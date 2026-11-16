/**
 * What a model can actually do, as opposed to what we hope it can do.
 *
 * ## Why this exists separately from the context window
 *
 * A context window is a number every caller needs and nobody can get wrong
 * without noticing. A *capability* is different: if the harness assumes a
 * model reads images and it does not, the request is rejected by the provider
 * — or worse, silently answered from the text around the picture. That is the
 * failure this module exists to prevent, and it is the one that produced "I
 * cannot see images in this environment" while a perfectly good screenshot sat
 * in the workspace.
 *
 * ## Where the answer comes from
 *
 * In order:
 *
 *   1. **What a provider told us**, registered at startup from its own
 *      catalogue (`registerModelCapabilities`). This is the only source that
 *      is current by construction.
 *   2. **The family table below**, for a model nothing has registered. It is
 *      deliberately short and conservative, and every row is a family whose
 *      vision support is a published, stable fact rather than a guess.
 *   3. **`false`.** An unknown model is assumed to be text-only, because the
 *      cost of the two mistakes is not symmetric: refusing to send an image to
 *      a model that could have read it wastes one tool call and says so, while
 *      sending one to a model that cannot fails the whole request.
 */

/** Everything the harness needs to know about a model before it calls it. */
export interface ModelCapabilities {
  /** The model accepts image content blocks alongside text. */
  vision?: boolean;
  /** Total context window, in tokens. */
  contextWindow?: number;
  /** Largest single response, in tokens. */
  maxOutput?: number;
}

const registered = new Map<string, ModelCapabilities>();

/**
 * Record what a provider says about one of its models.
 *
 * Merges rather than replaces, so a catalogue that knows the window and a
 * listing that knows the modalities can each contribute what they know.
 */
export function registerModelCapabilities(model: string, caps: ModelCapabilities): void {
  const key = model.trim().toLowerCase();
  if (!key) return;
  registered.set(key, { ...registered.get(key), ...caps });
}

/** For tests, and for a process whose configuration changed. */
export function clearRegisteredCapabilities(): void {
  registered.clear();
}

/** What has been registered for a model, if anything. */
export function registeredCapabilities(model: string | undefined): ModelCapabilities | null {
  if (!model) return null;
  return registered.get(model.trim().toLowerCase()) ?? null;
}

/**
 * Model families that read images, by name prefix.
 *
 * Longest match wins, so `deepseek-v4.1-flash` can say yes while a bare
 * `deepseek-` says nothing. A prefix is listed only when the family's vision
 * support is documented rather than inferred.
 */
const VISION_FAMILIES: ReadonlyArray<readonly [prefix: string, vision: boolean]> = [
  // OpenCode Zen / Go, confirmed against models.dev's modalities.
  ["mimo-v2.5", true],
  ["mimo-v2.6", true],
  ["mimo-v2-omni", true],
  ["muse-spark-", true],
  ["deepseek-v4.1", true],
  ["deepseek-v4-flash-vision", true],
  ["deepseek-4.1", true],
  // Checked against models.dev on 23 Oct 2026, when a failed directory load
  // left GLM 5.3 Flash to this table and it was refused an image. GLM 5.3
  // itself is text-only; its Flash reads images, video and PDFs.
  ["glm-5.3-flash", true],
  ["kimi-k3", true],
  ["kimi-k2.5", true],
  ["kimi-k2.6", true],
  ["kimi-k2.7", true],
  ["qwen3.5-plus", true],
  ["qwen3.6-plus", true],
  ["qwen3.7-plus", true],
  ["qwen3.8", true],
  ["minimax-m3", true],
  ["step-5", true],
  ["longcat-2.5", true],
  ["mistral-large-4", true],
  ["muse-wonder", true],
  ["grok-build", true],
  ["nemotron-3.5-super-vl", true],
  // Text-only families that would otherwise be caught by a shorter prefix.
  ["mimo-v2.5-pro", false],
  ["deepseek-flash", false],
  ["deepseek-chat", false],
  ["deepseek-reasoner", false],
  ["nemotron-", false],
  ["ling-", false],
  // The big multimodal families.
  ["claude-", true],
  ["gpt-4o", true],
  ["gpt-4-turbo", true],
  ["gpt-5", true],
  ["gpt-6", true],
  ["gemini-", true],
  ["grok-4", true],
  ["glm-4v", true],
  ["qwen-vl", true],
  ["qwen2-vl", true],
  ["llava", true],
];

/**
 * Can this model be shown a picture?
 *
 * The question every image-bearing code path asks before it spends anything
 * encoding one.
 */
export function modelSupportsVision(model: string | undefined): boolean {
  const caps = registeredCapabilities(model);
  if (caps && typeof caps.vision === "boolean") return caps.vision;
  if (!model) return false;

  const name = model.trim().toLowerCase();
  let best: boolean | null = null;
  let bestLen = -1;
  for (const [prefix, vision] of VISION_FAMILIES) {
    if (name.startsWith(prefix) && prefix.length > bestLen) {
      best = vision;
      bestLen = prefix.length;
    }
  }
  return best ?? false;
}

/**
 * Whether a model's window is large enough that compaction should aim at the
 * roomier target. See `compactionTargetFor`.
 */
export const LARGE_WINDOW_TOKENS = 500_000;

/** Tokens a compaction aims to leave behind: about 32k on every window (16 Oct 2026; see `checkpointTierFor`). */
export function compactionTargetFor(_windowTokens: number): number {
  return 32_000;
}
