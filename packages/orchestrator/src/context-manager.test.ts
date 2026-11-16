/**
 * Fitting a turn into the window without losing the thread.
 *
 * Compaction is the easiest place in an agent to introduce a bug nobody can
 * see. It does not throw, it does not fail a build, and the only symptom is
 * that the model gets subtly stupider as a session goes on — it forgets the
 * goal, or re-reads a file it already read, or answers a question it was asked
 * twenty messages ago. So the properties worth testing are the ones a person
 * would never notice being broken.
 */

import { describe, expect, it } from "vitest";
import { estimateTokens } from "@sqcode/shared";
import { compactHistory, estimateHistoryTokens, truncateToolResult } from "./context-manager.js";
import type { LLMMessage } from "./types.js";

const GOAL = "Initial Goal: fix the payment gateway timeout.";

function toolResult(id: string, chars: number): LLMMessage {
  return { role: "tool", toolCallId: id, content: "x".repeat(chars) };
}

describe("capping a single tool result", () => {
  it("leaves small output alone", () => {
    const small = "all 12 tests passed";
    expect(truncateToolResult(small, 1_000)).toBe(small);
  });

  /*
   * Head *and* tail, not a prefix.
   *
   * The old implementation kept the first 200 characters. A test runner puts
   * its summary at the bottom, so that reliably threw away the only line that
   * said whether the run passed — and left the agent confidently reasoning
   * about the header.
   */
  it("keeps both ends, because the conclusion is usually at the bottom", () => {
    const content = `FIRST_LINE\n${"filler ".repeat(5_000)}\nRESULT: 3 tests failed`;
    const out = truncateToolResult(content, 200);
    expect(out).toContain("FIRST_LINE");
    expect(out).toContain("RESULT: 3 tests failed");
  });

  it("says how much it dropped rather than hiding the gap", () => {
    const out = truncateToolResult("y".repeat(50_000), 200);
    expect(out).toMatch(/omitted from the middle/);
    expect(out).toMatch(/characters/);
  });

  it("actually gets near the budget", () => {
    const out = truncateToolResult("z".repeat(100_000), 500);
    // Marker text adds a little; the point is orders of magnitude, not exactness.
    expect(estimateTokens(out)).toBeLessThan(900);
  });
});

describe("one huge read cannot evict the conversation", () => {
  /*
   * The failure the old message-counting version could not even represent:
   * a single `read_file` on a large file is *one message*, so it was free
   * under a message-count rule, and on its own it exceeded the window.
   */
  it("caps an oversized tool result even when the history is short", () => {
    const history: LLMMessage[] = [
      { role: "user", content: GOAL },
      toolResult("call_1", 400_000),
      { role: "assistant", content: "Got it." },
    ];

    const out = compactHistory(history, { maxTokens: 100_000, maxToolResultTokens: 2_000 });

    expect(out).toHaveLength(3);
    expect(estimateHistoryTokens(out)).toBeLessThan(10_000);
    expect(out[0]?.content).toBe(GOAL);
    expect(out[2]?.content).toBe("Got it.");
  });

  it("does not touch a history that already fits", () => {
    const history: LLMMessage[] = [
      { role: "user", content: GOAL },
      { role: "assistant", content: "Reading the file." },
      toolResult("call_1", 100),
    ];
    expect(compactHistory(history, { maxTokens: 50_000 })).toEqual(history);
  });

  it("handles an empty history", () => {
    expect(compactHistory([])).toEqual([]);
  });
});

describe("what is never given up", () => {
  const long = (): LLMMessage[] => {
    const h: LLMMessage[] = [{ role: "user", content: GOAL }];
    for (let i = 0; i < 40; i++) {
      h.push({ role: "assistant", content: `step ${i}`, toolCalls: [] });
      h.push(toolResult(`call_${i}`, 8_000));
    }
    h.push({ role: "assistant", content: "FINAL THOUGHT" });
    return h;
  };

  it("keeps the goal, which is the one thing it cannot re-derive", () => {
    const out = compactHistory(long(), { maxTokens: 8_000 });
    expect(out[0]?.content).toBe(GOAL);
  });

  it("keeps the most recent message", () => {
    const out = compactHistory(long(), { maxTokens: 8_000 });
    expect(out[out.length - 1]?.content).toBe("FINAL THOUGHT");
  });

  it("gets under budget", () => {
    const out = compactHistory(long(), { maxTokens: 8_000 });
    expect(estimateHistoryTokens(out)).toBeLessThanOrEqual(8_000);
  });

  /*
   * A `tool` message whose call still exists in history must not vanish
   * outright — several provider APIs reject a tool_use with no matching
   * tool_result, which turns a compaction bug into a hard 400.
   */
  it("stubs dropped tool results instead of deleting them", () => {
    const out = compactHistory(long(), { maxTokens: 8_000 });
    const stubs = out.filter(
      (m) => m.role === "tool" && String(m.content).includes("dropped to fit"),
    );
    expect(stubs.length).toBeGreaterThan(0);
    for (const m of out) {
      if (m.role === "tool") expect(m.toolCallId).toBeTruthy();
    }
  });

  it("tells the model that something was removed", () => {
    const out = compactHistory(long(), { maxTokens: 8_000 });
    expect(JSON.stringify(out)).toMatch(/omitted|dropped/i);
  });

  it("spends the largest messages first", () => {
    // One giant result among small ones: it should go before they do.
    const history: LLMMessage[] = [
      { role: "user", content: GOAL },
      toolResult("small_a", 400),
      toolResult("giant", 200_000),
      toolResult("small_b", 400),
      { role: "assistant", content: "a" },
      { role: "assistant", content: "b" },
      { role: "assistant", content: "c" },
      { role: "assistant", content: "d" },
      { role: "assistant", content: "e" },
      { role: "assistant", content: "f" },
      { role: "assistant", content: "g" },
      { role: "assistant", content: "h" },
      { role: "assistant", content: "FINAL" },
    ];
    const out = compactHistory(history, { maxTokens: 3_000, maxToolResultTokens: 100_000 });
    const byId = new Map(out.filter((m) => m.role === "tool").map((m) => [m.toolCallId, m]));
    expect(String(byId.get("giant")?.content)).toContain("dropped to fit");
    expect(String(byId.get("small_a")?.content)).toBe("x".repeat(400));
  });
});

describe("it does not mutate what it was given", () => {
  it("leaves the caller's history intact", () => {
    const history: LLMMessage[] = [
      { role: "user", content: GOAL },
      toolResult("call_1", 200_000),
      { role: "assistant", content: "done" },
    ];
    const before = JSON.stringify(history);
    compactHistory(history, { maxTokens: 1_000, maxToolResultTokens: 100 });
    // The full history is what gets persisted and replayed; only the copy sent
    // to the model is allowed to be lossy.
    expect(JSON.stringify(history)).toBe(before);
  });
});
