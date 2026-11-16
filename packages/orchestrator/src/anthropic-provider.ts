/**
 * Claude, on Anthropic's own Messages API.
 *
 * ## Why not the OpenAI-compatible endpoint
 *
 * Claude was reached through chat completions — Anthropic's compatibility
 * endpoint, or a gateway translating to it — and three things were lost on
 * the way (13 Nov 2026):
 *
 *   - **Thinking.** A translating gateway refused the field outright ("thinking:
 *     cannot be represented by anthropic-messages"), and where thinking ran,
 *     its signed blocks never came back, so every step reasoned from nothing.
 *   - **Prompt caching.** No `cache_control`: a long session paid full price
 *     for its whole conversation on every step.
 *   - **Tool results** as separate messages, one per call, which the Messages
 *     API reads as separate turns.
 *
 * ## What this keeps intact
 *
 * A thinking block's signature is bound to the conversation before it: edit
 * an earlier turn and every later block is void. So the history goes out
 * append-only as far as this provider can make it:
 *
 *   - Thinking blocks are replayed exactly as they came (`thinkingBlocks`).
 *   - The working set, rebuilt every step, is a turn-scoped system message
 *     (`clear_at: "next_user_message"`), and every copy already sent stays
 *     where it was, verbatim. A cleared copy renders nothing and costs no
 *     tokens (measured 13 Nov 2026: 425 input tokens with or without a 1,350
 *     token cleared copy), yet the conversation the blocks were bound to is
 *     unchanged. Removed instead, the previous step's thinking was void.
 *   - What the engine does rewrite (a checkpoint, a reclaim) is covered by
 *     `prefix_mismatch_behavior: "drop_block"`: a block that no longer fits is
 *     dropped by the API, not a 400.
 *
 * Everything an endpoint refuses — a beta it does not pass on, a level of
 * effort a model does not take, a `max_tokens` above its cap — is learned
 * from the refusal and not sent again, the way `openai-provider.ts` learns a
 * dialect.
 */

import Anthropic from "@anthropic-ai/sdk";
import { contentHash } from "./context/task-state.js";
import { levelOn, ladderBelow, ladderFromRefusal, reasoningLadderFor, registerReasoningLadder, thinkingBudgetFor, type ReasoningLevel, type ThinkingLevel } from "@sqcode/shared";
import { ProviderError } from "./openai-provider.js";
import type { LLMChatOptions, LLMContentBlock, LLMMessage, LLMProvider, LLMResponseChunk, ThinkingBlock } from "./types.js";

type Params = Anthropic.Beta.Messages.MessageCreateParamsStreaming;
type MessageParam = Anthropic.Beta.Messages.BetaMessageParam;
type ContentBlock = Anthropic.Beta.Messages.BetaContentBlockParam;
type ToolResultContent = Anthropic.Beta.Messages.BetaToolResultBlockParam["content"];

const BINDING_BETA = "thinking-binding-controls-2026-08-01";
const CLEAR_AT_BETA = "mid-conversation-system-clear-at-2026-08-21";

/** Providers that route a conversation by a header of their own. */
const SESSION_HEADER_BY_HOST: { test: RegExp; header: string }[] = [{ test: /opencode\.ai|opencode\./i, header: "x-opencode-session" }];

/** How a model thinks, by family. */
export type ClaudeThinking = "adaptive" | "budget" | "none";

/**
 * Adaptive thinking (Claude 4.6 and later, Fable, Mythos) takes effort as a
 * level; Claude 3.7 and the 4.x models before 4.6 think to a token budget;
 * older Claude does not think.
 */
export function claudeThinkingFor(model: string): ClaudeThinking {
  const m = model.toLowerCase().replace(/^.*\//, "");
  if (/claude-(fable|mythos)/.test(m)) return "adaptive";
  if (/claude-(opus|sonnet|haiku)-(4-[6-9]|[5-9])/.test(m)) return "adaptive";
  if (/claude-(opus|sonnet|haiku)-4|claude-3-7/.test(m)) return "budget";
  return "none";
}

/** Whether a model id is Claude's. */
export function isClaudeModel(model: string): boolean {
  return /^(.*\/)?claude-/i.test(model.trim());
}

/** The most a model may write in one response, where it is lower than what is asked for. */
function outputCapOf(model: string): number {
  const m = model.toLowerCase();
  if (/claude-3-(5|haiku|opus|sonnet)|claude-3-5/.test(m)) return 8_192;
  if (/claude-(opus)-4(-0|-1)?(-|$)/.test(m) && !/4-[5-9]/.test(m)) return 32_000;
  return 128_000;
}

/** What one endpoint and model has refused, so it is not sent again. */
interface Dialect {
  binding: boolean;
  clearAt: boolean;
  thinking: ClaudeThinking;
  maxTokens?: number;
  effort: boolean;
}

/**
 * The endpoint's base, as the SDK wants it: without the `/v1` the SDK adds.
 * OpenCode's Claude models are served at `…/zen/go/v1/messages` (or
 * `…/zen/v1/messages`), the base its chat completions use.
 */
export function messagesBaseURL(baseURL: string | undefined): string | undefined {
  if (!baseURL) return undefined;
  return baseURL.replace(/\/+$/, "").replace(/\/v1$/, "");
}

export interface AnthropicMessagesProviderOptions {
  apiKey?: string;
  baseURL?: string;
  defaultModel?: string;
  sessionId?: string;
  headers?: Record<string, string>;
}

export class AnthropicMessagesProvider implements LLMProvider {
  public name = "anthropic_messages";
  public readonly defaultModel: string;
  private readonly client: Anthropic;
  private readonly dialects = new Map<string, Dialect>();
  /**
   * Every working set sent, by the message it followed, verbatim. Sent again in
   * the same place on every later request: see the header. Cleared copies cost
   * nothing, and a checkpoint drops the messages they are anchored to.
   */
  private readonly frames = new Map<string, string>();

  constructor(options: AnthropicMessagesProviderOptions = {}) {
    const apiKey = options.apiKey || process.env["ANTHROPIC_API_KEY"] || "missing-key";
    const baseURL = messagesBaseURL(options.baseURL);
    const routing = baseURL ? SESSION_HEADER_BY_HOST.find((h) => h.test.test(baseURL)) : undefined;
    this.client = new Anthropic({
      apiKey,
      ...(baseURL ? { baseURL } : {}),
      // Transient failures (429, 5xx, a dropped connection) are retried here, before anything streams.
      maxRetries: 3,
      defaultHeaders: {
        /*
         * The key as `x-api-key`, never `Authorization: Bearer`. The SDK sends
         * the bearer form since 1.x; Anthropic takes either, but OpenCode and
         * other gateways speaking this API take only `x-api-key` ("OpenCode
         * Go requires an API key", 13 Nov 2026).
         */
        "x-api-key": apiKey,
        authorization: null,
        ...(routing && options.sessionId ? { [routing.header]: options.sessionId } : {}),
        ...options.headers,
      },
    });
    this.defaultModel = options.defaultModel ?? process.env["ANTHROPIC_MODEL"] ?? "claude-sonnet-5";
  }

  private dialectOf(model: string): Dialect {
    let d = this.dialects.get(model);
    if (!d) {
      const thinking = claudeThinkingFor(model);
      d = { binding: thinking === "adaptive", clearAt: true, thinking, effort: thinking === "adaptive" };
      this.dialects.set(model, d);
    }
    return d;
  }

  async *chatStream(options: LLMChatOptions): AsyncIterable<LLMResponseChunk> {
    const model = (options.model ?? this.defaultModel).replace(/^anthropic\//, "");
    const dialect = this.dialectOf(model);
    let stripThinking = false;

    for (let attempt = 0; ; attempt++) {
      const { params, betas, framed } = this.buildRequest(options, model, dialect, stripThinking);
      let stream: AsyncIterable<Anthropic.Beta.Messages.BetaRawMessageStreamEvent>;
      try {
        stream = await this.client.beta.messages.create(
          { ...params, ...(betas.length > 0 ? { betas } : {}) },
          options.signal ? { signal: options.signal } : undefined,
        );
      } catch (err) {
        if (attempt < 6) {
          const learned = learnFrom(err, model, dialect, options.reasoning);
          if (learned === "strip") {
            if (!stripThinking) {
              stripThinking = true;
              continue;
            }
          } else if (learned) {
            continue;
          }
        }
        throw asProviderError(err);
      }
      // Remembered only once accepted: a refused request's frame was never part of the conversation.
      if (framed) this.frames.set(framed.anchor, framed.text);
      yield* readStream(stream);
      return;
    }
  }

  /** The request body, from the loop's history. Pure apart from reading `frames`. */
  buildRequest(
    options: LLMChatOptions,
    model: string,
    dialect: Dialect,
    stripThinking = false,
  ): { params: Params; betas: string[]; framed: { anchor: string; text: string } | null } {
    const betas: string[] = [];
    let frameText: string | null = null;
    const history: LLMMessage[] = [];
    for (const m of options.messages) {
      if (m.frame) frameText = textOf(m.content);
      else history.push(m);
    }

    const turns = toAnthropicTurns(history, stripThinking || dialect.thinking === "none");
    const anchors = turns.map((t) => t.anchor);

    /*
     * Earlier working sets, back where they were. A copy can only follow a
     * user turn that an assistant turn follows; anything else (a message
     * that arrived after the results, merged into their turn) is left out —
     * one edit, which `drop_block` absorbs.
     */
    const messages: MessageParam[] = [];
    const useClearAt = dialect.clearAt;
    for (let i = 0; i < turns.length; i++) {
      const turn = turns[i]!;
      messages.push(turn.message);
      const previous = useClearAt && turn.message.role === "user" ? this.frames.get(turn.anchor) : undefined;
      if (previous !== undefined && turns[i + 1]?.message.role === "assistant") {
        messages.push({ role: "system", clear_at: "next_user_message", content: previous });
      }
    }

    // This step's working set.
    let framed: { anchor: string; text: string } | null = null;
    const last = messages[messages.length - 1];
    if (frameText) {
      if (useClearAt && last?.role === "user") {
        messages.push({ role: "system", clear_at: "next_user_message", content: frameText });
        framed = { anchor: anchors[anchors.length - 1]!, text: frameText };
      } else if (last?.role === "user") {
        // No turn-scoped messages here: inside the last user turn, as before.
        last.content = [...asBlocks(last.content), { type: "text", text: frameText }];
      } else {
        messages.push({ role: "user", content: frameText });
      }
    }
    if (framed || messages.some((m) => m.role === "system")) betas.push(CLEAR_AT_BETA);
    // A conversation never ends on Claude's own words: there is no prefill.
    if (messages[messages.length - 1]?.role === "assistant") messages.push({ role: "user", content: "Continue." });
    this.forgetFramesNotIn(anchors);

    placeCacheBreakpoints(messages, options.cacheBreakpointIndex == null ? null : turnIndexFor(history, turns, options.cacheBreakpointIndex));

    const tools = (options.tools ?? []).map((t) => ({ name: t.name, description: t.description, input_schema: t.input_schema as Anthropic.Beta.Messages.BetaTool.InputSchema }));
    const cap = Math.min(dialect.maxTokens ?? Number.MAX_SAFE_INTEGER, outputCapOf(model));
    const effort = options.reasoning ?? "high";
    const wanted = options.maxTokens ?? (effort === "max" || effort === "apex" ? 64_000 : 32_000);
    const maxTokens = Math.max(1_024, Math.min(wanted, cap));

    const params: Params = {
      model,
      max_tokens: maxTokens,
      stream: true,
      // One breakpoint at the end of the system prompt caches the tools too: they come first.
      system: [{ type: "text", text: options.system, cache_control: { type: "ephemeral" } }],
      messages,
      ...(tools.length > 0 ? { tools } : {}),
    };

    if (dialect.thinking === "adaptive") {
      params.thinking = {
        type: "adaptive",
        display: "summarized",
        ...(dialect.binding ? { block_binding: { prefix_mismatch_behavior: "drop_block" } } : {}),
      };
      if (dialect.binding) betas.push(BINDING_BETA);
      if (dialect.effort) params.output_config = { effort: effortFor(model, effort) as "low" };
    } else if (dialect.thinking === "budget" && options.reasoning) {
      // Below the room for the answer, and at least the 1,024 the API asks for.
      const budget = Math.max(1_024, Math.min(thinkingBudgetFor(options.reasoning), maxTokens - 2_048));
      if (budget < maxTokens) params.thinking = { type: "enabled", budget_tokens: budget };
    } else if (options.temperature !== undefined && dialect.thinking === "none") {
      // Only where nothing thinks: thinking runs at the default temperature.
      (params as unknown as Record<string, unknown>)["temperature"] = Math.min(1, options.temperature);
    }
    return { params, betas, framed };
  }

  private forgetFramesNotIn(anchors: string[]): void {
    if (this.frames.size < 64) return;
    const live = new Set(anchors);
    for (const key of this.frames.keys()) if (!live.has(key)) this.frames.delete(key);
  }
}

/** A tier's effort on a model, from its ladder (learned or known). */
function effortFor(model: string, effort: ReasoningLevel): ThinkingLevel {
  return levelOn(effort, reasoningLadderFor(model, "chat")) as ThinkingLevel;
}

/**
 * What a refusal teaches, applied to `dialect`. True when the request should
 * be sent again as changed, "strip" when its thinking blocks are bound to a
 * conversation this one no longer is, and false for a real failure.
 */
function learnFrom(err: unknown, model: string, dialect: Dialect, reasoning: ReasoningLevel | undefined): boolean | "strip" {
  const status = (err as { status?: number }).status;
  if (status !== 400) return false;
  const message = err instanceof Error ? err.message : String(err);
  if (/bound to a different conversation|Invalid `?signature`?/i.test(message)) return "strip";
  if (dialect.binding && /block_binding|thinking-binding-controls|anthropic-beta|beta/i.test(message)) {
    dialect.binding = false;
    return true;
  }
  if (dialect.clearAt && /clear_at|role ['"]?system['"]?|system message|mid-conversation/i.test(message)) {
    dialect.clearAt = false;
    return true;
  }
  if (dialect.effort && /effort/i.test(message)) {
    const ladder = ladderFromRefusal(message);
    const current = reasoningLadderFor(model, "chat");
    const refused = reasoning ? levelOn(reasoning, current) : "high";
    const next = ladder ?? (current.length > 1 ? ladderBelow(current, refused) : null);
    if (next && next.join() !== current.join()) {
      registerReasoningLadder(model, next);
      return true;
    }
    dialect.effort = false;
    return true;
  }
  const cap = /max_tokens[^0-9]*\d+\s*>\s*(\d+)|maximum (?:allowed )?(?:value|of)?[^0-9]*(\d{3,})/i.exec(message);
  if (cap && /max_tokens/i.test(message)) {
    const limit = Number(cap[1] ?? cap[2]);
    if (limit > 0 && limit !== dialect.maxTokens) {
      dialect.maxTokens = limit;
      return true;
    }
  }
  if (dialect.thinking === "adaptive" && /adaptive/i.test(message)) {
    dialect.thinking = "budget";
    dialect.binding = false;
    dialect.effort = false;
    return true;
  }
  if (dialect.thinking !== "none" && /thinking/i.test(message) && /not supported|does not support|unsupported/i.test(message)) {
    dialect.thinking = "none";
    dialect.binding = false;
    dialect.effort = false;
    return true;
  }
  return false;
}

function asProviderError(err: unknown): Error {
  if (err instanceof Error && (err.name === "AbortError" || /aborted/i.test(err.message))) return err;
  const status = (err as { status?: number }).status;
  const message = err instanceof Error ? err.message : String(err);
  return new ProviderError(`The model request failed: ${message}`, status);
}

/** One Messages API turn, and what identifies it for the working sets anchored after it. */
interface Turn {
  message: MessageParam;
  anchor: string;
  /** Indexes into the loop's history this turn was built from. */
  from: number;
  to: number;
}

/**
 * The loop's history as Messages API turns.
 *
 * Tool results are user turns, all of one round's in one; a message that
 * follows them joins that turn after the results. An assistant message
 * carries its thinking blocks first, then its text, then its calls.
 */
export function toAnthropicTurns(history: LLMMessage[], withoutThinking = false): Turn[] {
  const turns: Turn[] = [];
  const push = (message: MessageParam, i: number): void => {
    const prev = turns[turns.length - 1];
    if (prev && prev.message.role === message.role && message.role !== "system") {
      // Same role twice in a row is one turn; tool results keep their place first.
      const merged = [...asBlocks(prev.message.content), ...asBlocks(message.content)];
      const results = merged.filter((b) => b.type === "tool_result");
      prev.message = { ...prev.message, content: message.role === "user" ? [...results, ...merged.filter((b) => b.type !== "tool_result")] : merged } as MessageParam;
      prev.to = i + 1;
      return;
    }
    turns.push({ message, anchor: "", from: i, to: i + 1 });
  };

  for (let i = 0; i < history.length; i++) {
    const m = history[i]!;
    if (m.role === "system") continue;
    if (m.role === "tool") {
      push({ role: "user", content: [{ type: "tool_result", tool_use_id: m.toolCallId ?? "unknown", content: toolResultContent(m.content) }] }, i);
      continue;
    }
    if (m.role === "assistant") {
      const blocks: ContentBlock[] = [];
      if (!withoutThinking) {
        for (const t of m.thinkingBlocks ?? []) blocks.push(t.type === "thinking" ? { type: "thinking", thinking: t.thinking, signature: t.signature } : { type: "redacted_thinking", data: t.data });
      }
      const text = textOf(m.content);
      if (text.trim()) blocks.push({ type: "text", text });
      for (const call of m.toolCalls ?? []) blocks.push({ type: "tool_use", id: call.id, name: call.name, input: call.input });
      // Nothing at all to say is not a turn: the API refuses an empty one.
      if (blocks.length === 0) continue;
      push({ role: "assistant", content: blocks }, i);
      continue;
    }
    const content = typeof m.content === "string" ? m.content : contentBlocks(m.content);
    if (typeof content === "string" ? !content.trim() : content.length === 0) continue;
    push({ role: "user", content }, i);
  }

  // Calls without results get one: the API refuses a tool_use left unanswered.
  for (let i = 0; i < turns.length; i++) {
    const turn = turns[i]!;
    if (turn.message.role !== "assistant") continue;
    const calls = asBlocks(turn.message.content).filter((b): b is Anthropic.Beta.Messages.BetaToolUseBlockParam => b.type === "tool_use");
    if (calls.length === 0) continue;
    const next = turns[i + 1];
    const answered = new Set(next?.message.role === "user" ? asBlocks(next.message.content).flatMap((b) => (b.type === "tool_result" ? [b.tool_use_id] : [])) : []);
    const missing = calls.filter((c) => !answered.has(c.id)).map((c): ContentBlock => ({ type: "tool_result", tool_use_id: c.id, content: "(interrupted: no result)", is_error: true }));
    if (missing.length === 0) continue;
    if (next?.message.role === "user") {
      const blocks = asBlocks(next.message.content);
      next.message = { role: "user", content: [...blocks.filter((b) => b.type === "tool_result"), ...missing, ...blocks.filter((b) => b.type !== "tool_result")] };
    } else {
      turns.splice(i + 1, 0, { message: { role: "user", content: missing }, anchor: "", from: turn.to, to: turn.to });
    }
  }

  for (const turn of turns) turn.anchor = anchorOf(turn.message);
  return turns;
}

/** What identifies a user turn across requests: its tool results' ids, or its words. */
function anchorOf(message: MessageParam): string {
  const blocks = asBlocks(message.content);
  const ids = blocks.flatMap((b) => (b.type === "tool_result" ? [b.tool_use_id] : []));
  if (ids.length > 0) return `results:${ids.join(",")}`;
  return `${message.role}:${contentHash(JSON.stringify(blocks.map((b) => (b.type === "text" ? b.text : b.type))))}`;
}

/** Which turn holds the loop's history index `index`. */
function turnIndexFor(history: LLMMessage[], turns: Turn[], index: number): number | null {
  if (index < 0 || index >= history.length) return null;
  for (let t = turns.length - 1; t >= 0; t--) if (turns[t]!.from <= index) return t;
  return null;
}

/**
 * Cache breakpoints on the conversation: the last user turn, so the next
 * request finds everything up to here cached, and the sealed prefix the loop
 * names, when it names one. With the system prompt's, three of the four
 * allowed. A working set takes none: the turn before it does.
 */
function placeCacheBreakpoints(messages: MessageParam[], sealedTurn: number | null): void {
  const mark = (i: number): void => {
    const m = messages[i];
    if (!m || m.role === "system") return;
    const blocks = asBlocks(m.content);
    const last = blocks[blocks.length - 1];
    if (!last || last.type === "thinking" || last.type === "redacted_thinking") return;
    blocks[blocks.length - 1] = { ...last, cache_control: { type: "ephemeral" } } as ContentBlock;
    m.content = blocks as typeof m.content;
  };
  let lastUser = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]!.role === "user") {
      lastUser = i;
      break;
    }
  }
  if (lastUser >= 0) mark(lastUser);
  if (sealedTurn !== null) {
    // Turn indexes count the loop's turns; working sets in between shift them.
    let seen = -1;
    for (let i = 0; i < messages.length; i++) {
      if (messages[i]!.role === "system") continue;
      seen++;
      if (seen === sealedTurn) {
        if (i !== lastUser) mark(i);
        break;
      }
    }
  }
}

function asBlocks(content: MessageParam["content"] | undefined): ContentBlock[] {
  if (content === undefined) return [];
  if (typeof content === "string") return content ? [{ type: "text", text: content }] : [];
  return [...(content as ContentBlock[])];
}

function textOf(content: LLMMessage["content"]): string {
  if (typeof content === "string") return content;
  return content.map((b) => (b.type === "text" ? b.text : "")).filter(Boolean).join("\n");
}

function imageBlock(b: Extract<LLMContentBlock, { type: "image" }>): Anthropic.Beta.Messages.BetaImageBlockParam {
  const match = /^data:([^;]+);base64,(.*)$/s.exec(b.image_data);
  const mediaType = (match?.[1] ?? b.media_type ?? "image/png") as "image/png";
  return { type: "image", source: { type: "base64", media_type: mediaType, data: match ? match[2]! : b.image_data } };
}

function contentBlocks(blocks: LLMContentBlock[]): ContentBlock[] {
  const out: ContentBlock[] = [];
  for (const b of blocks) {
    if (b.type === "text") {
      if (b.text) out.push({ type: "text", text: b.text });
    } else if (b.type === "image") out.push(imageBlock(b));
    else if (b.type === "tool_result") out.push({ type: "tool_result", tool_use_id: b.tool_use_id, content: b.content, ...(b.is_error ? { is_error: true } : {}) });
    else if (b.type === "tool_use") out.push({ type: "tool_use", id: b.id, name: b.name, input: b.input });
  }
  return out;
}

/** A tool's result: its text, and any pictures it returned, in the result itself. */
function toolResultContent(content: LLMMessage["content"]): ToolResultContent {
  if (typeof content === "string") return content || "(no output)";
  const parts: Array<Anthropic.Beta.Messages.BetaTextBlockParam | Anthropic.Beta.Messages.BetaImageBlockParam> = [];
  for (const b of content) {
    if (b.type === "text" && b.text) parts.push({ type: "text", text: b.text });
    else if (b.type === "image") parts.push(imageBlock(b));
    else if (b.type === "tool_result") parts.push({ type: "text", text: b.content });
  }
  return parts.length > 0 ? parts : "(no output)";
}

/** The stream, as the loop's chunks. */
async function* readStream(stream: AsyncIterable<Anthropic.Beta.Messages.BetaRawMessageStreamEvent>): AsyncIterable<LLMResponseChunk> {
  let block: { kind: "thinking"; text: string; signature: string } | { kind: "redacted"; data: string } | { kind: "tool"; id: string; name: string; json: string } | null = null;
  let usage: { input: number; cached: number } | null = null;
  let wroteText = false;

  for await (const event of stream) {
    switch (event.type) {
      case "message_start": {
        const u = event.message.usage;
        const read = u.cache_read_input_tokens ?? 0;
        usage = { input: (u.input_tokens ?? 0) + read + (u.cache_creation_input_tokens ?? 0), cached: read };
        break;
      }
      case "content_block_start": {
        const b = event.content_block;
        if (b.type === "thinking") block = { kind: "thinking", text: b.thinking ?? "", signature: b.signature ?? "" };
        else if (b.type === "redacted_thinking") block = { kind: "redacted", data: b.data };
        else if (b.type === "tool_use") {
          block = { kind: "tool", id: b.id, name: b.name, json: "" };
          yield { type: "tool_call_start", id: b.id, name: b.name, index: event.index };
        } else if (b.type === "text") {
          block = null;
          if (b.text) {
            wroteText = true;
            yield { type: "token", text: b.text };
          }
        } else block = null;
        if (block?.kind === "thinking" && block.text) yield { type: "reasoning", text: block.text };
        break;
      }
      case "content_block_delta": {
        const d = event.delta;
        if (d.type === "text_delta") {
          wroteText = true;
          yield { type: "token", text: d.text };
        } else if (d.type === "thinking_delta" && block?.kind === "thinking") {
          block.text += d.thinking;
          yield { type: "reasoning", text: d.thinking };
        } else if (d.type === "signature_delta" && block?.kind === "thinking") {
          block.signature += d.signature;
        } else if (d.type === "input_json_delta" && block?.kind === "tool") {
          block.json += d.partial_json;
          yield { type: "tool_call_delta", id: block.id, inputDelta: d.partial_json, index: event.index };
        }
        break;
      }
      case "content_block_stop": {
        if (block?.kind === "thinking" && block.signature) {
          const kept: ThinkingBlock = { type: "thinking", thinking: block.text, signature: block.signature };
          yield { type: "thinking_block", block: kept };
        } else if (block?.kind === "redacted") {
          yield { type: "thinking_block", block: { type: "redacted_thinking", data: block.data } };
        } else if (block?.kind === "tool") {
          let input: Record<string, unknown> = {};
          let malformed: { raw: string; error: string } | undefined;
          try {
            input = block.json.trim() ? (JSON.parse(block.json) as Record<string, unknown>) : {};
          } catch (err) {
            malformed = { raw: block.json, error: err instanceof Error ? err.message : String(err) };
          }
          yield { type: "tool_call_complete", id: block.id, name: block.name, input, ...(malformed ? { malformed } : {}) };
        }
        block = null;
        break;
      }
      case "message_delta": {
        if (usage) {
          yield { type: "usage", inputTokens: usage.input, cachedTokens: usage.cached, outputTokens: event.usage?.output_tokens ?? 0 };
          usage = null;
        }
        const reason = event.delta.stop_reason;
        if (reason === "refusal" && !wroteText) {
          yield { type: "token", text: "Claude declined to continue this response." };
        }
        if (reason) {
          yield {
            type: "stop",
            reason: reason === "tool_use" ? "tool_use" : reason === "max_tokens" || reason === "model_context_window_exceeded" ? "max_tokens" : reason === "stop_sequence" ? "stop_sequence" : "end_turn",
          };
        }
        break;
      }
      default:
        break;
    }
  }
}
