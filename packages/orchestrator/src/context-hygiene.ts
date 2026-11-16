/**
 * Keeping tool output in the context only while it is still worth reading.
 *
 * ## Why the window filled up
 *
 * Every tool result stayed, whole, for the life of the session. A result could
 * be up to ~4,000 tokens, and nothing ever made it smaller unless the whole
 * history reached the compaction threshold — which, at a default of 100% of a
 * million-token window, is almost never. So a session that looked at a page
 * eight times carried eight complete page snapshots, seven of them describing
 * a page that no longer existed, and the meter climbed on every step.
 *
 * Summarising did not help either, because it only runs when the history is
 * already full. The waste had to be removed as it was created.
 *
 * ## Two rules, both about what the output is *for*
 *
 * **Superseded.** Some output describes state that a later call has replaced.
 * The browser has one current page, so only the latest snapshot of it is
 * true; running `npm test` again makes the earlier run history; re-reading
 * the same lines of a file makes the first read redundant. The older result
 * becomes a one-line stub saying what replaced it.
 *
 * **Aged.** Other output was needed at the moment and is rarely needed again:
 * the 300 lines of an install log, a directory listing, a search. After a
 * number of steps — fewer for a page, more for a file the agent may still be
 * editing from — it is condensed to what a person would keep: the head, the
 * lines that report errors, warnings and results, and the tail.
 *
 * Neither rule loses anything that cannot be had again. Every stub and every
 * digest says how to get the full output back, and the full output is still
 * in the stored session.
 *
 * ## Staying friendly to the prompt cache
 *
 * Rewriting an old message changes the bytes of every request from that point
 * on, so the provider's cached prefix stops there. Ageing therefore moves in
 * steps of `EPOCH` calls rather than one at a time: the boundary advances every
 * few steps, and between advances the whole history is byte-identical to the
 * last request. Supersession is immediate, but what it rewrites is almost
 * always the previous step, which costs almost nothing.
 *
 * The output of this function is also what the prefix seal is taken over, so
 * the two agree by construction — see `stablePrefixLength` in the loop.
 */

import { wholeLimit } from "./tool-result.js";
import { IMAGE_TOKENS, estimateMessageTokens } from "@sqcode/shared";
import { groupUnits } from "./context-manager.js";
import { stableResult } from "./repetition.js";
import type { LLMMessage, LLMToolCall } from "./types.js";

/** What kind of output a tool produces, which decides how long it stays whole. */
export type OutputKind = "page" | "command" | "search" | "read" | "kept";

const KIND: Record<string, OutputKind> = {
  browser_open: "page",
  browser_snapshot: "page",
  browser_interact: "page",
  browser_batch: "page",
  browser_screenshot: "page",
  browser_console_logs: "command",
  run_command: "command",
  run_tests: "command",
  process_status: "command",
  // A wait carries the process's output tail, the same snapshot process_status gives.
  wait: "command",
  install_package: "command",
  git_operation: "command",
  grep_search: "search",
  list_directory: "search",
  find_symbol_definition: "search",
  find_symbol_references: "search",
  web_search: "search",
  fetch_url_content: "search",
  read_file: "read",
};

/**
 * Advance the ageing boundary this many calls at a time.
 *
 * Every freshness below is a multiple of it, so all kinds move together —
 * one cache break every four steps, not one per kind.
 */
export const EPOCH = 4;

/** Steps an output stays whole, by kind. */
const FRESH_STEPS: Record<Exclude<OutputKind, "kept">, number> = {
  // A page is replaced by the next snapshot anyway; this is for the last one.
  page: 4,
  command: 4,
  search: 8,
  // The agent edits from what it read, often several steps later.
  read: 12,
};

/**
 * The most any single result may cost while fresh.
 *
 * Below the context manager's own cap (4,000 tokens) on purpose: when this
 * has already trimmed a result, that one never needs to, so the messages the
 * seal fingerprints are exactly the messages that were sent.
 */
const FRESH_MAX_CHARS = 10_000;
/** A condensed, aged result. */
const AGED_MAX_CHARS = 1_600;
/** What stays of a past write's or edit's text: enough to recognise it. */
const PAST_EDIT_KEEP = 240;
/** A past command longer than this (a script written through the shell) is folded too. */
const PAST_COMMAND_KEEP = 800;
/** What stays of a past write's or edit's result. */
const PAST_EDIT_RESULT = 600;
const LINE_MAX = 220;

/** Lines worth keeping from the middle of anything: outcomes and problems. */
const SIGNAL =
  /\b(error|errors|failed|failure|fail|exception|warning|warn|cannot|could not|not found|undefined|denied|refused|timeout|timed out|panic|traceback|passed|tests?\b.*\d|exit(ed)? (code|with))\b|✗|✘|×|✓|FAIL|PASS|ERR!/i;

export interface HygieneStats {
  superseded: number;
  aged: number;
  /** Past writes and edits whose content was folded to a pointer at the file. */
  pastEdits: number;
  /** Steps dropped from view as exact repeats of the step after them; see `collapseRepeats`. */
  collapsed: number;
  /** Tokens the history no longer costs. */
  savedTokens: number;
}

export interface HygieneResult {
  messages: LLMMessage[];
  stats: HygieneStats;
}

/**
 * Tidy a history for sending. Pure: the input is not changed, and the same
 * history always produces the same output.
 */
export function tidyHistory(messages: LLMMessage[]): HygieneResult {
  const stats: HygieneStats = { superseded: 0, aged: 0, pastEdits: 0, collapsed: 0, savedTokens: 0 };
  if (messages.length === 0) return { messages, stats };

  // Each call, where its result is, and which step made it.
  const calls = new Map<string, { call: LLMToolCall; step: number }>();
  let steps = 0;
  for (const unit of groupUnits(messages)) {
    if (unit.kind !== "calls") continue;
    for (const call of messages[unit.start]!.toolCalls ?? []) calls.set(call.id, { call, step: steps });
    steps++;
  }

  /*
   * Calls that failed replace nothing. A navigation that errored left the
   * page where it was, so the snapshot before it is still the true one.
   */
  const failed = new Set<string>();
  for (const m of messages) {
    if (m.role === "tool" && m.toolCallId && typeof m.content === "string" && isFailure(m.content)) {
      failed.add(m.toolCallId);
    }
  }

  // The latest step to fill each slot; anything earlier in a slot is superseded.
  const latest = new Map<string, number>();
  for (const { call, step } of calls.values()) {
    if (failed.has(call.id)) continue;
    const slot = slotOf(call);
    if (slot && (latest.get(slot) ?? -1) < step) latest.set(slot, step);
  }

  /*
   * The ageing boundary, quantised. A result from a step before `before[kind]`
   * is aged. `steps` grows by one per call; the boundary moves only when it
   * crosses a multiple of EPOCH.
   */
  const boundary = (kind: Exclude<OutputKind, "kept">): number =>
    Math.floor(Math.max(0, steps - FRESH_STEPS[kind]) / EPOCH) * EPOCH;

  /*
   * Past edits, folded (5 Oct 2026).
   *
   * Measured on the longest stored sessions, a third of what the model was
   * sent each step was its own old edits: whole files from write_file and the
   * old and new text of edit_file, from long ago, of files that have changed
   * since. A model reading three superseded versions of a file is a model
   * that mixes them up, which is how a long session drifts into editing code
   * that no longer exists. Past the same freshness as a read (and on the same
   * epoch boundary, so the prompt cache moves only when reads' does), the
   * content becomes a pointer to the file, which is the current version.
   */
  const writeBoundary = boundary("read");
  const foldInput = (call: LLMToolCall, step: number): LLMToolCall => {
    if ((call.name !== "write_file" && call.name !== "edit_file" && call.name !== "run_command") || step >= writeBoundary) return call;
    const input = call.input ?? {};
    const path = typeof input["path"] === "string" ? (input["path"] as string) : "the file";
    let changed = false;
    const next: Record<string, unknown> = { ...input };
    const fields = call.name === "write_file" ? ["content"] : call.name === "run_command" ? ["command"] : ["old_str", "new_str"];
    for (const field of fields) {
      const value = input[field];
      // A command is kept whole unless it is a script in disguise (a heredoc writing a file).
      if (typeof value !== "string" || value.length <= (call.name === "run_command" ? PAST_COMMAND_KEEP : PAST_EDIT_KEEP)) continue;
      const lines = value.split("\n");
      next[field] =
        call.name === "run_command"
          ? `${value.slice(0, PAST_EDIT_KEEP)}\n[... ${lines.length} lines in all, run at an earlier step.]`
          : `${lines.slice(0, 3).join("\n").slice(0, PAST_EDIT_KEEP)}\n[... ${lines.length} lines in all, from an earlier step. ` +
            `${path} on disk is the current version: read_file it before working from this.]`;
      changed = true;
    }
    return changed ? { ...call, input: next } : call;
  };

  const out = messages.map((message) => {
    if (message.role === "assistant" && message.toolCalls?.length) {
      let folded = false;
      const toolCalls = message.toolCalls.map((call) => {
        const step = calls.get(call.id)?.step ?? steps;
        const next = foldInput(call, step);
        if (next !== call) folded = true;
        return next;
      });
      if (!folded) return message;
      stats.pastEdits++;
      const next = { ...message, toolCalls };
      stats.savedTokens += Math.max(0, estimateMessageTokens(message) - estimateMessageTokens(next));
      return next;
    }
    if (message.role !== "tool" || typeof message.content !== "string" || !message.toolCallId) return message;
    const found = calls.get(message.toolCallId);
    if (!found) return message;

    const { call, step } = found;
    const kind = KIND[call.name] ?? "kept";
    const slot = slotOf(call);
    let content = message.content;

    if (slot && (latest.get(slot) ?? step) > step) {
      content = supersededStub(call, content);
      stats.superseded++;
    } else if ((call.name === "write_file" || call.name === "edit_file") && step < writeBoundary && content.length > PAST_EDIT_RESULT) {
      // Its outcome stays (applied, failed, a warning); the echoed text of the file does not.
      content = condense(readable(content), PAST_EDIT_RESULT, `Earlier ${call.name} result, condensed: read the file for its current state`);
      stats.aged++;
    } else if (kind !== "kept" && step < boundary(kind)) {
      const digest = agedDigest(call, kind, content);
      if (digest.length < content.length) {
        content = digest;
        stats.aged++;
      }
    } else if (content.length > (wholeLimit(call.name) ?? FRESH_MAX_CHARS)) {
      content = condense(readable(content), FRESH_MAX_CHARS, `Long output of ${call.name}, shortened — re-run it with a narrower query for the rest.`);
    }

    if (content === message.content) return message;
    stats.savedTokens +=
      estimateMessageTokens(message) - estimateMessageTokens({ ...message, content });
    return { ...message, content };
  });

  return { messages: detachOldImages(collapseRepeats(messages, out, stats), stats), stats };
}

/** The loop's own notes on a repeated call, which differ only in their count. */
const REPEAT_NOTES = /\n\n\[Note: this is identical call number \d+[\s\S]*?\]|\n\n\[Code graph\][^\n]*$/g;

/**
 * Identical steps, shown once.
 *
 * A model that has taken one step five times (the same words, the same
 * calls, the same results) is shown five copies of it, and a context full of
 * one step is a strong pull towards taking it a sixth time (seen 8 and 11 Oct
 * 2026, GLM re-reading one file and re-sending one empty call). The copies
 * need not be back to back: on 13 Oct one directory listing was taken sixteen
 * times in one turn, in runs of two and three with other work and the loop's
 * own reminders between them, and every copy left in view made the next one
 * likelier. All but the latest copy leave the view; the stored session keeps
 * them, and the step that remains carries the loop's note on the repeat.
 * Results are compared without their run-to-run noise (`stableResult`), so a
 * command run twice is the same step when it printed the same thing, and a
 * different one when it did not (tests run again after a fix stay).
 * Identity is read from the history as stored (`original`), and the copies
 * are dropped from the tidied copy (`tidied`), which has the same length.
 */
function collapseRepeats(original: LLMMessage[], tidied: LLMMessage[], stats: HygieneStats): LLMMessage[] {
  const units = groupUnits(original).filter((u) => u.kind === "calls");
  if (units.length < 2) return tidied;
  const keyOf = (u: { start: number; end: number }): string => {
    const head = original[u.start]!;
    const calls = (head.toolCalls ?? []).map((c) => `${c.name}:${JSON.stringify(c.input ?? {})}`).join("|");
    const results = original
      .slice(u.start + 1, u.end)
      .map((m) => (typeof m.content === "string" ? stableResult(m.content.replace(REPEAT_NOTES, "")) : JSON.stringify(m.content)))
      .join("\u0000");
    return `${typeof head.content === "string" ? head.content.trim() : ""}\u0001${calls}\u0001${results}`;
  };
  const drop = new Set<number>();
  const later = new Set<string>();
  // From the newest back: a step seen again further on leaves the view.
  for (let i = units.length - 1; i >= 0; i--) {
    const unit = units[i]!;
    const key = keyOf(unit);
    if (!later.has(key)) {
      later.add(key);
      continue;
    }
    for (let k = unit.start; k < unit.end; k++) drop.add(k);
    stats.collapsed++;
  }
  if (drop.size === 0) return tidied;
  return tidied.filter((m, i) => {
    if (!drop.has(i)) return true;
    stats.savedTokens += estimateMessageTokens(m);
    return false;
  });
}

/** Pictures kept attached; older ones become a line saying what they were. */
export const KEEP_IMAGES = 3;

/**
 * Screenshots stop being re-sent once newer ones exist.
 *
 * Every attached image is paid for again on every request — about 1,600
 * tokens each — and a session that checks its work visually takes dozens. The
 * latest few are what the agent is reasoning about; an older one is replaced by
 * the line that introduced it, so the agent knows it looked and can look again.
 */
function detachOldImages(messages: LLMMessage[], stats: HygieneStats): LLMMessage[] {
  return labelOlderImages(detachBeyondKept(messages, stats));
}

/** What follows an image's source when it is attached: it is the page as it is now. */
export const FRESH_IMAGE = " (just taken: this is the page as it is now):";
const OLDER_IMAGE = " (EARLIER image: a newer one follows, so this is not the page as it is now):";

/**
 * Only the newest pictures are called current.
 *
 * Three screenshots stay attached, each introduced by a timestamped file
 * name. A model shown three pictures of the same site at three widths could
 * not tell which was the newest, and described an older one as what it had
 * just taken: "still the lagged mobile capture", four screenshots in a row,
 * while the page it had opened was a different one (1 Oct 2026). Every
 * picture before the latest message that has any now says it is older.
 */
function labelOlderImages(messages: LLMMessage[]): LLMMessage[] {
  let newest = -1;
  for (let i = messages.length - 1; i >= 0 && newest < 0; i--) {
    const content = messages[i]!.content;
    if (Array.isArray(content) && content.some((b) => b.type === "image")) newest = i;
  }
  if (newest <= 0) return messages;
  return messages.map((message, i) => {
    if (i >= newest || !Array.isArray(message.content)) return message;
    if (!message.content.some((b) => b.type === "text" && b.text.endsWith(FRESH_IMAGE))) return message;
    return {
      ...message,
      content: message.content.map((b) =>
        b.type === "text" && b.text.endsWith(FRESH_IMAGE) ? { ...b, text: b.text.slice(0, -FRESH_IMAGE.length) + OLDER_IMAGE } : b,
      ),
    };
  });
}

/*
 * The newest message with pictures keeps all of them.
 *
 * The cap counted pictures one by one, so a message with more than three lost
 * its first ones before the model ever saw them: the top of a long screenshot
 * sent as four parts, or the first of four attached pictures (14 Nov 2026).
 * What the model is about to look at is never trimmed; the cap is for what it
 * has already seen.
 */
function detachBeyondKept(messages: LLMMessage[], stats: HygieneStats): LLMMessage[] {
  let seen = 0;
  let newest = true;
  let dropping = false;
  const keepFrom = new Map<number, number>();
  for (let i = messages.length - 1; i >= 0; i--) {
    const content = messages[i]!.content;
    if (!Array.isArray(content)) continue;
    const images = content.filter((b) => b.type === "image").length;
    if (images === 0) continue;
    // How many of this message's images (counting from its last) are still kept.
    const keep = newest ? images : Math.max(0, Math.min(images, KEEP_IMAGES - seen));
    keepFrom.set(i, keep);
    if (keep < images) dropping = true;
    seen += images;
    newest = false;
  }
  if (!dropping) return messages;

  return messages.map((message, i) => {
    const keep = keepFrom.get(i);
    if (keep === undefined || !Array.isArray(message.content)) return message;
    const total = message.content.filter((b) => b.type === "image").length;
    if (keep >= total) return message;
    let index = 0;
    const blocks = message.content.map((block) => {
      if (block.type !== "image") return block;
      const kept = index++ >= total - keep;
      if (kept) return block;
      stats.aged++;
      stats.savedTokens += IMAGE_TOKENS;
      return { type: "text" as const, text: "[This image is no longer attached, to save context. Open it again with view_image, or take a new screenshot, if you need to see it.]" };
    });
    return { ...message, content: blocks };
  });
}

/**
 * What state a call's output describes, when a later call can replace it.
 *
 * Null for calls whose output stays true: an edit's result, a question's
 * answer, a sub-agent's report.
 */
export function slotOf(call: LLMToolCall): string | null {
  const input = call.input ?? {};
  const str = (key: string): string => (typeof input[key] === "string" ? (input[key] as string) : "");
  switch (call.name) {
    // One browser, one current page.
    case "browser_open":
    case "browser_snapshot":
    case "browser_interact":
    case "browser_batch":
    case "browser_screenshot":
      return "page";
    case "browser_console_logs":
      return "console";
    case "run_command":
      return `cmd:${str("command").replace(/\s+/g, " ").trim()}`;
    case "process_status":
      return `proc:${str("process_id")}`;
    case "wait":
      return str("process_id") ? `proc:${str("process_id")}` : null;
    case "read_file":
      return `read:${normalisePath(str("path"))}:${String(input["start_line"] ?? "")}-${String(input["end_line"] ?? "")}`;
    case "run_tests":
    case "grep_search":
    case "glob":
    case "list_directory":
    case "find_symbol_definition":
    case "find_symbol_references":
    case "web_search":
    case "fetch_url_content":
    case "research":
      return `${call.name}:${stableJson(input)}`;
    case "subagent_status":
      return "subagents";
    case "update_todo_list":
      return "todo";
    default:
      return null;
  }
}

function supersededStub(call: LLMToolCall, content: string): string {
  switch (slotOf(call)?.split(":")[0]) {
    case "page": {
      const { url, title } = pageOf(content);
      const where = url ? ` of ${url}${title ? ` ("${title}")` : ""}` : "";
      return `[Superseded page state${where}: a later browser call shows the page as it is now.]`;
    }
    case "cmd": {
      const exit = exitCodeOf(content);
      return `[Superseded: \`${clip(String(call.input["command"] ?? ""), 120)}\` was run again later${
        exit !== null ? ` (this run exited ${exit})` : ""
      }. See the later result.]`;
    }
    case "read":
      return `[Superseded: ${String(call.input["path"] ?? "this file")} was read again later. See the later result.]`;
    default:
      return `[Superseded: ${call.name} was called again later with the same input. See the later result.]`;
  }
}

function agedDigest(call: LLMToolCall, kind: Exclude<OutputKind, "kept">, content: string): string {
  if (content.length <= AGED_MAX_CHARS) return content;
  switch (kind) {
    case "page": {
      const { url, title } = pageOf(content);
      return (
        `[Earlier page state${url ? ` of ${url}` : ""}${title ? ` ("${title}")` : ""}, condensed. ` +
        `Take a browser_snapshot for the current page.]`
      );
    }
    case "read": {
      const path = String(call.input["path"] ?? "the file");
      return condense(readable(content), AGED_MAX_CHARS, `Earlier read of ${path}, condensed — read it again before editing from it.`);
    }
    case "command": {
      const exit = exitCodeOf(content);
      const label = call.name === "run_command" ? `\`${clip(String(call.input["command"] ?? ""), 120)}\`` : call.name;
      const note = `Earlier output of ${label}${exit !== null ? ` (exit ${exit})` : ""}, condensed — re-run it for the full output.`;
      return condense(readable(content), AGED_MAX_CHARS, note);
    }
    case "search":
      return condense(readable(content), AGED_MAX_CHARS, `Earlier ${call.name} result, condensed — run it again for the full list.`);
  }
}

/**
 * Shrink text to about `max` characters, keeping what a person would.
 *
 * The head (what was run, the first lines of a file), every line in the
 * middle that reports an outcome or a problem, and the tail (where a command
 * puts its summary). A plain head-and-tail cut is the one choice guaranteed to
 * throw away the single error line in the middle of an install log.
 */
export function condense(text: string, max: number, note: string): string {
  if (text.length <= max) return text;
  const raw = text.split("\n");
  /*
   * Too few lines to choose between — minified code, one enormous JSON value.
   * Keep both ends by character instead.
   */
  if (raw.length < 6) {
    const keep = Math.max(0, Math.floor((max - note.length - 40) / 2));
    return `[${note}]\n${text.slice(0, keep)}\n… (${(text.length - keep * 2).toLocaleString()} characters omitted) …\n${text.slice(-keep)}`;
  }
  const lines = raw.map((l) => clip(l, LINE_MAX));
  const budget = max - note.length - 60;

  const head: string[] = [];
  const tail: string[] = [];
  let used = 0;
  const take = (into: string[], line: string, front: boolean): boolean => {
    if (used + line.length + 1 > budget) return false;
    if (front) into.push(line);
    else into.unshift(line);
    used += line.length + 1;
    return true;
  };

  const headCount = Math.min(12, lines.length);
  const tailCount = Math.min(8, Math.max(0, lines.length - headCount));
  for (let i = 0; i < headCount; i++) if (!take(head, lines[i]!, true)) break;
  for (let i = lines.length - 1; i >= lines.length - tailCount; i--) if (!take(tail, lines[i]!, false)) break;

  const signal: string[] = [];
  for (let i = headCount; i < lines.length - tailCount; i++) {
    const line = lines[i]!;
    if (!SIGNAL.test(line)) continue;
    if (signal[signal.length - 1] === line) continue;
    if (!take(signal, line, true)) break;
  }

  const omitted = lines.length - head.length - signal.length - tail.length;
  return [
    `[${note}]`,
    ...head,
    ...(signal.length > 0 ? [`… (${omitted} lines omitted; problems and results kept) …`, ...signal] : []),
    ...(omitted > 0 && signal.length === 0 ? [`… (${omitted} lines omitted) …`] : []),
    ...(signal.length > 0 && tail.length > 0 ? ["…"] : []),
    ...tail,
  ].join("\n");
}

/**
 * A result as lines, when it arrived as JSON.
 *
 * Tool data is serialised compactly — `{"command","exitCode","stdout",…}` on
 * one line thousands of characters long — which a line-based digest can only
 * cut blindly. Unpacked, the error line in the middle of stderr is a line of
 * its own and survives.
 */
export function readable(content: string): string {
  const failed = /^FAILED: [^\n]*\n\n/.exec(content)?.[0] ?? "";
  const body = content.slice(failed.length);
  if (!body.startsWith("{")) return content;
  let data: Record<string, unknown>;
  try {
    const parsed = JSON.parse(body) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return content;
    data = parsed as Record<string, unknown>;
  } catch {
    return content;
  }

  const short: string[] = [];
  const long: string[] = [];
  for (const [key, value] of Object.entries(data)) {
    if (value === null || value === undefined || value === "") continue;
    if (typeof value === "string") {
      if (value.length > 160 || value.includes("\n")) long.push(`--- ${key} ---\n${value.trimEnd()}`);
      else short.push(`${key}: ${value}`);
    } else if (Array.isArray(value) && value.every((v) => typeof v === "string")) {
      long.push(`--- ${key} ---\n${(value as string[]).join("\n")}`);
    } else if (typeof value === "object") {
      const json = JSON.stringify(value);
      if (json.length > 160) long.push(`--- ${key} ---\n${json}`);
      else short.push(`${key}: ${json}`);
    } else {
      short.push(`${key}: ${String(value)}`);
    }
  }
  return `${failed}${[...short, ...long].join("\n")}`;
}

/**
 * A result that changed nothing, so replaces nothing.
 *
 * Not only `FAILED:` at the very start: a failed call with warnings has them
 * above the failure line, and a call refused by policy or by the person was
 * never run at all. Each of those once counted as the newest result in its
 * slot, and turned the last *real* output — the page as it is, the command's
 * actual result — into a stub.
 */
export function isFailure(content: string): boolean {
  return (
    /^(?:WARNING: [^\n]*\n+)*FAILED:/.test(content) ||
    /^\{\s*"success"\s*:\s*false\b/.test(content) ||
    /^(?:Action denied by policy:|Action was explicitly rejected by user confirmation\.|'[\w-]+' needs confirmation, and this session has no way to ask)/.test(content)
  );
}

function exitCodeOf(content: string): number | null {
  const m = /"exit_?[cC]ode"\s*:\s*(-?\d+)/.exec(content);
  return m ? Number(m[1]) : null;
}

function pageOf(content: string): { url: string; title: string } {
  const url = /(?:^|\\n|\n)URL: ([^\n\\]+)/.exec(content)?.[1] ?? /"url"\s*:\s*"([^"]+)"/.exec(content)?.[1] ?? "";
  const title = /(?:^|\\n|\n)Page: ([^\n\\]+)/.exec(content)?.[1] ?? /"title"\s*:\s*"([^"]*)"/.exec(content)?.[1] ?? "";
  return { url: clip(url, 160), title: clip(title, 100) };
}

function normalisePath(path: string): string {
  return path.trim().replace(/\\/g, "/").replace(/^(\.\/)+/, "");
}

function stableJson(value: unknown): string {
  if (!value || typeof value !== "object") return JSON.stringify(value) ?? "";
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  const obj = value as Record<string, unknown>;
  return `{${Object.keys(obj)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${stableJson(obj[k])}`)
    .join(",")}}`;
}

function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}
