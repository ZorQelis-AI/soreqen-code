/**
 * SoreQen Code Tool Execution Types & Interfaces
 */

import type { SandboxRunner } from "@sqcode/sandbox-runner";
import type { PermissionTier } from "@sqcode/shared";

export interface ToolExecutionContext {
  workspaceId: string;
  /** Memory kept between sessions (`remember`, `forget`, `recall`), when the host has one. */
  onMemory?: (tool: string, input: Record<string, unknown>) => Promise<ToolResult> | ToolResult;
  sessionId?: string;
  /** The model's id for the call being executed, so what it starts can be tied back to it. */
  callId?: string;
  /**
   * How many messages the person has sent that the agent has not read yet.
   *
   * A `wait` ends as soon as there is one: an agent sitting out a timer while
   * someone is talking to it is exactly the unresponsiveness this exists to end.
   */
  pendingMessages?: () => number;
  /**
   * How many of those the person chose to send now. A foreground command
   * stops being waited on (it keeps running), so the message is read at once.
   */
  urgentMessages?: () => number;
  /**
   * News the agent is about to be told, which also ends a `wait`: "A
   * sub-agent finished", "A background command ended". Null when there is none.
   */
  newsWaiting?: () => string | null;
  permissionTier?: PermissionTier;
  sandboxRunner: SandboxRunner;
  env?: Record<string, string>;
  onStdout?: (chunk: string) => void;
  onStderr?: (chunk: string) => void;
  /**
   * The turn's cancellation signal, for every tool that can wait.
   *
   * Passed to `execCommand` and to every outbound `fetch`. Without it, "stop"
   * meant "stop asking the model for more" while a 120-second test run and a
   * 15-second URL fetch carried on regardless.
   */
  signal?: AbortSignal;
  /**
   * Look a declaration up without searching for it.
   *
   * Supplied by the orchestrator, which already parsed several hundred source
   * files to build the repository map and can answer from that in memory. The
   * symbol tools use it first and fall back to a text search on a miss.
   *
   * Returns `null` when nothing is indexed at all — which is a different
   * answer from an empty array, and the difference matters: "I looked and it
   * is not there" versus "I have not looked". A tool that reports the second
   * as the first teaches the model a symbol does not exist.
   */
  lookupSymbol?: (
    name: string,
  ) => { file: string; line: number; kind: string; signature: string }[] | null;
  llmProvider?: unknown;
  /**
   * Put a question to the person and wait for the answer.
   *
   * Supplied only by a surface that has one. Absent means "nobody is
   * watching", which the `ask_user` arm reports as a fact the agent can work
   * around rather than as a failure — an unattended run must not block on a
   * question no one will read.
   */
  onAskUser?: (question: {
    question: string;
    why?: string;
    options?: string[];
    /** Which option the agent recommends, by position in `options`. */
    recommended?: number;
    recommendedBecause?: string;
    /** In a batch asked together: which question this is (from 0), and how many. */
    index?: number;
    total?: number;
    /** Asked again after the person went back: their earlier answer. */
    previous?: string;
  }) => Promise<string>;
  /**
   * Start a specialist, and answer immediately unless asked to wait.
   *
   * Returns the tool result itself rather than an outcome, because the two
   * cases genuinely differ: a non-blocking spawn reports an id and a running
   * status, and a blocking one reports an answer.
   */
  onSpawnSubagent?: (request: {
    role: string;
    taskPrompt: string;
    workspaceId: string;
    contextFiles?: string[];
    doneWhen?: string;
    known?: string;
    outOfScope?: string;
    wait?: boolean;
  }) => Promise<ToolResult>;
  /** Record entries in the durable task state. Supplied by the orchestrator's context engine. */
  onTaskState?: (input: Record<string, unknown>) => Promise<ToolResult> | ToolResult;
  /** Hybrid retrieval over the repository index. Supplied by the context engine. */
  onRetrieveContext?: (input: Record<string, unknown>) => Promise<ToolResult>;
  /** `code_graph`: the codebase as a graph, from the context engine's index. */
  onCodeGraph?: (input: Record<string, unknown>) => Promise<ToolResult>;
  /**
   * `research`, run by the orchestrator, which has a model for the deep
   * mode's planning and report. Without it the dispatcher gathers the
   * evidence itself (quick and standard depth).
   */
  onResearch?: (input: Record<string, unknown>, callId?: string) => Promise<ToolResult>;
  /** `schedule_wakeup`: kept by the host that can start the session again later. Absent: the surface cannot. */
  onScheduleWakeup?: (input: Record<string, unknown>) => Promise<ToolResult> | ToolResult;
  /** Load a conditional skill's text, or one of its files. Supplied by the orchestrator's skill set. */
  onUseSkill?: (name: string, file?: string, copy?: { to: string; overwrite: boolean }) => ToolResult | Promise<ToolResult>;
  /**
   * Tools that are not SoreQen's own — an MCP server's, by name
   * (`mcp__<server>__<tool>`). Supplied by the host that connected them.
   */
  onExternalTool?: (name: string, input: Record<string, unknown>, callId?: string) => Promise<ToolResult> | null;
  /** Report on delegated specialists; optionally block until they all finish. */
  onSubagentStatus?: (input: {
    agent_id?: string;
    wait_for_all?: boolean;
  }) => Promise<ToolResult>;
}

/**
 * A picture a tool produced, on its way to the model's eyes.
 *
 * Carried beside `data` rather than inside it, and that placement is the whole
 * point. A tool result is serialised to text before the model sees it, so
 * base64 in `data` became a wall of characters — clipped mid-string by the
 * result limit, unreadable by anything, and the reason the agent said it
 * "cannot see images in this environment" while looking straight at one.
 *
 * The loop lifts this field out and sends it as a real image content block.
 * Nothing serialises it, and a model that cannot read images is told so in
 * words instead of being sent a megabyte it will reject.
 */
export interface ToolImage {
  /** Raw base64, no data-URI prefix. */
  base64: string;
  /** `image/png`, `image/jpeg`, … */
  mediaType: string;
  /** Where it came from, for the sentence that accompanies it. */
  source: string;
}

export interface ToolResult<T = unknown> {
  success: boolean;
  data?: T;
  error?: string;
  diff?: string;
  image?: ToolImage;
  /** Several pictures, in order: a browser batch that screenshotted more than once. */
  images?: ToolImage[];
}

export class ToolExecutionError extends Error {
  constructor(
    public toolName: string,
    message: string,
  ) {
    super(`[${toolName}] ${message}`);
    this.name = "ToolExecutionError";
  }
}

export class ToolPermissionError extends Error {
  constructor(
    public toolName: string,
    message: string,
  ) {
    super(`[${toolName}] Permission Denied: ${message}`);
    this.name = "ToolPermissionError";
  }
}
