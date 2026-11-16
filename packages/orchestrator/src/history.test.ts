/**
 * Stored conversations replayed to a strict endpoint.
 *
 * Each case is a shape the gateway really writes. The first one is the bug:
 * a parallel batch persisted as separate assistant rows, which a strict
 * OpenAI-compatible endpoint rejects on the next message.
 */

import { describe, expect, it } from "vitest";
import { INTERRUPTED_RESULT, normalizeHistory } from "./history.js";
import type { LLMMessage } from "./types.js";

const call = (id: string, name = "read_file") => ({ id, name, input: { path: `${id}.ts` } });

/** Every assistant tool-call message must be followed by exactly its results. */
function assertWellFormed(messages: LLMMessage[]): void {
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i]!;
    if (m.role === "tool") {
      const owner = messages
        .slice(0, i)
        .reverse()
        .find((x) => x.role !== "tool");
      expect(owner?.role).toBe("assistant");
      expect(owner?.toolCalls?.some((c) => c.id === m.toolCallId)).toBe(true);
    }
    if (m.role === "assistant" && m.toolCalls?.length) {
      const following = messages.slice(i + 1, i + 1 + m.toolCalls.length);
      expect(following.map((f) => f.toolCallId)).toEqual(m.toolCalls.map((c) => c.id));
    }
  }
}

describe("normalizeHistory", () => {
  it("merges a parallel batch stored as one row per call", () => {
    const stored: LLMMessage[] = [
      { role: "user", content: "read both" },
      { role: "assistant", content: "", toolCalls: [call("a")] },
      { role: "assistant", content: "", toolCalls: [call("b")] },
      { role: "tool", toolCallId: "a", content: "A" },
      { role: "tool", toolCallId: "b", content: "B" },
      { role: "assistant", content: "Both read." },
    ];

    const out = normalizeHistory(stored);

    assertWellFormed(out);
    expect(out.filter((m) => m.role === "assistant" && m.toolCalls)).toHaveLength(1);
    expect(out[1]!.toolCalls!.map((c) => c.id)).toEqual(["a", "b"]);
  });

  it("orders results by the calls, whatever order they finished in", () => {
    const out = normalizeHistory([
      { role: "assistant", content: "", toolCalls: [call("a"), call("b")] },
      { role: "tool", toolCallId: "b", content: "B" },
      { role: "tool", toolCallId: "a", content: "A" },
    ]);
    expect(out.slice(1).map((m) => m.toolCallId)).toEqual(["a", "b"]);
  });

  it("answers an interrupted call instead of dropping it", () => {
    // Dropping the call would let the model believe the work happened.
    const out = normalizeHistory([
      { role: "assistant", content: "", toolCalls: [call("a"), call("b")] },
      { role: "tool", toolCallId: "a", content: "A" },
      { role: "user", content: "stop — do something else" },
    ]);

    assertWellFormed(out);
    expect(out[2]!.content).toBe(INTERRUPTED_RESULT);
    expect(out[3]!.role).toBe("user");
  });

  it("drops a result that answers no call", () => {
    const out = normalizeHistory([
      { role: "user", content: "hi" },
      { role: "tool", toolCallId: "ghost", content: "?" },
      { role: "assistant", content: "hello" },
    ]);
    expect(out.map((m) => m.role)).toEqual(["user", "assistant"]);
  });

  it("leaves sequential calls, each already answered, as they were", () => {
    const stored: LLMMessage[] = [
      { role: "assistant", content: "", toolCalls: [call("a")] },
      { role: "tool", toolCallId: "a", content: "A" },
      { role: "assistant", content: "", toolCalls: [call("b", "write_file")] },
      { role: "tool", toolCallId: "b", content: "B" },
    ];
    expect(normalizeHistory(stored)).toEqual(stored);
  });

  it("keeps one copy of a call that was stored twice", () => {
    const out = normalizeHistory([
      { role: "assistant", content: "", toolCalls: [call("a")] },
      { role: "assistant", content: "", toolCalls: [call("a")] },
      { role: "tool", toolCallId: "a", content: "A" },
    ]);
    expect(out[0]!.toolCalls).toHaveLength(1);
    assertWellFormed(out);
  });

  it("keeps the narration that came with the calls", () => {
    const out = normalizeHistory([
      { role: "assistant", content: "Let me look.", toolCalls: [call("a")] },
      { role: "assistant", content: "", toolCalls: [call("b")] },
      { role: "tool", toolCallId: "a", content: "A" },
      { role: "tool", toolCallId: "b", content: "B" },
    ]);
    expect(out[0]!.content).toBe("Let me look.");
  });

  it("carries reasoning through a merge, for thinking models that require it", () => {
    const out = normalizeHistory([
      { role: "assistant", content: "", reasoningContent: "Read both files.", toolCalls: [call("a")] },
      { role: "assistant", content: "", toolCalls: [call("b")] },
      { role: "tool", toolCallId: "a", content: "A" },
      { role: "tool", toolCallId: "b", content: "B" },
    ]);
    expect(out[0]!.reasoningContent).toBe("Read both files.");
  });
});
