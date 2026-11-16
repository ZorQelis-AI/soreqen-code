/**
 * OpenAI through the Responses API, and the chat provider learning an
 * endpoint's dialect field by field.
 *
 * The error strings are OpenAI's own, captured 24 Sep 2026 against gpt-6-luna.
 */

import { describe, expect, it } from "vitest";
import { withFrame } from "./context/engine.js";
import { adjustDialect, dialectFor, reasoningParamsIn } from "./openai-provider.js";
import {
  OpenAIResponsesProvider,
  outputCapFor,
  providerForEndpoint,
  refusesProtocol,
  responsesEffort,
  toResponsesInput,
  usesResponsesApi,
} from "./responses-provider.js";
import type { LLMMessage } from "./types.js";

const refusal = (message: string) => Object.assign(new Error(message), { status: 400 });

describe("prompt caching on every provider", () => {
  it("asks every chat endpoint for its usage, and OpenAI for session routing", () => {
    expect(dialectFor("https://opencode.ai/zen/go/v1")).toMatchObject({ streamUsage: true, cacheKey: false });
    expect(dialectFor("https://api.deepseek.com")).toMatchObject({ streamUsage: true, cacheKey: false });
    expect(dialectFor("https://api.openai.com/v1")).toMatchObject({ streamUsage: true, cacheKey: true });
  });

  it("drops either field for an endpoint that refuses it, and keeps the rest", () => {
    const noUsage = adjustDialect(dialectFor("https://example.test/v1"), refusal("400 Unrecognized request argument supplied: stream_options"));
    expect(noUsage).toMatchObject({ streamUsage: false, reasoningEffort: true, thinking: true });
    const noKey = adjustDialect(dialectFor("https://api.openai.com/v1"), refusal("400 Unknown parameter: 'prompt_cache_key'."));
    expect(noKey).toMatchObject({ cacheKey: false, streamUsage: true });
  });

  it("recognises an endpoint saying a model speaks another API", () => {
    // OpenCode Go's answer for Muse Spark over chat completions, 29 Sep 2026.
    expect(refusesProtocol(refusal('400 {"type":"error","error":{"type":"ModelProtocolUnsupported","message":"Model does not support this protocol."}}'))).toBe(true);
    expect(refusesProtocol(refusal("400 Invalid 'input': string too long."))).toBe(false);
  });
});

describe("request dialect", () => {
  it("starts OpenAI on max_completion_tokens and without `thinking`, everyone else as before", () => {
    expect(dialectFor("https://api.openai.com/v1")).toMatchObject({ tokensField: "max_completion_tokens", thinking: false });
    expect(dialectFor("https://opencode.ai/zen/go/v1")).toMatchObject({ tokensField: "max_tokens", thinking: true });
  });

  it("learns max_completion_tokens from OpenAI's refusal", () => {
    const next = adjustDialect(
      dialectFor("https://example.test/v1"),
      refusal("400 Unsupported parameter: 'max_tokens' is not supported with this model. Use 'max_completion_tokens' instead."),
    );
    expect(next?.tokensField).toBe("max_completion_tokens");
  });

  // 13 Nov 2026: OpenCode's answer for claude-haiku-5-5 over chat completions.
  it("drops a field a translating gateway says it cannot represent", () => {
    const next = adjustDialect(
      dialectFor("https://opencode.ai/zen/go/v1"),
      refusal("400 thinking: cannot be represented by anthropic-messages; use scoped provider_options when the destination has an equivalent option"),
    );
    expect(next).toMatchObject({ thinking: false, reasoningEffort: true });
  });

  it("drops only the field that was refused — reasoning effort survives a refused `thinking`", () => {
    const next = adjustDialect(dialectFor("https://example.test/v1"), refusal("400 Unrecognized request argument supplied: thinking"));
    expect(next).toMatchObject({ thinking: false, reasoningEffort: true });
    // Tiers spread over low, medium and high; Low is the least thinking, never none.
    expect(reasoningParamsIn("low", next!)).toEqual({ reasoning_effort: "low" });
    expect(reasoningParamsIn("extra", next!)).toEqual({ reasoning_effort: "medium" });
    // Levels above "high" are OpenAI's; an endpoint on this path is never sent one.
    expect(reasoningParamsIn("apex", next!)).toEqual({ reasoning_effort: "high" });
  });

  it("asks a budget-thinking endpoint for the tier's tokens, inside the room for the answer", () => {
    const deepseek = dialectFor("https://api.deepseek.com");
    expect(reasoningParamsIn("low", deepseek)).toMatchObject({ thinking: { type: "enabled", budget_tokens: 2048 } });
    expect(reasoningParamsIn("high", deepseek)).toMatchObject({ thinking: { type: "enabled", budget_tokens: 8192 } });
    // 64K would not fit in a 32K answer: kept below it.
    expect(reasoningParamsIn("apex", deepseek, undefined, 32_768)).toMatchObject({ thinking: { budget_tokens: 28_672 } });
    expect(reasoningParamsIn("medium", dialectFor("https://dashscope-intl.aliyuncs.com/compatible-mode/v1"))).toMatchObject({ enable_thinking: true, thinking_budget: 4096 });
    // Anthropic thinks only at its default temperature.
    expect(dialectFor("https://api.anthropic.com/v1").temperature).toBe(false);
  });

  it("drops temperature when a model only accepts its default", () => {
    const next = adjustDialect(
      dialectFor("https://api.openai.com/v1"),
      refusal("400 Unsupported value: 'temperature' does not support 0.2 with this model. Only the default (1) value is supported."),
    );
    expect(next?.temperature).toBe(false);
  });

  it("leaves real failures alone", () => {
    expect(adjustDialect(dialectFor("https://api.openai.com/v1"), refusal("400 Invalid 'input': string too long."))).toBeNull();
    expect(adjustDialect(dialectFor("https://api.openai.com/v1"), Object.assign(new Error("rate limited"), { status: 429 }))).toBeNull();
  });
});

describe("the Responses API provider", () => {
  it("is chosen for OpenAI itself and nothing else", () => {
    expect(usesResponsesApi("https://api.openai.com/v1")).toBe(true);
    expect(usesResponsesApi("https://opencode.ai/zen/go/v1")).toBe(false);
    expect(providerForEndpoint({ apiKey: "k", baseURL: "https://api.openai.com/v1", defaultModel: "gpt-6-luna" }).name).toBe("openai-responses");
    expect(providerForEndpoint({ apiKey: "k", baseURL: "https://opencode.ai/zen/go/v1", defaultModel: "m" }).name).not.toBe("openai-responses");
  });

  it("spreads the tiers over the model's own levels, and never sends none", () => {
    // GPT 6: low, medium, high, xhigh, max.
    expect(["low", "medium", "high", "extra", "max", "apex"].map((e) => responsesEffort(e as "low", "gpt-6-luna"))).toEqual([
      "low",
      "medium",
      "high",
      "xhigh",
      "max",
      "max",
    ]);
    // A three-level model: the tiers in pairs.
    expect(["low", "medium", "high", "extra", "max", "apex"].map((e) => responsesEffort(e as "low", "o3"))).toEqual([
      "low",
      "low",
      "medium",
      "medium",
      "high",
      "high",
    ]);
    expect(responsesEffort(undefined)).toBeUndefined();
  });

  it("sends the working set as a developer message, so the prompt cache keeps growing", () => {
    const { input } = toResponsesInput([
      { role: "user", content: "Fix the bug." },
      { role: "assistant", content: "", toolCalls: [{ id: "c1", name: "read_file", input: { path: "a.ts" } }] },
      { role: "tool", toolCallId: "c1", content: "x" },
      withFrame([], "[Working set] step 2")[0]!,
    ]);
    expect(input.at(-1)).toEqual({ role: "developer", content: [{ type: "input_text", text: "[Working set] step 2" }] });
    // The person's own words stay a user message.
    expect(input[0]).toMatchObject({ role: "user" });
  });

  it("gives the deepest levels room for the thinking they buy", () => {
    // Reasoning counts against the output cap: a flat 32k could be spent before the answer began.
    expect(outputCapFor("max")).toBe(128_000);
    expect(outputCapFor("xhigh")).toBe(65_536);
    expect(outputCapFor("high")).toBe(32_768);
  });

  it("learns a model's levels from what it refuses, instead of failing the turn", async () => {
    const provider = new OpenAIResponsesProvider({ apiKey: "k", defaultModel: "gpt-small" });
    const sent: Record<string, unknown>[] = [];
    (provider as unknown as { client: unknown }).client = {
      responses: {
        create: async (req: Record<string, unknown>) => {
          sent.push(req);
          const effort = (req["reasoning"] as { effort?: string })?.effort;
          if (effort === "max" || effort === "xhigh") {
            // Verbatim shape of OpenAI's refusal — which lists 'none' too, and must not be read as refusing it.
            throw Object.assign(
              new Error(`400 Invalid value: '${effort}'. Supported values are: 'none', 'minimal', 'low', 'medium', and 'high'.`),
              { status: 400 },
            );
          }
          return (async function* () {})();
        },
      },
    };
    const run = async (reasoning: "apex" | "low" | "extra") => {
      for await (const _ of provider.chatStream({ messages: [{ role: "user", content: "hi" }], reasoning })) void _;
    };
    await run("apex");
    // The refusal listed low, medium and high: one retry, at the top of that ladder.
    expect(sent.map((r) => (r["reasoning"] as { effort?: string }).effort)).toEqual(["max", "high"]);
    // Remembered, and every tier spread over the three it has.
    sent.length = 0;
    await run("apex");
    await run("extra");
    await run("low");
    expect(sent.map((r) => (r["reasoning"] as { effort?: string }).effort)).toEqual(["high", "medium", "low"]);
  });

  it("turns the loop's history into Responses items, calls and results paired", () => {
    const history: LLMMessage[] = [
      { role: "user", content: "Check Pune and Oslo." },
      {
        role: "assistant",
        content: "Checking both.",
        toolCalls: [
          { id: "c1", name: "get_weather", input: { city: "Pune" } },
          { id: "c2", name: "get_weather", input: { city: "Oslo" } },
        ],
      },
      { role: "tool", toolCallId: "c1", content: "31C" },
      // c2 was interrupted: it must still get an output before the next message.
      { role: "user", content: [{ type: "text", text: "Here is a picture:" }, { type: "image", image_data: "AAAA", media_type: "image/png" }] },
    ];
    const { input } = toResponsesInput(history);
    expect(input.map((i) => i["type"] ?? i["role"])).toEqual([
      "user",
      "assistant",
      "function_call",
      "function_call",
      "function_call_output",
      "function_call_output",
      "user",
    ]);
    const call = input[2]!;
    expect(call).toMatchObject({ type: "function_call", call_id: "c1", name: "get_weather", arguments: '{"city":"Pune"}' });
    // No item id: that would tie the call to a stored reasoning item this history does not carry.
    expect(call["id"]).toBeUndefined();
    expect(input[5]).toMatchObject({ type: "function_call_output", call_id: "c2" });
    expect(JSON.stringify(input[6])).toContain("data:image/png;base64,AAAA");
  });
});
