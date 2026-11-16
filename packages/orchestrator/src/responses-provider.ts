/**
 * OpenAI's own models, through the Responses API.
 *
 * ## Why not chat completions
 *
 * OpenAI's current reasoning models refuse the combination an agent needs
 * most on `/v1/chat/completions`: gpt-6-luna answers a request carrying both
 * function tools and reasoning with "Function tools with reasoning_effort are
 * not supported … use /v1/responses or set reasoning_effort to 'none'". The
 * only way to keep tools on that endpoint is to switch reasoning off — a
 * reasoning model that never reasons, and an effort setting that changes
 * nothing. On `/v1/responses` tools and reasoning work together, reasoning
 * effort is honoured, and the reasoning *summary* streams, so the transcript
 * shows what the model was thinking rather than only that it was.
 *
 * ## Shape
 *
 * The same `LLMProvider` contract as every other provider: the loop sends its
 * history and gets back tokens, reasoning, tool calls and a stop reason. The
 * history is sent whole each time (`store: false`); nothing depends on state
 * held at OpenAI, so compaction and checkpointing work unchanged.
 */

import { AnthropicMessagesProvider, isClaudeModel } from "./anthropic-provider.js";
import { parseToolArguments } from "./call-arguments.js";
import OpenAI from "openai";
import { ladderBelow, ladderFromRefusal, levelOn, reasoningLadderFor, registerReasoningLadder, type ReasoningLevel } from "@sqcode/shared";
import { INTERRUPTED_RESULT } from "./history.js";
import { OpenAICompatibleProvider } from "./openai-provider.js";
import { withRetry } from "./resilience.js";
import type { LLMChatOptions, LLMMessage, LLMProvider, LLMResponseChunk } from "./types.js";

export interface ResponsesProviderOptions {
  apiKey: string;
  baseURL?: string;
  defaultModel: string;
  /** Sent with every request: a routing header such as OpenCode's session id. */
  headers?: Record<string, string>;
}

type InputItem = Record<string, unknown>;

/** Whether an endpoint is OpenAI's own, where the Responses API is the one to use. */
export function usesResponsesApi(baseURL: string | undefined): boolean {
  return !!baseURL && /(^|\/\/)api\.openai\.com(\/|$)/.test(baseURL);
}

function textOf(content: LLMMessage["content"]): string {
  if (typeof content === "string") return content;
  return content
    .filter((b) => b.type === "text")
    .map((b) => (b as { text: string }).text)
    .join("\n");
}

/**
 * The loop's history as Responses input items.
 *
 * Every function call must have an output before the conversation moves on,
 * or the request is refused; a call left unanswered by an interrupted step is
 * given the same placeholder result the chat-completions path uses.
 */
export function toResponsesInput(messages: LLMMessage[]): { instructions: string; input: InputItem[] } {
  const extra: string[] = [];
  const input: InputItem[] = [];
  let open: Set<string> = new Set();

  const closeOpen = (): void => {
    for (const id of open) input.push({ type: "function_call_output", call_id: id, output: INTERRUPTED_RESULT });
    open = new Set();
  };

  for (const m of messages) {
    if (m.role === "tool") {
      if (!m.toolCallId) continue;
      input.push({ type: "function_call_output", call_id: m.toolCallId, output: textOf(m.content) });
      open.delete(m.toolCallId);
      continue;
    }
    closeOpen();
    if (m.role === "system") {
      extra.push(textOf(m.content));
    } else if (m.role === "user" && m.frame) {
      /*
       * The working set as a developer message, never a user one: a user
       * message after the tool results ends the model's turn, and with
       * reasoning on that froze the prompt cache at the system prompt — the
       * whole conversation billed at full price on every step. See `frame`.
       */
      input.push({ role: "developer", content: [{ type: "input_text", text: textOf(m.content) }] });
    } else if (m.role === "user") {
      if (typeof m.content === "string") {
        input.push({ role: "user", content: [{ type: "input_text", text: m.content }] });
      } else {
        const parts: InputItem[] = [];
        for (const b of m.content) {
          if (b.type === "text") parts.push({ type: "input_text", text: b.text });
          else if (b.type === "image") {
            parts.push({ type: "input_image", image_url: `data:${b.media_type ?? "image/png"};base64,${b.image_data}`, detail: "auto" });
          } else if (b.type === "tool_result") {
            input.push({ type: "function_call_output", call_id: b.tool_use_id, output: b.content });
          }
        }
        if (parts.length > 0) input.push({ role: "user", content: parts });
      }
    } else if (m.role === "assistant") {
      const text = textOf(m.content);
      if (text.trim()) input.push({ role: "assistant", content: [{ type: "output_text", text }] });
      for (const call of m.toolCalls ?? []) {
        // No item id: an id ties the call to a stored reasoning item, which this history does not carry.
        input.push({ type: "function_call", call_id: call.id, name: call.name, arguments: JSON.stringify(call.input ?? {}) });
        open.add(call.id);
      }
    }
  }
  // Calls still open at the end are the ones this request is answering — left as they are.
  return { instructions: extra.length > 0 ? extra.join("\n\n") : "", input };
}

/**
 * The effort a tier asks this model for, on its own ladder (`reasoning-ladder.ts`).
 * Never "none": no tier, and no helper call, switches thinking off.
 */
export function responsesEffort(level: ReasoningLevel | undefined, model?: string): string | undefined {
  if (!level) return undefined;
  return levelOn(level, reasoningLadderFor(model, "responses"));
}

/**
 * Room to answer, by effort.
 *
 * Reasoning tokens count against `max_output_tokens`, so `xhigh` and `max`
 * could spend the old flat 32,768 thinking and stop before a word of the
 * answer — "incomplete", reported as the turn running out. GPT 6 Luna's own
 * ceiling is 128,000.
 */
export function outputCapFor(effort: string | undefined): number {
  if (effort === "max") return 128_000;
  if (effort === "xhigh") return 65_536;
  return 32_768;
}

export class OpenAIResponsesProvider implements LLMProvider {
  public name = "openai-responses";
  private readonly client: OpenAI;
  private readonly defaultModel: string;
  /** Learned from refusals, like the chat provider's dialect. */
  private summaries = true;
  /** Whether a cap above 32,768 has been accepted — a smaller model may refuse it. */
  private bigOutput = true;
  /** Optional fields a gateway refused without naming them, dropped one per refusal. */
  private readonly omitted = new Set<string>();

  constructor(options: ResponsesProviderOptions) {
    this.client = new OpenAI({
      apiKey: options.apiKey,
      baseURL: options.baseURL ?? "https://api.openai.com/v1",
      ...(options.headers ? { defaultHeaders: options.headers } : {}),
    });
    this.defaultModel = options.defaultModel;
  }

  async *chatStream(options: LLMChatOptions): AsyncIterable<LLMResponseChunk> {
    const model = options.model ?? this.defaultModel;
    const { instructions, input } = toResponsesInput(options.messages);
    const tools = (options.tools ?? []).map((t) => ({
      type: "function" as const,
      name: t.name,
      description: t.description,
      parameters: t.input_schema as Record<string, unknown>,
      strict: false,
    }));

    const effortNow = (): string | undefined => responsesEffort(options.reasoning, model);
    const request = (): Record<string, unknown> => {
      const effort = effortNow();
      const reasoning: Record<string, unknown> = {
        ...(effort ? { effort } : {}),
        ...(this.summaries ? { summary: "auto" } : {}),
      };
      return {
        model,
        instructions: [options.system, instructions].filter(Boolean).join("\n\n"),
        input,
        ...(tools.length > 0 ? { tools, ...(this.omitted.has("parallel_tool_calls") ? {} : { parallel_tool_calls: true }) } : {}),
        stream: true,
        ...(this.omitted.has("store") ? {} : { store: false }),
        // One session's steps to one cache. See `cacheKey`.
        ...(options.cacheKey && !this.omitted.has("prompt_cache_key") ? { prompt_cache_key: options.cacheKey.slice(0, 64) } : {}),
        max_output_tokens: options.maxTokens ?? (this.bigOutput ? outputCapFor(effort) : 32_768),
        ...(Object.keys(reasoning).length > 0 ? { reasoning } : {}),
      };
    };

    let stream: AsyncIterable<Record<string, unknown>> | null = null;
    for (let attempt = 0; stream === null; attempt++) {
      try {
        stream = (await withRetry(
          () =>
            this.client.responses.create(request() as unknown as Parameters<OpenAI["responses"]["create"]>[0], {
              signal: options.signal,
            }),
          { signal: options.signal },
        )) as unknown as AsyncIterable<Record<string, unknown>>;
      } catch (err) {
        const message = String((err as { message?: string })?.message ?? "");
        const status = (err as { status?: number })?.status;
        const sent = effortNow() ?? "";
        const retry = attempt < 4 && status === 400;
        // Reasoning summaries need a verified organisation.
        if (retry && this.summaries && /summar/i.test(message)) this.summaries = false;
        /*
         * A level this model does not have. The refusal lists the ones it
         * does, which is its ladder in its own words: learned once, and every
         * tier spread over it from then on. A refusal that lists nothing
         * takes the ladder below the refused level.
         */
        else if (retry && sent && /reasoning\.effort|reasoning_effort|supported values/i.test(message)) {
          registerReasoningLadder(model, ladderFromRefusal(message) ?? ladderBelow(reasoningLadderFor(model, "responses"), sent));
          if (effortNow() === sent) throw err;
        } else if (retry && this.bigOutput && /max_output_tokens/i.test(message)) this.bigOutput = false;
        // A refusal naming no field ("[unsupported_parameter] The request contains an unsupported parameter"): the least needed goes first.
        else if (status === 400 && /unsupported[_ ]param|unknown[_ ]param|unrecognized[_ ](param|argument)/i.test(message)) {
          const next = ["prompt_cache_key", "summary", "parallel_tool_calls", "store"].find((f) => !this.omitted.has(f));
          if (!next || attempt >= 7) throw err;
          this.omitted.add(next);
          if (next === "summary") this.summaries = false;
        } else throw err;
      }
    }

    const calls = new Map<string, { callId: string; name: string; index: number }>();
    let sawTool = false;
    let incomplete = false;

    for await (const event of stream) {
      const type = String(event["type"] ?? "");
      switch (type) {
        case "response.output_text.delta":
          if (typeof event["delta"] === "string" && event["delta"]) yield { type: "token", text: event["delta"] };
          break;
        case "response.reasoning_summary_text.delta":
        case "response.reasoning_text.delta":
          if (typeof event["delta"] === "string" && event["delta"]) yield { type: "reasoning", text: event["delta"] };
          break;
        case "response.reasoning_summary_part.added":
          // Separate summary paragraphs, as the model wrote them.
          if (Number(event["summary_index"] ?? 0) > 0) yield { type: "reasoning", text: "\n\n" };
          break;
        case "response.output_item.added": {
          const item = (event["item"] ?? {}) as Record<string, unknown>;
          if (item["type"] === "function_call") {
            const entry = { callId: String(item["call_id"]), name: String(item["name"]), index: Number(event["output_index"] ?? calls.size) };
            calls.set(String(item["id"]), entry);
            yield { type: "tool_call_start", id: entry.callId, name: entry.name, index: entry.index };
          }
          break;
        }
        case "response.function_call_arguments.delta": {
          const entry = calls.get(String(event["item_id"]));
          if (entry && typeof event["delta"] === "string") {
            yield { type: "tool_call_delta", id: entry.callId, inputDelta: event["delta"], index: entry.index };
          }
          break;
        }
        case "response.output_item.done": {
          const item = (event["item"] ?? {}) as Record<string, unknown>;
          if (item["type"] === "function_call") {
            // Nearly-JSON is repaired; what cannot be read goes on as such, never as an empty call.
            const parsed = parseToolArguments(String(item["arguments"] ?? ""));
            sawTool = true;
            yield "error" in parsed
              ? { type: "tool_call_complete", id: String(item["call_id"]), name: String(item["name"]), input: {}, malformed: { raw: parsed.raw, error: parsed.error } }
              : { type: "tool_call_complete", id: String(item["call_id"]), name: String(item["name"]), input: parsed.input };
          }
          break;
        }
        case "response.incomplete":
          incomplete = true;
          yield* usageOf(event);
          break;
        case "response.completed":
          yield* usageOf(event);
          break;
        case "response.failed":
        case "error": {
          const detail =
            ((event["response"] as { error?: { message?: string } } | undefined)?.error?.message ??
              (event["message"] as string | undefined) ??
              "the response failed");
          throw new Error(`The model request failed: ${detail}`);
        }
      }
    }

    yield { type: "stop", reason: sawTool ? "tool_use" : incomplete ? "max_tokens" : "end_turn" };
  }
}

/** A finished response's token count, with the part served from the prompt cache. */
function* usageOf(event: Record<string, unknown>): Generator<LLMResponseChunk> {
  const usage = (event["response"] as { usage?: { input_tokens?: number; output_tokens?: number; input_tokens_details?: { cached_tokens?: number } } } | undefined)?.usage;
  if (!usage) return;
  yield {
    type: "usage",
    inputTokens: usage.input_tokens ?? 0,
    cachedTokens: usage.input_tokens_details?.cached_tokens ?? 0,
    ...(usage.output_tokens !== undefined ? { outputTokens: usage.output_tokens } : {}),
  };
}

/** An endpoint's way of saying this model speaks another API: OpenCode serves some models over Responses only. */
export function refusesProtocol(err: unknown): boolean {
  return /ModelProtocolUnsupported|does not support this protocol/i.test(String((err as { message?: string })?.message ?? err));
}

/** Models found to answer only on the Responses API, by endpoint and model: learned once per process. */
const RESPONSES_ONLY = new Set<string>();

/**
 * Chat completions for an OpenAI-compatible endpoint, and the Responses API
 * for a model on it that refuses chat completions.
 *
 * OpenCode Go lists Muse Spark beside MiMo and DeepSeek, and answers it only
 * on `/responses`: over chat completions every request failed with "Model
 * does not support this protocol" (found 29 Sep 2026), so a model in the
 * catalogue could never be used. The refusal comes before a single token, so
 * the request is simply made again the other way, and the model is remembered.
 */
export class ProtocolAdaptiveProvider implements LLMProvider {
  public name = "openai_compatible";
  private readonly chat: OpenAICompatibleProvider;
  private responses: OpenAIResponsesProvider | null = null;

  constructor(private readonly options: { apiKey: string; baseURL: string; defaultModel: string; sessionId?: string }) {
    this.chat = new OpenAICompatibleProvider(options);
  }

  private responsesProvider(): OpenAIResponsesProvider {
    this.responses ??= new OpenAIResponsesProvider({
      apiKey: this.options.apiKey,
      baseURL: this.options.baseURL,
      defaultModel: this.options.defaultModel,
      // The same routing (and so the same cache) as the chat requests had.
      ...(/opencode\./i.test(this.options.baseURL) ? { headers: { "x-opencode-session": this.chat.sessionId } } : {}),
    });
    return this.responses;
  }

  async *chatStream(options: LLMChatOptions): AsyncIterable<LLMResponseChunk> {
    const key = `${this.options.baseURL}|${options.model ?? this.options.defaultModel}`;
    if (RESPONSES_ONLY.has(key)) {
      yield* this.responsesProvider().chatStream(options);
      return;
    }
    let started = false;
    try {
      for await (const chunk of this.chat.chatStream(options)) {
        started = true;
        yield chunk;
      }
    } catch (err) {
      if (started || !refusesProtocol(err)) throw err;
      RESPONSES_ONLY.add(key);
      yield* this.responsesProvider().chatStream(options);
    }
  }
}

/**
 * The wire an endpoint is spoken to on.
 *
 * `auto` — the default — works it out from the address and the model. A
 * provider someone adds by hand can name it, for an endpoint nothing here
 * recognises: any gateway that speaks Anthropic's Messages API, OpenAI's
 * Responses API or chat completions can then serve any of its models.
 */
export type EndpointProtocol = "auto" | "anthropic" | "openai-responses" | "openai-chat";

export function protocolFor(baseURL: string, model: string, declared: EndpointProtocol = "auto"): Exclude<EndpointProtocol, "auto"> {
  if (declared !== "auto") return declared;
  if (/api\.anthropic\.com/i.test(baseURL)) return "anthropic";
  // OpenCode serves Claude on the Messages API beside chat completions; only there do thinking and caching survive.
  if (/opencode\.ai\/zen/i.test(baseURL) && isClaudeModel(model)) return "anthropic";
  if (usesResponsesApi(baseURL)) return "openai-responses";
  return "openai-chat";
}

/**
 * The provider for a catalogue endpoint: Claude's own Messages API for
 * Claude where it is served, the Responses API for OpenAI itself, chat
 * completions for every other OpenAI-compatible endpoint.
 */
export function providerForEndpoint(options: {
  apiKey: string;
  baseURL: string;
  defaultModel: string;
  sessionId?: string;
  protocol?: EndpointProtocol;
  headers?: Record<string, string>;
}): LLMProvider {
  switch (protocolFor(options.baseURL, options.defaultModel, options.protocol)) {
    case "anthropic":
      return new AnthropicMessagesProvider({
        apiKey: options.apiKey,
        baseURL: options.baseURL,
        defaultModel: options.defaultModel,
        ...(options.sessionId ? { sessionId: options.sessionId } : {}),
        ...(options.headers ? { headers: options.headers } : {}),
      });
    case "openai-responses":
      return new OpenAIResponsesProvider({ apiKey: options.apiKey, baseURL: options.baseURL, defaultModel: options.defaultModel });
    default:
      return new ProtocolAdaptiveProvider(options);
  }
}
