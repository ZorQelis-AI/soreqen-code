/**
 * Meaning, from a real embedding model — optional, and local by default.
 *
 * The built-in semantic signal compares word roots: it finds `verifySession`
 * for "verify the session" but not for "where do we check that a user is
 * logged in". An embedding model finds both. It is one signal of seven, and
 * configured, not required:
 *
 *   SOREQEN_EMBEDDINGS_URL    an OpenAI-compatible base URL — Ollama's
 *                             http://localhost:11434/v1, LM Studio, or a hosted one
 *   SOREQEN_EMBEDDINGS_MODEL  e.g. embeddinggemma:300m, nomic-embed-text
 *   SOREQEN_EMBEDDINGS_KEY    only for a hosted endpoint
 *
 * ## Never in the way
 *
 * Retrieval is synchronous and must stay fast, so all network work happens in
 * `prepare`, before a step's retrieval: the query is embedded, and the code is
 * embedded progressively in the background, cached by content hash so a file
 * is embedded again only when it changes. A chunk without a vector yet falls
 * back to the word-root similarity; an endpoint that fails is backed off from.
 * The worst case is exactly the behaviour without this.
 */

import type { Chunk, RepoIndex } from "./repo-index.js";
import { stemEmbedder, type Embedder } from "./retrieval.js";

export interface VectorEmbedderOptions {
  url: string;
  model: string;
  apiKey?: string;
}

/** Vectors by `model:chunk hash`, shared by every session in the process. Unit length. */
const VECTORS = new Map<string, Float32Array>();
const MAX_VECTORS = 20_000;
const BATCH = 32;
/** How long a step waits for background embedding before retrieving with what it has. */
const FILL_WAIT_MS = 1_200;
const QUERY_TIMEOUT_MS = 8_000;
const BACKOFF_MS = 60_000;

export function embedderFromEnv(env: NodeJS.ProcessEnv = process.env): VectorEmbedder | null {
  const url = env["SOREQEN_EMBEDDINGS_URL"]?.trim();
  const model = env["SOREQEN_EMBEDDINGS_MODEL"]?.trim();
  if (!url || !model) return null;
  const apiKey = env["SOREQEN_EMBEDDINGS_KEY"]?.trim();
  return new VectorEmbedder({ url, model, ...(apiKey ? { apiKey } : {}) });
}

function unit(values: number[]): Float32Array {
  const v = Float32Array.from(values);
  let norm = 0;
  for (const x of v) norm += x * x;
  norm = Math.sqrt(norm) || 1;
  for (let i = 0; i < v.length; i++) v[i]! /= norm;
  return v;
}

function dot(a: Float32Array, b: Float32Array): number {
  let s = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) s += a[i]! * b[i]!;
  return s;
}

/**
 * Cosine similarity as a 0–1 signal, relative to this query.
 *
 * A fixed scale does not work: each model has its own range (embeddinggemma
 * puts unrelated code near 0.2 and its best match near 0.45; another model
 * sits higher throughout), and squashing a real match into a small number let
 * word matches outvote it. So the query's own best match is 1 and its typical
 * chunk is 0 — measured on real code, 24 Sep 2026.
 */
export function cosineSignal(cos: number, median: number, top: number): number {
  if (top <= median) return 0;
  return Math.max(0, Math.min(1, (cos - median) / (top - median)));
}

/**
 * How a model wants queries and documents phrased.
 *
 * Retrieval models are trained with prompts, and leaving them out costs a
 * lot: embeddinggemma ranked the right code #1, #1, #4, #1 with its prompts
 * and #9, #3, #7, #1 without, on the same four questions.
 */
export function promptsFor(model: string): { query: (q: string) => string; doc: (title: string, text: string) => string } {
  const m = model.toLowerCase();
  if (m.includes("embeddinggemma")) {
    return { query: (q) => `task: code retrieval | query: ${q}`, doc: (t, x) => `title: ${t} | text: ${x}` };
  }
  if (m.includes("nomic-embed")) return { query: (q) => `search_query: ${q}`, doc: (_t, x) => `search_document: ${x}` };
  if (/(^|[^a-z])e5([^a-z]|$)/.test(m)) return { query: (q) => `query: ${q}`, doc: (_t, x) => `passage: ${x}` };
  if (m.includes("bge")) return { query: (q) => `Represent this sentence for searching relevant passages: ${q}`, doc: (_t, x) => x };
  return { query: (q) => q, doc: (_t, x) => x };
}

export class VectorEmbedder implements Embedder {
  readonly name = "vectors";
  readonly label = "similar meaning";
  /** A real model's sense of meaning counts for more than word roots do; see `retrieve`. */
  readonly weight = 2.5;
  private readonly prompts: ReturnType<typeof promptsFor>;
  private query: Float32Array | null = null;
  private queryText = "";
  /** This query's median and best cosine over the index: the scale `similarity` uses. */
  private median = 0;
  private top = 0;
  private backoffUntil = 0;
  private filling: Promise<void> | null = null;
  /** Vector keys of the chunks in the index last prepared against, to their chunk ids. */
  private ids = new Map<string, string>();

  constructor(private readonly options: VectorEmbedderOptions) {
    this.prompts = promptsFor(options.model);
  }

  private keyOf(chunk: Chunk): string {
    return `${this.options.model}:${chunk.hash}`;
  }

  private async embed(texts: string[], timeoutMs: number): Promise<Float32Array[] | null> {
    if (Date.now() < this.backoffUntil) return null;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(`${this.options.url.replace(/\/+$/, "")}/embeddings`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(this.options.apiKey ? { Authorization: `Bearer ${this.options.apiKey}` } : {}),
        },
        body: JSON.stringify({ model: this.options.model, input: texts }),
        signal: controller.signal,
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = (await res.json()) as { data?: { index?: number; embedding?: number[] }[] };
      const data = [...(json.data ?? [])].sort((a, b) => (a.index ?? 0) - (b.index ?? 0));
      if (data.length !== texts.length || data.some((d) => !Array.isArray(d.embedding))) throw new Error("malformed");
      return data.map((d) => unit(d.embedding!));
    } catch {
      this.backoffUntil = Date.now() + BACKOFF_MS;
      return null;
    } finally {
      clearTimeout(timer);
    }
  }

  /** Embed the query, and move the code's embedding along. */
  async prepare(text: string, index: RepoIndex): Promise<void> {
    const q = text.trim().slice(0, 4_000);
    if (q && q !== this.queryText) {
      const vectors = await this.embed([this.prompts.query(q)], QUERY_TIMEOUT_MS);
      this.query = vectors?.[0] ?? null;
      this.queryText = vectors ? q : "";
    }
    this.ids = new Map([...index.chunks.values()].map((c) => [this.keyOf(c), c.id]));
    if (!this.filling) {
      this.filling = this.fill(index).finally(() => {
        this.filling = null;
      });
    }
    await Promise.race([this.filling, new Promise((r) => setTimeout(r, FILL_WAIT_MS).unref?.())]);
    this.measure();
  }

  /** The query's scale: its median and best cosine over what is embedded. */
  private measure(): void {
    this.median = this.top = 0;
    if (!this.query) return;
    const scores: number[] = [];
    for (const key of this.ids.keys()) {
      const v = VECTORS.get(key);
      if (v) scores.push(dot(this.query, v));
    }
    if (scores.length < 5) return;
    scores.sort((a, b) => a - b);
    this.median = scores[Math.floor(scores.length / 2)]!;
    this.top = scores[scores.length - 1]!;
  }

  private async fill(index: RepoIndex): Promise<void> {
    const missing = [...index.chunks.values()].filter((c) => !VECTORS.has(this.keyOf(c)));
    for (let i = 0; i < missing.length; i += BATCH) {
      const batch = missing.slice(i, i + BATCH);
      const vectors = await this.embed(
        batch.map((c) => this.prompts.doc(c.symbol ?? c.path, `${c.path}\n${c.text.slice(0, 2_000)}`)),
        30_000,
      );
      if (!vectors) return;
      batch.forEach((c, j) => VECTORS.set(this.keyOf(c), vectors[j]!));
      if (VECTORS.size > MAX_VECTORS) {
        // Oldest first: a Map iterates in insertion order.
        for (const key of [...VECTORS.keys()].slice(0, VECTORS.size - MAX_VECTORS)) VECTORS.delete(key);
      }
    }
  }

  similarity(queryStems: Map<string, number>, chunk: Chunk): number {
    const v = this.query && this.top > this.median ? VECTORS.get(this.keyOf(chunk)) : undefined;
    return v ? cosineSignal(dot(this.query!, v), this.median, this.top) : stemEmbedder.similarity(queryStems, chunk);
  }

  /** The chunks closest in meaning to the query — candidates no word could have found. */
  nearest(limit: number): string[] {
    if (!this.query) return [];
    const scored: { id: string; s: number }[] = [];
    for (const [key, id] of this.ids) {
      const v = VECTORS.get(key);
      if (v) scored.push({ id, s: dot(this.query, v) });
    }
    return scored
      .sort((a, b) => b.s - a.s)
      .slice(0, limit)
      .map((x) => x.id);
  }

  /** How much of the index has a vector: for the debug view. */
  coverage(): { embedded: number; total: number } {
    let embedded = 0;
    for (const key of this.ids.keys()) if (VECTORS.has(key)) embedded++;
    return { embedded, total: this.ids.size };
  }
}
