/**
 * How the context window is spent, per model.
 *
 * A window is not one budget but several, in a fixed order of priority:
 *
 *   1. the reply              reserved first: a request with no room to answer
 *                             is a request that fails after it has been paid for
 *   2. instructions and tools the system prompt and tool schemas, always sent
 *   3. the working set        task state and retrieved evidence, rebuilt each step
 *   4. history                the conversation, which is the part that gives way
 *
 * History has a *soft* ceiling (`historyMax`) well below what physically fits.
 * Past it, low-value content is reduced first (stale and superseded output,
 * aged logs), and if that is not enough the history is checkpointed into task
 * state and rebuilt. The point is not to fill a million-token window because
 * it exists: every token sent is read, paid for, and competes for the model's
 * attention with the ones that matter.
 *
 * ## Configurable
 *
 * `SOREQEN_CONTEXT_BUDGETS` overrides any field, per model id or for all
 * (`"*"`), as JSON:
 *
 *     {"*": {"historyMax": 90000}, "mimo-v2.6-flash": {"workingSet": 10000}}
 *
 * A person's `/autocompaction` setting still applies: whichever is lower,
 * their threshold or `historyMax`, triggers a checkpoint.
 */

import { checkpointTierFor } from "@sqcode/shared";

export interface ContextBudget {
  window: number;
  /** Kept free for the model's answer. */
  reserveOutput: number;
  system: number;
  tools: number;
  /** Task state plus retrieved evidence. */
  workingSet: number;
  /** Of which, at most this much is task state. */
  stateMax: number;
  /** The soft ceiling on history sent per request. */
  historyMax: number;
  /** History size at which a checkpoint is made. */
  checkpointAt: number;
  /** Verbatim history kept after a checkpoint. */
  checkpointKeep: number;
  /**
   * Unread conversation that triggers a background read into task state,
   * ahead of the cut. See `extractAhead` in `state-checkpoint.ts`.
   */
  extractEvery: number;
  /** What physically fits, after everything reserved. */
  hardHistoryLimit: number;
  /** The most of the files being worked on put back after a cut. */
  restoreTokens: number;
}

export type BudgetOverrides = Partial<Pick<ContextBudget, "reserveOutput" | "workingSet" | "stateMax" | "historyMax" | "checkpointKeep" | "extractEvery">>;

export function parseBudgetOverrides(raw: string | undefined): Record<string, BudgetOverrides> {
  if (!raw?.trim()) return {};
  try {
    const parsed = JSON.parse(raw) as Record<string, BudgetOverrides>;
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

/** How much new conversation is read into task state at a time. */
export const EXTRACT_EVERY_TOKENS = 80_000;

/**
 * What a checkpoint aims to leave in the whole request, in tokens: system
 * prompt, tools, task state and conversation together, the number the meter
 * shows.
 *
 * It used to leave about 32k of *conversation*, on top of everything every
 * request carries; with 19k of system prompt and 43k of tools that read as
 * 100k on the meter, "even after a checkpoint" (reported 29 Oct 2026: "it
 * should be around 32K"). The verbatim tail and the files put back are now
 * what is left of this after the rest, never below the floors: a prompt and
 * tools bigger than the target still keep the last few steps word for word.
 */
export const CHECKPOINT_TARGET_TOTAL = 32_000;
/** The least verbatim tail a checkpoint keeps, whatever the rest weighs: the last few steps. */
export const CHECKPOINT_KEEP_MIN = 12_000;
/** The least of the working files a checkpoint puts back. */
export const CHECKPOINT_RESTORE_MIN = 3_000;

const clamp = (v: number, lo: number, hi: number): number => Math.max(lo, Math.min(hi, v));

export function budgetFor(input: {
  model?: string;
  window: number;
  systemTokens: number;
  toolTokens: number;
  maxOutputTokens?: number;
  /** The person's compaction threshold, in tokens of the whole request — only when they set one. */
  autoCompactTokens?: number;
  overrides?: Record<string, BudgetOverrides>;
}): ContextBudget {
  const { window } = input;
  const all = input.overrides ?? parseBudgetOverrides(process.env["SOREQEN_CONTEXT_BUDGETS"]);
  const o: BudgetOverrides = { ...(all["*"] ?? {}), ...(input.model ? (all[input.model] ?? {}) : {}) };

  const reserveOutput = o.reserveOutput ?? Math.min(input.maxOutputTokens ?? 32_768, Math.floor(window * 0.15));
  const workingSet = o.workingSet ?? clamp(Math.floor(window * 0.03), 3_000, 12_000);
  // Long sessions accumulate more state than a small window can show; a large one can afford more of it.
  const stateMax = o.stateMax ?? Math.min(Math.floor(workingSet * 0.45), window >= 500_000 ? 6_000 : 4_000);
  const hardHistoryLimit = Math.max(
    4_000,
    window - reserveOutput - input.systemTokens - input.toolTokens - workingSet,
  );
  /*
   * With no threshold of the person's own, history is checkpointed at
   * the window's tier (`checkpointTierFor`); with one, at theirs.
   *
   * The default cap was removed once, because a 1M-token model set to 100%
   * was checkpointed at about 16% while the meter promised 100%. That left a
   * session re-sending hundreds of thousands of tokens every step and never
   * checkpointing. The meter now shows this point (`effectiveCompactTokens`),
   * so the cap stays and nothing is promised that is not kept.
   */
  // Scaled to the window; see `checkpointTierFor`.
  const tier = checkpointTierFor(window);
  const defaultMax = input.autoCompactTokens === undefined ? tier.checkpointAt : hardHistoryLimit;
  const historyMax = Math.min(hardHistoryLimit, o.historyMax ?? defaultMax);

  // The person's threshold covers the whole request; history's share of it is what is left.
  const personal =
    input.autoCompactTokens !== undefined
      ? Math.max(2_000, input.autoCompactTokens - input.systemTokens - input.toolTokens - workingSet)
      : Infinity;
  const checkpointAt = Math.min(historyMax, personal, hardHistoryLimit);
  /*
   * After a cut the request is the system prompt, the tools, the task state
   * (in the working set) and what the cut kept: three quarters of the room
   * left under `CHECKPOINT_TARGET_TOTAL` is verbatim tail, a quarter the files
   * put back, each between its floor and the window tier's old size.
   */
  const room = CHECKPOINT_TARGET_TOTAL - input.systemTokens - input.toolTokens - stateMax;
  const keepForTotal = clamp(Math.floor(room * 0.75), CHECKPOINT_KEEP_MIN, tier.keep);
  const restoreForTotal = clamp(room - keepForTotal, CHECKPOINT_RESTORE_MIN, tier.restoreTokens);
  const checkpointKeep = Math.min(
    o.checkpointKeep ?? keepForTotal,
    Math.floor(checkpointAt * 0.5),
  );
  /*
   * Read every 80k of new conversation, and at least twice between cuts, so
   * a small window's checkpoint point is not reached with its whole stretch
   * still unread.
   */
  const extractEvery = Math.max(8_000, o.extractEvery ?? Math.min(tier.extractEvery, Math.floor(checkpointAt / 2)));

  return {
    window,
    reserveOutput,
    system: input.systemTokens,
    tools: input.toolTokens,
    workingSet,
    stateMax,
    historyMax,
    checkpointAt,
    checkpointKeep,
    extractEvery,
    hardHistoryLimit,
    restoreTokens: restoreForTotal,
  };
}
