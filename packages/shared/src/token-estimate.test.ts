/**
 * The estimator only has to be right enough to make good decisions.
 *
 * It is used to rank messages by cost and to keep a request inside a window —
 * never to bill anyone. So the properties that matter are monotonicity (bigger
 * text, bigger number), the safe direction at the margin (never *under*-count
 * badly), and a sane answer for a model nobody has heard of.
 */

import { describe, expect, it } from "vitest";
import {
  DEFAULT_CONTEXT_WINDOW,
  IMAGE_TOKENS,
  contextWindowFor,
  clearRegisteredContextWindows,
  parseTokenCount,
  registerContextWindow,
  estimateMessageTokens,
  estimateTokens,
  historyBudgetFor,
} from "./token-estimate.js";

describe("estimateTokens", () => {
  it("is zero only for empty input", () => {
    expect(estimateTokens("")).toBe(0);
    expect(estimateTokens("a")).toBeGreaterThan(0);
  });

  /*
   * A message that costs "nothing" is one a budget will happily keep an
   * unbounded number of — so the floor is 1, not 0.
   */
  it("never reports a non-empty string as free", () => {
    for (const s of ["a", ".", " ", "{}"]) {
      expect(estimateTokens(s)).toBeGreaterThanOrEqual(1);
    }
  });

  it("grows with length", () => {
    expect(estimateTokens("x".repeat(1_000))).toBeGreaterThan(estimateTokens("x".repeat(100)));
  });

  it("lands in the right order of magnitude for real text", () => {
    // ~1000 characters of prose is roughly 250-300 tokens; code is denser.
    const n = estimateTokens("the quick brown fox jumps over the lazy dog. ".repeat(23));
    expect(n).toBeGreaterThan(150);
    expect(n).toBeLessThan(500);
  });
});

describe("estimateMessageTokens", () => {
  it("counts structured content, not just strings", () => {
    const withBlocks = estimateMessageTokens({
      content: [{ type: "text", text: "x".repeat(400) }],
    });
    expect(withBlocks).toBeGreaterThan(80);
  });

  it("counts tool calls, which are otherwise invisible", () => {
    const bare = estimateMessageTokens({ content: "hi" });
    const withCalls = estimateMessageTokens({
      content: "hi",
      toolCalls: [{ id: "1", name: "read_file", input: { path: "src/a.ts" } }],
    });
    expect(withCalls).toBeGreaterThan(bare);
  });

  it("charges per-message overhead so many tiny messages are not free", () => {
    expect(estimateMessageTokens({ content: "" })).toBeGreaterThan(0);
  });

  it("counts a screenshot at what a model charges for it, not by the length of its base64", () => {
    // Reported 24 Sep 2026: compaction at a 21% meter — one 400 KB screenshot "cost" 100k tokens.
    const screenshot = "A".repeat(400_000);
    const tokens = estimateMessageTokens({
      content: [
        { type: "text", text: "Image from page.png:" },
        { type: "image", image_data: screenshot, media_type: "image/png" },
      ],
    });
    expect(tokens).toBeGreaterThan(IMAGE_TOKENS);
    expect(tokens).toBeLessThan(IMAGE_TOKENS + 100);
  });
});

describe("contextWindowFor", () => {
  it("matches dated model ids by prefix", () => {
    expect(contextWindowFor("claude-haiku-4-5-20251001")).toBe(200_000);
  });

  it("prefers the longest matching prefix", () => {
    // "gpt-4" is 8k, but "gpt-4o" is 128k — the more specific one must win
    // regardless of table order.
    expect(contextWindowFor("gpt-4o-2024-08-06")).toBe(128_000);
    expect(contextWindowFor("gpt-4")).toBe(8_192);
  });

  it("knows the default models' one-million-token windows", () => {
    expect(contextWindowFor("mimo-v2.5")).toBe(1_000_000);
    expect(contextWindowFor("deepseek-flash")).toBe(1_000_000);
    expect(contextWindowFor("deepseek-4.1-flash")).toBe(1_000_000);
  });

  it("is case-insensitive", () => {
    expect(contextWindowFor("MiMo-V2.5")).toBe(1_000_000);
  });

  it("prefers a window learned at run time over the table", () => {
    registerContextWindow("brand-new-model", 400_000);
    try {
      expect(contextWindowFor("Brand-New-Model")).toBe(400_000);
      registerContextWindow("mimo-v2.5", 262_144);
      expect(contextWindowFor("mimo-v2.5")).toBe(262_144);
    } finally {
      clearRegisteredContextWindows();
    }
    expect(contextWindowFor("brand-new-model")).toBe(DEFAULT_CONTEXT_WINDOW);
  });

  it("reads token counts as people write them", () => {
    expect(parseTokenCount("1m")).toBe(1_000_000);
    expect(parseTokenCount("256K")).toBe(256_000);
    expect(parseTokenCount("1_000_000")).toBe(1_000_000);
    expect(parseTokenCount(128000)).toBe(128_000);
    expect(parseTokenCount("lots")).toBeNull();
    expect(parseTokenCount("")).toBeNull();
  });

  /*
   * Guessing large on an unknown model sends a request the provider rejects,
   * after paying to transmit it. Guessing small only compacts more than
   * necessary. So the default is deliberately small.
   */
  it("falls back small for anything unrecognised", () => {
    expect(contextWindowFor("some-new-model-2027")).toBe(DEFAULT_CONTEXT_WINDOW);
    expect(contextWindowFor(undefined)).toBe(DEFAULT_CONTEXT_WINDOW);
    expect(DEFAULT_CONTEXT_WINDOW).toBeLessThan(64_000);
  });
});

describe("historyBudgetFor", () => {
  it("uses a listed window over the name table (18 Nov 2026: hosted models checkpointed every step)", () => {
    const listed = historyBudgetFor({ model: "hy4-flash", windowTokens: 1_000_000, systemPromptTokens: 9_000, toolSchemaTokens: 14_000, maxOutputTokens: 32_768 });
    expect(listed).toBe(1_000_000 - 9_000 - 14_000 - 32_768);
    // The negative control: by name alone the table does not know it, and the budget falls to its floor.
    expect(historyBudgetFor({ model: "hy4-flash", systemPromptTokens: 9_000, toolSchemaTokens: 14_000, maxOutputTokens: 32_768 })).toBe(4_000);
  });

  it("reserves room for the system prompt, the schemas and the reply", () => {
    const budget = historyBudgetFor({
      model: "gpt-4o",
      systemPromptTokens: 3_000,
      toolSchemaTokens: 5_000,
      maxOutputTokens: 8_000,
    });
    expect(budget).toBe(128_000 - 3_000 - 5_000 - 8_000);
  });

  /*
   * The reply is the part a naive check misses, and it is the one that makes
   * a request fail *after* the whole prompt has been paid for.
   */
  it("leaves space for output even when none is specified", () => {
    const budget = historyBudgetFor({
      model: "gpt-4o",
      systemPromptTokens: 0,
      toolSchemaTokens: 0,
    });
    expect(budget).toBeLessThan(128_000);
  });

  it("never returns a budget so small that nothing fits", () => {
    const budget = historyBudgetFor({
      model: "gpt-4",
      systemPromptTokens: 500_000,
      toolSchemaTokens: 500_000,
      maxOutputTokens: 500_000,
    });
    expect(budget).toBeGreaterThanOrEqual(4_000);
  });
});

/**
 * Properties of the tool definitions themselves.
 *
 * Lives here rather than in its own file because it is small and shares the
 * package. The reason it exists at all: a tool description is *prompt*, and it
 * is the only prompt the model reads at the moment it chooses an action. A
 * description that has drifted out of date does not fail a build — it quietly
 * makes every decision that uses it worse.
 */
describe("tool definitions", () => {
  it("describes every tool", async () => {
    const { SOREQEN_TOOL_DEFINITIONS } = await import("./tools.js");
    for (const t of SOREQEN_TOOL_DEFINITIONS) {
      expect(t.description?.trim().length ?? 0).toBeGreaterThan(40);
    }
  });

  /*
   * `spawn_subagent` claimed delegation ran "in parallel". It never did — it
   * is deliberately excluded from PARALLEL_SAFE_TOOLS, because a nested agent
   * turn mutates the workspace. The model was being told the opposite of the
   * truth at the exact moment it decided whether to delegate.
   */
  it("does not claim parallelism for tools that run sequentially", async () => {
    const { SOREQEN_TOOL_DEFINITIONS, isParallelSafe } = await import("./tools.js");
    for (const t of SOREQEN_TOOL_DEFINITIONS) {
      if (isParallelSafe(t.name)) continue;
      // Explicit denials are the point, not a violation — the corrected
      // `spawn_subagent` text reads "Runs sequentially, not in parallel", and
      // a bare substring match flagged the very fix it was written to enforce.
      const claim = (t.description ?? "").replace(/\bnot in parallel\b/gi, "");
      expect(
        /\bin parallel\b/i.test(claim),
        `${t.name} runs sequentially but its description claims parallelism`,
      ).toBe(false);
    }
  });

  it("warns that write_file destroys existing contents", async () => {
    const { SOREQEN_TOOL_DEFINITIONS } = await import("./tools.js");
    const write = SOREQEN_TOOL_DEFINITIONS.find((t) => t.name === "write_file")!;
    expect(write.description).toMatch(/destructive|replace|overwrit/i);
  });
});
