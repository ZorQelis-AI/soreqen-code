/**
 * Noticing a model that is circling.
 *
 * Seen 30 Sep 2026 in a long game build: six steps in a row each opened with
 * the same paragraph — "Phase 2's gate is green, but my visual audit found
 * two gaps…" — and each went on to read the same two or three files again.
 * Nothing was wrong with any single step; together they were a loop that
 * cost a minute of thought apiece and changed nothing.
 *
 * A step circles when what the model says is nearly what it said a few steps
 * ago *and* the step only looks around: reads, searches, listings. Saying the
 * same thing while editing is progress; reading the same thing while saying
 * the same thing is not. Two circling steps and the model is told so, with
 * the files it keeps re-reading named.
 *
 * Checking counts too (14 Oct 2026). A training run left in the background
 * was "verified" eight times in four minutes: "Training is running with your
 * exact cadence. Let me do a final verification before reporting.", each
 * time with a slightly different command reading the log, so no two steps
 * were identical and none of them only read files. A step that says nearly
 * word for word what it said before, and only checks (commands, status,
 * waits, pages) without writing anything, circles as well.
 */

import { createHash } from "node:crypto";
import type { LLMToolCall } from "./types.js";

/**
 * Fields of a tool result that differ on every run of the same call: the
 * process a command ran as, how long it took. Two runs that taught the same
 * thing differ only in these (seen 13 Oct 2026: one directory listing taken
 * sixteen times, each result unique only by its `process_id`).
 */
const VOLATILE = /"(?:process_id|ran_for|started_at|finished_at|duration_ms|elapsed_ms)":(?:"[^"]*"|\d+),?/g;

/** A tool result with its run-to-run noise taken out, for telling repeats apart. */
export function stableResult(text: string): string {
  return text.replace(VOLATILE, "");
}

/** A short fixed-size name for a step: its words, its calls and what they returned. */
export function stepFingerprint(text: string, calls: LLMToolCall[], results: string[]): string {
  const hash = createHash("sha1");
  hash.update(text.trim());
  for (const c of calls) hash.update(`\u0000${c.name}:${JSON.stringify(c.input ?? {})}`);
  for (const r of results) hash.update(`\u0001${stableResult(r)}`);
  return hash.digest("base64");
}

/** Tools that only look. A step made only of these changes nothing. */
const LOOKING = new Set([
  "read_file",
  "list_directory",
  "grep_search",
  "glob",
  "find_symbol_definition",
  "find_symbol_references",
  "code_graph",
  "retrieve_context",
  "process_status",
  "update_task_state",
  "update_todo_list",
]);

/**
 * Tools that check on things without writing any file: with `LOOKING`, what
 * a step made of only checks may call. A command can change things, so a
 * step of commands circles only when its words are nearly the same (`ECHO`).
 */
const CHECKING = new Set([
  "run_command",
  "wait",
  "web_search",
  "fetch_url_content",
  "browser_snapshot",
  "browser_screenshot",
  "browser_console_logs",
  "subagent_status",
]);

/** Tools that watch a process: a loop of these is someone polling a job. */
const POLLING = new Set(["run_command", "process_status", "wait"]);

/** How alike two statements must be to count as the same one. */
const SAME = 0.45;
/** How alike a checking step's statement must be: nearly word for word. */
const ECHO = 0.75;
/** Statements shorter than this are too short to judge. */
const MIN_CHARS = 40;
/** Nor are statements about fewer things than this ("Let me check the tests."). */
const MIN_WORDS = 4;
/** How far back a repeat is looked for. */
const WINDOW = 6;
/** Circling steps before the model is told. */
const TELL_AT = 2;
/** Times it is told in one turn, so a loop cannot become a loop of reminders. */
const MAX_TELLS = 3;

const FILLER = new Set([
  "the", "and", "but", "for", "with", "that", "this", "then", "than", "from", "into", "only", "have", "has",
  "are", "was", "were", "not", "now", "all", "any", "its", "it's", "let", "me", "my", "i'm", "i'll", "before",
  "after", "first", "next", "both", "need", "needs", "found", "reading", "read", "check", "checking",
]);

/** The words a statement is about. */
function contentWords(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .replace(/[`*_#>\[\]()"'.,:;!?/—–-]/g, " ")
      .split(/\s+/)
      .filter((w) => w.length > 2 && !FILLER.has(w) && !/^\d+$/.test(w)),
  );
}

/**
 * How much of the shorter statement's vocabulary the other one shares.
 *
 * A restatement is a paraphrase — "only differ by blade size" becomes "all the
 * same soldier with a bigger blade" — so runs of words barely overlap while
 * the words themselves mostly do. Of the shorter: a restatement that adds a
 * sentence is still the restatement.
 */
export function sameness(a: string, b: string): number {
  const x = contentWords(a);
  const y = contentWords(b);
  if (x.size === 0 || y.size === 0) return 0;
  let shared = 0;
  for (const w of x) if (y.has(w)) shared++;
  return shared / Math.min(x.size, y.size);
}

function pathOf(call: LLMToolCall): string | null {
  const input = call.input as Record<string, unknown>;
  const path = input["path"] ?? input["file"];
  return typeof path === "string" ? path : null;
}

export class RepetitionWatch {
  private said: string[] = [];
  private circling = 0;
  private tells = 0;
  private reads = new Map<string, number>();

  /**
   * One step: what the model said and the calls it made. Returns what to tell
   * it, when it has been circling long enough to be told.
   */
  observe(text: string, calls: LLMToolCall[]): string | null {
    const statement = text.trim();
    const looking = calls.length > 0 && calls.every((c) => LOOKING.has(c.name));
    const checking = calls.length > 0 && calls.every((c) => LOOKING.has(c.name) || CHECKING.has(c.name));
    if (!checking) {
      // Something was done. Whatever came before is not a loop any more.
      this.circling = 0;
      this.reads.clear();
    } else {
      for (const call of calls) {
        const path = call.name === "read_file" ? pathOf(call) : null;
        if (path) this.reads.set(path, (this.reads.get(path) ?? 0) + 1);
      }
    }

    const judged = statement.length >= MIN_CHARS && contentWords(statement).size >= MIN_WORDS;
    const closest = judged ? Math.max(0, ...this.said.map((earlier) => sameness(statement, earlier))) : 0;
    if (judged) {
      this.said.push(statement);
      if (this.said.length > WINDOW) this.said.shift();
    }

    if (!((looking && closest >= SAME) || (checking && closest >= ECHO))) return null;
    this.circling++;
    if (this.circling < TELL_AT || this.tells >= MAX_TELLS) return null;
    this.circling = 0;
    this.tells++;

    if (calls.some((c) => POLLING.has(c.name))) {
      return (
        "You are checking the same thing again and again: the last few steps said nearly the same words and ran " +
        "checks that changed nothing. What you have seen already answers it. If you are watching a background " +
        "job (training, a build, a download, a server), stop checking it: SoreQen tells you when it finishes, " +
        "crashes or is stopped, and starts a turn for you then. " +
        (this.tells > 1
          ? "Finish your turn now with what you already know. Do not run another check."
          : "Take a different next step, or finish your turn and report what you found.")
      );
    }

    const again = [...this.reads.entries()].filter(([, n]) => n > 1).map(([p]) => p);
    return (
      "You are going in circles: the last few steps opened with essentially the same status and only read " +
      "or searched, without changing anything." +
      (again.length > 0
        ? ` You have read ${again.map((p) => `\`${p}\``).join(", ")} more than once this turn; nothing has changed ` +
          "them since, so what you read is still current. Use it instead of reading again."
        : "") +
      " Do not restate the situation. Take the next concrete action now (make the edit, write the file, or run " +
      "the command), and if something specific is blocking you, say exactly what it is."
    );
  }
}
