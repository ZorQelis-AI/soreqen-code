/**
 * A published directory of what every model actually is.
 *
 * ## The problem this solves
 *
 * "When a model is added, first fetch its real context window." The obvious
 * place to ask is the provider: `GET {baseURL}/models`. But the two endpoints
 * this ships against — OpenCode Zen and OpenCode Go — answer that with ids and
 * nothing else: no window, no modalities, no output limit. So the harness fell
 * back to a hand-written prefix table, and a hand-written table is wrong the
 * day a model is renamed. MiMo V2.5 was billed as 128k for exactly that
 * reason, against a real window of a million.
 *
 * models.dev is the catalogue OpenCode itself publishes against, keyed by
 * provider API base URL, and it carries the three facts the harness cannot
 * guess: the context window, the output ceiling, and whether the model can be
 * shown a picture. It is consulted *before* the provider's own listing,
 * because it answers and the listing does not.
 *
 * ## Failure is not an error
 *
 * A deployment that cannot reach models.dev must still start. Every failure
 * here resolves to "nothing learned", and the caller falls through to the
 * provider listing and then to the built-in table exactly as before.
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

const DIRECTORY_URL = "https://models.dev/api.json";

export interface DirectoryModel {
  id: string;
  label: string;
  contextWindow?: number;
  maxOutput?: number;
  vision?: boolean;
  toolCall?: boolean;
}

/** Models a provider serves, by lowercased model id. */
export type DirectoryProvider = Map<string, DirectoryModel>;

/** The whole directory, keyed by the provider's API base URL (no trailing slash). */
export type ModelDirectory = Map<string, DirectoryProvider>;

/*
 * Fetched once per process when it works, and again when it did not.
 *
 * The request in flight is shared, so two callers starting at the same moment
 * (the gateway warming the catalogue and the CLI resolving a `--model` flag)
 * make one request instead of racing. A successful answer is kept for the
 * process. A failed one is not (23 Oct 2026): the failure used to be cached as
 * an empty directory for the life of the process, so one slow start (the
 * directory is about 6 MB, and the timeout was 8 s) left every model to the
 * built-in table, and GLM 5.3 Flash, which reads images, was refused them.
 */
let loaded: ModelDirectory | null = null;
let inFlight: Promise<ModelDirectory> | null = null;
let failures = 0;
let retryAt = 0;
let cacheFile: string | null = null;

/** How long to wait before asking again after a failure, by failure count. */
const RETRY_AFTER_MS = [20_000, 60_000, 5 * 60_000];

/** For tests, and for a process that wants a fresh answer. */
export function resetModelDirectory(): void {
  loaded = null;
  inFlight = null;
  failures = 0;
  retryAt = 0;
  cacheFile = null;
}

/**
 * Where the last good directory is kept on disk, so a start without network
 * (or before the network is up) still knows what each model is. Opt-in: the
 * desktop runtime and the CLI name a file in the SoreQen home; tests and the
 * server name none.
 */
export function setModelDirectoryCache(file: string | null): void {
  cacheFile = file;
}

/** The compact copy on disk: only the facts this harness reads. */
function writeCache(directory: ModelDirectory): void {
  if (!cacheFile) return;
  try {
    const providers: Record<string, Record<string, DirectoryModel>> = {};
    for (const [base, models] of directory) providers[base] = Object.fromEntries(models);
    mkdirSync(dirname(cacheFile), { recursive: true });
    writeFileSync(cacheFile, JSON.stringify({ savedAt: Date.now(), providers }));
  } catch {
    // A cache that cannot be written is a cache that is not there next time.
  }
}

function readCache(): ModelDirectory {
  const directory: ModelDirectory = new Map();
  if (!cacheFile) return directory;
  try {
    const body = JSON.parse(readFileSync(cacheFile, "utf8")) as { providers?: Record<string, Record<string, DirectoryModel>> };
    for (const [base, models] of Object.entries(body.providers ?? {})) {
      directory.set(base, new Map(Object.entries(models)));
    }
  } catch {
    // Missing or unreadable: nothing learned, as before the cache existed.
  }
  return directory;
}

function normaliseBase(url: string): string {
  return url.trim().replace(/\/+$/, "").toLowerCase();
}

/** One models.dev model entry, in the shape this harness uses. */
export function toDirectoryModel(id: string, raw: unknown): DirectoryModel | null {
  if (!raw || typeof raw !== "object") return null;
  const m = raw as {
    name?: unknown;
    limit?: { context?: unknown; output?: unknown };
    modalities?: { input?: unknown };
    tool_call?: unknown;
  };

  const context = typeof m.limit?.context === "number" ? m.limit.context : undefined;
  const output = typeof m.limit?.output === "number" ? m.limit.output : undefined;
  const inputs = Array.isArray(m.modalities?.input) ? (m.modalities.input as unknown[]) : null;

  return {
    id,
    label: typeof m.name === "string" && m.name ? m.name : id,
    ...(context ? { contextWindow: context } : {}),
    ...(output ? { maxOutput: output } : {}),
    // Only stated when the directory actually said — `undefined` means "this
    // source does not know", which is different from "no".
    ...(inputs ? { vision: inputs.includes("image") } : {}),
    ...(typeof m.tool_call === "boolean" ? { toolCall: m.tool_call } : {}),
  };
}

/** Parse a models.dev response. Exported so the shape can be tested offline. */
export function parseModelDirectory(body: unknown): ModelDirectory {
  const directory: ModelDirectory = new Map();
  if (!body || typeof body !== "object") return directory;

  for (const provider of Object.values(body as Record<string, unknown>)) {
    if (!provider || typeof provider !== "object") continue;
    const p = provider as { api?: unknown; models?: unknown };
    if (typeof p.api !== "string" || !p.models || typeof p.models !== "object") continue;

    const models: DirectoryProvider = new Map();
    for (const [id, raw] of Object.entries(p.models as Record<string, unknown>)) {
      const model = toDirectoryModel(id, raw);
      if (model) models.set(id.toLowerCase(), model);
    }
    if (models.size > 0) directory.set(normaliseBase(p.api), models);
  }
  return directory;
}

/** Whether this process has the directory from the network (not only the disk copy). */
export function modelDirectoryIsFresh(): boolean {
  return loaded !== null;
}

/** When the next attempt is allowed after a failure, 0 when it is not waiting on one. */
export function modelDirectoryRetryAt(): number {
  return loaded ? 0 : retryAt;
}

/**
 * The directory: from the network once, else the copy on disk.
 *
 * Never throws and never waits longer than `timeoutMs`: a deployment starting
 * behind a firewall gets the disk copy (or an empty map) and carries on, and
 * the next caller after the back-off asks the network again.
 */
export function loadModelDirectory(
  options: { fetch?: typeof fetch; timeoutMs?: number } = {},
): Promise<ModelDirectory> {
  if (loaded) return Promise.resolve(loaded);
  if (inFlight) return inFlight;
  if (Date.now() < retryAt) return Promise.resolve(readCache());

  const doFetch = options.fetch ?? globalThis.fetch;
  if (typeof doFetch !== "function") return Promise.resolve(readCache());

  const attempt = (async (): Promise<ModelDirectory> => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? 30_000);
    try {
      const res = await doFetch(DIRECTORY_URL, {
        headers: { Accept: "application/json" },
        signal: controller.signal,
      });
      if (!res.ok) throw new Error(`models.dev answered ${res.status}`);
      const directory = parseModelDirectory(await res.json());
      if (directory.size === 0) throw new Error("models.dev answered with no models");
      loaded = directory;
      failures = 0;
      retryAt = 0;
      writeCache(directory);
      return directory;
    } catch {
      failures++;
      retryAt = Date.now() + RETRY_AFTER_MS[Math.min(failures, RETRY_AFTER_MS.length) - 1]!;
      return readCache();
    } finally {
      clearTimeout(timer);
    }
  })();
  inFlight = attempt;
  void attempt.then(() => {
    if (inFlight === attempt) inFlight = null;
  });
  return attempt;
}

/**
 * What the directory knows about one model at one endpoint.
 *
 * Matched on the provider's base URL first, so the same model id served by two
 * plans — `mimo-v2.6-flash` on Go, `mimo-v2.6-flash-free` on Zen — cannot be
 * confused for each other. Falls back to any provider that serves the id,
 * because a base URL with a path prefix a deployment added is still the same
 * model.
 */
export function lookupDirectoryModel(
  directory: ModelDirectory,
  baseURL: string,
  modelId: string,
): DirectoryModel | null {
  const wanted = modelId.trim().toLowerCase();
  if (!wanted) return null;

  const exact = directory.get(normaliseBase(baseURL))?.get(wanted);
  if (exact) return exact;

  const serving: { base: string; model: DirectoryModel }[] = [];
  for (const [base, models] of directory) {
    const found = models.get(wanted);
    if (found) serving.push({ base, model: found });
  }
  if (serving.length === 0) return null;

  /*
   * The same host, when the address moved under it.
   *
   * By late Oct 2026 models.dev listed OpenCode Go at /inference/go/openai/v1
   * while SoreQen calls /zen/go/v1, so nothing matched exactly and the first
   * provider anywhere that served the id answered. Its order is the
   * directory's, and the answer was whichever reseller came first: one lists
   * DeepSeek V4.1 Flash as text-only, and its pictures would not have been sent.
   */
  const host = hostOf(baseURL);
  const sameHost = serving.filter((s) => hostOf(s.base) === host);
  if (sameHost.length > 0) {
    const segments = new Set(normaliseBase(baseURL).split("/"));
    const shared = (base: string) => base.split("/").filter((part) => segments.has(part)).length;
    return sameHost.reduce((best, s) => (shared(s.base) > shared(best.base) ? s : best)).model;
  }

  // Elsewhere, what most providers say, so one listing cannot decide alone whether a model sees.
  const sees = serving.filter((s) => s.model.vision === true).length;
  const blind = serving.filter((s) => s.model.vision === false).length;
  const vision = sees >= blind;
  return (serving.find((s) => s.model.vision === vision) ?? serving[0]!).model;
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return "";
  }
}
