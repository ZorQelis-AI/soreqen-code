/**
 * SoreQen Code Orchestrator Types & Interfaces
 * Production-Grade V2 Specification (Multi-Modal Image & Sub-Agent Swarms)
 */

import type {
  AgentMode,
  Effort,
  SubagentInfo,
  OutputStyle,
  PermissionTier,
  ReasoningLevel,
  StreamEvent,
  TodoItem,
  ToolName,
} from "@sqcode/shared";
import type { SandboxRunner } from "@sqcode/sandbox-runner";
import type { RoutingPolicy } from "./model-router.js";
import type { Checkpoint } from "./checkpoint.js";
import type { CacheStats } from "./tool-cache.js";
import type { ReviewVerdict } from "./self-review.js";
import type { PrefixSeal } from "./prefix-cache.js";
import type { RepoMap } from "./repo-map.js";
import type { TurnLedgerSnapshot } from "./turn-ledger.js";
import type { SkillOptions } from "./skills/index.js";
import type { ExternalTools } from "./external-tools.js";

export interface LLMToolCall {
  id: string;
  name: ToolName | string;
  input: Record<string, unknown>;
}

export interface LLMMessage {
  role: "user" | "assistant" | "system" | "tool";
  content: string | LLMContentBlock[];
  toolCallId?: string;
  toolCalls?: LLMToolCall[];
  /**
   * What a thinking model reasoned before this assistant message.
   *
   * Not decoration. DeepSeek's thinking mode *refuses* a tool-call follow-up
   * whose preceding assistant message arrives without it — "The
   * `reasoning_content` in the thinking mode must be passed back to the API"
   * — so dropping it, which every provider here did, broke the second step of
   * every tool-using turn on that model. Earlier turns may omit it; the
   * current turn's may not.
   */
  reasoningContent?: string;
  /**
   * Claude's thinking before this assistant message, exactly as it came:
   * the summarised text and the signature that carries the real reasoning.
   *
   * Sent back unchanged on the next request, or the model reasons each step
   * from nothing — and a signature is checked against the conversation that
   * produced it, so these are never edited, only kept or dropped whole. Other
   * providers ignore them; `reasoningContent` holds the same text for them.
   */
  thinkingBlocks?: ThinkingBlock[];
  /**
   * This message is the working set, rebuilt every step and never stored.
   *
   * A provider that can send it in a role that does not end the user's turn
   * should. Measured on GPT 6 Luna with reasoning on, 24 Sep 2026: sent as a
   * trailing *user* message it froze OpenAI's prompt cache at the system
   * prompt, and every step paid full price for the whole conversation; as a
   * trailing *developer* message the cache grew with the conversation.
   */
  frame?: boolean;
  /**
   * The id this message was stored under, when the caller stores messages.
   *
   * Never sent to a model. It is how a condensed history records which stored
   * messages its summary replaced, so the next turn can load the summary and
   * what came after it instead of the whole session again.
   */
  id?: string;
  /**
   * A user-role message the loop wrote itself — a nudge, a verification
   * result, a reminder — rather than the person.
   *
   * Never sent as a field. Without it, every reader of history took these
   * for the person's words: a session whose first request had been condensed
   * away got "You reached the maximum length of a single response" as its
   * goal (30 Sep 2026), and the loop's "do not"s were extracted as the
   * person's constraints.
   */
  fromLoop?: boolean;
}

/**
 * What a caller is told about a message the turn added, beyond the message.
 *
 * The message itself is exactly what the model sees. Everything a transcript
 * needs to *show* it faithfully after a reload — the reasoning behind it, the
 * diff an edit produced, whether a call was refused — is carried here, so a
 * stored session reads back the way it looked live.
 */
/**
 * What the person can do to a turn while it runs, other than stop it.
 *
 * Read by the loop at the start of every step, so each takes effect at the
 * next point where acting on it cannot corrupt the work in progress — never
 * mid-response, never between a tool call and its result.
 */
export interface TurnControls {
  /**
   * Messages sent since the last call, oldest first. Taking them removes them.
   *
   * Absent where nobody can send any — a `--print` run, a script. That is
   * also what tells `ask_user` there is nobody to ask, instead of leaving it
   * waiting on a channel nothing will ever write to.
   */
  takeMessages?(): { id: string; text: string }[];
  /** Whether a compaction was asked for since the last call. */
  takeCompactRequest(): boolean;
  /** The auto-compaction setting now in force. See `context-window.ts`. */
  autoCompact(): number | null | undefined;
  /**
   * How many messages are waiting, without taking them. Lets the loop set
   * aside a response that has barely started, and a `wait` end early, so a
   * message is read when it is sent rather than when the current step ends.
   */
  pendingMessages?(): number;
  /**
   * How many of those the person chose to send now. Each one interrupts
   * the step under way: a response being written is cut short (what it said
   * so far is kept), a command running in the foreground carries on in the
   * background, and a sub-agent being waited on is left running.
   */
  urgentMessages?(): number;
  /**
   * Background commands that ended since the last call, each with a note to
   * show the model, and takes them. See `process-notices.ts` in the gateway.
   */
  takeNotices?(): { processId: string; text: string }[];
  /** How many of those are waiting, without taking them: a `wait` ends when there are some. */
  noticesWaiting?(): number;
}

export interface MessageMeta {
  kind?: "response" | "final" | "nudge" | "tool_result" | "compaction" | "turn_end" | "interjection" | "answer";
  /** On an interjection: what the person actually typed. */
  text?: string;
  /** The reasoning behind an assistant message. */
  reasoning?: string;
  /** How long the model reasoned before this message, in milliseconds. */
  thinkingMs?: number;
  toolName?: string;
  success?: boolean;
  /** The call was refused by policy or by the user. */
  denied?: boolean;
  /** The call was set aside before it ran, to be made again; see `ToolResultEvent.deferred`. */
  deferred?: boolean;
  diff?: { path: string; unifiedDiff: string };
  /** Shown in a transcript, never sent back to a model: verification steps
   *  the loop ran itself, and how a turn ended. */
  displayOnly?: boolean;
  /** On a compaction summary: the stored id of the last message it replaces. */
  coversThroughId?: string;
  /**
   * On an assistant message from Claude: its thinking blocks, verbatim, so the
   * next turn can send them back. See `LLMMessage.thinkingBlocks`.
   */
  thinkingBlocks?: ThinkingBlock[];
  /** On a turn's final message: the checkpoint that undoes the turn. */
  checkpoint?: { id: string; changedFiles: string[] };
  /** On a turn ending that was not a completion. */
  status?: "cancelled" | "failed" | "stopped";
  error?: string;
}

/** A thinking block from Claude's Messages API, kept verbatim for replay. */
export type ThinkingBlock =
  | { type: "thinking"; thinking: string; signature: string }
  | { type: "redacted_thinking"; data: string };

export type LLMContentBlock =
  | { type: "text"; text: string }
  | { type: "image"; image_data: string; media_type?: string }
  | { type: "tool_use"; id: string; name: string; input: Record<string, unknown> }
  | { type: "tool_result"; tool_use_id: string; content: string; is_error?: boolean };

export interface LLMChatOptions {
  model?: string;
  system: string;
  messages: LLMMessage[];
  tools?: Array<{
    name: string;
    description: string;
    input_schema: {
      type: "object";
      properties: Record<string, unknown>;
      required: string[];
    };
  }>;
  maxTokens?: number;
  temperature?: number;
  /** How much a thinking model should reason. See `ReasoningLevel`. Providers
   *  that cannot control it ignore it. */
  reasoning?: ReasoningLevel;
  /**
   * Index of the last message in the stable, cacheable conversation prefix.
   *
   * Providers that support explicit prefix caching place a breakpoint after
   * this message; providers that do not ignore it. See `prefix-cache.ts` for
   * how the index is chosen and why compaction has to cooperate for it to mean
   * anything.
   */
  cacheBreakpointIndex?: number | null;
  /**
   * Which conversation this request belongs to, for providers that route by it.
   *
   * OpenAI keeps a cached prefix on one server and routes by a hash of the
   * prompt's start, which every session shares: measured on 24 Sep 2026, half
   * the steps of one session landed where its conversation was not cached and
   * paid for all of it again. Sent as `prompt_cache_key`, the session's
   * requests go to the same place. Providers without such a field ignore it.
   */
  cacheKey?: string;
  /** Aborts the request in flight. Providers pass it to their HTTP client, so
   *  a cancelled turn stops paying for tokens it will never show anyone. */
  signal?: AbortSignal;
  /**
   * What kind of step this request is, for SoreQen Auto: it picks a cheap
   * model for routine work (summaries, sub-agents) and a stronger one to plan
   * or review. Sent only to SoreQen's hosted models; everyone else ignores it.
   */
  step?: LLMStep;
  /** How many tries this turn has struggled (repeated itself, came back empty): Auto climbs a rung every two. */
  failures?: number;
}

export type LLMStep = "main" | "plan" | "review" | "summary" | "title" | "compact" | "subagent";

export type LLMResponseChunk =
  | { type: "token"; text: string }
  /** Reasoning a thinking model streams before (or between) its answer. */
  | { type: "reasoning"; text: string }
  /** A finished thinking block, signature and all, to send back next step. See `LLMMessage.thinkingBlocks`. */
  | { type: "thinking_block"; block: ThinkingBlock }
  /** `index` is the call's position in the response, where the endpoint
   *  reports one. Ids can change after the first chunk; positions cannot. */
  | { type: "tool_call_start"; id: string; name: string; index?: number }
  | { type: "tool_call_delta"; id: string; inputDelta: string; index?: number }
  | {
      type: "tool_call_complete";
      id: string;
      name: string;
      input: Record<string, unknown>;
      /** Arguments that could not be read: what arrived, and why not (see `call-arguments.ts`). */
      malformed?: { raw: string; error: string };
    }
  /**
   * The model wrote something shaped like a tool call into its answer, and it
   * could not be read as one. It did not run; see `text-tool-calls.ts`.
   */
  | { type: "malformed_tool_call"; raw: string }
  /** The request went to another model because the chosen one was overloaded. */
  | { type: "model_fallback"; from: string; to: string; reason: string }
  /**
   * What the provider says the request cost: input tokens, how many of them it
   * served from its prompt cache, and output. The only way to know caching
   * works on a provider is its own count; reasoning about prefixes is not it.
   */
  | { type: "usage"; inputTokens: number; cachedTokens: number; outputTokens?: number }
  | { type: "stop"; reason: "end_turn" | "tool_use" | "max_tokens" | "stop_sequence" };

export interface LLMProvider {
  name: string;
  chatStream(options: LLMChatOptions): AsyncIterable<LLMResponseChunk>;
}

/** Settings > General: the person's profile and standing instructions. */
export interface PersonalSettings {
  /** What to call them. */
  name?: string;
  /** What they do: "backend engineer", "student", "founder". */
  role?: string;
  /** Anything else they want known about them. */
  about?: string;
  /** How they want the agent to work, every session, every project. */
  instructions?: string;
  /** The language replies are written in, when not the one they write in. */
  replyLanguage?: string;
}

export interface AgentRuntimeContext {
  workspaceId: string;
  sessionId: string;
  permissionTier: PermissionTier;
  /** The mode the user selected. Shapes the prompt as well as the tier: plan
   *  mode gets an obligation the other three do not have. */
  mode?: AgentMode;
  effort?: Effort;
  outputStyle?: OutputStyle;
  /** Whether the workspace could be snapshotted. Told to the agent because it
   *  changes what auto mode will and will not ask about. */
  checkpointAvailable?: boolean;
  /** A map built by the caller. Supplied so the loop can build it
   *  concurrently with the checkpoint instead of serialising two independent
   *  pieces of I/O in front of the first model call. */
  repoMap?: RepoMap;
  relevantOpenFiles?: string[];
  projectConventions?: string;
  /** Where the agent keeps files it makes for itself, relative to the workspace. */
  scratchpadDir?: string;
  /** Where `.soreqen/` really is, when the workspace keeps it outside the project. */
  soreqenDir?: string;
  /** The SOREQEN SKILLS section, rendered from the session's skill set. */
  skillsPrompt?: string;
  /**
   * Whether this turn can hand work to a sub-agent: false below Max effort
   * and inside a sub-agent. The tools and their guidance are left out then,
   * rather than offered and refused. Unset counts as true.
   */
  canDelegate?: boolean;
}

export interface AgentTurnOptions {
  workspaceId: string;
  sessionId: string;
  /**
   * The mode the session is in.
   *
   * Preferred over `permissionTier`, which is retained for callers that only
   * know about tiers. When both are given, `permissionTier` is treated as the
   * workspace's ceiling and the mode is clamped against it — never the other
   * way round, because a mode is a client preference and a tier is a
   * server-side fact.
   */
  mode?: AgentMode;
  /** Reasoning effort. Sets how much the model reasons, how the agent is told
   *  to work, heal budgets, and self-review and affected tests at the higher
   *  tiers. */
  effort?: Effort;
  /** How the agent communicates. See `output-style.ts`. */
  outputStyle?: OutputStyle;
  /**
   * Who the person is and how they want the agent to work, from the host's
   * Settings > General: their own words, so trusted as the person's. See
   * `personalSection`.
   */
  personal?: PersonalSettings;
  /** Messages, compaction requests and settings arriving while the turn runs. */
  controls?: TurnControls;
  /**
   * `schedule_wakeup`: the host keeps the schedule and starts the session
   * again when it is due. Absent where nothing can (the CLI), and then the
   * tool is not offered.
   */
  onScheduleWakeup?: (input: Record<string, unknown>) => Promise<import("@sqcode/tools").ToolResult> | import("@sqcode/tools").ToolResult;
  /** Model routing policy. Disabled by default; see `model-router.ts`. */
  routing?: RoutingPolicy;
  /**
   * The cacheable conversation prefix carried over from the previous turn.
   *
   * Pass back what the previous turn returned. Omitting it is safe and simply
   * forfeits cross-turn prefix caching — the request is identical either way,
   * only its price differs.
   */
  prefixSeal?: PrefixSeal | null;
  permissionTier?: PermissionTier;
  userMessage: string | LLMContentBlock[];
  history?: LLMMessage[];
  /**
   * A plan left unfinished when an earlier turn was stopped. It is shown again
   * and held to again: the turn does not end with its items still open, just as
   * if the model had written it this turn.
   */
  plan?: TodoItem[];
  sandboxRunner: SandboxRunner;
  llmProvider: LLMProvider;
  /** Model id, used to size the context budget. Falls back to a small,
   *  conservative window when absent. */
  model?: string;
  /** Reserved for the model's reply when computing the history budget. */
  maxOutputTokens?: number;
  /**
   * Hard ceiling on estimated tokens for the whole turn.
   *
   * Checked *before* each request rather than after, so the guard cannot be
   * tripped by the very call it was meant to prevent. Absent means unlimited,
   * which is the right default for a CLI spending the user's own key and the
   * wrong one for the hosted surface.
   */
  maxTurnTokens?: number;
  /**
   * Loop passes allowed. Unset means no limit, which is the default for every
   * surface: a turn runs until the work is done, the user stops it, or it
   * genuinely cannot continue. Set only by harnesses that need a bound.
   */
  maxIterations?: number;
  /** Delegation depth. 0 is the user-facing turn; each sub-agent is one
   *  deeper. Passed explicitly rather than inferred, so the guard is a real
   *  check and not an accident of which callbacks were wired up. */
  depth?: number;
  /**
   * Stops the turn.
   *
   * Checked at every point where the loop is about to spend money or touch the
   * workspace: the top of each pass, before the model call, between streamed
   * chunks, and before any tool runs. A cancelled turn returns normally with
   * `stopReason: "cancelled"` and its history intact — it is a correct
   * outcome, not a failure.
   */
  signal?: AbortSignal;
  /**
   * How long a model response may send nothing before it is treated as
   * stalled, closed, and retried. Five minutes unless set.
   */
  streamIdleMs?: number;
  /**
   * Custom retry schedule in milliseconds for transient model failures.
   * If omitted, defaults to MODEL_RETRY_SCHEDULE_MS.
   */
  retryScheduleMs?: readonly number[];
  /**
   * The session a person is watching, when this turn is a sub-agent's.
   *
   * Commands a sub-agent starts are shown in that session, and it shares that
   * session's scratchpad. Absent for a top-level turn, which is its own root.
   */
  rootSessionId?: string;
  onEvent?: (event: StreamEvent) => void | Promise<void>;
  /**
   * Every message the turn adds to the conversation, in order, as it is added.
   *
   * The durable record of a turn. Events are for watching it live and are
   * lossy by design — a reload drops whatever was emitted in between. Storing
   * what this receives gives back exactly the conversation the model had:
   * its text between tool calls, its reasoning, each call's result and diff,
   * the loop's own nudges, and summaries that replaced earlier context.
   *
   * Return the stored id, when there is one; it is recorded on the message.
   * A failure to store is counted in `persistFailures` and never ends a turn.
   */
  onMessage?: (message: LLMMessage, meta: MessageMeta) => Promise<string | void> | string | void;
  /**
   * Which skills are on, and the person's own. Absent: SoreQen's 24, all on.
   * See `skills/index.ts`.
   */
  skills?: SkillOptions;
  /**
   * Tools from MCP servers the host connected. Absent: none. See
   * `external-tools.ts`.
   */
  externalTools?: ExternalTools;
  /** Memory kept between sessions, about the person and this project. Absent: none. See `memory.ts`. */
  memory?: import("./memory.js").MemoryStore;
  onAwaitConfirmation?: (confirmation: {
    confirmationId: string;
    toolCall: LLMToolCall;
    action: string;
    description: string;
  }) => Promise<boolean>;
}

export interface AgentTurnResult {
  sessionId: string;
  status: "completed" | "failed" | "blocked";
  /** Why the turn ended. `completed` is the only one that means the agent
   *  decided it was finished; the others mean a limit decided for it. */
  stopReason: "completed" | "max_iterations" | "token_budget_exhausted" | "cancelled" | "failed";
  finalResponse: string;
  /**
   * Every reply the person saw this turn, in order, ending with the final
   * one. A summary written before the turn record (see `draft` in the loop)
   * is stored on its own when the check sends the model back to work, and so
   * is not in `finalResponse`. A status line in it — a goal's
   * `[goal: achieved]` — was lost with it (13 Nov 2026).
   */
  replies?: string[];
  history: LLMMessage[];
  toolCallsExecuted: number;
  /** Estimated tokens sent across the turn, including any sub-agents it
   *  spawned. For budgeting and display only — provider-reported usage is the
   *  billing figure. */
  estimatedTokensUsed: number;
  /** Estimated tokens the model wrote across the turn — replies, reasoning and
   *  tool calls — including any sub-agents'. What a person sees as the turn's
   *  output. */
  outputTokens: number;
  /** Workspace-relative paths this turn wrote to. Reported by the turn that
   *  made the changes, rather than reconstructed from its transcript. */
  modifiedFiles: string[];
  /**
   * Audit records that could not be persisted.
   *
   * Surfaced rather than swallowed. Non-zero means the turn ran but its trail
   * is incomplete — which a caller storing compliance evidence needs to know,
   * and which the previous bare `catch {}` made impossible to discover.
   */
  auditFailures: number;
  /** Messages `onMessage` failed to store. Non-zero means a reload of this
   *  session will not show everything this turn did. */
  persistFailures: number;
  /** The mode the turn ran in, after clamping against the workspace tier. */
  mode: AgentMode;
  /**
   * The mode that was *asked* for, when clamping produced a different one.
   *
   * Absent whenever the requested mode was honoured, so its presence is
   * exactly the signal "what you selected is not what ran". A surface must
   * report it: a session labelled Bypass that is quietly running Auto is the
   * single most confusing state this product can be in, and it shipped that
   * way because the narrowing was inferable only from behaviour.
   */
  modeNarrowedFrom?: AgentMode;
  /** The checkpoint taken before the turn, when one could be. Pass its id to
   *  `restoreCheckpoint` to undo everything this turn did to the workspace. */
  checkpoint?: Checkpoint;
  /** Present when the workspace could not be snapshotted, with the reason.
   *  Auto mode degrades to asking about changes when this is set. */
  checkpointUnavailable?: string;
  /** Within-turn tool cache activity. */
  cache: CacheStats;
  /**
   * What the turn actually did, compiled from its own tool calls.
   *
   * Returned so a caller can show it beside the model's prose and, where the
   * two disagree, believe this one. See `turn-ledger.ts`.
   */
  ledger?: TurnLedgerSnapshot;
  /** The specialists this turn delegated to, and how each ended. */
  subagents?: SubagentInfo[];
  /** The conversation prefix now sealed for caching. Pass it to the next turn
   *  alongside `history`. Null means the seal was broken and next turn pays
   *  full price for the prefix, which is the correct outcome when keeping it
   *  would have pushed the request out of the context window. */
  prefixSeal: PrefixSeal | null;
  /** The self-review verdict, when the effort tier ran one. */
  review?: ReviewVerdict;
  /** Present in plan mode: the plan the agent produced, which is the
   *  deliverable rather than a side effect. */
  plan?: TurnPlan;
}

/** What plan mode produces instead of changes. */
export interface TurnPlan {
  /** The steps, as the agent posted them via `update_todo_list`. */
  steps: { id: string; title: string; status: string }[];
  /** The agent's prose around the plan. */
  rationale: string;
}
