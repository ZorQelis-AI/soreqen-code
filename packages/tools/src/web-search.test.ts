import { describe, it, expect, afterAll } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeBrowserSearch, isChallenge, unwrapBingUrl } from "./browser-search.js";

// Closing the shared headless browser can take over 10 s while other suites are busy.
afterAll(() => closeBrowserSearch(), 60_000);
import {
  exactFirst,
  isDuckDuckGoRefusal,
  parseSearxngHtml,
  parseSearxngJson,
  searxngBase,
  searxngCategories,
  searxngUnresponsive,
  parseDuckDuckGoHtml,
  registryFor,
  searchUnavailableMessage,
  searchWeb,
  unwrapDuckDuckGoUrl,
} from "./web-search.js";

describe("DuckDuckGo parsing", () => {
  const page = `
    <div class="result">
      <a rel="nofollow" class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fzod.dev%2F&rut=x">Zod <b>docs</b></a>
      <a class="result__snippet" href="#">TypeScript-first schema&nbsp;validation</a>
    </div>
    <div class="result">
      <a rel="nofollow" class="result__a" href="https://github.com/colinhacks/zod">zod on GitHub</a>
      <a class="result__snippet" href="#">Source &amp; issues</a>
    </div>`;

  it("unwraps the redirect so the model gets a URL it can actually fetch", () => {
    expect(unwrapDuckDuckGoUrl("//duckduckgo.com/l/?uddg=https%3A%2F%2Fzod.dev%2F&rut=x")).toBe("https://zod.dev/");
    // An ordinary href is left alone, bar the protocol-relative prefix.
    expect(unwrapDuckDuckGoUrl("//example.com/x")).toBe("https://example.com/x");
    expect(unwrapDuckDuckGoUrl("https://example.com/x")).toBe("https://example.com/x");
  });

  it("reads titles, urls and snippets, with entities decoded and tags stripped", () => {
    const hits = parseDuckDuckGoHtml(page, 5);
    expect(hits).toHaveLength(2);
    expect(hits[0]).toEqual({
      title: "Zod docs",
      url: "https://zod.dev/",
      snippet: "TypeScript-first schema validation",
    });
    expect(hits[1]?.snippet).toBe("Source & issues");
  });

  it("honours the result cap", () => {
    expect(parseDuckDuckGoHtml(page, 1)).toHaveLength(1);
  });

  it("tells a refusal from an empty result", () => {
    /*
     * The distinction this whole module exists to keep. DuckDuckGo answers a
     * rate-limited caller with 202 and a page about an "anomaly" — parsed
     * naively that is zero results, which teaches the agent the web has
     * nothing on the subject.
     */
    expect(isDuckDuckGoRefusal(202, "<html>fine</html>")).toBe(true);
    expect(isDuckDuckGoRefusal(200, "<p>Our systems detected unusual traffic</p>")).toBe(true);
    expect(isDuckDuckGoRefusal(200, page)).toBe(false);
  });
});

describe("registryFor", () => {
  it("recognises a package question, with its ecosystem named", () => {
    expect(registryFor("what is the latest version of the zod npm package")).toMatchObject({
      registry: "npm",
    });
    expect(registryFor("python requests library version")).toMatchObject({ registry: "pypi" });
    expect(registryFor("rust serde crate version")).toMatchObject({ registry: "crates" });
  });

  it("leaves everything else to a real search engine", () => {
    /*
     * Guessing broadly here would replace a web search with a package listing
     * and make the tool worse: "why does my build fail" is not answered by a
     * registry, however many package-shaped words it contains.
     */
    expect(registryFor("why does my typescript build fail with TS2345")).toBeNull();
    expect(registryFor("how does react reconciliation work")).toBeNull();
  });

  it("claims a question only when what is left is one package name", () => {
    // Each of these once came back as a list of unrelated packages, returned as the answer.
    for (const q of [
      "how to upgrade node version on windows",
      "which node version does vite 7 require",
      "python module not found error fix",
      "typescript library for date formatting",
      "rust version 1.90 release notes",
    ]) {
      expect(registryFor(q)).toBeNull();
    }
    expect(registryFor("express npm latest version")).toEqual({ registry: "npm", term: "express" });
    expect(registryFor("what's the current version of @tanstack/react-query npm package")).toEqual({
      registry: "npm",
      term: "@tanstack/react-query",
    });
  });

  it("answers from a registry only with the package asked about", () => {
    const hit = (name: string) => ({ name, title: name, url: `https://x/${name}`, snippet: "" });
    expect(exactFirst([hit("zod-to-json-schema"), hit("zod")], "zod")?.map((h) => h.title)).toEqual([
      "zod",
      "zod-to-json-schema",
    ]);
    expect(exactFirst([hit("ignore"), hit("bun")], "how to upgrade")).toBeNull();
  });
});

/** The chain without a browser: what a machine that cannot start one gets. */
const NO_BROWSER = { SOREQEN_BROWSER_SEARCH: "0" };

describe("searchWeb", () => {
  it("reports that nobody looked, rather than that nothing exists", async () => {
    const outcome = await searchWeb("how does react reconciliation work", 3, NO_BROWSER);
    if (outcome.provider !== null) {
      // DuckDuckGo or Stack Overflow happened to answer; that is a success, not a failure.
      expect(Array.isArray(outcome.results)).toBe(true);
    }
  }, 40_000);

  it("never asks anybody for a key", async () => {
    const outcome = await searchWeb("anything at all here", 2, { ...NO_BROWSER, BRAVE_SEARCH_API_KEY: "" });
    if (outcome.provider === null) {
      const said = `${outcome.attempted.join(" ")} ${searchUnavailableMessage("anything", outcome.attempted)}`;
      expect(said).not.toMatch(/key|BRAVE_SEARCH_API_KEY|TAVILY/i);
    }
  }, 40_000);

  it("writes a failure message that is actionable in the next tool call", () => {
    const message = searchUnavailableMessage("zod docs", ["bing asked for a captcha recently"]);
    expect(message).toContain("nothing looked");
    expect(message).toContain("fetch_url_content");
    expect(message).not.toMatch(/API key|Settings/);
  });

  /*
   * The real thing, through a browser on this machine. Skipped on a bare CI
   * box, where no browser starts and the chain above is the answer.
   */
  it.skipIf(process.env["CI"])("searches the engines through the person's own browser", async () => {
    const outcome = await searchWeb("vitest skipIf documentation", 5, { SOREQEN_HOME: mkdtempSync(join(tmpdir(), "sq-search-")) });
    expect(outcome.provider).not.toBeNull();
    if (outcome.provider === null) return;
    expect(outcome.results.length).toBeGreaterThan(0);
    for (const hit of outcome.results) {
      expect(hit.url).toMatch(/^https?:\/\//);
      expect(hit.url).not.toMatch(/bing\.com\/ck\//);
      expect(hit.title.length).toBeGreaterThan(0);
    }
  }, 60_000);
});

describe("browser search", () => {
  it("gives the model the page a Bing result links to, not Bing's redirect", () => {
    const href = "https://www.bing.com/ck/a?!&&p=cc8d&ptn=3&ver=2&hsh=4&u=a1aHR0cHM6Ly9naXRodWIuY29tL3RhdXJpLWFwcHMvdGF1cmk&ntb=1";
    expect(unwrapBingUrl(href)).toBe("https://github.com/tauri-apps/tauri");
    expect(unwrapBingUrl("https://react.dev/learn")).toBe("https://react.dev/learn");
  });

  it("tells a captcha from an answer", () => {
    expect(isChallenge("google", "https://www.google.com/sorry/index?continue=x", "", "")).toBe(true);
    expect(isChallenge("brave", "https://search.brave.com/search?q=x", "Captcha - Brave Search", "")).toBe(true);
    expect(isChallenge("bing", "https://www.bing.com/search?q=x", "x - Search", "Our systems have detected unusual traffic")).toBe(true);
    expect(isChallenge("bing", "https://www.bing.com/search?q=x", "x - Search", "About 1,000 results")).toBe(false);
  });
});

describe("SearXNG", () => {
  /*
   * Markup captured from a real SearXNG 2026 instance. The shape that matters
   * is the two anchors: the first is a *display* breadcrumb, and the title is
   * in the <h3> after it. Taking the first one gave every result a URL for a
   * title.
   */
  const PAGE = `
    <article class="result result-default category-general"><div class="result_inner">
      <a href="https://www.typescriptlang.org/play/structural-typing.ts" class="url_header" rel="noreferrer">
        <div class="url_wrapper"><span class="url_o1"><span class="url_i1">https://www.typescriptlang.org</span></span>
        <span class="url_o2"><span class="url_i2"> &rsaquo; play &rsaquo; structural-typing.ts</span></span></div>
      </a>
      <h3><a href="https://www.typescriptlang.org/play/structural-typing.ts" rel="noreferrer">
        Playground Example - <span class="highlight">Structural</span> Typing</a></h3>
      <p class="content">TypeScript is a <span class="highlight">Structural</span> Type System.</p>
    </div></article>
    <article class="result result-default category-general"><div class="result_inner">
      <a href="https://example.com/two" class="url_header"><div class="url_wrapper">example.com</div></a>
      <h3><a href="https://example.com/two">Second result</a></h3>
      <p class="content">Snippet two &amp; more.</p>
    </div></article>`;

  it("reads the title from the heading, not from the breadcrumb anchor", () => {
    const hits = parseSearxngHtml(PAGE, 5);
    expect(hits).toHaveLength(2);
    expect(hits[0]).toEqual({
      title: "Playground Example - Structural Typing",
      url: "https://www.typescriptlang.org/play/structural-typing.ts",
      snippet: "TypeScript is a Structural Type System.",
    });
    expect(hits[1]?.snippet).toBe("Snippet two & more.");
    // A title must never be the URL when a real one is present.
    expect(hits.every((h) => h.title !== h.url)).toBe(true);
  });

  it("honours the result cap", () => {
    expect(parseSearxngHtml(PAGE, 1)).toHaveLength(1);
  });

  it("says which engines refused, instead of reporting an empty web", () => {
    // SearXNG's own shape, captured 25 Sep 2026.
    const body = {
      results: [],
      unresponsive_engines: [["brave", "Suspended: too many requests"], ["duckduckgo", "CAPTCHA"]],
    };
    expect(searxngUnresponsive(body)).toEqual(["brave (too many requests)", "duckduckgo (captcha)"]);
    expect(searxngUnresponsive({ results: [] })).toEqual([]);
    expect(searxngUnresponsive(null)).toEqual([]);
  });

  it("adds the developer engines, except to a query that names a site", () => {
    expect(searxngCategories("vite 7 release notes")).toBe("general,it");
    // They ignore site:, and put unrelated pages on top of the ones asked for.
    expect(searxngCategories('site:github.com/google/fonts "IBM Plex Mono"')).toBe("general");
  });

  it("reads the JSON format when an instance has enabled it", () => {
    const hits = parseSearxngJson(
      { results: [{ title: "T", url: "https://x.dev", content: "c" }, { url: "https://y.dev" }, { nope: 1 }] },
      5,
    );
    expect(hits).toEqual([
      { title: "T", url: "https://x.dev", snippet: "c" },
      // A result with no title falls back to its URL rather than being dropped.
      { title: "https://y.dev", url: "https://y.dev", snippet: "" },
    ]);
  });

  it("survives a response that is not the shape it expects", () => {
    expect(parseSearxngJson(null, 3)).toEqual([]);
    expect(parseSearxngJson({ results: "nope" }, 3)).toEqual([]);
    expect(parseSearxngHtml("<html>nothing here</html>", 3)).toEqual([]);
  });

  it("reads SEARXNG_URL, with or without a scheme, and refuses nonsense", () => {
    expect(searxngBase({ SEARXNG_URL: "http://127.0.0.1:8888" })).toBe("http://127.0.0.1:8888");
    expect(searxngBase({ SEARXNG_URL: "localhost:8888" })).toBe("http://localhost:8888");
    expect(searxngBase({ SEARXNG_URL: "  http://searx.internal/  " })).toBe("http://searx.internal");
    /*
     * Unconfigured means unconfigured. Defaulting to a local port would have
     * every install probing a port on whatever machine it runs on, on every
     * search that got this far.
     */
    expect(searxngBase({})).toBeNull();
    expect(searxngBase({ SEARXNG_URL: "not a url" })).toBeNull();
  });

  it("is not mentioned when nobody configured it", async () => {
    const outcome = await searchWeb("how does react reconciliation work", 3, NO_BROWSER);
    if (outcome.provider === null) expect(outcome.attempted.join(" ")).not.toMatch(/SearXNG|SEARXNG_URL/);
  }, 40_000);
});
