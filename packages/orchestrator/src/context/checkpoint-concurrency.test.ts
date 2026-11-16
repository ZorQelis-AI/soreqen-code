/**
 * A checkpoint with a backlog reads several stretches at once (13 Nov 2026).
 *
 * A month-long session asked to checkpoint by hand read over a hundred
 * stretches one after another and looked stuck for hours. Reading them three
 * at a time must not change what the task state ends up saying: stretches are
 * merged in conversation order whatever order they finish in, and the first
 * that fails stops the merge there.
 */

import { describe, expect, it } from "vitest";
import type { LLMChatOptions, LLMMessage, LLMProvider, LLMResponseChunk } from "../types.js";
import { extractRange, segmentsOf, unreadFrom } from "./state-checkpoint.js";
import { TaskStateStore, emptyTaskState } from "./task-state.js";

/** Exchanges labelled msg-i, each with an id, about `chars` long. */
function conversation(n: number, chars = 3_000): LLMMessage[] {
  const out: LLMMessage[] = [];
  for (let i = 0; i < n; i++) {
    out.push({ id: `a${i}`, role: "assistant", content: `msg-${i}`, toolCalls: [{ id: `c${i}`, name: "run_command", input: { command: `echo ${i}` } }] });
    out.push({ id: `t${i}`, role: "tool", toolCallId: `c${i}`, content: `msg-${i} ${"x".repeat(chars)}` });
  }
  return out;
}

/**
 * Answers with one decision naming the first message it was shown. Earlier
 * stretches answer more slowly, so they finish out of order; one label can be
 * made to fail.
 */
function slowFirst(failOn?: number): { provider: LLMProvider; inFlight: () => number; peak: () => number } {
  let now = 0;
  let peak = 0;
  const provider: LLMProvider = {
    name: "slow-first",
    async *chatStream(options: LLMChatOptions): AsyncIterable<LLMResponseChunk> {
      const text = String(options.messages[0]?.content ?? "");
      const first = Number(/msg-(\d+)/.exec(text.slice(text.indexOf("<transcript>")))?.[1] ?? -1);
      now++;
      peak = Math.max(peak, now);
      try {
        await new Promise((r) => setTimeout(r, Math.max(1, 40 - first)));
        if (first === failOn) throw new Error("upstream unavailable");
        yield { type: "token", text: JSON.stringify({ decisions: [{ text: `decided at msg-${first}` }] }) };
        yield { type: "stop", reason: "end_turn" };
      } finally {
        now--;
      }
    },
  };
  return { provider, inFlight: () => now, peak: () => peak };
}

const decisions = (store: TaskStateStore): number[] =>
  store.state.entries.filter((e) => e.kind === "decision").map((e) => Number(/msg-(\d+)/.exec(e.text)?.[1]));

describe("checkpoint reads: several at once, merged in order", () => {
  it("reads three stretches at a time and merges them in conversation order", async () => {
    const history = conversation(48);
    const segments = segmentsOf(history, 0, history.length, 12_000);
    expect(segments.length).toBeGreaterThan(5);
    const store = new TaskStateStore(emptyTaskState("s"));
    const { provider, peak } = slowFirst();
    const progress: Array<[number, number]> = [];

    const result = await extractRange({
      history,
      store,
      provider,
      from: 0,
      to: history.length,
      checkpoint: 1,
      segmentChars: 12_000,
      onProgress: (done, total) => progress.push([done, total]),
    });

    expect(result.ok).toBe(true);
    expect(peak()).toBe(3);
    // In the conversation's order, though later stretches answered first.
    const read = decisions(store);
    expect(read).toEqual([...read].sort((a, b) => a - b));
    expect(read).toHaveLength(segments.length);
    // Progress from nothing to everything, one stretch at a time.
    expect(progress[0]).toEqual([0, segments.length]);
    expect(progress.at(-1)).toEqual([segments.length, segments.length]);
    expect(progress.map(([d]) => d)).toEqual([...Array(segments.length + 1).keys()]);
    // The mark is past the last message: nothing is left to read.
    expect(unreadFrom(history, store.state.extractedThrough)).toBe(history.length);
  });

  it("stops at the first stretch that fails, keeping what came before it", async () => {
    const history = conversation(48);
    const segments = segmentsOf(history, 0, history.length, 12_000);
    const failing = Number(/msg-(\d+)/.exec(String(history[segments[2]![0]]!.content))?.[1]);
    const store = new TaskStateStore(emptyTaskState("s"));
    const { provider, inFlight } = slowFirst(failing);

    const result = await extractRange({ history, store, provider, from: 0, to: history.length, checkpoint: 1, segmentChars: 12_000 });

    expect(result.ok).toBe(false);
    expect(result.reasons.join(" ")).toMatch(/upstream unavailable/);
    // The two stretches before it, and nothing after it, though those were read.
    expect(decisions(store)).toHaveLength(2);
    expect(unreadFrom(history, store.state.extractedThrough)).toBe(segments[2]![0]);
    // Nothing is left running behind the result.
    expect(inFlight()).toBe(0);
  });

  it("rejects once when stopped, and leaves no read unhandled", async () => {
    const history = conversation(48);
    const store = new TaskStateStore(emptyTaskState("s"));
    const { provider } = slowFirst();
    const stop = new AbortController();
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown): void => void unhandled.push(reason);
    process.on("unhandledRejection", onUnhandled);
    try {
      setTimeout(() => stop.abort(), 5);
      await expect(
        extractRange({ history, store, provider, from: 0, to: history.length, checkpoint: 1, segmentChars: 12_000, signal: stop.signal }),
      ).rejects.toThrow();
      await new Promise((r) => setTimeout(r, 80));
      expect(unhandled).toEqual([]);
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  });
});
