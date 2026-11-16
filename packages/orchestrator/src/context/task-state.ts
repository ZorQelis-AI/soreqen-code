/**
 * Task memory that lives outside the model's context.
 *
 * ## Why not the transcript
 *
 * The conversation was the agent's only memory. Everything it knew — the
 * constraint the user stated in the first message, the approach it abandoned
 * forty steps ago and why, the file it spent ten steps finding — existed only
 * as text somewhere in a history that has to be cut down to fit. Cutting it
 * lost exactly those things, and a narrative summary written to replace them
 * blurred the one distinction that matters most in debugging: what is known
 * versus what is merely suspected.
 *
 * ## What this is
 *
 * A typed record of the task, kept in the workspace and handed to the model
 * each step as a compact block. Every entry says what kind of claim it is and
 * where it came from:
 *
 *   constraint   a requirement from the user; evicted last, past sixty
 *   decision     a choice made, and why
 *   fact         established by evidence (a file, a command's output)
 *   observation  something seen, not yet interpreted
 *   hypothesis   a suspicion to test — never shown as a fact
 *   failure      something that did not work, with its error
 *   unknown      a question still open
 *   next_action  what is to be done
 *
 * Entries derived from a file carry the content hash they were derived from.
 * When the file changes, they are marked stale rather than silently kept —
 * the model is told the claim may no longer hold.
 */

import type { SandboxRunner } from "@sqcode/sandbox-runner";
import { estimateTokens } from "@sqcode/shared";

export type EntryKind =
  | "constraint"
  | "decision"
  | "fact"
  | "observation"
  | "hypothesis"
  | "failure"
  | "unknown"
  | "next_action";

export type EntryStatus = "active" | "confirmed" | "refuted" | "resolved" | "done" | "stale";

/** Where a claim came from. */
export interface Provenance {
  type: "user" | "tool" | "file" | "model" | "artifact" | "transcript";
  /** A path, a tool call id, an artifact path, or a transcript range. */
  ref: string;
  lines?: [number, number];
  /** Content hash of the file when the claim was made. */
  revision?: string;
  step?: number;
}

export interface StateEntry {
  id: string;
  kind: EntryKind;
  text: string;
  status: EntryStatus;
  source: Provenance;
  createdStep: number;
  updatedStep: number;
}

export interface FileRecord {
  path: string;
  /** Content hash as last seen or written, when known. */
  hash?: string;
  lastAction: "read" | "write" | "edit" | "delete";
  step: number;
}

export type Phase = "discovery" | "planning" | "implementation" | "debugging" | "testing" | "review";

export interface CheckpointRecord {
  step: number;
  at: number;
  reason: string;
  tokensBefore: number;
  tokensAfter: number;
  extracted: number;
  /**
   * `extract`: a stretch of conversation was read into task state and left in
   * place. `cut`: the older conversation was dropped from the history. Records
   * written before rolling checkpoints existed have neither, and were cuts.
   */
  kind?: "extract" | "cut" | "extract_failed";
}

/**
 * How far the conversation has been read into task state.
 *
 * The last message a checkpoint extracted, by id when it has one and by a
 * fingerprint of it and the two before it otherwise. Everything after it has
 * not been read; everything up to it never is again. This is what makes
 * each checkpoint read only its own stretch of the conversation.
 */
export interface ExtractionMark {
  id?: string;
  fingerprint: string;
  step: number;
}

export interface TaskState {
  version: 1;
  sessionId: string;
  /** What the session is for: the first request. */
  goal: string;
  /**
   * The latest requests, newest last. The current one is what the turn is
   * doing. `text` is its opening; a long one is saved whole at `file` and
   * `length` says how long it is.
   */
  requests: { text: string; step: number; file?: string; length?: number }[];
  phase: Phase;
  plan: { text: string; status: string }[];
  entries: StateEntry[];
  files: Record<string, FileRecord>;
  /** Steps taken across the whole session, all turns. */
  step: number;
  checkpoints: CheckpointRecord[];
  /** The plan was carried over from a turn the user stopped. */
  planCarried?: boolean;
  /** How far the conversation has been read into this state. See `ExtractionMark`. */
  extractedThrough?: ExtractionMark;
}

/** Entries of each kind kept before the least useful are dropped. */
const MAX_PER_KIND = 40;
/**
 * Constraints are kept longer than anything else, but not without limit.
 *
 * They were exempt from pruning and from the render budget both, and they are
 * added automatically from every request that says "should" or "only" — so a
 * long session grew a list that eventually filled the whole state budget on
 * its own and pushed decisions and failures out of view.
 */
const MAX_CONSTRAINTS = 60;
const MAX_READ_FILES = 400;
const MAX_REQUESTS = 5;
const MAX_TEXT = 600;
/** How soon after a change the state is written, when nothing else saves it first. */
const FLUSH_DEBOUNCE_MS = 1_500;

export function emptyTaskState(sessionId: string): TaskState {
  return {
    version: 1,
    sessionId,
    goal: "",
    requests: [],
    phase: "discovery",
    plan: [],
    entries: [],
    files: {},
    step: 0,
    checkpoints: [],
  };
}

/** Where a session's state lives in its workspace. */
export function statePathFor(sessionId: string): string {
  return `.soreqen/state/${sessionId.replace(/[^\w.-]/g, "_")}.json`;
}

export function normalisePath(path: string): string {
  return path.trim().replace(/\\/g, "/").replace(/^(\.\/)+/, "");
}

function normaliseText(text: string): string {
  return text.toLowerCase().replace(/\s+/g, " ").replace(/[.!]+$/, "").trim();
}

/** FNV-1a over a string: a content revision, not a security boundary. */
/**
 * Whether a provenance reference points at a file.
 *
 * A reference is not always a bare path: an entry extracted at a checkpoint
 * reads "messages 1-14 (checkpoint 1) · read_file src/auth.ts", and one the
 * model recorded may be "src/auth.ts:40-58". Every path-like token in it
 * counts, compared whole — `a.test.ts` does not refer to `a.ts`.
 */
export function refersTo(ref: string, path: string): boolean {
  const p = normalisePath(path);
  if (normalisePath(ref) === p) return true;
  for (const token of ref.match(/[\w@.\-/\\]+\.[A-Za-z0-9]{1,8}\b/g) ?? []) {
    const t = normalisePath(token);
    if (t === p || t.endsWith(`/${p}`) || p.endsWith(`/${t}`)) return true;
  }
  return false;
}

export function contentHash(text: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

/**
 * Phrases that mark a user's sentence as a requirement.
 *
 * Deliberately narrow. A constraint is never evicted, so a false positive
 * costs space on every step for the rest of the session; a missed one can
 * still be recorded by the model with `update_task_state`.
 */
const CONSTRAINT_CUE = new RegExp(
  [
    // Requirements and prohibitions.
    String.raw`\b(must|must not|mustn't|do not|don't|never|always|only|should|should not|shouldn't|cannot|can't|make sure|ensure|without|avoid|required?|keep)\b`,
    String.raw`\b(not allowed|forbidden|prohibited|mandatory|strictly|stick to|prefer|instead of|no more than|no less than|at most|at least|exactly|under \d+|within \d+|up to \d+)\b`,
    // Hinglish, as people here actually write requests: "mat karna", "nahi chahiye", "zaroor".
    String.raw`\b(mat|nahi|nahin|zaroor|zarur|hamesha|kabhi nahi|sirf|bilkul)\b`,
  ].join("|"),
  "i",
);

/** The sentences of a request that state requirements. */
export function extractConstraints(text: string): string[] {
  const sentences = text
    .replace(/\r/g, "")
    .split(/(?<=[.!?])\s+|\n+/)
    .map((s) => s.replace(/^[\s*\-•\d.)]+/, "").trim())
    .filter((s) => s.length >= 12 && s.length <= 400);
  const out: string[] = [];
  for (const sentence of sentences) {
    if (!CONSTRAINT_CUE.test(sentence)) continue;
    // A question is not a requirement.
    if (/\?$/.test(sentence)) continue;
    out.push(sentence);
    if (out.length >= 12) break;
  }
  return out;
}

export class TaskStateStore {
  private dirty = false;
  private counter = 0;

  constructor(
    public state: TaskState,
    private readonly runner: SandboxRunner | null = null,
    private readonly workspaceId: string = "",
  ) {
    this.counter = state.entries.reduce((max, e) => Math.max(max, Number(e.id.slice(1)) || 0), 0);
  }

  /** The session's saved state, or a fresh one. Never throws. */
  static async load(runner: SandboxRunner, workspaceId: string, sessionId: string): Promise<TaskStateStore> {
    try {
      const { content } = await runner.readFile(workspaceId, statePathFor(sessionId));
      const parsed = JSON.parse(content) as TaskState;
      if (parsed && parsed.version === 1 && Array.isArray(parsed.entries)) {
        return new TaskStateStore({ ...emptyTaskState(sessionId), ...parsed, sessionId }, runner, workspaceId);
      }
    } catch {
      // No saved state yet, or unreadable: start clean.
    }
    return new TaskStateStore(emptyTaskState(sessionId), runner, workspaceId);
  }

  get isDirty(): boolean {
    return this.dirty;
  }

  /** Write the state to the workspace, when it changed. Never throws. */
  async save(): Promise<boolean> {
    if (this.flushTimer) clearTimeout(this.flushTimer);
    this.flushTimer = null;
    // One write at a time, in order: a later save never lands before an earlier one.
    const run = this.writing.then(() => this.write()).catch(() => {
      this.dirty = true;
      return false;
    });
    // The chain itself never rejects: one failed write must not refuse every later one.
    this.writing = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  private async write(): Promise<boolean> {
    if (!this.dirty || !this.runner) return false;
    // Cleared before the write, so a change made while it is in flight marks it dirty again.
    this.dirty = false;
    try {
      await this.runner.writeFile(
        this.workspaceId,
        statePathFor(this.state.sessionId),
        JSON.stringify(this.state, null, 1),
        true,
      );
      return true;
    } catch {
      this.dirty = true;
      return false;
    }
  }

  private writing: Promise<void> = Promise.resolve();
  private flushTimer: ReturnType<typeof setTimeout> | null = null;

  /**
   * A change, saved shortly after.
   *
   * The loop saves after every tool batch and at the end of a turn; between
   * those, a decision recorded with `update_task_state` lived only in memory,
   * and a crash in that window lost it. A burst of changes is one write.
   */
  private touch(): void {
    this.dirty = true;
    if (!this.runner || this.flushTimer) return;
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      void this.save();
    }, FLUSH_DEBOUNCE_MS);
    this.flushTimer.unref?.();
  }

  advanceStep(): number {
    this.state.step++;
    this.touch();
    return this.state.step;
  }

  setPhase(phase: Phase): void {
    if (this.state.phase === phase) return;
    this.state.phase = phase;
    this.touch();
  }

  /** A new request from the user: becomes the current one, and its requirements become constraints. */
  addRequest(text: string): void {
    const clean = text.trim().slice(0, 4_000);
    if (!clean) return;
    if (!this.state.goal) this.state.goal = clean.slice(0, 1_500);
    this.state.requests.push({ text: clean.slice(0, 1_500), step: this.state.step });
    if (this.state.requests.length > MAX_REQUESTS) this.state.requests.splice(0, this.state.requests.length - MAX_REQUESTS);
    for (const constraint of extractConstraints(clean)) {
      this.add({ kind: "constraint", text: constraint, source: { type: "user", ref: "request", step: this.state.step } });
    }
    this.touch();
  }

  /** Where the current request is saved whole, when it is too long for the state to hold. */
  attachRequestFile(file: string, length: number): void {
    const current = this.state.requests[this.state.requests.length - 1];
    if (!current) return;
    current.file = file;
    current.length = length;
    this.touch();
  }

  setPlan(items: { title?: string; text?: string; content?: string; status?: string }[], carried = false): void {
    this.state.planCarried = carried;
    this.state.plan = items
      .map((i) => ({ text: String(i.title ?? i.text ?? i.content ?? "").slice(0, 200), status: String(i.status ?? "pending") }))
      .filter((i) => i.text)
      .slice(0, 30);
    this.touch();
  }

  /**
   * Record a claim. The same claim twice updates the first rather than
   * duplicating it — and never changes its kind: a hypothesis restated is
   * still a hypothesis until something confirms it.
   */
  add(input: { kind: EntryKind; text: string; source: Provenance; status?: EntryStatus }): StateEntry {
    const text = input.text.trim().slice(0, MAX_TEXT);
    const key = normaliseText(text);
    const existing = this.state.entries.find((e) => e.kind === input.kind && normaliseText(e.text) === key);
    if (existing) {
      existing.updatedStep = this.state.step;
      if (existing.status === "stale" || input.status) existing.status = input.status ?? "active";
      if (input.source.revision) existing.source = input.source;
      this.touch();
      return existing;
    }
    const entry: StateEntry = {
      id: `e${++this.counter}`,
      kind: input.kind,
      text,
      status: input.status ?? "active",
      source: input.source,
      createdStep: this.state.step,
      updatedStep: this.state.step,
    };
    this.state.entries.push(entry);
    this.prune(input.kind);
    this.touch();
    return entry;
  }

  /** Change an entry's status: a hypothesis confirmed or refuted, an action done. */
  update(id: string, status: EntryStatus, note?: string): StateEntry | null {
    const entry = this.state.entries.find((e) => e.id === id);
    if (!entry) return null;
    entry.status = status;
    entry.updatedStep = this.state.step;
    if (note) entry.text = `${entry.text} — ${note}`.slice(0, MAX_TEXT);
    this.touch();
    return entry;
  }

  /**
   * A file was read or changed.
   *
   * On a change, everything derived from an earlier revision of it goes
   * stale: a fact about `auth.ts` observed before `auth.ts` was edited may no
   * longer be true, and saying so is the difference between an agent that
   * re-checks and one that reasons from something that stopped being real.
   */
  recordFile(path: string, action: FileRecord["lastAction"], hash?: string): string[] {
    const p = normalisePath(path);
    const previous = this.state.files[p];
    if (action === "read" && previous && previous.lastAction !== "read") {
      /*
       * Reading a file this session changed does not un-change it. The record
       * keeps saying "edited at step N" — only the revision seen is updated —
       * or "files changed" would forget every file the agent checked its work in.
       */
      if (hash && previous.hash !== hash) {
        this.state.files[p] = { ...previous, hash };
        this.touch();
      }
      return [];
    }
    this.state.files[p] = { path: p, lastAction: action, step: this.state.step, ...(hash ? { hash } : {}) };
    if (!previous) this.forgetOldReads();
    const invalidated: string[] = [];
    if (action !== "read") {
      for (const entry of this.state.entries) {
        if (entry.status === "stale" || entry.status === "refuted" || entry.status === "done") continue;
        // Claims about the code go stale; intentions and requirements do not.
        if (entry.kind !== "fact" && entry.kind !== "observation" && entry.kind !== "hypothesis") continue;
        if (!refersTo(entry.source.ref, p)) continue;
        if (entry.source.revision && hash && entry.source.revision === hash) continue;
        entry.status = "stale";
        entry.updatedStep = this.state.step;
        invalidated.push(entry.id);
      }
    }
    if (!previous || previous.hash !== hash || previous.lastAction !== action) this.touch();
    return invalidated;
  }

  /**
   * The file list, bounded. Every file changed is kept — "files changed this
   * session" must be complete — but files only read are forgotten oldest
   * first past `MAX_READ_FILES`, or a long exploration grows the state file
   * by one record per file it ever looked at.
   */
  private forgetOldReads(): void {
    const reads = Object.values(this.state.files).filter((f) => f.lastAction === "read");
    if (reads.length <= MAX_READ_FILES) return;
    reads.sort((a, b) => a.step - b.step);
    for (const f of reads.slice(0, reads.length - MAX_READ_FILES)) delete this.state.files[f.path];
  }

  modifiedFiles(): FileRecord[] {
    return Object.values(this.state.files)
      .filter((f) => f.lastAction !== "read")
      .sort((a, b) => b.step - a.step);
  }

  /** The conversation has been read into this state up to `mark`. */
  markExtracted(mark: ExtractionMark): void {
    this.state.extractedThrough = mark;
    this.touch();
  }

  recordCheckpoint(record: CheckpointRecord): void {
    this.state.checkpoints.push(record);
    if (this.state.checkpoints.length > 20) this.state.checkpoints.shift();
    this.touch();
  }

  /**
   * Drop the least useful entries of a kind once there are too many.
   *
   * "Not active" is not the same as "not needed". A confirmed fact is the
   * most valuable thing in the state, and it was the first thing dropped,
   * because it was lumped in with finished actions and resolved failures.
   * Entries now go in order of how little they are still worth (see
   * `EVICTION_ORDER`), oldest first within each rank.
   */
  private prune(kind: EntryKind): void {
    const cap = kind === "constraint" ? MAX_CONSTRAINTS : MAX_PER_KIND;
    const ofKind = this.state.entries.filter((e) => e.kind === kind);
    if (ofKind.length <= cap) return;
    const doomed = new Set(
      evictionOrder(ofKind)
        .slice(0, ofKind.length - cap)
        .map((e) => e.id),
    );
    this.state.entries = this.state.entries.filter((e) => !doomed.has(e.id));
  }
}

/**
 * Which statuses go first when a kind is full: finished work, then claims
 * that stopped being true, then what was ruled out, then live work, and
 * confirmed facts last of all.
 */
const EVICTION_ORDER: Record<EntryStatus, number> = {
  done: 0,
  resolved: 0,
  stale: 1,
  refuted: 2,
  active: 3,
  confirmed: 4,
};

/** Ids are e1, e2, … in the order entries were made. */
function idNumber(e: StateEntry): number {
  return Number(e.id.slice(1)) || 0;
}

/** Entries in the order they would be dropped. Exported for tests. */
export function evictionOrder(entries: StateEntry[]): StateEntry[] {
  /*
   * What the person said outlives what the agent inferred. Oldest-first put
   * the requirements stated at the start of a session — the ones everything
   * else rests on — first in line once constraints piled up (audit, 1 Oct
   * 2026). A live requirement of theirs now goes only after every other.
   */
  const rank = (e: StateEntry): number =>
    EVICTION_ORDER[e.status] + (e.source.type === "user" && (e.status === "active" || e.status === "confirmed") ? 10 : 0);
  return [...entries].sort((a, b) => rank(a) - rank(b) || a.updatedStep - b.updatedStep || idNumber(a) - idNumber(b));
}

/** How an entry reads in the working set: its id, its kind in words, and where it came from. */
function line(e: StateEntry): string {
  const where = e.source.ref && e.source.type !== "user" ? ` (${sourceLabel(e.source)})` : "";
  const status =
    e.status === "active" ? "" : e.status === "stale" ? " [STALE — its source changed; re-verify]" : ` [${e.status}]`;
  return `- ${e.id}: ${e.text}${where}${status}`;
}

export function sourceLabel(s: Provenance): string {
  const lines = s.lines ? `:${s.lines[0]}-${s.lines[1]}` : "";
  const rev = s.revision ? `@${s.revision.slice(0, 7)}` : "";
  const step = s.step !== undefined && s.type !== "file" ? ` step ${s.step}` : "";
  return `${s.type === "file" ? "" : `${s.type} `}${s.ref}${lines}${rev}${step}`.trim();
}

/** Entries of every kind shown before any kind is shown more. See `renderTaskState`. */
const FLOOR_PER_KIND = 2;

const SECTIONS: { kind: EntryKind; title: string; statuses: EntryStatus[] }[] = [
  { kind: "constraint", title: "Constraints (from the user — always hold)", statuses: ["active", "stale"] },
  { kind: "decision", title: "Decisions", statuses: ["active", "stale"] },
  { kind: "failure", title: "Failures (do not repeat these)", statuses: ["active", "stale"] },
  { kind: "hypothesis", title: "Hypotheses (UNVERIFIED — test before relying on them)", statuses: ["active", "stale"] },
  { kind: "fact", title: "Facts (with evidence)", statuses: ["active", "confirmed", "stale"] },
  { kind: "unknown", title: "Open questions", statuses: ["active"] },
  { kind: "next_action", title: "Next actions", statuses: ["active"] },
  { kind: "observation", title: "Observations", statuses: ["active", "stale"] },
];

/**
 * The state as the model reads it, within a budget.
 *
 * Constraints and the current request are never cut. The rest is filled in
 * priority order — decisions, failures, hypotheses, facts — newest first
 * within each, until the budget is spent. Refuted hypotheses are shown in one
 * line, because "we ruled that out" is worth knowing.
 */
export function renderTaskState(
  state: TaskState,
  budgetTokens: number,
  options: {
    /**
     * Whether the request itself is still in the conversation being sent.
     * Unknown (a checkpoint's own reading of the state) counts as gone.
     */
    requestInView?: boolean;
  } = {},
): { text: string; tokens: number; omitted: number } {
  const out: string[] = [];
  const latest = state.requests[state.requests.length - 1];
  const current = latest?.text ?? state.goal;
  out.push("## TASK STATE (durable memory — survives compaction; ids like e12 can be updated with update_task_state)");
  if (state.goal && state.goal !== current) out.push(`Session goal: ${clip(state.goal, 400)}`);
  /*
   * The saved copy of a long request, named only once the message is gone.
   *
   * Named every step while the message was still in the conversation, it read
   * as an instruction: DeepSeek read a 21,700-character spec back from its
   * file, 787 lines, a few steps into the turn it had arrived in (reported
   * 6 Nov 2026: "it again read that prompt via saving it in a file"). While
   * the message is in view the copy adds nothing, so the line says where the
   * request already is; after a checkpoint drops it, the file is the request.
   */
  const length = (latest?.length ?? 0).toLocaleString("en-US");
  out.push(
    `Current request: ${clip(current, 900)}` +
      (latest?.file
        ? options.requestInView
          ? `\n(The opening of a ${length}-character request. All of it is the user's message above, in this conversation: work from that, not from a copy.)`
          : `\n(The request is ${length} characters; this is its opening. Its earlier message is no longer in this conversation, so the whole of it, word for word, is saved at ${latest.file}. Read it there for any detail you need.)`
        : ""),
  );
  out.push(`Phase: ${state.phase} · step ${state.step}`);
  if (state.plan.length > 0) {
    out.push(
      state.planCarried
        ? "Plan (still open from the turn the user stopped — continue it; if the current request changes direction, update_todo_list to revise it):"
        : "Plan:",
    );
    for (const item of state.plan) out.push(`- [${item.status}] ${item.text}`);
  }

  let used = estimateTokens(out.join("\n"));
  /*
   * Once every item of the plan is done, the next actions recorded along the
   * way are history. Listed with their ids, two at a time, they read as work
   * left — and an agent closed them two by two for eighteen steps before it
   * would finish (29 Sep 2026). Now they are counted, not listed.
   */
  const planDone = state.plan.length > 0 && state.plan.every((item) => /^(done|completed|complete)$/i.test(item.status));
  const leftoverActions = planDone ? state.entries.filter((e) => e.kind === "next_action" && e.status === "active").length : 0;
  const sections = planDone ? SECTIONS.filter((s) => s.kind !== "next_action") : SECTIONS;
  const lists = sections.map((section) => ({
    section,
    entries: state.entries
      .filter((e) => e.kind === section.kind && section.statuses.includes(e.status))
      // Newest first; within a step, the one recorded later.
      .sort((a, b) => b.updatedStep - a.updatedStep || idNumber(b) - idNumber(a))
      .map((e) => ({ e, text: line(e), cost: estimateTokens(line(e)) + 1 })),
    chosen: new Set<string>(),
  }));
  const take = (list: (typeof lists)[number], limit: number, max: number): void => {
    let n = 0;
    for (const item of list.entries) {
      if (n >= limit) break;
      if (list.chosen.has(item.e.id)) {
        n++;
        continue;
      }
      if (used + item.cost > max) continue;
      list.chosen.add(item.e.id);
      used += item.cost;
      n++;
    }
  };

  /*
   * Three passes, so that no one kind can crowd out the rest.
   *
   * Filled strictly in priority order, forty recent facts left no room for
   * the next actions below them, and a long list of constraints — never cut
   * at all — could take the whole budget on its own. So: constraints first,
   * newest first, up to 40% of the budget (the newest one always); then the
   * newest two of every other kind; then the rest in priority order.
   */
  const [constraints, ...rest] = lists;
  const constraintMax = Math.max(used + (constraints!.entries[0]?.cost ?? 0), used + Math.floor(budgetTokens * 0.4));
  take(constraints!, Infinity, constraintMax);
  for (const list of rest) take(list, FLOOR_PER_KIND, budgetTokens);
  for (const list of rest) take(list, Infinity, budgetTokens);

  let omitted = 0;
  const notShown: string[] = [];
  for (const list of lists) {
    const shown = list.entries.filter((item) => list.chosen.has(item.e.id));
    const missing = list.entries.length - shown.length;
    if (missing > 0) {
      omitted += missing;
      notShown.push(`${missing} ${list.section.kind.replace("_", " ")}${missing === 1 ? "" : "s"}`);
    }
    if (shown.length > 0) out.push([`${list.section.title}:`, ...shown.map((item) => item.text)].join("\n"));
  }

  if (leftoverActions > 0) {
    out.push(`(The plan is complete. ${leftoverActions} next action${leftoverActions === 1 ? "" : "s"} recorded earlier are not listed: they need nothing unless the request asks for more.)`);
  }
  const refuted = state.entries.filter((e) => e.kind === "hypothesis" && e.status === "refuted").slice(-6);
  if (refuted.length > 0) out.push(`Ruled out: ${refuted.map((e) => `${e.id} ${clip(e.text, 80)}`).join("; ")}`);

  const modified = Object.values(state.files).filter((f) => f.lastAction !== "read").sort((a, b) => b.step - a.step);
  if (modified.length > 0) {
    out.push(
      `Files changed this session: ${modified
        .slice(0, 25)
        .map((f) => `${f.path}${f.hash ? `@${f.hash.slice(0, 7)}` : ""}`)
        .join(", ")}${modified.length > 25 ? ` (+${modified.length - 25} more)` : ""}`,
    );
  }
  if (omitted > 0) {
    out.push(`(Older entries not shown, to fit the budget: ${notShown.join(", ")}. They are still recorded; the newest of each kind are above.)`);
  }
  const text = out.join("\n");
  return { text, tokens: estimateTokens(text), omitted };
}

function clip(text: string, max: number): string {
  const one = text.replace(/\s+/g, " ").trim();
  return one.length > max ? `${one.slice(0, max - 1)}…` : one;
}
