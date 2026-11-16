/**
 * The context engine: the one object the agent loop talks to.
 *
 * Every step runs the same cycle:
 *
 *   task state ─► retrieve evidence ─► rank ─► budget ─► compile ─► model
 *        ▲                                                             │
 *        └──────── update durable state ◄── process results ◄── tools ◄┘
 *
 * The model's context is a working set, assembled fresh each step. What
 * persists lives elsewhere: the task state in `.soreqen/state/`, the
 * repository index in memory, large outputs as artifacts in
 * `.soreqen/artifacts/`, and the conversation itself in the session store.
 *
 * Nothing here runs a model except `checkpoint`, and nothing here throws into
 * the loop: a failure in the engine degrades to the history the loop already
 * has, never to a failed turn.
 */

import type { SandboxRunner } from "@sqcode/sandbox-runner";
import { estimateHistoryTokens } from "../context-manager.js";
import { slotOf, tidyHistory } from "../context-hygiene.js";
import type { LLMMessage, LLMProvider, LLMToolCall } from "../types.js";
import type { ContextBudget } from "./budget.js";
import { VERIFY_COMMAND, buildQuery, callsOf, compileWorkingSet, detectPhase, type RetrievedDebug } from "./compiler.js";
import { indexFor, type IndexStats, type RepoIndex } from "./repo-index.js";
import { fileText, graphOf, impactText, keyPath, neighbourhoodLine, overviewText, searchText, symbolText } from "./code-graph.js";
import { restoreWorkingFiles } from "./restore-files.js";
import { retrieve, type Embedder } from "./retrieval.js";
import { checkpointHistory, extractAhead, readDue, type CheckpointResult } from "./state-checkpoint.js";
import {
  TaskStateStore,
  contentHash,
  emptyTaskState,
  normalisePath,
  sourceLabel,
  statePathFor,
  type CheckpointRecord,
  type EntryKind,
  type EntryStatus,
  type Phase,
  type Provenance,
} from "./task-state.js";
import { artifactPathFor, gateHistory, storeArtifact } from "./tool-gateway.js";
import { distillOutput } from "../tool-output.js";
import { WorkspaceKnowledge, renderKnowledge } from "./workspace-knowledge.js";
import { embedderFromEnv } from "./vector-embedder.js";

export interface CompressionEvent {
  step: number;
  kind:
    | "superseded"
    | "aged"
    | "artifact"
    | "stale"
    | "checkpoint"
    | "checkpoint_failed"
    | "extracted"
    | "invalidated"
    | "budget"
    | "reclaimed";
  detail: string;
  savedTokens: number;
}

export interface ContextDebug {
  step: number;
  phase: Phase;
  at: number;
  budget: ContextBudget;
  tokens: {
    system: number;
    tools: number;
    /** History as stored. */
    historyRaw: number;
    /** History as sent, after the gateway and hygiene. */
    history: number;
    workingSet: number;
    state: number;
    evidence: number;
    total: number;
  };
  history: {
    messages: number;
    superseded: number;
    aged: number;
    gated: number;
    staleReads: number;
    savedTokens: number;
  };
  retrieved: RetrievedDebug[];
  considered: number;
  duplicates: number;
  duplicateTokens: number;
  stale: { id: string; kind: EntryKind; text: string; source: string }[];
  compressions: CompressionEvent[];
  checkpoints: CheckpointRecord[];
  index: IndexStats;
  cache: { sealedMessages: number; sealedTokens: number };
}

export interface Prepared {
  /** The history as the model should see it: hygiene and gateway applied. */
  view: LLMMessage[];
  /** The working set, to append after the history. */
  frame: string;
  phase: Phase;
  checkpointNeeded: boolean;
  debug: ContextDebug;
}

const MAX_COMPRESSIONS = 40;
/** Steps a failed read-ahead waits before it is tried again. */
const READ_RETRY_STEPS = 5;
/** Re-tidy already-sent history once this much of it, and this share, is dead output. See `prepare`. */
const RECLAIM_MIN_TOKENS = 20_000;
const RECLAIM_SHARE = 0.3;
const WRITES = new Set(["write_file", "edit_file"]);
const TEST_COMMAND = VERIFY_COMMAND;

export class ContextEngine {
  private firstPrepare = true;
  /** What the last step sent: the raw history and the form it was sent in. See `keepSent`. */
  private sent: { raw: LLMMessage[]; view: LLMMessage[] } | null = null;
  private readonly writtenArtifacts = new Set<string>();
  private compressions: CompressionEvent[] = [];
  private lastDebug: ContextDebug | null = null;
  /** Facts earlier sessions in this workspace established. See `workspace-knowledge.ts`. */
  private knowledge: WorkspaceKnowledge = WorkspaceKnowledge.empty();

  private constructor(
    readonly store: TaskStateStore,
    readonly index: RepoIndex | null,
    private readonly runner: SandboxRunner,
    private readonly workspaceId: string,
    private readonly sessionId: string,
    private readonly embedder?: Embedder,
  ) {}

  static async open(input: {
    runner: SandboxRunner;
    workspaceId: string;
    sessionId: string;
    embedder?: Embedder;
    /** Skip the repository index — for tests, or a runner that cannot list. */
    withoutIndex?: boolean;
  }): Promise<ContextEngine> {
    const store = await TaskStateStore.load(input.runner, input.workspaceId, input.sessionId);
    const index = input.withoutIndex ? null : indexFor(input.runner, input.workspaceId);
    // A real embedding model when one is configured (SOREQEN_EMBEDDINGS_URL/MODEL); word roots otherwise.
    const embedder = input.embedder ?? (index ? (embedderFromEnv() ?? undefined) : undefined);
    const engine = new ContextEngine(store, index, input.runner, input.workspaceId, input.sessionId, embedder);
    engine.knowledge = await WorkspaceKnowledge.load(input.runner, input.workspaceId);
    return engine;
  }

  /**
   * Forget a session's task state — after its conversation was rewound, so
   * decisions from the abandoned branch do not steer the new one.
   */
  static async reset(runner: SandboxRunner, workspaceId: string, sessionId: string): Promise<void> {
    await runner
      .writeFile(workspaceId, statePathFor(sessionId), JSON.stringify(emptyTaskState(sessionId), null, 1), true)
      .catch(() => undefined);
  }

  /**
   * A session with history but no task state — one that predates the engine,
   * or was just rewound — gets its goal and constraints from its first
   * request. Only the first: later user-role messages include the loop's own
   * notes, whose "do not"s are not the user's requirements. Anything else
   * the older messages established is extracted at the next checkpoint.
   */
  seedFrom(history: LLMMessage[]): void {
    if (this.store.state.goal || this.store.state.requests.length > 0) return;
    const first = history.find(
      (m) => m.role === "user" && !m.fromLoop && typeof m.content === "string" && !m.content.startsWith("["),
    );
    if (first) this.store.addRequest(String(first.content));
  }

  get debug(): ContextDebug | null {
    return this.lastDebug;
  }

  // ---- observing ---------------------------------------------------------------

  observeUserMessage(text: string): void {
    this.store.addRequest(text);
  }

  observePlan(items: { title?: string; text?: string; content?: string; status?: string }[], options: { carried?: boolean } = {}): void {
    this.store.setPlan(items, options.carried ?? false);
  }

  /**
   * A tool result, as it enters the conversation.
   *
   * Updates the task state from what the result shows — files changed, a
   * failure with its error, a failure fixed — and saves a large output as an
   * artifact so the digest the model sees can point at the whole of it.
   */
  async observeToolResult(input: {
    call: LLMToolCall;
    success: boolean;
    content: string;
    full?: string;
    artifact?: string;
  }): Promise<void> {
    const { call, success, content } = input;
    const step = this.store.state.step;
    try {
      const path = typeof call.input["path"] === "string" ? normalisePath(call.input["path"] as string) : "";

      if (WRITES.has(call.name) && success && path) {
        const hash =
          call.name === "write_file" && typeof call.input["content"] === "string"
            ? contentHash(call.input["content"] as string)
            : undefined;
        const invalidated = this.store.recordFile(path, call.name === "write_file" ? "write" : "edit", hash);
        this.index?.markDirty(path);
        if (invalidated.length > 0) {
          this.note({ step, kind: "invalidated", detail: `${invalidated.join(", ")} derived from ${path}, which changed`, savedTokens: 0 });
        }
      } else if (call.name === "read_file" && success && path) {
        this.store.recordFile(path, "read", this.index?.files.get(path)?.hash);
      }

      const slot = slotOf(call);
      if (!success && call.name !== "ask_user") {
        this.store.add({
          kind: "failure",
          text: `${describe(call)}: ${firstError(content)}`,
          source: { type: "tool", ref: slot ?? call.name, step },
        });
      } else if (success && slot) {
        // A command that failed before and passes now: the failure is resolved.
        for (const e of this.store.state.entries) {
          if (e.kind === "failure" && e.status === "active" && e.source.ref === slot) {
            this.store.update(e.id, "resolved", `passed at step ${step}`);
          }
        }
        if ((call.name === "run_tests" || (call.name === "run_command" && TEST_COMMAND.test(String(call.input["command"] ?? ""))))) {
          this.store.add({ kind: "observation", text: `${describe(call)} passed`, source: { type: "tool", ref: slot, step } });
        }
      }

      /*
       * The whole output, as lines.
       *
       * Saved as it arrived, a JSON result was one line, so the read_file
       * range a digest points at returned that one line whatever range was
       * asked for (23 Oct 2026). `full` is already distilled
       * (`shapeToolOutput`); content that was never cut is distilled here.
       */
      // A read's full output is the file itself; see `gateHistory`. A paged
      // document names its own artifact, and is saved whatever its size.
      if (input.artifact || (content.length > 6_000 && call.name !== "read_file")) {
        const artifact = input.artifact ?? artifactPathFor(this.sessionId, call.name, content);
        if (!this.writtenArtifacts.has(artifact)) await this.ensureIgnored();
        const whole = input.full ?? distillOutput(content);
        if (!this.writtenArtifacts.has(artifact) && (await storeArtifact(this.runner, this.workspaceId, artifact, whole))) {
          this.writtenArtifacts.add(artifact);
        }
      }
    } catch {
      // Memory is an aid; a failure to update it never fails the turn.
    }
  }

  // ---- the model's own tools ---------------------------------------------------------

  /** `update_task_state`: the model records what it decided, suspects, found, or plans. */
  updateTaskState(input: {
    add?: { kind?: string; text?: string; source?: string }[];
    update?: { id?: string; status?: string; note?: string }[];
  }): { success: boolean; data?: unknown; error?: string } {
    const kinds: EntryKind[] = ["constraint", "decision", "fact", "observation", "hypothesis", "failure", "unknown", "next_action"];
    const statuses: EntryStatus[] = ["active", "confirmed", "refuted", "resolved", "done"];
    const added: string[] = [];
    const notes: string[] = [];
    for (const item of input.add ?? []) {
      const kind = kinds.find((k) => k === item.kind);
      const text = String(item.text ?? "").trim();
      if (!kind || !text) {
        notes.push(`skipped an item: kind must be one of ${kinds.join(", ")}, with text`);
        continue;
      }
      const source = this.provenanceOf(item.source);
      /*
       * A fact needs evidence. Without a source it is recorded as an
       * observation, and the model is told — so "I think X" cannot enter
       * durable memory as "X".
       */
      const effective: EntryKind = kind === "fact" && !item.source ? "observation" : kind;
      if (effective !== kind) notes.push(`"${text.slice(0, 60)}" was recorded as an observation: a fact needs a source (path:lines, command, or artifact)`);
      added.push(this.store.add({ kind: effective, text, source }).id);
    }
    const updated: string[] = [];
    for (const item of input.update ?? []) {
      const status = statuses.find((s) => s === item.status);
      if (!item.id || !status) {
        notes.push(`skipped an update: needs an id and a status of ${statuses.join(", ")}`);
        continue;
      }
      /*
       * A whole kind at once. The state shows the newest few of each kind, so
       * an agent closing old next actions two at a time was shown two more each
       * step — eighteen steps, a minute of thought each (29 Sep 2026).
       */
      const whole = /^all:(\w+)$/.exec(item.id);
      if (whole) {
        const kind = kinds.find((k) => k === whole[1]);
        if (!kind) {
          notes.push(`no kind ${whole[1]}: one of ${kinds.join(", ")}`);
          continue;
        }
        const ids = this.store.state.entries.filter((e) => e.kind === kind && e.status === "active").map((e) => e.id);
        for (const id of ids) this.store.update(id, status, item.note);
        updated.push(`${ids.length} ${kind} entries→${status}`);
        continue;
      }
      if (this.store.update(item.id, status, item.note)) updated.push(`${item.id}→${status}`);
      else notes.push(`no entry ${item.id}`);
    }
    return {
      success: added.length + updated.length > 0,
      data: { added, updated, ...(notes.length > 0 ? { notes } : {}) },
      ...(added.length + updated.length === 0 ? { error: notes.join("; ") || "Nothing to record." } : {}),
    };
  }

  /**
   * `code_graph`: the codebase as a graph — its shape, a file's place in it, a
   * symbol's users and uses, what a change reaches. See `code-graph.ts`.
   */
  /** Files and names already given a graph note this turn: once each is enough. */
  private graphNoted = new Set<string>();

  /**
   * The graph, delivered where the model already looks.
   *
   * Measured on 1 Oct 2026 across every session since the graph shipped:
   * about 1,000 tool calls by the main agents and several thousand by
   * sub-agents, and not one of them was `code_graph` — the models read and
   * grep by habit, whatever the prompt recommends. So the graph rides along
   * with those: the first read of a source file says what uses it, what it
   * imports and which tests cover it, and a search for a declared name says
   * where it is declared and how widely it is used. One line each, once per
   * turn, from the graph already built — no extra call.
   *
   * Measured again on 4 Oct 2026: still no `code_graph` calls, and only 11
   * notes in ~4,900 calls, because most work is in projects the agent builds
   * from nothing, where the index was empty when the turn started and never
   * caught up. So the index is brought up to date first (only what changed),
   * and an edit gets the note that matters most: which files depend on the
   * one just changed and which tests cover it, so a change to an export is
   * checked where it lands instead of discovered as a broken build later.
   */
  async graphNote(call: LLMToolCall, success: boolean): Promise<string | null> {
    if (!success || !this.index) return null;
    const edited =
      (call.name === "edit_file" || call.name === "write_file") && typeof call.input["path"] === "string"
        ? normalisePath(call.input["path"] as string)
        : null;
    try {
      if (edited) this.index.markDirty(edited);
      if (this.index.hasDirty() || this.index.files.size === 0) await this.index.refresh(false);
      if (this.index.files.size === 0) return null;
      const graph = graphOf(this.index);
      if (edited) {
        const file =
          this.index.files.get(edited) ?? [...this.index.files.values()].find((f) => edited.endsWith(`/${f.path}`));
        if (!file?.isCode || this.graphNoted.has(`edit:${file.path}`)) return null;
        const users = new Set<string>();
        for (const n of graph.nodes.values()) {
          if (n.path !== file.path) continue;
          for (const from of graph.callers.get(n.key)?.keys() ?? []) {
            const p = keyPath(from);
            if (p !== file.path) users.add(p);
          }
        }
        const tests = this.index.testsFor(file.path);
        if (users.size === 0 && tests.length === 0) return null;
        this.graphNoted.add(`edit:${file.path}`);
        const list = [...users].slice(0, 6).join(", ") + (users.size > 6 ? ` and ${users.size - 6} more` : "");
        return (
          `[Code graph] ${file.path} is used by ${users.size ? list : "no other file"}` +
          (tests.length ? `; covered by ${tests.slice(0, 3).join(", ")}` : "") +
          ". If this edit changed a signature, an export or behaviour they rely on, check those" +
          (tests.length ? " and run the tests" : "") +
          ` (code_graph impact ${file.path} shows the whole chain).`
        );
      }
      if (call.name === "read_file" && typeof call.input["path"] === "string") {
        const asked = normalisePath(call.input["path"] as string);
        const file =
          this.index.files.get(asked) ?? [...this.index.files.values()].find((f) => asked.endsWith(`/${f.path}`));
        if (!file?.isCode || this.graphNoted.has(file.path)) return null;
        this.graphNoted.add(file.path);
        const line = neighbourhoodLine(this.index, graph, file.path);
        return line ? `[Code graph] ${line}. Who calls a function here: code_graph symbol; what a change reaches: code_graph impact.` : null;
      }
      if (call.name === "grep_search") {
        /*
         * The name being searched for, also inside a pattern: "\bparseConfig\b",
         * "parseConfig\(", "function parseConfig", "class Session". The longest
         * word in it that the graph knows as a declared name.
         */
        const raw = String(call.input["pattern"] ?? call.input["query"] ?? "").trim();
        const words = (raw.replace(/\\[bBwWsSdD]/g, " ").match(/[A-Za-z_$][\w$]{2,}/g) ?? []).filter(
          (w) => !/^(function|class|interface|type|const|let|var|def|export|import|async|public|private|static|return|new)$/.test(w),
        );
        const pattern = [...words].sort((a, b) => b.length - a.length).find((w) => graph.find(w).some((n) => n.name === w)) ?? "";
        if (!pattern || this.graphNoted.has(`#${pattern}`)) return null;
        const found = graph.find(pattern).filter((n) => n.name === pattern);
        if (found.length === 0) return null;
        this.graphNoted.add(`#${pattern}`);
        const shown = found.slice(0, 3).map((n) => {
          const users = new Set([...(graph.callers.get(n.key)?.keys() ?? [])].map(keyPath));
          return `${n.path}:${n.line} (${n.kind}, used from ${users.size} file${users.size === 1 ? "" : "s"})`;
        });
        return `[Code graph] ${pattern} is declared at ${shown.join("; ")}${found.length > 3 ? ` and ${found.length - 3} more` : ""}. code_graph symbol ${pattern} lists every use.`;
      }
    } catch {
      // A note is a convenience; the result stands without it.
    }
    return null;
  }

  /**
   * The codebase's map at the start of work, or null where there is no
   * codebase worth mapping yet (an empty folder, a handful of files).
   */
  async startOverview(minCodeFiles = 8): Promise<string | null> {
    if (!this.index) return null;
    await this.index.refresh(this.index.files.size === 0).catch(() => undefined);
    let code = 0;
    for (const f of this.index.files.values()) if (f.isCode) code++;
    if (code < minCodeFiles) return null;
    return overviewText(this.index, graphOf(this.index));
  }

  async codeGraph(input: { action?: string; name?: string; path?: string; query?: string; depth?: number }): Promise<{ success: boolean; data?: unknown; error?: string }> {
    if (!this.index) return { success: false, error: "The code graph is not available in this session; use grep_search and read_file." };
    await this.index.refresh(this.index.files.size === 0).catch(() => undefined);
    const graph = graphOf(this.index);
    const action = String(input.action ?? "").trim() || (input.name ? "symbol" : input.path ? "file" : input.query ? "search" : "overview");
    const path = input.path ? normalisePath(String(input.path)) : undefined;
    const name = input.name ? String(input.name).trim() : undefined;
    const depth = Math.min(Math.max(1, Number(input.depth) || 3), 5);
    let text: string | null;
    switch (action) {
      case "overview":
        text = overviewText(this.index, graph);
        break;
      case "file":
        if (!path) return { success: false, error: "code_graph file needs a 'path'." };
        text = fileText(this.index, graph, path);
        if (text === null) return { success: false, error: `${path} is not in the code graph (not a source file, too large, or not there). Try glob.` };
        break;
      case "symbol":
        if (!name) return { success: false, error: "code_graph symbol needs a 'name'." };
        text = symbolText(this.index, graph, name, path);
        if (text === null) return { success: false, error: `No declaration named ${name}${path ? ` in ${path}` : ""}. Try code_graph search, or grep_search for a name that is not declared (a key, a string).` };
        break;
      case "impact":
        if (!name && !path) return { success: false, error: "code_graph impact needs a 'name' or a 'path'." };
        text = impactText(this.index, graph, { ...(name ? { name } : {}), ...(path ? { path } : {}) }, depth);
        if (text === null) return { success: false, error: `Nothing named ${name ?? path} in the code graph.` };
        break;
      case "search":
        if (!input.query && !name) return { success: false, error: "code_graph search needs a 'query'." };
        text = searchText(graph, String(input.query ?? name));
        break;
      default:
        return { success: false, error: `Unknown action '${action}'. Use overview, file, symbol, impact or search.` };
    }
    return { success: true, data: text };
  }

  /** `retrieve_context`: the model asks the retriever directly. */
  async retrieveContext(input: { query?: string; detail?: string; limit?: number }): Promise<{ success: boolean; data?: unknown; error?: string }> {
    const query = String(input.query ?? "").trim();
    if (!query) return { success: false, error: "retrieve_context needs a 'query'." };
    if (!this.index) return { success: false, error: "The repository index is not available in this session; use grep_search." };
    await this.index.refresh(this.index.files.size === 0).catch(() => undefined);
    await this.embedder?.prepare?.(query, this.index).catch(() => undefined);
    const result = retrieve(
      this.index,
      {
        text: query,
        phase: this.store.state.phase,
        focusFiles: [],
        modifiedFiles: this.store.modifiedFiles().map((f) => ({ path: f.path, step: f.step })),
        taskFiles: [],
        currentStep: this.store.state.step,
        inContext: new Map(),
      },
      { limit: Math.min(Math.max(1, input.limit ?? 8), 20), ...(this.embedder ? { embedder: this.embedder } : {}) },
    );
    const withCode = input.detail === "code";
    return {
      success: true,
      data: {
        considered: result.considered,
        results: result.items.map((item, i) => ({
          location: `${item.chunk.path}:${item.chunk.start}-${item.chunk.end}`,
          ...(item.chunk.symbol ? { symbol: item.chunk.symbol } : {}),
          ...(item.chunk.signature ? { signature: item.chunk.signature } : {}),
          revision: item.chunk.fileHash.slice(0, 7),
          score: Math.round(item.relevance * 1000) / 1000,
          why: item.reasons,
          ...(withCode && i < 4 ? { code: item.chunk.text.split("\n").slice(0, 60).join("\n") } : {}),
        })),
        ...(result.items.length === 0 ? { note: "Nothing matched. Try other words, or grep_search for an exact string." } : {}),
      },
    };
  }

  // ---- each step -----------------------------------------------------------------------

  async prepare(input: {
    history: LLMMessage[];
    budget: ContextBudget;
    hint?: Phase;
    sealed?: { messages: number; tokens: number };
    /** False to re-prepare the same step, e.g. straight after a checkpoint. */
    advance?: boolean;
  }): Promise<Prepared> {
    const step = input.advance === false ? this.store.state.step : this.store.advanceStep();

    if (this.index) {
      try {
        const changed = await this.index.refresh(this.firstPrepare);
        // Files the agent changed get the hash they now have.
        for (const path of changed) {
          const record = this.store.state.files[path];
          const hash = this.index.files.get(path)?.hash;
          if (record && hash && record.lastAction !== "read" && record.hash !== hash) {
            this.store.recordFile(path, record.lastAction, hash);
          }
        }
      } catch {
        // An index that cannot refresh is used as it stands.
      }
    }
    this.firstPrepare = false;

    const tidy = tidyHistory(input.history);
    const gate = gateHistory(tidy.messages, this.sessionId);
    // Already-sent messages stay byte-identical, so the provider's cache holds. See `keepSent`.
    let kept = keepSent(this.sent, input.history, gate.messages);
    /*
     * Unless keeping them has stopped paying.
     *
     * A long turn that re-runs the same commands and snapshots the same page
     * keeps every superseded copy while the sent form is kept, and the view
     * grows toward the checkpoint point on dead output. Once tidying would
     * remove a large share of it, one full-price request to re-send the tidied
     * view costs less than carrying the dead weight — and an early cut — for
     * the rest of the turn.
     */
    if (kept.kept > 0) {
      const keptTokens = estimateHistoryTokens(kept.view);
      const waste = keptTokens - estimateHistoryTokens(gate.messages);
      if (waste >= RECLAIM_MIN_TOKENS && waste >= keptTokens * RECLAIM_SHARE) {
        kept = { view: gate.messages, kept: 0, staleUnmarked: [] };
        this.note({ step, kind: "reclaimed", detail: `re-tidied the sent history: ${waste.toLocaleString()} tokens of superseded output dropped`, savedTokens: waste });
      }
    }
    const view = kept.view;
    this.sent = { raw: input.history.slice(), view };
    await this.ensureArtifacts(gate.stats.artifacts);

    const calls = callsOf(gate.messages);
    const phase = detectPhase(calls, input.hint);
    this.store.setPhase(phase);

    if (this.index && this.embedder?.prepare) {
      const q = buildQuery(this.store.state, calls, phase);
      await this.embedder.prepare([q.text, q.errorText ?? ""].join("\n"), this.index).catch(() => undefined);
    }
    const index = this.index;
    const knowledge = index
      ? renderKnowledge(
          this.knowledge.current(this.sessionId, (p) => index.files.get(p)?.hash, this.store.state.entries),
          Math.floor(input.budget.stateMax / 3),
        )
      : "";
    const ws = compileWorkingSet({
      state: this.store.state,
      ...(knowledge ? { knowledge } : {}),
      index: this.index,
      history: view,
      phase,
      budgetTokens: input.budget.workingSet,
      stateBudgetTokens: input.budget.stateMax,
      ...(this.embedder ? { embedder: this.embedder } : {}),
    });

    const historyRaw = estimateHistoryTokens(input.history);
    const history = estimateHistoryTokens(view);
    const saved = Math.max(0, historyRaw - history);
    if (tidy.stats.superseded > 0) this.note({ step, kind: "superseded", detail: `${tidy.stats.superseded} outputs replaced by newer ones`, savedTokens: 0 });
    if (tidy.stats.aged > 0) this.note({ step, kind: "aged", detail: `${tidy.stats.aged} older outputs condensed`, savedTokens: 0 });
    if (gate.stats.gated > 0) this.note({ step, kind: "artifact", detail: `${gate.stats.gated} large outputs shown as digests with artifacts`, savedTokens: 0 });
    if (gate.stats.staleReads > 0) this.note({ step, kind: "stale", detail: `${gate.stats.staleReads} reads marked stale`, savedTokens: 0 });

    const debug: ContextDebug = {
      step,
      phase,
      at: Date.now(),
      budget: input.budget,
      tokens: {
        system: input.budget.system,
        tools: input.budget.tools,
        historyRaw,
        history,
        workingSet: ws.tokens,
        state: ws.stateTokens,
        evidence: ws.evidenceTokens,
        total: input.budget.system + input.budget.tools + history + ws.tokens,
      },
      history: {
        messages: view.length,
        superseded: tidy.stats.superseded,
        aged: tidy.stats.aged,
        gated: gate.stats.gated,
        staleReads: gate.stats.staleReads,
        savedTokens: saved,
      },
      retrieved: ws.retrieved,
      considered: ws.considered,
      duplicates: ws.duplicates,
      duplicateTokens: ws.duplicateTokens,
      stale: this.store.state.entries
        .filter((e) => e.status === "stale")
        .slice(-20)
        .map((e) => ({ id: e.id, kind: e.kind, text: e.text.slice(0, 160), source: sourceLabel(e.source) })),
      compressions: this.compressions.slice(-MAX_COMPRESSIONS),
      checkpoints: this.store.state.checkpoints.slice(-10),
      index: this.index?.stats ?? { files: 0, chunks: 0, symbols: 0, edges: 0, tests: 0, builtMs: 0, truncated: false },
      cache: { sealedMessages: input.sealed?.messages ?? 0, sealedTokens: input.sealed?.tokens ?? 0 },
    };
    this.lastDebug = debug;

    return {
      view,
      frame: kept.staleUnmarked.length > 0
        ? `${ws.text}

Changed since you last read them — read again before editing from those reads: ${kept.staleUnmarked.join(", ")}.`
        : ws.text,
      phase,
      checkpointNeeded: history > input.budget.checkpointAt,
      debug,
    };
  }

  /** A read of the conversation into task state, running beside the turn. See `readAhead`. */
  private reading: Promise<void> | null = null;
  /**
   * After a read fails, the step before which it is not tried again. A read
   * that failed was due again at the very next step, and was attempted on
   * every step until one succeeded — each a full request (28 Sep 2026).
   */
  private readRetryStep = 0;

  /**
   * Read the unread conversation into task state once `minTokens` of it has
   * accumulated — in the background, so the step that triggers it does not
   * wait. One read at a time; a later call while one is running does nothing,
   * and the next step asks again. See `extractAhead`.
   */
  readAhead(input: {
    history: LLMMessage[];
    /** The history as sent — the sizes the meter shows. See `readDue`. */
    view: LLMMessage[];
    provider: LLMProvider;
    model?: string;
    /** Read at every multiple of this: 80k, 160k, 240k … */
    every: number;
    /** Also read when the conversation passes this, just short of the cut. */
    nearCutAt?: number;
    signal?: AbortSignal;
  }): boolean {
    if (this.reading) return false;
    if (this.store.state.step < this.readRetryStep) return false;
    const due = readDue({
      history: input.history,
      sizes: alignedSizes(input.history, input.view),
      mark: this.store.state.extractedThrough,
      every: input.every,
      ...(input.nearCutAt !== undefined ? { nearCutAt: input.nearCutAt } : {}),
    });
    if (!due) return false;
    this.reading = extractAhead({
      history: input.history,
      provider: input.provider,
      ...(input.model ? { model: input.model } : {}),
      ...(input.signal ? { signal: input.signal } : {}),
      // Due is decided above; whatever is unread, however little, is read.
      minTokens: 1,
      store: this.store,
      onFailure: (reason) =>
        this.note({ step: this.store.state.step, kind: "checkpoint_failed", detail: `reading ahead stopped: ${reason}`, savedTokens: 0 }),
    })
      .then(async (result) => {
        if (!result) return;
        if (!result.ok) this.readRetryStep = this.store.state.step + READ_RETRY_STEPS;
        this.note({
          step: this.store.state.step,
          kind: "extracted",
          detail: `read ${result.tokens.toLocaleString()} tokens of conversation into task state (${result.count} entries); nothing removed yet`,
          savedTokens: 0,
        });
        await this.store.save();
      })
      // A cancelled turn or a failed request leaves the mark where it was; the next read starts there.
      .catch(() => undefined)
      .finally(() => {
        this.reading = null;
      });
    return true;
  }

  /** Wait for a background read to finish, so nothing writes the state after the turn has saved it. */
  async settle(): Promise<void> {
    await this.reading;
  }

  /**
   * The conversation as the model is shown it: repeated steps collapsed, old
   * output condensed, large output as digests with artifacts. No step is
   * advanced and nothing is noted.
   *
   * A checkpoint asked for between turns reads this, not the stored record.
   * The record of a month-long session was 13 MB — over a hundred stretches to
   * read — while the model's own view of it was a small part of that; the
   * task state can only hold what the model was shown anyway (13 Nov 2026).
   * Message ids survive tidying, so the extraction mark and the compaction's
   * `coversThroughId` still point into the stored record.
   */
  async tidied(history: LLMMessage[]): Promise<LLMMessage[]> {
    const gate = gateHistory(tidyHistory(history).messages, this.sessionId);
    await this.ensureArtifacts(gate.stats.artifacts);
    return gate.messages;
  }

  /** Checkpoint the history into task state. See `state-checkpoint.ts`. */
  async checkpoint(input: {
    history: LLMMessage[];
    provider: LLMProvider;
    model?: string;
    keepRecentTokens: number;
    signal?: AbortSignal;
    /** Room for the working files restored after the cut, in tokens. See `restore-files.ts`. */
    restoreTokens?: number;
    /** Stretches read so far, of how many: for a person waiting on a checkpoint. */
    onProgress?: (done: number, total: number) => void;
  }): Promise<CheckpointResult | null> {
    // A read already under way covers part of what the cut drops: let it land first.
    await this.settle();
    const result = await checkpointHistory({
      ...input,
      store: this.store,
      onFailure: (reason) =>
        this.note({ step: this.store.state.step, kind: "checkpoint_failed", detail: `fell back to a summary: ${reason}`, savedTokens: 0 }),
    });
    if (result) {
      /*
       * The files it was working on, back with the checkpoint message — so the
       * steps after a cut are spent on the task, not on reading the same files
       * again. See `restore-files.ts`.
       */
      const restored = await restoreWorkingFiles({
        store: this.store,
        runner: this.runner,
        workspaceId: this.workspaceId,
        index: this.index,
        kept: result.history.slice(1),
        budgetChars: Math.floor((input.restoreTokens ?? 0) * 4),
      }).catch(() => null);
      if (restored) {
        const message: LLMMessage = { ...result.message, content: `${String(result.message.content)}\n\n${restored.text}` };
        result.history[0] = message;
        result.message = message;
        result.tokensAfter = estimateHistoryTokens(result.history);
      }
      this.note({
        step: this.store.state.step,
        kind: "checkpoint",
        detail: `${result.replaced} messages checkpointed, ${result.extracted} entries extracted${restored ? `; ${restored.files.length} working file(s) restored: ${restored.files.join(", ")}` : ""}`,
        savedTokens: Math.max(0, result.tokensBefore - result.tokensAfter),
      });
      await this.persist();
    } else {
      /*
       * What was read is kept even when the cut was not made: a checkpoint
       * stopped, or failing on its last stretch, starts the next one from
       * there instead of from the beginning.
       */
      await this.store.save().catch(() => undefined);
    }
    return result;
  }

  note(event: CompressionEvent): void {
    // Consecutive identical notes (the same stubs, every step) are one event.
    const last = this.compressions[this.compressions.length - 1];
    if (last && last.kind === event.kind && last.detail === event.detail) {
      last.step = event.step;
      return;
    }
    this.compressions.push(event);
    if (this.compressions.length > MAX_COMPRESSIONS * 2) this.compressions.splice(0, this.compressions.length - MAX_COMPRESSIONS);
  }

  async persist(): Promise<void> {
    await this.ensureIgnored();
    await this.store.save();
    // Evidenced facts outlive the session; only when their files can be pinned to a revision.
    if (this.index) {
      const index = this.index;
      this.knowledge.promote(this.sessionId, this.store.state.entries, [...index.files.keys()], (p) => index.files.get(p)?.hash);
      await this.knowledge.save();
    }
  }

  private ignored = false;

  /**
   * `.soreqen/` never shows up in the user's `git status`.
   *
   * The checkpoint snapshot writes the same file, but only in modes that take
   * one; task state and artifacts are written in every mode. Written once, and
   * not over an existing one.
   */
  private async ensureIgnored(): Promise<void> {
    if (this.ignored) return;
    this.ignored = true;
    try {
      await this.runner.readFile(this.workspaceId, ".soreqen/.gitignore");
    } catch {
      await this.runner
        .writeFile(
          this.workspaceId,
          ".soreqen/.gitignore",
          [
            "# Written by SoreQen Code. This directory holds workspace snapshots",
            "# and local agent state; none of it belongs in your repository.",
            "*",
            "",
          ].join("\n"),
          true,
        )
        .catch(() => undefined);
    }
  }

  /** An artifact a digest refers to exists, even for output recorded before this process started. */
  /*
   * Writes the artifacts the digests point at.
   *
   * The text comes from the gate itself. Re-deriving it from the raw history
   * hashed different content whenever tidying had changed a message first (a
   * superseded subagent_status, say), so the digest named a file that was never
   * written and the agent spent minutes hunting for it.
   */
  private async ensureArtifacts(artifacts: { path: string; text: string }[]): Promise<void> {
    for (const { path, text } of artifacts) {
      if (this.writtenArtifacts.has(path)) continue;
      const exists = await this.runner.statFile?.(this.workspaceId, path).catch(() => null);
      if (exists || (await storeArtifact(this.runner, this.workspaceId, path, text))) this.writtenArtifacts.add(path);
    }
  }

  private provenanceOf(raw: string | undefined): Provenance {
    const step = this.store.state.step;
    if (!raw) return { type: "model", ref: "agent", step };
    const m = /^(.+?\.[\w]{1,8})(?::(\d+)(?:-(\d+))?)?$/.exec(raw.trim());
    if (m) {
      const path = normalisePath(m[1]!);
      const hash = this.index?.files.get(path)?.hash ?? this.store.state.files[path]?.hash;
      const lines: [number, number] | undefined = m[2] ? [Number(m[2]), Number(m[3] ?? m[2])] : undefined;
      return { type: path.startsWith(".soreqen/artifacts/") ? "artifact" : "file", ref: path, ...(lines ? { lines } : {}), ...(hash ? { revision: hash } : {}), step };
    }
    return { type: "tool", ref: raw.slice(0, 160), step };
  }
}

function describe(call: LLMToolCall): string {
  const i = call.input ?? {};
  const arg = i["command"] ?? i["path"] ?? i["query"] ?? i["url"] ?? "";
  return `${call.name}${arg ? ` ${String(arg).slice(0, 100)}` : ""}`;
}

/** The line of an output that says what went wrong. */
export function firstError(content: string): string {
  const failed = /^FAILED: ([^\n]+)/.exec(content)?.[1];
  const lines = content.replace(/\\n/g, "\n").split("\n");
  const errorLine = lines.find((l) => /\b(error|Error|ERR!|FAIL|failed|exception|Traceback|cannot|not found)\b/.test(l) && !/^FAILED:/.test(l));
  const pick = errorLine ?? failed ?? lines.find((l) => l.trim()) ?? "failed";
  return pick.replace(/\s+/g, " ").trim().slice(0, 240);
}

/** The working set added to the end of a request: into the last user message, or as one. */
/**
 * Messages already sent keep the form they were sent in.
 *
 * Tidying rewrites old tool output in place — superseded runs become stubs,
 * reads overtaken by an edit are marked stale, old logs are digested. Each
 * rewrite saves a few hundred tokens and changes a message the provider has
 * already cached, and the cache cannot survive a change: measured on GPT 6
 * Luna, 24 Sep 2026, every step that rewrote an earlier result paid for the
 * whole conversation again (cached fell from ~95% to the system prompt
 * alone), while every append-only step was ~95% cached. So what was sent
 * stays as it was, and tidying applies to what is new. The next turn, or a
 * checkpoint, tidies everything again.
 *
 * Returns the view to send, and the stale-read warnings the kept part could
 * not be given — they go in the working set instead, so an edit is never made
 * from an out-of-date read.
 */
export function keepSent(
  sent: { raw: LLMMessage[]; view: LLMMessage[] } | null,
  raw: LLMMessage[],
  fresh: LLMMessage[],
): { view: LLMMessage[]; kept: number; staleUnmarked: string[] } {
  const none = { view: fresh, kept: 0, staleUnmarked: [] };
  if (!sent || raw.length < sent.raw.length || fresh.length !== raw.length || sent.view.length !== sent.raw.length) return none;
  for (let i = 0; i < sent.raw.length; i++) {
    const a = raw[i]!, b = sent.raw[i]!;
    // The same message, or the history was rewritten underneath (a checkpoint, a rewind): start again.
    if (a !== b && JSON.stringify([a.role, a.toolCallId, a.content]) !== JSON.stringify([b.role, b.toolCallId, b.content])) return none;
  }
  const kept = sent.view.length;
  const staleUnmarked: string[] = [];
  for (let i = 0; i < kept; i++) {
    const now = fresh[i]!.content, then = sent.view[i]!.content;
    const stale = typeof now === "string" ? /^\[STALE: (.+?) was changed after this read/.exec(now) : null;
    if (stale && !(typeof then === "string" && then.startsWith("[STALE: "))) staleUnmarked.push(stale[1]!);
  }
  return { view: [...sent.view, ...fresh.slice(kept)], kept, staleUnmarked: [...new Set(staleUnmarked)] };
}

/**
 * The view's size for each message of the history, index for index.
 *
 * Reading ahead measures the conversation as it is sent (`readDue`), and used
 * to give up whenever the view and the history differed in length. They do as
 * soon as one repeated step is collapsed out of the view, which in a long
 * session is nearly always: a mail session of 3,309 messages had never been
 * read into task state at all, so its first manual checkpoint had a month of
 * conversation to read and ran for hours (13 Nov 2026). A message the view
 * dropped counts as nothing; one without an id is measured as stored, which
 * errs high, the safe side for deciding a read is due.
 */
export function alignedSizes(history: LLMMessage[], view: LLMMessage[]): LLMMessage[] {
  if (view.length === history.length) return view;
  const byId = new Map<string, LLMMessage>();
  for (const m of view) if (m.id) byId.set(m.id, m);
  return history.map((m) => (m.id ? (byId.get(m.id) ?? { role: m.role, content: "" }) : m));
}

export function withFrame(messages: LLMMessage[], frame: string): LLMMessage[] {
  if (!frame) return messages;
  /*
   * Always its own message, flagged, and each provider places it: chat
   * completions fold it into the last tool result or the person's message,
   * the Responses API sends it as a developer message, and Claude's Messages
   * API as a turn-scoped system message that stays where it was sent. Merged
   * into the person's message here, it was text Claude's next request no
   * longer had — an edit before its thinking, which voided it (13 Nov 2026).
   */
  return [...messages, { role: "user", content: frame, frame: true }];
}

