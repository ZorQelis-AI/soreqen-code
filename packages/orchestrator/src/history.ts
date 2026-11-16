/**
 * A stored conversation, made into one a provider will accept.
 *
 * ## The defect this exists for
 *
 * The gateway persists a turn as it streams: one `assistant` row per
 * `tool_call` event, one `tool` row per `tool_result`. The loop announces
 * every call in a batch *before* executing any of them, so three parallel
 * reads were stored as
 *
 *   assistant(call A) · assistant(call B) · assistant(call C) · tool(A) · tool(B) · tool(C)
 *
 * and replayed to the model in exactly that shape on the next message. The
 * OpenAI chat format requires an assistant message with `tool_calls` to be
 * followed *immediately* by a tool message for each of its calls. The first
 * assistant row is followed by another assistant row, so a strict endpoint
 * refuses the whole request — on the second message of any session whose
 * first message used a parallel batch. Lenient endpoints accepted it, which is
 * why it looked intermittent: it depended on the model and on whether the
 * agent happened to read two files at once.
 *
 * A turn that is cancelled between a call and its result leaves the same
 * problem in a different form: a call with no answer.
 *
 * ## What it does
 *
 *   - Merges consecutive assistant tool-call rows into one message.
 *   - Puts each call's result directly after it, in the order the calls were
 *     made.
 *   - Gives an unanswered call a result that says it was interrupted, rather
 *     than dropping the call — the model needs to know it asked, or it will
 *     assume the work was done.
 *   - Drops a tool result that answers no call, which no endpoint accepts.
 */

import type { LLMMessage, LLMToolCall } from "./types.js";

export const INTERRUPTED_RESULT =
  "No result was recorded for this call — the turn was interrupted before it finished.";

function textOf(message: LLMMessage): string {
  if (typeof message.content === "string") return message.content.trim();
  return message.content
    .filter((b): b is { type: "text"; text: string } => b.type === "text")
    .map((b) => b.text)
    .join("\n")
    .trim();
}

export function normalizeHistory(messages: LLMMessage[]): LLMMessage[] {
  const out: LLMMessage[] = [];
  let i = 0;

  while (i < messages.length) {
    const message = messages[i]!;

    if (message.role === "assistant" && message.toolCalls && message.toolCalls.length > 0) {
      const calls: LLMToolCall[] = [];
      const seen = new Set<string>();
      const texts: string[] = [];
      let reasoningContent = message.reasoningContent;
      let thinkingBlocks = message.thinkingBlocks;
      // The newest merged row's id, so the message can still name where it is
      // stored — see `LLMMessage.id`.
      let id = message.id;

      let j = i;
      while (
        j < messages.length &&
        messages[j]!.role === "assistant" &&
        (messages[j]!.toolCalls?.length ?? 0) > 0
      ) {
        const row = messages[j]!;
        const text = textOf(row);
        if (text) texts.push(text);
        reasoningContent ??= row.reasoningContent;
        thinkingBlocks ??= row.thinkingBlocks;
        id = row.id ?? id;
        for (const call of row.toolCalls!) {
          // The same call stored twice — a retried write, a replayed event —
          // is still one call, and a duplicate id is rejected outright.
          if (seen.has(call.id)) continue;
          seen.add(call.id);
          calls.push(call);
        }
        j++;
      }

      const results = new Map<string, LLMMessage>();
      while (j < messages.length && messages[j]!.role === "tool") {
        const result = messages[j]!;
        if (result.toolCallId && seen.has(result.toolCallId) && !results.has(result.toolCallId)) {
          results.set(result.toolCallId, result);
        }
        j++;
      }

      out.push({
        role: "assistant",
        content: texts.join("\n\n"),
        toolCalls: calls,
        ...(reasoningContent ? { reasoningContent } : {}),
        ...(thinkingBlocks?.length ? { thinkingBlocks } : {}),
        ...(id ? { id } : {}),
      });
      for (const call of calls) {
        out.push(
          results.get(call.id) ?? { role: "tool", toolCallId: call.id, content: INTERRUPTED_RESULT },
        );
      }

      i = j;
      continue;
    }

    // A result with no call in front of it answers nothing.
    if (message.role === "tool") {
      i++;
      continue;
    }

    out.push(message);
    i++;
  }

  return out;
}
