/**
 * Sub-agents that run beside the work instead of in front of it.
 *
 * ## What was wrong with the old shape
 *
 * `spawn_subagent` awaited the delegated turn. The parent issued the call and
 * then sat there — no tokens, no tool calls, no progress — for however long the
 * specialist took, which on a real investigation is minutes. Delegation was
 * therefore strictly worse than doing the work inline unless the sub-agent's
 * context isolation alone paid for the wall-clock, and it usually did not. The
 * surface showed one tool call that took four minutes and said nothing about
 * what was happening inside it.
 *
 * ## The shape now
 *
 * A spawn starts the turn and returns an id. The parent carries on with
 * whatever does not depend on the answer, and each result is handed to it at
 * the start of the step after the sub-agent finished (it used to have to ask
 * with `subagent_status`, and learned of a finish only when it thought to; 15
 * Oct 2026). It can still block deliberately, with `wait_for_all`, when it has
 * genuinely run out of independent work. The loop will not let a turn finish
 * while a sub-agent is still running, so a result can be late but never lost.
 *
 * ## Why a pool object rather than a bag of promises
 *
 * Three things have to be true at once, and each of them is a bug if it is
 * only true by convention:
 *
 *   - **A rejected promise must not become an unhandled rejection.** A
 *     sub-agent that throws while the parent is busy elsewhere would otherwise
 *     take the process down. Every promise is attached to at the moment it is
 *     created, and the failure is stored as a result.
 *   - **A result must be delivered exactly once.** The parent reads results
 *     through `collect`, and a result read twice is a parent that thinks two
 *     specialists agreed with each other.
 *   - **The budget must be shared.** Sub-agents spend the parent's tokens.
 *     Without one place that knows how many are running, "delegate more" is an
 *     unbounded-cost button.
 */

import type { SubagentInfo } from "@sqcode/shared";
import type { EntryKind, TaskState } from "./context/task-state.js";

/**
 * How many specialists may run at once, by effort tier.
 *
 * Delegation is only offered at the top two tiers, and they want different
 * things from it. Max delegates *selectively* — a review here, a wide search
 * there — so three is more than it will usually use and never the reason it
 * cannot. Apex is the tier whose whole premise is spending more to be right,
 * so it gets room to run a real team: an explorer, a researcher and a reviewer
 * working while the main agent writes code is exactly the shape that pays.
 *
 * The ceiling is not about compute. It is about a parent that can still say
 * what each specialist is doing — past about half a dozen, the parent spends
 * more tokens tracking the team than it saves by having one.
 */
export const SUBAGENT_CONCURRENCY: Record<string, number> = {
  max: 3,
  apex: 6,
};

/** Used when the tier is unknown, and as the ceiling anything else is capped to. */
export const DEFAULT_SUBAGENT_CONCURRENCY = 4;

export function subagentConcurrencyFor(effort: string | undefined): number {
  return SUBAGENT_CONCURRENCY[String(effort ?? "").toLowerCase()] ?? DEFAULT_SUBAGENT_CONCURRENCY;
}

export interface SubagentOutcome {
  finalResponse: string;
  filesModified: string[];
  estimatedTokensUsed?: number;
  outputTokens?: number;
}

/** What a sub-agent reports back to the pool while it works. */
export interface SubagentReporter {
  /** The id the panel knows this agent by, so its own events can be tagged. */
  readonly id: string;
  activity(text: string): void;
  step(): void;
}

export interface SpawnRequest {
  role: string;
  task: string;
  /** The whole brief the specialist receives, so the person watching it can read exactly that. */
  brief?: string;
  /** The turn itself. Given a reporter so its progress reaches the panel. */
  run: (report: SubagentReporter) => Promise<SubagentOutcome>;
}

interface Entry {
  info: SubagentInfo;
  promise: Promise<void>;
  /** The result has not yet been handed to the parent. */
  unread: boolean;
}

/** The longest brief sent to a surface for display. The specialist itself always gets all of it. */
const MAX_BRIEF_CHARS = 24_000;

export class SubagentPool {
  private readonly entries = new Map<string, Entry>();
  private counter = 0;

  constructor(
    private readonly onUpdate?: (agent: SubagentInfo) => void,
    private readonly maxConcurrent: number = DEFAULT_SUBAGENT_CONCURRENCY,
  ) {}

  /** The ceiling this pool was built with, for the message that reports it. */
  capacity(): number {
    return this.maxConcurrent;
  }

  /** Running right now. */
  runningCount(): number {
    let n = 0;
    for (const e of this.entries.values()) if (e.info.status === "running") n++;
    return n;
  }

  anyRunning(): boolean {
    return this.runningCount() > 0;
  }

  /** Every sub-agent this turn started, oldest first. */
  list(): SubagentInfo[] {
    return [...this.entries.values()].map((e) => ({ ...e.info }));
  }

  get(id: string): SubagentInfo | null {
    const found = this.entries.get(id);
    return found ? { ...found.info } : null;
  }

  /**
   * Start one, without waiting for it.
   *
   * Returns the record as it stands the instant it was created, so the caller
   * has an id to report even though nothing has happened yet. A pool already
   * at capacity refuses rather than queueing: a queued spawn looks to the
   * model exactly like a running one, and it would plan around a specialist
   * that has not started.
   */
  spawn(request: SpawnRequest): { ok: true; agent: SubagentInfo } | { ok: false; reason: string } {
    if (this.runningCount() >= this.maxConcurrent) {
      return {
        ok: false,
        reason:
          `${this.maxConcurrent} sub-agents are already running, which is the limit. ` +
          "Delegate again when one finishes (its report comes to you then), or do this part yourself.",
      };
    }

    const id = `sub_${++this.counter}_${Math.random().toString(36).slice(2, 8)}`;
    const info: SubagentInfo = {
      id,
      role: request.role,
      task: request.task.length > 400 ? `${request.task.slice(0, 400)}…` : request.task,
      ...(request.brief ? { brief: request.brief.slice(0, MAX_BRIEF_CHARS) } : {}),
      status: "running",
      startedAt: Date.now(),
      steps: 0,
    };

    const entry: Entry = { info, promise: Promise.resolve(), unread: false };
    this.entries.set(id, entry);
    this.publish(info);

    const reporter: SubagentReporter = {
      id,
      activity: (text) => {
        if (entry.info.status !== "running") return;
        entry.info.activity = text.slice(0, 200);
        this.publish(entry.info);
      },
      step: () => {
        if (entry.info.status !== "running") return;
        entry.info.steps = (entry.info.steps ?? 0) + 1;
        this.publish(entry.info);
      },
    };

    /*
     * Attached immediately, and never left to reject on its own.
     *
     * `run` is an async function the caller wrote; if it throws synchronously
     * or rejects while the parent is mid-tool-call, an unattached promise is a
     * process-level unhandled rejection. Catching here turns every outcome,
     * including a crash, into a record the parent can read.
     */
    entry.promise = (async () => {
      try {
        const outcome = await request.run(reporter);
        entry.info.status = "completed";
        entry.info.result = outcome.finalResponse;
        entry.info.filesModified = outcome.filesModified;
      } catch (err) {
        entry.info.status = "failed";
        entry.info.error = err instanceof Error ? err.message : String(err);
      } finally {
        entry.info.endedAt = Date.now();
        delete entry.info.activity;
        entry.unread = true;
        this.publish(entry.info);
      }
    })();

    return { ok: true, agent: { ...info } };
  }

  /**
   * Results the parent has not been told about yet, marked as told.
   *
   * The "marked as told" half is why this is not just a filter over `list()`:
   * a finished sub-agent stays in the list for the panel and for a later
   * `subagent_status`, but its result is *delivered* to the parent once.
   */
  collect(): SubagentInfo[] {
    const out: SubagentInfo[] = [];
    for (const entry of this.entries.values()) {
      if (!entry.unread) continue;
      entry.unread = false;
      out.push({ ...entry.info });
    }
    return out;
  }

  /** Whether any finished result is still waiting to be read. */
  hasUnread(): boolean {
    for (const entry of this.entries.values()) if (entry.unread) return true;
    return false;
  }

  /** Settle every running sub-agent. Never rejects — each promise already
   *  records its own failure. */
  async waitForAll(): Promise<void> {
    await Promise.all([...this.entries.values()].map((e) => e.promise));
  }

  /** Until the next running sub-agent finishes; at once when none is running. Never rejects. */
  async waitForAny(): Promise<void> {
    const running = [...this.entries.values()].filter((e) => e.info.status === "running");
    if (running.length > 0) await Promise.race(running.map((e) => e.promise));
  }

  private publish(info: SubagentInfo): void {
    this.onUpdate?.({ ...info });
  }
}

/**
 * The specialists, and what each is for.
 *
 * A role is not decoration: it is prepended to the sub-agent's brief, so the
 * wording here is the only instruction the specialist gets about how to work.
 * Each says what to produce, because the most common way a delegated turn
 * wastes its budget is returning a transcript instead of an answer.
 */
export const SUBAGENT_ROLES: Record<string, string> = {
  researcher:
    "You research. Find current, authoritative information with web_search and fetch_url_content. Prefer " +
    "primary sources — official documentation, changelogs, release notes, the source code itself — over " +
    "blog posts and forum answers, and give version numbers and dates wherever they matter. Return the " +
    "findings with the URL each one came from, and say plainly what you could not confirm. Do not change " +
    "any file.",
  explorer:
    "You explore code. Map how the part of this codebase named in your brief actually works: the entry " +
    "points, the call paths through it, the data shapes that cross its boundaries, the configuration it " +
    "reads, and the tests that cover it. Read the code rather than guessing from names. Return a map with " +
    "file:line references for every claim. Do not change any file.",
  architect:
    "You design. Given the goal in your brief, read the code it touches first, then return the approach " +
    "you would take, the alternatives you rejected and why, the risks, and the concrete ordered list of " +
    "changes it implies, file by file. Do not change any file.",
  implementer:
    "You implement. Make exactly the change described in your brief, in the smallest correct patch that " +
    "matches the surrounding code's style. Read each file before editing it. Then prove it: run the " +
    "typecheck and the tests that cover what you changed, and fix what they report. Return what you " +
    "changed, file by file, and the command output that shows it works.",
  debugger:
    "You debug. Reproduce the failure in your brief first, and do not change code until you have. Find " +
    "the root cause — the first place the behaviour diverges from what is intended — and fix that, not " +
    "the symptom. Re-run the reproduction to show it now passes. Return the reproduction, the diagnosis " +
    "with file:line, the fix, and the evidence.",
  tester:
    "You test. Write or run the tests described in your brief, following the project's existing test " +
    "framework and conventions. Report exactly what passed, what failed, and the failing output verbatim " +
    "— never a summary that hides a failure. A test you could not run is reported as not run, with why.",
  browser_auditor:
    "You verify in a browser. Open the page, exercise the flow described in your brief with " +
    "browser_interact, screenshot each important state (screenshots are shown to you directly; use browser_batch for " +
    "several steps you already know, e.g. resize, open, screenshot), and " +
    "read browser_console_logs. Report what you saw, not what you expected to see, with the console " +
    "errors quoted exactly. Do not change any file.",
  documenter:
    "You document. Read the code being documented first, then write the documentation described in " +
    "your brief, matching the project's existing style and structure. Every command and example you " +
    "write must be one you checked. Change nothing but documentation.",
  code_reviewer:
    "You review. Read the diff or files named in your brief and find what is wrong with them: bugs, " +
    "missed cases, broken conventions, security and performance problems. For each finding give the " +
    "file:line, a concrete failing input or call path, and the severity. Do not report style preferences " +
    "as bugs. If you find nothing, say what you checked. Do not change any file.",
  performance_analyst:
    "You analyse performance. Measure before you conclude — time it, count it, profile it — and report " +
    "the numbers with the exact method and command that produced them, then where the time goes, with " +
    "file:line. Change code only if the brief asks you to, and measure again after.",
  security_auditor:
    "You audit security. Find reachable weaknesses in the code named in your brief — injection, broken " +
    "auth, unsafe deserialisation, path traversal, secrets in code, missing validation — each with the " +
    "call path from an input an attacker controls. Rank by impact times reachability. Do not change any " +
    "file.",
};

/**
 * How a reading role should read (29 Sep 2026: a reviewer read two files,
 * thought for minutes, read two more — a turn of many hours spent mostly in
 * the thinking between small steps). Appended to every read-only role.
 */
const READ_IN_BATCHES =
  " Read in batches: in your first step, open every file your brief names (and any you already know " +
  "you need) together, in one step; then think over all of them at once. Each step costs a full round " +
  "of thought, so one or two files per step makes the work many times slower without making it better.";

/** Roles that must not change the workspace. */
const READ_ONLY_ROLES = new Set(["researcher", "explorer", "architect", "browser_auditor", "code_reviewer", "security_auditor"]);

export const SUBAGENT_ROLE_NAMES = Object.keys(SUBAGENT_ROLES);

/**
 * Accept the role the model asked for, or the nearest one that exists.
 *
 * Models produce `"testing"` for `tester` and `"code_architect"` for
 * `architect` often enough that refusing the call would spend a round trip on
 * a spelling. An unrecognised role becomes `explorer`, which is the least
 * destructive specialist — it reads.
 */
export function resolveRole(raw: string): string {
  const key = String(raw ?? "").trim().toLowerCase().replace(/[\s-]+/g, "_");
  if (SUBAGENT_ROLES[key]) return key;

  const aliases: Record<string, string> = {
    research: "researcher",
    code_exploration: "explorer",
    exploration: "explorer",
    code_explorer: "explorer",
    code_architect: "architect",
    architecture: "architect",
    implementation: "implementer",
    coder: "implementer",
    debugging: "debugger",
    testing: "tester",
    test: "tester",
    ui_testing: "browser_auditor",
    browser_testing: "browser_auditor",
    browser: "browser_auditor",
    documentation: "documenter",
    docs: "documenter",
    code_review: "code_reviewer",
    reviewer: "code_reviewer",
    review: "code_reviewer",
    performance: "performance_analyst",
    performance_analysis: "performance_analyst",
    security: "security_auditor",
    security_analysis: "security_auditor",
  };
  return aliases[key] ?? "explorer";
}
/** What the parent knows about the session, handed down so a specialist does not work blind. */
export interface BriefSession {
  goal?: string;
  /** What the person asked for in the current turn. */
  request?: string;
  /** The person's requirements. They bind the specialist exactly as they bind the parent. */
  constraints?: string[];
  decisions?: string[];
  /** Approaches already tried and failed: not to be repeated. */
  failures?: string[];
  filesChanged?: string[];
}

export interface BriefExtras {
  /** How the specialist knows it is finished: the acceptance criteria. */
  doneWhen?: string;
  /** What the parent has already established, so it is not re-derived. */
  known?: string;
  /** What to leave alone. */
  outOfScope?: string;
  session?: BriefSession;
}

/**
 * The session context a brief carries, from the parent's task state.
 *
 * A specialist used to receive only what the parent thought to write. The
 * person's requirements were the first thing lost: "don't touch the public
 * API", stated once at the start of the session, reached no sub-agent unless
 * the parent repeated it, and an implementer would cheerfully change the
 * public API. The requirements, the decisions already made, the approaches
 * that already failed and the files already changed now go down with every
 * brief, from the same durable memory the parent reads.
 */
export function briefSessionFrom(state: TaskState): BriefSession {
  const newest = (kind: EntryKind, statuses: string[], n: number): string[] =>
    state.entries
      .filter((e) => e.kind === kind && statuses.includes(e.status))
      .sort((a, b) => b.updatedStep - a.updatedStep)
      .slice(0, n)
      .map((e) => oneLine(e.text, 240));
  const request = state.requests[state.requests.length - 1]?.text;
  return {
    ...(state.goal ? { goal: oneLine(state.goal, 500) } : {}),
    ...(request && request !== state.goal ? { request: oneLine(request, 700) } : {}),
    constraints: newest("constraint", ["active"], 15),
    decisions: newest("decision", ["active"], 8),
    failures: newest("failure", ["active"], 6),
    filesChanged: Object.values(state.files)
      .filter((f) => f.lastAction !== "read")
      .sort((a, b) => b.step - a.step)
      .slice(0, 20)
      .map((f) => f.path),
  };
}

function oneLine(text: string, max: number): string {
  const one = text.replace(/\s+/g, " ").trim();
  return one.length > max ? `${one.slice(0, max - 1)}…` : one;
}

/** A list section, or nothing when there is nothing to list. */
function section(title: string, items: readonly string[] | undefined): string {
  return items && items.length > 0 ? `\n\n## ${title}\n${items.map((i) => `- ${i}`).join("\n")}` : "";
}

function block(title: string, text: string | undefined): string {
  const t = text?.trim();
  return t ? `\n\n## ${title}\n${t.slice(0, 6_000)}` : "";
}

/**
 * The brief a specialist is given.
 *
 * It is the specialist's whole world: it never sees the parent's
 * conversation. So it is written as a document a competent stranger could act
 * on without a single question — who it is and how it works, the task, how it
 * will know it is done, what is already known, what the person requires, where
 * to start, the rules of the arrangement, and the exact shape of the report
 * the parent needs back. Sections with nothing in them are left out.
 */
export function buildBrief(role: string, task: string, contextFiles?: readonly string[], extras: BriefExtras = {}): string {
  const readOnly = READ_ONLY_ROLES.has(role);
  const instruction = (SUBAGENT_ROLES[role] ?? SUBAGENT_ROLES["explorer"]!) + (readOnly ? READ_IN_BATCHES : "");
  const s = extras.session ?? {};

  const context =
    s.goal || s.request
      ? `\n\n## Session context (from the lead agent's task memory)` +
        (s.goal ? `\nSession goal: ${s.goal}` : "") +
        (s.request ? `\nWhat the person asked for this turn: ${s.request}` : "")
      : "";

  const rules = [
    "Stay inside this brief. The lead agent is handling everything else, and work outside the brief is work it will do twice.",
    readOnly
      ? "Do not create, edit or delete any file. Your job is to find out and report."
      : "Change only what the brief needs. Read a file before you edit it, and match the code around your change.",
    "You cannot ask the person anything. If something blocks you, do what you can, then say exactly what is missing in your report.",
    "Every claim needs evidence: a file:line, a command and its output, or a URL. Say \"unverified\" for anything you could not check.",
    "You cannot delegate further. Do the work yourself.",
    "Finish with the report below: a direct answer, not a story of how you got there.",
  ];

  const report = [
    "1. **Result**: the answer or outcome, in the first lines. Done, partly done, or blocked, and why.",
    readOnly
      ? "2. **Findings**: each with its file:line (or URL) and what it shows, most important first."
      : "2. **Changes**: every file you changed, and what changed in it and why.",
    "3. **Evidence**: the commands you ran and the lines of their output that prove the result.",
    "4. **Open issues**: what you could not verify, the risks you saw, and anything left for the lead agent.",
  ];

  return (
    `[SUB-AGENT ROLE: ${role}]\n` +
    `You are a ${role.replace(/_/g, " ")} sub-agent working for SoreQen Code, the lead agent, inside a larger ` +
    `task. You were given this one part of it.\n\n` +
    `## How you work\n${instruction}` +
    `\n\n## Your task\n${task.trim()}` +
    block("Done when", extras.doneWhen) +
    block("Already known (use it; do not re-derive it)", extras.known) +
    block("Out of scope (leave these alone)", extras.outOfScope) +
    context +
    section("The person's requirements (these bind you too)", s.constraints) +
    section("Decisions already made", s.decisions) +
    section("Already tried and failed (do not repeat)", s.failures) +
    section("Files changed so far this session", s.filesChanged) +
    section("Start from these files", contextFiles) +
    section("Rules", rules) +
    `\n\n## Your report\nReturn one report in this shape:\n${report.join("\n")}`
  );
}
