/**
 * OpenAI-Compatible Streaming LLM Provider
 * Supports OpenCode Go Plan, MiMo-V2.5, DeepSeek, OpenAI, Groq, Ollama, etc.
 */

import { randomUUID } from "node:crypto";
import OpenAI from "openai";
import { parseToolArguments } from "./call-arguments.js";
import { levelOn, reasoningLadderFor, thinkingBudgetFor, type ReasoningLevel } from "@sqcode/shared";
import type { LLMProvider, LLMChatOptions, LLMMessage, LLMResponseChunk } from "./types.js";
import { withRetry } from "./resilience.js";
import { INTERRUPTED_RESULT } from "./history.js";
import { TextToolCallExtractor, type ExtractedChunk } from "./text-tool-calls.js";

export interface OpenAICompatibleProviderOptions {
  apiKey?: string;
  baseURL?: string;
  defaultModel?: string;
  modelFallbackChain?: string[];
  /**
   * A stable identifier for this conversation, sent to providers that route on
   * one.
   *
   * OpenCode Go refuses a request without it — *400: Request is missing
   * x-opencode-session and cannot be routed efficiently* — because it uses the
   * value for cache affinity: consecutive turns carrying the same id land on a
   * worker that already holds the prefix. A random value per request would
   * satisfy the check and forfeit the entire benefit, so this is one value for
   * the life of the session.
   *
   * Optional, and harmless where it is not understood: an unrecognised header
   * is ignored by every other OpenAI-compatible endpoint.
   */
  sessionId?: string;
  /** Anything else the endpoint needs. Merged after the ones above, so a
   *  caller can override them. */
  headers?: Record<string, string>;
}

/**
 * Providers that route on a session header, and what they call it.
 *
 * Matched on the base URL rather than configured, because the requirement is a
 * property of the endpoint and asking every caller to know it is how the
 * header went missing in the first place.
 */
const SESSION_HEADER_BY_HOST: { test: RegExp; header: string }[] = [
  { test: /opencode\.ai|opencode\./i, header: "x-opencode-session" },
  // SoreQen's hosted models: the gateway passes it on as the upstream's own session header.
  { test: /\/api\/code\/v1/i, header: "x-session-id" },
];

/**
 * A request the provider could not complete, after retries.
 *
 * Thrown rather than streamed. The previous behaviour was to yield the error
 * *as answer text* — `[LLM Provider Error: 400 …]` — followed by a normal
 * stop, so a failed request completed the turn successfully with an error
 * message as its answer. The surface rendered it as prose, the loop recorded
 * it as the model's reply, and the next turn sent it back to the model as
 * something it had said.
 */
export class ProviderError extends Error {
  constructor(
    message: string,
    public readonly status?: number,
  ) {
    super(message);
    this.name = "ProviderError";
  }
}

/** The two field names reasoning arrives under. */
export type ReasoningKey = "reasoning_content" | "reasoning";

/**
 * Reasoning text in a streamed delta, and which field carried it.
 *
 * Two conventions exist and both are in use here: DeepSeek streams
 * `reasoning_content`; OpenCode's MiMo (and OpenRouter) stream `reasoning`.
 * The field name matters beyond reading it — it is also the name the
 * reasoning must be *sent back* under, see `toOpenAIMessages`.
 */
export function reasoningDeltaOf(delta: unknown): { key: ReasoningKey; text: string } | null {
  if (!delta || typeof delta !== "object") return null;
  const d = delta as Record<string, unknown>;
  if (typeof d["reasoning_content"] === "string" && d["reasoning_content"]) {
    return { key: "reasoning_content", text: d["reasoning_content"] };
  }
  if (typeof d["reasoning"] === "string" && d["reasoning"]) {
    return { key: "reasoning", text: d["reasoning"] };
  }
  return null;
}

/**
 * Which spelling of each request field an endpoint accepts.
 *
 * "OpenAI-compatible" endpoints disagree on the details, and a field one
 * requires another refuses outright: OpenAI's current models reject
 * `max_tokens` ("use max_completion_tokens") and any temperature but the
 * default; DeepSeek wants `thinking`, which OpenAI calls an unknown parameter.
 * Each difference is learned per field from the endpoint's own refusal, so
 * one rejected field never takes the others down with it — reasoning effort
 * keeps working on an endpoint that merely lacks `thinking`.
 */
export interface RequestDialect {
  tokensField: "max_tokens" | "max_completion_tokens";
  temperature: boolean;
  thinking: boolean;
  reasoningEffort: boolean;
  /** `stream_options.include_usage`: the usage chunk, and in it the tokens served from the prompt cache. */
  streamUsage: boolean;
  /** `prompt_cache_key`: OpenAI routes a session's requests to the server holding its cache. */
  cacheKey: boolean;
  /** Qwen on DashScope: `enable_thinking` and `thinking_budget` instead of `thinking`. */
  qwenThinking?: boolean;
}

/** What is known of an endpoint before it has refused anything. */
export function dialectFor(baseURL: string): RequestDialect {
  const openai = /(^|\/\/)api\.openai\.com(\/|$)/.test(baseURL);
  const qwen = /dashscope/i.test(baseURL);
  // Anthropic takes no temperature but the default while it thinks.
  const anthropic = /(^|\/\/)api\.anthropic\.com(\/|$)/.test(baseURL);
  return {
    tokensField: openai ? "max_completion_tokens" : "max_tokens",
    temperature: !anthropic,
    thinking: !openai && !qwen,
    ...(qwen ? { qwenThinking: true } : {}),
    reasoningEffort: true,
    streamUsage: true,
    // Elsewhere an unknown field can be refused, and the prefix alone finds the cache (DeepSeek, Kimi), or a session header does (OpenCode).
    cacheKey: openai,
  };
}

/**
 * The dialect a refusal asks for, or null when the error is not about a field
 * this can change — then it is a real failure, and is thrown.
 */
export function adjustDialect(dialect: RequestDialect, err: unknown): RequestDialect | null {
  const status = (err as { status?: number })?.status;
  if (status !== 400 && status !== 422) return null;
  const message = String((err as { message?: string })?.message ?? "");
  if (/passed back/i.test(message)) return null;
  /*
   * A refusal that names the field. Gateways that translate to another
   * protocol word it their own way: OpenCode answered a Claude model's
   * `thinking` with "thinking: cannot be represented by anthropic-messages"
   * (13 Nov 2026), which no phrase here matched, so every turn failed.
   */
  const names = (field: string): boolean =>
    new RegExp(
      `['"\`]?${field}['"\`]?[^.]*\\b(not supported|unsupported|unrecognized|unknown|not permitted|not allowed|does not support|extra|cannot be represented|can ?not be (mapped|translated|converted)|is not available|not representable)|\\b(unsupported|unrecognized|unknown|extra)\\b[^.]*['"\`]?${field}\\b`,
      "i",
    ).test(message);
  if (dialect.tokensField === "max_tokens" && /max_completion_tokens/.test(message) && names("max_tokens")) {
    return { ...dialect, tokensField: "max_completion_tokens" };
  }
  if (dialect.temperature && names("temperature")) return { ...dialect, temperature: false };
  if (dialect.thinking && (names("thinking") || /budget_tokens/.test(message))) return { ...dialect, thinking: false };
  if (dialect.qwenThinking && (names("enable_thinking") || names("thinking_budget"))) return { ...dialect, qwenThinking: false };
  if (dialect.reasoningEffort && names("reasoning_effort")) return { ...dialect, reasoningEffort: false };
  if (dialect.streamUsage && /stream_options|include_usage/.test(message)) return { ...dialect, streamUsage: false };
  if (dialect.cacheKey && names("prompt_cache_key")) return { ...dialect, cacheKey: false };
  /*
   * A refusal that names no field: "[unsupported_parameter] The request
   * contains an unsupported parameter" (OpenCode, 9 Oct 2026). The optional
   * fields are dropped one per refusal, the least needed first, so the request
   * that finally goes through keeps everything the model does accept.
   * reasoning_effort goes last: without it the model still thinks, at its own
   * default.
   */
  if (/unsupported[_ ]param|unknown[_ ]param|unrecognized[_ ](param|argument|field)|extra[_ ](inputs|fields)/i.test(message)) {
    if (dialect.cacheKey) return { ...dialect, cacheKey: false };
    if (dialect.thinking) return { ...dialect, thinking: false };
    if (dialect.qwenThinking) return { ...dialect, qwenThinking: false };
    if (dialect.streamUsage) return { ...dialect, streamUsage: false };
    if (dialect.temperature) return { ...dialect, temperature: false };
    if (dialect.reasoningEffort) return { ...dialect, reasoningEffort: false };
  }
  return null;
}

/** The levels a chat-completions endpoint can be sent: nothing above `high` (see below). */
const CHAT_LEVELS = new Set(["low", "medium", "high"]);

/**
 * The reasoning fields for a tier, in a dialect.
 *
 * Thinking is never switched off here: the weakest tier asks for the model's
 * lowest level. `reasoning_effort` is the tier spread over the model's own
 * levels (`reasoning-ladder.ts`); `thinking` asks a budget-based model for the
 * tier's tokens (2K at Low to 64K at Apex), kept inside the room the answer has.
 *
 * Never above `high` in `reasoning_effort`. `xhigh` and `max` are OpenAI's,
 * and OpenAI's own models go through the Responses API; the endpoints on this
 * path answer an unknown *value* with "invalid value", which `adjustDialect`
 * rightly does not treat as a field it can drop, so the turn would fail.
 */
export function reasoningParamsIn(
  level: ReasoningLevel | undefined,
  dialect: RequestDialect,
  model?: string,
  maxTokens = 32_768,
): Record<string, unknown> {
  if (!level) return {};
  const ladder = reasoningLadderFor(model, "chat").filter((l) => CHAT_LEVELS.has(l));
  const budget = Math.max(1024, Math.min(thinkingBudgetFor(level), maxTokens - 4096));
  return {
    ...(dialect.reasoningEffort ? { reasoning_effort: levelOn(level, ladder) } : {}),
    ...(dialect.thinking ? { thinking: { type: "enabled", budget_tokens: budget } } : {}),
    ...(dialect.qwenThinking ? { enable_thinking: true, thinking_budget: budget } : {}),
  };
}

/** Whether a failed request was refused because of the reasoning fields. */
export function rejectsReasoningControl(err: unknown): boolean {
  const status = (err as { status?: number })?.status;
  if (status !== 400 && status !== 422) return false;
  const message = String((err as { message?: string })?.message ?? "");
  if (/passed back/i.test(message)) return false;
  return /thinking|reasoning_effort|unrecognized|unknown (parameter|field|argument|name)|extra (inputs|fields)|not (permitted|supported|allowed)/i.test(
    message,
  );
}

type ChatMessage = OpenAI.ChatCompletionMessageParam;

function toParts(content: unknown): OpenAI.ChatCompletionContentPart[] {
  if (typeof content === "string") return content ? [{ type: "text", text: content }] : [];
  return Array.isArray(content) ? (content as OpenAI.ChatCompletionContentPart[]) : [];
}

/**
 * Make a message list every OpenAI-compatible endpoint will accept.
 *
 * The last line of defence, and deliberately independent of how the history
 * was produced. Whatever compaction, a summary, an interrupted turn or a stored
 * session did to it, three shapes are rejected outright by strict endpoints,
 * and a rejected request is a turn that stops:
 *
 *   - a tool result that answers no call in front of it — dropped;
 *   - a call left without a result before the conversation moves on — given
 *     one that says it was interrupted;
 *   - two user messages, or two plain assistant messages, in a row — merged.
 *     DeepSeek refuses consecutive messages of the same role.
 */
export function sanitizeChatMessages(input: ChatMessage[]): ChatMessage[] {
  const out: ChatMessage[] = [];
  let open: { ids: string[]; answered: Set<string> } | null = null;

  const closeOpen = (): void => {
    if (!open) return;
    for (const id of open.ids) {
      if (!open.answered.has(id)) out.push({ role: "tool", tool_call_id: id, content: INTERRUPTED_RESULT });
    }
    open = null;
  };

  for (const message of input) {
    if (message.role === "tool") {
      if (open && open.ids.includes(message.tool_call_id) && !open.answered.has(message.tool_call_id)) {
        open.answered.add(message.tool_call_id);
        out.push(message);
      }
      continue;
    }

    closeOpen();
    const prev = out[out.length - 1];

    if (message.role === "user" && prev?.role === "user") {
      const bothText = typeof prev.content === "string" && typeof message.content === "string";
      out[out.length - 1] = bothText
        ? { role: "user", content: `${prev.content as string}\n\n${message.content as string}` }
        : { role: "user", content: [...toParts(prev.content), ...toParts(message.content)] };
      continue;
    }

    const hasCalls = (m: ChatMessage | undefined): boolean =>
      m?.role === "assistant" && Array.isArray(m.tool_calls) && m.tool_calls.length > 0;

    if (message.role === "assistant" && prev?.role === "assistant" && !hasCalls(prev)) {
      const before = typeof prev.content === "string" ? prev.content : "";
      const after = typeof message.content === "string" ? message.content : "";
      const content = [before, after].filter((s) => s && s.trim()).join("\n\n");
      out[out.length - 1] = { ...message, content: content || (hasCalls(message) ? null : "") } as ChatMessage;
    } else {
      out.push(message);
    }

    if (hasCalls(message)) {
      const calls = (message as OpenAI.ChatCompletionAssistantMessageParam).tool_calls ?? [];
      open = { ids: calls.map((c) => c.id), answered: new Set() };
    }
  }

  closeOpen();
  return out;
}

/**
 * The loop's messages in OpenAI chat format.
 *
 * Exported so the conversion — and in particular the reasoning round trip —
 * can be tested without a network.
 *
 * `reasoningKey` is the field this endpoint was seen to stream reasoning
 * under, or null if it never has. Reasoning is echoed only under that name:
 * DeepSeek *requires* `reasoning_content` on a tool-call follow-up and
 * rejects the request without it, while an endpoint that never produced
 * reasoning is sent nothing it did not ask for.
 */
export function toOpenAIMessages(
  options: Pick<LLMChatOptions, "system" | "messages">,
  reasoningKey: ReasoningKey | null,
): OpenAI.ChatCompletionMessageParam[] {
  const messages: OpenAI.ChatCompletionMessageParam[] = [];

  if (options.system) {
    messages.push({ role: "system", content: options.system });
  }

  const frame = options.messages.find((m) => m.role === "user" && m.frame);

  for (const m of options.messages) {
    if (m === frame) continue;
    if (m.role === "tool") {
      messages.push({
        role: "tool",
        tool_call_id: m.toolCallId ?? "call_unknown",
        content: typeof m.content === "string" ? m.content : JSON.stringify(m.content),
      });
      continue;
    }

    if (m.role === "assistant") {
      const reasoning =
        reasoningKey && m.reasoningContent ? { [reasoningKey]: m.reasoningContent } : {};

      if (m.toolCalls && m.toolCalls.length > 0) {
        const contentStr = typeof m.content === "string" && m.content.length > 0 ? m.content : null;
        messages.push({
          role: "assistant",
          content: contentStr,
          tool_calls: m.toolCalls.map((tc) => ({
            id: tc.id,
            type: "function" as const,
            function: {
              name: tc.name,
              arguments: typeof tc.input === "string" ? tc.input : JSON.stringify(tc.input ?? {}),
            },
          })),
          ...reasoning,
        } as OpenAI.ChatCompletionAssistantMessageParam);
      } else {
        messages.push({
          role: "assistant",
          content: typeof m.content === "string" ? m.content : JSON.stringify(m.content),
          ...reasoning,
        } as OpenAI.ChatCompletionAssistantMessageParam);
      }
      continue;
    }

    if (m.role === "system") {
      messages.push({
        role: "system",
        content: typeof m.content === "string" ? m.content : JSON.stringify(m.content),
      });
      continue;
    }

    // User message: text and multi-modal image blocks.
    if (Array.isArray(m.content)) {
      const parts: OpenAI.ChatCompletionContentPart[] = m.content.map((b) => {
        if (b.type === "image") {
          const url = b.image_data.startsWith("data:")
            ? b.image_data
            : `data:${b.media_type ?? "image/png"};base64,${b.image_data}`;
          return { type: "image_url", image_url: { url } };
        }
        if (b.type === "text") return { type: "text", text: b.text };
        return { type: "text", text: JSON.stringify(b) };
      });
      messages.push({ role: "user", content: parts });
    } else {
      messages.push({ role: "user", content: m.content });
    }
  }

  return withFrameIn(sanitizeChatMessages(messages), frame);
}

/**
 * The working set, inside the last tool result rather than after it.
 *
 * A user message after the tool results is a new question to a thinking
 * model. DeepSeek, MiMo, GLM and Qwen keep reasoning only after the last user
 * message, so a working set sent as one wiped every earlier step's thinking,
 * and each step began again from nothing: "The working set is rebuilt. I'm at
 * step 62. What's done: ✓ ✓ ✓", the same plan written four times over and one
 * file read three times in a row (MiMo and DeepSeek, 30-31 Oct 2026). Inside
 * the tool result it is part of the step the model is in the middle of.
 *
 * At the start of a turn there is no tool result, and it joins the person's
 * message, which is a new question anyway.
 */
function withFrameIn(messages: ChatMessage[], frame: LLMMessage | undefined): ChatMessage[] {
  if (!frame) return messages;
  const text = typeof frame.content === "string" ? frame.content : JSON.stringify(frame.content);
  const last = messages[messages.length - 1];
  if (last?.role === "tool") {
    const before = typeof last.content === "string" ? last.content : JSON.stringify(last.content);
    return [...messages.slice(0, -1), { ...last, content: `${before}\n\n${text}` }];
  }
  return sanitizeChatMessages([...messages, { role: "user", content: text }]);
}

export class OpenAICompatibleProvider implements LLMProvider {
  public name = "openai_compatible";
  private client: OpenAI;
  public defaultModel: string;
  public fallbackChain: string[];
  /** Sent as the routing header where the endpoint wants one. Exposed so a
   *  caller can log it when a provider asks which session a request came from. */
  public readonly sessionId: string;
  /**
   * The field this endpoint streams reasoning under, learned from its own
   * output. Null until it has produced any.
   *
   * Learned rather than configured, because the only reliable source for
   * "what does this endpoint call it" is what the endpoint sent — and the
   * failure for guessing wrong in either direction is a rejected request.
   */
  private reasoningKey: ReasoningKey | null = null;
  /** How this endpoint wants its fields, learned from its refusals. See `RequestDialect`. */
  private dialect: RequestDialect;
  /** Per model: one gateway serves many models, and one refusing a field says nothing of the others. */
  private readonly dialects = new Map<string, RequestDialect>();
  /** SoreQen's hosted models, which read SoreQen Auto's step hints. */
  private readonly soreqenHosted: boolean;

  constructor(options?: OpenAICompatibleProviderOptions) {
    const apiKey =
      options?.apiKey ||
      process.env.OPENCODE_API_KEY ||
      process.env.MIMO_API_KEY ||
      process.env.OPENAI_API_KEY;

    if (!apiKey) {
      throw new Error(
        "[SoreQen Code] No LLM API key configured. Set OPENCODE_API_KEY, MIMO_API_KEY, or OPENAI_API_KEY environment variable, or pass apiKey in constructor options.",
      );
    }

    const baseURL =
      options?.baseURL ||
      process.env.OPENCODE_BASE_URL ||
      process.env.MIMO_BASE_URL ||
      process.env.OPENAI_BASE_URL ||
      "https://api.openai.com/v1"; // standard OpenAI-compatible default

    const model =
      options?.defaultModel ||
      process.env.OPENCODE_MODEL ||
      process.env.MIMO_MODEL ||
      process.env.OPENAI_MODEL ||
      "mimo-v2.6-flash";

    this.defaultModel = model;
    this.fallbackChain = options?.modelFallbackChain ?? [];

    /*
     * The session header, when the endpoint wants one.
     *
     * Generated here rather than taken from the agent's `sessionId`, because
     * this object outlives no session and precedes every one — and because the
     * value only has to be *stable*, not meaningful. A caller that has a real
     * session id may pass it and get better affinity.
     */
    this.sessionId = options?.sessionId ?? `sq_${randomUUID()}`;

    const routingHeader = SESSION_HEADER_BY_HOST.find((h) => h.test.test(baseURL));
    const defaultHeaders: Record<string, string> = {
      ...(routingHeader ? { [routingHeader.header]: this.sessionId } : {}),
      ...options?.headers,
    };

    this.client = new OpenAI({
      apiKey,
      baseURL,
      defaultHeaders,
    });
    this.dialect = dialectFor(baseURL);
    this.soreqenHosted = /\/api\/code\/v1/i.test(baseURL);
  }

  /**
   * Issue the streaming request, retrying transient failures.
   *
   * Here rather than in the agent loop, because this is the line that actually
   * makes the HTTP call — with `stream: true` the promise resolves once the
   * connection is established, so a failure to connect is catchable and a
   * retry is meaningful. Wrapping the generator instead would guard nothing.
   *
   * Uses the shared policy so backoff, jitter and cancellation behave the same
   * everywhere. The previous bespoke loop retried on substring matches against
   * the error message ("429", "500") with a fixed delay and no jitter, so every
   * rate-limited client in a fleet retried in lockstep and recreated the burst.
   */
  private async createStreamWithRetry(
    params: Parameters<OpenAI["chat"]["completions"]["create"]>[0],
    signal?: AbortSignal,
    headers?: Record<string, string>,
  ): Promise<ReturnType<OpenAI["chat"]["completions"]["create"]>> {
    return withRetry(() => this.client.chat.completions.create(params, { signal, ...(headers ? { headers } : {}) }), { signal });
  }

  /** SoreQen Auto's hints, for SoreQen's hosted models only: which kind of step, and how it is going. */
  private stepHeaders(options: LLMChatOptions): Record<string, string> | undefined {
    if (!this.soreqenHosted || (!options.step && !options.failures)) return undefined;
    return {
      ...(options.step ? { "x-soreqen-step": options.step } : {}),
      ...(options.failures ? { "x-soreqen-failures": String(Math.max(0, Math.min(99, Math.round(options.failures)))) } : {}),
    };
  }

  async *chatStream(options: LLMChatOptions): AsyncIterable<LLMResponseChunk> {
    const model = options.model ?? this.defaultModel;

    const messages = toOpenAIMessages(options, this.reasoningKey);

    const tools: OpenAI.ChatCompletionTool[] = (options.tools ?? []).map((t) => ({
      type: "function",
      function: {
        name: t.name,
        description: t.description,
        parameters: t.input_schema as Record<string, unknown>,
      },
    }));

    try {
      const requestFor = (d: RequestDialect): Record<string, unknown> => ({
        model,
        messages,
        tools: tools.length > 0 ? tools : undefined,
        stream: true as const,
        // Raised from 4096 → 32768: large game/app code easily exceeds 4096 tokens.
        // Hitting the old limit caused finish_reason="length" which the loop treated as
        // "completed", silently killing the turn before any files were written.
        [d.tokensField]: options.maxTokens ?? 32768,
        ...(d.temperature ? { temperature: options.temperature ?? 0 } : {}),
        ...reasoningParamsIn(options.reasoning, d, model, options.maxTokens ?? 32768),
        ...(d.streamUsage ? { stream_options: { include_usage: true } } : {}),
        ...(d.cacheKey && options.cacheKey ? { prompt_cache_key: options.cacheKey.slice(0, 64) } : {}),
      });

      let stream: AsyncIterable<OpenAI.ChatCompletionChunk> | null = null;
      // One field learned per refusal, per model: seven is every field this knows about.
      for (let attempt = 0; stream === null; attempt++) {
        const dialect = this.dialects.get(model) ?? this.dialect;
        try {
          stream = (await this.createStreamWithRetry(
            requestFor(dialect) as unknown as Parameters<OpenAI["chat"]["completions"]["create"]>[0],
            options.signal,
            this.stepHeaders(options),
          )) as AsyncIterable<OpenAI.ChatCompletionChunk>;
        } catch (err) {
          const next = attempt < 7 ? adjustDialect(dialect, err) : null;
          if (!next) throw err;
          this.dialects.set(model, next);
        }
      }

      const activeToolCalls = new Map<
        number,
        { id: string; name: string; argumentsJson: string; started: boolean }
      >();

      /*
       * Calls written into the answer as text, lifted back out.
       *
       * Their indices start well above any the endpoint assigns, because the
       * loop keys calls by index and a collision would merge a real call's
       * arguments into a recovered one.
       */
      const textCalls = new TextToolCallExtractor(options.tools ?? []);
      let recovered = 0;
      function* fromText(chunks: ExtractedChunk[]): Generator<LLMResponseChunk> {
        for (const chunk of chunks) {
          if (chunk.type === "text") {
            yield { type: "token", text: chunk.text };
          } else if (chunk.type === "call") {
            const index = 10_000 + recovered;
            const id = `call_text_${Date.now().toString(36)}_${recovered++}`;
            yield { type: "tool_call_start", id, name: chunk.call.name, index };
            yield { type: "tool_call_complete", id, name: chunk.call.name, input: chunk.call.input };
          } else {
            yield { type: "malformed_tool_call", raw: chunk.raw };
          }
        }
      }

      for await (const chunk of stream) {
        // The last chunk, with include_usage: no choices, only the count.
        if (chunk.usage) {
          const usage = chunk.usage as OpenAI.CompletionUsage & { prompt_cache_hit_tokens?: number };
          yield {
            type: "usage",
            inputTokens: usage.prompt_tokens ?? 0,
            // OpenAI and most compatible hosts; DeepSeek names it its own way.
            cachedTokens: usage.prompt_tokens_details?.cached_tokens ?? usage.prompt_cache_hit_tokens ?? 0,
            ...(usage.completion_tokens !== undefined ? { outputTokens: usage.completion_tokens } : {}),
          };
        }
        const choice = chunk.choices[0];
        if (!choice) continue;

        const delta = choice.delta;

        const reasoning = reasoningDeltaOf(delta);
        if (reasoning) {
          this.reasoningKey ??= reasoning.key;
          yield { type: "reasoning", text: reasoning.text };
        }

        if (delta?.content) {
          yield* fromText(textCalls.push(delta.content));
        }

        if (delta?.tool_calls) {
          for (const tc of delta.tool_calls) {
            const index = tc.index;
            let entry = activeToolCalls.get(index);

            if (!entry) {
              entry = {
                id: tc.id ?? `call_${Date.now()}_${index}`,
                name: tc.function?.name ?? "",
                argumentsJson: "",
                started: false,
              };
              activeToolCalls.set(index, entry);
            }

            if (tc.id) entry.id = tc.id;
            if (tc.function?.name) entry.name = tc.function.name;

            if (!entry.started && entry.name) {
              entry.started = true;
              yield { type: "tool_call_start", id: entry.id, name: entry.name, index };
            }

            if (tc.function?.arguments) {
              entry.argumentsJson += tc.function.arguments;
              yield { type: "tool_call_delta", id: entry.id, inputDelta: tc.function.arguments, index };
            }
          }
        }

        if (choice.finish_reason) {
          yield* fromText(textCalls.end());
          for (const [, entry] of activeToolCalls.entries()) {
            // Nearly-JSON is repaired; what cannot be read goes on as such, never as an empty call.
            const parsed = parseToolArguments(entry.argumentsJson);
            yield "error" in parsed
              ? { type: "tool_call_complete", id: entry.id, name: entry.name, input: {}, malformed: { raw: parsed.raw, error: parsed.error } }
              : { type: "tool_call_complete", id: entry.id, name: entry.name, input: parsed.input };
          }
          activeToolCalls.clear();

          let stopReason: "end_turn" | "tool_use" | "max_tokens" | "stop_sequence";
          if (choice.finish_reason === "tool_calls") stopReason = "tool_use";
          else if (choice.finish_reason === "length") stopReason = "max_tokens";
          // The endpoint says "stop" because, as far as it knows, there were
          // no calls. There were; they were in the text.
          else if (recovered > 0) stopReason = "tool_use";
          else stopReason = "end_turn";

          yield { type: "stop", reason: stopReason };
        }
      }
    } catch (err: unknown) {
      /*
       * A cancelled request ends the stream quietly. The loop checks the
       * signal itself and reports a cancellation — which is a correct outcome,
       * not a provider failure, and must not be shown as one.
       */
      if (options.signal?.aborted) return;
      const status = (err as { status?: number }).status;
      const msg = err instanceof Error ? err.message : String(err);
      throw new ProviderError(`The model request failed: ${msg}`, status);
    }
  }
}
