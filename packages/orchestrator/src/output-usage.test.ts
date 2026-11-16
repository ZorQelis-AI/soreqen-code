/**
 * The token numbers a person reads: what the model wrote, and how full the
 * context is, in the provider's own count (reported 6 Nov 2026: "the output
 * tokens it shows are quite wrong", beside Claude Code doing the same work).
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { LocalSandboxRunner } from "@sqcode/sandbox-runner";
import type { StreamEvent } from "@sqcode/shared";
import { runAgentTurn } from "./agent-loop.js";
import { MeterScale } from "./meter-scale.js";
import { resetIndexes } from "./context/repo-index.js";
import type { LLMChatOptions, LLMProvider, LLMResponseChunk } from "./types.js";

/** Two steps: a long thought and a write, then a short answer; each reports its usage. */
function scripted(input: () => number = () => 9_000): LLMProvider & { requests: LLMChatOptions[] } {
  const requests: LLMChatOptions[] = [];
  let step = 0;
  return {
    name: "scripted-usage",
    requests,
    async *chatStream(options: LLMChatOptions): AsyncIterable<LLMResponseChunk> {
      requests.push(options);
      step++;
      if (step === 1) {
        // About 9,000 characters of reasoning, all different (a repeated one reads as a stuck stream).
        yield {
          type: "reasoning",
          text: Array.from({ length: 200 }, (_, i) => `Option ${i} puts section ${(i * 7) % 13} under heading ${(i * 11) % 17}.`).join(" "),
        };
        yield { type: "tool_call_start", id: "w1", name: "write_file" };
        yield { type: "tool_call_complete", id: "w1", name: "write_file", input: { path: "notes.md", content: "# Notes\n" } };
        yield { type: "usage", inputTokens: input(), cachedTokens: 0, outputTokens: 1_900 };
        yield { type: "stop", reason: "tool_use" };
        return;
      }
      yield { type: "token", text: "Wrote notes.md." };
      yield { type: "usage", inputTokens: 9_500, cachedTokens: 8_800, outputTokens: 12 };
      yield { type: "stop", reason: "end_turn" };
    },
  };
}

describe("token numbers in the provider's count", () => {
  const wsId = `usage_ws_${Date.now()}`;
  let runner: LocalSandboxRunner;
  let dir: string;

  beforeEach(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "sqcode_usage_"));
    runner = new LocalSandboxRunner(dir);
    await runner.createWorkspace(wsId, { storagePath: dir });
  });

  afterEach(async () => {
    resetIndexes();
    await runner.destroyWorkspace(wsId);
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });

  it("counts output as the provider reported it, not by characters", async () => {
    const events: StreamEvent[] = [];
    const provider = scripted();
    const result = await runAgentTurn({
      workspaceId: wsId,
      sessionId: "s_usage",
      mode: "bypass",
      userMessage: "make a notes file",
      sandboxRunner: runner,
      llmProvider: provider,
      model: "scripted-usage-model",
      onEvent: (e) => {
        events.push(e);
      },
    });
    expect(result.stopReason).toBe("completed");
    // 1,900, then 12 for each later response (the answer, and the check of it), as reported;
    // the estimate would have said over 2,500 for the first step alone.
    expect(result.outputTokens).toBe(1_900 + 12 * (provider.requests.length - 1));
    const steps = events.filter((e) => e.type === "step_start") as { outputTokens?: number }[];
    expect(steps[1]?.outputTokens).toBe(1_900);
  });

  it("shows the meter at the ratio the provider's count bears to the estimate", async () => {
    const events: StreamEvent[] = [];
    await runAgentTurn({
      workspaceId: wsId,
      sessionId: "s_meter",
      mode: "bypass",
      userMessage: "make a notes file",
      sandboxRunner: runner,
      // The provider counts each request at 80% of what the meter estimated for it.
      llmProvider: scripted(() => {
        const last = [...events].reverse().find((e) => e.type === "context_usage") as { usage: { usedTokens: number } } | undefined;
        return Math.round((last?.usage.usedTokens ?? 10_000) * 0.8);
      }),
      model: "scripted-meter-model",
      onEvent: (e) => {
        events.push(e);
      },
    });
    const meters = events.filter((e) => e.type === "context_usage") as { usage: { usedTokens: number; compactAtTokens: number; breakdown: Record<string, number> } }[];
    expect(meters.length).toBeGreaterThanOrEqual(2);
    const [first, second] = meters as [(typeof meters)[number], (typeof meters)[number]];
    // A model not seen before: the first request is shown as estimated. The provider counted it at
    // 80% of that, so the second is shown at 80%, the system prompt (the same both times) with it.
    const ratio = Math.round(first.usage.usedTokens * 0.8) / first.usage.usedTokens;
    expect(Math.abs(second.usage.breakdown["system"]! - Math.round(first.usage.breakdown["system"]! * ratio))).toBeLessThanOrEqual(2);
    // The checkpoint mark moves with the meter, so the two still agree.
    expect(second.usage.compactAtTokens).toBeLessThan(first.usage.compactAtTokens);
  });
});

describe("MeterScale", () => {
  it("learns a model's ratio, ignores tiny or nonsensical requests, and moves smoothly", () => {
    const scale = new MeterScale();
    expect(scale.factor("m")).toBe(1);
    scale.observe("m", 500, 400); // too small to say anything
    expect(scale.factor("m")).toBe(1);
    scale.observe("m", 28_700, 23_000);
    expect(scale.factor("m")).toBeCloseTo(0.801, 2);
    scale.observe("m", 30_000, 900); // a count that cannot mean the whole request
    expect(scale.factor("m")).toBeCloseTo(0.801, 2);
    scale.observe("m", 30_000, 27_000);
    expect(scale.factor("m")).toBeCloseTo((0.801 + 0.9) / 2, 2);
    expect(scale.factor("other")).toBe(1);
  });
});
