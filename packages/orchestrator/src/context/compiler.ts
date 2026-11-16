/**
 * The working set: what the model is shown this step, besides the conversation.
 *
 * Rebuilt every step from durable state, and never stored in the
 * conversation — so it cannot pile up, go stale in the history, or be
 * repeated. It holds two things:
 *
 *   the task state   goal, constraints, decisions, hypotheses, failures,
 *                    files changed, next actions — always, within its budget
 *   evidence         the code most relevant to what the agent is doing now,
 *                    chosen by `retrieval.ts` for the current phase
 *
 * ## Progressive disclosure
 *
 * Evidence is shown at the cheapest level that is useful. Every item gets its
 * location, its declaration and why it was chosen; only the few highest-value
 * items — more when implementing or debugging, fewer when exploring — are
 * shown as code, and only while the budget lasts. A file already visible
 * unchanged in the conversation is never shown again.
 */

import { estimateTokens } from "@sqcode/shared";
import type { LLMMessage, LLMToolCall } from "../types.js";
import type { RepoIndex } from "./repo-index.js";
import { graphOf, neighbourhoodLine } from "./code-graph.js";
import { retrieve, type Embedder, type RetrievalQuery, type ScoredItem, type Signal } from "./retrieval.js";
import { normalisePath, renderTaskState, type Phase, type TaskState } from "./task-state.js";

const READS = new Set(["read_file"]);
const WRITES = new Set(["write_file", "edit_file"]);
/**
 * A command that verifies something: a test runner, a type-check, a linter,
 * a build. Anchored to how such commands are actually invoked, so that
 * `Test-Path node_modules/vitest` or `tsconfig.json` does not count as one.
 */
export const VERIFY_COMMAND =
  /(?:^|[\s;&|(])(?:npx\s+|pnpm\s+(?:exec\s+)?|yarn\s+|bunx?\s+)?(?:vitest|jest|pytest|mocha|playwright\s+test|tsc|eslint|ruff|mypy)\b|\b(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?(?:test|typecheck|lint|check|build)\b|\b(?:go|cargo|dotnet|mvn|gradle)\s+test\b|\bpython\d?\s+-m\s+(?:pytest|unittest)\b/i;
const TESTS = VERIFY_COMMAND;

/** Code shown in full for this many of the top items, by phase. */
const BODIES: Record<Phase, number> = {
  discovery: 1,
  planning: 1,
  implementation: 3,
  debugging: 3,
  testing: 2,
  review: 2,
};
/** The most one item may cost in code. */
const MAX_BODY_TOKENS = 900;

interface CallRecord {
  call: LLMToolCall;
  content: string;
  failed: boolean;
  index: number;
}

/** The calls in a history with their results, oldest first. */
/**
 * Whether the current request is still a message in the conversation sent.
 *
 * A checkpoint removes it; until one does, it is the first thing the model
 * reads, and a pointer to a saved copy only sends the model to read it twice.
 */
export function requestInView(state: TaskState, history: LLMMessage[]): boolean {
  const latest = state.requests[state.requests.length - 1];
  if (!latest?.file) return false;
  const opening = latest.text.slice(0, 200);
  if (!opening) return false;
  return history.some((m) => {
    if (m.role !== "user" || m.fromLoop) return false;
    const text = typeof m.content === "string" ? m.content : m.content.map((b) => (b.type === "text" ? b.text : "")).join("");
    return text.trimStart().startsWith(opening);
  });
}

export function callsOf(messages: LLMMessage[]): CallRecord[] {
  const byId = new Map<string, LLMToolCall>();
  for (const m of messages) for (const c of m.toolCalls ?? []) byId.set(c.id, c);
  const out: CallRecord[] = [];
  messages.forEach((m, index) => {
    if (m.role !== "tool" || !m.toolCallId || typeof m.content !== "string") return;
    const call = byId.get(m.toolCallId);
    if (!call) return;
    const failed = m.content.startsWith("FAILED:") || /"exit_?[cC]ode"\s*:\s*[1-9]/.test(m.content.slice(0, 400));
    out.push({ call, content: m.content, failed, index });
  });
  return out;
}

/**
 * What the agent is doing, from what it has just done.
 *
 * A failure among the last few results means debugging; a test or type-check
 * just run means testing; a write means implementing; a plan just written
 * means planning; the loop says when it is reviewing. Otherwise it is still
 * finding its way.
 */
export function detectPhase(calls: CallRecord[], hint?: Phase): Phase {
  if (hint) return hint;
  const recent = calls.slice(-6);
  const last3 = recent.slice(-3);
  if (last3.some((c) => c.failed && c.call.name !== "read_file" && c.call.name !== "grep_search")) return "debugging";
  const lastTwo = recent.slice(-2);
  if (lastTwo.some((c) => c.call.name === "run_tests" || (c.call.name === "run_command" && TESTS.test(String(c.call.input["command"] ?? ""))))) {
    return "testing";
  }
  if (recent.slice(-4).some((c) => WRITES.has(c.call.name))) return "implementation";
  if (lastTwo.some((c) => c.call.name === "update_todo_list") && !calls.some((c) => WRITES.has(c.call.name))) return "planning";
  if (calls.some((c) => WRITES.has(c.call.name)) && recent.length > 0 && recent.every((c) => READS.has(c.call.name))) {
    return "implementation";
  }
  return "discovery";
}

/** The retrieval query for this step, from the task state and the recent work. */
export function buildQuery(state: TaskState, calls: CallRecord[], phase: Phase): RetrievalQuery {
  const recent = calls.slice(-8);
  const focus = new Set<string>();
  for (const c of recent) {
    const p = c.call.input["path"];
    if (typeof p === "string" && p) focus.add(normalisePath(p));
  }
  const lastFailure = [...calls].reverse().find((c) => c.failed);
  const failureIsRecent = lastFailure && calls.length - calls.indexOf(lastFailure) <= 4;

  const active = state.entries.filter((e) => e.status === "active" || e.status === "stale");
  const request = state.requests[state.requests.length - 1]?.text ?? state.goal;
  const text = [
    request,
    ...state.plan.filter((p) => p.status === "in_progress").map((p) => p.text),
    ...active.filter((e) => e.kind === "hypothesis" || e.kind === "next_action" || e.kind === "unknown").map((e) => e.text),
  ].join("\n");

  const taskFiles = new Set<string>();
  for (const e of active) {
    if (e.source.type === "file" || /\.[a-z]{1,5}$/i.test(e.source.ref)) taskFiles.add(normalisePath(e.source.ref));
  }

  // What the conversation already shows, current: full reads not overtaken by a write.
  const inContext = new Map<string, string>();
  const lastWrite = new Map<string, number>();
  for (const c of calls) {
    const p = typeof c.call.input["path"] === "string" ? normalisePath(c.call.input["path"] as string) : "";
    if (p && WRITES.has(c.call.name) && !c.failed) lastWrite.set(p, c.index);
  }
  for (const c of calls) {
    if (c.call.name !== "read_file" || c.failed || c.content.startsWith("[")) continue;
    const p = typeof c.call.input["path"] === "string" ? normalisePath(c.call.input["path"] as string) : "";
    const ranged = c.call.input["start_line"] !== undefined || c.call.input["end_line"] !== undefined;
    if (p && !ranged && (lastWrite.get(p) ?? -1) < c.index) inContext.set(p, "read");
  }

  return {
    text,
    ...(failureIsRecent ? { errorText: lastFailure!.content.slice(0, 2_000) } : {}),
    phase,
    focusFiles: [...focus],
    modifiedFiles: Object.values(state.files)
      .filter((f) => f.lastAction !== "read")
      .map((f) => ({ path: f.path, step: f.step })),
    taskFiles: [...taskFiles],
    currentStep: state.step,
    inContext,
  };
}

export interface RetrievedDebug {
  path: string;
  lines: [number, number];
  symbol?: string;
  disclosure: "code" | "outline";
  relevance: number;
  utility: number;
  tokens: number;
  signals: Record<Signal, number>;
  reasons: string[];
}

export interface CompiledWorkingSet {
  text: string;
  tokens: number;
  stateTokens: number;
  evidenceTokens: number;
  stateOmitted: number;
  phase: Phase;
  retrieved: RetrievedDebug[];
  considered: number;
  duplicates: number;
  duplicateTokens: number;
}

/*
 * Worded so that it does not read as a fresh start. "Rebuilt every step" was
 * taken as one: MiMo opened nearly every thought with "The working set is
 * rebuilt. I'm at step 62. What's done: …" and planned the task again from
 * the top (30 Oct 2026).
 */
const FRAME_HEADER =
  "[Working set: reference notes kept current by SoreQen, refreshed with each tool result. Not a new message and not a restart: " +
  "carry on from your last step and do not recap it. " +
  "Task state is authoritative for goal, constraints and decisions. Evidence below was retrieved for the current phase; " +
  "code_graph to see how code connects, read_file anything else, retrieve_context to search, update_task_state to record decisions, hypotheses and findings.]";

export function compileWorkingSet(input: {
  state: TaskState;
  /** Facts from earlier sessions, already checked for staleness. Shown after the state. */
  knowledge?: string;
  index: RepoIndex | null;
  history: LLMMessage[];
  phase: Phase;
  budgetTokens: number;
  stateBudgetTokens: number;
  embedder?: Embedder;
}): CompiledWorkingSet {
  const { state, index, phase } = input;
  const calls = callsOf(input.history);
  const stateView = renderTaskState(state, input.stateBudgetTokens, { requestInView: requestInView(state, input.history) });

  const parts = [FRAME_HEADER, stateView.text, ...(input.knowledge ? [input.knowledge] : [])];
  let used = estimateTokens(parts.join("\n\n"));
  const retrieved: RetrievedDebug[] = [];
  let considered = 0;
  let duplicates = 0;
  let duplicateTokens = 0;

  /*
   * Where the files being changed sit in the code: what uses them, what they
   * import, which tests cover them — a line each, from the code graph, so a
   * change is made knowing what it reaches without a search to find out.
   */
  if (index && index.files.size > 0 && used < input.budgetTokens - 400) {
    const changing = Object.entries(state.files)
      .filter(([, f]) => f.lastAction === "edit" || f.lastAction === "write")
      .sort((a, b) => b[1].step - a[1].step)
      .slice(0, 5)
      .map(([p]) => p);
    if (changing.length > 0) {
      const graph = graphOf(index);
      const lines = changing.map((p) => neighbourhoodLine(index, graph, p)).filter((l): l is string => l !== null);
      if (lines.length > 0) {
        const section = `## CODE MAP (the files you are changing; code_graph for more)\n${lines.map((l) => `- ${l}`).join("\n")}`;
        const cost = estimateTokens(section);
        if (used + cost < input.budgetTokens - 200) {
          parts.push(section);
          used += cost;
        }
      }
    }
  }

  if (index && index.chunks.size > 0 && used < input.budgetTokens - 200) {
    const query = buildQuery(state, calls, phase);
    const result = retrieve(index, query, { limit: 10, ...(input.embedder ? { embedder: input.embedder } : {}) });
    considered = result.considered;
    duplicates = result.duplicates;
    duplicateTokens = result.duplicateTokens;

    const lines: string[] = [];
    let bodies = 0;
    for (const item of result.items) {
      const shown = renderItem(item, index, bodies < BODIES[phase]);
      const cost = estimateTokens(shown.text);
      if (used + cost > input.budgetTokens) {
        const outline = renderItem(item, index, false);
        const outlineCost = estimateTokens(outline.text);
        if (used + outlineCost > input.budgetTokens) continue;
        lines.push(outline.text);
        used += outlineCost;
        retrieved.push(debugOf(item, "outline", outlineCost));
        continue;
      }
      if (shown.disclosure === "code") bodies++;
      lines.push(shown.text);
      used += cost;
      retrieved.push(debugOf(item, shown.disclosure, cost));
    }
    if (lines.length > 0) {
      parts.push(`## RELEVANT CODE (phase: ${phase}; ${retrieved.length} of ${considered} candidates, best first)\n${lines.join("\n")}`);
    }
  }

  const text = parts.join("\n\n");
  const tokens = estimateTokens(text);
  return {
    text,
    tokens,
    stateTokens: stateView.tokens,
    evidenceTokens: Math.max(0, tokens - stateView.tokens),
    stateOmitted: stateView.omitted,
    phase,
    retrieved,
    considered,
    duplicates,
    duplicateTokens,
  };
}

function debugOf(item: ScoredItem, disclosure: "code" | "outline", tokens: number): RetrievedDebug {
  return {
    path: item.chunk.path,
    lines: [item.chunk.start, item.chunk.end],
    ...(item.chunk.symbol ? { symbol: item.chunk.symbol } : {}),
    disclosure,
    relevance: round(item.relevance),
    utility: round(item.utility),
    tokens,
    signals: Object.fromEntries(Object.entries(item.signals).map(([k, v]) => [k, round(v)])) as Record<Signal, number>,
    reasons: item.reasons,
  };
}

function renderItem(item: ScoredItem, index: RepoIndex, withBody: boolean): { text: string; disclosure: "code" | "outline" } {
  const c = item.chunk;
  const head = `- ${c.path}:${c.start}-${c.end}${c.symbol ? ` \`${c.symbol}\`` : ""} @${c.fileHash.slice(0, 7)} — ${item.reasons.slice(0, 3).join("; ") || "related"}`;
  if (withBody) {
    const maxLines = Math.max(8, Math.floor((MAX_BODY_TOKENS * 3.5) / 60));
    const lines = c.text.split("\n");
    const body = lines.slice(0, maxLines).join("\n");
    const more = lines.length > maxLines ? `\n  … ${lines.length - maxLines} more lines (read_file ${c.path} ${c.start + maxLines}-${c.end})` : "";
    const lang = c.path.split(".").pop() ?? "";
    return { text: `${head}\n\`\`\`${lang}\n${body}\n\`\`\`${more}`, disclosure: "code" };
  }
  const sig = c.signature ? `\n    ${c.signature}` : "";
  const outline = !c.symbol ? index.outline(c.path, 6) : "";
  return { text: `${head}${sig}${outline ? `\n${outline}` : ""}`, disclosure: "outline" };
}

function round(n: number): number {
  return Math.round(n * 1000) / 1000;
}
