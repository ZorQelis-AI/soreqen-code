/**
 * Research: an answer's evidence, gathered the way a careful person would.
 *
 * `web_search` returns ten links and their snippets, and a snippet is a
 * search engine's guess at what a page says. An agent that answers from
 * snippets answers from guesses, and one that reads pages does it one
 * `fetch_url_content` at a time, each a round trip through the model.
 *
 * This does the reading. For a question:
 *
 *   1. **Several searches.** The question asked several ways (the model's own
 *      phrasings, or variants made here), because one phrasing finds one
 *      corner of the web.
 *   2. **Ranked sources.** Results are merged by reciprocal rank fusion (a page
 *      several searches agree on outranks one that topped a single search),
 *      weighted by the kind of source (documentation, papers, standards and
 *      the project's own site over aggregators), at most two per site, and
 *      never pages that cannot be read as text (video, social feeds).
 *   3. **The pages read.** Fetched in parallel; a page that comes back as a
 *      script shell or a bot wall is read again in a real browser
 *      (browser-search.ts). Navigation, footers and banners are dropped.
 *   4. **The passages that answer.** Each page is cut into passages and
 *      scored against the question (BM25), so what reaches the model is the
 *      part of each page that bears on it, with its source numbered for
 *      citation.
 *
 * Nothing here calls a model. The deep mode (several rounds, each guided by
 * what the last one lacked, then a cited report) lives in the orchestrator,
 * which has one, and uses this for each round.
 */

import { searchWeb, type WebSearchHit } from "./web-search.js";
import { browserSearch } from "./browser-search.js";
import { assertPublicHost } from "./web-content-tools.js";

export interface EvidenceSource {
  /** Citation number, [n]. */
  n: number;
  title: string;
  url: string;
  site: string;
  published?: string;
  /** The passages that bear on the question, best first. */
  passages: string[];
  /** How the page was read. */
  via: "fetch" | "browser";
}

export interface Evidence {
  question: string;
  queries: string[];
  /** Which search provider answered each query. */
  providers: string[];
  sources: EvidenceSource[];
  /** Results that were found but could not be read, and why. */
  unread: { url: string; why: string }[];
  /** Searches that failed outright. */
  failedQueries: string[];
}

export interface GatherOptions {
  question: string;
  queries?: string[];
  /** Sources to read and keep. */
  maxSources?: number;
  passagesPerSource?: number;
  /** URLs already read in an earlier round, not read again. */
  exclude?: Iterable<string>;
  /** The number the first new source gets: rounds continue one numbering. */
  firstNumber?: number;
  signal?: AbortSignal;
  onProgress?: (message: string) => void;
  /** For tests: replaces the web. */
  search?: (query: string, max: number) => Promise<{ results: WebSearchHit[]; provider: string } | null>;
  read?: (url: string, signal?: AbortSignal) => Promise<ReadPage | null>;
}

export interface ReadPage {
  title: string;
  text: string;
  published?: string;
  via: "fetch" | "browser";
}

const STOP = new Set(
  "a an and are as at be but by can do does for from has have how i in into is it its of on or that the their them then there these this to was what when where which who why will with you your vs versus about than over under more most best any all not no yes should would could did get got make use using used".split(" "),
);

export function terms(text: string): string[] {
  return (text.toLowerCase().match(/[\p{L}\p{N}][\p{L}\p{N}.+#-]*/gu) ?? [])
    .map((t) => t.replace(/[.-]+$/, ""))
    .filter((t) => t.length > 1 && !STOP.has(t));
}

/** Other ways to ask, when the model gave none: the question, its keywords, and a slant by kind. */
export function expandQueries(question: string, given?: string[]): string[] {
  const out: string[] = [];
  const add = (q: string): void => {
    const t = q.trim().replace(/\s+/g, " ");
    if (t && !out.some((o) => o.toLowerCase() === t.toLowerCase())) out.push(t);
  };
  for (const q of given ?? []) add(q);
  if (out.length >= 2) return out.slice(0, 8);
  add(question);
  const keywords = terms(question).slice(0, 8).join(" ");
  if (keywords.split(" ").length >= 2) add(keywords);
  const q = question.toLowerCase();
  if (/\b(latest|current|new|recent|today|this (week|month|year)|20\d\d)\b/.test(q)) add(`${keywords} ${new Date().getFullYear()}`);
  if (/\b(how (do|to)|api|docs?|documentation|configure|install|setup|error|example)\b/.test(q)) add(`${keywords} documentation`);
  if (/\b(compare|comparison|vs|versus|better|alternatives?|difference)\b/.test(q)) add(`${keywords} comparison review`);
  if (/\b(paper|research|study|benchmark|evidence|state of the art|sota)\b/.test(q)) add(`${keywords} arxiv paper`);
  return out.slice(0, 5);
}

/** Pages that cannot be read as text, or are feeds rather than sources. */
const UNREADABLE = /(^|\.)(youtube\.com|youtu\.be|tiktok\.com|instagram\.com|facebook\.com|x\.com|twitter\.com|pinterest\.[a-z.]+|linkedin\.com|vimeo\.com|spotify\.com)$/i;

/** A prior on what kind of source a site is. Additive to the fused rank. */
export function sourcePrior(url: string, queryTerms: Set<string>): number {
  let host = "";
  let path = "";
  try {
    const u = new URL(url);
    host = u.hostname.toLowerCase().replace(/^www\./, "");
    path = u.pathname.toLowerCase();
  } catch {
    return -1;
  }
  let p = 0;
  if (/^(docs|developer|developers|learn|api|reference|devdocs)\./.test(host) || /\/(docs?|reference|api|guide|manual)(\/|$)/.test(path)) p += 0.012;
  if (/(^|\.)(arxiv\.org|acm\.org|ieee\.org|nature\.com|science\.org|nih\.gov|openreview\.net|semanticscholar\.org|aclanthology\.org)$/.test(host)) p += 0.012;
  if (/\.(gov|edu|ac\.[a-z]{2})$/.test(host) || /(^|\.)(w3\.org|ietf\.org|rfc-editor\.org|whatwg\.org|iso\.org|mozilla\.org|python\.org|rust-lang\.org|nodejs\.org)$/.test(host)) p += 0.01;
  if (/(^|\.)(github\.com|gitlab\.com|stackoverflow\.com|wikipedia\.org)$/.test(host)) p += 0.006;
  // The project's own site: its name is in the question.
  const label = host.split(".").slice(-2, -1)[0] ?? "";
  if (label.length > 2 && queryTerms.has(label)) p += 0.01;
  if (/(^|\.)(medium\.com|quora\.com|reddit\.com|dev\.to|hashnode\.dev)$/.test(host)) p -= 0.002;
  if (/(top-?\d+|best-.*-(tools|apps|software))/.test(path)) p -= 0.004;
  return p;
}

export function normaliseUrl(url: string): string {
  try {
    const u = new URL(url);
    u.hash = "";
    for (const k of [...u.searchParams.keys()]) if (/^(utm_|ref$|ref_|fbclid|gclid|mc_)/i.test(k)) u.searchParams.delete(k);
    u.hostname = u.hostname.replace(/^www\./, "");
    let s = u.toString();
    if (s.endsWith("/")) s = s.slice(0, -1);
    return s;
  } catch {
    return url;
  }
}

/** A PDF on arXiv has an abstract page that reads as text. */
function readableUrl(url: string): string {
  const m = /^https?:\/\/arxiv\.org\/pdf\/([^?#]+?)(\.pdf)?$/i.exec(url);
  return m ? `https://arxiv.org/abs/${m[1]}` : url;
}

const ENTITY: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", "#39": "'", mdash: "-", ndash: "-", hellip: "…", rsquo: "'", lsquo: "'", rdquo: '"', ldquo: '"' };

/** The main text of an HTML page, without a DOM: good enough to rank passages, and a browser read covers the rest. */
export function htmlToText(html: string): { title: string; text: string; published?: string } {
  const title = decode(/<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)/i.exec(html)?.[1] ?? /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1] ?? "").trim();
  const published =
    /<meta[^>]+(?:property=["']article:published_time["']|name=["']date["']|itemprop=["']datePublished["'])[^>]+content=["']([^"']+)/i.exec(html)?.[1] ??
    /"datePublished"\s*:\s*"([^"]+)"/.exec(html)?.[1] ??
    /<time[^>]+datetime=["']([^"']+)/i.exec(html)?.[1];
  let body = html
    .replace(/<(script|style|noscript|svg|iframe|template)\b[\s\S]*?<\/\1>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ");
  const article = [...body.matchAll(/<article\b[\s\S]*?<\/article>/gi)].map((m) => m[0]).sort((a, b) => b.length - a.length)[0];
  const main = /<main\b[\s\S]*?<\/main>/i.exec(body)?.[0];
  body = article && article.length > 2_000 ? article : main ?? body;
  body = body.replace(/<(nav|header|footer|aside|form)\b[\s\S]*?<\/\1>/gi, " ");
  const text = decode(
    body
      .replace(/<(br|hr)\b[^>]*>/gi, "\n")
      .replace(/<\/(p|div|li|h[1-6]|tr|section|blockquote|pre|dd|dt|figcaption)>/gi, "\n")
      .replace(/<li\b[^>]*>/gi, "\n- ")
      // Cells keep a space between them; inline tags (a syntax highlighter's
      // spans, links, emphasis) vanish, or code reads "fastify . get (".
      .replace(/<\/?(td|th|dd|dt|label|option)\b[^>]*>/gi, " ")
      .replace(/<[^>]+>/g, ""),
  )
    .replace(/[ \t\f\v]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return { title, text, ...(published ? { published } : {}) };
}

function decode(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+\d*);/gi, (m, e: string) => {
    if (e[0] === "#") {
      const code = e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : m;
    }
    return ENTITY[e.toLowerCase()] ?? m;
  });
}

/** Looks like a page that did not render without scripts, or a wall in front of one. */
export function needsBrowser(status: number, text: string): boolean {
  if (status === 401 || status === 403 || status === 429 || status === 503) return true;
  if (text.length < 600) return true;
  return /enable javascript|javascript is (disabled|required)|checking your browser|just a moment|captcha|access denied|are you a robot/i.test(text.slice(0, 2_000));
}

const READ_TIMEOUT_MS = 12_000;
const MAX_HTML = 3_000_000;

/** Read a page: a fetch first, a real browser when the fetch gets nothing worth reading. */
export async function readPage(url: string, signal?: AbortSignal): Promise<ReadPage | null> {
  const target = readableUrl(url);
  let fetched: ReadPage | null = null;
  let status = 0;
  try {
    const u = new URL(target);
    if (u.protocol !== "http:" && u.protocol !== "https:") return null;
    await assertPublicHost(u.hostname);
    const res = await fetch(target, {
      redirect: "follow",
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(READ_TIMEOUT_MS)]) : AbortSignal.timeout(READ_TIMEOUT_MS),
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
        Accept: "text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.5",
        "Accept-Language": "en-US,en;q=0.9",
      },
    });
    status = res.status;
    const type = res.headers.get("content-type") ?? "";
    if (/pdf|octet-stream|image\/|video\/|audio\//i.test(type)) return null;
    const raw = (await res.text()).slice(0, MAX_HTML);
    const page = /html|xml/i.test(type) || /<html|<body/i.test(raw.slice(0, 2_000)) ? htmlToText(raw) : { title: "", text: raw };
    fetched = { ...page, via: "fetch" };
  } catch (err) {
    if (signal?.aborted) return null;
    // A private address is refused for good; a browser would be refused too.
    if (err instanceof Error && /blocked|private|loopback|metadata/i.test(err.message)) return null;
  }
  if (fetched && !needsBrowser(status, fetched.text)) return fetched;
  if (process.env["SOREQEN_BROWSER_SEARCH"] === "0") return fetched;
  if (signal?.aborted) return fetched;
  // Bounded inside (`READ_DEADLINE_MS`), and stopped with the turn.
  const rendered = await browserSearch().read(target, signal).catch(() => null);
  if (rendered && rendered.text.length > (fetched?.text.length ?? 0)) return { ...rendered, via: "browser" };
  return fetched;
}

/** Passages of about `size` characters, along paragraph lines. */
export function passagesOf(text: string, size = 700): string[] {
  const paragraphs = text.split(/\n{1,}/).map((p) => p.trim()).filter((p) => p.length > 0);
  const out: string[] = [];
  let cur = "";
  for (const p of paragraphs) {
    if (p.length > size * 1.6) {
      if (cur) out.push(cur);
      cur = "";
      for (const sentence of p.match(/[^.!?]+[.!?]+["')\]]*\s*|[^.!?]+$/g) ?? [p]) {
        if ((cur + sentence).length > size && cur) {
          out.push(cur.trim());
          cur = "";
        }
        cur += sentence;
      }
      continue;
    }
    if ((cur + "\n" + p).length > size && cur) {
      out.push(cur.trim());
      cur = "";
    }
    cur = cur ? `${cur}\n${p}` : p;
  }
  if (cur.trim()) out.push(cur.trim());
  // A line of navigation or a lone heading is not a passage.
  return out.filter((p) => p.length >= 80);
}

/** BM25 over every passage of every page, so a term rare across the sources counts for more. */
export function scorePassages(passages: string[][], query: string[], weights?: Map<string, number>): number[][] {
  const k1 = 1.4;
  const b = 0.75;
  const docs = passages.flat().map((p) => terms(p));
  const n = docs.length || 1;
  const avg = docs.reduce((s, d) => s + d.length, 0) / n || 1;
  const df = new Map<string, number>();
  for (const d of docs) for (const t of new Set(d)) df.set(t, (df.get(t) ?? 0) + 1);
  const unique = [...new Set(query)];
  let i = 0;
  return passages.map((page) =>
    page.map(() => {
      const d = docs[i++]!;
      const tf = new Map<string, number>();
      for (const t of d) tf.set(t, (tf.get(t) ?? 0) + 1);
      let score = 0;
      for (const t of unique) {
        const f = tf.get(t);
        if (!f) continue;
        const idf = Math.log(1 + (n - (df.get(t) ?? 0) + 0.5) / ((df.get(t) ?? 0) + 0.5));
        score += (weights?.get(t) ?? 1) * idf * ((f * (k1 + 1)) / (f + k1 * (1 - b + (b * d.length) / avg)));
      }
      return score;
    }),
  );
}

async function inParallel<T, R>(items: T[], limit: number, work: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) {
        const i = next++;
        out[i] = await work(items[i]!);
      }
    }),
  );
  return out;
}

function siteOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}

/** Search, rank, read and excerpt. One round of research. */
export async function gatherEvidence(options: GatherOptions): Promise<Evidence> {
  const question = options.question.trim();
  const queries = expandQueries(question, options.queries);
  const maxSources = Math.max(1, Math.min(options.maxSources ?? 8, 16));
  const perSource = Math.max(1, Math.min(options.passagesPerSource ?? 3, 5));
  const exclude = new Set([...(options.exclude ?? [])].map(normaliseUrl));
  const search =
    options.search ??
    (async (q: string, max: number) => {
      const outcome = await searchWeb(q, max);
      return outcome.provider === null ? null : { results: outcome.results, provider: outcome.provider };
    });
  const read = options.read ?? readPage;

  // 1. Searches: two at a time, so the engines see a person, not a burst.
  options.onProgress?.(`Searching ${queries.length} ways: ${queries.map((q) => `"${q}"`).join(", ")}`);
  const answers = await inParallel(queries, 2, async (q) => {
    if (options.signal?.aborted) return null;
    return search(q, 10).catch(() => null);
  });

  // 2. Fusion, by kind of source, at most two a site.
  const queryTerms = new Set(terms(`${question} ${queries.join(" ")}`));
  const candidates = new Map<string, { hit: WebSearchHit; score: number }>();
  const providers: string[] = [];
  const failedQueries: string[] = [];
  answers.forEach((answer, qi) => {
    if (!answer) {
      failedQueries.push(queries[qi]!);
      return;
    }
    providers.push(answer.provider);
    answer.results.forEach((hit, rank) => {
      if (!/^https?:/i.test(hit.url) || UNREADABLE.test(siteOf(hit.url))) return;
      const key = normaliseUrl(hit.url);
      if (exclude.has(key)) return;
      const fused = 1 / (60 + rank + 1);
      const had = candidates.get(key);
      candidates.set(key, { hit: had?.hit ?? hit, score: (had?.score ?? sourcePrior(hit.url, queryTerms)) + fused });
    });
  });
  const perSite = new Map<string, number>();
  const ranked = [...candidates.values()]
    .sort((a, b) => b.score - a.score)
    .filter(({ hit }) => {
      const site = siteOf(hit.url);
      const count = perSite.get(site) ?? 0;
      perSite.set(site, count + 1);
      return count < 2;
    })
    // Read more than will be kept: some will not read, some will not bear on the question.
    .slice(0, Math.ceil(maxSources * 1.6));

  // 3. Read them.
  options.onProgress?.(`Reading ${ranked.length} sources`);
  const unread: { url: string; why: string }[] = [];
  const pages = await inParallel(ranked, 6, async ({ hit }) => {
    if (options.signal?.aborted) return null;
    const page = await read(hit.url, options.signal).catch(() => null);
    if (!page || page.text.length < 200) {
      unread.push({ url: hit.url, why: page ? "almost no text" : "could not be read" });
      return null;
    }
    return { hit, page };
  });

  // 4. Passages, scored against the question (its own words count double).
  const readOk = pages.filter((p): p is { hit: WebSearchHit; page: ReadPage } => p !== null);
  const cut = readOk.map(({ page, hit }) => {
    const ps = passagesOf(page.text);
    // The snippet stands in for a page whose text did not split into passages.
    return ps.length > 0 ? ps : hit.snippet ? [hit.snippet] : [];
  });
  const weights = new Map<string, number>();
  for (const t of terms(question)) weights.set(t, 2);
  const scores = scorePassages(cut, [...queryTerms], weights);
  const chosen = readOk
    .map((r, i) => {
      const byScore = cut[i]!.map((p, j) => ({ p, s: scores[i]![j]!, j })).sort((a, b) => b.s - a.s);
      const best = byScore.slice(0, perSource).filter((x) => x.s > 0);
      // In page order, so an argument reads as the page made it.
      const passages = (best.length > 0 ? best : byScore.slice(0, 1)).sort((a, b) => a.j - b.j).map((x) => x.p);
      const relevance = best.reduce((s, x) => s + x.s, 0);
      return { ...r, passages, relevance, order: i };
    })
    // Fused rank first, then what the page actually says about the question.
    .map((r) => ({ ...r, total: r.relevance / 40 + (ranked.length - r.order) / ranked.length }))
    .sort((a, b) => b.total - a.total)
    .slice(0, maxSources);

  let n = options.firstNumber ?? 1;
  const sources: EvidenceSource[] = chosen.map((c) => ({
    n: n++,
    title: (c.page.title || c.hit.title || siteOf(c.hit.url)).slice(0, 200),
    url: c.hit.url,
    site: siteOf(c.hit.url),
    ...(c.page.published ? { published: c.page.published.slice(0, 10) } : {}),
    passages: c.passages.map((p) => (p.length > 1_100 ? `${p.slice(0, 1_100)}…` : p)),
    via: c.page.via,
  }));

  return { question, queries, providers: [...new Set(providers)], sources, unread, failedQueries };
}

/** Evidence as the model reads it: numbered sources, their passages, and what to do with them. */
export function formatEvidence(e: Evidence, opts: { instructions?: boolean } = {}): string {
  const lines: string[] = [];
  lines.push(`Research: ${e.question}`);
  lines.push(`Searched ${e.queries.length} ways (${e.providers.join(", ") || "no engine answered"}): ${e.queries.map((q) => `"${q}"`).join(" | ")}`);
  if (e.failedQueries.length > 0) lines.push(`No search engine answered: ${e.failedQueries.map((q) => `"${q}"`).join(", ")}`);
  lines.push(`Read ${e.sources.length} sources${e.unread.length ? `; ${e.unread.length} more could not be read` : ""}.`);
  for (const s of e.sources) {
    lines.push("");
    lines.push(`[${s.n}] ${s.title} (${s.site}${s.published ? `, ${s.published}` : ""})`);
    lines.push(s.url);
    for (const p of s.passages) lines.push(`> ${p.replace(/\n+/g, "\n> ")}`);
  }
  if (opts.instructions !== false) {
    lines.push("");
    lines.push(
      e.sources.length > 0
        ? "Answer from these sources, citing them inline as [n] for each claim, and list the sources you cited (title and URL) at the end. Where sources disagree or are dated, say so. If they do not answer part of the question, say what is missing rather than filling it in, or research again with narrower queries."
        : "Nothing could be read. Try different, more specific queries, or fetch_url_content on a page you know.",
    );
  }
  return lines.join("\n");
}

/** Sources kept at each depth. */
export const DEPTH_SOURCES = { quick: 5, standard: 8, deep: 10 } as const;

/**
 * The `research` tool without a model: one round, at quick or standard
 * depth (deep, which needs a model to plan and report, is the orchestrator's;
 * here it is a standard round with more sources).
 */
export async function runResearch(
  input: Record<string, unknown>,
  signal?: AbortSignal,
  onProgress?: (message: string) => void,
): Promise<{ success: boolean; data?: unknown; error?: string }> {
  const question = typeof input["question"] === "string" ? input["question"].trim() : "";
  if (question.length < 3) return { success: false, error: "research needs a 'question'." };
  const depth = input["depth"] === "quick" || input["depth"] === "deep" ? input["depth"] : "standard";
  const queries = Array.isArray(input["queries"]) ? input["queries"].filter((q): q is string => typeof q === "string").slice(0, 8) : undefined;
  const max = typeof input["max_sources"] === "number" ? input["max_sources"] : DEPTH_SOURCES[depth];
  const evidence = await gatherEvidence({
    question,
    ...(queries ? { queries } : {}),
    maxSources: max,
    passagesPerSource: depth === "quick" ? 2 : 3,
    ...(signal ? { signal } : {}),
    ...(onProgress ? { onProgress } : {}),
  });
  if (evidence.sources.length === 0) {
    return {
      success: false,
      data: { question, queries: evidence.queries },
      error: formatEvidence(evidence),
    };
  }
  // Text, not JSON: the evidence names each source's URL already, and an escaped string reads worse and costs more.
  return { success: true, data: formatEvidence(evidence) };
}
