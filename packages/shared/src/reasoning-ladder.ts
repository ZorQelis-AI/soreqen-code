/**
 * How SoreQen Code's six effort tiers become a model's own thinking levels.
 *
 * ## The problem
 *
 * Models do not agree on how many thinking levels they have. OpenAI's
 * reasoning models say low / medium / high, the newest add xhigh and max,
 * some older ones only low / medium / high, and plenty of endpoints have one
 * level of thinking and nothing to choose. SoreQen Code has six tiers: Low,
 * Medium, High, Extra, Max and Apex. Sending the tier's name and hoping only
 * works when the two ladders happen to be the same length.
 *
 * ## The rule
 *
 * A model's levels are its *ladder*, weakest to strongest. The six tiers are
 * spread over it evenly, Max and Apex sharing the top (Apex is a different
 * way of working, not a different amount of thinking per call):
 *
 *   3 levels  low, medium, high              Low+Medium → low, High+Extra → medium, Max+Apex → high
 *   5 levels  low … xhigh, max               Low → low, Medium → medium, High → high, Extra → xhigh, Max+Apex → max
 *
 * and the same for any other length (see `RUNGS`). A model with six or more
 * levels gives Apex a level of its own.
 *
 * ## Never off
 *
 * No tier switches thinking off, on any model, and neither do SoreQen's own
 * helper calls (summaries, memory, checkpoints): the weakest anything asks for
 * is the model's lowest level of thinking. "none" and "minimal" are not on a
 * ladder for that reason; they are the same as off in practice.
 *
 * ## Where a ladder comes from
 *
 *   1. what the model told us: a refusal lists the values it accepts, and the
 *      ladder is learned from it (`ladderFromRefusal`);
 *   2. the deployment's own catalogue line, when it states one;
 *   3. the family table below;
 *   4. the API's usual three (low, medium, high).
 *
 * Budgets: where a model thinks to a token budget instead of a named level,
 * each tier's `thinkingBudget` (2K, 4K, 8K, 16K, 32K, 64K) is what is asked for.
 */

import { EFFORT, EFFORTS, type Effort } from "./effort.js";

/** Thinking levels as OpenAI-style APIs spell them, weakest to strongest. */
export const THINKING_LEVELS = ["low", "medium", "high", "xhigh", "max"] as const;
export type ThinkingLevel = (typeof THINKING_LEVELS)[number];

/** Which wire a model is reached on: the two have different families of models behind them. */
export type ReasoningApi = "responses" | "chat";

/**
 * Which rung each tier takes, for a ladder of each length, tiers in
 * `EFFORTS` order (low, medium, high, extra, max, apex).
 */
const RUNGS: Record<number, readonly number[]> = {
  1: [0, 0, 0, 0, 0, 0],
  2: [0, 0, 0, 1, 1, 1],
  3: [0, 0, 1, 1, 2, 2],
  4: [0, 1, 1, 2, 3, 3],
  5: [0, 1, 2, 3, 4, 4],
};

/** The rung a tier takes on a ladder of `size` levels. */
export function rungFor(effort: Effort, size: number): number {
  if (size <= 1) return 0;
  const tier = EFFORTS.indexOf(effort);
  const table = RUNGS[size];
  if (table) return table[tier]!;
  // Six or more: every tier its own rung, spread over the whole ladder.
  return Math.round((tier * (size - 1)) / (EFFORTS.length - 1));
}

/** The level a tier asks a model for. */
export function levelOn(effort: Effort, ladder: readonly string[]): string {
  const levels = ladder.length > 0 ? ladder : DEFAULT_LADDER.chat;
  return levels[rungFor(effort, levels.length)]!;
}

/** Thinking tokens a tier asks for, where a model thinks to a budget. */
export function thinkingBudgetFor(effort: Effort): number {
  return EFFORT[effort].thinkingBudget;
}

const DEFAULT_LADDER: Record<ReasoningApi, readonly ThinkingLevel[]> = {
  // Learned down from here on the first refusal, which lists what the model takes.
  responses: ["low", "medium", "high", "xhigh", "max"],
  chat: ["low", "medium", "high"],
};

/**
 * Families whose levels are published, longest prefix first wins. Only where
 * the levels are a documented fact; everything else starts from the default
 * and learns from its first refusal.
 */
const FAMILIES: ReadonlyArray<readonly [prefix: string, ladder: readonly ThinkingLevel[]]> = [
  // GPT 6: none, minimal, low, medium, high, xhigh, max (measured 24 Sep 2026).
  ["gpt-6", ["low", "medium", "high", "xhigh", "max"]],
  ["gpt-5.2", ["low", "medium", "high", "xhigh"]],
  ["gpt-5.3", ["low", "medium", "high", "xhigh"]],
  ["gpt-5.4", ["low", "medium", "high", "xhigh"]],
  ["gpt-5.5", ["low", "medium", "high", "xhigh"]],
  ["gpt-5", ["low", "medium", "high"]],
  ["o1", ["low", "medium", "high"]],
  ["o3", ["low", "medium", "high"]],
  ["o4", ["low", "medium", "high"]],
  /*
   * Claude with adaptive thinking takes effort as a level. The newest take all
   * five; a model that takes fewer says which in its refusal, and is learned.
   */
  ["claude-opus-5", ["low", "medium", "high", "xhigh", "max"]],
  ["claude-sonnet-5", ["low", "medium", "high", "xhigh", "max"]],
  ["claude-haiku-5", ["low", "medium", "high", "xhigh", "max"]],
  ["claude-fable", ["low", "medium", "high", "xhigh", "max"]],
  ["claude-mythos", ["low", "medium", "high", "xhigh", "max"]],
  ["claude-opus-4-8", ["low", "medium", "high", "xhigh", "max"]],
  ["claude-opus-4-7", ["low", "medium", "high", "xhigh", "max"]],
  ["claude-opus-4-6", ["low", "medium", "high", "max"]],
  ["claude-sonnet-4-6", ["low", "medium", "high", "max"]],
  ["gemini-3", ["low", "high"]],
  ["gemini-2.5", ["low", "medium", "high"]],
];

const registered = new Map<string, ThinkingLevel[]>();

function key(model: string): string {
  // "openai/gpt-6-luna" and "gpt-6-luna" are the same model.
  return model.trim().toLowerCase().replace(/^.*\//, "");
}

/** Keep only real thinking levels, weakest first, each once. */
export function cleanLadder(levels: readonly string[]): ThinkingLevel[] {
  const wanted = new Set(levels.map((l) => l.trim().toLowerCase()));
  return THINKING_LEVELS.filter((l) => wanted.has(l));
}

/** Record a model's ladder: from its catalogue line, or learned from what it refused. */
export function registerReasoningLadder(model: string, levels: readonly string[]): void {
  const ladder = cleanLadder(levels);
  if (ladder.length > 0 && model.trim()) registered.set(key(model), ladder);
}

/** For tests. */
export function clearReasoningLadders(): void {
  registered.clear();
}

/** A model's thinking levels, weakest to strongest. Never empty. */
export function reasoningLadderFor(model: string | undefined, api: ReasoningApi): readonly ThinkingLevel[] {
  if (model) {
    const name = key(model);
    const known = registered.get(name);
    if (known) return known;
    let best: readonly ThinkingLevel[] | null = null;
    let bestLength = 0;
    for (const [prefix, ladder] of FAMILIES) {
      if (name.startsWith(prefix) && prefix.length > bestLength) {
        best = ladder;
        bestLength = prefix.length;
      }
    }
    if (best) return best;
  }
  return DEFAULT_LADDER[api];
}

/**
 * The values a refusal says a model accepts.
 *
 * OpenAI answers an unsupported effort with the list ("Supported values are:
 * 'none', 'minimal', 'low', 'medium', 'high' and 'xhigh'"), which is the
 * model's ladder in its own words. Null when the message lists none.
 */
export function ladderFromRefusal(message: string): ThinkingLevel[] | null {
  // OpenAI's wording, and Anthropic's validator's ("Input should be 'low', 'medium' or 'high'").
  const list = /supported values|must be one of|expected one of|valid values|input should be/i.exec(message);
  if (!list) return null;
  // Only what follows the list's heading: the value it refused is named before it.
  const quoted = [...message.slice(list.index).matchAll(/['"`]([a-z]+)['"`]/gi)].map((m) => m[1]!.toLowerCase());
  const ladder = cleanLadder(quoted);
  return ladder.length > 0 ? ladder : null;
}

/** The same ladder without its top level, for a refusal that does not say what it takes. */
export function ladderBelow(ladder: readonly ThinkingLevel[], refused: string): ThinkingLevel[] {
  const at = ladder.indexOf(refused as ThinkingLevel);
  const rest = at >= 0 ? ladder.slice(0, at) : ladder.slice(0, -1);
  return rest.length > 0 ? [...rest] : ["low"];
}

/** Which level each tier gets on a ladder, for a picker or a settings page. */
export function tierMapping(ladder: readonly string[]): Record<Effort, string> {
  return Object.fromEntries(EFFORTS.map((e) => [e, levelOn(e, ladder)])) as Record<Effort, string>;
}
