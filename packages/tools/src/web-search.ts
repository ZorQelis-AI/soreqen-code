/**
 * Searching the web, and being honest about it when that is not possible.
 *
 * ## Why this was rewritten
 *
 * `web_search` did Brave, then Tavily, then gave up with:
 *
 *     "No search API key configured. Set BRAVE_SEARCH_API_KEY or …"
 *
 * Both keys are optional, most installs have neither, and so the tool the
 * prompt tells the agent to use for "current documentation, a library's latest
 * API, or a specific error message" failed on every call. An agent that has
 * been refused once stops trying, which is why the symptom people report is
 * not "search errored" but "it never searches".
 *
 * ## What it does now
 *
 * A chain, tried in order, each provider owning its own shape:
 *
 *   1. **Brave**, then **Tavily** — search APIs, only when a deployment has
 *      put a key in its environment. Nobody is ever asked for one.
 *   2. **Package registries** — npm, PyPI and crates.io, for a query that is
 *      plainly about a package: exact where a search engine is approximate.
 *   3. **The search engines, through a real browser** (browser-search.ts) —
 *      Bing, DuckDuckGo, Brave and Google, from the person's own machine, as
 *      they would search. The main road since 29 Sep 2026: SoreQen Code runs
 *      on their computer, so it needs no key, and a browser is answered where
 *      a script is refused.
 *   4. **DuckDuckGo's HTML endpoint** by `fetch`, **Stack Overflow's API**
 *      for a coding question, and **SearXNG** when one is configured — for a
 *      machine where no browser can be started.
 *
 * And when every one of those has failed, the error says what to do right
 * now — `fetch_url_content` on a documentation URL — and that the engines
 * recover within minutes.
 *
 * ## The rule this file exists to keep
 *
 * A provider that cannot answer must never return zero results. Zero results
 * is a fact about the world; a blocked request is a fact about us. Conflating
 * them is the same bug `search.ts` documents for ripgrep, one layer out.
 */

import { ENGINES, browserSearch } from "./browser-search.js";

export interface WebSearchHit {
  title: string;
  url: string;
  snippet: string;
}

export interface WebSearchOutcome {
  results: WebSearchHit[];
  /** Which provider answered. Reported to the model: a registry answer covers
   *  less ground than a web search, and that is worth knowing. */
  provider: string;
  /** Providers that could not be used, and why, for the failure message. */
  attempted: string[];
}

const TIMEOUT_MS = 10_000;

const BROWSER_HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
  Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
  "Accept-Language": "en-US,en;q=0.9",
};

function decodeEntities(text: string): string {
  return text
    .replace(/<[^>]+>/g, "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/&#(\d+);/g, (_, code: string) => String.fromCharCode(Number(code)))
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * DuckDuckGo wraps every result in a redirect: `//duckduckgo.com/l/?uddg=<encoded>`.
 * The real URL is the only part worth giving a model — a redirect URL cannot be
 * read, cited, or fetched by `fetch_url_content` without another hop.
 */
export function unwrapDuckDuckGoUrl(href: string): string {
  const match = /[?&]uddg=([^&]+)/.exec(href);
  if (match?.[1]) {
    try {
      return decodeURIComponent(match[1]);
    } catch {
      /* fall through to the raw href */
    }
  }
  return href.startsWith("//") ? `https:${href}` : href;
}

/** Parse DuckDuckGo's HTML results page. Exported so the shape can be tested
 *  against a saved page rather than against the live, rate-limited service. */
export function parseDuckDuckGoHtml(html: string, max: number): WebSearchHit[] {
  const hits: WebSearchHit[] = [];
  const anchor = /<a[^>]*class="[^"]*result__a[^"]*"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g;
  const snippets = [...html.matchAll(/class="result__snippet"[^>]*>([\s\S]*?)<\/a>/g)].map((m) =>
    decodeEntities(m[1] ?? ""),
  );

  let i = 0;
  for (const match of html.matchAll(anchor)) {
    if (hits.length >= max) break;
    const url = unwrapDuckDuckGoUrl(match[1] ?? "");
    const title = decodeEntities(match[2] ?? "");
    if (!url || !title) {
      i++;
      continue;
    }
    hits.push({ title, url, snippet: snippets[i] ?? "" });
    i++;
  }
  return hits;
}

/**
 * Is this response DuckDuckGo declining rather than answering?
 *
 * It answers a rate-limited caller with `202` and a page that says "anomaly",
 * not with a 4xx — so status alone cannot tell the two apart, and an unchecked
 * parse of that page yields an empty result list that looks exactly like "the
 * web has nothing on this".
 */
export function isDuckDuckGoRefusal(status: number, body: string): boolean {
  if (status === 202) return true;
  return /anomaly|unusual traffic|captcha|challenge-form/i.test(body.slice(0, 4_000));
}

/** A question a developer would take to Stack Overflow: code words, an error, a library. */
export function looksTechnical(query: string): boolean {
  return /\b(error|exception|undefined|null|typeerror|syntaxerror|cannot|failed|how to|example|function|class|method|api|library|npm|pip|cargo|react|vue|svelte|next\.?js|node|typescript|javascript|python|rust|go(lang)?|java|sql|css|html|docker|git|linux|windows|async|await|regex|json|http|webpack|vite)\b/i.test(query) || /c\+\+|c#|[{}();]|\w+\(\)|::|=>/i.test(query);
}

async function stackOverflowSearch(query: string, max: number): Promise<WebSearchHit[] | null> {
  const url =
    `https://api.stackexchange.com/2.3/search/advanced?order=desc&sort=relevance&site=stackoverflow` +
    `&q=${encodeURIComponent(query)}&pagesize=${Math.min(max, 10)}&filter=withbody`;
  const res = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS) });
  if (!res.ok) return null;
  const data = (await res.json()) as { items?: { title: string; link: string; body?: string; is_answered?: boolean; score?: number }[] };
  const hits = (data.items ?? []).slice(0, max).map((item) => ({
    title: decodeEntities(item.title),
    url: item.link,
    snippet: `${item.is_answered ? "Answered" : "Unanswered"} · score ${item.score ?? 0} · ${decodeEntities(item.body ?? "").slice(0, 220)}`,
  }));
  return hits.length > 0 ? hits : null;
}

async function braveSearch(query: string, max: number, key: string): Promise<WebSearchHit[] | null> {
  const url =
    `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}` +
    `&count=${Math.min(max, 10)}&text_decorations=false&search_lang=en`;
  const res = await fetch(url, {
    headers: { Accept: "application/json", "Accept-Encoding": "gzip", "X-Subscription-Token": key },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) return null;
  const data = (await res.json()) as {
    web?: { results?: { title: string; url: string; description?: string }[] };
  };
  const results = (data.web?.results ?? []).slice(0, max).map((r) => ({
    title: r.title,
    url: r.url,
    snippet: r.description ?? "",
  }));
  return results.length > 0 ? results : null;
}

async function tavilySearch(query: string, max: number, key: string): Promise<WebSearchHit[] | null> {
  const res = await fetch("https://api.tavily.com/search", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      api_key: key,
      query,
      max_results: Math.min(max, 10),
      search_depth: "basic",
      include_answer: false,
    }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) return null;
  const data = (await res.json()) as { results?: { title: string; url: string; content?: string }[] };
  const results = (data.results ?? []).slice(0, max).map((r) => ({
    title: r.title,
    url: r.url,
    snippet: r.content ?? "",
  }));
  return results.length > 0 ? results : null;
}

/**
 * When DuckDuckGo may be asked again, after refusing this machine.
 *
 * A refusal is a rate limit, not bad luck: asked again a second later it
 * refuses again. Without this every search paid two refused requests before
 * reaching the provider that answers — measured at up to 2.6 of 3.8 seconds.
 */
let duckDuckGoRestingUntil = 0;
const DUCKDUCKGO_REST_MS = 10 * 60_000;

/** The lite front end's results: `<a … class='result-link'>` rows, snippets in `result-snippet` cells. */
export function parseDuckDuckGoLite(html: string, max: number): WebSearchHit[] {
  const hits: WebSearchHit[] = [];
  const links = [...html.matchAll(/<a[^>]*href=["']([^"']+)["'][^>]*class=["']result-link["'][^>]*>([\s\S]*?)<\/a>/g)];
  const snippets = [...html.matchAll(/class=["']result-snippet["'][^>]*>([\s\S]*?)<\/td>/g)].map((m) => decodeEntities(m[1] ?? ""));
  links.forEach((m, i) => {
    if (hits.length >= max) return;
    const url = unwrapDuckDuckGoUrl(m[1] ?? "");
    const title = decodeEntities(m[2] ?? "");
    if (url.startsWith("http") && title) hits.push({ title, url, snippet: snippets[i] ?? "" });
  });
  return hits;
}

/**
 * DuckDuckGo's front ends, in the order they answer best. A GET to the HTML
 * page answered this machine when the POST was refused (29 Sep 2026); the
 * lite page was always "no results" because its markup, which is not the
 * HTML page's, was never parsed.
 */
async function duckDuckGoSearch(query: string, max: number): Promise<WebSearchHit[] | null> {
  let refused = 0;
  const q = encodeURIComponent(query);
  const attempts: { url: string; init: RequestInit; parse: (html: string, max: number) => WebSearchHit[] }[] = [
    { url: `https://html.duckduckgo.com/html/?q=${q}&kl=us-en`, init: { headers: BROWSER_HEADERS }, parse: parseDuckDuckGoHtml },
    {
      url: "https://html.duckduckgo.com/html/",
      init: {
        method: "POST",
        headers: { ...BROWSER_HEADERS, "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ q: query, kl: "us-en" }).toString(),
      },
      parse: parseDuckDuckGoHtml,
    },
    { url: `https://lite.duckduckgo.com/lite/?q=${q}&kl=us-en`, init: { headers: BROWSER_HEADERS }, parse: parseDuckDuckGoLite },
  ];
  for (const attempt of attempts) {
    try {
      const res = await fetch(attempt.url, { ...attempt.init, signal: AbortSignal.timeout(TIMEOUT_MS) });
      const body = await res.text();
      if (isDuckDuckGoRefusal(res.status, body)) {
        refused++;
        continue;
      }
      const hits = attempt.parse(body, max);
      if (hits.length > 0) return hits;
    } catch {
      // Try the next front end, then fall out of the chain.
    }
  }
  if (refused === attempts.length) duckDuckGoRestingUntil = Date.now() + DUCKDUCKGO_REST_MS;
  return null;
}

/**
 * Which package registry, if any, this query is about.
 *
 * Deliberately narrow. A registry answer is precise and authoritative for
 * "what version is X" and worthless for "why does my build fail", so guessing
 * broadly here would replace a web search with a package listing and make the
 * tool worse. The ecosystem must be named, or the query must plainly be about
 * a package.
 */
export function registryFor(query: string): { registry: "npm" | "pypi" | "crates"; term: string } | null {
  const text = query.trim();
  const lower = text.toLowerCase();

  const strip = (re: RegExp): string => text.replace(re, " ").replace(/\s+/g, " ").trim();
  const FILLER = "the|what'?s|what|is|of|on|in|a|current|newest|now";

  /*
   * What is left must be one package name, or it is not a package question.
   *
   * The ecosystem words alone let every how-to through: "how to upgrade node
   * version on windows" became an npm search for "how to upgrade on windows",
   * and "which node version does vite 7 require" answered with
   * `which-boxed-primitive` — returned as the result, so the web was never
   * searched at all.
   */
  const one = (registry: "npm" | "pypi" | "crates", term: string) =>
    /^(@[a-z0-9][\w.-]*\/)?[a-z0-9][\w.-]*$/i.test(term) && /[a-z]/i.test(term) ? { registry, term } : null;

  if (/\b(npm|node|yarn|pnpm|javascript|typescript)\b/.test(lower) && /\b(package|module|library|version|latest)\b/.test(lower)) {
    return one("npm", strip(new RegExp(`\\b(npm|node|yarn|pnpm|javascript|typescript|package|module|library|version|latest|${FILLER})\\b`, "gi")));
  }
  if (/\b(pypi|pip|python)\b/.test(lower) && /\b(package|module|library|version|latest)\b/.test(lower)) {
    return one("pypi", strip(new RegExp(`\\b(pypi|pip|python|package|module|library|version|latest|${FILLER})\\b`, "gi")));
  }
  if (/\b(crates?\.io|cargo|rust)\b/.test(lower) && /\b(crate|package|library|version|latest)\b/.test(lower)) {
    return one("crates", strip(new RegExp(`\\b(crates?\\.io|cargo|rust|crate|package|library|version|latest|${FILLER})\\b`, "gi")));
  }
  return null;
}

/**
 * The package asked about, first — or nothing, when the registry has no
 * package by that name. A search endpoint matches loosely, and its nearest
 * neighbours are not an answer to "what version is X".
 */
export function exactFirst(hits: (WebSearchHit & { name: string })[], term: string): WebSearchHit[] | null {
  const at = hits.findIndex((h) => h.name.toLowerCase() === term.toLowerCase());
  if (at === -1) return null;
  return [hits[at]!, ...hits.filter((_, i) => i !== at)].map(({ name: _name, ...hit }) => hit);
}

async function registrySearch(
  registry: "npm" | "pypi" | "crates",
  term: string,
  max: number,
): Promise<WebSearchHit[] | null> {
  if (!term) return null;
  const signal = AbortSignal.timeout(TIMEOUT_MS);
  const ua = { "User-Agent": "SoreQen-Code-Agent/2.0 (+https://soreqen.ai)", Accept: "application/json" };

  if (registry === "npm") {
    const res = await fetch(
      `https://registry.npmjs.org/-/v1/search?text=${encodeURIComponent(term)}&size=${Math.min(max, 10)}`,
      { headers: ua, signal },
    );
    if (!res.ok) return null;
    const data = (await res.json()) as {
      objects?: { package: { name: string; version: string; description?: string; date?: string } }[];
    };
    const hits = (data.objects ?? []).slice(0, max).map(({ package: p }) => ({
      name: p.name,
      title: `${p.name}@${p.version}`,
      url: `https://www.npmjs.com/package/${p.name}`,
      snippet: `${p.description ?? ""}${p.date ? ` (published ${p.date.slice(0, 10)})` : ""}`.trim(),
    }));
    return exactFirst(hits, term);
  }

  if (registry === "pypi") {
    // PyPI has no search API; the per-project endpoint is the reliable one — and exact by construction.
    const res = await fetch(`https://pypi.org/pypi/${encodeURIComponent(term)}/json`, {
      headers: ua,
      signal,
    });
    if (!res.ok) return null;
    const data = (await res.json()) as { info?: { name: string; version: string; summary?: string } };
    if (!data.info) return null;
    return [
      {
        title: `${data.info.name} ${data.info.version}`,
        url: `https://pypi.org/project/${data.info.name}/`,
        snippet: data.info.summary ?? "",
      },
    ];
  }

  const res = await fetch(
    `https://crates.io/api/v1/crates?q=${encodeURIComponent(term)}&per_page=${Math.min(max, 10)}`,
    { headers: ua, signal },
  );
  if (!res.ok) return null;
  const data = (await res.json()) as {
    crates?: { name: string; max_stable_version?: string; newest_version?: string; description?: string }[];
  };
  const hits = (data.crates ?? []).slice(0, max).map((c) => ({
    name: c.name,
    title: `${c.name} ${c.max_stable_version ?? c.newest_version ?? ""}`.trim(),
    url: `https://crates.io/crates/${c.name}`,
    snippet: c.description ?? "",
  }));
  return exactFirst(hits, term);
}

/** Every provider declined. Distinct from a provider answering with nothing,
 *  which is a real answer about the world and is returned as one. */
export interface WebSearchUnavailable {
  provider: null;
  attempted: string[];
}

/**
 * Run the chain.
 *
 * `provider: null` means nobody looked; an empty `results` with a provider
 * named means somebody looked and found nothing. The caller must tell those
 * two apart, which is the whole reason the return type distinguishes them.
 */
export async function searchWeb(
  query: string,
  maxResults: number,
  env: Record<string, string | undefined> = process.env,
): Promise<WebSearchOutcome | WebSearchUnavailable> {
  const key = `${query.trim().replace(/\s+/g, " ").toLowerCase()}|${maxResults}`;
  const recent = RECENT.get(key);
  if (recent && Date.now() - recent.at < RECENT_MS) return recent.outcome;
  const outcome = await searchWebNow(query, maxResults, env);
  // Only answers are kept: a failure must be free to succeed on the next try.
  if (outcome.provider !== null) {
    RECENT.set(key, { at: Date.now(), outcome });
    if (RECENT.size > 200) RECENT.delete(RECENT.keys().next().value!);
  }
  return outcome;
}

/**
 * Searches answered in the last ten minutes, by query.
 *
 * An agent repeats itself — the same search in a retry, in a sub-agent, after
 * a compaction. Each repeat was another request to the engines behind
 * SearXNG, and a burst of them is exactly what got every engine to rate-limit
 * this machine on 25 Sep 2026.
 */
const RECENT = new Map<string, { at: number; outcome: WebSearchOutcome }>();
const RECENT_MS = 10 * 60_000;

async function searchWebNow(
  query: string,
  maxResults: number,
  env: Record<string, string | undefined>,
): Promise<WebSearchOutcome | WebSearchUnavailable> {
  const attempted: string[] = [];
  const max = Math.max(1, Math.min(maxResults || 5, 10));

  // A search API, for a deployment that set a key in its environment. Nobody is asked for one.
  const braveKey = env["BRAVE_SEARCH_API_KEY"] || env["BRAVE_API_KEY"];
  if (braveKey) {
    try {
      const hits = await braveSearch(query, max, braveKey);
      if (hits) return { results: hits, provider: "brave", attempted };
      attempted.push("Brave's API returned nothing");
    } catch {
      attempted.push("Brave's API was unreachable");
    }
  }

  const tavilyKey = env["TAVILY_API_KEY"];
  if (tavilyKey) {
    try {
      const hits = await tavilySearch(query, max, tavilyKey);
      if (hits) return { results: hits, provider: "tavily", attempted };
      attempted.push("Tavily returned nothing");
    } catch {
      attempted.push("Tavily was unreachable");
    }
  }

  /*
   * The registry before DuckDuckGo when the query is plainly about a package.
   *
   * It is both faster and more authoritative: "the latest version of zod" is
   * answered exactly by the registry and approximately by a search engine that
   * indexed a blog post last year.
   */
  const registry = registryFor(query);
  if (registry) {
    try {
      const hits = await registrySearch(registry.registry, registry.term, max);
      if (hits) return { results: hits, provider: `${registry.registry} registry`, attempted };
      attempted.push(`${registry.registry} had no match`);
    } catch {
      attempted.push(`${registry.registry} was unreachable`);
    }
  }

  /*
   * The search engines themselves, through a real browser on this machine
   * (browser-search.ts): Bing, DuckDuckGo, Brave, Google, the next one when an
   * engine asks for a captcha. The main road; everything after it is for a
   * machine where no browser can be started.
   */
  let lookedAndFoundNothing: string | null = null;
  if (env["SOREQEN_BROWSER_SEARCH"] !== "0") {
    const browser = browserSearch(env);
    for (const engine of ENGINES) {
      if (browser.unavailable()) {
        attempted.push(`no browser could be started for searching (${browser.unavailable()})`);
        break;
      }
      if (browser.resting(engine)) {
        attempted.push(`${engine} asked for a captcha recently`);
        continue;
      }
      const answer = await browser.search(engine, query, max);
      if (answer.hits && answer.hits.length > 0) return { results: answer.hits, provider: engine, attempted };
      if (answer.hits) lookedAndFoundNothing ??= engine;
      else if (answer.note) attempted.push(answer.note);
      // Two engines that looked and found nothing are an answer; asking all four is not kinder.
      if (answer.hits && lookedAndFoundNothing !== engine) break;
    }
  }

  if (Date.now() < duckDuckGoRestingUntil) {
    attempted.push("DuckDuckGo is rate-limiting this machine (not asked again yet)");
  } else {
    try {
      const hits = await duckDuckGoSearch(query, max);
      if (hits) return { results: hits, provider: "duckduckgo", attempted };
      attempted.push("DuckDuckGo rate-limited this request");
    } catch {
      attempted.push("DuckDuckGo was unreachable");
    }
  }

  /*
   * Stack Overflow's own search API, for a coding question.
   *
   * Keyless (300 requests a day per address), official, and the right answer
   * for an error message or a how-to — which is what most of an agent's
   * searches are. Not a web search: it is only asked for a question that
   * reads as code, and says which provider answered.
   */
  if (looksTechnical(query)) {
    try {
      const hits = await stackOverflowSearch(query, max);
      if (hits) return { results: hits, provider: "stackoverflow", attempted };
      attempted.push("Stack Overflow had no answer");
    } catch {
      attempted.push("Stack Overflow was unreachable");
    }
  }

  /*
   * SearXNG last.
   *
   * By the time the chain reaches here everything else has declined, which is
   * exactly the case a self-hosted meta-search engine exists for — it asks
   * Google, Bing and the rest from an address they will answer, and it has no
   * key and no quota of its own.
   */
  const searxng = searxngBase(env);
  if (searxng) {
    try {
      const { hits, down } = await searxngSearch(searxng, query, max);
      if (hits) return { results: hits, provider: "searxng", attempted };
      /*
       * Nothing, and why. "Returned nothing" read as "no such thing exists"
       * when in fact every engine behind SearXNG was rate-limiting this
       * machine — which passes within minutes, so say so.
       */
      attempted.push(
        down.length > 0
          ? `SearXNG's engines are refusing this machine for now — ${down.join(", ")}; they recover within minutes, so search less often and try again shortly`
          : "SearXNG returned nothing",
      );
    } catch (err) {
      const timedOut = err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError");
      attempted.push(
        timedOut
          ? `SearXNG at ${searxng} did not answer within ${SEARXNG_TIMEOUT_MS / 1000}s`
          : `SearXNG at ${searxng} could not be reached — is its container running?`,
      );
    }
  }

  // Somebody looked and there is nothing: a fact about the world, reported as one.
  if (lookedAndFoundNothing) return { results: [], provider: lookedAndFoundNothing, attempted };
  return { provider: null, attempted };
}

/**
 * Where this deployment's SearXNG is, if it has one.
 *
 * Read from the environment rather than defaulting to `localhost:8080`,
 * because a default would have every install quietly probing a port on the
 * machine it happens to be running on — which is both a wasted round trip on
 * every failed search and a small port scan nobody asked for.
 */
export function searxngBase(env: Record<string, string | undefined>): string | null {
  const raw = (env["SEARXNG_URL"] ?? env["SEARXNG_BASE_URL"] ?? "").trim();
  if (!raw) return null;
  const withScheme = /^https?:\/\//i.test(raw) ? raw : `http://${raw}`;
  try {
    return new URL(withScheme).origin;
  } catch {
    return null;
  }
}

/**
 * Parse a SearXNG JSON response.
 *
 * Exported so the shape can be tested without an instance running, which
 * matters: the JSON format is **disabled by default** in SearXNG's own
 * `settings.yml`, so the most likely failure in the field is a perfectly
 * healthy instance answering with HTML.
 */
export function parseSearxngJson(body: unknown, max: number): WebSearchHit[] {
  if (!body || typeof body !== "object") return [];
  const results = (body as { results?: unknown }).results;
  if (!Array.isArray(results)) return [];

  const hits: WebSearchHit[] = [];
  for (const raw of results) {
    if (hits.length >= max) break;
    if (!raw || typeof raw !== "object") continue;
    const r = raw as { title?: unknown; url?: unknown; content?: unknown };
    if (typeof r.url !== "string" || !r.url) continue;
    hits.push({
      title: typeof r.title === "string" && r.title ? r.title : r.url,
      url: r.url,
      snippet: typeof r.content === "string" ? r.content : "",
    });
  }
  return hits;
}

/**
 * Parse SearXNG's HTML results page.
 *
 * The fallback for an instance that has not enabled the JSON format — which
 * is the default, so this is not an edge case. Its markup is stable and
 * simple: each result is an `<article class="result">` with an `<h3><a>` and a
 * `<p class="content">`.
 */
export function parseSearxngHtml(html: string, max: number): WebSearchHit[] {
  const hits: WebSearchHit[] = [];
  const article = /<article[^>]*class="[^"]*result[^"]*"[\s\S]*?<\/article>/g;

  for (const block of html.match(article) ?? []) {
    if (hits.length >= max) break;

    /*
     * The title lives in the `<h3>`, not in the first anchor.
     *
     * Each result opens with an `<a class="url_header">` holding a *display*
     * breadcrumb — "typescriptlang.org › docs › handbook" — and the real
     * title follows in `<h3><a>`. Taking the first anchor gave every result a
     * URL for a title, which is both useless to read and useless to search.
     */
    const heading = /<h3[^>]*>\s*<a[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/.exec(block);
    const fallback = /<a[^>]+href="([^"]+)"[^>]*>/.exec(block);
    const url = heading?.[1] ?? fallback?.[1] ?? "";
    if (!/^https?:/i.test(url)) continue;

    const snippet = /<p[^>]*class="[^"]*content[^"]*"[^>]*>([\s\S]*?)<\/p>/.exec(block);
    hits.push({
      title: decodeEntities(heading?.[2] ?? "") || url,
      url,
      snippet: decodeEntities(snippet?.[1] ?? ""),
    });
  }
  return hits;
}

/** JSON first, HTML when the instance has not enabled it. */
/**
 * SearXNG waits for its slowest engine, so it gets longer than a single API:
 * with a dozen engines, six seconds is an ordinary answer.
 */
const SEARXNG_TIMEOUT_MS = 20_000;

/**
 * Which SearXNG categories to search.
 *
 * `it` adds Stack Overflow, GitHub, MDN and the package registries — what a
 * coding agent most often wants. They ignore `site:`, though, and a `site:`
 * query given them came back with an unrelated MDN page on top, so a query
 * that names a site gets the web engines only.
 */
export function searxngCategories(query: string): string {
  return /\bsite:/i.test(query) ? "general" : "general,it";
}

/**
 * The engines SearXNG reports as not answering, as "brave (too many
 * requests)". Empty when all answered, or when the body is not SearXNG's JSON.
 */
export function searxngUnresponsive(body: unknown): string[] {
  const list = (body as { unresponsive_engines?: unknown })?.unresponsive_engines;
  if (!Array.isArray(list)) return [];
  return list
    .filter((e): e is [string, string] => Array.isArray(e) && typeof e[0] === "string")
    .map(([name, why]) => (why ? `${name} (${String(why).replace(/^Suspended: /i, "").toLowerCase()})` : name));
}

async function searxngSearch(base: string, query: string, max: number): Promise<{ hits: WebSearchHit[] | null; down: string[] }> {
  const url = `${base}/search?q=${encodeURIComponent(query)}&format=json&safesearch=0&categories=${searxngCategories(query)}`;
  const res = await fetch(url, {
    headers: { Accept: "application/json", "User-Agent": "SoreQen-Code-Agent/2.0" },
    signal: AbortSignal.timeout(SEARXNG_TIMEOUT_MS),
  });

  if (res.ok) {
    const type = res.headers.get("content-type") ?? "";
    if (type.includes("json")) {
      const body = await res.json();
      const hits = parseSearxngJson(body, max);
      // JSON answered: an empty list here is the engines refusing, not a page to re-read as HTML.
      return { hits: hits.length > 0 ? hits : null, down: searxngUnresponsive(body) };
    }
  }

  /*
   * Either the JSON format is off (403, or an HTML body), or it answered with
   * nothing. Asking again for the page a browser would get costs one request
   * and covers the default configuration.
   */
  const page = await fetch(`${base}/search?q=${encodeURIComponent(query)}&categories=${searxngCategories(query)}`, {
    headers: { ...BROWSER_HEADERS },
    signal: AbortSignal.timeout(SEARXNG_TIMEOUT_MS),
  });
  if (!page.ok) return { hits: null, down: [] };
  const hits = parseSearxngHtml(await page.text(), max);
  return { hits: hits.length > 0 ? hits : null, down: [] };
}

/** What the agent is told when nothing could answer. Says what would fix it
 *  and what to do right now, because only one of those is actionable in the
 *  next tool call. */
export function searchUnavailableMessage(query: string, attempted: string[]): string {
  return (
    `No search provider could answer "${query}". Tried: ${attempted.join("; ")}.\n\n` +
    "Do not conclude that nothing exists on this topic — nothing looked. The engines recover " +
    "within minutes, so search less often and try again shortly. Meanwhile use fetch_url_content " +
    "directly on the documentation you need (a library's docs site, a GitHub README at " +
    "raw.githubusercontent.com, an MDN or package-registry page), or open the page with the " +
    "browser tools."
  );
}
