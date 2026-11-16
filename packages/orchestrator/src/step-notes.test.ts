import { describe, expect, it } from "vitest";
import { NOTE_CALL, inStep } from "./step-notes.js";
import { interjectionContent } from "./agent-loop.js";
import { toOpenAIMessages } from "./openai-provider.js";
import { withFrame } from "./context/engine.js";
import type { LLMMessage } from "./types.js";

const user: LLMMessage = { role: "user", content: "Write the docs." };
const call = (id: string): LLMMessage => ({
  role: "assistant",
  content: "",
  reasoningContent: `thinking before ${id}`,
  toolCalls: [{ id, name: "read_file", input: { path: "a.ts" } }],
});
const result = (id: string, content = `result ${id}`): LLMMessage => ({ role: "tool", toolCallId: id, content });
const note = (content: string): LLMMessage => ({ role: "user", content, fromLoop: true });

describe("inStep", () => {
  it("puts the loop's notes inside the tool result they follow, so no user message ends the step", () => {
    const history = [user, call("c1"), result("c1"), note("<soreqen-skills>docs</soreqen-skills>"), note("A note on how you are working.")];
    const sent = inStep(history).messages;
    expect(sent.map((m) => m.role)).toEqual(["user", "assistant", "tool"]);
    expect(sent[2]!.content).toBe("result c1\n\n<soreqen-skills>docs</soreqen-skills>\n\nA note on how you are working.");
  });

  it("does the same for a message the person sent while it worked", () => {
    const history = [user, call("c1"), result("c1"), { role: "user", content: interjectionContent("use Tailwind") } as LLMMessage];
    const sent = inStep(history).messages;
    expect(sent).toHaveLength(3);
    expect(sent[2]!.content).toContain("use Tailwind");
  });

  it("makes a note after a reply with reasoning the result of a call on that reply", () => {
    const reply: LLMMessage = { role: "assistant", content: "Done: wrote the docs.", reasoningContent: "checked them" };
    const sent = inStep([user, call("c1"), result("c1"), reply, note("Before you finish: the record.")]).messages;
    expect(sent.map((m) => m.role)).toEqual(["user", "assistant", "tool", "assistant", "tool"]);
    expect(sent[3]).toMatchObject({ content: "Done: wrote the docs.", reasoningContent: "checked them", toolCalls: [{ name: NOTE_CALL }] });
    expect(sent[4]).toMatchObject({ toolCallId: sent[3]!.toolCalls![0]!.id, content: "Before you finish: the record." });
  });

  it("leaves the person's messages, pictures, and notes with nothing to sit in", () => {
    const picture: LLMMessage = { role: "user", content: [{ type: "image", image_data: "AAAA", media_type: "image/png" }], fromLoop: true };
    const plainReply: LLMMessage = { role: "assistant", content: "Hi." };
    const history = [note("A note at the start."), user, call("c1"), result("c1"), picture, plainReply, note("after a reply without reasoning")];
    const sent = inStep(history).messages;
    expect(sent.map((m) => m.role)).toEqual(["user", "user", "assistant", "tool", "user", "assistant", "user"]);
  });

  it("maps a cache breakpoint on the input to the message that now holds it", () => {
    const folded = inStep([user, call("c1"), result("c1"), note("n"), call("c2"), result("c2")]);
    expect([0, 1, 2, 3, 4, 5].map(folded.at)).toEqual([0, 1, 2, 2, 3, 4]);
  });

  it("is a pure function of the history, so the same history is the same request every step", () => {
    const history = [user, call("c1"), result("c1"), note("n1"), call("c2"), result("c2")];
    expect(JSON.stringify(inStep(history).messages)).toBe(JSON.stringify(inStep(history).messages));
    // Appending a step leaves everything already sent as it was.
    const longer = inStep([...history, note("n2"), call("c3"), result("c3")]).messages;
    expect(longer.slice(0, 4)).toEqual(inStep(history).messages.slice(0, 4));
  });

  it("reaches the endpoint as one tool message with the working set after it, and no user message", () => {
    const history = [user, call("c1"), result("c1"), note("A skill.")];
    const sent = toOpenAIMessages({ system: "s", messages: withFrame(inStep(history).messages, "[Working set]") }, "reasoning_content");
    expect(sent.map((m) => m.role)).toEqual(["system", "user", "assistant", "tool"]);
    expect(sent[3]!.content).toBe("result c1\n\nA skill.\n\n[Working set]");
  });
});
