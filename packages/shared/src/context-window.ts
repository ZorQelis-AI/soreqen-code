/**
 * How full the model's context window is, and when it is condensed.
 *
 * Every surface shows the same numbers — the web meter, the CLI's `/context` —
 * and every surface accepts the same `/autocompact` setting, so both live here.
 *
 * ## The setting
 *
 * One number, read two ways, because both are what people type:
 *
 *   - **1 to 100** is a percentage of the window: `/autocompact 80`.
 *   - **Above 100** is a token count: `/autocompact 150000`, or `150k`.
 *
 * Unset means `DEFAULT_AUTO_COMPACT_PERCENT`. There is deliberately no "off":
 * a conversation that is never condensed does not keep its context, it hits
 * the window and the model refuses the request.
 */

/**
 * When a session is condensed, as a share of the window.
 *
 * A hundred, which reads like "never" and is not. The window still has to hold
 * the system prompt, the tool schemas and the room reserved for the reply, so
 * the conversation's own trigger — computed in the agent loop — sits below
 * this by exactly those amounts. What a hundred buys is that nothing is
 * condensed *early*: a session with room left keeps its history word for word,
 * and pays for a summary only at the point where the alternative is a request
 * the provider refuses.
 *
 * It was ninety, which on a one-million-token window meant summarising a
 * session that still had a hundred thousand tokens of headroom.
 */
export const DEFAULT_AUTO_COMPACT_PERCENT = 100;
/** Below this, a session would spend more on summarising than on working. */
export const MIN_AUTO_COMPACT_PERCENT = 20;
export const MIN_AUTO_COMPACT_TOKENS = 8_000;

export interface ContextUsageBreakdown {
  system: number;
  tools: number;
  messages: number;
  workingSet?: number;
}

export interface ContextUsageSnapshot {
  usedTokens: number;
  windowTokens: number;
  compactAtTokens: number;
  breakdown: ContextUsageBreakdown;
}

/** The token count at which a session is condensed, for a given window. */
export function autoCompactTokens(setting: number | null | undefined, windowTokens: number): number {
  const value = setting ?? DEFAULT_AUTO_COMPACT_PERCENT;
  if (value <= 100) {
    const percent = Math.min(100, Math.max(MIN_AUTO_COMPACT_PERCENT, value));
    return Math.floor((windowTokens * percent) / 100);
  }
  return Math.min(windowTokens, Math.max(MIN_AUTO_COMPACT_TOKENS, Math.floor(value)));
}

/**
 * Conversation a session carries before it is checkpointed, when nobody has
 * set `/autocompact`.
 *
 * Checkpointing moves older history into task state and keeps a verbatim
 * tail, which is what makes a long session feel unlimited: requests stay
 * lean, fast and cheap, and the model's attention stays on what matters.
 * Removed on 24 Sep 2026 so a 100% default would mean 100% — and then a 1M
 * model re-sent 359k tokens of history on every step and never checkpointed.
 * The fix for that complaint was an honest meter, not no checkpoints.
 */
export const DEFAULT_CHECKPOINT_HISTORY_TOKENS = 160_000;

/**
 * The defaults, by the size of the model's window (1 Oct 2026, from the
 * engine audit). One fixed 160k point was too late for a 200k model, whose
 * window it nearly filled, and too early for a 1M one, which re-read its
 * files after every cut while three quarters of its window sat unused. Each
 * tier sets where a session is checkpointed, the verbatim tail it keeps, how
 * often the background reader takes notes, and how much of the files being
 * worked on is put back after a cut.
 *
 * Raised by half on 19 Oct 2026, asked for by the person: a 1M model was cut
 * at about 360k of request (320k of conversation plus the system prompt and
 * tools) and is now cut at about 540k (480k of conversation). The cut is
 * still capped by what the window can hold (`hardHistoryLimit` in the
 * budget), so a smaller window is never pushed past its edge.
 */
export interface CheckpointTier {
  checkpointAt: number;
  keep: number;
  extractEvery: number;
  restoreTokens: number;
}

/*
 * What a checkpoint leaves is the same on every window: about 32k tokens of
 * conversation (a 24k verbatim tail, the person's last words in the marker,
 * up to 8k of the files being worked on), never more than
 * `CHECKPOINT_MAX_AFTER`. The tail used to scale with the window (64k to
 * 96k, plus 25k restored), so a cut on a 1M model left 80k+ and the next one
 * came sooner (asked for 16 Oct 2026: "around 32K, not 80K+"). The task
 * state carries the rest; a bigger window only moves when the cut happens.
 */
export function checkpointTierFor(windowTokens: number): CheckpointTier {
  // A 128k window cannot hold half again as much beside its prompt and reply: it stays at 80k.
  if (windowTokens < 160_000) return { checkpointAt: 80_000, keep: 16_000, extractEvery: 40_000, restoreTokens: 6_000 };
  if (windowTokens < 300_000) return { checkpointAt: 120_000, keep: 16_000, extractEvery: 60_000, restoreTokens: 6_000 };
  if (windowTokens < 600_000) return { checkpointAt: 240_000, keep: 24_000, extractEvery: 120_000, restoreTokens: 8_000 };
  if (windowTokens < 1_200_000) return { checkpointAt: 480_000, keep: 24_000, extractEvery: 180_000, restoreTokens: 8_000 };
  return { checkpointAt: 960_000, keep: 24_000, extractEvery: 240_000, restoreTokens: 8_000 };
}

/** The most conversation a checkpoint may leave, whatever the tail's last messages weigh. */
export const CHECKPOINT_MAX_AFTER = 64_000;

/**
 * Where a session is actually checkpointed, in tokens of the whole request —
 * what a meter must show. `overheadTokens` is what every request carries
 * besides history: system prompt, tool schemas, working set.
 *
 * An explicit `/autocompact` is taken at its word. The default is the lower of
 * the window and the default history point.
 */
export function effectiveCompactTokens(
  setting: number | null | undefined,
  windowTokens: number,
  overheadTokens: number,
): number {
  const threshold = autoCompactTokens(setting, windowTokens);
  return setting == null ? Math.min(threshold, overheadTokens + checkpointTierFor(windowTokens).checkpointAt) : threshold;
}

export type AutoCompactParse =
  | { ok: true; value: number | null }
  | { ok: false; error: string };

/**
 * Read what someone typed after `/autocompact`.
 *
 * `null` means "back to the default". Anything unreadable is an error with a
 * sentence saying what would have worked, rather than a silent no-op.
 */
export function parseAutoCompact(raw: string): AutoCompactParse {
  const text = raw.trim().toLowerCase().replace(/,/g, "");
  if (!text) return { ok: false, error: "Give a percentage (80) or a token count (150k)." };
  if (text === "default" || text === "reset" || text === "auto") return { ok: true, value: null };

  const match = text.match(/^(\d+(?:\.\d+)?)\s*(%|k|m)?$/);
  if (!match) {
    return { ok: false, error: `'${raw.trim()}' is not a percentage (80) or a token count (150k).` };
  }
  const number = Number(match[1]);
  const unit = match[2];

  if (unit === "%" || (!unit && number <= 100)) {
    if (number < MIN_AUTO_COMPACT_PERCENT || number > 100) {
      return { ok: false, error: `A percentage must be between ${MIN_AUTO_COMPACT_PERCENT} and 100.` };
    }
    return { ok: true, value: Math.round(number) };
  }

  const tokens = Math.round(number * (unit === "m" ? 1_000_000 : unit === "k" ? 1_000 : 1));
  if (tokens < MIN_AUTO_COMPACT_TOKENS) {
    return { ok: false, error: `A token count must be at least ${formatTokenCount(MIN_AUTO_COMPACT_TOKENS)}.` };
  }
  return { ok: true, value: tokens };
}

/**
 * "90%", "150k tokens", or — unset — what the default really does.
 *
 * Unset used to read "100%", which is exactly what the meter promised while
 * sessions were checkpointed far earlier: the mismatch reported on 24 Sep 2026.
 */
export function describeAutoCompact(setting: number | null | undefined, windowTokens?: number): string {
  if (setting == null) {
    return windowTokens
      ? `${formatTokenCount(checkpointTierFor(windowTokens).checkpointAt)} of conversation (the default for this model)`
      : "a point scaled to the model's window (the default)";
  }
  return setting <= 100 ? `${setting}%` : `${formatTokenCount(setting)} tokens`;
}

/**
 * The context panel's one line about checkpoints: "Auto checkpoint at 480k".
 * The longer story (older turns move into task memory, /checkpoint-at changes
 * the point) is the line's tooltip, not more text in the panel.
 */
export function checkpointLine(setting: number | null | undefined, windowTokens?: number): string {
  if (setting == null) {
    return windowTokens ? `Auto checkpoint at ${formatTokenCount(checkpointTierFor(windowTokens).checkpointAt)}` : "Auto checkpoint on";
  }
  return `Auto checkpoint at ${setting <= 100 ? `${setting}%` : formatTokenCount(setting)}`;
}

/** 950 · 12.3k · 524k · 1.2M */
export function formatTokenCount(n: number): string {
  if (n < 1_000) return String(Math.max(0, Math.round(n)));
  if (n < 100_000) return `${(n / 1_000).toFixed(1).replace(/\.0$/, "")}k`;
  if (n < 1_000_000) return `${Math.round(n / 1_000)}k`;
  return `${(n / 1_000_000).toFixed(1).replace(/\.0$/, "")}M`;
}
