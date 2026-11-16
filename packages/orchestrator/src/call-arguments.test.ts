import { describe, expect, it } from "vitest";
import { WriteFileInputSchema } from "@sqcode/shared";
import { describeInputError, parseToolArguments, unreadableCallMessage } from "./call-arguments.js";
import { tidyHistory } from "./context-hygiene.js";
import type { LLMMessage } from "./types.js";

describe("a tool call's arguments", () => {
  it("reads valid JSON as it is", () => {
    expect(parseToolArguments('{"path":"a.py","content":"x"}')).toEqual({ input: { path: "a.py", content: "x" }, repaired: false });
  });

  it("repairs raw newlines and stray backslashes inside strings", () => {
    const raw = '{"path":"a.py","content":"import re\nprint(re.match(r\'\\d+\', s))\n"}';
    const out = parseToolArguments(raw);
    expect("input" in out && out.repaired).toBe(true);
    expect("input" in out && out.input["content"]).toBe("import re\nprint(re.match(r'\\d+', s))\n");
  });

  it("takes the first object when a server sends the payload twice", () => {
    const out = parseToolArguments('{"path":"a"}{"path":"a"}');
    expect("input" in out && out.input).toEqual({ path: "a" });
  });

  it("reports what arrived when it cannot be read, instead of an empty call", () => {
    const out = parseToolArguments('{"path": "a.py", "content": "unterminated');
    expect("error" in out).toBe(true);
    expect("raw" in out && out.raw).toContain("unterminated");
  });

  it("explains an empty call in words, with the way round it, and no literal tags", () => {
    const schema = WriteFileInputSchema;
    const err = schema.safeParse({}).error;
    const text = describeInputError("write_file", {}, err)!;
    expect(text).toMatch(/^FAILED: Your write_file call arrived with no arguments/);
    expect(text).toContain("\\u003c");
    // The message is read by the same model through the same server: it must not carry the tags themselves.
    expect(text).not.toMatch(/<\/?think>|<\|im_/);
    expect(unreadableCallMessage("write_file", { raw: "{bad", error: "Unexpected token" })).toContain('began: "{bad"');
  });

  it("lists missing fields plainly when some arguments did arrive", () => {
    const schema = WriteFileInputSchema;
    const text = describeInputError("write_file", { path: "a.py" }, schema.safeParse({ path: "a.py" }).error)!;
    expect(text).toContain("- content: missing (required)");
  });
});

describe("identical steps", () => {
  const step = (id: string, note = ""): LLMMessage[] => [
    { role: "assistant", content: "Let me read the failing tests.", toolCalls: [{ id, name: "read_file", input: { path: "t.ts" } }] },
    { role: "tool", toolCallId: id, content: `{"path":"t.ts","content":"x"}${note}` },
  ];

  it("are shown once, the last copy kept", () => {
    const history: LLMMessage[] = [
      { role: "user", content: "fix it" },
      ...step("a"),
      ...step("b"),
      ...step("c", "\n\n[Note: this is identical call number 3 to read_file, and it returned exactly the same result as before. Repeating it will not change the outcome; change your approach.]"),
    ];
    const { messages, stats } = tidyHistory(history);
    expect(stats.collapsed).toBe(2);
    const calls = messages.filter((m) => m.role === "assistant").flatMap((m) => m.toolCalls ?? []);
    expect(calls.map((c) => c.id)).toEqual(["c"]);
    expect(String(messages[messages.length - 1]!.content)).toContain("identical call number 3");
  });

  it("are shown once even with other steps and reminders between them", () => {
    const listing = (id: string, pid: string): LLMMessage[] => [
      { role: "assistant", content: "Let me check the skills directory.", toolCalls: [{ id, name: "run_command", input: { command: "ls .agents" } }] },
      { role: "tool", toolCallId: id, content: `{"process_id":"${pid}","command":"ls .agents","status":"exited","ran_for":"0s","output":"skills"}` },
    ];
    const history: LLMMessage[] = [
      { role: "user", content: "install these skills" },
      ...listing("a", "p_1"),
      { role: "assistant", content: "Now the files.", toolCalls: [{ id: "r", name: "read_file", input: { path: "SKILL.md" } }] },
      { role: "tool", toolCallId: "r", content: "skill text" },
      ...listing("b", "p_2"),
      { role: "user", content: "You have now taken exactly the same step 3 times this turn." },
      ...listing("c", "p_3"),
    ];
    const { messages, stats } = tidyHistory(history);
    expect(stats.collapsed).toBe(2);
    const calls = messages.filter((m) => m.role === "assistant").flatMap((m) => m.toolCalls ?? []);
    expect(calls.map((c) => c.id)).toEqual(["r", "c"]);
  });

  it("are left alone when anything differs", () => {
    const history: LLMMessage[] = [
      ...step("a"),
      { role: "user", content: "keep going" },
      { role: "assistant", content: "Let me read the failing tests.", toolCalls: [{ id: "b", name: "read_file", input: { path: "t.ts" } }] },
      { role: "tool", toolCallId: "b", content: `{"path":"t.ts","content":"changed"}` },
      { role: "assistant", content: "Let me read the failing tests.", toolCalls: [{ id: "c", name: "read_file", input: { path: "u.ts" } }] },
      { role: "tool", toolCallId: "c", content: "y" },
    ];
    expect(tidyHistory(history).stats.collapsed).toBe(0);
  });
});
