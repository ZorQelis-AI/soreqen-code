import { describe, it, expect } from "vitest";
import { OpenAICompatibleProvider, reasoningDeltaOf, toOpenAIMessages } from "./openai-provider.js";
import type { LLMMessage } from "./types.js";
import { withFrame } from "./context/engine.js";

/*
 * The reasoning round trip.
 *
 * DeepSeek's thinking mode rejects a tool-call follow-up whose assistant
 * message arrives without its reasoning — measured against the live API:
 * "The `reasoning_content` in the thinking mode must be passed back to the
 * API." MiMo streams the same thing under a different name. These pin both
 * halves: reading it under either name, and sending it back under the one the
 * endpoint used.
 */
describe("reasoning", () => {
  it("reads DeepSeek's reasoning_content", () => {
    expect(reasoningDeltaOf({ reasoning_content: "Think." })).toEqual({
      key: "reasoning_content",
      text: "Think.",
    });
  });

  it("reads MiMo's reasoning", () => {
    expect(reasoningDeltaOf({ reasoning: "Think." })).toEqual({ key: "reasoning", text: "Think." });
  });

  it("ignores the empty reasoning field DeepSeek opens every stream with", () => {
    expect(reasoningDeltaOf({ role: "assistant", content: null, reasoning_content: "" })).toBeNull();
  });

  const toolTurn: LLMMessage[] = [
    { role: "user", content: "Read package.json" },
    {
      role: "assistant",
      content: "",
      reasoningContent: "I should read it.",
      toolCalls: [{ id: "call_1", name: "read_file", input: { path: "package.json" } }],
    },
    { role: "tool", toolCallId: "call_1", content: '{"name":"demo"}' },
  ];

  it("sends reasoning back under the name the endpoint used", () => {
    const deepseek = toOpenAIMessages({ system: "", messages: toolTurn }, "reasoning_content");
    expect(deepseek[1]).toMatchObject({ reasoning_content: "I should read it." });

    const mimo = toOpenAIMessages({ system: "", messages: toolTurn }, "reasoning");
    expect(mimo[1]).toMatchObject({ reasoning: "I should read it." });
    expect(mimo[1]).not.toHaveProperty("reasoning_content");
  });

  it("sends nothing to an endpoint that never produced reasoning", () => {
    const plain = toOpenAIMessages({ system: "", messages: toolTurn }, null);
    expect(plain[1]).not.toHaveProperty("reasoning_content");
    expect(plain[1]).not.toHaveProperty("reasoning");
  });

  /*
   * 31 Oct 2026: the working set went as a user message after the tool
   * results, which a thinking model reads as a new question, so it dropped its
   * own reasoning and began every step with "The working set is rebuilt. I'm
   * at step 62…".
   */
  it("puts the working set inside the last tool result, so the step's reasoning stays in view", () => {
    const messages = withFrame(toolTurn, "[Working notes] goal: ship it");
    const out = toOpenAIMessages({ system: "", messages }, "reasoning_content");
    expect(out.map((m) => m.role)).toEqual(["user", "assistant", "tool"]);
    expect(out[1]).toMatchObject({ reasoning_content: "I should read it." });
    expect(out[2]).toMatchObject({ role: "tool", tool_call_id: "call_1", content: '{"name":"demo"}\n\n[Working notes] goal: ship it' });
  });

  it("joins the person's message when the turn has no tool result yet", () => {
    const messages = withFrame([{ role: "user", content: "Read package.json" }], "[Working notes]");
    const out = toOpenAIMessages({ system: "", messages }, null);
    expect(out).toEqual([{ role: "user", content: "Read package.json\n\n[Working notes]" }]);
  });

  it("keeps the tool call intact alongside the reasoning", () => {
    const out = toOpenAIMessages({ system: "sys", messages: toolTurn }, "reasoning_content");
    expect(out[0]).toEqual({ role: "system", content: "sys" });
    expect(out[2]).toMatchObject({ role: "assistant", tool_calls: [{ id: "call_1" }] });
    expect(out[3]).toMatchObject({ role: "tool", tool_call_id: "call_1" });
  });
});

describe("OpenAICompatibleProvider Suite (OpenCode MiMo-V2.5)", () => {
  it("instantiates correctly with custom baseURL and default mimo-v2.5 model", () => {
    const provider = new OpenAICompatibleProvider({
      apiKey: "sk-test-opencode-key",
      baseURL: "https://opencode.ai/zen/go/v1",
      defaultModel: "mimo-v2.5",
    });

    expect(provider.name).toBe("openai_compatible");
    expect(provider.defaultModel).toBe("mimo-v2.5");
  });

  it("reads configuration from environment variables", () => {
    process.env.OPENCODE_API_KEY = "sk-env-key";
    process.env.OPENCODE_MODEL = "mimo-v2.5";

    const provider = new OpenAICompatibleProvider();
    expect(provider.defaultModel).toBe("mimo-v2.5");

    delete process.env.OPENCODE_API_KEY;
    delete process.env.OPENCODE_MODEL;
  });
});

/*
 * SoreQen Auto's hints (14 Nov 2026): which kind of step a request is, and how
 * the turn is going. Sent to SoreQen's hosted models only; any other endpoint
 * is never told.
 */
describe("SoreQen Auto step hints", () => {
  async function headersSent(baseSuffix: string): Promise<Record<string, string | string[] | undefined>> {
    const { createServer } = await import("node:http");
    let seen: Record<string, string | string[] | undefined> = {};
    const server = createServer((req, res) => {
      seen = req.headers;
      req.resume();
      req.on("end", () => {
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.end('data: {"choices":[{"delta":{"content":"ok"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n');
      });
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const port = (server.address() as { port: number }).port;
    try {
      const provider = new OpenAICompatibleProvider({ apiKey: "k", baseURL: `http://127.0.0.1:${port}${baseSuffix}`, defaultModel: "m", sessionId: "s1" });
      for await (const _ of provider.chatStream({ system: "", messages: [{ role: "user", content: "hi" }], step: "plan", failures: 2 })) {
        // drain
      }
    } finally {
      server.close();
    }
    return seen;
  }

  it("tells SoreQen's hosted models the step and the struggles", async () => {
    const h = await headersSent("/api/code/v1");
    expect(h["x-soreqen-step"]).toBe("plan");
    expect(h["x-soreqen-failures"]).toBe("2");
    expect(h["x-session-id"]).toBe("s1");
  });

  it("tells nobody else", async () => {
    const h = await headersSent("/v1");
    expect(h["x-soreqen-step"]).toBeUndefined();
    expect(h["x-soreqen-failures"]).toBeUndefined();
  });
});
