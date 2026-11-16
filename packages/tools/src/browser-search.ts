/**
 * Web search through a real browser on the person's own machine.
 *
 * ## Why a browser
 *
 * SoreQen Code runs on the person's computer, from their own connection, so
 * it can search the way they do — without a key. What it cannot do is search
 * with Node's `fetch`: on 29 Sep 2026, from a home connection, DuckDuckGo
 * answered `fetch` with its 202 "anomaly" page, Brave with 429 and Yahoo with
 * 500, while the same queries through the system's Edge came back in one to
 * two seconds with the results a person would see. The engines tell a script
 * from a browser by how it connects and behaves, not by its address.
 *
 * ## Staying welcome
 *
 * A real browser is still refused when it searches like a robot: after a few
 * quick queries Google showed its "sorry" page and Brave a captcha, and only
 * Bing kept answering. So:
 *
 *   - the queries are spread over four engines, most tolerant first;
 *   - an engine that shows a challenge rests for a quarter of an hour, and the
 *     next one answers meanwhile;
 *   - one engine is asked at most once every two seconds;
 *   - the profile persists (~/.soreqen/browser/search), so cookies build up
 *     as they do for a returning visitor;
 *   - repeats are answered from the ten-minute cache in `web-search.ts`.
 *
 * ## Staying light
 *
 * One browser for every session, launched on the first search and closed after
 * ninety seconds without one; images, media and fonts are never downloaded; at
 * most three searches run at once and the rest wait their turn.
 */

import { homedir } from "node:os";
import { join } from "node:path";
import type { BrowserContext, Page } from "playwright";
import type { WebSearchHit } from "./web-search.js";

export type SearchEngine = "bing" | "duckduckgo" | "brave" | "google";
export const ENGINES: SearchEngine[] = ["bing", "duckduckgo", "brave", "google"];

const IDLE_CLOSE_MS = 90_000;
/** The longest closing the browser may take before it is left to exit with the process. */
const CLOSE_WAIT_MS = 10_000;
const REST_MS = 15 * 60_000;
const SPACING_MS = 2_000;
const MAX_PAGES = 3;
const NAV_TIMEOUT_MS = 15_000;
const RESULTS_TIMEOUT_MS = 6_000;
/**
 * The most one read or one search may take, every step of it included.
 *
 * Playwright's timeouts cover navigation and waiting for a selector, not
 * `page.evaluate`, not opening a page, not closing one. A page whose scripts
 * kept its tab busy held a read for ever, and with it one of the `MAX_PAGES`
 * slots; three of those and every later read and search, in every session,
 * waited in the queue behind them (reported 29 Oct 2026: deep research stuck
 * after "13 sources" for hours). These bound the whole of it.
 */
const READ_DEADLINE_MS = 30_000;
const SEARCH_DEADLINE_MS = 40_000;
/** Reads or searches in a row that ran out of time before the browser is started afresh. */
const RESTART_AFTER_TIMEOUTS = 2;

class DeadlineError extends Error {}

/** `work`, unless it takes longer than `ms` or `signal` stops it first. */
function bounded<T>(work: Promise<T>, ms: number, signal?: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => finish(() => reject(new DeadlineError(`no answer within ${ms / 1000}s`))), ms);
    const stop = (): void => finish(() => reject(new Error("stopped")));
    let done = false;
    const finish = (settle: () => void): void => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", stop);
      settle();
    };
    if (signal?.aborted) return stop();
    signal?.addEventListener("abort", stop, { once: true });
    work.then(
      (value) => finish(() => resolve(value)),
      (err: unknown) => finish(() => reject(err)),
    );
  });
}

export interface EngineAnswer {
  engine: SearchEngine;
  /** null: the engine refused (a challenge page) or could not be reached. */
  hits: WebSearchHit[] | null;
  note?: string;
}

const URLS: Record<SearchEngine, (q: string) => string> = {
  bing: (q) => `https://www.bing.com/search?q=${encodeURIComponent(q)}&setlang=en`,
  duckduckgo: (q) => `https://duckduckgo.com/?q=${encodeURIComponent(q)}&ia=web`,
  brave: (q) => `https://search.brave.com/search?q=${encodeURIComponent(q)}&source=web`,
  google: (q) => `https://www.google.com/search?q=${encodeURIComponent(q)}&hl=en`,
};

/** The element each engine's results arrive in: what to wait for. */
const RESULT_SELECTOR: Record<SearchEngine, string> = {
  bing: "li.b_algo h2 a",
  duckduckgo: "a[data-testid=result-title-a]",
  brave: "#results a[href^='http']",
  google: "a:has(h3)",
};

/**
 * A Bing result links through `bing.com/ck/a?…&u=a1<base64url>`. The model
 * needs the page itself, to fetch it: the part after `a1` is its address.
 */
export function unwrapBingUrl(href: string): string {
  try {
    const url = new URL(href);
    if (!/(^|\.)bing\.com$/.test(url.hostname)) return href;
    const u = url.searchParams.get("u");
    if (!u || !u.startsWith("a1")) return href;
    const decoded = Buffer.from(u.slice(2).replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8");
    return /^https?:\/\//.test(decoded) ? decoded : href;
  } catch {
    return href;
  }
}

/** Whether a page is an engine refusing us rather than answering. */
export function isChallenge(engine: SearchEngine, url: string, title: string, text: string): boolean {
  if (engine === "google" && /\/sorry\//.test(url)) return true;
  if (/captcha/i.test(title)) return true;
  return /unusual traffic|are you a robot|verify (that )?you are (a )?human|anomaly|bots use duckduckgo too|confirm this search was made by a human/i.test(
    text.slice(0, 4000),
  );
}

/** Runs in the page: the results, as the engine shows them. */
function extract(engine: SearchEngine): { title: string; url: string; snippet: string }[] {
  const clean = (s: string | null | undefined): string => (s ?? "").replace(/\s+/g, " ").trim();
  // The longest text in a result that is not its title: the snippet, whatever the engine calls it.
  const longest = (box: Element | null, title: string): string => {
    if (!box) return "";
    let best = "";
    for (const el of Array.from(box.querySelectorAll("p, span, div"))) {
      if (el.querySelector("p, div")) continue;
      const t = clean(el.textContent);
      if (t.length > best.length && t !== title && !t.startsWith("http")) best = t;
    }
    return best;
  };
  const out: { title: string; url: string; snippet: string }[] = [];
  const add = (title: string, url: string, snippet: string): void => {
    if (!title || !/^https?:\/\//.test(url) || out.some((r) => r.url === url)) return;
    out.push({ title, url, snippet: snippet.slice(0, 400) });
  };

  if (engine === "bing") {
    for (const li of Array.from(document.querySelectorAll("li.b_algo"))) {
      const a = li.querySelector("h2 a") as HTMLAnchorElement | null;
      if (!a) continue;
      const title = clean(a.textContent);
      add(title, a.href, clean(li.querySelector(".b_caption p, p")?.textContent) || longest(li, title));
    }
  } else if (engine === "duckduckgo") {
    for (const a of Array.from(document.querySelectorAll("a[data-testid=result-title-a]")) as HTMLAnchorElement[]) {
      const box = a.closest("article") ?? a.parentElement?.parentElement?.parentElement ?? null;
      const title = clean(a.textContent);
      add(title, a.href, clean(box?.querySelector("[data-result=snippet]")?.textContent) || longest(box, title));
    }
  } else if (engine === "brave") {
    for (const box of Array.from(document.querySelectorAll("#results [data-type=web], #results .snippet"))) {
      const a = box.querySelector("a[href^='http']") as HTMLAnchorElement | null;
      if (!a || /brave\.com/.test(new URL(a.href).hostname)) continue;
      const title = clean(box.querySelector(".title, .snippet-title, [class*=title]")?.textContent) || clean(a.textContent);
      add(title, a.href, clean(box.querySelector(".snippet-description, .content, [class*=description]")?.textContent) || longest(box, title));
    }
  } else {
    for (const a of Array.from(document.querySelectorAll("a:has(h3)")) as HTMLAnchorElement[]) {
      const title = clean(a.querySelector("h3")?.textContent);
      const box = a.closest("[data-hveid], .g") ?? a.parentElement?.parentElement ?? null;
      add(title, a.href, longest(box, title));
    }
  }
  return out;
}

/**
 * Runs inside a page being read: the main content's text, without the
 * navigation, headers, footers, cookie banners and ads around it. A string,
 * so it closes over nothing here. The page is a throwaway, so the clutter is
 * removed from the live DOM, which keeps `innerText`'s line breaks.
 */
const READ_PAGE = `(() => {
  const meta = (sel) => document.querySelector(sel)?.getAttribute("content") || "";
  let published = meta('meta[property="article:published_time"]') || meta('meta[name="date"]') || meta('meta[itemprop="datePublished"]') || document.querySelector("time[datetime]")?.getAttribute("datetime") || "";
  if (!published) {
    for (const s of document.querySelectorAll('script[type="application/ld+json"]')) {
      const m = /"date(?:Published|Modified)"\\s*:\\s*"([^"]+)"/.exec(s.textContent || "");
      if (m) { published = m[1]; break; }
    }
  }
  const junk = "script,style,noscript,svg,iframe,nav,header,footer,aside,form,dialog,[role=navigation],[role=banner],[role=contentinfo],[role=complementary],[aria-hidden=true],[class*=cookie],[id*=cookie],[class*=consent],[class*=advert],[class*=sidebar],[class*=related],[class*=newsletter],[class*=share]";
  const articles = [...document.querySelectorAll("article")].sort((a, b) => (b.innerText || "").length - (a.innerText || "").length);
  const root = (articles[0] && (articles[0].innerText || "").length > 400 ? articles[0] : null) || document.querySelector("main,[role=main]") || document.body;
  root.querySelectorAll(junk).forEach((e) => e.remove());
  const text = (root.innerText || "").replace(/\\n{3,}/g, "\\n\\n").trim();
  return { title: meta('meta[property="og:title"]') || document.title || "", text: text.slice(0, 120000), published: published || undefined };
})()`;

/** Exported for tests; everything else uses the one `browserSearch()` returns. */
export class BrowserSearch {
  private context: Promise<BrowserContext> | null = null;
  private idle: ReturnType<typeof setTimeout> | null = null;
  private active = 0;
  private queue: (() => void)[] = [];
  private restingUntil = new Map<SearchEngine, number>();
  private lastAsked = new Map<SearchEngine, number>();
  private launchFailure: { at: number; reason: string } | null = null;

  constructor(private readonly profileDir: string) {}

  resting(engine: SearchEngine): boolean {
    return (this.restingUntil.get(engine) ?? 0) > Date.now();
  }

  /** Why no browser could be started, if none could, recently. */
  unavailable(): string | null {
    if (this.launchFailure && Date.now() - this.launchFailure.at < 5 * 60_000) return this.launchFailure.reason;
    return null;
  }

  /**
   * Read a page as a person's browser shows it: its title, main text and
   * date. For the research engine, when a plain fetch gets a script shell or
   * a bot wall. The same browser and spacing as searching; images, media and
   * fonts are not downloaded.
   */
  async read(url: string, signal?: AbortSignal): Promise<{ title: string; text: string; published?: string } | null> {
    if (!(await this.slot(signal, READ_DEADLINE_MS))) return null;
    const held: { page?: Page } = {};
    try {
      const read = (async () => {
        const context = await this.open();
        held.page = await context.newPage();
        await held.page.goto(url, { waitUntil: "domcontentloaded", timeout: NAV_TIMEOUT_MS });
        await held.page.waitForLoadState("networkidle", { timeout: 4_000 }).catch(() => undefined);
        return (await held.page.evaluate(READ_PAGE)) as { title: string; text: string; published?: string };
      })();
      read.catch(() => undefined);
      const page = await bounded(read, READ_DEADLINE_MS, signal);
      this.timeouts = 0;
      return page;
    } catch (err) {
      this.timedOut(err);
      return null;
    } finally {
      this.done(held.page);
    }
  }

  async search(engine: SearchEngine, query: string, max: number, signal?: AbortSignal): Promise<EngineAnswer> {
    if (!(await this.slot(signal, SEARCH_DEADLINE_MS))) return { engine, hits: null, note: `${engine} was not asked (stopped, or no browser free in time)` };
    const held: { page?: Page } = {};
    try {
      const search = (async (): Promise<EngineAnswer> => {
        // Each search takes its moment before waiting for it, so three at once go two seconds apart, not together.
        const at = Math.max(Date.now(), (this.lastAsked.get(engine) ?? 0) + SPACING_MS);
        this.lastAsked.set(engine, at);
        if (at > Date.now()) await new Promise((r) => setTimeout(r, at - Date.now()));

        const context = await this.open();
        const page = (held.page = await context.newPage());
        await page.goto(URLS[engine](query), { waitUntil: "domcontentloaded", timeout: NAV_TIMEOUT_MS });
        await page.waitForSelector(RESULT_SELECTOR[engine], { timeout: RESULTS_TIMEOUT_MS }).catch(() => undefined);

        const hits = (await page.evaluate(extract, engine)).map((h) => ({ ...h, url: engine === "bing" ? unwrapBingUrl(h.url) : h.url }));
        if (hits.length > 0) return { engine, hits: hits.slice(0, max) };

        const text = await page.evaluate(() => document.body?.innerText ?? "").catch(() => "");
        if (isChallenge(engine, page.url(), await page.title().catch(() => ""), text)) {
          this.restingUntil.set(engine, Date.now() + REST_MS);
          return { engine, hits: null, note: `${engine} asked for a captcha (resting it for 15 minutes)` };
        }
        return { engine, hits: [] };
      })();
      search.catch(() => undefined);
      const answer = await bounded(search, SEARCH_DEADLINE_MS, signal);
      this.timeouts = 0;
      return answer;
    } catch (err) {
      this.timedOut(err);
      const reason = err instanceof Error ? err.message.split("\n")[0]! : String(err);
      if (this.unavailable()) return { engine, hits: null, note: `no browser could be started (${this.unavailable()})` };
      return { engine, hits: null, note: `${engine} did not load (${reason.slice(0, 120)})` };
    } finally {
      this.done(held.page);
    }
  }

  /** Deadline misses in a row; see `RESTART_AFTER_TIMEOUTS`. */
  private timeouts = 0;

  /** A read or search that ran out of time: twice in a row, and the browser itself is likely stuck. */
  private timedOut(err: unknown): void {
    if (!(err instanceof DeadlineError)) return;
    this.timeouts++;
    if (this.timeouts >= RESTART_AFTER_TIMEOUTS) {
      this.timeouts = 0;
      void this.close();
    }
  }

  /**
   * A page finished with: closed in the background, its slot handed on at once.
   *
   * Never awaited. A page stuck enough to need the deadline is stuck enough
   * not to close, and waiting for it is how one page used to hold its slot
   * for good.
   */
  private done(page: Page | undefined): void {
    if (page) void page.close().catch(() => undefined);
    this.release();
  }

  /**
   * A page slot: at once if one is free, otherwise the next one released.
   * False when `signal` stops the wait or none comes free within `waitMs`;
   * the caller then has no slot and gives nothing back.
   */
  private async slot(signal?: AbortSignal, waitMs = Infinity): Promise<boolean> {
    if (signal?.aborted) return false;
    if (this.idle) clearTimeout(this.idle);
    this.idle = null;
    if (this.active < MAX_PAGES) {
      this.active++;
      return true;
    }
    return new Promise<boolean>((resolve) => {
      let settled = false;
      const grant = (): void => {
        // Handed a slot after giving up (cannot happen once it is out of the queue, but never strand one).
        if (settled) return this.release();
        settled = true;
        cleanup();
        resolve(true);
      };
      const giveUp = (): void => {
        if (settled) return;
        settled = true;
        const at = this.queue.indexOf(grant);
        if (at >= 0) this.queue.splice(at, 1);
        cleanup();
        resolve(false);
      };
      const timer = Number.isFinite(waitMs) ? setTimeout(giveUp, waitMs) : undefined;
      const cleanup = (): void => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", giveUp);
      };
      signal?.addEventListener("abort", giveUp, { once: true });
      this.queue.push(grant);
    });
  }

  private release(): void {
    const next = this.queue.shift();
    if (next) {
      next();
      return;
    }
    this.active--;
    if (this.active === 0) this.idle = setTimeout(() => void this.close(), IDLE_CLOSE_MS);
    this.idle?.unref?.();
  }

  private open(): Promise<BrowserContext> {
    if (this.context) return this.context;
    const launching = launch(this.profileDir).catch((err: unknown) => {
      this.context = null;
      this.launchFailure = { at: Date.now(), reason: err instanceof Error ? err.message.split("\n")[0]! : String(err) };
      throw err;
    });
    this.context = launching;
    void launching.then((ctx) => ctx.on("close", () => {
      if (this.context === launching) this.context = null;
    }), () => undefined);
    return launching;
  }

  async close(): Promise<void> {
    const ctx = this.context;
    this.context = null;
    if (!ctx) return;
    // Bounded: a browser still starting, or too busy to answer, must not hold up whoever closes it (the CLI at exit).
    const closing = (async () => {
      await (await ctx.catch(() => null))?.close().catch(() => undefined);
    })();
    await Promise.race([
      closing,
      new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, CLOSE_WAIT_MS);
        timer.unref?.();
      }),
    ]);
  }
}

/**
 * The person's Edge or Chrome first — installed, updated, and what the engines
 * see every day — and Playwright's own Chromium when neither is there. Each with
 * a profile of its own if it can have one; another SoreQen holding that profile
 * (the CLI beside the app) gets a fresh one for the while.
 */
async function launch(profileDir: string): Promise<BrowserContext> {
  const { chromium } = await import("playwright");
  const args = ["--disable-blink-features=AutomationControlled", "--no-first-run", "--no-default-browser-check", "--mute-audio"];
  const channels: (string | undefined)[] = process.platform === "win32" ? ["msedge", "chrome", undefined] : ["chrome", "msedge", undefined];
  let lastError: unknown = null;
  for (const channel of channels) {
    for (const persistent of [true, false]) {
      try {
        const opts = { headless: true, args, locale: "en-US", ...(channel ? { channel } : {}) };
        const context = persistent
          ? await chromium.launchPersistentContext(profileDir, opts)
          : await (await chromium.launch(opts)).newContext({ locale: "en-US" });
        // Headless says so in its user agent; a search engine should see the browser it is.
        const page = context.pages()[0] ?? (await context.newPage());
        const ua = (await page.evaluate(() => navigator.userAgent)).replace(/Headless(?=Chrome|Edg)/g, "");
        await page.close().catch(() => undefined);
        // In the header every request carries, and in what the page's scripts read.
        await context.setExtraHTTPHeaders({ "accept-language": "en-US,en;q=0.9", "user-agent": ua });
        await context.addInitScript(`Object.defineProperty(navigator, "userAgent", { get: () => ${JSON.stringify(ua)} });`);
        await context.route("**/*", (route) => {
          const type = route.request().resourceType();
          return type === "image" || type === "media" || type === "font" ? route.abort() : route.continue();
        });
        return context;
      } catch (err) {
        lastError = err;
      }
    }
  }
  throw lastError instanceof Error ? lastError : new Error("no browser could be started");
}

let shared: BrowserSearch | null = null;

export function browserSearch(env: Record<string, string | undefined> = process.env): BrowserSearch {
  const home = env["SOREQEN_HOME"] || join(homedir(), ".soreqen");
  shared ??= new BrowserSearch(join(home, "browser", "search"));
  return shared;
}

export async function closeBrowserSearch(): Promise<void> {
  await shared?.close();
}
