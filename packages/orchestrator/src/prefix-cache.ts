/**
 * Carrying the cache across turns, not only within one.
 *
 * ## What was already cached, and what was not
 *
 * The system prompt and the tool schemas are marked cacheable, so the
 * expensive, unchanging head of every request is billed once and then read at
 * cache rates. Inside a turn that works well: twenty iterations share one
 * prefix.
 *
 * Between turns it stopped there. The *conversation* — every message, tool
 * call and tool result from earlier turns — was re-sent at full price on every
 * request, and in a long session that conversation is most of the payload.
 * The one part of the request that grows without bound was the one part paying
 * full price for every token, every time.
 *
 * ## Why it is not simply another breakpoint
 *
 * Because prefix caching requires the prefix to be **byte-identical** to the
 * previous request, and `compactHistory` is a function of the *whole* history.
 * Add one message and the budget arithmetic changes; a tool result that fit
 * last turn gets truncated this turn; a message that survived gets dropped.
 * Every one of those rewrites a byte somewhere near the front, and a prefix
 * that differs in one byte is a complete cache miss — silently, with no error
 * and a bill that looks the same as before.
 *
 * So this is a design change in how compaction works, not a parameter:
 *
 *   > **Once a prefix has been sent, it is frozen. Compaction may only ever
 *   > act on messages after it.**
 *
 * `sealPrefix` records the length and a fingerprint of what was sent.
 * `stablePrefixLength` reports how much of the current history still matches
 * that seal byte for byte. Compaction is then told to leave that region alone,
 * and the provider marks a cache breakpoint at its end.
 *
 * ## What is given up
 *
 * Compaction's freedom to reclaim tokens from the oldest messages, which is
 * where it would most like to reclaim them. When the sealed prefix alone
 * approaches the budget the seal is **broken** — the whole history is
 * recompacted, one turn pays full price, and a new seal forms. Paying a full
 * prefix occasionally to keep a session inside its window is obviously right;
 * the alternative is a session that cannot continue.
 *
 * The honest summary: this makes long sessions much cheaper and makes exactly
 * one turn — the one where the seal breaks — cost what every turn used to.
 */

import { estimateMessageTokens } from "@sqcode/shared";
import type { LLMMessage } from "./types.js";

export interface PrefixSeal {
  /** Messages in the frozen region. */
  length: number;
  /** Fingerprint of those messages, to detect that history was rewritten
   *  underneath us — an edited message, a restored checkpoint, a `/new`. */
  fingerprint: string;
  /** Rough tokens in the region, to decide when the seal is too expensive
   *  to keep. */
  tokens: number;
}

/**
 * Below this fraction of the budget, a seal is worth keeping.
 *
 * At two thirds there is still a third of the window for the live part of the
 * conversation, which is enough for several exchanges plus a large tool
 * result. Past it, freezing history costs more than the caching saves.
 */
const SEAL_BUDGET_FRACTION = 0.66;

/**
 * A seal is only worth taking once there is something to seal.
 *
 * Four messages is roughly one completed exchange with tool use. Sealing
 * earlier means re-sealing constantly, and each re-seal is the full-price turn
 * this whole mechanism exists to avoid.
 */
const MIN_SEALABLE_MESSAGES = 4;

/**
 * Content-addressed fingerprint of a message range.
 *
 * Includes role, content and tool call identity — everything a provider would
 * serialise — because the comparison being made is "would this produce the
 * same bytes", not "is this the same conversation".
 */
function fingerprint(messages: LLMMessage[]): string {
  let hash = 0x811c9dc5;
  const feed = (text: string): void => {
    for (let i = 0; i < text.length; i++) {
      hash ^= text.charCodeAt(i);
      hash = Math.imul(hash, 0x01000193);
    }
  };

  for (const m of messages) {
    feed(m.role);
    feed(typeof m.content === "string" ? m.content : JSON.stringify(m.content));
    if (m.toolCallId) feed(m.toolCallId);
    for (const call of m.toolCalls ?? []) {
      feed(call.id);
      feed(call.name);
      feed(JSON.stringify(call.input));
    }
  }

  return (hash >>> 0).toString(16);
}

/**
 * How many leading messages are still exactly what was sealed.
 *
 * Returns 0 when the seal no longer applies — the history got shorter, or
 * something inside it changed. Both happen for good reasons (a restored
 * checkpoint, a cleared session, a compaction that had to break the seal), and
 * both mean the cached prefix is gone and a new one must be built.
 */
export function stablePrefixLength(history: LLMMessage[], seal: PrefixSeal | null): number {
  if (!seal || seal.length === 0) return 0;
  if (history.length < seal.length) return 0;
  if (fingerprint(history.slice(0, seal.length)) !== seal.fingerprint) return 0;
  return seal.length;
}

/**
 * Freeze the part of the history worth keeping identical next turn.
 *
 * Called with the messages *as they were actually sent*, after compaction —
 * sealing the uncompacted history would seal bytes the provider never saw, and
 * the next request would miss the cache while believing it had hit it.
 *
 * The last message is deliberately excluded: it is this turn's live exchange,
 * it is the thing most likely to be followed by a tool result that changes
 * nothing before it but everything after, and there is no benefit to sealing
 * a boundary one message earlier than the next request will reach anyway.
 */
export function sealPrefix(
  sentMessages: LLMMessage[],
  budgetTokens: number,
  previous: PrefixSeal | null,
): PrefixSeal | null {
  const sealable = sentMessages.length - 1;
  if (sealable < MIN_SEALABLE_MESSAGES) return previous;

  const ceiling = budgetTokens * SEAL_BUDGET_FRACTION;

  /*
   * Grow the seal only as far as the ceiling allows.
   *
   * Extending an existing seal is the common case and the cheap one: the
   * prefix from last turn is already cached, and adding messages after it
   * keeps that cache valid while making next turn's cached region larger.
   */
  let length = 0;
  let tokens = 0;
  for (let i = 0; i < sealable; i++) {
    const cost = estimateMessageTokens(sentMessages[i]!);
    if (tokens + cost > ceiling) break;
    tokens += cost;
    length = i + 1;
  }

  if (length < MIN_SEALABLE_MESSAGES) {
    /*
     * The head alone exceeds the ceiling.
     *
     * Nothing can be sealed, and any previous seal is now false — it describes
     * a region compaction is about to start rewriting. Returning null breaks
     * it explicitly, which costs one full-price turn and is the correct
     * outcome: a stale seal would make compaction refuse to touch messages it
     * must touch, and the request would exceed the window.
     */
    return null;
  }

  return { length, tokens, fingerprint: fingerprint(sentMessages.slice(0, length)) };
}

/**
 * Where the provider should place its conversation cache breakpoint.
 *
 * Null means "do not place one" — either nothing is sealed yet, or the seal no
 * longer matches. Providers that do not support explicit breakpoints ignore
 * this entirely and lose nothing; the mechanism degrades to what it was.
 */
export function cacheBreakpointIndex(
  history: LLMMessage[],
  seal: PrefixSeal | null,
): number | null {
  const stable = stablePrefixLength(history, seal);
  return stable >= MIN_SEALABLE_MESSAGES ? stable - 1 : null;
}
