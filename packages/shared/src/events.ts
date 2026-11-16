/**
 * SoreQen Code Real-Time Event Streaming Protocol
 */

import { z } from "zod";
import { TodoItemSchema } from "./models.js";

export const TokenEventSchema = z.object({
  type: z.literal("token"),
  sessionId: z.string(),
  delta: z.string(),
});
export type TokenEvent = z.infer<typeof TokenEventSchema>;

/**
 * Reasoning streamed by a thinking model.
 *
 * Its own event rather than tokens with a flag, because the two are shown
 * differently and stored differently: an answer is the record of the turn, a
 * model's working-out is context for reading it. A surface that ignores this
 * event loses nothing it depended on — before it existed the reasoning was
 * discarded entirely, and a thinking model looked like one that had hung.
 */
export const ThinkingEventSchema = z.object({
  type: z.literal("thinking"),
  sessionId: z.string(),
  delta: z.string(),
});
export type ThinkingEvent = z.infer<typeof ThinkingEventSchema>;

/**
 * The loop is about to ask the model for its next step.
 *
 * Everything streamed after this — reasoning, text, calls being written —
 * belongs to one model response. A surface needs that boundary for two
 * reasons: to clear a response that failed halfway and is being retried (see
 * `ModelRetryEvent`), and to tell "the model is thinking" apart from "the
 * model is writing a 40 KB file", which look identical from the token stream.
 */
export const StepStartEventSchema = z.object({
  type: z.literal("step_start"),
  sessionId: z.string(),
  step: z.number().int(),
  /** Tokens this turn has sent the model so far, including this step's
   *  request. Estimated, like the context meter. */
  tokens: z.number().int().optional(),
  /** Tokens the model has written this turn — replies, reasoning and tool
   *  calls — before this step. Estimated. */
  outputTokens: z.number().int().optional(),
});
export type StepStartEvent = z.infer<typeof StepStartEventSchema>;

/**
 * The turn's output so far, sub-agents included, between step starts.
 *
 * A sub-agent can work for twenty minutes inside one parent step, and its
 * output used to reach the parent's count only when it finished, so the
 * session's number stood still the whole time. Sent whenever a running
 * sub-agent's own count moves.
 */
export const OutputUsageEventSchema = z.object({
  type: z.literal("output_usage"),
  sessionId: z.string(),
  /** Everything written this turn: the agent's own output and every sub-agent's so far. */
  outputTokens: z.number().int(),
});
export type OutputUsageEvent = z.infer<typeof OutputUsageEventSchema>;

/**
 * A tool call the model is still writing.
 *
 * A `tool_call` event can only be sent once the model has finished streaming
 * the call's arguments — and for `write_file` those arguments are the whole
 * file. Writing a large file took minutes during which the interface still
 * said "Thinking", because nothing else had been announced. This is sent as
 * soon as the call's name is known, and again as its arguments grow, with
 * whatever identifying fields (a path, a command) can already be read.
 *
 * `index` is the call's position within the current step. Call ids are not
 * used, because some endpoints only settle the id after the name.
 */
export const ToolCallPendingEventSchema = z.object({
  type: z.literal("tool_call_pending"),
  sessionId: z.string(),
  index: z.number().int(),
  tool: z.string(),
  /** Fields already readable from the partial arguments: path, command, query, url. */
  preview: z.record(z.string()).optional(),
  /** Size of the arguments streamed so far. */
  bytes: z.number().int().optional(),
});
export type ToolCallPendingEvent = z.infer<typeof ToolCallPendingEventSchema>;

/**
 * The model request failed and is being retried.
 *
 * A long autonomous run meets dropped connections, rate limits and upstream
 * 5xx as a matter of course. They used to end the turn. They are now retried
 * with backoff, and a surface is told so it can say "reconnecting" rather than
 * look frozen — and discard whatever the failed attempt had streamed.
 */
export const ModelRetryEventSchema = z.object({
  type: z.literal("model_retry"),
  sessionId: z.string(),
  attempt: z.number().int(),
  delayMs: z.number().int(),
  message: z.string(),
  /**
   * Why. `interjection` and `skill` are not failures: the response was set
   * aside so the agent could read a message the person just sent, or a skill
   * covering the file it was about to write, and a surface should not say
   * "reconnecting" for either.
   */
  reason: z.enum(["error", "overflow", "stall", "interjection", "skill"]).optional(),
});
export type ModelRetryEvent = z.infer<typeof ModelRetryEventSchema>;

/**
 * Another model is answering because the chosen one refused for load. Shown
 * in the transcript, never silent: the person picked a model.
 */
export const ModelFallbackEventSchema = z.object({
  type: z.literal("model_fallback"),
  sessionId: z.string(),
  from: z.string(),
  to: z.string(),
  reason: z.string(),
});
export type ModelFallbackEvent = z.infer<typeof ModelFallbackEventSchema>;

/**
 * The conversation was condensed to fit the model's context window.
 *
 * `summary` means earlier work was replaced by a written summary; `trim` means
 * old tool output was shortened or dropped. Either way the agent keeps going —
 * this is reported because a person reading a long session deserves to know
 * the agent's memory of its start is now a summary.
 */
export const ContextCompactedEventSchema = z.object({
  type: z.literal("context_compacted"),
  sessionId: z.string(),
  /**
   * `checkpoint`: the older messages were extracted into durable task state.
   * `summary`: the fallback, a narrative summary.
   * `unchanged`: a compaction was asked for and there was nothing to condense.
   */
  method: z.enum(["checkpoint", "summary", "trim", "unchanged"]),
  tokensBefore: z.number().int(),
  tokensAfter: z.number().int(),
});
export type ContextCompactedEvent = z.infer<typeof ContextCompactedEventSchema>;

/**
 * A checkpoint asked for between turns, under way: when it began, and how
 * many stretches of conversation it has read, of how many.
 *
 * The session is busy with it, not with a turn. Without saying so, the page
 * took the busy session for the last turn resumed, reopened it, and counted
 * its clock from that turn's start — "150h 56m · Checkpointing" (13 Nov 2026).
 */
export const CheckpointProgressSchema = z.object({
  startedAt: z.number(),
  done: z.number().int(),
  /** Zero while the conversation is still being measured. */
  total: z.number().int(),
});
export type CheckpointProgress = z.infer<typeof CheckpointProgressSchema>;

export const CheckpointProgressEventSchema = CheckpointProgressSchema.extend({
  type: z.literal("checkpoint_progress"),
  sessionId: z.string(),
});
export type CheckpointProgressEvent = z.infer<typeof CheckpointProgressEventSchema>;

export const ContextUsageSchema = z.object({
  /** Everything the next request carries: system prompt, tool schemas, conversation. */
  usedTokens: z.number().int(),
  windowTokens: z.number().int(),
  /** Where automatic compaction begins. */
  compactAtTokens: z.number().int(),
  breakdown: z.object({
    system: z.number().int(),
    tools: z.number().int(),
    messages: z.number().int(),
    /** The part of `messages` that is the compiled working set. */
    workingSet: z.number().int().optional(),
  }),
});
export type ContextUsage = z.infer<typeof ContextUsageSchema>;

/**
 * What the context engine put in front of the model this step, and why.
 *
 * Sent before every model request, beside `context_usage`. Observability
 * only: the shape is the orchestrator's `ContextDebug`, kept loose here so the
 * debug view can grow without a schema change in every package.
 */
export const ContextDebugEventSchema = z.object({
  type: z.literal("context_debug"),
  sessionId: z.string(),
  debug: z.record(z.string(), z.unknown()),
});
export type ContextDebugEvent = z.infer<typeof ContextDebugEventSchema>;

/**
 * How full the context window is, sent before every model request.
 *
 * Estimated, not billed: the same estimate the loop compacts against, so the
 * meter and the compaction it predicts always agree.
 */
export const ContextUsageEventSchema = z.object({
  type: z.literal("context_usage"),
  sessionId: z.string(),
  usage: ContextUsageSchema,
});
export type ContextUsageEvent = z.infer<typeof ContextUsageEventSchema>;

export const QueuedMessageSchema = z.object({
  id: z.string(),
  text: z.string(),
  /**
   * The person chose "Send now": the agent stops what it is doing to read
   * this, instead of finishing its current step first.
   */
  urgent: z.boolean().optional(),
});
export type QueuedMessage = z.infer<typeof QueuedMessageSchema>;

/**
 * Messages sent while a turn is running, not yet read by the agent.
 *
 * Sent whenever the queue changes. `returned` holds messages that will now
 * never be delivered — the turn was stopped — so a surface can put them back
 * in the composer instead of losing what someone typed.
 */
export const InputQueueEventSchema = z.object({
  type: z.literal("input_queue"),
  sessionId: z.string(),
  items: z.array(QueuedMessageSchema),
  returned: z.array(QueuedMessageSchema).optional(),
});
export type InputQueueEvent = z.infer<typeof InputQueueEventSchema>;

/**
 * A message from the user entered the conversation without starting it.
 *
 * Either delivered into a running turn at its next step, or opening the turn
 * that follows one which finished before it could be read. `queueIds` names
 * the queued messages it was made from.
 */
export const UserMessageEventSchema = z.object({
  type: z.literal("user_message"),
  sessionId: z.string(),
  text: z.string(),
  queueIds: z.array(z.string()).optional(),
  /** The question this message answers: shown inside the question, not as a message of its own. */
  answers: z.string().optional(),
});
export type UserMessageEvent = z.infer<typeof UserMessageEventSchema>;

/** Session metadata changed: its title, or its auto-compaction setting. */
/**
 * How a session was last set up: the choices in its composer. Kept with the
 * session, so switching away and back — or to another device — finds them as
 * they were left.
 */
export const SessionSettingsSchema = z.object({
  mode: z.string().optional(),
  effort: z.string().optional(),
  model: z.string().optional(),
  outputStyle: z.string().optional(),
});
export type SessionSettings = z.infer<typeof SessionSettingsSchema>;

export const SessionUpdatedEventSchema = z.object({
  type: z.literal("session_updated"),
  sessionId: z.string(),
  title: z.string().optional(),
  /** Null when reset to the default. See `context-window.ts`. */
  autoCompact: z.number().nullable().optional(),
  settings: SessionSettingsSchema.optional(),
});
export type SessionUpdatedEvent = z.infer<typeof SessionUpdatedEventSchema>;

export const ToolCallEventSchema = z.object({
  type: z.literal("tool_call"),
  sessionId: z.string(),
  callId: z.string(),
  tool: z.string(),
  input: z.record(z.unknown()),
});
export type ToolCallEvent = z.infer<typeof ToolCallEventSchema>;

export const ToolResultEventSchema = z.object({
  type: z.literal("tool_result"),
  sessionId: z.string(),
  callId: z.string(),
  tool: z.string(),
  output: z.unknown(),
  success: z.boolean(),
  /**
   * The call was set aside before it ran — a write stopped to read the skill
   * that covers it — and will be made again. Not a result to show: the row
   * goes, and the call that replaces it takes its place.
   */
  deferred: z.boolean().optional(),
});
export type ToolResultEvent = z.infer<typeof ToolResultEventSchema>;

/**
 * A running tool saying how far along it is: an MCP server's progress
 * notifications and log messages, while the call is still open. Display only —
 * the result still arrives as `tool_result`.
 */
export const ToolProgressEventSchema = z.object({
  type: z.literal("tool_progress"),
  sessionId: z.string(),
  callId: z.string(),
  tool: z.string(),
  progress: z.number().optional(),
  total: z.number().optional(),
  message: z.string().optional(),
});
export type ToolProgressEvent = z.infer<typeof ToolProgressEventSchema>;

export const DiffEventSchema = z.object({
  type: z.literal("diff"),
  sessionId: z.string(),
  path: z.string(),
  unifiedDiff: z.string(),
  /**
   * The edit that made it. Two edits to one file in one step used to share
   * whichever diff came last by path, so a failed edit showed the successful
   * one's change and the step counted it twice (1 Nov 2026: "+32 −14" for one
   * real "+16 −7").
   */
  callId: z.string().optional(),
});
export type DiffEvent = z.infer<typeof DiffEventSchema>;

export const TodoUpdateEventSchema = z.object({
  type: z.literal("todo_update"),
  sessionId: z.string(),
  items: z.array(TodoItemSchema),
});
export type TodoUpdateEvent = z.infer<typeof TodoUpdateEventSchema>;

export const ConfirmationRequiredEventSchema = z.object({
  type: z.literal("confirmation_required"),
  sessionId: z.string(),
  confirmationId: z.string(),
  action: z.string(),
  description: z.string(),
  payload: z.record(z.unknown()).optional(),
  /** The sub-agent asking, when it is not the session's own agent. */
  agent: z.object({ id: z.string(), label: z.string() }).optional(),
});
export type ConfirmationRequiredEvent = z.infer<typeof ConfirmationRequiredEventSchema>;

/**
 * A command the agent started, as a process with a lifetime of its own.
 *
 * Foreground processes are waited for and time out; background ones run until
 * something stops them. Either can be stopped by the person watching.
 */
export const ProcessInfoSchema = z.object({
  id: z.string(),
  /** The tool call that started it, to tie it to its line in the transcript. */
  callId: z.string().optional(),
  command: z.string(),
  description: z.string().optional(),
  background: z.boolean(),
  /** Running in a pseudo-terminal, and so able to take input. */
  interactive: z.boolean().optional(),
  status: z.enum(["running", "exited", "stopped", "timed_out", "failed"]),
  exitCode: z.number().int().nullable(),
  startedAt: z.number(),
  endedAt: z.number().optional(),
  stoppedBy: z.enum(["user", "agent", "timeout", "cancelled", "shutdown"]).optional(),
});
export type ProcessInfo = z.infer<typeof ProcessInfoSchema>;

export const ProcessStartedEventSchema = z.object({
  type: z.literal("process_started"),
  sessionId: z.string(),
  process: ProcessInfoSchema,
});
export type ProcessStartedEvent = z.infer<typeof ProcessStartedEventSchema>;

/** Output as it arrives, in batches a few times a second. */
export const ProcessOutputEventSchema = z.object({
  type: z.literal("process_output"),
  sessionId: z.string(),
  processId: z.string(),
  chunk: z.string(),
});
export type ProcessOutputEvent = z.infer<typeof ProcessOutputEventSchema>;

export const ProcessExitedEventSchema = z.object({
  type: z.literal("process_exited"),
  sessionId: z.string(),
  process: ProcessInfoSchema,
});
export type ProcessExitedEvent = z.infer<typeof ProcessExitedEventSchema>;

/** A process as a page that has just arrived sees it: its state and latest output. */
export const ProcessSnapshotSchema = ProcessInfoSchema.extend({ output: z.string() });
export type ProcessSnapshot = z.infer<typeof ProcessSnapshotSchema>;

/**
 * Sent once to each new subscriber: is a turn already running here, and is it
 * waiting on a person?
 *
 * Turns outlive the request that started them, so a page that reloads mid-turn
 * has no other way to know it should show "working" and a Stop button rather
 * than an idle composer. `pending` carries an unanswered approval for the same
 * reason: the original `confirmation_required` went to a page that no longer
 * exists, and without it the turn would wait for an answer nobody could give.
 */
/**
 * The agent has asked the person a question and stopped for the answer.
 *
 * Distinct from `confirmation_required`, which is a yes/no about an action the
 * agent is about to take. This is a question whose answer is *information* —
 * which of two readings of the request is meant, which account to use, whether
 * a missing thing should be created. It is answered by sending an ordinary
 * message, so the answer lands in the transcript where it belongs and the
 * existing mid-turn message channel carries it. The event exists so a surface
 * can say "SoreQen Code is waiting on you" rather than showing a spinner
 * against a turn that will never move on its own.
 */
export const QuestionEventSchema = z.object({
  type: z.literal("question"),
  sessionId: z.string(),
  questionId: z.string(),
  question: z.string(),
  /** Why the agent cannot settle this itself. */
  why: z.string().optional(),
  /** Concrete choices, when the answer is a choice. */
  options: z.array(z.string()).optional(),
  /** Which of the options the agent recommends, by position. */
  recommended: z.number().int().nonnegative().optional(),
  /** Why it recommends that one. */
  recommendedBecause: z.string().optional(),
  /** In a batch of questions asked together: which one this is (from 0), and how many there are. */
  index: z.number().int().nonnegative().optional(),
  total: z.number().int().positive().optional(),
  /** Asked again because the person went back to it: what they answered before. */
  previous: z.string().optional(),
});
export type QuestionEvent = z.infer<typeof QuestionEventSchema>;

/**
 * The answer that means "take me back to the question before this one", in a
 * batch asked together. Sent like an answer, read by the batch, and never
 * recorded as anything the person said. Answering the second question used to
 * leave no way back to change the first (13 Nov 2026).
 */
export const ASK_USER_BACK = "\u2063ask_user:back\u2063";

/** The question was answered (or the turn moved on), so the prompt can clear. */
export const QuestionAnsweredEventSchema = z.object({
  type: z.literal("question_answered"),
  sessionId: z.string(),
  questionId: z.string(),
  answer: z.string().optional(),
});
export type QuestionAnsweredEvent = z.infer<typeof QuestionAnsweredEventSchema>;

/**
 * One delegated sub-agent, as the panel watching them sees it.
 *
 * Sub-agents used to be invisible: the parent blocked on one, the surface
 * showed a single tool call that took four minutes, and nothing said what was
 * happening inside it. Now each one reports its own life cycle, and the panel
 * is read-only by design — a person may watch a sub-agent and may not talk to
 * it, because a sub-agent that takes instructions from two places is a
 * sub-agent whose brief nobody can state.
 */
export const SubagentInfoSchema = z.object({
  id: z.string(),
  role: z.string(),
  /** The brief, trimmed for display. */
  task: z.string(),
  /** The whole brief the sub-agent was given, for someone watching it. */
  brief: z.string().optional(),
  status: z.enum(["running", "completed", "failed", "cancelled"]),
  startedAt: z.number(),
  endedAt: z.number().optional(),
  /** What it is doing right now, from its own progress. */
  activity: z.string().optional(),
  /** Tool calls it has made. */
  steps: z.number().optional(),
  /** Its answer, once it has one. */
  result: z.string().optional(),
  error: z.string().optional(),
  filesModified: z.array(z.string()).optional(),
});
export type SubagentInfo = z.infer<typeof SubagentInfoSchema>;

export const SubagentUpdateEventSchema = z.object({
  type: z.literal("subagent_update"),
  sessionId: z.string(),
  agent: SubagentInfoSchema,
});
export type SubagentUpdateEvent = z.infer<typeof SubagentUpdateEventSchema>;

/**
 * Something a sub-agent's own turn did — a token, a tool call, a result.
 *
 * Wrapped rather than merged into the parent's stream, because the parent's
 * transcript must not show them: interleaving several agents' calls into one
 * conversation is exactly what made delegation unreadable. A surface keeps one
 * transcript per agent from these instead, and shows it only to someone who
 * asks to watch that agent.
 *
 * `event` is a `StreamEvent`. It is typed loosely here only because the
 * schema cannot refer to the union it is part of without a lazy cycle, and
 * nothing validates these at runtime.
 */
export const SubagentEventSchema = z.object({
  type: z.literal("subagent_event"),
  sessionId: z.string(),
  agentId: z.string(),
  event: z.record(z.string(), z.unknown()),
});
export type SubagentEvent = z.infer<typeof SubagentEventSchema>;

/**
 * A goal (`/goal`, Smart Loop mode): an objective the agent works toward turn
 * after turn, started again automatically, until it is achieved or somebody
 * stops it. Kept with the session, so it outlives a restart of the runtime.
 */
export const GoalStateSchema = z.object({
  objective: z.string(),
  /**
   * `active`: turns follow one another. `paused`: waiting for the person
   * (stopped, blocked, no progress, failing), resumable. `achieved`: verified
   * done. `stopped`: ended by the person.
   */
  status: z.enum(["active", "paused", "achieved", "stopped"]),
  startedAt: z.number(),
  updatedAt: z.number(),
  /** Turns worked on it so far. */
  turns: z.number(),
  /** Files changed across all of its turns (counted per turn, not distinct). */
  filesChanged: z.number(),
  /** Turns in a row that changed nothing. */
  idleTurns: z.number(),
  /** Failed turns in a row. */
  failures: z.number(),
  /** The agent said it was achieved; the next turn checks that before it is closed. */
  verifying: z.boolean().optional(),
  /** Why it is paused, or what the last turn reported. */
  note: z.string().optional(),
});
export type GoalState = z.infer<typeof GoalStateSchema>;

export const GoalUpdateEventSchema = z.object({
  type: z.literal("goal_update"),
  sessionId: z.string(),
  goal: GoalStateSchema.nullable(),
});
export type GoalUpdateEvent = z.infer<typeof GoalUpdateEventSchema>;

/** A session's scheduled checks (`schedule_wakeup`), or null when none are left. */
export const WakeupStateSchema = z.object({
  at: z.number(),
  every: z.number().optional(),
  remaining: z.number(),
  note: z.string(),
  done: z.number(),
  /** Background commands the checks watch: once all have ended, the checks stop by themselves. */
  watching: z.array(z.string()).optional(),
});

export const WakeupUpdateEventSchema = z.object({
  type: z.literal("wakeup_update"),
  sessionId: z.string(),
  wakeup: WakeupStateSchema.nullable(),
});
export type WakeupUpdateEvent = z.infer<typeof WakeupUpdateEventSchema>;

/** Memories saved after a turn by the check for what it established (see orchestrator/memory-extract.ts). */
export const MemorySavedEventSchema = z.object({
  type: z.literal("memory_saved"),
  sessionId: z.string(),
  names: z.array(z.string()),
});
export type MemorySavedEvent = z.infer<typeof MemorySavedEventSchema>;

export const SessionStateEventSchema = z.object({
  type: z.literal("session_state"),
  /** The session's goal, when it has one (`/goal`). */
  goal: GoalStateSchema.optional(),
  /** Its scheduled checks; null when it has none. Absent from the brief running/stopped notices. */
  wakeup: WakeupStateSchema.nullable().optional(),
  sessionId: z.string(),
  running: z.boolean(),
  pending: ConfirmationRequiredEventSchema.optional(),
  /** An unanswered question, for the same reason `pending` exists. */
  question: QuestionEventSchema.optional(),
  /** Sub-agents this turn delegated to, running or recently finished. */
  subagents: z.array(SubagentInfoSchema).optional(),
  /** Messages waiting to be read by the running turn. */
  queue: z.array(QueuedMessageSchema).optional(),
  /** The context window as of the last request, when known. */
  context: ContextUsageSchema.optional(),
  /** Processes this session's agent started that are running or recently ended. */
  processes: z.array(ProcessSnapshotSchema).optional(),
  /** The composer choices the session was last used with. */
  settings: SessionSettingsSchema.optional(),
  /** The running turn's plan, as it stands. */
  plan: z.array(TodoItemSchema).optional(),
  /** Set when what is running is a checkpoint between turns, not a turn. */
  checkpoint: CheckpointProgressSchema.optional(),
  /**
   * The running turn's response so far — what a page arriving mid-sentence
   * has missed, since it is stored only once the response is complete — and
   * the tokens the model has written this turn.
   */
  live: z
    .object({
      text: z.string(),
      reasoning: z.string(),
      outputTokens: z.number().optional(),
      /** When this step asked the model (ms since epoch): where its thinking began. */
      startedAt: z.number().optional(),
      /** When its first words, or first call, arrived: where its thinking ended. */
      answeredAt: z.number().optional(),
      /**
       * This step's calls as they stand: how far a running one has got, and
       * the result of one already finished. A step's results are stored only
       * when its last call ends, so a page arriving during a long research
       * call saw the step's quick calls spinning and the research with no
       * progress at all (14 Oct 2026).
       */
      calls: z
        .array(
          z.object({
            callId: z.string(),
            tool: z.string(),
            progress: z.string().optional(),
            result: z.object({ success: z.boolean(), output: z.string() }).optional(),
          }),
        )
        .optional(),
    })
    .optional(),
});
export type SessionStateEvent = z.infer<typeof SessionStateEventSchema>;

export const ErrorEventSchema = z.object({
  type: z.literal("error"),
  sessionId: z.string(),
  code: z.string(),
  message: z.string(),
  /**
   * The tool call this error is about, when it is about one.
   *
   * A refused call used to raise an error with no way to tell *which* call
   * was refused — so a surface showing three pending calls could not mark the
   * right one, and left the refused call spinning for ever.
   */
  callId: z.string().optional(),
});
export type ErrorEvent = z.infer<typeof ErrorEventSchema>;

export const CompleteEventSchema = z.object({
  type: z.literal("complete"),
  sessionId: z.string(),
  summary: z.string(),
  /**
   * The checkpoint taken before this turn, if there was one.
   *
   * Carried on the completion event because that is the moment a client can
   * act on it: the turn is over, the diff is on screen, and "undo this" is the
   * next thing someone might want. A client that learns about the checkpoint
   * later, from a separate request, has to correlate it back to a turn — and
   * would have to know to ask.
   */
  checkpointId: z.string().optional(),
  /** Files this turn wrote to, so the undo affordance can say how much it
   *  would restore before anyone commits to it. */
  changedFiles: z.array(z.string()).optional(),
  /**
   * Present when the workspace could not be snapshotted, with the reason.
   *
   * Not merely the absence of `checkpointId`: "plan mode takes no checkpoint"
   * and "this workspace has no git" are different facts, and only the second
   * one changes what Auto mode will do. A client that conflated them would
   * warn about a missing undo in the one mode that cannot change anything.
   */
  checkpointUnavailable: z.string().optional(),
});
export type CompleteEvent = z.infer<typeof CompleteEventSchema>;

/**
 * Union of all Stream Events
 */
export const StreamEventSchema = z.discriminatedUnion("type", [
  TokenEventSchema,
  ThinkingEventSchema,
  SessionStateEventSchema,
  StepStartEventSchema,
  OutputUsageEventSchema,
  ToolCallPendingEventSchema,
  ModelRetryEventSchema,
  ContextCompactedEventSchema,
  CheckpointProgressEventSchema,
  ContextUsageEventSchema,
  ContextDebugEventSchema,
  InputQueueEventSchema,
  UserMessageEventSchema,
  SessionUpdatedEventSchema,
  ToolCallEventSchema,
  ToolResultEventSchema,
  ToolProgressEventSchema,
  DiffEventSchema,
  TodoUpdateEventSchema,
  ConfirmationRequiredEventSchema,
  ErrorEventSchema,
  CompleteEventSchema,
  ProcessStartedEventSchema,
  ProcessOutputEventSchema,
  ProcessExitedEventSchema,
  QuestionEventSchema,
  QuestionAnsweredEventSchema,
  SubagentUpdateEventSchema,
  SubagentEventSchema,
  ModelFallbackEventSchema,
  GoalUpdateEventSchema,
  WakeupUpdateEventSchema,
  MemorySavedEventSchema,
]);
export type StreamEvent = z.infer<typeof StreamEventSchema>;

/**
 * Client Inbound Message Types
 */
export const InboundMessageSchema = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("send_message"),
    sessionId: z.string(),
    content: z.string(),
  }),
  z.object({
    action: z.literal("confirm"),
    sessionId: z.string(),
    confirmationId: z.string(),
    approved: z.boolean(),
    reason: z.string().optional(),
  }),
  z.object({
    action: z.literal("abort"),
    sessionId: z.string(),
  }),
]);
export type InboundMessage = z.infer<typeof InboundMessageSchema>;
