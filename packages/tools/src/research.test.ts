import { describe, expect, it } from "vitest";
import { expandQueries, formatEvidence, gatherEvidence, htmlToText, needsBrowser, normaliseUrl, passagesOf, sourcePrior, type ReadPage } from "./research.js";
import { addressToUrl, playwrightKey } from "./browser-live.js";

const PAGE = (topic: string, extra = ""): string =>
  `<html><head><title>${topic} guide</title><meta property="article:published_time" content="2026-08-01T00:00:00Z"></head><body>
  <nav>Home Docs Blog Pricing Login</nav>
  <article><h1>${topic}</h1>
  <p>${topic} streaming responses are configured with the stream option. When stream is true the server sends events as they are produced, which lowers the time to the first token considerably for long answers.</p>
  <p>${"Unrelated paragraph about the company history, its founders, the office dog and the colour of the logo, which nobody reading about configuration needs. ".repeat(6)}</p>
  <p>${extra}</p></article><footer>Copyright</footer></body></html>`;

describe("htmlToText", () => {
  it("keeps the article and drops the navigation, footer and scripts", () => {
    const page = htmlToText(PAGE("Fastify", "<script>alert(1)</script>Use reply.raw for server-sent events."));
    expect(page.title).toBe("Fastify guide");
    expect(page.published).toBe("2026-08-01T00:00:00Z");
    expect(page.text).toContain("stream option");
    expect(page.text).toContain("reply.raw");
    expect(page.text).not.toMatch(/Pricing Login|Copyright|alert\(1\)/);
  });

  it("decodes entities", () => {
    expect(htmlToText("<p>a &amp; b &#x27;c&#39; &lt;d&gt;</p>").text).toBe("a & b 'c' <d>");
  });
});

describe("passages and scoring", () => {
  it("cuts text into passages along paragraphs and drops crumbs", () => {
    const text = ["short", "x".repeat(300), "y".repeat(300), "z".repeat(300)].join("\n");
    const ps = passagesOf(text, 700);
    expect(ps.length).toBe(2);
    expect(ps.every((p) => p.length >= 80)).toBe(true);
  });

  it("reads a script shell or a bot wall as needing a browser", () => {
    expect(needsBrowser(200, "Please enable JavaScript to continue." + " ".repeat(700))).toBe(true);
    expect(needsBrowser(403, "x".repeat(5000))).toBe(true);
    expect(needsBrowser(200, "real content ".repeat(100))).toBe(false);
  });
});

describe("queries and sources", () => {
  it("keeps the model's queries and adds variants only when it gave fewer than two", () => {
    expect(expandQueries("q", ["a", "b", "a"])).toEqual(["a", "b"]);
    const made = expandQueries("How do I configure streaming in Fastify?");
    expect(made[0]).toBe("How do I configure streaming in Fastify?");
    expect(made.some((q) => /documentation/.test(q))).toBe(true);
  });

  it("prefers documentation and the project's own site to listicles", () => {
    const t = new Set(["fastify", "streaming"]);
    expect(sourcePrior("https://fastify.dev/docs/latest/Reply", t)).toBeGreaterThan(sourcePrior("https://medium.com/@x/top-10-tools", t));
  });

  it("treats tracking parameters, www and a trailing slash as the same page", () => {
    expect(normaliseUrl("https://www.a.com/x/?utm_source=t#h")).toBe(normaliseUrl("https://a.com/x"));
  });
});

describe("gatherEvidence", () => {
  const web: Record<string, { title: string; url: string; snippet: string }[]> = {
    "fastify streaming": [
      { title: "Docs", url: "https://fastify.dev/docs/reply", snippet: "" },
      { title: "Video", url: "https://www.youtube.com/watch?v=1", snippet: "" },
      { title: "Blog", url: "https://blog.example.com/a", snippet: "" },
    ],
    "fastify sse": [
      { title: "Blog", url: "https://blog.example.com/a?utm_source=x", snippet: "" },
      { title: "Empty", url: "https://empty.example.com/", snippet: "" },
    ],
  };
  const search = async (q: string) => ({ results: web[q] ?? [], provider: "test" });
  const read = async (url: string): Promise<ReadPage | null> =>
    url.includes("empty") ? { title: "", text: "", via: "fetch" } : { ...htmlToText(PAGE(url.includes("fastify.dev") ? "Fastify" : "Blog")), via: "fetch" };

  it("fuses, skips video, reads, numbers and excerpts", async () => {
    const e = await gatherEvidence({ question: "How does Fastify stream responses?", queries: ["fastify streaming", "fastify sse"], search, read });
    expect(e.sources.map((s) => s.site)).toEqual(expect.arrayContaining(["fastify.dev", "blog.example.com"]));
    expect(e.sources.some((s) => s.site.includes("youtube"))).toBe(false);
    expect(e.sources.map((s) => s.n)).toEqual([1, 2]);
    expect(e.unread.map((u) => u.url)).toContain("https://empty.example.com/");
    // The passage about streaming, not the one about the office dog.
    expect(e.sources[0]!.passages.join(" ")).toContain("stream option");
    expect(e.sources[0]!.passages.join(" ")).not.toContain("office dog");
    const text = formatEvidence(e);
    expect(text).toMatch(/\[1\] .+\n https?:|\[1\] /);
    expect(text).toContain("cite");
  });

  it("does not read again what an earlier round read, and continues its numbering", async () => {
    const e = await gatherEvidence({
      question: "Fastify streaming",
      queries: ["fastify streaming", "fastify sse"],
      search,
      read,
      exclude: ["https://fastify.dev/docs/reply"],
      firstNumber: 7,
    });
    expect(e.sources.some((s) => s.site === "fastify.dev")).toBe(false);
    expect(e.sources[0]!.n).toBe(7);
  });

  it("says nobody answered rather than returning an empty finding", async () => {
    const e = await gatherEvidence({ question: "anything", queries: ["a", "b"], search: async () => null, read });
    expect(e.failedQueries).toEqual(["a", "b"]);
    expect(formatEvidence(e)).toMatch(/No search engine answered/);
  });
});

describe("the live browser's address bar", () => {
  it("turns what a person types into a URL", () => {
    expect(addressToUrl("localhost:3000/x")).toBe("http://localhost:3000/x");
    expect(addressToUrl("example.com")).toBe("https://example.com");
    expect(addressToUrl("https://a.b/c")).toBe("https://a.b/c");
    expect(addressToUrl("how to center a div")).toMatch(/^https:\/\/duckduckgo\.com\/\?q=how%20to/);
    expect(addressToUrl("javascript:alert(1)")).toBe("about:blank");
  });

  it("names keys as Playwright does", () => {
    expect(playwrightKey("Control+A")).toBe("Control+A");
    expect(playwrightKey(" ")).toBe("Space");
    expect(playwrightKey("Shift+Left")).toBe("Shift+ArrowLeft");
  });
});

describe("htmlToText on highlighted code", () => {
  it("joins a highlighter's spans without spaces", () => {
    const html = "<pre><code><span class=k>fastify</span><span>.</span><span>get</span>(<span>'/events'</span>)</code></pre><table><tr><td>a</td><td>b</td></tr></table>";
    const text = htmlToText(html).text;
    expect(text).toContain("fastify.get('/events')");
    expect(text).toMatch(/a\s+b/);
  });
});
