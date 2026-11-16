import { describe, expect, it } from "vitest";
import { tidyHistory } from "./context-hygiene.js";
import type { LLMMessage } from "./types.js";

/** A history of `n` steps, the first writing a large file; later steps list a directory. */
function history(n: number): LLMMessage[] {
  const big = Array.from({ length: 300 }, (_, i) => `line ${i} of the original file`).join("\n");
  const out: LLMMessage[] = [
    { role: "user", content: "Build it." },
    { role: "assistant", content: "", toolCalls: [{ id: "w0", name: "write_file", input: { path: "src/app.ts", content: big } }] },
    { role: "tool", toolCallId: "w0", content: `Wrote src/app.ts\n${big}` },
  ];
  for (let i = 1; i < n; i++) {
    out.push({ role: "assistant", content: "", toolCalls: [{ id: `l${i}`, name: "list_directory", input: { path: `d${i}` } }] });
    out.push({ role: "tool", toolCallId: `l${i}`, content: "a.ts" });
  }
  return out;
}

describe("past edits in a long session", () => {
  it("keeps a recent write whole", () => {
    const { messages } = tidyHistory(history(4));
    expect(String(messages[1]!.toolCalls![0]!.input["content"])).toContain("line 299");
  });

  it("folds an old write to a pointer at the file, and keeps the call valid", () => {
    const { messages, stats } = tidyHistory(history(30));
    const input = messages[1]!.toolCalls![0]!.input;
    expect(input["path"]).toBe("src/app.ts");
    expect(String(input["content"])).toMatch(/300 lines in all.*src\/app\.ts on disk is the current version/s);
    expect(String(input["content"])).not.toContain("line 299");
    expect(String(messages[2]!.content).length).toBeLessThan(800);
    expect(stats.pastEdits).toBe(1);
  });

  it("is a pure function: the same history gives the same bytes", () => {
    expect(JSON.stringify(tidyHistory(history(30)).messages)).toBe(JSON.stringify(tidyHistory(history(30)).messages));
  });
});
