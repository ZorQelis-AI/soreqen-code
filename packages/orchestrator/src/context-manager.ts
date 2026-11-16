/**
 * Keeping a turn inside the model's context window.
 *
 * ## What was wrong
 *
 * The previous version counted **messages**. It kept the first message and the
 * most recent six, and truncated anything in between whose text ran past 500
 * characters — but only once the history exceeded 25 messages. Three problems
 * followed, and they compound:
 *
 *   - **A message is not a unit of cost.** One `read_file` on a 200 KB file is
 *     a single message. Under a message-count rule it is free, and it alone
 *     can exceed the entire window.
 *   - **It rarely ran.** The loop capped at 25 iterations, so a history long
 *     enough to trip a 25-*message* threshold usually arrived near the end of
 *     the turn, after the expensive requests had already been sent.
 *   - **It claimed to summarise and did not.** The docstring promised no loss
 *     of "semantic intent"; the code kept a 200-character prefix and discarded
 *     the rest. An agent told the first line of a stack trace and nothing else
 *     will confidently debug the wrong thing.
 *
 * ## The pairing bug
 *
 * The token-budget rewrite fixed those and introduced a worse one. It gave up
 * messages one at a time, and an assistant message that *made* tool calls was
 * "anything else", so it was dropped whole — while the results answering it
 * were kept as stubs. Every provider pairs a tool result with the call before
 * it, so the next request was refused outright:
 *
 *   400 Messages with role 'tool' must be a response to a preceding message
 *       with 'tool_calls'
 *
 * That ended long turns at exactly the moment they had done the most work,
 * which is how it was found. Compaction now works in **units**: an assistant
 * message together with the results of its calls is one thing, kept or given
 * up together, and a result is never separated from its call.
 *
 * ## What it does now
 *
 * Budget in tokens, spend it on the most useful units, and be honest in the
 * marker about what was dropped.
 *
 * Two things are never touched: the **first unit**, which is the goal (or the
 * summary that replaced the early session), and the **most recent exchanges**,
 * which are what the agent is reasoning about right now. Everything between is
 * negotiable, and is given up **largest first**. Tool output goes before
 * decisions: a call's results are shortened to stubs first, and the call
 * itself is dropped only if that was not enough.
 *
 * Long sessions are condensed properly before it comes to this — see
 * `summarizer.ts`. This is the fallback that always works, including when a
 * summary could not be written.
 */

import { wholeLimit } from "./tool-result.js";
import { estimateMessageTokens, estimateTokens } from "@sqcode/shared";
import type { LLMMessage } from "./types.js";

export interface ContextCompactionOptions {
  /** Token ceiling for the whole history. Compaction is a no-op below it. */
  maxTokens?: number;
  /** Recent messages kept verbatim, whatever they cost. */
  preserveRecentCount?: number;
  /** Ceiling for any single tool result, applied before the budget is
   *  considered at all. */
  maxToolResultTokens?: number;
  /**
   * Leading messages that must be returned byte-for-byte unchanged.
   *
   * This is what makes cross-turn prefix caching possible. A provider's cache
   * matches on an exact prefix, and compaction is a function of the whole
   * history — so without this, adding one message silently rewrites something
   * near the front and turns every request into a cache miss with no error and
   * no visible symptom beyond the bill.
   *
   * Compaction therefore treats this region as untouchable and takes its
   * savings from everything after it. `prefix-cache.ts` decides how large the
   * region may get, and breaks the seal when keeping it would cost more than
   * it saves.
   */
  frozenPrefixLength?: number;
}

const DEFAULTS = {
  maxTokens: 100_000,
  preserveRecentCount: 8,
  maxToolResultTokens: 4_000,
} as const;

const STUB = "[Earlier tool output dropped to fit the context window. Re-run if needed.]";
const STUB_TOKENS = estimateTokens(STUB) + 4;

/**
 * Shorten one oversized tool result, keeping both ends.
 *
 * Head and tail rather than a prefix, because output is rarely front-loaded:
 * a test run puts the summary at the bottom, a stack trace puts the throwing
 * frame at the top, and a file listing is interesting at both. Keeping only
 * the start is the one choice guaranteed to lose the conclusion.
 */
export function truncateToolResult(content: string, maxTokens: number): string {
  const budgetChars = maxTokens * 3.5;
  if (content.length <= budgetChars) return content;

  const keep = Math.floor(budgetChars / 2);
  /*
   * Cut on whole lines. A cut mid-line left `const isAutho` at the end of the
   * head and `rized = true` at the start of the tail — code that reads as
   * broken, and a model told a file is broken goes and reads it again
   * (audit, 1 Oct 2026). A cut moves back (or forward) to the nearest line
   * break, unless the lines are so long that would lose most of the budget.
   */
  let head = content.slice(0, keep);
  const headBreak = head.lastIndexOf("\n");
  if (headBreak > keep * 0.6) head = head.slice(0, headBreak);
  let tail = content.slice(-keep);
  const tailBreak = tail.indexOf("\n");
  if (tailBreak !== -1 && tailBreak < keep * 0.4) tail = tail.slice(tailBreak + 1);
  const droppedChars = content.length - head.length - tail.length;
  const droppedLines = content.slice(head.length, content.length - tail.length).split("\n").length - 1;

  return (
    `${head}\n\n[... ${droppedLines > 0 ? `${droppedLines.toLocaleString()} lines, ` : ""}${droppedChars.toLocaleString()} characters ` +
    `(~${Math.ceil(droppedChars / 3.5).toLocaleString()} tokens) omitted from the middle ` +
    `of this output. Re-run the tool with a narrower query if you need what is missing. ...]\n\n` +
    `${tail}`
  );
}

/** Tokens the whole history would cost as-is. */
export function estimateHistoryTokens(messages: LLMMessage[]): number {
  return messages.reduce((sum, m) => sum + estimateMessageTokens(m), 0);
}

/**
 * A span of history that must be kept or given up as a whole.
 *
 * `calls` is an assistant message that made tool calls plus the results that
 * immediately answer them. `single` is any other message. `stray` is a tool
 * result with no call in front of it — which no endpoint accepts, and which
 * the provider drops before sending — kept separate so compaction can still
 * shorten it.
 */
export interface HistoryUnit {
  start: number;
  /** Exclusive. */
  end: number;
  kind: "calls" | "single" | "stray";
}

export function groupUnits(messages: LLMMessage[]): HistoryUnit[] {
  const units: HistoryUnit[] = [];
  let i = 0;
  while (i < messages.length) {
    const message = messages[i]!;
    if (message.role === "assistant" && message.toolCalls && message.toolCalls.length > 0) {
      const ids = new Set(message.toolCalls.map((c) => c.id));
      let j = i + 1;
      while (
        j < messages.length &&
        messages[j]!.role === "tool" &&
        (!messages[j]!.toolCallId || ids.has(messages[j]!.toolCallId!))
      ) {
        j++;
      }
      units.push({ start: i, end: j, kind: "calls" });
      i = j;
      continue;
    }
    units.push({ start: i, end: i + 1, kind: message.role === "tool" ? "stray" : "single" });
    i++;
  }
  return units;
}

/**
 * Fit `messages` into a token budget.
 *
 * Returns a new array; the input is not mutated, because the caller keeps the
 * full history for persistence and only the compacted copy goes to the model.
 */
export function compactHistory(
  messages: LLMMessage[],
  options?: ContextCompactionOptions,
): LLMMessage[] {
  const maxTokens = options?.maxTokens ?? DEFAULTS.maxTokens;
  const preserveRecentCount = options?.preserveRecentCount ?? DEFAULTS.preserveRecentCount;
  const maxToolResultTokens = options?.maxToolResultTokens ?? DEFAULTS.maxToolResultTokens;
  // Clamped: a stale seal longer than the history would freeze messages that
  // do not exist and, worse, protect indices past the end from being reclaimed.
  const frozen = Math.min(Math.max(options?.frozenPrefixLength ?? 0, 0), messages.length);

  if (messages.length === 0) return [];

  // Pass 1: cap any single tool result. This runs unconditionally, not only
  // when the budget is tight — a 200 KB blob is not worth sending even when it
  // technically fits, and capping it here is what stops one read from
  // evicting the entire earlier conversation.
  // A research report, a skill's text or a file read is kept whole (see WHOLE_LIMITS): its own, larger cap.
  const toolOf = new Map<string, string>();
  for (const m of messages) for (const c of m.toolCalls ?? []) toolOf.set(c.id, c.name);
  const capFor = (m: LLMMessage): number => {
    const document = m.toolCallId ? wholeLimit(toolOf.get(m.toolCallId) ?? "") : undefined;
    return document ? Math.max(maxToolResultTokens, Math.ceil(document / 4)) : maxToolResultTokens;
  };
  const capped: LLMMessage[] = messages.map((m, i) => {
    // Inside the frozen prefix, even a re-truncation to the *same* length is
    // forbidden: the point is byte identity with what was already sent, and
    // those messages were capped when they were first sent.
    if (i < frozen) return m;
    if (m.role !== "tool" || typeof m.content !== "string") return m;
    const cap = capFor(m);
    if (estimateTokens(m.content) <= cap) return m;
    return { ...m, content: truncateToolResult(m.content, cap) };
  });

  if (estimateHistoryTokens(capped) <= maxTokens) return capped;

  // Pass 2: give up the middle, a unit at a time, largest first.
  const units = groupUnits(capped);
  const lastIndex = capped.length - 1;
  const recentFrom = Math.max(1, capped.length - preserveRecentCount);

  const isProtected = (u: HistoryUnit): boolean =>
    u.start === 0 || u.start < frozen || u.end > recentFrom || u.end - 1 === lastIndex;

  const stubbed = new Set<number>();
  const dropped = new Set<HistoryUnit>();

  const tokensOf = (u: HistoryUnit): number => {
    let sum = 0;
    for (let i = u.start; i < u.end; i++) {
      sum += stubbed.has(i) ? STUB_TOKENS : estimateMessageTokens(capped[i]!);
    }
    return sum;
  };

  const negotiable = units.filter((u) => !isProtected(u)).sort((a, b) => tokensOf(b) - tokensOf(a));
  let running = estimateHistoryTokens(capped);

  // Stage A: tool output becomes stubs; other messages are dropped whole.
  for (const unit of negotiable) {
    if (running <= maxTokens) break;
    if (unit.kind === "single") {
      dropped.add(unit);
      running -= tokensOf(unit);
      continue;
    }
    for (let i = unit.start; i < unit.end; i++) {
      const message = capped[i]!;
      if (message.role !== "tool") continue;
      const saved = estimateMessageTokens(message) - STUB_TOKENS;
      if (saved <= 0) continue;
      stubbed.add(i);
      running -= saved;
    }
  }

  // Stage B: still over, so whole calls go too — each with its results, never
  // one without the other. A stray result is already a one-line stub and
  // buys nothing more by going.
  if (running > maxTokens) {
    for (const unit of negotiable) {
      if (running <= maxTokens) break;
      if (unit.kind !== "calls" || dropped.has(unit)) continue;
      dropped.add(unit);
      running -= tokensOf(unit);
    }
  }

  const out: LLMMessage[] = [];
  let elided = 0;
  let markerAt = 0;

  units.forEach((unit, u) => {
    if (dropped.has(unit)) {
      elided += unit.end - unit.start;
      return;
    }
    for (let i = unit.start; i < unit.end; i++) {
      const message = capped[i]!;
      out.push(stubbed.has(i) ? { ...message, content: STUB } : message);
    }
    if (u === 0) markerAt = out.length;
  });

  // Say so, once, rather than letting the model infer a gap it cannot see.
  if (elided > 0) {
    out.splice(markerAt, 0, {
      role: "user",
      content: `[${elided} earlier message(s) omitted to fit the context window.]`,
    });
  }

  /*
   * Pass 3: the protected set can be too big on its own.
   *
   * Passes 1 and 2 only ever touch the negotiable middle, so if the goal plus
   * the recent tail already exceed the budget there is nothing left for them
   * to give up — and the function used to return an over-budget history
   * anyway, quietly. That is the worst possible outcome: the caller believes
   * it has been fitted, sends it, and the provider rejects the request after
   * the whole prompt has been transmitted.
   *
   * So the recent tool results get squeezed too, in decreasing steps. Recent
   * output is the most useful thing in the window, which is exactly why it is
   * shrunk last and gradually rather than dropped.
   *
   * The goal and the final message are still never removed. If they alone
   * exceed the budget this returns over — but at that point the model cannot
   * be asked the question at all, and silently discarding the question is not
   * an improvement on failing loudly.
   */
  for (const cap of [2_000, 800, 300, 100]) {
    if (estimateHistoryTokens(out) <= maxTokens) break;
    for (let i = 0; i < out.length; i++) {
      // A marker spliced in shifts every later index, and means the seal is
      // already broken — a message inside the negotiable range was dropped
      // and the caller will re-seal. Only an untouched prefix is protected.
      if (elided === 0 && i < frozen) continue;
      const msg = out[i]!;
      if (msg.role !== "tool" || typeof msg.content !== "string") continue;
      if (estimateTokens(msg.content) <= cap) continue;
      out[i] = { ...msg, content: truncateToolResult(msg.content, cap) };
    }
  }

  return out;
}
