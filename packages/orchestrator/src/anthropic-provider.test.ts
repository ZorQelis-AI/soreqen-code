/**
 * Claude on the Messages API: what is sent, and what is kept between steps.
 *
 * The property that matters most is append-only: what one request sent, the
 * next sends again byte for byte, with its thinking blocks — otherwise each
 * step's signature no longer matches and the model reasons from nothing.
 */

import { describe, expect, it } from "vitest";
import { withFrame } from "./context/engine.js";
import { AnthropicMessagesProvider, claudeThinkingFor, toAnthropicTurns } from "./anthropic-provider.js";
import { protocolFor, providerForEndpoint } from "./responses-provider.js";
import type { LLMChatOptions, LLMMessage, LLMResponseChunk } from "./types.js";

const tools: LLMChatOptions["tools"] = [{ name: "read_file", description: "Read a file", input_schema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] } }];
const sig = (n: number) => `sig-${n}`;

/** A provider whose client records request bodies and answers with `events`. */
function recording(answers: Array<unknown[] | Error>) {
  const provider = new AnthropicMessagesProvider({ apiKey: "k", baseURL: "https://opencode.ai/zen/go/v1", defaultModel: "claude-haiku-5-5", sessionId: "s1" });
  const sent: Record<string, unknown>[] = [];
  (provider as unknown as { client: unknown }).client = {
    beta: {
      messages: {
        create: async (body: Record<string, unknown>) => {
          sent.push(JSON.parse(JSON.stringify(body)) as Record<string, unknown>);
          const answer = answers.shift() ?? [];
          if (answer instanceof Error) throw answer;
          return (async function* () {
            for (const e of answer) yield e;
          })();
        },
      },
    },
  };
  const run = async (options: Partial<LLMChatOptions> & { messages: LLMMessage[] }): Promise<LLMResponseChunk[]> => {
    const out: LLMResponseChunk[] = [];
    for await (const c of provider.chatStream({ system: "You are SoreQen.", tools, reasoning: "high", ...options })) out.push(c);
    return out;
  };
  return { provider, sent, run };
}

const refusal = (message: string) => Object.assign(new Error(message), { status: 400 });

describe("Claude's Messages API: the request", () => {
  it("puts one round's results in one user turn, pictures inside the result", () => {
    const turns = toAnthropicTurns([
      { role: "user", content: "Read both." },
      {
        role: "assistant",
        content: "",
        thinkingBlocks: [{ type: "thinking", thinking: "Two reads.", signature: sig(1) }],
        toolCalls: [
          { id: "c1", name: "read_file", input: { path: "a" } },
          { id: "c2", name: "read_file", input: { path: "b" } },
        ],
      },
      { role: "tool", toolCallId: "c1", content: "A" },
      { role: "tool", toolCallId: "c2", content: [{ type: "text", text: "B" }, { type: "image", image_data: "data:image/png;base64,QUJD" }] },
    ]);
    expect(turns.map((t) => t.message.role)).toEqual(["user", "assistant", "user"]);
    const assistant = turns[1]!.message.content as Array<{ type: string }>;
    // Thinking first, exactly as it came, then the calls.
    expect(assistant.map((b) => b.type)).toEqual(["thinking", "tool_use", "tool_use"]);
    expect(assistant[0]).toEqual({ type: "thinking", thinking: "Two reads.", signature: sig(1) });
    const results = turns[2]!.message.content as Array<{ type: string; content: unknown }>;
    expect(results.map((b) => b.type)).toEqual(["tool_result", "tool_result"]);
    expect(JSON.stringify(results[1]!.content)).toContain('"media_type":"image/png"');
  });

  it("answers a call left without a result, and drops an empty turn", () => {
    const turns = toAnthropicTurns([
      { role: "user", content: "Go." },
      { role: "assistant", content: "" },
      { role: "assistant", content: "", toolCalls: [{ id: "c1", name: "read_file", input: { path: "a" } }] },
      { role: "user", content: "Stop and tell me." },
    ]);
    const last = turns[turns.length - 1]!.message.content as Array<{ type: string; tool_use_id?: string }>;
    expect(last[0]).toMatchObject({ type: "tool_result", tool_use_id: "c1" });
    expect(last[1]).toMatchObject({ type: "text", text: "Stop and tell me." });
  });

  it("asks for adaptive thinking, summarised, at the tier's effort, and drops a block that no longer fits", () => {
    const { provider } = recording([]);
    const { params, betas } = provider.buildRequest({ system: "s", messages: [{ role: "user", content: "hi" }], tools, reasoning: "extra" }, "claude-opus-5-5", {
      binding: true,
      clearAt: true,
      thinking: "adaptive",
      effort: true,
    });
    expect(params.thinking).toEqual({ type: "adaptive", display: "summarized", block_binding: { prefix_mismatch_behavior: "drop_block" } });
    expect(params.output_config).toEqual({ effort: "xhigh" });
    expect(betas).toContain("thinking-binding-controls-2026-08-01");
    // No sampling parameters: thinking runs at the default.
    expect(params).not.toHaveProperty("temperature");
    // The system prompt carries the breakpoint that caches the tools before it.
    expect(params.system).toEqual([{ type: "text", text: "s", cache_control: { type: "ephemeral" } }]);
  });

  it("knows which Claude thinks how", () => {
    expect(claudeThinkingFor("claude-haiku-5-5")).toBe("adaptive");
    expect(claudeThinkingFor("anthropic/claude-opus-4-8")).toBe("adaptive");
    expect(claudeThinkingFor("claude-fable-5-2")).toBe("adaptive");
    expect(claudeThinkingFor("claude-sonnet-4-5")).toBe("budget");
    expect(claudeThinkingFor("claude-3-7-sonnet-20250219")).toBe("budget");
    expect(claudeThinkingFor("claude-3-5-haiku-20241022")).toBe("none");
  });
});

describe("Claude's Messages API: append-only between steps", () => {
  const step1: LLMMessage[] = [{ role: "user", content: "Fix the bug." }];
  const call = (n: number): LLMMessage => ({
    role: "assistant",
    content: "",
    thinkingBlocks: [{ type: "thinking", thinking: `Step ${n}.`, signature: sig(n) }],
    toolCalls: [{ id: `c${n}`, name: "read_file", input: { path: `f${n}` } }],
  });
  const result = (n: number): LLMMessage => ({ role: "tool", toolCallId: `c${n}`, content: `contents ${n}` });

  it("keeps every working set where it was sent, and the thinking after it, byte for byte", async () => {
    const { sent, run } = recording([[], [], []]);
    await run({ messages: withFrame(step1, "[Working set] step 1") });
    await run({ messages: withFrame([...step1, call(1), result(1)], "[Working set] step 2") });
    await run({ messages: withFrame([...step1, call(1), result(1), call(2), result(2)], "[Working set] step 3") });

    const shapes = sent.map((b) => (b["messages"] as Array<{ role: string }>).map((m) => m.role));
    expect(shapes[0]).toEqual(["user", "system"]);
    expect(shapes[1]).toEqual(["user", "system", "assistant", "user", "system"]);
    expect(shapes[2]).toEqual(["user", "system", "assistant", "user", "system", "assistant", "user", "system"]);

    // Each request is the one before it with the new step appended — cache marks aside.
    const plain = (b: Record<string, unknown>) => JSON.stringify(b["messages"]).replace(/,"cache_control":\{"type":"ephemeral"\}/g, "");
    const before = JSON.parse(plain(sent[1]!)) as unknown[];
    const after = JSON.parse(plain(sent[2]!)) as unknown[];
    expect(after.slice(0, before.length)).toEqual(before);

    const frames = (b: Record<string, unknown>) => (b["messages"] as Array<{ role: string; content: unknown; clear_at?: string }>).filter((m) => m.role === "system");
    expect(frames(sent[2]!).map((m) => [m.content, m.clear_at])).toEqual([
      ["[Working set] step 1", "next_user_message"],
      ["[Working set] step 2", "next_user_message"],
      ["[Working set] step 3", "next_user_message"],
    ]);
    expect(sent[2]!["betas"]).toEqual(expect.arrayContaining(["mid-conversation-system-clear-at-2026-08-21", "thinking-binding-controls-2026-08-01"]));
  });

  it("marks the last user turn for the cache, never a working set", async () => {
    const { sent, run } = recording([[]]);
    await run({ messages: withFrame([...step1, call(1), result(1)], "[Working set]") });
    const messages = sent[0]!["messages"] as Array<{ role: string; content: unknown }>;
    const marked = messages.map((m) => JSON.stringify(m.content).includes("cache_control"));
    // A fresh provider has no earlier working set to put back: user, assistant, results, this step's.
    expect(marked).toEqual([false, false, true, false]);
  });

  it("forgets a working set the API refused, so it is never replayed as sent", async () => {
    const { sent, run } = recording([refusal("400 messages.1: clear_at: Extra inputs are not permitted"), [], []]);
    await run({ messages: withFrame(step1, "[Working set] 1") });
    // Learned: the working set rides inside the last user turn instead.
    expect((sent[1]!["messages"] as Array<{ role: string }>).map((m) => m.role)).toEqual(["user"]);
    await run({ messages: withFrame([...step1, call(1), result(1)], "[Working set] 2") });
    expect((sent[2]!["messages"] as Array<{ role: string }>).every((m) => m.role !== "system")).toBe(true);
  });
});

describe("Claude's Messages API: the stream and its refusals", () => {
  it("streams thinking, keeps its signature, and reports cached input", async () => {
    const { run } = recording([
      [
        { type: "message_start", message: { usage: { input_tokens: 10, cache_read_input_tokens: 900, cache_creation_input_tokens: 0 } } },
        { type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "", signature: "" } },
        { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "Read a first." } },
        { type: "content_block_delta", index: 0, delta: { type: "signature_delta", signature: "abc" } },
        { type: "content_block_stop", index: 0 },
        { type: "content_block_start", index: 1, content_block: { type: "tool_use", id: "c1", name: "read_file", input: {} } },
        { type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: '{"path":"a"}' } },
        { type: "content_block_stop", index: 1 },
        { type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 42 } },
      ],
    ]);
    const chunks = await run({ messages: [{ role: "user", content: "go" }] });
    expect(chunks).toContainEqual({ type: "reasoning", text: "Read a first." });
    expect(chunks).toContainEqual({ type: "thinking_block", block: { type: "thinking", thinking: "Read a first.", signature: "abc" } });
    expect(chunks).toContainEqual({ type: "tool_call_complete", id: "c1", name: "read_file", input: { path: "a" } });
    expect(chunks).toContainEqual({ type: "usage", inputTokens: 910, cachedTokens: 900, outputTokens: 42 });
    expect(chunks.at(-1)).toEqual({ type: "stop", reason: "tool_use" });
  });

  it("drops a beta the endpoint does not pass on, and keeps the rest", async () => {
    const { sent, run } = recording([refusal("400 thinking.adaptive.block_binding: Extra inputs are not permitted"), []]);
    await run({ messages: [{ role: "user", content: "hi" }] });
    expect(sent).toHaveLength(2);
    expect((sent[1]!["thinking"] as Record<string, unknown>)["block_binding"]).toBeUndefined();
    expect(sent[1]!["output_config"]).toBeDefined();
  });

  it("strips thinking once when its blocks are bound to another conversation", async () => {
    const { sent, run } = recording([
      refusal("400 messages.1.content.0: Invalid `signature` in `thinking` block. The block is bound to a different conversation."),
      [],
    ]);
    await run({ messages: [{ role: "user", content: "a" }, { role: "assistant", content: "b", thinkingBlocks: [{ type: "thinking", thinking: "t", signature: "s" }] }, { role: "user", content: "c" }] });
    expect(JSON.stringify(sent[0]!["messages"])).toContain('"thinking"');
    expect(JSON.stringify(sent[1]!["messages"])).not.toContain('"type":"thinking"');
  });

  it("steps effort down to what a model takes", async () => {
    const { sent, run } = recording([refusal("400 output_config.effort: Input should be 'low', 'medium' or 'high'"), [], []]);
    await run({ model: "claude-haiku-5-9", messages: [{ role: "user", content: "hi" }], reasoning: "max" });
    expect(sent.map((b) => (b["output_config"] as { effort: string }).effort)).toEqual(["max", "high"]);
    // Remembered: the next request asks for what the model takes at once.
    await run({ model: "claude-haiku-5-9", messages: [{ role: "user", content: "hi" }], reasoning: "medium" });
    expect((sent[2]!["output_config"] as { effort: string }).effort).toBe("low");
  });
});

describe("which wire an endpoint is spoken to on", () => {
  it("sends Claude to the Messages API where it is served, everything else as before", () => {
    expect(protocolFor("https://opencode.ai/zen/go/v1", "claude-haiku-5-5")).toBe("anthropic");
    expect(protocolFor("https://opencode.ai/zen/go/v1", "glm-5.3")).toBe("openai-chat");
    expect(protocolFor("https://api.anthropic.com/v1", "claude-sonnet-5")).toBe("anthropic");
    expect(protocolFor("https://api.openai.com/v1", "gpt-6-luna")).toBe("openai-responses");
    // SoreQen's own gateway speaks chat completions for every model.
    expect(protocolFor("https://soreqen.com/api/code/v1", "claude-haiku-5-5")).toBe("openai-chat");
    // A provider added by hand says what it speaks.
    expect(protocolFor("https://llm.example.test/v1", "anything", "anthropic")).toBe("anthropic");
    expect(providerForEndpoint({ apiKey: "k", baseURL: "https://opencode.ai/zen/go/v1", defaultModel: "claude-haiku-5-5" }).name).toBe("anthropic_messages");
  });
});
