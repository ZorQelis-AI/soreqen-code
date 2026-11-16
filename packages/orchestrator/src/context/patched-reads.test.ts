import { describe, expect, it } from "vitest";
import { gateHistory, patchRead } from "./tool-gateway.js";
import { adjustDialect, dialectFor } from "../openai-provider.js";
import type { LLMMessage } from "../types.js";

const read = (content: string, totalLines = content.split("\n").length): string => JSON.stringify({ path: "doc.md", content, totalLines });
const edited = '{"path":"doc.md","diff":"...","matchStrategy":"exact"}';

describe("a read the agent's own edits overtook", () => {
  it("is brought up to date instead of being marked stale", () => {
    const history: LLMMessage[] = [
      { role: "user", content: "write it" },
      { role: "assistant", content: "", toolCalls: [{ id: "r", name: "read_file", input: { path: "doc.md" } }] },
      { role: "tool", toolCallId: "r", content: read("# Title\n<!-- CHUNK2 -->\nend") },
      { role: "assistant", content: "", toolCalls: [{ id: "e", name: "edit_file", input: { path: "doc.md", old_str: "<!-- CHUNK2 -->", new_str: "## Two\nbody\n<!-- CHUNK3 -->" } }] },
      { role: "tool", toolCallId: "e", content: edited },
    ];
    const gated = gateHistory(history, "s");
    const text = String(gated.messages[2]!.content);
    expect(text).toMatch(/^\[Current: /);
    const data = JSON.parse(text.slice(text.indexOf("\n") + 1)) as { content: string; totalLines: number };
    expect(data.content).toBe("# Title\n## Two\nbody\n<!-- CHUNK3 -->\nend");
    expect(data.totalLines).toBe(5);
    expect(gated.stats.patchedReads).toBe(1);
    expect(gated.stats.staleReads).toBe(0);
  });

  it("says line numbers may have moved when an edit was outside a ranged read", () => {
    const out = patchRead(read("line a\nline b"), [{ input: { old_str: "somewhere else entirely", new_str: "x\ny" }, result: edited }]);
    expect(out).toMatch(/line numbers may have moved/);
  });

  it("stays stale when the edit straddles the read, matched loosely, or is ambiguous", () => {
    const content = read("const alpha = computeSomething();\nreturn alpha;");
    // Only part of the edited text is in this read.
    expect(patchRead(content, [{ input: { old_str: "const alpha = computeSomething();\nmore beyond the range", new_str: "x" }, result: edited }])).toBeNull();
    // Placed by a looser rung: the read does not hold the old text exactly.
    expect(patchRead(content, [{ input: { old_str: "return alpha;", new_str: "return beta;" }, result: '{"matchStrategy":"whitespace"}' }])).toBeNull();
    // Twice in the read.
    expect(patchRead(read("x = 1\nx = 1"), [{ input: { old_str: "x = 1", new_str: "x = 2" }, result: edited }])).toBeNull();
    // Not a whole read.
    expect(patchRead("[... 4,000 characters omitted ...]", [{ input: { old_str: "a", new_str: "b" }, result: edited }])).toBeNull();
  });

  it("stays stale after a whole-file write", () => {
    const history: LLMMessage[] = [
      { role: "assistant", content: "", toolCalls: [{ id: "r", name: "read_file", input: { path: "doc.md" } }] },
      { role: "tool", toolCallId: "r", content: read("old") },
      { role: "assistant", content: "", toolCalls: [{ id: "w", name: "write_file", input: { path: "doc.md", content: "new" } }] },
      { role: "tool", toolCallId: "w", content: '{"written":true}' },
    ];
    expect(String(gateHistory(history, "s").messages[1]!.content)).toMatch(/^\[STALE: /);
  });
});

describe("a refusal that names no field", () => {
  const refusal = { status: 400, message: "400 Upstream request failed: [unsupported_parameter] The request contains an unsupported parameter." };

  it("drops the optional fields one at a time, reasoning effort last", () => {
    let d = dialectFor("https://opencode.ai/zen/go/v1");
    const dropped: string[] = [];
    for (;;) {
      const next = adjustDialect(d, refusal);
      if (!next) break;
      const gone = (Object.keys(d) as (keyof typeof d)[]).find((k) => d[k] !== next[k]);
      dropped.push(String(gone));
      d = next;
    }
    expect(dropped.at(-1)).toBe("reasoningEffort");
    expect(dropped).toContain("thinking");
    expect(dropped).toContain("temperature");
  });
});
