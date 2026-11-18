/**
 * The models a deployment serves, read once from the environment.
 *
 * ## Why this lives in the orchestrator
 *
 * The gateway and the CLI both need the answer to "what does the name
 * `deepseek-4.1-flash` mean". They used to have separate answers: the gateway
 * had a catalogue and the CLI's `/model` merely changed a string, so switching
 * the CLI to any model not served by the *current* endpoint sent that name to
 * the wrong provider and failed with that provider's "unknown model" error.
 * One parser, one meaning.
 *
 * ## Format
 *
 *   SOREQEN_MODELS="id|baseURL|KEY_ENV_VAR|upstream model|Label|context window,…"
 *
 * The first three fields are required. The **third is the name of the
 * environment variable** holding the key, never the key — a configuration
 * string that contains a secret ends up in a process listing, a crash dump and
 * a support ticket.
 *
 * The fourth and fifth are optional and exist for one reason: the name a
 * person uses for a model and the name its API accepts are often different.
 * DeepSeek's endpoint accepts `deepseek-flash`; what someone picks from a menu
 * is "DeepSeek 4.1 Flash". Without the split, either the menu showed an API
 * identifier or the API was sent a marketing name.
 *
 * The sixth, also optional, is the context window (`1m`, `256k`, `1000000`).
 *
 * The seventh, also optional, is the model's thinking levels, weakest first,
 * separated by `/` (`low/medium/high/xhigh/max`), for a model whose levels no
 * table here knows. SoreQen's six effort tiers are spread over them (see
 * `reasoning-ladder.ts` in `@sqcode/shared`).
 *
 * ## The context window, from the source
 *
 * A model's window decides when history is compacted and what the context
 * meter shows, and a wrong one is expensive either way: too small compacts a
 * conversation that had room, too large sends requests the provider rejects.
 * So it is taken, in order, from the catalogue entry, from the published model
 * directory (`model-directory.ts`), from the provider's own model listing
 * (both via `discoverContextWindows`, run when a deployment starts), and only
 * then from the built-in table in `@sqcode/shared`.
 *
 * The same pass learns whether each model reads images, which is the one fact
 * no listing here carries and the one the image tools cannot work without.
 */

import {
  contextWindowFor,
  parseTokenCount,
  registerContextWindow,
  registerModelCapabilities,
  registerReasoningLadder,
} from "@sqcode/shared";
import { loadModelDirectory, lookupDirectoryModel } from "./model-directory.js";

export interface ModelEndpoint {
  /** What callers ask for. Stable, lowercase, no spaces. */
  id: string;
  /** What a person reads in a picker. */
  label: string;
  /** What the provider's API is actually sent. */
  upstreamModel: string;
  baseURL: string;
  apiKey: string;
  /** The window the catalogue states, when it states one. */
  contextWindow?: number;
  /**
   * The picker's heading for it, when the host names one — the desktop app's
   * "Your own API key models". Otherwise the provider, from the base URL.
   */
  group?: string;
  /** A heading above the groups, when the host has two kinds of model to tell apart. */
  section?: string;
  /** The wire to speak, when the host says; otherwise worked out (`protocolFor`). */
  protocol?: "auto" | "anthropic" | "openai-responses" | "openai-chat";
  /** Extra headers a provider someone added by hand asked for. */
  headers?: Record<string, string>;
  /** A line under the name in a picker: what a request costs ("about 2.4 credits a request"). */
  detail?: string;
  /** The model a new session starts on, when it is not simply the first. */
  isDefault?: boolean;
  /**
   * Switched off in Settings > Models: still usable (a session already on it
   * keeps working), but left out of the picker.
   */
  hidden?: boolean;
}

export function parseModelCatalogue(
  env: Record<string, string | undefined> = process.env,
): ModelEndpoint[] {
  const raw = env["SOREQEN_MODELS"];
  if (!raw) return [];

  const catalogue: ModelEndpoint[] = [];
  const seen = new Set<string>();

  for (const entry of raw.split(",")) {
    const [id, baseURL, keyVar, upstream, label, window, levels] = entry.split("|").map((f) => f.trim());
    if (!id || !baseURL || !keyVar) continue;

    /*
     * A model whose key is missing is left out, not listed and broken.
     *
     * Listing it would put an option in the picker that fails the moment it
     * is chosen, with an authentication error that names the provider rather
     * than the missing variable.
     */
    const apiKey = env[keyVar];
    if (!apiKey) continue;

    // First definition wins. A duplicate id is a configuration mistake, and
    // silently taking the last one would make the order of a long string
    // decide which account gets billed.
    if (seen.has(id)) continue;
    seen.add(id);

    const contextWindow = parseTokenCount(window) ?? undefined;
    const endpoint: ModelEndpoint = {
      id,
      baseURL,
      apiKey,
      upstreamModel: upstream || id,
      label: label || id,
      ...(contextWindow ? { contextWindow } : {}),
    };
    if (contextWindow) rememberWindow(endpoint, contextWindow);
    if (levels) {
      registerReasoningLadder(endpoint.id, levels.split("/"));
      registerReasoningLadder(endpoint.upstreamModel, levels.split("/"));
    }
    catalogue.push(endpoint);
  }

  return catalogue;
}

/** Under both names, since callers use either. */
function rememberWindow(endpoint: ModelEndpoint, tokens: number): void {
  registerContextWindow(endpoint.id, tokens);
  registerContextWindow(endpoint.upstreamModel, tokens);
}

/** Likewise for everything else a model can do — see `model-capabilities.ts`. */
function rememberCapabilities(
  endpoint: ModelEndpoint,
  caps: { vision?: boolean; contextWindow?: number; maxOutput?: number },
): void {
  registerModelCapabilities(endpoint.id, caps);
  registerModelCapabilities(endpoint.upstreamModel, caps);
}

/** Field names providers use for a model's window in their listings. */
const WINDOW_FIELDS = [
  "context_length",
  "context_window",
  "max_context_length",
  "max_context_tokens",
  "max_model_len",
  "max_input_tokens",
  "input_token_limit",
  "contextLength",
  "contextWindow",
];

/** A model's window, from one entry of a provider's model listing. */
export function windowFromListing(entry: unknown): number | null {
  if (!entry || typeof entry !== "object") return null;
  const record = entry as Record<string, unknown>;
  for (const field of WINDOW_FIELDS) {
    const tokens = parseTokenCount(record[field] as string | number | undefined);
    if (tokens) return tokens;
  }
  for (const nested of ["top_provider", "limits", "limit", "meta", "metadata"]) {
    const inner = record[nested];
    if (inner && typeof inner === "object") {
      const tokens = windowFromListing(inner);
      if (tokens) return tokens;
    }
  }
  return null;
}

/**
 * Ask each provider how large its models' windows are.
 *
 * OpenAI-compatible endpoints list their models at `GET {baseURL}/models`,
 * and many — OpenRouter, vLLM, Together, OpenCode — say the window there.
 * Endpoints that do not, or that cannot be reached, keep the catalogue's or
 * the table's value. Never throws, and gives up after `timeoutMs` per
 * endpoint, so a slow provider cannot hold up a deployment starting.
 *
 * Resolves to what it learned, by catalogue id.
 */
export async function discoverContextWindows(
  catalogue: ModelEndpoint[],
  options: { fetch?: typeof fetch; timeoutMs?: number } = {},
): Promise<Record<string, number>> {
  const doFetch = options.fetch ?? globalThis.fetch;
  const learned: Record<string, number> = {};
  if (typeof doFetch !== "function") return learned;

  /*
   * The published directory first.
   *
   * It answers for every model these endpoints serve, including the two facts
   * a `GET /models` listing here does not carry: the output ceiling and
   * whether the model reads images. Endpoints it does not know fall through
   * to the listing below exactly as they did before.
   */
  const directory = await loadModelDirectory({ fetch: doFetch, timeoutMs: options.timeoutMs });
  const unresolved: ModelEndpoint[] = [];
  for (const endpoint of catalogue) {
    const known = lookupDirectoryModel(directory, endpoint.baseURL, endpoint.upstreamModel);
    if (known) {
      rememberCapabilities(endpoint, {
        ...(known.vision !== undefined ? { vision: known.vision } : {}),
        ...(known.contextWindow ? { contextWindow: known.contextWindow } : {}),
        ...(known.maxOutput ? { maxOutput: known.maxOutput } : {}),
      });
      // The catalogue's own window still wins: a deployment that states one
      // has said something deliberate about its own quota.
      if (!endpoint.contextWindow && known.contextWindow) {
        rememberWindow(endpoint, known.contextWindow);
        learned[endpoint.id] = known.contextWindow;
      }
    }
    if (!endpoint.contextWindow && learned[endpoint.id] === undefined) unresolved.push(endpoint);
  }

  const byBase = new Map<string, ModelEndpoint[]>();
  for (const endpoint of unresolved) {
    const key = `${endpoint.baseURL}|${endpoint.apiKey}`;
    byBase.set(key, [...(byBase.get(key) ?? []), endpoint]);
  }

  await Promise.all(
    [...byBase.values()].map(async (endpoints) => {
      const { baseURL, apiKey } = endpoints[0]!;
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? 6_000);
      try {
        const res = await doFetch(`${baseURL.replace(/\/+$/, "")}/models`, {
          headers: { Authorization: `Bearer ${apiKey}`, Accept: "application/json" },
          signal: controller.signal,
        });
        if (!res.ok) return;
        const body = (await res.json()) as { data?: unknown; models?: unknown };
        const list = Array.isArray(body.data) ? body.data : Array.isArray(body.models) ? body.models : [];
        for (const endpoint of endpoints) {
          const wanted = endpoint.upstreamModel.toLowerCase();
          const entry = list.find((item) => {
            const id = item && typeof item === "object" ? (item as { id?: unknown; name?: unknown }).id ?? (item as { name?: unknown }).name : null;
            if (typeof id !== "string") return false;
            const name = id.toLowerCase();
            return name === wanted || name.endsWith(`/${wanted}`);
          });
          const tokens = windowFromListing(entry);
          if (tokens) {
            rememberWindow(endpoint, tokens);
            learned[endpoint.id] = tokens;
          }
        }
      } catch {
        // Unreachable or unexpected: the table's value stands.
      } finally {
        clearTimeout(timer);
      }
    }),
  );
  return learned;
}

/** The window a catalogue model will be treated as having, right now. */
export function windowForEndpoint(endpoint: ModelEndpoint): number {
  return endpoint.contextWindow ?? contextWindowFor(endpoint.id);
}

/**
 * Resolve a name against the catalogue.
 *
 * By id first, then by upstream model, so `/model deepseek-flash` — the name
 * printed in DeepSeek's own documentation — works as well as the catalogue id.
 * Null is an answer: callers must refuse an unknown model, never fall back to
 * a different one.
 */
export function findModel(catalogue: ModelEndpoint[], name: string): ModelEndpoint | null {
  const wanted = name.trim().toLowerCase();
  return (
    catalogue.find((m) => m.id.toLowerCase() === wanted) ??
    catalogue.find((m) => m.upstreamModel.toLowerCase() === wanted) ??
    null
  );
}
