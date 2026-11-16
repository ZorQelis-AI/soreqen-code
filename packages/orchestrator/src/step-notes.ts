/**
 * Notes the loop adds during a turn, sent inside the step they belong to.
 *
 * ## Why they cannot be user messages
 *
 * A thinking model's chat template decides what of its own reasoning it sees
 * again by where the last *user* message is. Measured on OpenCode Go, 2 Nov
 * 2026, with the same history sent four ways (`prompt_tokens` only):
 *
 *                         reasoning kept   a later user message
 *   DeepSeek V4.1 Flash        yes          drops all of it
 *   MiMo V2.6 Flash            yes          keeps it
 *   GLM 5.3 Flash              yes          keeps it
 *
 * So on DeepSeek (and Qwen, and any template built the same way) every user
 * message in the middle of a turn wipes the reasoning of every step before
 * it: the "re-plans every step" bug the working set caused on 31 Oct, at the
 * rate of the loop's notes rather than every step. And because the history
 * before that point is now drawn without its reasoning, it no longer matches
 * what the provider cached: the same probe, a note sent as a user message
 * after three steps, took DeepSeek's cached share from 13,440 tokens to 5,888
 * (the system prompt alone) and billed the whole turn again; the same note
 * inside the last tool result kept 12,288 cached and billed only itself.
 * One session of 1 Nov had nineteen such notes (skills reached, narration,
 * the turn record, process notices, a message sent mid-turn).
 *
 * ## What happens instead
 *
 * Pure, on the way out, so what is stored and what the context engine reads
 * stay as they were, and the same history always gives the same request:
 *
 * - A note after a tool result is appended to that result, as Claude Code
 *   does with its reminders. A step's results and what the loop says about
 *   them are one message from the model's side.
 * - A note after a reply with reasoning (the turn record, a review of the
 *   diff, a message passed over) becomes the result of a call on that reply,
 *   `before_finishing`, so the reply's reasoning stays in view. The reply is
 *   new in this request either way, so adding the call costs no cache.
 * - Anything else, a note at the start of a turn or after a reply without
 *   reasoning, stays a user message: there is nothing for it to wipe.
 *
 * Only text notes move. A picture still needs a user message, the one place
 * chat completions takes an image.
 */

import type { LLMMessage } from "./types.js";

/** The name of the call a note after a reply is the result of. */
export const NOTE_CALL = "before_finishing";

const INTERJECTION = "[The user sent this message while you were working.]";

/** A text message the loop wrote during the turn, or one the person sent while it worked. */
export function isStepNote(m: LLMMessage): boolean {
  return m.role === "user" && !m.frame && typeof m.content === "string" && (m.fromLoop === true || m.content.startsWith(INTERJECTION));
}

/**
 * The history as it is sent: each step note inside its step; see the module
 * comment. `at(i)` is where message `i` of the input ended up, for a cache
 * breakpoint counted on the input.
 */
export function inStep(messages: LLMMessage[]): { messages: LLMMessage[]; at: (i: number) => number } {
  const out: LLMMessage[] = [];
  const where: number[] = [];
  messages.forEach((m, i) => {
    const prev = out[out.length - 1];
    if (isStepNote(m) && prev) {
      const note = m.content as string;
      if (prev.role === "tool" && typeof prev.content === "string") {
        out[out.length - 1] = { ...prev, content: `${prev.content}\n\n${note}` };
        where.push(out.length - 1);
        return;
      }
      if (prev.role === "assistant" && !prev.toolCalls?.length && prev.reasoningContent) {
        const id = `note_${i}`;
        out[out.length - 1] = { ...prev, toolCalls: [{ id, name: NOTE_CALL, input: {} }] };
        out.push({ role: "tool", toolCallId: id, content: note });
        where.push(out.length - 1);
        return;
      }
    }
    out.push(m);
    where.push(out.length - 1);
  });
  return { messages: out, at: (i) => (i >= 0 && i < where.length ? where[i]! : i) };
}
