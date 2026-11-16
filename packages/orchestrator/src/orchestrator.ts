/**
 * SoreQen Code High-Level Orchestrator Service
 */

import type { SkillOptions } from "./skills/index.js";
import type { MemoryStore } from "./memory.js";
import type { ExternalTools } from "./external-tools.js";
import { getSandboxRunner, type SandboxRunner } from "@sqcode/sandbox-runner";
import type { StreamEvent, PermissionTier, AgentMode, Effort, OutputStyle, TodoItem } from "@sqcode/shared";
import type { AgentTurnOptions, LLMProvider, AgentTurnResult, LLMMessage, MessageMeta, TurnControls } from "./types.js";
import { OpenAICompatibleProvider } from "./openai-provider.js";
import { runAgentTurn } from "./agent-loop.js";
import type { RoutingPolicy } from "./model-router.js";
import type { PrefixSeal } from "./prefix-cache.js";

export interface OrchestratorConfig {
  sandboxRunner?: SandboxRunner;
  llmProvider?: LLMProvider;
}

/**
 * The environment's provider, made when a turn first needs it.
 *
 * Made in the constructor, it threw "No LLM API key configured" while the
 * server was still starting, on any computer with no key in its environment,
 * which is every fresh install: the desktop runtime died before it listened,
 * so the app showed "127.0.0.1 refused to connect" instead of its "add your
 * own key" screen (3 Oct 2026, a beta laptop and both macOS builds). Most
 * turns bring a provider of their own; this one only answers when none does,
 * and the missing key is then that turn's error.
 */
function lazyDefaultProvider(): LLMProvider {
  let made: LLMProvider | null = null;
  const real = (): LLMProvider => (made ??= new OpenAICompatibleProvider());
  return {
    get name() {
      try {
        return real().name;
      } catch {
        return "openai_compatible";
      }
    },
    chatStream: (options) => real().chatStream(options),
  };
}

export class SoreQenOrchestrator {
  private sandboxRunner: SandboxRunner;
  private llmProvider: LLMProvider;

  constructor(config?: OrchestratorConfig) {
    this.sandboxRunner = config?.sandboxRunner ?? getSandboxRunner();
    this.llmProvider = config?.llmProvider ?? lazyDefaultProvider();
  }

  /**
   * Run one turn.
   *
   * This facade used to accept a strict subset of what `runAgentTurn` supports,
   * which quietly made the rest unreachable: a caller going through the
   * orchestrator — which is every caller, including the CLI and the gateway —
   * could not set a model, a token budget, or a cancellation signal, however
   * carefully those were implemented underneath. A narrowing wrapper is a
   * feature that does not exist.
   */
  async runTurn(options: {
    workspaceId: string;
    sessionId: string;
    /** The mode the user selected. Preferred over `permissionTier`, which is
     *  treated as the workspace's ceiling when both are given. */
    mode?: AgentMode;
    /** Reasoning effort. Drives how much the model reasons, how the agent is
     *  told to work, affected-test runs and self-review. */
    effort?: Effort;
    /** How the agent communicates. */
    outputStyle?: OutputStyle;
    /** Messages, compaction requests and settings arriving mid-turn. */
    controls?: TurnControls;
    routing?: RoutingPolicy;
    /** Carried between turns to keep the conversation prefix cacheable. */
    prefixSeal?: PrefixSeal | null;
    permissionTier?: PermissionTier;
    userMessage: string;
    llmProvider?: LLMProvider;
    history?: LLMMessage[];
    /** An unfinished plan from a stopped turn. See `AgentTurnOptions.plan`. */
    plan?: TodoItem[];
    /** Sizes the context budget. Without it the loop assumes a small window. */
    model?: string;
    maxOutputTokens?: number;
    maxTurnTokens?: number;
    maxIterations?: number;
    /** Stops the turn. See `AgentTurnOptions.signal`. */
    signal?: AbortSignal;
    onEvent?: (event: StreamEvent) => void | Promise<void>;
    /** Every message the turn adds, as it is added. See `AgentTurnOptions.onMessage`. */
    onMessage?: (message: LLMMessage, meta: MessageMeta) => Promise<string | void> | string | void;
    /** Which skills are on. See `AgentTurnOptions.skills`. */
    skills?: SkillOptions;
    /** Connected MCP servers' tools. See `AgentTurnOptions.externalTools`. */
    externalTools?: ExternalTools;
    /** Memory kept between sessions. See `AgentTurnOptions.memory`. */
    memory?: MemoryStore;
    /** Settings > General. See `AgentTurnOptions.personal`. */
    personal?: AgentTurnOptions["personal"];
    onAwaitConfirmation?: (confirmation: {
      confirmationId: string;
      action: string;
      description: string;
      payload?: Record<string, unknown>;
    }) => Promise<boolean>;
    /** `schedule_wakeup`. See `AgentTurnOptions.onScheduleWakeup`. */
    onScheduleWakeup?: AgentTurnOptions["onScheduleWakeup"];
  }): Promise<AgentTurnResult> {
    return runAgentTurn({
      workspaceId: options.workspaceId,
      sessionId: options.sessionId,
      mode: options.mode,
      effort: options.effort,
      outputStyle: options.outputStyle,
      controls: options.controls,
      onMessage: options.onMessage,
      routing: options.routing,
      prefixSeal: options.prefixSeal,
      permissionTier: options.permissionTier,
      userMessage: options.userMessage,
      history: options.history,
      ...(options.plan ? { plan: options.plan } : {}),
      sandboxRunner: this.sandboxRunner,
      llmProvider: options.llmProvider ?? this.llmProvider,
      model: options.model,
      maxOutputTokens: options.maxOutputTokens,
      maxTurnTokens: options.maxTurnTokens,
      maxIterations: options.maxIterations,
      signal: options.signal,
      onEvent: options.onEvent,
      ...(options.skills ? { skills: options.skills } : {}),
      ...(options.externalTools ? { externalTools: options.externalTools } : {}),
      ...(options.memory ? { memory: options.memory } : {}),
      ...(options.personal ? { personal: options.personal } : {}),
      ...(options.onScheduleWakeup ? { onScheduleWakeup: options.onScheduleWakeup } : {}),
      onAwaitConfirmation: options.onAwaitConfirmation
        ? async (c) =>
            options.onAwaitConfirmation!({
              confirmationId: c.confirmationId,
              action: c.action,
              description: c.description,
              payload: c.toolCall.input,
            })
        : undefined,
    });
  }
}
