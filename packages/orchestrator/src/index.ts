/**
 * SoreQen Code Orchestrator Package
 * Master exports.
 */

export * from "./types.js";
export * from "./prompt.js";
export * from "./llm-provider.js";
export * from "./anthropic-provider.js";
export * from "./openai-provider.js";
export * from "./responses-provider.js";
export * from "./context-manager.js";
export * from "./summarizer.js";
export * from "./prefix-cache.js";
export * from "./guardrails.js";
export * from "./reversibility.js";
export * from "./mode-policy.js";
export * from "./checkpoint.js";
export * from "./repo-map.js";
export * from "./tool-cache.js";
export * from "./test-selector.js";
export * from "./self-review.js";
export * from "./model-router.js";
export * from "./eval-harness.js";
export * from "./eval-tasks.js";
export * from "./audit.js";
export * from "./confirmation.js";
export * from "./memory-manager.js";
export * from "./memory.js";
export * from "./memory-extract.js";
export * from "./self-healer.js";
export * from "./resilience.js";
export * from "./tool-result.js";
export * from "./session-resources.js";
export * from "./model-failover.js";
export * from "./model-catalogue.js";
export * from "./custom-providers.js";
export * from "./goal.js";
export * from "./model-directory.js";
export * from "./history.js";
/*
 * `subagent-manager.ts` was removed in Phase 2.
 *
 * It was a second, unused implementation of delegation: nothing in the repo
 * called `SubAgentManager.spawnSubAgent`, and it lacked the depth limit,
 * iteration cap and budget inheritance that the live path in `agent-loop.ts`
 * now has. Keeping both would have meant fixing every future guard twice and
 * discovering, later, that the wrong copy was the one in use.
 */
export * from "./agent-loop.js";
export * from "./orchestrator.js";
export * from "./turn-ledger.js";
export * from "./subagent-pool.js";
export * from "./attachment-images.js";
// The context engine: only what callers outside the loop need.
export {
  ContextEngine,
  budgetFor,
  parseBudgetOverrides,
  CHECKPOINT_MARK,
  statePathFor,
  resetIndexes,
  type ContextBudget,
  type ContextDebug,
  type TaskState,
} from "./context/index.js";
export * from "./skills/index.js";
export * from "./external-tools.js";

export { deepResearch, type DeepResearchOptions } from "./research-agent.js";
export * from "./personal.js";
