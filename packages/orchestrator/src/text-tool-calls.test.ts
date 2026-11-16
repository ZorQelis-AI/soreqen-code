/**
 * Tool calls written as text are lifted out, not shown.
 *
 * The first case is the one from a real session: MiMo wrote an `edit_file`
 * call into its answer, the endpoint passed it through as prose, the edit
 * never ran, and several kilobytes of markup filled the chat.
 */

import { describe, expect, it } from "vitest";
import { TextToolCallExtractor, parseTextToolCall, type ExtractedChunk, type ToolShape } from "./text-tool-calls.js";

const TOOLS: ToolShape[] = [
  {
    name: "edit_file",
    input_schema: {
      type: "object",
      properties: { path: { type: "string" }, old_str: { type: "string" }, new_str: { type: "string" } },
    },
  },
  {
    name: "read_file",
    input_schema: { type: "object", properties: { path: { type: "string" }, start_line: { type: "number" } } },
  },
];

/** Stream `text` through in pieces of `size`, the way tokens arrive. */
function run(text: string, size = 7): ExtractedChunk[] {
  const x = new TextToolCallExtractor(TOOLS);
  const out: ExtractedChunk[] = [];
  for (let i = 0; i < text.length; i += size) out.push(...x.push(text.slice(i, i + size)));
  out.push(...x.end());
  return out;
}

const textOf = (chunks: ExtractedChunk[]): string =>
  chunks.map((c) => (c.type === "text" ? c.text : "")).join("");
const callsOf = (chunks: ExtractedChunk[]) =>
  chunks.flatMap((c) => (c.type === "call" ? [c.call] : []));

describe("TextToolCallExtractor", () => {
  it("recovers the Qwen XML call from the real session, and shows none of it", () => {
    const leaked =
      "Fixing the re-render.\n" +
      "<tool_call><function=edit_file><parameter=new_str> this.root.classList.remove('hidden');\n" +
      "const sig = `${o.index}:${o.text}`;</parameter><parameter=old_str> this.root.classList.remove('hidden');" +
      "</parameter><parameter=path>src/ui/dialogueUI.ts</parameter></function></tool_call>";

    const out = run(leaked);
    expect(textOf(out)).toBe("Fixing the re-render.\n");
    expect(callsOf(out)).toEqual([
      {
        name: "edit_file",
        input: {
          path: "src/ui/dialogueUI.ts",
          old_str: " this.root.classList.remove('hidden');",
          new_str: " this.root.classList.remove('hidden');\nconst sig = `${o.index}:${o.text}`;",
        },
      },
    ]);
  });

  it("finds a call however the stream happens to split it", () => {
    const text = 'a<tool_call>{"name":"read_file","arguments":{"path":"x.ts"}}</tool_call>b';
    for (const size of [1, 2, 3, 5, 11, 64]) {
      const out = run(text, size);
      expect(textOf(out)).toBe("ab");
      expect(callsOf(out)).toEqual([{ name: "read_file", input: { path: "x.ts" } }]);
    }
  });

  it("reads the Hermes JSON form, with arguments as an object or a string", () => {
    const tools = new Map(TOOLS.map((t) => [t.name, t]));
    expect(parseTextToolCall('<tool_call>{"name":"read_file","arguments":"{\\"path\\":\\"a\\"}"}</tool_call>', tools)).toEqual(
      { name: "read_file", input: { path: "a" } },
    );
  });

  it("types parameters from the schema: a string stays a string, a number is a number", () => {
    /*
     * Everything in the markup is text. Without the schema, "42" and code that
     * happens to be valid JSON would both be guessed at — and turning a
     * `new_str` of `[1, 2]` into an array would corrupt the edit.
     */
    const out = run(
      "<function=read_file><parameter=path>\n[1, 2]\n</parameter><parameter=start_line>\n42\n</parameter></function>",
    );
    expect(callsOf(out)).toEqual([{ name: "read_file", input: { path: "[1, 2]", start_line: 42 } }]);
  });

  it("leaves the markup alone when it is being discussed, not used", () => {
    const inFence = "Models sometimes write:\n```xml\n<tool_call><function=read_file></function></tool_call>\n```\nDone.";
    const out = run(inFence, 4);
    expect(textOf(out)).toBe(inFence);
    expect(callsOf(out)).toEqual([]);

    const inline = "The `<tool_call>` tag wraps a call.";
    expect(textOf(run(inline))).toBe(inline);
  });

  it("still recovers a call that comes after a fence has closed", () => {
    const text = "```ts\nconst a = 1;\n```\n<function=read_file><parameter=path>a.ts</parameter></function>";
    const out = run(text, 9);
    expect(textOf(out)).toBe("```ts\nconst a = 1;\n```\n");
    expect(callsOf(out)).toEqual([{ name: "read_file", input: { path: "a.ts" } }]);
  });

  it("reports a block it cannot read instead of running or showing it", () => {
    // A tool that does not exist is not run, however well-formed.
    const unknown = run("x<tool_call><function=delete_everything></function></tool_call>y");
    expect(textOf(unknown)).toBe("xy");
    expect(unknown.some((c) => c.type === "malformed")).toBe(true);
    expect(callsOf(unknown)).toEqual([]);

    // An opener that is never closed is given up at the end, not shown.
    const cut = run("Working on it <tool_call><function=edit_file><parameter=path>a.ts");
    expect(textOf(cut)).toBe("Working on it ");
    expect(callsOf(cut)).toEqual([]);
    expect(cut.some((c) => c.type === "malformed")).toBe(true);

    // Only the outer tag forgotten: complete, so it runs.
    const unwrapped = run("<tool_call><function=read_file><parameter=path>a.ts</parameter></function>");
    expect(callsOf(unwrapped)).toEqual([{ name: "read_file", input: { path: "a.ts" } }]);
  });

  it("passes ordinary text straight through, holding back only a possible opener", () => {
    const x = new TextToolCallExtractor(TOOLS);
    expect(x.push("Hello <")).toEqual([{ type: "text", text: "Hello " }]);
    expect(x.push("b>world")).toEqual([{ type: "text", text: "<b>world" }]);
    expect(x.end()).toEqual([]);
  });

  it("is a no-op for a request with no tools", () => {
    const x = new TextToolCallExtractor([]);
    expect(x.push("<tool_call>{}</tool_call>")).toEqual([{ type: "text", text: "<tool_call>{}</tool_call>" }]);
  });
});
