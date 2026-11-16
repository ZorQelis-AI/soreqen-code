/**
 * Finding the code that matters for the step at hand.
 *
 * ## Several signals, because no single one is reliable
 *
 * Keyword search finds `refreshToken` when you ask about `refreshToken`, and
 * nothing when you ask about "renewing the session". Similarity of meaning
 * finds the second and ranks a comment about sessions above the function that
 * renews them. Neither knows that the file being edited imports the one that
 * broke, or that a test named after it exists. So each candidate is scored on
 * all of them:
 *
 *   lexical     BM25 over identifier-aware terms
 *   semantic    similarity of word roots — a lexical proxy, swappable for a
 *               real embedding model through `Embedder`, never the only signal
 *   symbol      defines, or calls, a symbol the task or error names
 *   dependency  one import away from a file in focus
 *   task        a file the task state or the request names
 *   recency     changed recently in this session
 *   test        a test of a file in focus
 *
 * weighted by what the agent is doing — debugging leans on the error and the
 * recent change, testing on the tests, discovery on the words.
 *
 * ## Then chosen for value, not only for score
 *
 * A candidate's score is divided by what it would cost in tokens, a chunk
 * whose file is already visible unchanged in the conversation is marked a
 * duplicate and pushed down, and selection is MMR: each pick is the best
 * remaining candidate *after* penalising similarity to what is already
 * picked, so five near-identical chunks of one file do not crowd out the one
 * chunk of another that the step actually needs.
 */

import type { Chunk, RepoIndex } from "./repo-index.js";
import type { Phase } from "./task-state.js";
import { mentionedPaths, mentionedSymbols, stem, termCounts, terms } from "./text.js";

export type Signal = "lexical" | "semantic" | "symbol" | "dependency" | "task" | "recency" | "test";

export const SIGNALS: Signal[] = ["lexical", "semantic", "symbol", "dependency", "task", "recency", "test"];

/** How much each signal counts, by phase. Each row sums to 1. */
export const PHASE_WEIGHTS: Record<Phase, Record<Signal, number>> = {
  discovery: { lexical: 0.3, semantic: 0.2, symbol: 0.2, dependency: 0.1, task: 0.1, recency: 0.05, test: 0.05 },
  planning: { lexical: 0.3, semantic: 0.2, symbol: 0.15, dependency: 0.15, task: 0.1, recency: 0.05, test: 0.05 },
  implementation: { lexical: 0.2, semantic: 0.1, symbol: 0.25, dependency: 0.15, task: 0.15, recency: 0.1, test: 0.05 },
  debugging: { lexical: 0.2, semantic: 0.05, symbol: 0.25, dependency: 0.15, task: 0.1, recency: 0.15, test: 0.1 },
  testing: { lexical: 0.15, semantic: 0.05, symbol: 0.15, dependency: 0.15, task: 0.1, recency: 0.15, test: 0.25 },
  review: { lexical: 0.1, semantic: 0.05, symbol: 0.05, dependency: 0.15, task: 0.2, recency: 0.3, test: 0.15 },
};

export interface RetrievalQuery {
  /** The current request, and what the agent is focused on. */
  text: string;
  /** The latest failure's output: its paths and symbols weigh heavily. */
  errorText?: string;
  phase: Phase;
  /** Files read or edited in the last few steps. */
  focusFiles: string[];
  /** Files changed this session, with the step they changed at. */
  modifiedFiles: { path: string; step: number }[];
  /** Files the task state refers to. */
  taskFiles: string[];
  currentStep: number;
  /**
   * Files whose *current* content is already visible in the conversation —
   * read in full and not changed since. A chunk from one is a duplicate.
   */
  inContext: Map<string, string>;
}

/**
 * A similarity of meaning between the query and a chunk, from 0 to 1.
 *
 * The default compares word roots, which needs nothing installed. A real
 * embedding model can be dropped in here; retrieval treats it as one signal
 * among seven either way.
 */
export interface Embedder {
  readonly name?: string;
  /** How a high score reads in a reason: "similar wording", "similar meaning". */
  readonly label?: string;
  similarity(queryStems: Map<string, number>, chunk: Chunk): number;
  /** How much more the semantic signal counts with this embedder than with word roots. */
  readonly weight?: number;
  /** Chunk ids closest to the query, for embedders that can search by vector. */
  nearest?(limit: number): string[];
  /** Network work before a (synchronous) retrieval: embed the query, move the index along. */
  prepare?(text: string, index: RepoIndex): Promise<void>;
}

/** A phase's weights with the semantic signal scaled, still summing to 1. */
export function weightsFor(phase: Phase, semanticScale: number): Record<Signal, number> {
  const base = PHASE_WEIGHTS[phase];
  if (semanticScale === 1) return base;
  const scaled = { ...base, semantic: base.semantic * semanticScale };
  const total = SIGNALS.reduce((s, k) => s + scaled[k], 0);
  return Object.fromEntries(SIGNALS.map((k) => [k, scaled[k] / total])) as Record<Signal, number>;
}

export const stemEmbedder: Embedder = {
  name: "word-roots",
  similarity(query, chunk) {
    let dot = 0;
    let qNorm = 0;
    let cNorm = 0;
    for (const [t, q] of query) {
      qNorm += q * q;
      const c = chunk.stems.get(t);
      if (c) dot += q * c;
    }
    for (const c of chunk.stems.values()) cNorm += c * c;
    return qNorm && cNorm ? dot / Math.sqrt(qNorm * cNorm) : 0;
  },
};

export interface ScoredItem {
  chunk: Chunk;
  /** Weighted relevance, before cost and diversity. */
  relevance: number;
  /** Relevance for its token cost, after importance and duplicate penalties. */
  utility: number;
  signals: Record<Signal, number>;
  reasons: string[];
  duplicate: boolean;
}

export interface RetrievalResult {
  items: ScoredItem[];
  considered: number;
  /** Candidates dropped because their content was already in context. */
  duplicates: number;
  duplicateTokens: number;
}

const K1 = 1.2;
const B = 0.75;
const RECENCY_HALF_LIFE = 10;

export function retrieve(
  index: RepoIndex,
  query: RetrievalQuery,
  options: { limit?: number; lambda?: number; embedder?: Embedder } = {},
): RetrievalResult {
  const limit = options.limit ?? 12;
  const lambda = options.lambda ?? 0.72;
  const embedder = options.embedder ?? stemEmbedder;
  const weights = weightsFor(query.phase, embedder.weight ?? 1);

  // The query, with the error counted twice: it is the most specific thing there is.
  const queryText = `${query.text}\n${query.errorText ?? ""}\n${query.errorText ?? ""}`;
  const qTerms = termCounts(terms(queryText));
  const qStems = termCounts([...qTerms.keys()].map(stem));
  const symbols = new Set(mentionedSymbols(queryText).map((s) => s.toLowerCase()));
  const namedPaths = new Set(
    [...mentionedPaths(queryText), ...query.taskFiles].map((p) => p.replace(/\\/g, "/").replace(/^\.\//, "")),
  );
  const focus = new Set(query.focusFiles);
  const modified = new Map(query.modifiedFiles.map((m) => [m.path, m.step]));

  const neighbourOf = new Map<string, string>();
  const testOf = new Map<string, string>();
  for (const f of new Set([...focus, ...modified.keys()])) {
    const n = index.neighbours(f);
    for (const p of [...n.imports, ...n.importedBy]) if (!neighbourOf.has(p)) neighbourOf.set(p, f);
    for (const t of index.testsFor(f)) if (!testOf.has(t)) testOf.set(t, f);
  }

  /*
   * A failing test points at itself and at what it tests.
   *
   * The error text already weighs in as words. What it did not say is that
   * the test file it names is where the failure is observed, the files that
   * test imports are where it is most likely caused, and the functions in its
   * stack trace are the code that ran. Those become signals of their own.
   */
  const failingTests = new Set<string>();
  const failingSubjects = new Map<string, string>();
  if (query.errorText) {
    const files = [...index.files.keys()];
    for (const raw of mentionedPaths(query.errorText)) {
      const p = raw.replace(/\\/g, "/").replace(/^\.\//, "").replace(/:\d+(:\d+)?$/, "");
      const hit = index.files.has(p) ? p : files.find((f) => p.endsWith(`/${f}`) || f.endsWith(`/${p}`));
      if (hit && index.files.get(hit)?.isTest) failingTests.add(hit);
    }
    for (const t of failingTests) {
      for (const imported of index.files.get(t)?.imports ?? []) if (!failingSubjects.has(imported)) failingSubjects.set(imported, t);
    }
    for (const m of query.errorText.matchAll(/\bat (?:async )?(?:new )?(?:[\w$]+\.)*([\w$]{3,}) \(/g)) {
      if (!/^(Object|Module|process|processTicksAndRejections|runMicrotasks|Promise)$/.test(m[1]!)) symbols.add(m[1]!.toLowerCase());
    }
  }

  // Candidates: anything any signal can see. Scoring every chunk would work;
  // this keeps a large repository's retrieval in milliseconds.
  const candidates = new Set<string>();
  for (const p of [...failingTests, ...failingSubjects.keys()]) for (const c of index.chunksOf(p)) candidates.add(c.id);
  // By meaning, where the embedder can: code that shares no word with the query.
  for (const id of embedder.nearest?.(60) ?? []) candidates.add(id);
  for (const t of qTerms.keys()) for (const id of index.postings.get(t) ?? []) candidates.add(id);
  for (const s of symbols) for (const d of index.symbolDefs.get(s) ?? []) candidates.add(d.chunkId);
  for (const p of [...focus, ...modified.keys(), ...namedPaths, ...neighbourOf.keys(), ...testOf.keys()]) {
    for (const c of index.chunksOf(p)) candidates.add(c.id);
  }

  const N = Math.max(1, index.chunks.size);
  const raw: ScoredItem[] = [];
  let maxBm25 = 0;
  const bm25 = new Map<string, number>();
  for (const id of candidates) {
    const chunk = index.chunks.get(id);
    if (!chunk) continue;
    let score = 0;
    for (const [t, qf] of qTerms) {
      const tf = chunk.terms.get(t);
      if (!tf) continue;
      const df = index.df.get(t) ?? 0;
      const idf = Math.log(1 + (N - df + 0.5) / (df + 0.5));
      score += idf * ((tf * (K1 + 1)) / (tf + K1 * (1 - B + (B * chunk.length) / index.avgLength))) * Math.min(qf, 3);
    }
    bm25.set(id, score);
    if (score > maxBm25) maxBm25 = score;
  }

  for (const id of candidates) {
    const chunk = index.chunks.get(id);
    if (!chunk) continue;
    const file = index.files.get(chunk.path);
    const reasons: string[] = [];
    const signals = {} as Record<Signal, number>;

    signals.lexical = maxBm25 > 0 ? (bm25.get(id) ?? 0) / maxBm25 : 0;
    signals.semantic = embedder.similarity(qStems, chunk);

    let symbol = 0;
    let symbolName = "";
    if (chunk.symbol && symbols.has(chunk.symbol.toLowerCase())) {
      symbol = 1;
      symbolName = chunk.symbol;
    } else if (symbols.size > 0) {
      for (const s of symbols) {
        if (chunk.terms.has(s)) {
          symbol = 0.6;
          symbolName = s;
          break;
        }
      }
    }
    signals.symbol = symbol;

    signals.dependency = focus.has(chunk.path) ? 0.8 : neighbourOf.has(chunk.path) ? 1 : 0;
    signals.task = namedPaths.has(chunk.path) || [...namedPaths].some((p) => chunk.path.endsWith(`/${p}`)) ? 1 : 0;
    const changedAt = modified.get(chunk.path);
    signals.recency = changedAt === undefined ? 0 : Math.pow(0.5, Math.max(0, query.currentStep - changedAt) / RECENCY_HALF_LIFE);
    signals.test = failingTests.has(chunk.path) || failingSubjects.has(chunk.path)
      ? 1
      : testOf.has(chunk.path)
        ? 1
        : file?.isTest && query.phase === "testing"
          ? 0.3
          : 0;
    if (failingTests.has(chunk.path)) reasons.push("in the failing test");
    else if (failingSubjects.has(chunk.path)) reasons.push(`imported by the failing test ${failingSubjects.get(chunk.path)}`);

    let relevance = 0;
    for (const s of SIGNALS) relevance += weights[s] * signals[s];

    if (signals.lexical >= 0.3) reasons.push(`matches the task's terms (${signals.lexical.toFixed(2)})`);
    if (signals.semantic >= 0.25) reasons.push(`${embedder.label ?? "similar wording"} (${signals.semantic.toFixed(2)})`);
    if (symbol === 1) reasons.push(`defines \`${symbolName}\`, which the task names`);
    else if (symbol > 0) reasons.push(`uses \`${symbolName}\``);
    if (focus.has(chunk.path)) reasons.push("in a file being worked on");
    else if (neighbourOf.has(chunk.path)) reasons.push(`one import away from ${neighbourOf.get(chunk.path)}`);
    if (signals.task) reasons.push("named in the request or task state");
    if (changedAt !== undefined) reasons.push(`changed at step ${changedAt}`);
    if (testOf.has(chunk.path)) reasons.push(`tests ${testOf.get(chunk.path)}`);

    // Signals that agree are worth more than one that is loud on its own.
    const agreeing = SIGNALS.filter((s) => signals[s] >= 0.3).length;
    const confidence = Math.min(1, agreeing / 3);
    const importance = 1 + Math.max(-0.3, Math.min(0.3, (file?.importance ?? 0) / 100));
    const duplicate = query.inContext.has(chunk.path);
    const cost = 1 + chunk.tokens / 1_500;
    const utility = (relevance * importance * (0.7 + 0.3 * confidence) * (duplicate ? 0.15 : 1)) / cost;

    if (relevance > 0) raw.push({ chunk, relevance, utility, signals, reasons, duplicate });
  }

  raw.sort((a, b) => b.utility - a.utility);
  const pool = raw.slice(0, 200);
  const selected: ScoredItem[] = [];
  let duplicates = 0;
  let duplicateTokens = 0;
  // Never zero or NaN: every score below is divided by it.
  const maxUtility = pool[0]?.utility && Number.isFinite(pool[0].utility) && pool[0].utility > 0 ? pool[0].utility : 1;

  while (selected.length < limit && pool.length > 0) {
    let best = -1;
    let bestScore = -Infinity;
    for (let i = 0; i < pool.length; i++) {
      const item = pool[i]!;
      let maxSim = 0;
      for (const s of selected) maxSim = Math.max(maxSim, similarity(item.chunk, s.chunk));
      const mmr = lambda * (item.utility / maxUtility) - (1 - lambda) * maxSim;
      if (mmr > bestScore) {
        bestScore = mmr;
        best = i;
      }
    }
    // No score won (every one NaN): stop, rather than splice(-1) the last item in by accident.
    if (best < 0) break;
    const [item] = pool.splice(best, 1);
    if (!item) break;
    if (item.duplicate) {
      duplicates++;
      duplicateTokens += item.chunk.tokens;
      continue;
    }
    selected.push(item);
  }

  return { items: selected, considered: candidates.size, duplicates, duplicateTokens };
}

/** How alike two chunks are: shared terms, and more so in the same file. */
export function similarity(a: Chunk, b: Chunk): number {
  let shared = 0;
  const [small, large] = a.terms.size <= b.terms.size ? [a.terms, b.terms] : [b.terms, a.terms];
  for (const t of small.keys()) if (large.has(t)) shared++;
  const jaccard = shared / Math.max(1, a.terms.size + b.terms.size - shared);
  return Math.min(1, jaccard + (a.path === b.path ? 0.3 : 0));
}
