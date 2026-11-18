/**
 * The ReAct loop.
 *
 * ## What a turn is, now
 *
 * Before anything is sent to a model, a turn establishes three things: the
 * **mode** it is running in, whether the workspace could be **checkpointed**,
 * and what the **effort** tier asks for. Those decide almost everything else —
 * how much the model reasons, whether it asks before writing, whether it runs
 * the tests covering its changes, and whether it reviews its own diff before
 * claiming to be finished.
 *
 * Then it loops: send, read tool calls, gate them, run them, feed results
 * back. And before it is allowed to say it is done, it has to get past
 * verification — a typecheck, optionally the affected tests, optionally a
 * review of its own complete diff.
 *
 * ## It runs until the work is done
 *
 * There used to be a step cap — 25 at High — and a turn that reached it simply
 * stopped, usually in the middle of verifying the thing it had just built,
 * with no message on the web surface to say why. There is no cap now. What
 * used to end long turns has been dealt with at the cause instead:
 *
 *   - **A dropped connection or an overloaded provider** is retried with
 *     backoff (`MAX_MODEL_ATTEMPTS`), and the surface is told it is
 *     reconnecting.
 *   - **A full context window** is condensed: older work is summarised
 *     (`summarizer.ts`) and, failing that, trimmed a whole call at a time
 *     (`context-manager.ts`) — never separating a call from its result, which
 *     is what produced the `role 'tool' must be a response…` 400s.
 *   - **A file too big for one response** is detected and the agent is told to
 *     write it in parts, rather than being asked to "continue" into the same
 *     wall forever.
 *
 * ## Ordering that matters
 *
 * **The checkpoint is taken before the first model call**, not before the
 * first write. A turn that is cancelled halfway still needs a way back, and
 * "before the first write" is a moment nobody can identify in advance.
 *
 * **Permission is decided per call, mode first, tier underneath.** See
 * `mode-policy.ts`. The tier can only ever narrow what the mode allows.
 *
 * **Gate, then execute.** Confirmations run strictly in order, because a
 * confirmation is a question put to a person and three at once is not a better
 * experience than three in a row. Execution then runs in contiguous batches of
 * parallel-safe calls — contiguous, so a batch never reorders around a write.
 *
 * **Verification runs at exactly one moment**: the model believes it is
 * finished and has touched real source. That is when a wrong answer is about
 * to become the user's problem, and it is the only point where the cost of a
 * check buys anything.
 */

import { runResearch, executeTool, whenUrgent, fitImageForModel, type ToolExecutionContext, type ToolResult } from "@sqcode/tools";
import { deepResearch } from "./research-agent.js";
import { StreamStalledError, withIdleTimeout } from "./stream-idle.js";
import {
  ASK_USER_BACK,
  EFFORT,
  EFFORTS,
  SOREQEN_TOOL_DEFINITIONS,
  autoCompactTokens,
  contextWindowFor,
  modelSupportsVision,
  scratchpadDirFor,
  estimateTokens,
  historyBudgetFor,
  isParallelSafe,
  modeDefinition,
  modeForTier,
  type AgentMode,
  type Effort,
  type StreamEvent,
  type SubagentInfo,
  type TodoItem,
} from "@sqcode/shared";
import type {
  AgentTurnOptions,
  AgentTurnResult,
  LLMContentBlock,
  LLMMessage,
  ThinkingBlock,
  LLMToolCall,
  MessageMeta,
} from "./types.js";
import { buildSystemPrompt } from "./prompt.js";
import { MEMORY_TOOL_DEFINITIONS, memoryPromptSection, runMemoryTool } from "./memory.js";
import { compactHistory, estimateHistoryTokens } from "./context-manager.js";
import { ContextEngine, budgetFor, markThrough, unreadFrom, withFrame } from "./context/index.js";
import { summarizeHistory } from "./summarizer.js";
import { clampTier, evaluateForMode } from "./mode-policy.js";
import { logAuditEvent } from "./audit.js";
import { MemoryManager } from "./memory-manager.js";
import { SelfHealer } from "./self-healer.js";
import { shapeToolOutput } from "./tool-output.js";
import { TurnCancelledError, delay, throwIfCancelled, untilCancelled } from "./resilience.js";
import { RepeatNotes } from "./repeat-notes.js";
import { meterScale } from "./meter-scale.js";
import { commandPath, createCheckpoint, type Checkpoint } from "./checkpoint.js";
import { buildRepoMap, lookupSymbol } from "./repo-map.js";
import { ToolResultCache } from "./tool-cache.js";
import { RepetitionWatch, stepFingerprint } from "./repetition.js";
import { NarrationWatch } from "./narration.js";
import { DegenerateOutputError, DegenerationWatch } from "./degenerate.js";
import { CONTROL_TAGS, describeInputError, unreadableCallMessage } from "./call-arguments.js";
import { FRESH_IMAGE } from "./context-hygiene.js";
import { extractMemories, noteExtracted, worthExtracting } from "./memory-extract.js";
import { personalSection } from "./personal.js";
import { DEFAULT_POLICY, routeStep } from "./model-router.js";
import { runAffectedTests, testFeedback } from "./test-selector.js";
import { diffSinceCheckpoint, reviewFeedback, reviewOwnDiff, type ReviewVerdict } from "./self-review.js";
import { cacheBreakpointIndex, sealPrefix, stablePrefixLength, type PrefixSeal } from "./prefix-cache.js";
import { inStep } from "./step-notes.js";
import {
  SubagentPool,
  buildBrief,
  briefSessionFrom,
  resolveRole,
  subagentConcurrencyFor,
  type SubagentReporter,
} from "./subagent-pool.js";
import { TurnLedger, readSummaryCheck } from "./turn-ledger.js";
import { attachedImages, withInlineImages } from "./attachment-images.js";
import { MAX_AUTO_SKILLS, SkillSet, readProjectSkills } from "./skills/index.js";
import { decideExternalTool, type ExternalTools, type SampleRequest, type SampleResult } from "./external-tools.js";
import { LOAD_TOOLS, isDeferrable, loadToolsDefinition, loadedIn, resolveToolNames, shouldDefer, splitToolName } from "./deferred-tools.js";
/** The most a server may have the model write for it in one sampling request. */
const MAX_SAMPLE_TOKENS = 4_096;

/** How deep delegation may nest. One level: a supervisor may call a
 *  specialist, and the specialist does the work itself. Deeper trees multiply
 *  cost geometrically while getting steadily further from the original goal. */
const MAX_SUBAGENT_DEPTH = 1;

/** Tools whose execution changes something outside the agent, and which
 *  therefore earn an audit record both before they run and after. */
const STATE_MUTATING_TOOLS = [
  "edit_file",
  "write_file",
  "run_command",
  "git_operation",
  "install_package",
];

/**
 * Model retry backoff intervals (in milliseconds).
 *
 * Begins with binary exponential backoff:
 *   Attempt 1 fails -> wait 2s (2,000ms) before attempt 2
 *   Attempt 2 fails -> wait 4s (4,000ms) before attempt 3
 *   Attempt 3 fails -> wait 8s (8,000ms) before attempt 4
 *   Attempt 4 fails -> wait 16s (16,000ms) before attempt 5
 *   Attempt 5 fails -> wait 32s (32,000ms) before attempt 6
 *
 * Followed by 1.5x geometric progression:
 *   Attempt 6 fails -> wait 64s (64,000ms) before attempt 7
 *   Attempt 7 fails -> wait 96s (96,000ms) before attempt 8
 *   Attempt 8 fails -> wait 144s (144,000ms) before attempt 9
 *   Attempt 9 fails -> wait 216s (216,000ms) before attempt 10
 *   Attempt 10 fails -> wait 324s (324,000ms) before attempt 11
 *
 * Once this schedule is exhausted (attempt 11 fails), the turn gives up and throws.
 */
export const MODEL_RETRY_SCHEDULE_MS: readonly number[] = [
  2_000,
  4_000,
  8_000,
  16_000,
  32_000,
  64_000,
  96_000,
  144_000,
  216_000,
  324_000,
] as const;

export const MAX_MODEL_ATTEMPTS = MODEL_RETRY_SCHEDULE_MS.length + 1;

/**
 * Delay in milliseconds for the given attempt number.
 * Returns null when attempts exceed the schedule, signaling that the error must be thrown.
 */
export function modelRetryDelayMs(
  attempt: number,
  schedule: readonly number[] = MODEL_RETRY_SCHEDULE_MS,
): number | null {
  if (attempt < 1 || attempt > schedule.length) return null;
  return schedule[attempt - 1]!;
}


/** A call still being written reports its progress at most this often. */
const PENDING_THROTTLE_MS = 250;

/** The same call returning the same result this many times in a row earns a
 *  note in the result. A turn with no step cap must not be able to spin. */
const REPEAT_NOTE_AT = 3;

/**
 * The same step, word for word and call for call, again and again.
 *
 * Seen 8 Oct 2026 (a sub-agent running one search nine times) and 11 Oct (a
 * write_file sent forty times with no arguments). Stopping at six was too
 * blunt: it ended work a person was waiting on (11 Oct). So the loop works
 * its way out first. After a second identical step the sampling is made
 * hotter, so the same context stops producing the same step; at the third and
 * sixth the model is told plainly what it keeps doing. Only a model that is
 * still identical at the tenth, through all of that, is stopped. Not a step
 * cap: a turn that keeps changing what it does runs as long as it needs.
 */
const STUCK_AT = 10;
/** Identical steps at which the model is told what it keeps doing. */
const STUCK_TELL = new Set([3, 6]);
/** How much hotter sampling gets per identical step after the first, and the most it adds. */
const REPEAT_HEAT_STEP = 0.2;
const REPEAT_HEAT_MAX = 0.6;
/** Tools whose results can say a process has ended; see `seenEnded`. */
const PROCESS_TOOLS = new Set(["run_command", "process_status", "wait", "stop_process"]);

/** Processes a tool result shows as no longer running. */
function endedIn(content: string): string[] {
  const out: string[] = [];
  for (const m of content.matchAll(/"process_id":"([^"]+)"[^{}]*?"status":"([a-z_]+)"/g)) {
    if (m[2] !== "running") out.push(m[1]!);
  }
  return out;
}

/** A request longer than this is also saved whole as a file; see where the turn starts. */
const LONG_REQUEST_CHARS = 12_000;

/** Finished sub-agents' reports, as the lead agent is handed them. */
function subagentReports(finished: SubagentInfo[]): string {
  return finished
    .map((agent) => {
      const head = `### ${agent.role} (${agent.id}): ${agent.status}`;
      const files = agent.filesModified && agent.filesModified.length > 0 ? `\nFiles it changed: ${agent.filesModified.join(", ")}` : "";
      const body = agent.error ? `Failed: ${agent.error}` : (agent.result ?? "(no answer)");
      return `${head}${files}\n${body}`;
    })
    .join("\n\n");
}

/** Looping responses retried in one turn before the failure is treated like any other. */
const MAX_DEGENERATE_RETRIES = 6;

/**
 * Responses that spent their whole output on thinking, retried one tier lower
 * each. A model at Max or Apex can think until the output cap and say nothing
 * (seen 6 to 8 Oct: 100,000 characters of thought, then an empty answer, then
 * "continue where you left off" and the same again, ten minutes a time).
 */
const MAX_THOUGHT_OUT = 3;

/** The tier `by` steps below `level`, never below the lowest: thinking is never off. */
function tierBelow(level: Effort, by: number): Effort {
  return EFFORTS[Math.max(0, EFFORTS.indexOf(level) - by)]!;
}

/** A call as the permission check sees it: a skill's file copied into the project is a write to that path. */
function asWrite(call: LLMToolCall): LLMToolCall {
  const to = call.input["copy_to"];
  return call.name === "use_skill" && typeof to === "string" && to.trim() ? { ...call, name: "write_file", input: { path: to.trim() } } : call;
}

/** Reasoning attached to a message only when there is some. */
function reasoningFor(text: string, blocks: ThinkingBlock[] = []): { reasoningContent?: string; thinkingBlocks?: ThinkingBlock[] } {
  return { ...(text ? { reasoningContent: text } : {}), ...(blocks.length > 0 ? { thinkingBlocks: [...blocks] } : {}) };
}

/** A path's last part, for a line about it. */
function fileName(path: string): string {
  return path.replace(/\\/g, "/").split("/").pop() || path;
}

function withoutReasoning(message: LLMMessage): LLMMessage {
  if (!message.reasoningContent && !message.thinkingBlocks) return message;
  const { reasoningContent: _dropped, thinkingBlocks: _blocks, ...rest } = message;
  return rest;
}

/**
 * The identifying fields of a tool call whose arguments are still arriving.
 *
 * Only fields whose string has been closed are read, so a path is never shown
 * half-typed. `file_path` is reported as `path`, the name every surface
 * already labels by.
 */
export function previewPartialInput(json: string): Record<string, string> | undefined {
  const preview: Record<string, string> = {};
  for (const key of ["path", "file_path", "command", "query", "url", "symbol_name", "role", "action", "package_name", "operation"]) {
    const match = json.match(new RegExp(`"${key}"\\s*:\\s*"((?:[^"\\\\]|\\\\.)*)"`));
    if (!match) continue;
    try {
      preview[key === "file_path" ? "path" : key] = JSON.parse(`"${match[1]}"`) as string;
    } catch {
      // An escape sequence cut in half; the next delta will complete it.
    }
  }
  return Object.keys(preview).length > 0 ? preview : undefined;
}

/**
 * A message the person sent while the agent was working, as the model reads it.
 *
 * Framed, because arriving between two tool results it is otherwise ambiguous:
 * a model that takes "also make it blue" as a brand-new task abandons the one
 * in progress, and one that takes "stop" as a remark keeps going. The frame
 * says when it was sent and that the work in hand continues unless the message
 * says otherwise.
 */
const FILLER = new Set(
  "please also just this that with from have make sure some them they then than what when will would could should into your about there their these those really very completely complete done finished everything".split(" "),
);

/**
 * Whether a reply takes up a message at all: it shares one of the message's
 * words that carry meaning. "Remove the Hinglish completely" answered with
 * "All six plan items are complete" shares none, and was passed over.
 */
export function addresses(reply: string, message: string): boolean {
  const words = (t: string): string[] => t.toLowerCase().match(/[\p{L}\p{N}]{4,}/gu) ?? [];
  // Whole words, less a plural or tense ending: a shared prefix made "completely" answer to "complete".
  const stem = (w: string): string => w.replace(/(ing|ed|es|s)$/, "");
  const said = new Set(words(reply).map(stem));
  return words(message).some((w) => !FILLER.has(w) && said.has(stem(w)));
}

export function interjectionContent(text: string): string {
  return [
    "[The user sent this message while you were working.]",
    "",
    text,
    "",
    "[Read it now and decide how it fits. If it changes what you are doing, change course now. If it " +
      "adds something, decide whether to do it now or right after what you are in the middle of, add it " +
      "to your plan, and do both. If it asks a question, answer it briefly and carry on. If it asks you to " +
      "stop or to do something else instead, do that. When you finish, your summary covers the whole task: " +
      "the original request and everything added while you worked.]",
  ].join("\n");
}

/** A response set aside, before anything came of it, so a new message can be read. */
class SetAsideForMessage extends Error {
  constructor() {
    super("Set aside to read a new message.");
    this.name = "SetAsideForMessage";
  }
}

/** Past this share of the checkpoint point, conversation is read into task state in smaller stretches. */
const NEAR_CUT_SHARE = 0.85;
/** How often a streaming response checks for a new message. */
const MESSAGE_POLL_MS = 400;
/**
 * A response longer than this is left to finish before a new message is read.
 *
 * Setting aside a response that has only been thinking costs a few seconds of
 * that thinking. One that is already writing a reply or a tool call — a whole
 * file, say — would be thrown away, so it completes and the message is read at
 * the next step, a moment later.
 */
const SET_ASIDE_TEXT_LIMIT = 1_500;

/** The whole of the reply that says a closing summary matches the turn record. */
const VERIFIED = "VERIFIED";

/** Tools that only keep records: a step of nothing else did no work on the task. */
const BOOKKEEPING_TOOLS = new Set(["update_task_state", "update_todo_list"]);
const BOOKKEEPING_NUDGE_AT = 2;
const BOOKKEEPING_NUDGE =
  "[Note: the last steps only updated records. The task state and plan do not need tidying before you " +
  "finish. If the request is done, write your final answer now; if not, take the next real step.]";
/** Times the agent is sent back to an unfinished plan before a turn may end anyway. */
const MAX_PLAN_NUDGES = 3;
/**
 * Steps of work without a word to the plan, before the agent is reminded of it.
 *
 * A typeface turn of 5 Nov 2026 wrote an eleven-item plan at step 8 and next
 * touched it at step 121, marking all eleven done at once: for 113 steps the
 * person's plan bar read "0 of 11". The reminder is a step note (inside the
 * step's results; see `step-notes.ts`), so it costs no reasoning, and it says
 * plainly that it may be ignored when the plan is already right.
 */
const PLAN_REMINDER_STEPS = 12;
/** At most this many plan reminders in a turn. */
const MAX_PLAN_REMINDERS = 6;

/** A request refused because the conversation no longer fits the model. */
export function isContextOverflow(err: unknown): boolean {
  const status = (err as { status?: number })?.status;
  if (status !== undefined && status !== 400 && status !== 413) return false;
  const message = String((err as { message?: string })?.message ?? "");
  return /context length|context window|maximum context|too many tokens|prompt is too long|reduce the length|exceeds the (model|maximum)/i.test(
    message,
  );
}

/** A response that has sent nothing for this long has stalled, not slowed. */
const STREAM_IDLE_MS = 5 * 60_000;

/**
 * The same, for a model asked to think at `xhigh` or `max` (Max and Apex).
 * It can reason for minutes before the next summary line arrives, and five
 * minutes of silence there is thinking, not a stall.
 */
const DEEP_STREAM_IDLE_MS = 15 * 60_000;

// The stall guard has its own module (stream-idle.ts) so the research engine can use it too.
export { StreamStalledError, withIdleTimeout };

/**
 * A response with nothing in it: no text, no tool call.
 *
 * Not an answer. Models served through gateways send these now and then — a
 * stop with an empty body — and the loop took one for the model finishing:
 * the turn closed on a blank summary and the person had to ask "What
 * happened... Continue" (seen in stored sessions, 28-30 Sep 2026). It is
 * asked for again, like any other failed request, a few times.
 */
export class EmptyResponseError extends Error {
  constructor() {
    super("The model sent an empty response.");
    this.name = "EmptyResponseError";
  }
}

/** Empty responses asked for again before the loop tells the model instead. */
const EMPTY_RESPONSE_RETRIES = 2;

/** Then it is told, this many times, before the turn ends saying so. */
/** Empty replies in a row before the turn ends on one (reset by any step that does something). */
const MAX_EMPTY_NUDGES = 3;

const EMPTY_RESPONSE_NUDGE =
  "Your last response was empty: no text and no tool call. If work remains, carry on with it now " +
  "using tool calls. If the task is finished, write your summary for the person.";

/**
 * Whether a failed model request is worth trying again.
 *
 * Statuses decide when there is one. A stream that died mid-response has none
 * — "terminated", "other side closed", a connection error — and those are
 * exactly the failures a long run meets most, so a missing status counts as
 * transient unless the message says the request itself was wrong.
 */
export function isTransientModelError(err: unknown): boolean {
  if (err instanceof TurnCancelledError) return false;
  // A spent plan window or balance is not a busy provider: asking again only fails again (17 Nov 2026).
  if ((err as { type?: string })?.type === "usage_limit") return false;
  const status = (err as { status?: number })?.status;
  if (typeof status === "number") {
    return status === 408 || status === 409 || status === 425 || status === 429 || status >= 500;
  }
  const message = String((err as { message?: string })?.message ?? err);
  return !/invalid api key|unauthori[sz]ed|forbidden|not found|invalid_request/i.test(message);
}

function retryMessage(err: unknown): string {
  if (err instanceof StreamStalledError || err instanceof EmptyResponseError) return `${err.message} Trying again.`;
  const status = (err as { status?: number })?.status;
  if (status === 429) return "The model provider is rate limiting requests.";
  if (typeof status === "number" && status >= 500) return `The model provider returned an error (${status}).`;
  return "The connection to the model was interrupted.";
}

/**
 * A tool's input as the audit trail keeps it.
 *
 * `write_file` carries the whole file, which the stored conversation already
 * has; copying it into the audit row doubled every file the agent wrote into
 * a second table. The trail records what was done and to what — the path,
 * the command — and the size of anything long.
 */
function auditableInput(input: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input ?? {})) {
    out[key] =
      typeof value === "string" && value.length > 1_000
        ? `${value.slice(0, 400)}… [${value.length.toLocaleString()} characters]`
        : value;
  }
  return out;
}

/** What the model is told when a tool call it wrote as text could not be read. */
const MALFORMED_CALL_NUDGE =
  "Your last message contained a tool call written as text (<tool_call>/<function=...> markup) that " +
  "could not be read, so it was NOT executed and nothing changed. Call tools only through the " +
  "function-calling interface, with complete arguments, and do not describe the call in prose.";

export async function runAgentTurn(options: AgentTurnOptions): Promise<AgentTurnResult> {
  const {
    workspaceId,
    sessionId,
    userMessage,
    sandboxRunner,
    llmProvider,
    onEvent,
    onAwaitConfirmation,
  } = options;

  /*
   * Mode and tier, reconciled once.
   *
   * A caller may pass either. `mode` is what the person selected;
   * `permissionTier` is what the workspace allows. When both are present the
   * tier is the ceiling and the mode is clamped to it — a read-only workspace
   * stays read-only whichever mode is chosen, and a bypass request against it
   * silently becomes plan rather than being honoured or rejected.
   */
  const requestedMode: AgentMode = options.mode ?? modeForTier(options.permissionTier ?? "guarded_autonomy");
  const modeSpec = modeDefinition(requestedMode);
  const permissionTier = options.permissionTier
    ? clampTier(modeSpec.tier, options.permissionTier)
    : modeSpec.tier;
  // After clamping, the effective mode may be narrower than the one asked for.
  const mode: AgentMode = permissionTier === modeSpec.tier ? requestedMode : modeForTier(permissionTier);

  /*
   * When the clamp changed the answer, say which mode was asked for.
   *
   * This used to happen silently, and it produced the most confusing bug in
   * the product: a CLI that sent a default `guarded_autonomy` ceiling on every
   * turn got `bypass` clamped to `auto`, printed "mode Bypass", and then asked
   * for confirmations. Every layer was individually correct — the clamp is the
   * whole point of having a tier — and the result was a lie on screen.
   */
  const modeNarrowedFrom: AgentMode | undefined =
    mode === requestedMode ? undefined : requestedMode;

  const effort = options.effort;
  const effortSpec = effort ? EFFORT[effort] : null;
  /** Whether this turn can start a sub-agent at all; the tools and their guidance are only offered when it can. */
  const canDelegate = (!effortSpec || effortSpec.allowDelegation) && (options.depth ?? 0) < MAX_SUBAGENT_DEPTH;

  const history: LLMMessage[] = options.history ? [...options.history] : [];
  let toolCallsExecuted = 0;
  /** Whether the agent saved anything to memory itself this turn: if not, a check after the turn may. */
  let rememberedThisTurn = false;
  let finalResponseText = "";
  /** No limit unless a caller asks for one. See the header. */
  const maxIterations = options.maxIterations ?? Number.POSITIVE_INFINITY;
  const maxHealAttempts = effortSpec?.maxHealAttempts ?? 2;
  const depth = options.depth ?? 0;
  let iteration = 0;
  const modifiedFiles: string[] = [];
  /** The model's own plan, as last written via `update_todo_list`. Used to
   *  tell "stopped early" from "finished" without reading the prose. */
  let todoItems: TodoItem[] = (options.plan ?? []).map((t) => ({ ...t }));
  let planNudges = 0;
  /** Empty responses the model has been told about this turn; see `EmptyResponseError`. */
  let emptyNudges = 0;
  /** Responses in a row that ran out of room while still thinking; see `MAX_THOUGHT_OUT`. */
  let thoughtOut = 0;
  /** The last step's words and calls, and how many times in a row it has been taken; see `STUCK_AT`. */
  let lastStepKey = "";
  let sameSteps = 0;
  /** Every step taken this turn, by words, calls and results, and how often; see `STUCK_TELL`. */
  const stepsTaken = new Map<string, number>();
  /** For each repeated step, the count the model was last told about, so one count is told once. */
  const toldRepeats = new Map<string, number>();
  /** Added to the tier's temperature while the model repeats itself; see `STUCK_AT`. */
  let repeatHeat = 0;
  /** The step after `STUCK_AT`: the model reports where things stand, and no call runs. */
  let closing = false;
  /** Responses dropped this turn for looping on one phrase; see `degenerate.ts`. */
  let degenerateRetries = 0;
  const repetition = new RepetitionWatch();
  const narration = new NarrationWatch();
  let healAttempts = 0;
  /** Audit writes that could not be persisted. Reported on the result so a
   *  caller is never left believing the trail is complete when it is not. */
  let auditFailures = 0;
  /**
   * Result records still being written. The *intent* record is awaited before
   * a call runs — that ordering is the audit trail's guarantee — but the
   * result is after the fact, and waiting on a database round trip between
   * every call and the next only slowed the turn. They are settled, and their
   * failures counted, before the turn returns.
   */
  const auditWrites: Promise<void>[] = [];
  let persistFailures = 0;
  const signal = options.signal;
  const cache = new ToolResultCache();
  /** Reads and commands repeated with the same result this turn, which their results then say. */
  const repeatNotes = new RepeatNotes();
  /** What this turn actually did, for a summary nobody has to take on trust. */
  const ledger = new TurnLedger();
  /**
   * Images produced by tool calls in the current batch, waiting to be shown.
   *
   * Collected during execution and flushed after the batch's tool results are
   * in history, because an image cannot ride inside a tool result — the wire
   * format makes a tool message a string — and inserting a user message
   * mid-batch would separate a call from its result.
   */
  let pendingImages: { callId: string; base64: string; mediaType: string; source: string }[] = [];
  /** The question the agent is waiting on, replayed to a page that arrives
   *  after it was asked. */
  let openQuestion: {
    questionId: string;
    question: string;
    why?: string;
    options?: string[];
    recommended?: number;
    recommendedBecause?: string;
    index?: number;
    total?: number;
  } | null =
    null;
  /**
   * What the person said during the step now in progress.
   *
   * There is one message queue and two things that read it: the interjection
   * channel, which delivers anything said mid-turn, and `ask_user`, which
   * waits for an answer. They race — and the interjection channel wins,
   * because it reads at the top of every step, before the model has even
   * produced the call that asks the question.
   *
   * The consequence was a hang: somebody types a moment before the agent
   * asks, their message is delivered as an ordinary interjection, and the
   * question then waits for ever for a second message nobody knows to send.
   *
   * So what was said this step is remembered. A question asked in the same
   * step is answered by it immediately, rather than by silence.
   */
  let saidThisStep: string[] = [];
  /**
   * The person's latest mid-turn message, until a step is taken after it.
   *
   * A message that lands while the summary is being written is delivered, and
   * the model then often finishes anyway, reporting the old request as done.
   * From the person's side the agent stopped and ignored them.
   */
  let unacted: { text: string; reminded: boolean } | null = null;
  const routing = options.routing ?? DEFAULT_POLICY;
  /** The cacheable prefix carried in from the last turn, updated as this one
   *  runs. See `prefix-cache.ts`. */
  let prefixSeal: PrefixSeal | null = options.prefixSeal ?? null;

  const emit = async (event: StreamEvent): Promise<void> => {
    if (onEvent) await onEvent(event);
  };

  /**
   * The specialists this turn delegated to.
   *
   * One pool per turn, not per process: a sub-agent belongs to the turn that
   * started it, and a turn that ends with one still running is a bug the loop
   * closes rather than a resource the next turn inherits.
   */
  const subagents = new SubagentPool(
    (agent) => {
      void emit({ type: "subagent_update", sessionId, agent });
    },
    subagentConcurrencyFor(effort),
  );

  /**
   * Hand a message the turn just added to whoever stores the conversation.
   *
   * Never throws: a database that is down loses a reload's fidelity, which is
   * counted and reported, and must not also lose the turn.
   */
  const persist = async (message: LLMMessage, meta: MessageMeta = {}): Promise<void> => {
    // Every note the loop adds is stored as a nudge; see `LLMMessage.fromLoop`.
    if (message.role === "user" && meta.kind === "nudge") message.fromLoop = true;
    if (!options.onMessage) return;
    try {
      const id = await options.onMessage(message, meta);
      if (typeof id === "string" && id) message.id = id;
    } catch {
      persistFailures++;
    }
  };

  /**
   * Deliver messages the person sent while the turn was running.
   *
   * Called only at step boundaries — after a batch's results are in history,
   * before the next request — which is the one place a new user message can
   * go without splitting a call from its result or cutting a response in half.
   * Several waiting messages become one, so the model reads them together.
   */
  const deliverInterjections = async (
    items: { id: string; text: string }[] = options.controls?.takeMessages?.() ?? [],
  ): Promise<boolean> => {
    if (items.length === 0) return false;
    const text = items.map((item) => item.text.trim()).filter(Boolean).join("\n\n");
    if (!text) return false;
    const content = interjectionContent(text);
    // Stored as text, like the turn's first message; the pictures attached to it go to the model.
    const stored: LLMMessage = { role: "user", content };
    await persist(stored, { kind: "interjection", text });
    const images = await attachedImages(
      items.map((item) => item.text),
      { runner: sandboxRunner, workspaceId, ...(options.model ? { model: options.model } : {}) },
    );
    const message: LLMMessage = images.length > 0 ? { ...stored, content: [{ type: "text", text: content }, ...images] } : stored;
    saidThisStep.push(text);
    unacted = { text, reminded: false };
    history.push(message);
    await emit({ type: "user_message", sessionId, text, queueIds: items.map((item) => item.id) });
    return true;
  };

  /*
   * The checkpoint, taken before anything else.
   *
   * Its success is not incidental: `auto` mode's entire confirmation rule is
   * "if a checkpoint can undo it, don't ask", so a failed snapshot changes how
   * the rest of this turn behaves. It is therefore established up front, not
   * lazily at the first write, and the reason for a failure is carried through
   * to the result so a user can be told why they are suddenly being asked.
   */
  let checkpoint: Checkpoint | undefined;
  let checkpointUnavailable: string | undefined;

  /*
   * Two independent pieces of I/O, run at the same time.
   *
   * The snapshot and the repository map both sit in front of the first model
   * call, neither depends on the other, and both are dominated by waiting.
   */
  const label =
    typeof userMessage === "string"
      ? userMessage
      : (userMessage.find((b) => b.type === "text")?.text ?? "turn");

  const [snap, repoMap] = await Promise.all([
    modeSpec.checkpoint && depth === 0
      ? createCheckpoint(sandboxRunner, workspaceId, label)
      : Promise.resolve(null),
    buildRepoMap(sandboxRunner, workspaceId),
  ]);

  if (snap) {
    if (snap.ok && snap.checkpoint) {
      checkpoint = snap.checkpoint;
    } else {
      checkpointUnavailable = snap.reason ?? "the workspace could not be snapshotted";
    }
  }

  const checkpointAvailable = checkpoint !== undefined;

  /*
   * The user's message, with any pictures they attached inside it.
   *
   * Not persisted here: whoever called the turn already stored it, before the
   * turn started, so a failed start still records it. The stored copy is the
   * text — the bytes stay in the workspace, where they already are.
   */
  history.push({
    role: "user",
    content:
      typeof userMessage === "string"
        ? await withInlineImages(userMessage, {
            runner: sandboxRunner,
            workspaceId,
            ...(options.model ? { model: options.model } : {}),
          })
        : userMessage,
  });

  /*
   * The context engine: durable task memory, the repository index, and the
   * per-step working set. Opened once per turn; its state outlives the turn
   * in the workspace. See `context/engine.ts`.
   */
  const engine = await ContextEngine.open({ runner: sandboxRunner, workspaceId, sessionId });
  engine.seedFrom(history.slice(0, -1));
  engine.observeUserMessage(label);

  /*
   * A long request, kept whole where no checkpoint can shorten it (15 Oct
   * 2026). The task state holds a request's opening 1,500 characters, and a
   * checkpoint drops the message itself, so the middle of a long spec could
   * be gone by the time the work reached it. Saved as a file, and named in
   * the task state, which the working set shows every step.
   */
  if (depth === 0 && label.length > LONG_REQUEST_CHARS) {
    const file = `.soreqen/artifacts/${sessionId.replace(/[^\w.-]/g, "_")}/request-${Date.now().toString(36)}.md`;
    try {
      await sandboxRunner.writeFile(workspaceId, file, label, true);
      engine.store.attachRequestFile(file, label.length);
    } catch {
      // The message itself is still in the conversation.
    }
  }

  /*
   * Skills, and tools from outside.
   *
   * The skill set is fixed for the turn — built-ins, the person's, the
   * project's, minus what is switched off — so the section it renders into the
   * system prompt is the same bytes on every step. External tools are
   * whatever the host connected; the tool list sent to the model is ours
   * followed by theirs, in a stable order for the same reason.
   */
  const skills = SkillSet.from(
    options.skills,
    options.skills?.projectSkills === false ? [] : await readProjectSkills(sandboxRunner, workspaceId),
  );
  const external = options.externalTools;
  const memory = options.memory;
  /*
   * Connector tools, offered by name until needed, when there are enough of
   * them to matter (see deferred-tools.ts). Decided once per turn, like the
   * system prompt that says so. Loaded: the ones this conversation has
   * already called or loaded, and any loaded during the turn.
   */
  const deferExternal = external ? shouldDefer(external.definitions()) : false;
  const loadedExternal = loadedIn(history);
  const offeredExternalDefinitions = (): ReturnType<ExternalTools["definitions"]> => {
    const all = external ? external.definitions() : [];
    if (!deferExternal) return all;
    return [
      ...(all.some((d) => isDeferrable(d.name)) ? [loadToolsDefinition(all)] : []),
      ...all.filter((d) => !isDeferrable(d.name) || loadedExternal.has(d.name)),
    ];
  };
  const buildTools = () => [
    /*
     * The two symbol tools are code_graph's 'symbol' action under other names.
     * With three ways to ask one question the models took none of them and
     * grepped; one tool is the one they learn. A call to the old names still
     * works (the dispatcher answers it from the graph).
     */
    ...SOREQEN_TOOL_DEFINITIONS.filter(
      (t) =>
        t.name !== "find_symbol_definition" &&
        t.name !== "find_symbol_references" &&
        // Offered only where a sub-agent can be started; see `canDelegate`.
        (canDelegate || (t.name !== "spawn_subagent" && t.name !== "subagent_status")) &&
        // Only where the host can start the session again, and never for a sub-agent.
        (t.name !== "schedule_wakeup" || (Boolean(options.onScheduleWakeup) && depth === 0)),
    ),
    ...(memory ? (MEMORY_TOOL_DEFINITIONS as unknown as typeof SOREQEN_TOOL_DEFINITIONS) : []),
    ...offeredExternalDefinitions(),
  ];
  let toolDefinitions = buildTools();
  /** The app tools the model is offered, by name; see the refresh at the top of each step. */
  const externalNames = (): string => (external ? external.definitions().map((d) => d.name).join("\u0000") : "");
  let offeredExternal = externalNames();
  /**
   * Every MCP call is audited, read-only or not: whether a tool only reads is
   * partly the server's own claim, and the trail is where a false one shows.
   */
  const externalWrite = (name: string): boolean => external?.describe(name) !== undefined;

  /*
   * A plan the last turn left open, back on screen and back in force.
   *
   * Stopping a turn and saying "continue" used to start the next one with no
   * plan at all: the list vanished from the page, and the rule that a turn
   * does not end with items still open silently stopped applying. It is
   * carried over only while something on it is unfinished — a finished plan
   * is never shown again.
   */
  if (todoItems.some((t) => t.status === "pending" || t.status === "in_progress")) {
    engine.observePlan(todoItems, { carried: true });
    await emit({ type: "todo_update", sessionId, items: todoItems });
  } else {
    todoItems = [];
  }

  /** Rough tokens sent across the whole turn. An estimate, for the budget
   *  guard only — never for billing, which uses provider-reported usage. */
  let estimatedTokensUsed = 0;
  /** What the provider reported: input, and the part served from its prompt cache — this turn, and the last request. */
  const providerCache = { requests: 0, inputTokens: 0, cachedTokens: 0, last: null as { inputTokens: number; cachedTokens: number } | null };
  /** Rough tokens the model wrote across the turn: what a person sees as output. */
  let outputTokens = 0;
  /** The estimate of the request last sent, to set beside the provider's count of it. */
  let lastRequestTokens = 0;
  /** Whose tokenizer the meter is calibrated to. */
  const meterModel = options.model ?? llmProvider.name;
  /** What each running sub-agent has written so far; folded into `outputTokens` when it finishes. */
  /*
   * Sub-agents' approvals, in turn: one question in front of the person at a
   * time, each naming the agent that asks. The chain only orders the asking;
   * an answer goes straight back to the agent that is waiting for it.
   */
  let approvalQueue: Promise<unknown> = Promise.resolve();
  const approvalFor =
    (agentId: string, role: string) =>
    (conf: Parameters<NonNullable<typeof onAwaitConfirmation>>[0]): Promise<boolean> => {
      const label = role.charAt(0).toUpperCase() + role.slice(1).replace(/_/g, " ");
      const asked = approvalQueue.then(async () => {
        if (signal?.aborted || !onAwaitConfirmation) return false;
        const confirmationId = `conf_${agentId}_${conf.confirmationId.replace(/^conf_/, "")}`;
        const description = `${label} (a sub-agent) asks: ${conf.description}`;
        await emit({
          type: "confirmation_required",
          sessionId,
          confirmationId,
          action: conf.action,
          description,
          payload: { ...conf.toolCall.input },
          agent: { id: agentId, label },
        });
        return onAwaitConfirmation({ ...conf, confirmationId, description });
      });
      approvalQueue = asked.catch(() => undefined);
      return asked;
    };
  const subagentOutput = new Map<string, number>();
  const outputWithSubagents = (): number => {
    let total = outputTokens;
    for (const n of subagentOutput.values()) total += n;
    return total;
  };
  /** The session a person is watching; a sub-agent reports into its parent's. */
  const rootSessionId = options.rootSessionId ?? sessionId;

  /**
   * An MCP server asking the model to write something (sampling), while one
   * of its tools runs for this turn.
   *
   * The server writes the prompt, so this is a request from outside that
   * spends the person's model: it is asked about every time — bypass mode
   * excepted, which asks about nothing — and refused where nobody can be
   * asked. The model answers with no tools and none of the conversation, so
   * whatever the server's prompt says, the answer is only text handed back.
   */
  let samples = 0;
  const sampleForServer = async (request: SampleRequest, callId?: string): Promise<SampleResult> => {
    const maxTokens = Math.max(1, Math.min(request.maxTokens || 1024, MAX_SAMPLE_TOKENS));
    if (mode !== "bypass") {
      if (!onAwaitConfirmation) throw new Error("This session cannot ask the person, so the server's request was refused.");
      const confirmationId = `conf_sample_${callId ?? "x"}_${++samples}`;
      const asked = request.messages.map((m) => m.text).join("\n").replace(/\s+/g, " ").slice(0, 300);
      const description = `MCP server "${request.server}" asks the model to write up to ${maxTokens} tokens for it. It asked: "${asked}"`;
      await emit({ type: "confirmation_required", sessionId, confirmationId, action: "mcp_sampling", description });
      const approved = await onAwaitConfirmation({
        confirmationId,
        toolCall: { id: confirmationId, name: "mcp_sampling", input: { server: request.server } },
        action: "mcp_sampling",
        description,
      });
      throwIfCancelled(signal);
      if (!approved) throw new Error("The person declined the server's request to use the model.");
    }
    let text = "";
    let stopReason: SampleResult["stopReason"] = "endTurn";
    for await (const chunk of llmProvider.chatStream({
      ...(options.model ? { model: options.model } : {}),
      system:
        request.systemPrompt?.slice(0, 8_000) ??
        "You are answering a request from a tool (an MCP server) on behalf of a developer. Answer only what is asked.",
      messages: request.messages.map((m) => ({ role: m.role, content: m.text })),
      maxTokens,
      ...(signal ? { signal } : {}),
    })) {
      if (chunk.type === "token") text += chunk.text;
      else if (chunk.type === "stop" && chunk.reason === "max_tokens") stopReason = "maxTokens";
    }
    outputTokens += Math.ceil(text.length / 4);
    return { text, model: options.model ?? llmProvider.name, stopReason };
  };

  const toolCtx: ToolExecutionContext = {
    workspaceId,
    permissionTier,
    onTaskState: (input) => engine.updateTaskState(input as Parameters<ContextEngine["updateTaskState"]>[0]),
    ...(memory ? { onMemory: (tool: string, input: Record<string, unknown>) => runMemoryTool(memory, tool, input) } : {}),
    onRetrieveContext: (input) => engine.retrieveContext(input as Parameters<ContextEngine["retrieveContext"]>[0]),
    onCodeGraph: (input) => engine.codeGraph(input as Parameters<ContextEngine["codeGraph"]>[0]),
    /*
     * research: one round of reading at quick and standard depth; at deep, a
     * planned, multi-round search with a cited report written by this
     * session's model (research-agent.ts). Progress shows on the tool's card.
     */
    onResearch: (input, callId) => {
      const onProgress = (message: string): void =>
        void emit({ type: "tool_progress", sessionId, callId: callId ?? "", tool: "research", message }).catch(() => undefined);
      if (input["depth"] !== "deep" && input["depth"] !== "max") return runResearch(input, signal, onProgress);
      const queries = Array.isArray(input["queries"]) ? input["queries"].filter((q): q is string => typeof q === "string") : undefined;
      return deepResearch({
        question: typeof input["question"] === "string" ? input["question"] : "",
        ...(queries ? { queries } : {}),
        provider: llmProvider,
        ...(options.model ? { model: options.model } : {}),
        ...(signal ? { signal } : {}),
        intensity: input["depth"] === "max" ? "max" : "deep",
        onProgress,
      });
    },
    ...(options.onScheduleWakeup && depth === 0 ? { onScheduleWakeup: options.onScheduleWakeup } : {}),
    onUseSkill: async (name, file, copy) => {
      // A skill written since the turn began (installed a step ago, say) is read in now.
      if (!skills.get(name)) await skills.refresh({ runner: sandboxRunner, workspaceId }).catch(() => []);
      const known = skills.get(name);
      if (known && !file) skillsInView.add(known.name);
      /*
       * A skill's file into the project, byte for byte (13 Nov 2026). A
       * 40 KB engine read back and retyped cost twenty thousand tokens and
       * came out with mistakes, or cut short at the read limit. Its
       * permission was decided with the call, as a write_file to `copy.to`.
       */
      if (file && copy) {
        const raw = await skills.readFile(name, file, { runner: sandboxRunner, workspaceId }, true);
        if (!raw.ok) return { success: false, error: raw.error };
        if (!copy.overwrite) {
          const exists = await sandboxRunner.readFile(workspaceId, copy.to, 1, 1).then(
            () => true,
            () => false,
          );
          if (exists) return { success: false, error: `${copy.to} already exists. Copy to another path, or pass overwrite: true to replace it.` };
        }
        const written = await sandboxRunner.writeFile(workspaceId, copy.to, raw.text, true);
        const kb = (Buffer.byteLength(raw.text) / 1024).toFixed(1);
        return {
          success: true,
          data: `Copied ${file} (${kb} KB) from ${known?.name ?? name} to ${written.path}. It is in the project now: change it there with edit_file, and do not read it back whole.`,
        };
      }
      const loaded = file ? await skills.readFile(name, file, { runner: sandboxRunner, workspaceId }) : skills.load(name);
      return loaded.ok ? { success: true, data: loaded.text } : { success: false, error: loaded.error };
    },
    onExternalTool: (name, input, callId) =>
      external?.describe(name)
        ? external.call(name, input, {
            ...(signal ? { signal } : {}),
            onProgress: (p) =>
              void emit({ type: "tool_progress", sessionId, callId: callId ?? "", tool: name, ...p }).catch(() => undefined),
            sample: (request) => sampleForServer(request, callId),
            interrupted: () => (options.controls?.pendingMessages?.() ?? 0) > 0,
          })
        : null,
    sandboxRunner,
    sessionId: rootSessionId,
    pendingMessages: () => options.controls?.pendingMessages?.() ?? 0,
    urgentMessages: () => options.controls?.urgentMessages?.() ?? 0,
    newsWaiting: () =>
      subagents.hasUnread()
        ? "A sub-agent you delegated to finished"
        : (options.controls?.noticesWaiting?.() ?? 0) > 0
          ? "A background command ended"
          : null,
    /*
     * Cancellation, all the way down.
     *
     * `throwIfCancelled` only ever fired between tool calls, so pressing
     * Ctrl-C during a two-minute test run stopped the loop and left the tests
     * running. The runner kills the process group on abort; the fetch-based
     * tools abort their request.
     */
    signal,
    /*
     * The declarations the repo map already parsed.
     *
     * Null when nothing was indexed, which happens on a repo-map cache hit
     * because that path skips the parse. The tools read null as "not looked"
     * rather than "not there" and fall back to searching.
     */
    lookupSymbol: (name: string) =>
      repoMap.symbols.filesIndexed === 0 ? null : lookupSymbol(repoMap.symbols, name),
    /*
     * A question, asked properly.
     *
     * Prose in a response does not pause anything: the loop reads the absence
     * of tool calls as "finished", so an agent that ended a message with a
     * question had asked nobody and stopped. This is the channel that actually
     * waits — and it waits on the ordinary mid-turn message queue, so the
     * answer arrives as a user message in the transcript rather than as a
     * side-channel value nothing records.
     */
    /*
     * Only where there is a queue to answer through.
     *
     * An unattended run — an eval, a scheduled job, a sub-agent — has no
     * message channel, so a question there would wait for ever on an answer
     * that cannot arrive. Leaving the callback off is what makes the tool
     * report "there is nobody to ask", which the agent can state an
     * assumption about and work around.
     */
    onAskUser: !options.controls?.takeMessages
      ? undefined
      : async ({ question, why, options: choices, recommended, recommendedBecause, index, total, previous }) => {
      /*
       * Already answered, before it was asked.
       *
       * Whatever the person said during this step was delivered to the model
       * as an interjection and is already in the history above this call. It
       * is also, in practice, the answer — nobody types at an agent that is
       * about to ask them something by coincidence. Returning it here beats
       * waiting for a second message that will never come.
       */
      // Only for the first of a batch: the later ones are asked after it, so nothing said before them is news.
      // Not when asked again after going back: that is the person changing an answer, not news.
      if (saidThisStep.length > 0 && !index && previous === undefined) {
        return (
          `You have already been told, in the message above: "${saidThisStep.join(" ")}". ` +
          "Use that as the answer, and only ask again if it genuinely does not address the question."
        );
      }

      const questionId = `q_${sessionId}_${Date.now().toString(36)}`;
      openQuestion = {
        questionId,
        question,
        ...(why ? { why } : {}),
        ...(choices && choices.length > 0 ? { options: choices } : {}),
        ...(recommended !== undefined ? { recommended } : {}),
        ...(recommendedBecause ? { recommendedBecause } : {}),
        ...(total !== undefined && total > 1 ? { index: index ?? 0, total } : {}),
        ...(previous !== undefined ? { previous } : {}),
      };
      await emit({ type: "question", sessionId, ...openQuestion });

      try {
        for (;;) {
          throwIfCancelled(signal);
          const waiting = options.controls?.takeMessages?.() ?? [];
          const answer = waiting
            .map((m) => m.text.trim())
            .filter(Boolean)
            .join("\n\n");
          // Back to the question before: the batch asks it again. Nothing the person said.
          if (answer === ASK_USER_BACK || waiting.some((m) => m.text.trim() === ASK_USER_BACK)) {
            await emit({ type: "question_answered", sessionId, questionId });
            return ASK_USER_BACK;
          }
          if (answer) {
            await emit({ type: "question_answered", sessionId, questionId, answer });
            /*
             * Recorded as an ordinary user message, not swallowed into the
             * tool result. The tool result tells the model what was said; this
             * is what makes the answer survive a reload, a compaction and the
             * next turn's history.
             */
            await persist({ role: "user", content: answer }, { kind: "answer", text: answer });
            await emit({
              type: "user_message",
              sessionId,
              text: answer,
              queueIds: waiting.map((m) => m.id),
              answers: questionId,
            });
            return answer;
          }
          await delay(MESSAGE_POLL_MS, signal);
        }
          } finally {
            openQuestion = null;
          }
        },

    onSubagentStatus: async ({ agent_id, wait_for_all }) => {
      if (wait_for_all && subagents.anyRunning()) {
        const urgent = whenUrgent(() => options.controls?.urgentMessages?.() ?? 0, signal);
        await Promise.race([subagents.waitForAll(), urgent.promise]);
        urgent.cancel();
      }

      if (agent_id) {
        const one = subagents.get(agent_id);
        if (!one) {
          return {
            success: false,
            data: { agents: [] },
            error: `No sub-agent with id ${agent_id} was started by this turn.`,
          };
        }
        subagents.collect();
        return { success: true, data: { agents: [one] } };
      }

      const all = subagents.list();
      // Reading the roster counts as being told: a result reported here must
      // not be delivered a second time by the finishing gate below.
      subagents.collect();
      return {
        success: true,
        data: { running: all.filter((a) => a.status === "running").length, agents: all },
      };
    },

    onSpawnSubagent: async ({ role: rawRole, taskPrompt, workspaceId: wsId, contextFiles, doneWhen, known, outOfScope, wait }) => {
      if (effortSpec && !effortSpec.allowDelegation) {
        return {
          success: false,
          data: { delegated: false },
          error:
            `Delegation is only available at Max and Apex effort; this turn runs at ` +
            `'${effort ?? "default"}'. Do this part of the work yourself.`,
        };
      }
      if (depth >= MAX_SUBAGENT_DEPTH) {
        return {
          success: false,
          data: { delegated: false },
          error:
            `Delegation refused: already ${depth} level(s) deep, and the limit is ` +
            `${MAX_SUBAGENT_DEPTH}. Do this part of the work yourself.`,
        };
      }

      const role = resolveRole(rawRole);
      const brief = buildBrief(role, taskPrompt, contextFiles, {
        ...(doneWhen ? { doneWhen } : {}),
        ...(known ? { known } : {}),
        ...(outOfScope ? { outOfScope } : {}),
        session: briefSessionFrom(engine.store.state),
      });
      const started = subagents.spawn({
        role,
        task: taskPrompt,
        brief,
        run: async (report: SubagentReporter) => {
          const subResult = await runAgentTurn({
            workspaceId: wsId,
            // Derived from the agent's id, so everything it owns — its browser,
            // its scratch files — can be found and released with the parent.
            sessionId: `${sessionId}_sub_${report.id}`,
            /*
             * The parent's own mode: never looser, and no tighter either.
             *
             * It used to be clamped to auto under a bypass parent. Auto asks
             * before an irreversible command, a sub-agent has nobody to ask,
             * so every such command was refused — specialists in a session
             * the person had set to "don't ask me" stopped short with "needs
             * confirmation" (seen 1 Oct 2026). Bypass is what the person
             * chose for this work, specialists included.
             */
            mode,
            permissionTier,
            effort,
            userMessage: brief,
            history: [],
            // The same skills, and the same connected servers. An MCP call that
            // needs approval is asked about like any other (see below).
            ...(options.skills ? { skills: options.skills } : {}),
            ...(options.externalTools ? { externalTools: options.externalTools } : {}),
            sandboxRunner,
            llmProvider,
            model: options.model,
            maxOutputTokens: options.maxOutputTokens,
            depth: depth + 1,
            rootSessionId,
            signal,
            /*
             * Its approvals come to the person, named, one at a time.
             *
             * A sub-agent runs in the parent's mode, so a command that mode
             * asks about is asked about here too: "Researcher (a sub-agent)
             * wants to run …", with the literal command, Allow or Deny. It
             * used to have no way to ask, so such a command was refused and
             * the work stopped short. Several specialists may want approval
             * at once; they queue, so the person answers one clear question
             * at a time and always knows which agent is asking.
             */
            ...(onAwaitConfirmation ? { onAwaitConfirmation: approvalFor(report.id, role) } : {}),
            /*
             * A sub-agent's own events go out wrapped, not merged.
             *
             * Merged into the parent's stream they would interleave several
             * agents' calls into one transcript with no way to tell them apart
             * — which is what made delegation unreadable before. Wrapped and
             * tagged, a surface can keep one transcript per agent and show it
             * to someone who asks to watch that agent, while the parent's
             * conversation stays the parent's.
             *
             * Its questions and approvals are not forwarded as anything a
             * person can answer: see `onAwaitConfirmation` above.
             */
            onEvent: (event) => {
              if (event.type === "tool_call") {
                report.step();
                report.activity(event.tool);
              }
              // Its count, and its own sub-agents' through it, reach the session's number as they grow.
              if ((event.type === "step_start" || event.type === "output_usage") && typeof event.outputTokens === "number") {
                subagentOutput.set(report.id, event.outputTokens);
                void emit({ type: "output_usage", sessionId, outputTokens: outputWithSubagents() });
              }
              void emit({
                type: "subagent_event",
                sessionId,
                agentId: report.id,
                event: event as unknown as Record<string, unknown>,
              });
            },
            // A sub-agent's spend counts against the parent's remaining budget,
            // not a fresh one — otherwise delegation is an unlimited-money button.
            maxTurnTokens: options.maxTurnTokens
              ? Math.max(0, options.maxTurnTokens - estimatedTokensUsed)
              : undefined,
          });

          estimatedTokensUsed += subResult.estimatedTokensUsed;
          subagentOutput.delete(report.id);
          outputTokens += subResult.outputTokens;
          /*
           * A sub-agent's edits are this turn's edits.
           *
           * Verification runs against `modifiedFiles`, so a file changed by a
           * specialist and not recorded here is a file that is never
           * typechecked, never covered by the affected tests, and missing from
           * the checkpoint's change list.
           */
          for (const file of subResult.modifiedFiles) {
            if (!modifiedFiles.includes(file)) modifiedFiles.push(file);
          }

          return { finalResponse: subResult.finalResponse, filesModified: subResult.modifiedFiles };
        },
      });

      if (!started.ok) {
        return { success: false, data: { delegated: false }, error: started.reason };
      }

      if (!wait) {
        return {
          success: true,
          data: {
            delegated: true,
            agent_id: started.agent.id,
            role,
            status: "running",
            message:
              `Sub-agent ${started.agent.id} (${role}) is running beside you. Carry straight on ` +
              "with work that does not depend on it. Its report is handed to you when it finishes; there is no need to check on it.",
          },
        };
      }

      // Waited on until it finishes, or until the person sends a message now; see `whenUrgent`.
      const urgent = whenUrgent(() => options.controls?.urgentMessages?.() ?? 0, signal);
      const outcome = await Promise.race([subagents.waitForAll().then(() => "done" as const), urgent.promise]);
      urgent.cancel();
      if (outcome === "urgent") {
        return {
          success: true,
          data: {
            delegated: true,
            agent_id: started.agent.id,
            role,
            status: "running",
            message:
              `Sub-agent ${started.agent.id} (${role}) is still running: it was no longer waited on because the ` +
              "person sent a message that could not wait, and it is below. Read it first; the " +
              "sub-agent's report is handed to you when it finishes.",
          },
        };
      }
      const finished = subagents.get(started.agent.id);
      subagents.collect();
      return {
        success: finished?.status === "completed",
        data: {
          delegated: true,
          agent_id: started.agent.id,
          role,
          status: finished?.status ?? "failed",
          finalResponse: finished?.result ?? "",
          filesModified: finished?.filesModified ?? [],
        },
        ...(finished?.error ? { error: finished.error } : {}),
      };
    },
  };

  /*
   * Built once, not once per iteration.
   *
   * It reads the sandbox — hierarchical memory and a repo map — and every
   * provider's prompt cache keys on an exact prefix match, so a system prompt
   * rebuilt each pass is both slower and a guaranteed cache miss.
   */
  /*
   * A place for the agent's own files, outside the project's.
   *
   * Scripts it writes to test a theory, logs it captures and data it generates
   * used to land in the project root, where they were mistaken for deliverables,
   * swept into commits and left behind. Under `.soreqen/`, which checkpoints,
   * searches and the repository map already ignore. Created up front so a
   * command can use it as its working directory straight away.
   */
  const scratchpadDir = scratchpadDirFor(rootSessionId);
  try {
    await sandboxRunner.writeFile(
      workspaceId,
      `${scratchpadDir}/README.md`,
      "Files SoreQen created for its own use in this session. Safe to delete.\n",
      false,
    );
  } catch {
    // Already there, or the workspace is read-only; the prompt still names it.
  }

  const basePrompt = await buildSystemPrompt(
    {
      workspaceId,
      sessionId,
      permissionTier,
      mode,
      effort,
      outputStyle: options.outputStyle,
      checkpointAvailable,
      repoMap,
      // Where it really is: the agent runs scripts from it in shell commands.
      scratchpadDir: commandPath(sandboxRunner, workspaceId, scratchpadDir),
      soreqenDir: sandboxRunner.dataPathOf?.(workspaceId) ?? undefined,
      skillsPrompt: [skills.renderForPrompt(), external?.promptSection?.({ deferred: deferExternal }) ?? ""].filter(Boolean).join("\n\n"),
      canDelegate,
    },
    sandboxRunner,
  );
  /*
   * What SoreQen remembers, as of the start of this turn: read once, so a
   * memory saved midway shows from the next turn and the system prompt — the
   * cached prefix — stays the same for every step of this one.
   */
  let memorySection = "";
  if (memory) {
    try {
      /*
       * Matched against what the conversation is about, not only this
       * message: a memory is shown whole when the request concerns it (see
       * `inFull` in memory.ts), and "continue" concerns what came before.
       */
      const asked = [
        ...history
          .slice(0, -1)
          .filter((m) => m.role === "user" && !m.fromLoop && typeof m.content === "string")
          .slice(-2)
          .map((m) => (m.content as string).slice(0, 2_000)),
        label,
      ].join("\n");
      memorySection = memoryPromptSection(memory.snapshot(asked), memory.scopes());
    } catch {
      // An unreadable memory folder costs the turn its memory, never the turn.
    }
  }
  const personal = personalSection(options.personal);
  const systemPrompt = [basePrompt, personal, memorySection].filter(Boolean).join("\n\n");

  /*
   * The skills this request clearly calls for, loaded before the first step.
   *
   * Delivered inside the request itself — appended to this turn's user
   * message, marked as SoreQen's and not the person's words — and never as an
   * assistant tool call the model did not make. A synthetic assistant message
   * carries no reasoning, and providers that replay reasoning refuse history
   * shaped like that: DeepSeek's thinking mode wants `reasoning_content` on
   * every assistant tool call, Anthropic's extended thinking a thinking block
   * before a tool use. The first turn got away with it; every later one failed.
   *
   * The transcript still shows a "Skill" row for each: display-only records,
   * like the verification step's, stored and never sent back. Appending to the
   * newest message changes nothing already sent, so the cache is unaffected.
   * A skill already in the conversation — loaded by the agent, or for an
   * earlier message still in view — is not loaded twice.
   */
  /** Background processes the agent has seen end this turn, so a notice of their end is not repeated. */
  const seenEnded = new Set<string>();
  /** Skills whose text the model has in this turn: loaded for the request, by itself, or reached by its work. */
  const skillsInView = new Set<string>();
  /** Loaded because the work reached them (see `SkillSet.reachedBy`), this turn. */
  let skillsReached = 0;
  if (options.skills?.autoActivate !== false) {
    const loadedBefore = skillsInView;
    const marker = /<skill name="([a-z0-9-]+)">/g;
    for (const message of history) {
      for (const call of message.toolCalls ?? []) {
        if (call.name === "use_skill") loadedBefore.add(String(call.input["name"] ?? ""));
      }
      const texts =
        typeof message.content === "string"
          ? [message.content]
          : message.content.flatMap((b) => (b.type === "text" ? [b.text] : []));
      for (const text of texts) for (const m of text.matchAll(marker)) loadedBefore.add(m[1]!);
    }
    // The person's last two messages before this one, and what the agent wrote lately: see `SkillContext`.
    const earlier = history
      .slice(0, -1)
      .filter((m) => m.role === "user" && !m.fromLoop)
      .map((m) => (typeof m.content === "string" ? m.content : m.content.map((b) => (b.type === "text" ? b.text : "")).join(" ")))
      .filter((t) => t.trim() && !t.startsWith("Image from"))
      .slice(-2)
      .join("\n");
    const recentPaths = history
      .slice(-80)
      .flatMap((m) => m.toolCalls ?? [])
      .filter((c) => c.name === "write_file" || c.name === "edit_file")
      .map((c) => String(c.input["path"] ?? ""))
      .filter(Boolean);
    const picks = skills.match(label, undefined, { earlier, paths: recentPaths }).filter((m) => !loadedBefore.has(m.name));
    for (const pick of picks) skillsInView.add(pick.name);
    const request = history[history.length - 1];
    if (picks.length > 0 && request?.role === "user") {
      const stamp = Date.now().toString(36);
      const loaded = picks.map((pick) => ({ pick, result: skills.load(pick.name) }));
      const block = [
        '<soreqen-skills note="Loaded by SoreQen for this request because it matched them. These are your instructions for the work they cover, not something the user wrote.">',
        ...loaded.filter((l) => l.result.ok).map((l) => `<skill name="${l.pick.name}">\n${l.result.ok ? l.result.text : ""}\n</skill>`),
        "</soreqen-skills>",
      ].join("\n");
      request.content =
        typeof request.content === "string"
          ? `${request.content}\n\n${block}`
          : [...request.content, { type: "text", text: block }];

      const calls: LLMToolCall[] = loaded.map((l, i) => ({ id: `skill_${stamp}_${i}`, name: "use_skill", input: { name: l.pick.name } }));
      await persist({ role: "assistant", content: "", toolCalls: calls }, { kind: "response", displayOnly: true });
      for (const [i, call] of calls.entries()) {
        const { pick, result } = loaded[i]!;
        const content = result.ok ? result.text : result.error;
        await emit({ type: "tool_call", sessionId, callId: call.id, tool: "use_skill", input: { name: pick.name, matched: pick.because } });
        await emit({ type: "tool_result", sessionId, callId: call.id, tool: "use_skill", output: content, success: result.ok });
        await persist(
          { role: "tool", toolCallId: call.id, content },
          { kind: "tool_result", toolName: "use_skill", success: result.ok, displayOnly: true },
        );
      }
    }
  }

  /*
   * The code graph, before the first step in an existing codebase.
   *
   * The models navigate by read_file and grep_search out of habit: across
   * every stored session, 1,172 reads, 600 searches and not one code_graph
   * call. So SoreQen takes the first look itself: the codebase's map (its
   * directories, the files everything depends on, the entry points) goes in
   * with the request, the same way an auto-loaded skill does, and shows as a
   * Code graph row. Once per conversation while it is in view; nothing for a
   * folder that is empty or nearly so, where there is nothing to map yet.
   */
  {
    const request = history[history.length - 1];
    const mapped = history.some(
      (m) =>
        m.toolCalls?.some((c) => c.name === "code_graph") ||
        (typeof m.content === "string" ? m.content : m.content.map((b) => (b.type === "text" ? b.text : "")).join("")).includes(
          "<soreqen-code-graph",
        ),
    );
    if (request?.role === "user" && !mapped) {
      const overview = await engine.startOverview().catch(() => null);
      if (overview) {
        const block =
          '<soreqen-code-graph note="The codebase map, from code_graph overview, run by SoreQen at the start of this work. ' +
          'Use code_graph file / symbol / impact to go deeper before reading or changing code.">\n' +
          `${overview}\n</soreqen-code-graph>`;
        request.content =
          typeof request.content === "string" ? `${request.content}\n\n${block}` : [...request.content, { type: "text", text: block }];
        const call: LLMToolCall = { id: `graph_${Date.now().toString(36)}`, name: "code_graph", input: { action: "overview" } };
        await persist({ role: "assistant", content: "", toolCalls: [call] }, { kind: "response", displayOnly: true });
        await emit({ type: "tool_call", sessionId, callId: call.id, tool: "code_graph", input: call.input });
        await emit({ type: "tool_result", sessionId, callId: call.id, tool: "code_graph", output: overview, success: true });
        await persist(
          { role: "tool", toolCallId: call.id, content: overview },
          { kind: "tool_result", toolName: "code_graph", success: true, displayOnly: true },
        );
      }
    }
  }

  const systemTokens = estimateTokens(systemPrompt);
  let toolTokens = estimateTokens(JSON.stringify(toolDefinitions));
  const windowTokens = options.contextWindow ?? contextWindowFor(options.model);

  /**
   * `load_tools`: the connector tools named join the tool list from the next
   * request, and a server loaded for the first time sends its own instructions
   * with them (kept out of the system prompt while its tools were deferred).
   */
  const loadExternalTools = (input: Record<string, unknown>): ToolResult => {
    const all = external ? external.definitions() : [];
    const { found, unknown } = resolveToolNames(input["names"], all);
    if (found.length === 0) {
      return {
        success: false,
        error: `No connected app has a tool called ${unknown.map((n) => `'${n}'`).join(", ") || "that"}. load_tools lists them by server.`,
      };
    }
    const servers = new Set(found.map((n) => splitToolName(n).server));
    const newServers = [...servers].filter((s) => ![...loadedExternal].some((n) => splitToolName(n).server === s));
    for (const name of found) loadedExternal.add(name);
    toolDefinitions = buildTools();
    toolTokens = estimateTokens(JSON.stringify(toolDefinitions));
    const instructions = newServers.map((s) => external?.instructions?.(s)).filter((t): t is string => Boolean(t));
    return {
      success: true,
      data: {
        loaded: found,
        ...(unknown.length > 0 ? { not_found: unknown } : {}),
        note: "These are in your tool list from your next step: call them by these names.",
        ...(instructions.length > 0 ? { server_instructions: instructions.join("\n\n") } : {}),
      },
    };
  };

  /** Shrinks when a provider says the conversation is too long for it, so the
   *  estimate learns the model's real limit instead of failing again. */
  let historyBudget = historyBudgetFor({
    model: options.model,
    systemPromptTokens: systemTokens,
    toolSchemaTokens: toolTokens,
    maxOutputTokens: options.maxOutputTokens,
  });

  let stopReasonForTurn: AgentTurnResult["stopReason"] = "completed";
  let review: ReviewVerdict | undefined;
  let reviewed = false;
  let testedAfterChanges = false;
  /** The turn record has been put in front of the model once. */
  let ledgerDelivered = false;
  /**
   * The closing summary the model wrote before it saw the turn record, while
   * it checks that summary against the record.
   *
   * The check used to ask for the summary to be written again, so every turn
   * that changed a file ended with two summaries, one after the other
   * (reported 27 Sep 2026). Now the model answers VERIFIED or with a
   * correction, the checking pass is not streamed, and the draft is the
   * summary — stored once, when the check is done. Anything that ends the
   * turn another way stores the draft first (`flushDraft`), so it is never lost.
   */
  let draft: { message: LLMMessage; meta: MessageMeta; facts: LLMMessage } | null = null;
  /** Drafts stored on their own (`flushDraft`), for `TurnResult.replies`. */
  const storedDrafts: string[] = [];
  /** Steps in a row that only kept records. See BOOKKEEPING_NUDGE. */
  let bookkeepingSteps = 0;
  /** Steps since the plan was last written, and reminders about it so far; see `PLAN_REMINDER_STEPS`. */
  let stepsSincePlan = 0;
  let planReminders = 0;
  const flushDraft = async (): Promise<void> => {
    if (!draft) return;
    const pending = draft;
    draft = null;
    storedDrafts.push(String(pending.message.content ?? ""));
    await persist(pending.message, { kind: "response", ...pending.meta });
  };
  /**
   * Writes performed, and the count as of the last verification that passed.
   *
   * Verification runs when the model believes it is finished, and "finished"
   * can now be reached more than once in a turn — a late message, a sub-agent
   * result, or the turn record each send it back for another pass. Without
   * this, every one of those re-ran the project's typecheck against a tree
   * that had not changed since the last time it passed.
   */
  let writeCount = 0;
  let writesAtLastVerify = -1;
  /** Iteration before which another summary is not attempted, after one could
   *  not be written. */
  let summaryRetryAt = 0;
  /** Consecutive identical call-and-result, for the repeat note. */
  let lastCallKey = "";
  let lastCallContent = "";
  let repeatCount = 0;

  /*
   * Cancellation unwinds through here as a value, not an exception.
   *
   * `throwIfCancelled` is used at the spend points because it keeps the call
   * sites to one line, but a cancelled turn is a *correct* outcome — the user
   * asked for it — so it must not surface to the caller as a thrown error
   * indistinguishable from a crash. Everything done so far is kept.
   */
  try {
  while (iteration < maxIterations) {
    iteration++;
    // Checked before anything is spent: the top of the loop is the cheapest
    // place to notice that nobody is waiting for the answer any more.
    throwIfCancelled(signal);

    /*
     * Summarise before trimming, when the conversation is getting full.
     *
     * Trimming keeps a request valid; a summary keeps the agent competent. The
     * older part of the session becomes a written account of the goal, what
     * was done, what was decided and what remains, and the recent exchanges
     * stay word for word. Stored like any other message, so a reload — and the
     * next turn — starts from the summary instead of the whole session.
     */
    /*
     * A new step, so nothing has been said during it yet. Cleared *before*
     * the delivery below, so a message delivered at this boundary counts as
     * said during the step it is about to be read in.
     */
    saidThisStep = [];
    await deliverInterjections();

    /*
     * A background command ended: a training run crashed, a build finished.
     * Told here, at the start of the step after it happened, so the agent
     * does not find out only when it next thinks to look (13 Oct 2026). One
     * whose end the agent has already seen (it waited for it, or checked on
     * it) is not told twice.
     */
    {
      const notices = (options.controls?.takeNotices?.() ?? []).filter((n) => !seenEnded.has(n.processId));
      if (notices.length > 0) {
        for (const n of notices) seenEnded.add(n.processId);
        const note: LLMMessage = {
          role: "user",
          content: `${notices.map((n) => n.text).join("\n\n")}\n\nSoreQen sent this, not the user. Take it into account in what you do next.`,
          fromLoop: true,
        };
        history.push(note);
        await persist(note, { kind: "nudge", displayOnly: false });
      }
    }

    /*
     * A sub-agent finished: its report, at the start of the step after it
     * did. The lead agent used to learn of a finish only when it thought to
     * call subagent_status, and polled it to find out (15 Oct 2026).
     */
    if (subagents.hasUnread()) {
      const finished = subagents.collect();
      for (const agent of finished) ledger.recordSubagentOutcome(agent.role, agent.status);
      const one = finished.length === 1;
      const still = subagents.runningCount();
      const note: LLMMessage = {
        role: "user",
        content:
          `[Sub-agent finished] ${one ? "A sub-agent you delegated to has" : `${finished.length} sub-agents you delegated to have`} finished. ` +
          `${one ? "Its report follows" : "Their reports follow"}; there is no need to call subagent_status for ${one ? "it" : "them"}.` +
          (still > 0 ? ` ${still} other${still === 1 ? " is" : "s are"} still working; you are told when each finishes.` : "") +
          `\n\n${subagentReports(finished)}\n\nSoreQen sent this, not the user. Fold what is useful into the work.`,
        fromLoop: true,
      };
      history.push(note);
      await persist(note, { kind: "nudge", displayOnly: false });
    }

    /*
     * An app connected during the turn is usable in the turn ("connect to
     * this", then use it; asked for 13 Oct 2026). The host's list is read
     * again each step and the tools offered follow it; when nothing changed
     * nothing is rebuilt, so the cached prefix holds.
     */
    if (external?.refresh) {
      await external.refresh().catch(() => undefined);
      const now = externalNames();
      if (now !== offeredExternal) {
        offeredExternal = now;
        toolDefinitions = buildTools();
        toolTokens = estimateTokens(JSON.stringify(toolDefinitions));
      }
    }

    /*
     * The threshold is the person's to set — `/autocompact 80`, or a token
     * count — and is read every step, so changing it mid-turn takes effect at
     * the next one. It is a share of the whole window, like the meter shows;
     * the conversation's own trigger is that, less the system prompt and tool
     * schemas every request also carries, and never above the budget that
     * leaves room for the reply.
     */
    const compactSetting = options.controls?.autoCompact();
    const compactAtTokens = autoCompactTokens(compactSetting, windowTokens);
    const historyTrigger = Math.min(historyBudget, Math.max(2_000, compactAtTokens - systemTokens - toolTokens));
    const compactRequested = options.controls?.takeCompactRequest() ?? false;
    /*
     * The context engine prepares this step: the history as it should be
     * seen (superseded and stale output condensed, large output as digests
     * with artifacts, overtaken reads marked stale), the phase, and the
     * working set compiled from durable state and retrieval.
     *
     * The trigger is measured against the prepared view, not the raw record —
     * otherwise a history that is mostly dead snapshots would be compacted for
     * a size it no longer has — and against the budget's soft ceiling for
     * history, so the conversation is checkpointed long before it is merely
     * physically too big.
     */
    const budget = budgetFor({
      ...(options.model ? { model: options.model } : {}),
      window: windowTokens,
      systemTokens,
      toolTokens,
      ...(options.maxOutputTokens ? { maxOutputTokens: options.maxOutputTokens } : {}),
      // Only a threshold the person set: with none, the default history point applies.
      ...(compactSetting != null ? { autoCompactTokens: compactAtTokens } : {}),
    });
    let prepared = await engine.prepare({ history, budget });
    let tidied = prepared.view;
    const historyTokens = estimateHistoryTokens(tidied);
    const checkpointTrigger = Math.min(historyTrigger, budget.checkpointAt);

    if (compactRequested || (iteration >= summaryRetryAt && historyTokens > checkpointTrigger)) {
      /*
       * Compact to a size, not to a fraction.
       *
       * The point of a compaction is to buy enough room that the next hundred
       * steps do not need another one. A fraction of the trigger cannot do
       * that: on a large window it keeps so much verbatim history that the
       * session is back at the trigger almost immediately, paying for a
       * summary every few steps — the behaviour that made long turns stall
       * and announce a full context as the reason.
       *
       * So the target is absolute: the window's tier says how much verbatim
       * tail stays (24k up to 96k; see `checkpointTierFor`), never more than
       * the budget allows. A hand-asked compaction takes half of that,
       * because the person wants room now.
       */
      const target = Math.min(historyBudget, budget.checkpointKeep * (compactRequested ? 0.5 : 1));
      /*
       * A checkpoint into task state first; the narrative summary only if the
       * extraction could not be made. Either way the older messages are not
       * simply lost — see `context/state-checkpoint.ts`.
       */
      const checkpointed = await engine.checkpoint({
        history,
        provider: llmProvider,
        ...(options.model ? { model: options.model } : {}),
        keepRecentTokens: Math.floor(target),
        // A share of the room below the next checkpoint, so restoring cannot trigger it.
        // and never more than the window's tier allows (15k, or 25k on larger windows).
        restoreTokens: Math.min(budget.restoreTokens, Math.floor(Math.max(0, checkpointTrigger - target) * 0.3)),
        signal,
      });
      const condensed = checkpointed
        ? { ...checkpointed, summary: checkpointed.message, method: "checkpoint" as const }
        : await summarizeHistory({
            history,
            provider: llmProvider,
            model: options.model,
            keepRecentTokens: Math.floor(target),
            maxTranscriptTokens: Math.floor(historyBudget * 0.6),
            signal,
          }).then((r) => (r ? { ...r, method: "summary" as const } : null));
      if (condensed) {
        history.splice(0, history.length, ...condensed.history);
        prepared = await engine.prepare({ history, budget, advance: false });
        tidied = prepared.view;
        prefixSeal = null;
        await persist(condensed.summary, {
          kind: "compaction",
          ...(condensed.coversThroughId ? { coversThroughId: condensed.coversThroughId } : {}),
        });
        /*
         * What the model had in view, before and after: the number the
         * trigger read. `condensed.tokensBefore` measures the stored record,
         * every old snapshot and full output the model is never sent, and the
         * notice read "1.7M → 23.8k" in a 1M window cut at 360k (18 Oct 2026).
         */
        await emit({
          type: "context_compacted",
          sessionId,
          method: condensed.method,
          tokensBefore: historyTokens,
          tokensAfter: estimateHistoryTokens(tidied),
        });
      } else {
        if (compactRequested) {
          await emit({
            type: "context_compacted",
            sessionId,
            method: "unchanged",
            tokensBefore: historyTokens,
            tokensAfter: historyTokens,
          });
        }
        summaryRetryAt = iteration + 5;
      }
    }

    /*
     * Rolling checkpoints: each 80k of conversation not yet read into task
     * state is read now, in the background, while it stays in the history.
     * The cut above then drops only what has been read, usually without a
     * request of its own. Close to the cut, a smaller stretch is read too,
     * so the cut finds it already done. See `extractAhead` in
     * `context/state-checkpoint.ts`.
     */
    engine.readAhead({
      history,
      view: tidied,
      provider: llmProvider,
      ...(options.model ? { model: options.model } : {}),
      every: budget.extractEvery,
      nearCutAt: checkpointTrigger * NEAR_CUT_SHARE,
      signal,
    });

    /*
     * Compact against a real token budget, derived from this model's window —
     * and leave the sealed prefix exactly as it was sent.
     */
    /*
     * The seal is compared with `tidied`, not `history`.
     *
     * The seal fingerprints what was sent, and what was sent is derived from
     * `tidied`. Comparing it with the raw history — as this did — meant any
     * tool result long enough to be trimmed made the fingerprint differ for
     * ever, so the seal never held past the first long output.
     */
    const frameTokens = estimateTokens(prepared.frame);
    const frozen = stablePrefixLength(tidied, prefixSeal);
    let compactedHistory = compactHistory(tidied, {
      // The working set is sent too, and comes out of the same budget.
      maxTokens: Math.max(4_000, historyBudget - frameTokens),
      frozenPrefixLength: frozen,
    });

    /*
     * Stop before sending, not after.
     *
     * A budget checked after the response has arrived has already spent the
     * money it exists to protect.
     */
    const messageTokens = estimateHistoryTokens(compactedHistory) + frameTokens;
    const requestTokens = systemTokens + toolTokens + messageTokens;
    lastRequestTokens = requestTokens;

    /*
     * The meter in the provider's tokens, not the estimate's.
     *
     * Budgets and the checkpoint trigger stay on the estimate, which errs
     * high on purpose (see token-estimate.ts). What the person reads is
     * scaled by how the provider's count of recent requests compared with
     * the estimate of them: a fresh session read 28,700 here when the
     * provider counted about 23,000 (6 Nov 2026). The mark where the
     * checkpoint will happen is scaled with it, so the two still agree.
     */
    const scale = meterScale.factor(meterModel);
    const shown = (n: number): number => Math.round(n * scale);
    await emit({
      type: "context_usage",
      sessionId,
      usage: {
        usedTokens: shown(requestTokens),
        windowTokens,
        /*
         * Where the engine will actually checkpoint, in the meter's terms —
         * derived from the trigger, not computed beside it, so the mark on
         * the meter and the compaction it predicts cannot disagree again.
         */
        compactAtTokens: Math.min(windowTokens, shown(systemTokens + toolTokens + frameTokens + checkpointTrigger)),
        breakdown: { system: shown(systemTokens), tools: shown(toolTokens), messages: shown(messageTokens), workingSet: shown(frameTokens) },
      },
    });
    await emit({
      type: "context_debug",
      sessionId,
      debug: {
        ...prepared.debug,
        tokens: { ...prepared.debug.tokens, history: estimateHistoryTokens(compactedHistory), total: requestTokens },
        cache: {
          sealedMessages: frozen,
          sealedTokens: estimateHistoryTokens(tidied.slice(0, frozen)),
          // The provider's own count, up to the previous request: whether the prefix really was reused.
          ...(providerCache.requests > 0 ? { provider: { ...providerCache } } : {}),
        },
      } as unknown as Record<string, unknown>,
    });
    if (options.maxTurnTokens && estimatedTokensUsed + requestTokens > options.maxTurnTokens) {
      stopReasonForTurn = "token_budget_exhausted";
      finalResponseText =
        finalResponseText ||
        "This turn reached its token budget before finishing. The work so far is intact; " +
          "send another message to continue.";
      break;
    }
    estimatedTokensUsed += requestTokens;

    /*
     * Which model handles this pass.
     *
     * Routing is off by default and off entirely at the top effort tier — see
     * `model-router.ts`. When it is off, this returns the configured model.
     */
    const route = routeStep(routing, history, iteration, effort);

    await emit({ type: "step_start", sessionId, step: iteration, tokens: estimatedTokensUsed, outputTokens: outputWithSubagents() });

    /** Set when this step's response is set aside to read a new message. */
    let setAsideForMessage = false;
    /**
     * Skills a write in this response reaches that are not in view yet, and
     * the file that reached them. The response is set aside before the write
     * runs, the skills come in, and the step is asked for again: a skill read
     * after the files it covers were written is a skill that changed nothing
     * (1 Nov 2026, the documentation skill arriving after every document of a
     * turn had been written). See `skillsAhead`.
     */
    let skillAhead: { names: string[]; path: string; callId: string; tool: string } | null = null;
    const skillsAhead = (name: string, path: string | undefined, callId: string): { names: string[]; path: string; callId: string; tool: string } | null => {
      if (!path || (name !== "write_file" && name !== "edit_file")) return null;
      if (options.skills?.autoActivate === false || skillsReached >= MAX_AUTO_SKILLS || draft) return null;
      const names = skills.reachedBy([path]).filter((n) => !skillsInView.has(n)).slice(0, MAX_AUTO_SKILLS - skillsReached);
      return names.length > 0 ? { names, path, callId, tool: name } : null;
    };

    let currentTurnText = "";
    /** This response's reasoning. Sent back with the assistant message it
     *  belongs to, because a thinking model may refuse the next request
     *  without it — see `LLMMessage.reasoningContent`. */
    let currentReasoning = "";
    /** Claude's thinking blocks for this response, signatures and all; see `LLMMessage.thinkingBlocks`. */
    let currentThinking: ThinkingBlock[] = [];
    let reasoningStartedAt = 0;
    let reasoningMs = 0;
    let activeToolCalls: LLMToolCall[] = [];
    /** Calls whose arguments could not be read, by id: answered in words, never run. */
    const unreadable = new Map<string, { raw: string; error: string }>();
    let stopReason: "end_turn" | "tool_use" | "max_tokens" | "stop_sequence" = "end_turn";
    /** What the provider says this response's output came to, when it says. */
    let reportedOutput: number | null = null;
    /** Tool calls the model wrote as text that could not be read. None ran. */
    let malformedCalls = 0;
    /** Calls announced during this response, by position. */
    let pendingCalls = new Map<string, { index: number; id: string; name: string; json: string; sentAt: number; preview: string }>();

    const endReasoning = (): void => {
      if (reasoningStartedAt && !reasoningMs) reasoningMs = Date.now() - reasoningStartedAt;
    };

    /*
     * One model response, retried until it arrives whole.
     *
     * A retry discards the failed attempt completely: its partial text never
     * reaches history, and `model_retry` tells a surface to clear what it had
     * drawn since `step_start`.
     */
    for (let attempt = 1; ; attempt++) {
      /*
       * Thinking is timed from the request, not from the first reasoning that
       * arrives: several providers think in silence and send a summary of it
       * in one burst just before answering, which timed a minute of thought as
       * the milliseconds of the burst — "Thought for 1s" (28 Sep 2026).
       */
      const askedAt = Date.now();
      currentTurnText = "";
      currentReasoning = "";
      currentThinking = [];
      reasoningStartedAt = 0;
      reasoningMs = 0;
      activeToolCalls = [];
      stopReason = "end_turn";
      reportedOutput = null;
      malformedCalls = 0;
      pendingCalls = new Map();

      /*
       * Each attempt has its own abort, so a stalled one can be closed without
       * stopping the turn. Stopping the turn still aborts it.
       */
      const attemptAbort = new AbortController();
      const forwardStop = (): void => attemptAbort.abort();
      if (signal?.aborted) attemptAbort.abort();
      else signal?.addEventListener("abort", forwardStop, { once: true });

      /*
       * A message sent while the model is still thinking is read now, not
       * after the response it no longer applies to. The response is set aside
       * and asked for again with the message in view — but only while nothing
       * of substance has been written: a reply under way, or a tool call being
       * streamed, finishes first. See `SET_ASIDE_TEXT_LIMIT`.
       */
      let interruptedForMessage = false;
      // The message was one the person chose to send now: see `urgentMessages`.
      let interruptedUrgently = false;
      // A reply or a thought that has turned into one phrase over and over; see `degenerate.ts`.
      const replyLoop = new DegenerationWatch();
      const thoughtLoop = new DegenerationWatch();
      const pendingMessages = options.controls?.pendingMessages;
      const messageWatch = pendingMessages
        ? setInterval(() => {
            if (interruptedForMessage || pendingMessages() === 0) return;
            const now = (options.controls?.urgentMessages?.() ?? 0) > 0;
            if (!now && (pendingCalls.size > 0 || activeToolCalls.length > 0 || currentTurnText.length > SET_ASIDE_TEXT_LIMIT)) return;
            interruptedForMessage = true;
            interruptedUrgently = now;
            attemptAbort.abort();
          }, MESSAGE_POLL_MS)
        : null;

      try {
        // The loop's own notes go inside the step they belong to; see `step-notes.ts`.
        const sendable = inStep(compactedHistory);
        const breakpoint = cacheBreakpointIndex(compactedHistory, prefixSeal);
        const stream = llmProvider.chatStream({
          system: systemPrompt,
          // The working set rides at the end: rebuilt each step, never stored.
          messages: withFrame(sendable.messages, prepared.frame),
          tools: toolDefinitions,
          cacheBreakpointIndex: breakpoint === null ? null : sendable.at(breakpoint),
          cacheKey: sessionId,
          // SoreQen Auto's hints: plan mode plans, a delegated agent is routine work,
          // and a loop that keeps repeating itself is struggling.
          step: mode === "plan" ? "plan" : /_sub_/.test(sessionId) ? "subagent" : "main",
          ...(repeatHeat > 0 ? { failures: Math.round(repeatHeat / REPEAT_HEAT_STEP) } : {}),
          model: options.model ?? (routing.enabled ? route.model : undefined),
          ...(effortSpec
            ? { temperature: Math.min(1, effortSpec.temperature + repeatHeat), reasoning: tierBelow(effortSpec.id, thoughtOut) }
            : repeatHeat > 0
              ? { temperature: repeatHeat }
              : {}),
          signal: attemptAbort.signal,
        });

        const idleMs =
          options.streamIdleMs ??
          (effortSpec?.id === "max" || effortSpec?.id === "apex" ? DEEP_STREAM_IDLE_MS : STREAM_IDLE_MS);
        // A stopped turn stops waiting here at once, whether or not the stream ends when its request is aborted.
        for await (const chunk of withIdleTimeout(stream, idleMs, () => attemptAbort.abort(), signal)) {
          // Stop mid-response rather than paying out the whole generation.
          throwIfCancelled(signal);

          if (chunk.type === "token") {
            endReasoning();
            currentTurnText += chunk.text;
            if (replyLoop.check(currentTurnText)) {
              attemptAbort.abort();
              throw new DegenerateOutputError("reply");
            }
            // Checking the summary is not a second summary: not shown as it is written.
            if (!draft) await emit({ type: "token", sessionId, delta: chunk.text });
          } else if (chunk.type === "reasoning") {
            if (!reasoningStartedAt) reasoningStartedAt = askedAt;
            currentReasoning += chunk.text;
            if (thoughtLoop.check(currentReasoning)) {
              attemptAbort.abort();
              throw new DegenerateOutputError("thinking");
            }
            if (!draft) await emit({ type: "thinking", sessionId, delta: chunk.text });
          } else if (chunk.type === "thinking_block") {
            currentThinking.push(chunk.block);
          } else if (chunk.type === "tool_call_start") {
            endReasoning();
            const key = chunk.index !== undefined ? `i${chunk.index}` : chunk.id;
            if (!pendingCalls.has(key)) {
              const entry = { index: pendingCalls.size, id: chunk.id, name: chunk.name, json: "", sentAt: Date.now(), preview: "" };
              pendingCalls.set(key, entry);
              await emit({ type: "tool_call_pending", sessionId, index: entry.index, tool: chunk.name });
            }
          } else if (chunk.type === "tool_call_delta") {
            const key = chunk.index !== undefined ? `i${chunk.index}` : chunk.id;
            const entry = pendingCalls.get(key);
            if (!entry) continue;
            entry.json += chunk.inputDelta;
            /*
             * What the call is, as soon as it can be read; how far along it is,
             * a few times a second. A 40 KB file arrives as thousands of deltas
             * and an event per delta would cost more than the file.
             */
            const preview = previewPartialInput(entry.json);
            // A write to a file a skill covers: stop here, before its content is written; see `skillAhead`.
            const ahead = skillsAhead(entry.name, preview?.["path"], entry.id);
            if (ahead) {
              skillAhead = ahead;
              attemptAbort.abort();
              break;
            }
            const previewKey = preview ? JSON.stringify(preview) : "";
            const now = Date.now();
            if (previewKey !== entry.preview || now - entry.sentAt >= PENDING_THROTTLE_MS) {
              entry.preview = previewKey;
              entry.sentAt = now;
              await emit({
                type: "tool_call_pending",
                sessionId,
                index: entry.index,
                tool: entry.name,
                ...(preview ? { preview } : {}),
                bytes: entry.json.length,
              });
            }
          } else if (chunk.type === "tool_call_complete") {
            // A provider that sends each call whole is checked here instead.
            const ahead = skillsAhead(chunk.name, typeof chunk.input?.["path"] === "string" ? chunk.input["path"] : undefined, chunk.id);
            if (ahead) {
              skillAhead = ahead;
              attemptAbort.abort();
              break;
            }
            activeToolCalls.push({ id: chunk.id, name: chunk.name, input: chunk.input });
            if (chunk.malformed) unreadable.set(chunk.id, chunk.malformed);
          } else if (chunk.type === "malformed_tool_call") {
            malformedCalls++;
          } else if (chunk.type === "model_fallback") {
            await emit({ type: "model_fallback", sessionId, from: chunk.from, to: chunk.to, reason: chunk.reason });
          } else if (chunk.type === "usage") {
            providerCache.requests++;
            providerCache.inputTokens += chunk.inputTokens;
            providerCache.cachedTokens += chunk.cachedTokens;
            providerCache.last = { inputTokens: chunk.inputTokens, cachedTokens: chunk.cachedTokens };
            if (typeof chunk.outputTokens === "number" && chunk.outputTokens > 0) reportedOutput = (reportedOutput ?? 0) + chunk.outputTokens;
            meterScale.observe(meterModel, lastRequestTokens, chunk.inputTokens);
          } else if (chunk.type === "stop") {
            stopReason = chunk.reason;
          }
        }

        /*
         * A stream that ended because the turn was cancelled is a cancellation.
         * The provider ends quietly on abort; without this the partial text
         * would be taken as a finished answer. The same goes for one set aside
         * for a message.
         */
        throwIfCancelled(signal);
        if (interruptedForMessage) throw new SetAsideForMessage();
        if (skillAhead) break;
        endReasoning();
        const empty =
          !currentTurnText.trim() &&
          activeToolCalls.length === 0 &&
          pendingCalls.size === 0 &&
          malformedCalls === 0 &&
          stopReason !== "max_tokens";
        // The check of a summary may be answered with nothing; see `readSummaryCheck`.
        if (empty && !draft && attempt <= EMPTY_RESPONSE_RETRIES) throw new EmptyResponseError();
        break;
      } catch (err) {
        if (err instanceof TurnCancelledError || signal?.aborted) {
          throw err instanceof TurnCancelledError ? err : new TurnCancelledError();
        }
        // Stopped on purpose, for a skill; handled after this loop.
        if (skillAhead) break;

        /*
         * Stuck repeating one phrase: the response is dropped and asked for
         * again, sampled hotter so the same context does not give the same
         * loop. Never shown to the person as a reply, never put in history.
         */
        if (err instanceof DegenerateOutputError && degenerateRetries < MAX_DEGENERATE_RETRIES) {
          degenerateRetries++;
          repeatHeat = Math.min(REPEAT_HEAT_MAX, repeatHeat + 0.3);
          await emit({
            type: "model_retry",
            sessionId,
            attempt,
            delayMs: 0,
            message: `${err.message} Asking again.`,
            reason: "error",
          });
          continue;
        }

        if (interruptedForMessage) {
          /*
           * Cut short by "Send now" partway through a reply: what it had said
           * stays, on screen and in the conversation, marked as cut short for
           * the model, so it answers the message knowing where it stopped.
           * Calls it had not finished writing are dropped. With nothing said
           * yet, the response is simply asked for again.
           */
          const said = currentTurnText.trim();
          if (interruptedUrgently && said) {
            const cut: LLMMessage = { role: "assistant", content: said, ...reasoningFor(currentReasoning, currentThinking) };
            history.push({ ...cut, content: `${said}\n\n[Cut short here: the person sent a message that could not wait.]` });
            await persist(cut, { kind: "response", ...(currentReasoning ? { reasoning: currentReasoning } : {}) });
          } else {
            await emit({
              type: "model_retry",
              sessionId,
              attempt,
              delayMs: 0,
              message: "Reading the message you just sent.",
              reason: "interjection",
            });
          }
          setAsideForMessage = true;
          break;
        }

        /*
         * Too long for the model: learn its real limit and condense.
         *
         * The window table is an estimate, and some endpoints serve a model
         * with a smaller window than its name suggests. The budget shrinks and
         * the history is compacted to it, rather than the turn ending.
         */
        if (isContextOverflow(err) && attempt <= 4) {
          historyBudget = Math.max(4_000, Math.floor(historyBudget * 0.6));
          prefixSeal = null;
          compactedHistory = compactHistory(prepared.view, { maxTokens: Math.max(4_000, historyBudget - frameTokens) });
          await emit({
            type: "model_retry",
            sessionId,
            attempt,
            delayMs: 0,
            message: "The conversation was too long for the model. Condensing it and trying again.",
            reason: "overflow",
          });
          continue;
        }

        const wait = modelRetryDelayMs(attempt, options.retryScheduleMs);
        if (!isTransientModelError(err) || wait === null) throw err;

        await emit({
          type: "model_retry",
          sessionId,
          attempt,
          delayMs: wait,
          message: retryMessage(err),
          reason: err instanceof StreamStalledError ? "stall" : "error",
        });
        await delay(wait, signal);
      } finally {
        if (messageWatch) clearInterval(messageWatch);
        signal?.removeEventListener("abort", forwardStop);
      }
    }

    // The new message is delivered at the top of the next step.
    if (setAsideForMessage) continue;

    /*
     * A skill before the write it covers.
     *
     * The write is stopped before its content is written, and the skills come
     * in as its result: "not written yet; here is what covers it; write it
     * again". Once per skill per turn, at most `MAX_AUTO_SKILLS`; a skill that
     * will not load is not asked for again.
     *
     * The response itself is kept — its thinking, what it said, the call it
     * began. It used to be thrown away and the step asked for again, and from
     * the outside that looked like the agent finishing a thought, starting a
     * write, then forgetting both and thinking the same thing from the start
     * (reported 13 Nov 2026). Kept, nothing is thought twice, and Claude's
     * signed thinking stays valid: nothing before it changes.
     */
    if (skillAhead) {
      const { names, path: reachedPath, callId: stoppedId, tool: stoppedTool } = skillAhead;
      endReasoning();
      const loaded = names.map((name) => ({ name, result: skills.load(name) }));
      for (const l of loaded) skillsInView.add(l.name);
      const ok = loaded.filter((l) => l.result.ok);
      skillsReached += ok.length;

      const stopped: LLMToolCall = { id: stoppedId || `call_skill_${Date.now().toString(36)}`, name: stoppedTool, input: { path: reachedPath } };
      // Calls this response finished before the write: not run, and said so, so the model asks again if it still wants them.
      const before = activeToolCalls.filter((c) => c.id !== stopped.id);
      const said: LLMMessage = { role: "assistant", content: currentTurnText, ...reasoningFor(currentReasoning, currentThinking), toolCalls: [...before, stopped] };
      history.push(said);
      await persist(said, { kind: "response", ...(currentReasoning ? { reasoning: currentReasoning, thinkingMs: reasoningMs } : {}) });

      for (const call of before) {
        const content = "Not run: this step was set aside to read a skill first. Call it again if you still need it.";
        await emit({ type: "tool_call", sessionId, callId: call.id, tool: call.name, input: call.input });
        await emit({ type: "tool_result", sessionId, callId: call.id, tool: call.name, output: content, success: false, deferred: true });
        const message: LLMMessage = { role: "tool", toolCallId: call.id, content };
        history.push(message);
        await persist(message, { kind: "tool_result", toolName: call.name, success: false, deferred: true });
      }

      const skillText = ok.map((l) => `<skill name="${l.name}">\n${l.result.ok ? l.result.text : ""}\n</skill>`).join("\n");
      const content =
        ok.length > 0
          ? [
              `Not written yet: ${reachedPath} is covered by the ${ok.map((l) => l.name).join(" and ")} skill, which was not in view. ` +
                "Read it below; it is your instructions for this work from here on. Then make the change again, following it.",
              "",
              `<soreqen-skills note="Loaded by SoreQen because this write reached them. Not something the user wrote.">`,
              skillText,
              "</soreqen-skills>",
            ].join("\n")
          : `Not written yet: the skill that covers ${reachedPath} could not be loaded. Make the change again.`;
      await emit({ type: "tool_call", sessionId, callId: stopped.id, tool: stopped.name, input: stopped.input });
      await emit({ type: "tool_result", sessionId, callId: stopped.id, tool: stopped.name, output: content, success: false, deferred: true });
      const result: LLMMessage = { role: "tool", toolCallId: stopped.id, content };
      history.push(result);
      await persist(result, { kind: "tool_result", toolName: stopped.name, success: false, deferred: true });

      // What the person sees in place of the stopped write: the skills, read.
      const stamp = Date.now().toString(36);
      for (const [i, l] of ok.entries()) {
        const callId = `skill_${stamp}_${i}`;
        await emit({ type: "tool_call", sessionId, callId, tool: "use_skill", input: { name: l.name, matched: [`before writing ${fileName(reachedPath)}`] } });
        await emit({ type: "tool_result", sessionId, callId, tool: "use_skill", output: l.result.ok ? l.result.text : "", success: true });
      }
      continue;
    }

    /*
     * What the model wrote, as the provider counted it.
     *
     * It was always an estimate, at 3.5 characters a token: right for code,
     * but reasoning is prose, nearer 4.5 to the token, and a call's arguments
     * were measured as JSON, every newline and quote escaped. A long turn
     * read a third or so above what the provider billed, and beside Claude
     * Code doing the same work it looked inflated (reported 6 Nov 2026). The
     * estimate stays for a provider that reports no usage.
     */
    if (reportedOutput !== null) {
      outputTokens += reportedOutput;
    } else {
      const writtenCalls =
        pendingCalls.size > 0
          ? [...pendingCalls.values()].reduce((sum, call) => sum + estimateTokens(call.json), 0)
          : activeToolCalls.reduce((sum, call) => sum + estimateTokens(JSON.stringify(call.input)), 0);
      outputTokens += estimateTokens(currentTurnText) + estimateTokens(currentReasoning) + writtenCalls;
    }

    /*
     * Re-seal from what was actually sent, not from `history`.
     *
     * `compactedHistory` is the byte-for-byte payload the provider saw;
     * sealing the local record would fingerprint bytes that were never
     * transmitted.
     */
    prefixSeal = sealPrefix(compactedHistory, historyBudget, prefixSeal);

    const reasoningMeta: MessageMeta = currentReasoning
      ? { reasoning: currentReasoning, thinkingMs: reasoningMs }
      : {};

    if (stopReason === "tool_use" && activeToolCalls.length > 0) {
      unacted = null;
      // The check found work still to do: the draft stands as what was said, and the turn goes on.
      await flushDraft();
      const assistantMessage: LLMMessage = {
        role: "assistant",
        content: currentTurnText,
        toolCalls: activeToolCalls,
        ...reasoningFor(currentReasoning, currentThinking),
      };
      history.push(assistantMessage);
      // Stored before anything runs, so a reload mid-command shows the call.
      await persist(assistantMessage, { kind: "response", ...reasoningMeta });

      /*
       * Tool execution happens in two phases, and the split is the point.
       *
       * **Gate, in order.** Permission checks and confirmations run strictly
       * sequentially.
       *
       * **Execute, in contiguous batches.** Runs of adjacent parallel-safe
       * calls go together; anything else runs alone, in order. Given
       * [read A, write B, read C], hoisting both reads into one batch would run
       * `read C` before `write B` — so a batch never crosses a sequential call.
       */
      type Gated =
        | { kind: "run"; call: LLMToolCall }
        | {
            kind: "refused";
            call: LLMToolCall;
            message: string;
            code: "PERMISSION_DENIED" | "USER_REJECTED" | "WITHHELD";
          };

      const gated: Gated[] = [];

      for (const toolCall of activeToolCalls) {
        toolCallsExecuted++;
        if (toolCall.name === "remember" || toolCall.name === "edit_memory") rememberedThisTurn = true;

        await emit({
          type: "tool_call",
          sessionId,
          callId: toolCall.id,
          tool: toolCall.name,
          input: toolCall.input,
        });

        // The step it was given to report in, without tools; see `STUCK_AT`.
        if (closing) {
          gated.push({
            kind: "refused",
            call: toolCall,
            message: "Not run: this step was for telling the user where things stand, without calling tools.",
            code: "WITHHELD",
          });
          continue;
        }

        // Loading a connector's tools changes only what the model is offered: allowed in every mode.
        if (toolCall.name === LOAD_TOOLS) {
          gated.push({ kind: "run", call: toolCall });
          continue;
        }

        // An MCP server's tool acts outside the workspace; it has its own rule.
        const externalInfo = external?.describe(toolCall.name);
        let permCheck = externalInfo
          ? decideExternalTool(externalInfo, { mode, tier: permissionTier })
          : evaluateForMode(asWrite(toolCall), {
              mode,
              checkpointAvailable,
              workspaceTier: options.permissionTier,
            });

        /*
         * A file written somewhere else on the computer.
         *
         * Auto works without asking because a checkpoint can undo its edits,
         * and a checkpoint covers the project only. A write outside it is
         * one auto cannot take back, so it asks — as it does for anything
         * else irreversible. Bypass does not ask; manual already does.
         */
        const writing = asWrite(toolCall);
        const writtenPath = writing.input["path"];
        if (
          mode === "auto" &&
          permCheck.allowed &&
          !permCheck.requiresConfirmation &&
          (writing.name === "write_file" || writing.name === "edit_file") &&
          typeof writtenPath === "string" &&
          sandboxRunner.isOutsideWorkspace?.(workspaceId, writtenPath)
        ) {
          permCheck = {
            ...permCheck,
            requiresConfirmation: true,
            reason: `Write ${writtenPath}, outside this project, where a checkpoint cannot undo it`,
          };
        }

        if (!permCheck.allowed) {
          gated.push({
            kind: "refused",
            call: toolCall,
            message: `Action denied by policy: ${permCheck.reason ?? "Violates hard denylist."}`,
            code: "PERMISSION_DENIED",
          });
          continue;
        }

        if (permCheck.requiresConfirmation) {
          const description =
            permCheck.reason ?? `Execute potentially sensitive operation: '${toolCall.name}'`;
          let approved = false;

          if (onAwaitConfirmation) {
            await emit({
              type: "confirmation_required",
              sessionId,
              confirmationId: `conf_${toolCall.id}`,
              action: toolCall.name,
              description,
            });
            approved = await onAwaitConfirmation({
              confirmationId: `conf_${toolCall.id}`,
              toolCall,
              action: toolCall.name,
              description,
            });
            // A Stop pressed while the question was open arrives as a refusal;
            // it is a cancellation, and must end the turn as one.
            throwIfCancelled(signal);
          }

          if (!approved) {
            /*
             * Two different refusals, told apart: an agent told it was rejected
             * argues with a decision nobody made; an agent told the surface
             * cannot ask can do something else, or say why it stopped.
             */
            gated.push({
              kind: "refused",
              call: toolCall,
              message: onAwaitConfirmation
                ? "Action was explicitly rejected by user confirmation."
                : `'${toolCall.name}' needs confirmation, and this session has no way to ask ` +
                  `for one. Either do this differently, or report that it needs a mode or ` +
                  `surface that can prompt.`,
              code: "USER_REJECTED",
            });
            continue;
          }

          /*
           * The tool-layer flag is set here, and only here: `toolGitOperation`
           * refuses a push without `confirmed: true`, and the flag must mean
           * that someone was actually asked.
           */
          if (toolCall.name === "git_operation") {
            toolCall.input["confirmed"] = true;
          }
        }

        gated.push({ kind: "run", call: toolCall });
      }

      // Results are keyed by call id, because a batch finishes out of order
      // and history must not.
      const results = new Map<string, { content: string; success: boolean; full?: string; artifact?: string }>();
      const diffs = new Map<string, { path: string; unifiedDiff: string }>();
      const refusedIds = new Set<string>();

      for (const g of gated) {
        if (g.kind !== "refused") continue;
        results.set(g.call.id, { content: g.message, success: false });
        // Withheld (the report step, `STUCK_AT`) is not a refusal anyone made: no error, no "Denied".
        if (g.code !== "WITHHELD") {
          refusedIds.add(g.call.id);
          await emit({
            type: "error",
            sessionId,
            code: g.code,
            message: g.message,
            callId: g.call.id,
          });
        }
        // And a result, so the call is answered in every interface.
        await emit({
          type: "tool_result",
          sessionId,
          callId: g.call.id,
          tool: g.call.name,
          output: g.message,
          success: false,
        });
      }

      const executeOne = async (toolCall: LLMToolCall): Promise<void> => {
        const garbled = unreadable.get(toolCall.id);
        if (garbled) {
          const content = unreadableCallMessage(toolCall.name, garbled);
          results.set(toolCall.id, { content, success: false });
          await emit({ type: "tool_result", sessionId, callId: toolCall.id, tool: toolCall.name, output: content, success: false });
          return;
        }
        /*
         * A repeat of an identical read, served from this turn's cache. Only
         * read-only tools are cacheable, and every entry is dropped the moment
         * anything could have changed what it observed.
         */
        const cached = cache.get(toolCall);
        if (cached) {
          results.set(toolCall.id, cached);
          await emit({
            type: "tool_result",
            sessionId,
            callId: toolCall.id,
            tool: toolCall.name,
            output: cached.content,
            success: cached.success,
          });
          return;
        }

        if (toolCall.name === "edit_file" || toolCall.name === "write_file") {
          const targetPath = String(toolCall.input["path"] ?? "");
          if (targetPath && !modifiedFiles.includes(targetPath)) {
            modifiedFiles.push(targetPath);
          }
          writeCount++;
        }

        if (STATE_MUTATING_TOOLS.includes(toolCall.name) || externalWrite(toolCall.name)) {
          const audited = await logAuditEvent({
            workspaceId,
            sessionId,
            action: `tool_execute_${toolCall.name}`,
            actorType: "agent",
            detail: { tool: toolCall.name, input: auditableInput(toolCall.input), mode },
          });
          if (!audited.persisted) auditFailures++;
        }

        let resultString = "";
        let fullResult: string | undefined;
        let artifactPath: string | undefined;
        let success = true;

        try {
          // Stop ends the turn now, not when the slowest tool notices; see `untilCancelled`.
          const toolRes =
            toolCall.name === LOAD_TOOLS
              ? loadExternalTools(toolCall.input)
              : await untilCancelled(executeTool(toolCall.name, toolCall.input, { ...toolCtx, callId: toolCall.id }), signal);
          // A connector tool called without being loaded first is loaded now, so it is offered properly from here on.
          if (deferExternal && isDeferrable(toolCall.name) && !loadedExternal.has(toolCall.name) && external?.describe(toolCall.name)) {
            loadedExternal.add(toolCall.name);
            toolDefinitions = buildTools();
            toolTokens = estimateTokens(JSON.stringify(toolDefinitions));
          }

          /*
           * A picture, on its way to being seen.
           *
           * Held here and attached after the batch, because the wire format
           * makes a tool result a string: base64 placed in one is a wall of
           * characters that the result limit then cuts in half. The model gets
           * a real image block instead, in a user message that follows its own
           * tool result.
           */
          if (toolRes.images) {
            // A batch: its steps ran whether or not the pictures can be shown.
            if (modelSupportsVision(options.model)) {
              for (const image of toolRes.images) pendingImages.push({ callId: toolCall.id, ...image });
            } else if (toolRes.data && typeof toolRes.data === "object") {
              toolRes.data = {
                ...(toolRes.data as Record<string, unknown>),
                screenshots_not_shown: `The model in use (${options.model ?? "unknown"}) cannot read images.`,
              };
            }
            delete toolRes.images;
          }
          if (toolRes.image) {
            if (modelSupportsVision(options.model)) {
              pendingImages.push({ callId: toolCall.id, ...toolRes.image });
            } else {
              /*
               * Told, rather than silently degraded.
               *
               * Sending an image to a text-only model fails at the provider
               * with an error naming neither the file nor the model. Saying so
               * here lets the agent do the one thing that works — ask the
               * person what the picture shows, or pick a model that can see.
               */
              const source = toolRes.image.source;
              delete toolRes.image;
              toolRes.success = false;
              toolRes.error =
                `The model in use (${options.model ?? "unknown"}) cannot read images, so ` +
                `'${source}' could not be shown to you. Ask the user to switch to a ` +
                "vision-capable model, or to describe what the image shows.";
            }
          }

          // A step taken again with the same result is told so; see `RepeatNotes`.
          const again = repeatNotes.note(toolCall.name, toolCall.input, toolRes);
          if (again && toolRes.data && typeof toolRes.data === "object") {
            toolRes.data = { ...(toolRes.data as Record<string, unknown>), repeat: again };
          }

          // See `formatToolResult`: a failure carrying only an `error` used to
          // be reported to the model as "Execution succeeded." And see
          // `shapeToolOutput`: distilled before it is cut, paged when a
          // document is still too long, the whole saved readable.
          const shaped = shapeToolOutput(toolCall.name, toolRes, { sessionId, windowTokens, input: toolCall.input });
          resultString = shaped.content;
          fullResult = shaped.full;
          artifactPath = shaped.artifact;
          success = toolRes.success;
          ledger.record(toolCall.name, toolCall.input, {
            success: toolRes.success,
            data: toolRes.data,
          });

          if (toolRes.diff) {
            const diff = { path: String(toolCall.input["path"] ?? "unknown"), unifiedDiff: toolRes.diff };
            diffs.set(toolCall.id, diff);
            await emit({ type: "diff", sessionId, ...diff, callId: toolCall.id });
          }

          if (toolCall.name === "update_todo_list") {
            todoItems = (toolCall.input["items"] ?? []) as TodoItem[];
            engine.observePlan(todoItems);
            await emit({ type: "todo_update", sessionId, items: todoItems });
          }
        } catch (err: unknown) {
          if (err instanceof TurnCancelledError) throw err;
          success = false;
          // A schema error in words, and an empty call explained, rather than Zod's JSON list of issues.
          resultString = describeInputError(toolCall.name, toolCall.input ?? {}, err) ?? (err instanceof Error ? err.message : String(err));
        }

        results.set(toolCall.id, {
          content: resultString,
          success,
          ...(fullResult ? { full: fullResult } : {}),
          ...(artifactPath ? { artifact: artifactPath } : {}),
        });
        cache.set(toolCall, resultString, success);
        cache.observeMutation(toolCall);

        if (STATE_MUTATING_TOOLS.includes(toolCall.name) || externalWrite(toolCall.name)) {
          auditWrites.push(
            logAuditEvent({
              workspaceId,
              sessionId,
              action: `tool_result_${toolCall.name}`,
              actorType: "agent",
              detail: { tool: toolCall.name, success, output: resultString.slice(0, 2_000) },
            }).then((audited) => {
              if (!audited.persisted) auditFailures++;
            }),
          );
        }

        await emit({
          type: "tool_result",
          sessionId,
          callId: toolCall.id,
          tool: toolCall.name,
          output: resultString,
          success,
        });
      };

      // The last gate before anything touches the workspace.
      throwIfCancelled(signal);

      /*
       * A question runs alongside everything else in its step.
       *
       * Taken in order, a step of [ask_user, research] left the research
       * waiting for as long as the person took to answer, often minutes
       * (seen 8 Oct 2026). Nothing in the same step can depend on the answer,
       * since the model wrote every call in it before there was one, and the
       * question touches nothing in the workspace. So it is put to the person
       * first and the rest runs while they think.
       */
      const asked = gated.filter((g) => g.kind === "run" && g.call.name === "ask_user").map((g) => executeOne(g.call));
      const runnable = gated.filter((g) => g.kind === "run" && g.call.name !== "ask_user").map((g) => g.call);
      let cursor = 0;
      while (cursor < runnable.length) {
        if (!isParallelSafe(runnable[cursor]!.name)) {
          await executeOne(runnable[cursor]!);
          cursor++;
          continue;
        }
        let batchEnd = cursor;
        while (batchEnd < runnable.length && isParallelSafe(runnable[batchEnd]!.name)) batchEnd++;
        await Promise.all(runnable.slice(cursor, batchEnd).map(executeOne));
        cursor = batchEnd;
      }
      await Promise.all(asked);

      // Results go into history in the order the model asked for them,
      // whatever order they actually finished in.
      for (const toolCall of activeToolCalls) {
        const r = results.get(toolCall.id);
        let content = r?.content ?? "Tool produced no result.";

        /*
         * The same call, the same answer, again.
         *
         * Harmless under a step cap, which ended a spinning turn eventually.
         * Without one, a model that keeps re-reading an unchanged file or
         * re-running a failing command would spend for ever — so the result
         * itself tells it, at the moment it would otherwise do it once more.
         */
        const callKey = `${toolCall.name}:${JSON.stringify(toolCall.input)}`;
        if (callKey === lastCallKey && content === lastCallContent) {
          repeatCount++;
        } else {
          lastCallKey = callKey;
          lastCallContent = content;
          repeatCount = 1;
        }
        if (repeatCount >= REPEAT_NOTE_AT) {
          content +=
            `\n\n[Note: this is identical call number ${repeatCount} to ${toolCall.name}, and it ` +
            "returned exactly the same result as before. Repeating it will not change the outcome; " +
            "change your approach.]";
        }

        // The code graph's line on what was just read or searched for; see `graphNote`.
        const graphNote = await engine.graphNote(toolCall, r?.success ?? false).catch(() => null);
        if (graphNote) content += `\n\n${graphNote}`;

        if (PROCESS_TOOLS.has(toolCall.name)) for (const id of endedIn(content)) seenEnded.add(id);
        const toolMessage: LLMMessage = { role: "tool", toolCallId: toolCall.id, content };
        history.push(toolMessage);
        await engine.observeToolResult({
          call: toolCall,
          success: r?.success ?? false,
          content,
          ...(r?.full ? { full: r.full } : {}),
          ...(r?.artifact ? { artifact: r.artifact } : {}),
        });
        const diff = diffs.get(toolCall.id);
        await persist(toolMessage, {
          kind: "tool_result",
          toolName: toolCall.name,
          success: r?.success ?? false,
          ...(refusedIds.has(toolCall.id) ? { denied: true } : {}),
          ...(diff ? { diff } : {}),
        });
      }
      // Durable after every batch, so a crash mid-turn loses no task memory.
      await engine.persist();

      /*
       * A skill the work has reached.
       *
       * The request is matched once, before the first step, and a request
       * rarely names everything its work turns into: "build the game" whose
       * agent then writes the menu screen, "fix the bug" that lands in a
       * stylesheet. The first time this turn writes a file a skill covers
       * (by its paths), the skill comes in, after the batch's results, marked
       * as SoreQen's. At most `MAX_AUTO_SKILLS` this way per turn.
       */
      if (options.skills?.autoActivate !== false && skillsReached < MAX_AUTO_SKILLS) {
        const written = activeToolCalls
          .filter((c) => (c.name === "write_file" || c.name === "edit_file") && results.get(c.id)?.success)
          .map((c) => String(c.input["path"] ?? ""))
          .filter(Boolean);
        const reached = written.length > 0
          ? skills.reachedBy(written).filter((n) => !skillsInView.has(n)).slice(0, MAX_AUTO_SKILLS - skillsReached)
          : [];
        const loaded = reached.map((name) => ({ name, result: skills.load(name) })).filter((l) => l.result.ok);
        if (loaded.length > 0) {
          skillsReached += loaded.length;
          for (const l of loaded) skillsInView.add(l.name);
          const block = [
            '<soreqen-skills note="Loaded by SoreQen because the work reached files these cover. They are your instructions for that work from here on, not something the user wrote.">',
            ...loaded.map((l) => `<skill name="${l.name}">\n${l.result.ok ? l.result.text : ""}\n</skill>`),
            "</soreqen-skills>",
          ].join("\n");
          const note: LLMMessage = { role: "user", content: block, fromLoop: true };
          history.push(note);
          await persist(note, { kind: "nudge", displayOnly: true });
          const stamp = Date.now().toString(36);
          for (const [i, l] of loaded.entries()) {
            const callId = `skill_${stamp}_${i}`;
            await emit({ type: "tool_call", sessionId, callId, tool: "use_skill", input: { name: l.name, matched: ["files this step wrote"] } });
            await emit({ type: "tool_result", sessionId, callId, tool: "use_skill", output: l.result.ok ? l.result.text : "", success: true });
          }
        }
      }

      /*
       * Now the pictures.
       *
       * After every tool result in the batch, never between one and its call:
       * a user message inserted mid-batch separates an assistant's tool call
       * from the result that answers it, which strict endpoints reject.
       */
      if (pendingImages.length > 0) {
        const blocks: LLMContentBlock[] = [];
        for (const image of pendingImages) {
          /*
           * Fitted to what the provider accepts: a full-page screenshot of a
           * long page, or a large file opened with view_image, used to fail
           * the whole request (more than 8000 pixels a side). Most pictures
           * pass through untouched.
           */
          const fit = fitImageForModel(Buffer.from(image.base64, "base64"), image.mediaType, { name: image.source });
          blocks.push({ type: "text", text: `Image from ${image.source}${FRESH_IMAGE}${fit.note ? `\n${fit.note}` : ""}` });
          if (!fit.changed) {
            blocks.push({ type: "image", image_data: image.base64, media_type: image.mediaType });
            continue;
          }
          for (const part of fit.images) {
            if (part.label) blocks.push({ type: "text", text: part.label });
            blocks.push({ type: "image", image_data: Buffer.from(part.bytes).toString("base64"), media_type: part.mediaType });
          }
        }
        const shown: LLMMessage = { role: "user", content: blocks };
        history.push(shown);
        /*
         * Stored as a sentence, not as the bytes.
         *
         * The transcript already shows the picture next to the tool call that
         * produced it, and a session whose stored history carries several
         * megabytes of base64 is a session that cannot be loaded.
         */
        await persist(
          {
            role: "user",
            content: `[Looked at ${pendingImages.map((i) => i.source).join(", ")}]`,
          },
          { kind: "nudge", displayOnly: true },
        );
        pendingImages = [];
      }

      /*
       * A call it wrote as text alongside ones that ran. The others have
       * results; this one has nothing, and without a word the model would
       * read the silence as success.
       */
      if (malformedCalls > 0) {
        const nudge: LLMMessage = { role: "user", content: MALFORMED_CALL_NUDGE };
        history.push(nudge);
        await persist(nudge, { kind: "nudge" });
      }

      /*
       * Steps spent only on bookkeeping.
       *
       * A turn whose work was done spent eighteen steps — a minute of thought
       * each — updating its task state and plan before it would write its
       * answer (29 Sep 2026). Two such steps in a row, and it is told plainly
       * that nothing more is needed to finish.
       */
      bookkeepingSteps = activeToolCalls.every((c) => BOOKKEEPING_TOOLS.has(c.name)) ? bookkeepingSteps + 1 : 0;
      if (bookkeepingSteps >= BOOKKEEPING_NUDGE_AT) {
        bookkeepingSteps = 0;
        const nudge: LLMMessage = { role: "user", content: BOOKKEEPING_NUDGE };
        history.push(nudge);
        await persist(nudge, { kind: "nudge", displayOnly: true });
      }

      // A plan the work has moved past; see `PLAN_REMINDER_STEPS`.
      stepsSincePlan = activeToolCalls.some((c) => c.name === "update_todo_list") ? 0 : stepsSincePlan + 1;
      const planOpen = todoItems.filter((t) => t.status === "pending" || t.status === "in_progress");
      if (mode !== "plan" && todoItems.length > 1 && planOpen.length > 0 && stepsSincePlan >= PLAN_REMINDER_STEPS && planReminders < MAX_PLAN_REMINDERS) {
        stepsSincePlan = 0;
        planReminders++;
        const done = todoItems.filter((t) => t.status === "completed").length;
        const current = todoItems.find((t) => t.status === "in_progress");
        const nudge: LLMMessage = {
          role: "user",
          content:
            `[Note: your plan was last updated ${PLAN_REMINDER_STEPS} or more steps ago. It shows ${done} of ${todoItems.length} done` +
            (current ? `, with "${current.title}" in progress` : "") +
            ", and the person watches it to see where you are. If you have finished items since, mark them completed and " +
            "set the one you are on now as in_progress, in one update_todo_list call, then carry on. If it is already right, ignore this.]",
          fromLoop: true,
        };
        history.push(nudge);
        await persist(nudge, { kind: "nudge", displayOnly: true });
      }

      thoughtOut = 0;
      // Empty replies are a provider's passing glitch, counted in a row: a step that did something starts the count again.
      emptyNudges = 0;

      // Word for word and call for call, again: stuck. See `STUCK_AT`.
      const stepKey = `${currentTurnText.trim()}\u0000${activeToolCalls.map((c) => `${c.name}:${JSON.stringify(c.input)}`).join("|")}`;
      sameSteps = stepKey === lastStepKey ? sameSteps + 1 : 1;
      lastStepKey = stepKey;
      /*
       * The same step need not come back to back to be a loop: a model can
       * return to it after a few other steps, again and again (13 Oct 2026,
       * one listing taken sixteen times in runs of two and three). Counted
       * over the turn by what it said, what it called and what came back, so
       * a command run again after a change, printing something new, is new.
       */
      const fingerprint = stepFingerprint(
        currentTurnText,
        activeToolCalls,
        activeToolCalls.map((c) => results.get(c.id)?.content ?? ""),
      );
      const taken = (stepsTaken.get(fingerprint) ?? 0) + 1;
      stepsTaken.set(fingerprint, taken);
      const repeats = Math.max(sameSteps, taken);
      const tellKey = taken >= sameSteps ? fingerprint : stepKey;
      repeatHeat = Math.min(REPEAT_HEAT_MAX, REPEAT_HEAT_STEP * Math.max(0, repeats - 1));
      if (STUCK_TELL.has(repeats) && repeats > (toldRepeats.get(tellKey) ?? 0)) {
        toldRepeats.set(tellKey, repeats);
        const last = results.get(activeToolCalls[activeToolCalls.length - 1]?.id ?? "")?.content ?? "";
        const nudge: LLMMessage = {
          role: "user",
          content:
            `You have now taken exactly the same step ${repeats} times ${sameSteps === repeats ? "in a row" : "this turn"}: the same words, the same ` +
            `call${activeToolCalls.length === 1 ? "" : "s"} (${activeToolCalls.map((c) => c.name).join(", ")}), and the same result each time. ` +
            "Another identical attempt will get the same result. Read that result again" +
            (last.startsWith("FAILED") ? " (it says why it failed and what to do instead)" : "") +
            " and take a different step: a different tool, a different approach, or the work in smaller parts. " +
            "If something outside your control blocks you, say exactly what it is and finish.",
        };
        history.push(nudge);
        await persist(nudge, { kind: "nudge", displayOnly: true });
      }
      /*
       * Still identical at the tenth, through hotter sampling and two plain
       * reminders: the model reports instead of trying again.
       *
       * It used to stop the turn with an error ("Stopped: the same step was
       * taken 10 times in a row"), and the person asked that it never end that
       * way (23 Oct 2026). The model now gets one step, its calls not run, to
       * say in its own words what it was trying to do, what kept happening and
       * what it needs, and the turn ends on that answer like any other. Still
       * not a step cap: only a step repeated word for word and call for call
       * gets here.
       */
      if (closing) {
        // It called tools in the step meant for its report: the turn ends on what it wrote.
        const said = currentTurnText.trim();
        finalResponseText =
          said ||
          `I kept taking the same step (${activeToolCalls.map((c) => c.name).join(", ")}) and getting the same result, ` +
            "so I have paused here rather than repeat it again. Everything done so far is saved. " +
            "Tell me what to do differently, or say continue and I will take another approach.";
        if (!said) {
          await emit({ type: "token", sessionId, delta: finalResponseText });
          const reply: LLMMessage = { role: "assistant", content: finalResponseText };
          history.push(reply);
          await persist(reply, { kind: "final" });
        }
        break;
      }
      if (sameSteps >= STUCK_AT) {
        closing = true;
        const report: LLMMessage = {
          role: "user",
          content:
            `You have taken exactly the same step ${sameSteps} times in a row (${activeToolCalls.map((c) => c.name).join(", ")}), ` +
            "with the same result each time, so it will not be run again. Do not call any tool now. In a few lines, tell the user " +
            "what you were trying to do, what kept happening, what you have done so far, and what you need from them " +
            "(or what different approach you would take next). Then end your turn.",
          fromLoop: true,
        };
        history.push(report);
        await persist(report, { kind: "nudge", displayOnly: true });
        continue;
      }

      // Saying the same thing and reading the same files, step after step.
      const circling = repetition.observe(currentTurnText, activeToolCalls);
      if (circling) {
        const nudge: LLMMessage = { role: "user", content: circling };
        history.push(nudge);
        await persist(nudge, { kind: "nudge", displayOnly: true });
      }

      // A line before every call, step after step: told once to let the rows speak.
      const narrating = circling ? null : narration.observe(currentTurnText, activeToolCalls.length);
      if (narrating) {
        const nudge: LLMMessage = { role: "user", content: narrating, fromLoop: true };
        history.push(nudge);
        await persist(nudge, { kind: "nudge", displayOnly: true });
      }

      continue;
    }

    /*
     * It meant to call a tool and wrote the call as text instead.
     *
     * Nothing ran. Ending here would finish the turn on a promise — the model
     * believes it made the edit — so it is told, and the step is taken again.
     */
    if (malformedCalls > 0) {
      const said: LLMMessage = { role: "assistant", content: currentTurnText, ...reasoningFor(currentReasoning, currentThinking) };
      history.push(said);
      await persist(said, { kind: "response", ...reasoningMeta });
      const nudge: LLMMessage = { role: "user", content: MALFORMED_CALL_NUDGE };
      history.push(nudge);
      await persist(nudge, { kind: "nudge" });
      continue;
    }

    /*
     * Still empty after being asked again: the model is told, rather than its
     * silence being taken for a finished turn with a blank summary.
     */
    if (!draft && !currentTurnText.trim() && stopReason !== "max_tokens" && emptyNudges < MAX_EMPTY_NUDGES) {
      emptyNudges++;
      // The same context gave nothing: the next try is sampled a little hotter, like a repeated step.
      repeatHeat = Math.min(REPEAT_HEAT_MAX, REPEAT_HEAT_STEP * emptyNudges);
      /*
       * A thought that breaks off at a quote or a tag, then nothing: the model
       * server took a tag the model was writing for its own marker and ended
       * the response there (reproduced 11 Oct 2026). Said so, with the way round it.
       */
      const cut = CONTROL_TAGS.test(currentReasoning) || /['"`<=(]\s*$/.test(currentReasoning);
      const nudge: LLMMessage = {
        role: "user",
        content: cut ? `${EMPTY_RESPONSE_NUDGE}\n\n${unreadableCallMessage("last", { empty: true }).replace(/^FAILED: [^\n]*\n\n/, "")}` : EMPTY_RESPONSE_NUDGE,
      };
      history.push(nudge);
      await persist(nudge, { kind: "nudge" });
      continue;
    }

    if (stopReason === "max_tokens") {
      /*
       * The response hit the output ceiling.
       *
       * Prose that ran long can simply continue. A tool call cut off is
       * different: its arguments are incomplete, it cannot run, and asking the
       * model to "continue" makes it start the same oversized call again — for
       * ever, now that nothing caps the loop. It is told why it failed and how
       * to succeed instead.
       */
      const truncatedCall = pendingCalls.size > 0 || activeToolCalls.length > 0;
      /*
       * All of it was thought: nothing said, nothing called. "Continue where
       * you left off" has nothing to continue from (the thought is not kept
       * as an answer), so the model began again and thought just as long.
       * The step is taken again a tier lower, with nothing added to history.
       */
      if (!truncatedCall && !currentTurnText.trim() && thoughtOut < MAX_THOUGHT_OUT && effortSpec) {
        thoughtOut++;
        continue;
      }
      const partial: LLMMessage = {
        role: "assistant",
        content: currentTurnText,
        ...reasoningFor(currentReasoning, currentThinking),
      };
      history.push(partial);
      await persist(partial, { kind: "response", ...reasoningMeta });

      const nudge: LLMMessage = {
        role: "user",
        content: truncatedCall
          ? "Your last tool call was cut off because it exceeded the maximum length of a single " +
            "response, so it was not executed. Do not repeat it in one piece. Split the work: create " +
            "the file with its first part using write_file, then add the remaining parts with " +
            "edit_file (or several smaller files), each call comfortably short."
          : "You reached the maximum length of a single response. Continue exactly where you left off.",
      };
      history.push(nudge);
      await persist(nudge, { kind: "nudge" });
      continue;
    }

    /*
     * The model is about to finish, and the person has said something since.
     *
     * Finishing now would answer the old request and leave the new message
     * to start a separate turn, after the context the agent has built is
     * already out of its hands. So what it just said is kept, the message is
     * delivered, and the turn goes on — the same as if it had arrived between
     * two tool calls.
     */
    /*
     * Anything said since, before finishing.
     *
     * Checked here and again before every later step of finishing —
     * verification, tests, review, the final answer — because each can take a
     * while, and a message that arrived during one used to be left for a new
     * turn after this one ended: sent to a working agent, and not read by it.
     */
    const deliverLateMessages = async (): Promise<boolean> => {
      const late = options.controls?.takeMessages?.() ?? [];
      if (late.length === 0) return false;
      const said: LLMMessage = { role: "assistant", content: currentTurnText, ...reasoningFor(currentReasoning, currentThinking) };
      history.push(said);
      await persist(said, { kind: "response", ...reasoningMeta });
      await deliverInterjections(late);
      return true;
    };

    if (await deliverLateMessages()) continue;

    /*
     * A message the answer passed over.
     *
     * Once per message: the model is shown it again and asked to act on it or
     * say in a line why it needs nothing. A reply that still takes no step
     * ends the turn as before, so this cannot loop.
     */
    // Set inside deliverInterjections, which TypeScript's narrowing cannot see.
    const passedOver = unacted as { text: string; reminded: boolean } | null;
    if (passedOver && !passedOver.reminded && !addresses(currentTurnText, passedOver.text)) {
      passedOver.reminded = true;
      if (draft) {
        // Mid-check: the summary stands as said, the check's reply is dropped, and the next summary is checked again.
        const factsAt = history.lastIndexOf(draft.facts);
        if (factsAt >= 0) history.splice(factsAt, 1);
        await flushDraft();
        ledgerDelivered = false;
      } else {
        const said: LLMMessage = { role: "assistant", content: currentTurnText, ...reasoningFor(currentReasoning, currentThinking) };
        history.push(said);
        await persist(said, { kind: "response", ...reasoningMeta });
      }
      const reminder: LLMMessage = {
        role: "user",
        content:
          `Before you finish: the person wrote "${passedOver.text.slice(0, 600)}" while you were working, ` +
          "and no step since has acted on it. Do what it asks now. If it truly needs nothing more, " +
          "say so in one sentence.",
      };
      history.push(reminder);
      await persist(reminder, { kind: "nudge", displayOnly: true });
      continue;
    }

    /*
     * Is the plan finished?
     *
     * Asked of something the loop actually knows — the model's own plan —
     * rather than guessed from the prose. Every item must be completed, or
     * marked failed with a reason, before the turn ends: a plan is the agent's
     * own statement of what the request takes, so an item still open is work
     * not done. The prompt keeps suggestions for later off the plan.
     *
     * A few reminders, not unlimited ones, so a model that cannot or will not
     * update its list cannot hold a turn open for ever. Not in plan mode,
     * where an open plan is the deliverable.
     */
    const unfinished = todoItems.filter((t) => t.status === "pending" || t.status === "in_progress");

    if (mode !== "plan" && unfinished.length > 0 && planNudges < MAX_PLAN_NUDGES) {
      planNudges++;
      const stopped: LLMMessage = { role: "assistant", content: currentTurnText, ...reasoningFor(currentReasoning, currentThinking) };
      history.push(stopped);
      await persist(stopped, { kind: "response", ...reasoningMeta });
      const nudge: LLMMessage = {
        role: "user",
        content:
          `Your plan still has ${unfinished.length} unfinished item(s): ` +
          unfinished.map((t) => `"${t.title}" (${t.status})`).join(", ") +
          ". The task is not finished until every item on your plan is completed. Carry on with them now. " +
          "If an item is already done, mark it completed. If one turns out to be unnecessary, or cannot be " +
          "done because of something outside your control, mark it failed with update_todo_list and say why " +
          "in your summary. Do not finish with anything left pending or in progress.",
      };
      history.push(nudge);
      await persist(nudge, { kind: "nudge" });
      continue;
    }

    if (await deliverLateMessages()) continue;

    /*
     * Verify before claiming to be done.
     *
     * At exactly one moment — the model believes it has finished and has
     * touched real source. Failures come back as evidence, not as orders.
     */
    if (modifiedFiles.length > 0 && writeCount !== writesAtLastVerify && healAttempts < maxHealAttempts) {
      const verification = await SelfHealer.verifyCodeIntegrity(
        workspaceId,
        sandboxRunner,
        modifiedFiles,
      );

      const verifyCallId = `verify_${iteration}`;
      const verifyOutput = verification.passed
        ? verification.output
        : (verification.diagnostics ?? []).join("\n");
      await emit({
        type: "tool_call",
        sessionId,
        callId: verifyCallId,
        tool: "verify_changes",
        input: { files: modifiedFiles },
      });
      await emit({
        type: "tool_result",
        sessionId,
        callId: verifyCallId,
        tool: "verify_changes",
        output: verifyOutput,
        success: verification.passed,
      });
      // Stored for the transcript. The model never made this call, so it is
      // never sent back to it.
      await persist(
        { role: "assistant", content: "", toolCalls: [{ id: verifyCallId, name: "verify_changes", input: { files: [...modifiedFiles] } }] },
        { kind: "response", displayOnly: true },
      );
      await persist(
        { role: "tool", toolCallId: verifyCallId, content: String(verifyOutput ?? "") },
        { kind: "tool_result", toolName: "verify_changes", success: verification.passed, displayOnly: true },
      );

      ledger.recordCheck({
        kind: "typecheck",
        detail: verification.passed
          ? "the project's own check passed"
          : String(verifyOutput ?? "").split("\n").filter(Boolean)[0] ?? "failed",
        passed: verification.passed,
      });

      if (verification.passed) writesAtLastVerify = writeCount;

      if (!verification.passed) {
        healAttempts++;
        const said: LLMMessage = { role: "assistant", content: currentTurnText, ...reasoningFor(currentReasoning, currentThinking) };
        history.push(said);
        await persist(said, { kind: "response", ...reasoningMeta });
        const feedback: LLMMessage = { role: "user", content: SelfHealer.feedbackFor(verification) };
        history.push(feedback);
        await persist(feedback, { kind: "nudge" });
        continue;
      }

      /*
       * The tests that cover the change, at the effort tiers that ask for
       * them. After the typecheck and not instead of it, and only the
       * *affected* tests.
       */
      if (await deliverLateMessages()) continue;

      if (effortSpec?.runAffectedTests && !testedAfterChanges) {
        testedAfterChanges = true;
        const tests = await runAffectedTests(sandboxRunner, workspaceId, modifiedFiles);

        if (tests.ran) {
          const testCallId = `tests_${iteration}`;
          const testOutput = tests.passed ? `${tests.files.length} test file(s) passed.` : tests.output;
          await emit({
            type: "tool_call",
            sessionId,
            callId: testCallId,
            tool: "run_affected_tests",
            input: { files: tests.files },
          });
          await emit({
            type: "tool_result",
            sessionId,
            callId: testCallId,
            tool: "run_affected_tests",
            output: testOutput,
            success: tests.passed,
          });
          await persist(
            { role: "assistant", content: "", toolCalls: [{ id: testCallId, name: "run_affected_tests", input: { files: tests.files } }] },
            { kind: "response", displayOnly: true },
          );
          await persist(
            { role: "tool", toolCallId: testCallId, content: testOutput },
            { kind: "tool_result", toolName: "run_affected_tests", success: tests.passed, displayOnly: true },
          );
        }

        if (tests.ran) {
          ledger.recordCheck({
            kind: "affected tests",
            detail: tests.passed
              ? `${tests.files.length} test file(s) passed`
              : String(tests.output ?? "").split("\n").filter(Boolean).slice(-1)[0] ?? "failed",
            passed: tests.passed,
          });
        }

        if (tests.ran && !tests.passed && healAttempts < maxHealAttempts) {
          healAttempts++;
          const said: LLMMessage = { role: "assistant", content: currentTurnText, ...reasoningFor(currentReasoning, currentThinking) };
          history.push(said);
          await persist(said, { kind: "response", ...reasoningMeta });
          const feedback: LLMMessage = { role: "user", content: testFeedback(tests) };
          history.push(feedback);
          await persist(feedback, { kind: "nudge" });
          continue;
        }
      }
    }

    /*
     * A second opinion on the diff, once.
     *
     * A fresh call given the request and the final diff and nothing else. Once
     * and only once: a review of the fix produced in response to a review is
     * how a turn stops terminating.
     */
    if (await deliverLateMessages()) continue;

    if (effortSpec?.selfReviewDiff && !reviewed && modifiedFiles.length > 0) {
      reviewed = true;
      const diff = await diffSinceCheckpoint(
        sandboxRunner,
        workspaceId,
        checkpoint?.id ?? null,
      );
      review = await reviewOwnDiff({
        runner: sandboxRunner,
        workspaceId,
        llmProvider,
        model: options.model,
        request:
          typeof userMessage === "string"
            ? userMessage
            : (userMessage.find((b) => b.type === "text")?.text ?? ""),
        diff,
        signal,
      });

      if (review.ran) {
        ledger.recordCheck({
          kind: "self-review",
          detail: review.clean ? "no blocking issues found in the diff" : "issues found and addressed",
          passed: review.clean,
        });
      }

      if (review.ran && !review.clean) {
        const said: LLMMessage = { role: "assistant", content: currentTurnText, ...reasoningFor(currentReasoning, currentThinking) };
        history.push(said);
        await persist(said, { kind: "response", ...reasoningMeta });
        const feedback: LLMMessage = { role: "user", content: reviewFeedback(review) };
        history.push(feedback);
        await persist(feedback, { kind: "nudge" });
        continue;
      }
    }

    if (await deliverLateMessages()) continue;

    /*
     * Nothing finishes while a specialist is still working.
     *
     * A sub-agent's answer is part of this turn's work, so a turn that ended
     * with one in flight would be reporting on a job half of which is still
     * running — and the surface would then show a completed turn whose panel
     * had a spinner in it. Waiting here is the one place it is cheap: the
     * parent has already decided it is done.
     *
     * Until the next one finishes, not all of them: each report is handed
     * over at the top of the step as it comes, so the work it changes is done
     * then rather than after the slowest specialist. A message from the
     * person ends the wait too, so it is read when it is sent.
     */
    if (subagents.anyRunning() || subagents.hasUnread()) {
      if (!subagents.hasUnread()) {
        const message = whenUrgent(() => options.controls?.pendingMessages?.() ?? 0, signal);
        await Promise.race([subagents.waitForAny(), message.promise]);
        message.cancel();
        throwIfCancelled(signal);
      }
      if (subagents.hasUnread() || (options.controls?.pendingMessages?.() ?? 0) > 0) {
        const said: LLMMessage = {
          role: "assistant",
          content: currentTurnText,
          ...reasoningFor(currentReasoning, currentThinking),
        };
        history.push(said);
        await persist(said, { kind: "response", ...reasoningMeta });
        continue;
      }
    }

    /*
     * The facts, before the summary that describes them.
     *
     * Once per turn, and only for a turn that changed a file. The model is
     * shown what its own tool calls actually did, and writes its closing
     * summary from that rather than from a memory several compactions old.
     *
     * The gate is deliberately `touchedFiles` and not "did anything at all".
     * This costs one model round trip, and it is worth paying exactly where a
     * false claim costs the user something — a turn that reports an edit it
     * did not make, or tests that never ran. A turn that only read and
     * answered has nothing to misreport, so it pays nothing.
     */
    if (!ledgerDelivered && ledger.touchedFiles()) {
      ledgerDelivered = true;
      const said: LLMMessage = {
        role: "assistant",
        content: currentTurnText,
        ...reasoningFor(currentReasoning, currentThinking),
      };
      history.push(said);

      const facts: LLMMessage = {
        role: "user",
        content:
          "Before you finish: this is the record of what your tool calls actually did this turn. " +
          "It is the whole record — anything absent from it did not happen.\n\n" +
          `<turn-record>\n${ledger.render()}\n</turn-record>\n\n` +
          "Check the summary you just wrote against this record. If something the request asked for is " +
          "missing from the record, it is unfinished — go and do it now. Otherwise, if every claim in " +
          `your summary is supported by the record, reply with exactly ${VERIFIED} and nothing else. ` +
          "If a claim is wrong or a check it mentions never ran, reply with only a short correction " +
          'starting "Correction:" — do not write the summary again; the person has already read it.',
      };
      history.push(facts);
      await persist(facts, { kind: "nudge", displayOnly: true });
      draft = { message: said, meta: reasoningMeta, facts };
      continue;
    }

    // Completed turn
    let finalReasoningMeta = reasoningMeta;
    let finalReasoning = currentReasoning;
    let finalThinking = currentThinking;
    if (draft) {
      /*
       * The check came back. The draft is the summary; a correction, if the
       * check found one, is added under it — and shown, because nothing of
       * the checking pass was. The draft and the record leave the history
       * here: what stays is the one summary as the person read it.
       */
      const checked = draft;
      draft = null;
      const { correction } = readSummaryCheck(String(checked.message.content ?? ""), currentTurnText);
      /*
       * The reading mark must not sit on messages about to leave.
       *
       * A read ahead that ran during the check read up to its messages; with
       * them gone the mark would not be found next turn, and everything since
       * the last cut would be read again. Wait for any read, then put the mark
       * back on the last stored message before the summary.
       */
      await engine.settle();
      const draftAt = history.lastIndexOf(checked.message);
      if (draftAt > 0 && unreadFrom(history, engine.store.state.extractedThrough) > draftAt) {
        engine.store.markExtracted(markThrough(history, 0, draftAt, engine.store.state.step));
      }
      if (correction) await emit({ type: "token", sessionId, delta: `\n\n${correction}` });
      finalResponseText = [String(checked.message.content ?? "").trim(), correction].filter(Boolean).join("\n\n");
      for (const m of [checked.message, checked.facts]) {
        const at = history.lastIndexOf(m);
        if (at >= 0) history.splice(at, 1);
      }
      finalReasoningMeta = checked.meta;
      finalReasoning = checked.message.reasoningContent ?? "";
      finalThinking = checked.message.thinkingBlocks ?? [];
    } else {
      finalResponseText =
        currentTurnText.trim() ||
        "The model ended this turn without a reply, even after being asked to continue. " +
          "Everything done so far is saved; send a message to carry on.";
    }
    const finalMessage: LLMMessage = {
      role: "assistant",
      content: finalResponseText,
      ...reasoningFor(finalReasoning, finalThinking),
    };
    history.push(finalMessage);
    await persist(finalMessage, {
      kind: "final",
      ...finalReasoningMeta,
      ...(checkpoint && modifiedFiles.length > 0
        ? { checkpoint: { id: checkpoint.id, changedFiles: [...modifiedFiles] } }
        : {}),
    });

    // Record session in episodic memory for future turns
    if (modifiedFiles.length > 0 || toolCallsExecuted > 0) {
      const userGoalStr =
        typeof userMessage === "string"
          ? userMessage
          : (userMessage.find((b) => b.type === "text")?.text ?? "Multi-modal task");

      await MemoryManager.recordEpisodicMemory(workspaceId, sandboxRunner, {
        sessionId,
        timestamp: new Date().toISOString(),
        userGoal: userGoalStr,
        summary: finalResponseText.slice(0, 300),
        filesModified: modifiedFiles,
        keyDecisions: [],
      });
    }

    await emit({
      type: "complete",
      sessionId,
      summary: finalResponseText,
      ...(checkpoint ? { checkpointId: checkpoint.id, changedFiles: modifiedFiles } : {}),
      ...(checkpointUnavailable ? { checkpointUnavailable } : {}),
    });

    /*
     * What the turn established, if the agent did not save it itself.
     *
     * After `complete`, and not awaited: the reply is already the person's,
     * and the next message never waits on this. Only the lead agent's turns,
     * since a sub-agent's work is reported to the lead, which decides.
     */
    const ledgerNow = ledger.snapshot();
    if (
      memory &&
      depth === 0 &&
      !rememberedThisTurn &&
      worthExtracting({
        request: label,
        toolCalls: toolCallsExecuted,
        commands: ledgerNow.commands.length,
        filesChanged: ledgerNow.created.length + ledgerNow.modified.length,
        commandLines: ledgerNow.commands.map((c) => c.command),
        storeKey: memory.key,
      })
    ) {
      void extractMemories({
        provider: llmProvider,
        model: options.model,
        store: memory,
        request: label,
        record: ledger.render(),
        reply: finalResponseText,
      })
        .then((names) => {
          if (names.length === 0) return undefined;
          noteExtracted(memory.key);
          return emit({ type: "memory_saved", sessionId, names });
        })
        .catch(() => undefined);
    }

    break;
  }

  /*
   * Running out of iterations is not success — and, now that only a caller
   * can impose a limit, it is said on the stream as well as in the result.
   */
  if (iteration >= maxIterations && !finalResponseText) {
    stopReasonForTurn = "max_iterations";
    finalResponseText =
      `Stopped after ${maxIterations} steps without reaching a conclusion. ` +
      "Any completed work is saved; send another message to continue from here.";
  }

  if (stopReasonForTurn === "max_iterations" || stopReasonForTurn === "token_budget_exhausted") {
    await flushDraft();
    await emit({ type: "error", sessionId, code: "TURN_STOPPED", message: finalResponseText });
    await persist(
      { role: "assistant", content: "" },
      { kind: "turn_end", displayOnly: true, status: "stopped", error: finalResponseText },
    );
  }

  } catch (err: unknown) {
    // A summary the person already read survives a stop or a crash during its check.
    await flushDraft().catch(() => undefined);
    if (err instanceof TurnCancelledError) {
      stopReasonForTurn = "cancelled";
      finalResponseText =
        finalResponseText ||
        "Stopped at your request. Everything completed up to this point is saved.";
      await emit({
        type: "error",
        sessionId,
        code: "CANCELLED",
        message: "The turn was cancelled.",
      });
      await persist({ role: "assistant", content: "" }, { kind: "turn_end", displayOnly: true, status: "cancelled" });
    } else {
      /*
       * A crash must not take the work with it.
       *
       * The turn failed; that is reported. What it did before failing is
       * still true — including the checkpoint id that undoes it — and is
       * returned so a caller can show it, save it, or roll it back.
       */
      stopReasonForTurn = "failed";
      const message = err instanceof Error ? err.message : String(err);
      finalResponseText =
        finalResponseText ||
        `This turn stopped on an error: ${message}\n\n` +
          (checkpoint
            ? `Any files already changed are still changed. Checkpoint ${checkpoint.id.slice(0, 8)} ` +
              `restores the workspace to how it was before this turn.`
            : "Any files already changed are still changed, and this workspace has no checkpoint to undo them.");

      await emit({ type: "error", sessionId, code: "TURN_FAILED", message });
      await persist(
        { role: "assistant", content: "" },
        { kind: "turn_end", displayOnly: true, status: "failed", error: message },
      );
    }
  }

  await Promise.all(auditWrites);
  // A read into task state still running beside the turn lands before the state is saved.
  await engine.settle();
  await engine.persist();

  return {
    sessionId,
    status: stopReasonForTurn === "completed" ? "completed" : "blocked",
    stopReason: stopReasonForTurn,
    finalResponse: finalResponseText,
    replies: [...storedDrafts, finalResponseText].filter((t) => t.trim().length > 0),
    /*
     * Returned without reasoning.
     *
     * It is needed *within* a turn, where a thinking model refuses a tool
     * follow-up that omits it, and never across turns. Carrying it forward
     * would resend every past turn's working-out on every future request.
     */
    history: history.map(withoutReasoning),
    toolCallsExecuted,
    estimatedTokensUsed,
    outputTokens,
    modifiedFiles,
    auditFailures,
    persistFailures,
    mode,
    ...(modeNarrowedFrom ? { modeNarrowedFrom } : {}),
    ...(checkpoint ? { checkpoint } : {}),
    ...(checkpointUnavailable ? { checkpointUnavailable } : {}),
    cache: cache.snapshot(),
    prefixSeal,
    /** What the turn actually did, from its own tool calls. See `turn-ledger.ts`. */
    ledger: ledger.snapshot(),
    ...(subagents.list().length > 0 ? { subagents: subagents.list() } : {}),
    ...(review ? { review } : {}),
    // In plan mode the plan *is* the answer, so it is returned as a first-class
    // field rather than left for the caller to scrape out of the prose.
    ...(mode === "plan" && todoItems.length > 0
      ? { plan: { steps: todoItems.map((t) => ({ ...t })), rationale: finalResponseText } }
      : {}),
  };
}
