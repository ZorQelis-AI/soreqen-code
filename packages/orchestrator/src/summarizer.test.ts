/**
 * Condensing a long session.
 *
 * The properties that matter are the ones a person would never see break: a
 * summary must not keep a tool call while replacing its result, must say what
 * it replaced, and must never cost the turn when it cannot be written.
 */

import { describe, expect, it } from "vitest";
import type { LLMMessage, LLMProvider } from "./types.js";
import { SUMMARY_PREFIX, isSummaryMessage, renderTranscript, splitForSummary, summarizeHistory } from "./summarizer.js";
import { TurnCancelledError } from "./resilience.js";

function session(steps: number): LLMMessage[] {
  const h: LLMMessage[] = [{ role: "user", content: "Build the game.", id: "m0" }];
  for (let i = 0; i < steps; i++) {
    h.push({
      role: "assistant",
      content: `Step ${i}.`,
      toolCalls: [{ id: `c${i}`, name: "read_file", input: { path: `f${i}.ts` } }],
      id: `a${i}`,
    });
    h.push({ role: "tool", toolCallId: `c${i}`, content: "z".repeat(4_000), id: `t${i}` });
  }
  h.push({ role: "assistant", content: "Continuing.", id: "last" });
  return h;
}

const writes = (text: string): LLMProvider => ({
  name: "fake",
  async *chatStream() {
    yield { type: "reasoning", text: "thinking about it" };
    yield { type: "token", text };
    yield { type: "stop", reason: "end_turn" };
  },
});

const fails = (err: Error): LLMProvider => ({
  name: "fake",
  async *chatStream() {
    throw err;
  },
});

describe("where the cut goes", () => {
  it("cuts between whole units, never between a call and its result", () => {
    const history = session(12);
    const cut = splitForSummary(history, 3_000);
    expect(cut).not.toBeNull();
    expect(history[cut!]!.role).not.toBe("tool");
  });

  it("keeps at least the last two units, however large", () => {
    const history = session(6);
    const cut = splitForSummary(history, 1);
    // The last two units: the final plain message and the call before it.
    expect(history.length - cut!).toBeGreaterThanOrEqual(3);
  });

  // 16 Oct 2026: a cut must leave under 64k, even when the last outputs are huge.
  it("keeps one unit, not two, when two would pass the ceiling", () => {
    const history = session(6);
    for (const m of history) if (m.role === "tool") m.content = "z".repeat(300_000);
    const cut = splitForSummary(history, 24_000)!;
    // The final message only: the call before it would bring the tail past 64k.
    expect(history.length - cut).toBe(1);
  });

  it("declines when there is nothing worth condensing", () => {
    expect(splitForSummary([{ role: "user", content: "hi" }, { role: "assistant", content: "hello" }], 100)).toBeNull();
  });
});

describe("summarising", () => {
  it("replaces the older part with a summary and keeps the rest verbatim", async () => {
    const history = session(12);
    const result = await summarizeHistory({
      history,
      provider: writes("Goal: build the game."),
      keepRecentTokens: 3_000,
      maxTranscriptTokens: 10_000,
    });

    expect(result).not.toBeNull();
    const [summary, ...tail] = result!.history;
    expect(isSummaryMessage(summary!)).toBe(true);
    expect(String(summary!.content)).toContain("Goal: build the game.");
    expect(String(summary!.content)).toContain(`replaces ${result!.replaced} earlier message`);
    expect(tail[tail.length - 1]!.content).toBe("Continuing.");
    expect(result!.tokensAfter).toBeLessThan(result!.tokensBefore);
    // The next turn loads the summary and what follows the message it names.
    expect(result!.coversThroughId).toBe(history[result!.replaced - 1]!.id);
  });

  it("uses only the answer, not the model's reasoning", async () => {
    const result = await summarizeHistory({
      history: session(12),
      provider: writes("The summary."),
      keepRecentTokens: 3_000,
      maxTranscriptTokens: 10_000,
    });
    expect(String(result!.summary.content)).not.toContain("thinking about it");
    expect(String(result!.summary.content).startsWith(SUMMARY_PREFIX)).toBe(true);
  });

  it("gives up quietly when the summary cannot be written, so the turn can trim instead", async () => {
    const result = await summarizeHistory({
      history: session(12),
      provider: fails(new Error("503 overloaded")),
      keepRecentTokens: 3_000,
      maxTranscriptTokens: 10_000,
    });
    expect(result).toBeNull();
  });

  it("does not swallow a cancellation", async () => {
    await expect(
      summarizeHistory({
        history: session(12),
        provider: fails(new TurnCancelledError()),
        keepRecentTokens: 3_000,
        maxTranscriptTokens: 10_000,
      }),
    ).rejects.toBeInstanceOf(TurnCancelledError);
  });
});

describe("the transcript it reads", () => {
  it("shortens a huge file write rather than sending it whole", () => {
    const text = renderTranscript(
      [
        { role: "assistant", content: "Writing.", toolCalls: [{ id: "w", name: "write_file", input: { path: "a.ts", content: "q".repeat(50_000) } }] },
        { role: "tool", toolCallId: "w", content: "ok" },
      ],
      100_000,
    );
    expect(text.length).toBeLessThan(2_000);
    expect(text).toContain("write_file");
    expect(text).toContain("RESULT of write_file");
  });
});
