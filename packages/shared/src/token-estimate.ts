/**
 * How much context something costs, and how much a model has.
 *
 * ## Why an estimate and not a tokenizer
 *
 * Exact counts need the model's own tokenizer, which differs per provider and
 * per model — `tiktoken` for OpenAI, a different vocabulary for Claude,
 * another for MiMo. Bundling all of them costs megabytes and a native build
 * step, and still gets the next model wrong.
 *
 * What this is *for* decides the accuracy needed. It answers "which of these
 * messages is expensive enough to drop", and the answer only has to rank
 * correctly and be conservative at the margin. It is deliberately **not** used
 * for billing — providers report real usage and that is what should be
 * charged.
 *
 * The ratio is calibrated for the mix an agent actually accumulates: source
 * code, JSON tool results, shell output, and file paths. That is denser than
 * prose — punctuation, identifiers and indentation all tokenize poorly — so
 * the usual "4 characters per token" figure for English understates it. 3.5
 * is closer, and erring low on capacity is the safe direction: overestimating
 * cost drops one message too many, underestimating it overflows the window
 * and the request fails outright.
 */

/** Characters per token, for the code-and-JSON mix an agent accumulates. */
const CHARS_PER_TOKEN = 3.5;

/** Rough per-message overhead for role markers and framing the API adds. */
const MESSAGE_OVERHEAD_TOKENS = 4;

/**
 * Approximate tokens in a string.
 *
 * Never returns 0 for non-empty input: a message that costs "nothing" is one a
 * budget will happily keep an unbounded number of.
 */
export function estimateTokens(text: string): number {
  if (!text) return 0;
  return Math.max(1, Math.ceil(text.length / CHARS_PER_TOKEN));
}

/**
 * Approximate tokens for a whole message, including role framing.
 *
 * Reasoning counts: within a turn it is sent back with its message, and once
 * the turn is no longer broken up by a user message at every step the model
 * reads all of it (31 Oct 2026). Between turns it is dropped before this is
 * asked.
 */
export function estimateMessageTokens(message: {
  content: unknown;
  toolCalls?: unknown;
  reasoningContent?: string;
}): number {
  const calls = message.toolCalls ? JSON.stringify(message.toolCalls) : "";
  return (
    estimateContentTokens(message.content) +
    estimateTokens(calls) +
    estimateTokens(message.reasoningContent ?? "") +
    MESSAGE_OVERHEAD_TOKENS
  );
}

/**
 * What an image costs a model: a fixed allowance, not its bytes.
 *
 * Providers bill a picture by its pixels — about 1,600 tokens at the size they
 * scale screenshots down to — whatever its file size. Counting it as text, by
 * the length of its base64, made one screenshot "cost" 100,000 tokens: the
 * meter read 21% while the compaction trigger saw a nearly full window, and
 * the conversation was compacted for pictures that cost almost nothing.
 */
export const IMAGE_TOKENS = 1_600;

function estimateContentTokens(content: unknown): number {
  if (typeof content === "string") return estimateTokens(content);
  if (!Array.isArray(content)) return estimateTokens(JSON.stringify(content ?? ""));
  let total = 0;
  for (const block of content as Array<Record<string, unknown> | null>) {
    if (!block || typeof block !== "object") continue;
    const type = block["type"];
    if (type === "text" && typeof block["text"] === "string") total += estimateTokens(block["text"]);
    else if (type === "image" || type === "image_url" || "image_data" in block) total += IMAGE_TOKENS;
    else total += estimateTokens(JSON.stringify(block));
  }
  return total;
}

/**
 * Total context window by model, in tokens.
 *
 * Matched by prefix, longest first, so `claude-opus-5-20260101` resolves
 * without this table having to know every dated release. A model nobody has
 * listed falls back to a deliberately small window: being wrong in the small
 * direction compacts more than necessary, which is slower; being wrong in the
 * large direction sends a request the provider rejects, which fails the turn.
 */
const CONTEXT_WINDOWS: ReadonlyArray<readonly [prefix: string, tokens: number]> = [
  ["claude-opus-5", 200_000],
  ["claude-sonnet-5", 200_000],
  ["claude-fable-5", 200_000],
  ["claude-haiku-4-5", 200_000],
  ["claude-", 200_000],
  /*
   * OpenCode Zen and Go.
   *
   * These are last-resort values for a process that could not reach the
   * published directory at startup — `model-directory.ts` is what normally
   * answers, and it is current by construction where this table is not. The
   * `-free` variants are separate rows because the free tier of a model does
   * not necessarily serve the same window as the paid one: MiMo-V2.6-Flash is
   * a million tokens on Go and two hundred thousand on Zen's free tier.
   */
  ["mimo-v2.6-flash-free", 200_000],
  ["mimo-v2.5", 1_000_000],
  ["mimo-v2.6", 1_048_576],
  ["mimo-", 128_000],
  ["muse-spark-", 1_048_576],
  ["nemotron-3-ultra", 1_000_000],
  ["nemotron-", 262_144],
  ["ling-", 262_144],
  ["gpt-4o", 128_000],
  ["gpt-4-turbo", 128_000],
  ["gpt-4", 8_192],
  ["gpt-", 128_000],
  ["deepseek-flash", 1_000_000],
  ["deepseek-4.1", 1_000_000],
  ["deepseek-v4.1", 1_000_000],
  ["deepseek-", 64_000],
  ["llama-3", 128_000],
  ["qwen", 32_768],
];

/** Used when the model is unrecognised. Small on purpose — see above. */
export const DEFAULT_CONTEXT_WINDOW = 32_768;

/**
 * Windows learned at run time — from a deployment's model catalogue, or from
 * the provider's own model listing — by exact model name. They win over the
 * table, which is only the fallback for a model nobody has described.
 */
const registered = new Map<string, number>();

export function registerContextWindow(model: string, tokens: number): void {
  if (!model || !Number.isFinite(tokens) || tokens < 1_024) return;
  registered.set(model.trim().toLowerCase(), Math.floor(tokens));
}

/** For tests. */
export function clearRegisteredContextWindows(): void {
  registered.clear();
}

/**
 * A token count as people write it: `1000000`, `1m`, `256k`, `1_000_000`.
 * Null for anything else.
 */
export function parseTokenCount(value: string | number | undefined | null): number | null {
  if (typeof value === "number") return Number.isFinite(value) && value > 0 ? Math.floor(value) : null;
  if (!value) return null;
  const match = /^(\d+(?:\.\d+)?)\s*([km])?$/i.exec(value.trim().replace(/[_,]/g, ""));
  if (!match) return null;
  const unit = match[2]?.toLowerCase();
  const n = Number(match[1]) * (unit === "m" ? 1_000_000 : unit === "k" ? 1_000 : 1);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : null;
}

export function contextWindowFor(model: string | undefined): number {
  if (!model) return DEFAULT_CONTEXT_WINDOW;
  const name = model.toLowerCase();
  const known = registered.get(name.trim());
  if (known) return known;
  let best: number | null = null;
  let bestLen = -1;
  for (const [prefix, tokens] of CONTEXT_WINDOWS) {
    if (name.startsWith(prefix) && prefix.length > bestLen) {
      best = tokens;
      bestLen = prefix.length;
    }
  }
  return best ?? DEFAULT_CONTEXT_WINDOW;
}

/**
 * How much of the window history may occupy.
 *
 * The window has to hold the system prompt, the tool schemas, the history
 * **and** the reply the model is about to generate. Only the last of those is
 * invisible to a naive check, and it is the one that makes a request fail
 * *after* you have paid to send everything else — so it is reserved up front
 * rather than hoped for.
 */
export function historyBudgetFor(options: {
  model?: string;
  systemPromptTokens: number;
  toolSchemaTokens: number;
  maxOutputTokens?: number;
}): number {
  const total = contextWindowFor(options.model);
  const reserved =
    options.systemPromptTokens + options.toolSchemaTokens + (options.maxOutputTokens ?? 8_192);
  // A floor, so a huge system prompt cannot drive the budget negative and
  // compact history down to nothing.
  return Math.max(4_000, total - reserved);
}
