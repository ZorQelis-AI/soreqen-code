/**
 * Tools that are not SoreQen's own: what an MCP server offers.
 *
 * The orchestrator knows only this interface. Connecting to servers, speaking
 * the protocol and keeping processes alive is `@sqcode/mcp`'s job, and the
 * host (CLI, desktop app) decides which servers to connect — so the agent loop
 * has no dependency on the protocol SDK, and a surface with no business
 * running other people's servers (the hosted website) simply passes none.
 */

import type { ToolResult } from "@sqcode/tools";
import type { AgentMode, PermissionTier } from "@sqcode/shared";

export interface ExternalToolDefinition {
  /** `mcp__<server>__<tool>`: unique across servers, and says whose it is. */
  name: string;
  description: string;
  input_schema: {
    type: "object";
    properties: Record<string, unknown>;
    required: string[];
  };
}

export interface ExternalToolInfo {
  server: string;
  tool: string;
  /**
   * Treated as only reading: the person declared it so (`declaredReadOnly`),
   * or it is one of the person's own servers and the server says so (MCP
   * `readOnlyHint`).
   *
   * A hint alone is never enough from a server the person did not configure
   * themselves. The MCP specification says as much — annotations are hints,
   * and a client must not base decisions on them when the server is not
   * trusted — and a project's `.mcp.json` is a repository's choice of server,
   * not the person's. Such a server calling a destructive tool "read-only"
   * would otherwise walk it past every confirmation.
   */
  readOnly: boolean;
  /** The person marked it read-only in their own configuration (`readOnly` in mcp.json). */
  declaredReadOnly: boolean;
  /** The person listed this tool, or the whole server, as approved in advance. */
  autoApproved: boolean;
}

/** How far along a running call is, as its server reports it. */
export interface ExternalProgress {
  progress?: number;
  total?: number;
  message?: string;
}

/**
 * A server asking the model to write something (MCP sampling): its own
 * prompt, sent without tools, the answer going back to the server.
 */
export interface SampleRequest {
  server: string;
  systemPrompt?: string;
  messages: { role: "user" | "assistant"; text: string }[];
  maxTokens: number;
}

export interface SampleResult {
  text: string;
  model: string;
  stopReason: "endTurn" | "maxTokens";
}

/**
 * What one call carries besides its input, all supplied by the turn it runs in.
 *
 * Sampling is offered per call, not per connection: a server may ask the
 * model something only while one of its own tools is running for the agent,
 * inside a turn someone is watching and can answer a confirmation in — never
 * in the background, where nobody would know it was spending their model.
 */
export interface ExternalCallContext {
  signal?: AbortSignal;
  onProgress?: (progress: ExternalProgress) => void;
  /** Absent: the server's request is refused. */
  sample?: (request: SampleRequest) => Promise<SampleResult>;
  /** True once the person has sent a message: a tool waiting on them (a sign-in) stops waiting. */
  interrupted?: () => boolean;
}

export interface ExternalTools {
  definitions(): ExternalToolDefinition[];
  describe(name: string): ExternalToolInfo | undefined;
  call(name: string, input: Record<string, unknown>, context?: ExternalCallContext): Promise<ToolResult>;
  /**
   * A few lines for the system prompt: which servers are connected, and what they are for.
   *
   * `deferred`: the servers' tools are offered through `load_tools` rather than in full
   * (see `DEFER_EXTERNAL_TOOLS_AT` in agent-loop.ts), so the section names the servers and
   * leaves their own instructions to `instructions`, given when their tools are loaded.
   */
  promptSection?(options?: { deferred?: boolean }): string;
  /** A server's own instructions, fenced as its words, for when its tools are loaded. */
  instructions?(server: string): string | undefined;
  /**
   * Brings `definitions` up to date with what is connected now: a server the
   * agent (or the person, in Settings) connected during the turn. Called
   * before each step; cheap when nothing changed.
   */
  refresh?(): Promise<void>;
}

export interface ExternalDecision {
  allowed: boolean;
  requiresConfirmation: boolean;
  reason?: string;
}

/**
 * Whether an external tool may run, and whether to ask first.
 *
 * An MCP tool can do anything its server can: post a message, charge a card,
 * delete a record in somebody else's system. None of that is inside the
 * workspace, so no checkpoint can undo it, and `auto`'s "a snapshot covers it"
 * argument never applies. Hence:
 *
 *   - plan / read_only: only tools treated as read-only (see `readOnly`);
 *   - bypass: everything, without asking (the mode says so on the label);
 *   - manual / propose_only: every call is asked about, except tools the
 *     person *declared* read-only — a server's own word does not waive a
 *     confirmation the person chose to see;
 *   - auto: read-only tools and tools approved in advance run; everything
 *     else is asked about, every time.
 */
export function decideExternalTool(
  info: ExternalToolInfo,
  ctx: { mode: AgentMode; tier: PermissionTier },
): ExternalDecision {
  const label = `${info.tool} (MCP server "${info.server}")`;
  if (ctx.mode === "plan" || ctx.tier === "read_only") {
    return info.readOnly
      ? { allowed: true, requiresConfirmation: false }
      : { allowed: false, requiresConfirmation: false, reason: `${label} may change things outside the workspace, and this session is read-only.` };
  }
  if (ctx.mode === "bypass") return { allowed: true, requiresConfirmation: false };
  // Manual, and a propose-only workspace, approve each change as it happens:
  // neither a server's hint nor an approval given in advance stands in for that.
  if (ctx.mode === "manual" || ctx.tier === "propose_only") {
    return info.declaredReadOnly
      ? { allowed: true, requiresConfirmation: false }
      : { allowed: true, requiresConfirmation: true, reason: `Run ${label}? This session confirms every action outside the workspace.` };
  }
  if (info.readOnly || info.autoApproved) return { allowed: true, requiresConfirmation: false };
  return {
    allowed: true,
    requiresConfirmation: true,
    reason: `Run ${label}? It acts outside this workspace, so a checkpoint cannot undo it.`,
  };
}
