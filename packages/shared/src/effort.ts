/**
 * Reasoning effort, and the sixth stop that only exists here.
 *
 * ## The five, and why they are copied rather than imported
 *
 * The platform — the website, the apps, the console — ships a five-stop effort
 * selector defined in `@soreqen/config`'s `models.ts`: **low, medium, high,
 * extra, max**. The names are reproduced here exactly; the thinking budgets
 * are SoreQen Code's own (5 Oct 2026): 2K / 4K / 8K / 16K / 32K, and 64K for
 * Apex, with thinking never switched off.
 *
 * They are copied because SoreQen Code is a separate workspace with its own
 * dependency graph, and a CLI that people install standalone cannot reach into
 * the platform monorepo. That is a real duplication and it can drift, so it is
 * marked: `PLATFORM_EFFORTS` below is the contract, and `effort.test.ts` pins
 * the budgets. If the platform changes a number, that test is where it should
 * be noticed.
 *
 * ## The sixth: Apex
 *
 * Coding is where extra deliberation actually pays, and it is the one surface
 * where a user can reasonably be asked to spend more for a better answer on
 * purpose. So SoreQen Code adds one stop above `max`.
 *
 * **It is not simply a bigger thinking budget.** A larger number on its own
 * buys a longer monologue and very little else — the thing that makes a coding
 * agent right is not more thinking per call, it is more *verification* per
 * turn. So Apex changes the shape of the turn:
 *
 *   - the strong model handles every step, with routing to a cheaper model
 *     switched off;
 *   - the agent reviews its own complete diff before it is allowed to finish;
 *   - the tests covering the changed files run, not just a typecheck;
 *   - it gets more loop iterations and more attempts at fixing its own
 *     verification failures;
 *   - delegation to sub-agents is available.
 *
 * That is a tier you can justify charging for, because each item is a
 * discrete, checkable thing the cheaper tiers do not do.
 *
 * It is deliberately not named after anyone else's. `ultrathink` and
 * `ultracode` are Anthropic's; this is the top of the ladder
 * Low → Medium → High → Extra → **Apex**.
 */

import { z } from "zod";

/**
 * The platform's five, in order. Kept in step with `@soreqen/config`.
 *
 * Exported separately from `EFFORTS` so a surface that must match the website
 * exactly — a shared billing table, a settings screen that mirrors the app —
 * can iterate the five without accidentally offering the CLI-only sixth.
 */
export const PLATFORM_EFFORTS = ["low", "medium", "high", "extra", "max"] as const;

export const EFFORTS = [...PLATFORM_EFFORTS, "apex"] as const;
export type Effort = (typeof EFFORTS)[number];

export const EffortSchema = z.enum(EFFORTS);

/**
 * How much a thinking model is asked to reason: the tier itself.
 *
 * A provider turns a tier into the model's own level (`reasoning-ladder.ts`):
 * the six tiers are spread over however many levels the model has, and a model
 * that thinks to a token budget is given the tier's `thinkingBudget`. No tier
 * switches thinking off.
 */
export type ReasoningLevel = Effort;

export interface EffortSpec {
  id: Effort;
  label: string;
  /** One line, shown under the label in a picker. */
  summary: string;
  /** Thinking tokens asked for, where a model thinks to a budget. Never 0: no tier switches thinking off. */
  thinkingBudget: number;
  temperature: number;
  topP: number;
  /** Floor on a sampled token's probability relative to the most likely one.
   *  Trims the tail top-p leaves behind on flat distributions. */
  minP: number;

  // ---- the agentic half, which is what makes these mean anything here ----

  /**
   * How the agent is told to work at this tier, in the system prompt.
   *
   * The behavioural half of effort, and the one every model honours: how far
   * to explore before editing, how much to plan, how much to verify. A model
   * that ignores reasoning parameters still reads its instructions.
   */
  guidance: string;
  /** Rounds of "your change does not pass the project's own checks". */
  maxHealAttempts: number;
  /** Whether cheaper models may handle mechanical steps. Off at the top,
   *  where the point is quality rather than margin. */
  allowModelRouting: boolean;
  /** Whether the agent must read its own complete diff before finishing. */
  selfReviewDiff: boolean;
  /** Whether verification runs the tests covering changed files, or stops at
   *  a typecheck. */
  /**
   * Run the tests covering any file the turn changed, before it may finish.
   *
   * On from `medium` upward, which is a deliberate rebalance. The tiers used
   * to scale almost entirely on `maxIterations` — 10 at low to 60 at apex —
   * while this and `selfReviewDiff` stayed off until `extra` and `max`. So the
   * tiers people actually select bought *more chances to be wrong*, and the
   * machinery that catches being wrong was reserved for tiers they rarely
   * choose.
   *
   * The trade is favourable in the obvious direction: running the tests that
   * already cover the changed files costs one command, against fifteen extra
   * model round trips. `test-selector.ts` was already written and already
   * doing this for the top tiers.
   */
  runAffectedTests: boolean;
  /**
   * Whether the agent may delegate to sub-agents.
   *
   * The top two tiers only, and they use it differently: Max delegates
   * selectively, Apex runs a team (see `subagentConcurrencyFor`). It used to be
   * on from High upward, which put a full nested agent turn — the most
   * expensive single thing the harness can do — inside the tier most people
   * leave selected. Below Max, the agent does the work itself.
   */
  allowDelegation: boolean;
  /** True for the tier that needs saying out loud before it is entered. */
  isPremium: boolean;
}

export const EFFORT: Record<Effort, EffortSpec> = {
  low: {
    id: "low",
    label: "Low",
    summary: "Quick and light. For small, clear changes.",
    thinkingBudget: 2048,
    temperature: 0.7,
    topP: 0.9,
    minP: 0.05,
    guidance:
      "Effort is LOW. Move fast: read only what the change needs, skip broad exploration, keep " +
      "the plan in your head unless the task genuinely has several steps, and verify with the " +
      "single cheapest check that proves the change works.",
    maxHealAttempts: 1,
    allowModelRouting: true,
    selfReviewDiff: false,
    runAffectedTests: false,
    allowDelegation: false,
    isPremium: false,
  },
  medium: {
    id: "medium",
    label: "Medium",
    summary: "Balanced. The everyday setting.",
    thinkingBudget: 4096,
    temperature: 0.7,
    topP: 0.9,
    minP: 0.05,
    guidance:
      "Effort is MEDIUM. Explore enough to be confident before editing, plan multi-step work " +
      "with the todo list, and verify what you changed before you finish.",
    maxHealAttempts: 2,
    allowModelRouting: true,
    selfReviewDiff: false,
    runAffectedTests: true,
    allowDelegation: false,
    isPremium: false,
  },
  high: {
    id: "high",
    label: "High",
    summary: "Plans first and checks each step.",
    thinkingBudget: 8192,
    temperature: 0.6,
    topP: 0.9,
    minP: 0.05,
    guidance:
      "Effort is HIGH. Understand the surrounding code before editing — callers, conventions, " +
      "existing tests. Write a concrete plan, consider edge cases as you implement, and verify " +
      "each meaningful step rather than only the end result.",
    maxHealAttempts: 2,
    allowModelRouting: true,
    selfReviewDiff: false,
    runAffectedTests: true,
    allowDelegation: false,
    isPremium: false,
  },
  extra: {
    id: "extra",
    label: "Extra",
    summary: "Investigates deeply. For tricky work.",
    thinkingBudget: 16_384,
    temperature: 0.6,
    topP: 0.9,
    minP: 0.05,
    guidance:
      "Effort is EXTRA. Investigate thoroughly before editing: trace how the affected code is " +
      "used and tested. Weigh the alternatives for any non-obvious decision, handle edge cases " +
      "explicitly, and verify each step and then the whole change.",
    maxHealAttempts: 3,
    allowModelRouting: true,
    selfReviewDiff: false,
    runAffectedTests: true,
    allowDelegation: false,
    isPremium: false,
  },
  max: {
    id: "max",
    label: "Max",
    summary: "Exhaustive, and reviews its own changes.",
    thinkingBudget: 32_768,
    temperature: 0.5,
    topP: 0.95,
    minP: 0.03,
    guidance:
      "Effort is MAX. Be exhaustive: trace every path your change affects, handle failure modes " +
      "and edge cases explicitly, run every relevant check, and re-read your complete change " +
      "before you finish. Your diff will be reviewed against the request.",
    maxHealAttempts: 3,
    allowModelRouting: true,
    selfReviewDiff: true,
    runAffectedTests: true,
    allowDelegation: true,
    isPremium: false,
  },
  apex: {
    id: "apex",
    label: "Apex",
    summary: "The most thorough. For work that must be right.",
    thinkingBudget: 65_536,
    /*
     * Lower temperature than every tier below it.
     *
     * The instinct at the top of a ladder is to turn everything up, but
     * sampling temperature is not an effort dial — it is a diversity dial.
     * Apex exists for the change you want to be *right*, where a second
     * plausible-but-different answer has negative value. More thinking, less
     * wandering.
     */
    temperature: 0.4,
    topP: 0.95,
    minP: 0.02,
    guidance:
      "Effort is APEX. Correctness is the only goal. Prefer the more robust approach even when it " +
      "is slower, prove each claim with a check rather than an argument, and before finishing " +
      "review your own work adversarially — as the most demanding senior reviewer would — and fix " +
      "everything that review would reject.",
    maxHealAttempts: 4,
    // The one tier that never hands a step to a cheaper model.
    allowModelRouting: false,
    selfReviewDiff: true,
    runAffectedTests: true,
    allowDelegation: true,
    isPremium: true,
  },
};

export const DEFAULT_EFFORT: Effort = "medium";

export function isEffort(v: string): v is Effort {
  return (EFFORTS as readonly string[]).includes(v);
}

export function effortSpec(effort: Effort): EffortSpec {
  return EFFORT[effort];
}

/** Effort as an ordinal, for comparisons. Never persist this — the order is
 *  an implementation detail and inserting a tier would change every stored
 *  value. */
export function effortRank(effort: Effort): number {
  return EFFORTS.indexOf(effort);
}

export function atLeast(effort: Effort, floor: Effort): boolean {
  return effortRank(effort) >= effortRank(floor);
}

/**
 * Parse an effort from what someone typed.
 *
 * `apex` is also reachable by the words people actually use when they want it
 * — "maximum effort", "think harder" — because the tier is worthless if the
 * only way to find it is reading the docs. Aliases cost nothing.
 */
const ALIASES: Record<string, Effort> = {
  low: "low",
  fast: "low",
  quick: "low",
  none: "low",
  medium: "medium",
  med: "medium",
  normal: "medium",
  default: "medium",
  high: "high",
  deep: "high",
  extra: "extra",
  deeper: "extra",
  max: "max",
  maximum: "max",
  apex: "apex",
  peak: "apex",
  hardest: "apex",
  think_harder: "apex",
  "beyond-max": "apex",
};

export function parseEffort(raw: string): Effort | null {
  const key = raw.trim().toLowerCase().replace(/[\s-]+/g, "_");
  return ALIASES[key] ?? ALIASES[key.replace(/_/g, "-")] ?? null;
}

/**
 * Whether a prompt asks for Apex in passing.
 *
 * The keyword is recognised inside an ordinary sentence — "fix the parser,
 * apex" — because that is how people reach for a top tier in practice, mid-
 * thought rather than by opening a menu. Matched on a word boundary so a file
 * called `apex.ts` does not silently triple the cost of a turn.
 */
export function requestsApex(prompt: string): boolean {
  return /\bapex\b/i.test(prompt);
}

/** Effort levels as flat data, for a picker or `--help`. */
export function listEfforts(includeApex = true): EffortSpec[] {
  return (includeApex ? EFFORTS : PLATFORM_EFFORTS).map((e) => EFFORT[e]);
}
