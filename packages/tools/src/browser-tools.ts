/**
 * SoreQen Autonomous Browser & Visual Inspection Engine (Playwright)
 *
 * The engine is Firefox (Playwright's build of it), with Chromium, Edge and
 * Chrome behind it: a machine that has not downloaded Firefox yet still has a
 * browser, and Firefox is fetched in the background for next time.
 */

import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { chromium, firefox, type Browser, type BrowserContext, type Page } from "playwright";
import {
  scratchpadDirFor,
  type BrowserOpenInput,
  type BrowserScreenshotInput,
  type BrowserInteractInput,
  type BrowserConsoleLogsInput,
} from "@sqcode/shared";
import type { ToolExecutionContext } from "./types.js";
import { renderSnapshot } from "./browser-page.js";
import { drivePage, rememberSnapshot, snapshotPage, type DriveInput, type DriveResult } from "./browser-drive.js";

interface BrowserSessionState {
  /**
   * The session's own context in the shared browser: its cookies, storage and
   * pages, isolated from every other session's. See `sharedBrowser`.
   */
  browser: BrowserContext | null;
  page: Page | null;
  logs: Array<{ type: string; text: string; timestamp: Date }>;
  /** When this session last did anything with its browser. */
  usedAt: number;
  /**
   * Things that happened on the page that the agent did not ask about and
   * must hear about: a dialog it answered, a tab that opened, a request that
   * failed. Handed over with the next browser result, then cleared.
   */
  notes: string[];
}

/** Notes kept between two browser calls. The first are the informative ones. */
const MAX_NOTES = 20;

/**
 * Console lines kept per session.
 *
 * This array grew without a limit, and a dev server that logs on every render
 * fills it at the rate the page renders. It lives in the *gateway's* heap, not
 * the browser's, so a page left open eventually took the gateway down with an
 * out-of-memory abort — which is what it did.
 *
 * The tail is what anyone wants: an error is read just after it happens, and
 * the fifty-thousandth "rendered in 4ms" is not evidence of anything.
 */
const MAX_LOG_LINES = 1_000;
const MAX_LOG_CHARS = 4_000;

/**
 * How long a browser may sit unused before it is closed.
 *
 * A Chromium is 150–300 MB of resident memory and its own process tree. One
 * per session, never closed, is the other half of the same crash: nothing in
 * the product ever called `closeBrowserSession`, so every session that had
 * ever opened a page still held a browser.
 */
const BROWSER_IDLE_MS = 10 * 60_000;

const sessionStates = new Map<string, BrowserSessionState>();

function getOrCreateSessionState(sessionId: string): BrowserSessionState {
  // Every browser call is a chance to close the ones nobody is using —
  // not only an open, which a session driving one page never calls again.
  sweepIdleBrowsers(sessionId);
  let s = sessionStates.get(sessionId);
  if (!s) {
    s = { browser: null, page: null, logs: [], usedAt: Date.now(), notes: [] };
    sessionStates.set(sessionId, s);
    ensureSweeper();
  }
  s.usedAt = Date.now();
  return s;
}

function note(state: BrowserSessionState, text: string): void {
  if (state.notes.length < MAX_NOTES) state.notes.push(text);
}

/** The notes since the last result, handed over once. */
export function takeBrowserNotes(sessionId: string | undefined): string[] {
  const state = sessionStates.get(sessionId ?? "default");
  if (!state || state.notes.length === 0) return [];
  const notes = state.notes;
  state.notes = [];
  return notes;
}

/**
 * Everything a page does that a person testing it would notice.
 *
 * - **Dialogs** are accepted — "Delete this item?" answered the way a tester
 *   clicking through would — and reported, with their text, because an alert
 *   is often the only place an app says what went wrong. (Playwright's default
 *   dismisses them silently: a confirm-to-delete never deleted, and nothing
 *   said why.)
 * - **New tabs** from `target="_blank"` or `window.open` become the page the
 *   tools act on. Before, the agent kept clicking the old page, which had not
 *   changed, and concluded the link did nothing.
 * - **Failed requests** — an HTTP status of 400 or more, or no response at
 *   all — are logged and noted. A single-page app shows none of this on the
 *   page; a 500 from its API looks exactly like an empty list.
 */
function watchPage(state: BrowserSessionState, page: Page): void {
  page.on("console", (msg) => recordLog(state, msg.type(), msg.text()));
  page.on("pageerror", (err) => {
    recordLog(state, "error", `Uncaught exception: ${err.message}`);
    note(state, `Uncaught exception on the page: ${err.message.slice(0, 300)}`);
  });
  page.on("dialog", (dialog) => {
    const text = `A ${dialog.type()} dialog said "${dialog.message().slice(0, 300)}" — it was accepted.`;
    recordLog(state, "dialog", text);
    note(state, text);
    void dialog.accept().catch(() => undefined);
  });
  page.on("popup", (popup) => {
    state.page = popup;
    watchPage(state, popup);
    const text = `A new tab opened (${popup.url() || "loading"}) and is now the page these tools act on.`;
    recordLog(state, "tab", text);
    note(state, text);
  });
  page.on("response", (response) => {
    const status = response.status();
    if (status < 400) return;
    const request = response.request();
    const text = `${status} ${request.method()} ${shortenUrl(response.url())}`;
    recordLog(state, "network", text);
    if (["document", "xhr", "fetch", "script"].includes(request.resourceType())) note(state, `Request failed: ${text}`);
  });
  page.on("requestfailed", (request) => {
    const reason = request.failure()?.errorText ?? "no response";
    // An aborted request is usually a navigation cancelling its own fetches.
    if (/ERR_ABORTED/i.test(reason)) return;
    const text = `${request.method()} ${shortenUrl(request.url())} — ${reason}`;
    recordLog(state, "network", `failed ${text}`);
    if (["document", "xhr", "fetch", "script"].includes(request.resourceType())) note(state, `Request failed: ${text}`);
  });
}

function shortenUrl(url: string): string {
  return url.length > 160 ? `${url.slice(0, 157)}…` : url;
}

/** Record a console line, keeping only the most recent ones. */
function recordLog(state: BrowserSessionState, type: string, text: string): void {
  state.logs.push({ type, text: text.slice(0, MAX_LOG_CHARS), timestamp: new Date() });
  if (state.logs.length > MAX_LOG_LINES) {
    state.logs.splice(0, state.logs.length - MAX_LOG_LINES);
  }
}

/**
 * Close browsers nobody has used lately.
 *
 * Called at the top of every browser tool, and every minute while any browser
 * is open — see `ensureSweeper` for why the call-site sweep alone was not enough.
 */
function sweepIdleBrowsers(exceptSessionId?: string): void {
  const now = Date.now();
  for (const [id, state] of sessionStates) {
    if (id === exceptSessionId) continue;
    if (now - state.usedAt < BROWSER_IDLE_MS) continue;
    void state.browser?.close().catch(() => undefined);
    sessionStates.delete(id);
  }
  if (sessionStates.size === 0) stopSweeper();
  closeUnusedBrowsers();
}

/*
 * One browser for every session, one context each.
 *
 * Each session used to launch a Chromium of its own — a few hundred megabytes
 * apiece, so eight sessions testing their pages ran eight browsers (asked for
 * 29 Sep 2026: six to eight sessions at once without strain). A context is
 * what isolates a session anyway: its own cookies, storage, cache and pages.
 * Headless and headed are separate browsers, since that is a launch option.
 */
const sharedBrowsers = new Map<boolean, Promise<Browser>>();

async function sharedBrowser(headless: boolean): Promise<Browser> {
  const existing = sharedBrowsers.get(headless);
  if (existing) {
    const browser = await existing.catch(() => null);
    if (browser?.isConnected()) return browser;
    sharedBrowsers.delete(headless);
  }
  const launching = launchBrowser(headless);
  sharedBrowsers.set(headless, launching);
  launching.catch(() => sharedBrowsers.delete(headless));
  return launching;
}

/** The shared browsers close with their last context: an idle agent holds no Chromium. */
let opening = 0;

/** How many browsers are running and how many session contexts they hold. For tests and diagnostics. */
export async function browserStats(): Promise<{ browsers: number; contexts: number }> {
  let contexts = 0;
  for (const b of sharedBrowsers.values()) contexts += (await b.catch(() => null))?.contexts().length ?? 0;
  return { browsers: sharedBrowsers.size, contexts };
}

function closeUnusedBrowsers(): void {
  const inUse = opening > 0 || [...sessionStates.values()].some((s) => s.browser);
  if (inUse) return;
  for (const [headless, browser] of sharedBrowsers) {
    sharedBrowsers.delete(headless);
    void browser.then((b) => b.close()).catch(() => undefined);
  }
}

/*
 * …and on a timer as well, after all.
 *
 * Sweeping only inside a browser call closed a browser only when some *other*
 * session used one later, so the last browser anyone opened lived until the
 * server restarted. One left on a WebGL page rendered it in software for
 * hours — eleven cores' worth, found by chance. The timer runs only while a
 * browser exists, and is unref'd so it never keeps the process alive.
 */
let sweeper: ReturnType<typeof setInterval> | null = null;
const SWEEP_EVERY_MS = 60_000;

function ensureSweeper(): void {
  if (sweeper) return;
  sweeper = setInterval(() => sweepIdleBrowsers(), SWEEP_EVERY_MS);
  sweeper.unref?.();
}

function stopSweeper(): void {
  if (sweeper) clearInterval(sweeper);
  sweeper = null;
}

async function getOrLaunchBrowser(headless: boolean = true, sessionId: string): Promise<BrowserContext> {
  const state = getOrCreateSessionState(sessionId);
  if (state.browser && state.browser.browser()?.isConnected()) {
    return state.browser;
  }
  // Counted while it opens, so a sweep from another session cannot close the browser under it.
  opening++;
  try {
    const browser = await sharedBrowser(headless);
    /*
     * At the screen's own scale, never more than 2x.
     *
     * A page drawn at 1x and shown on a 150% screen is stretched, and looks
     * soft however well it is laid out. At the screen's scale the panel shows
     * the page pixel for pixel. A 100% screen stays at 1x, the cheapest, and
     * the agent's own screenshots are taken at CSS size either way, so the
     * model is sent no more pixels than before.
     */
    const scale = panelScale;
    state.browser = await browser.newContext(scale > 1 ? { deviceScaleFactor: scale } : {});
    contextScale.set(state.browser, scale);
    return state.browser;
  } finally {
    opening--;
  }
}

/** The scale new pages are drawn at: the screen's, as the panel reports it. */
let panelScale = 1;
const contextScale = new WeakMap<BrowserContext, number>();

/** The panel's screen scale (devicePixelRatio), for browsers started from now on. */
export function setPanelScale(scale: number): void {
  if (Number.isFinite(scale) && scale > 0) panelScale = Math.min(2, Math.max(1, Math.round(scale * 4) / 4));
}

/** The scale a page is drawn at: its frames are this many pixels per CSS pixel. */
export function pageScale(page: Page): number {
  return contextScale.get(page.context()) ?? 1;
}

/** Which engine the shared browser runs on, once one has started. */
let engine: "firefox" | "chromium" | null = null;

export function browserEngine(): "firefox" | "chromium" | null {
  return engine;
}

/*
 * Firefox, fetched once in the background.
 *
 * Playwright drives its own build of Firefox (stock Firefox has no automation
 * protocol it can use), a one-off download of about 120 MB. Nothing waits for
 * it: until it lands, the session gets Chromium, Edge or Chrome, and the next
 * browser started after it lands is Firefox.
 */
let firefoxInstall: Promise<boolean> | null = null;

function installFirefoxInBackground(): void {
  if (firefoxInstall || process.env["SOREQEN_BROWSER_NO_INSTALL"]) return;
  firefoxInstall = new Promise<boolean>((resolve) => {
    try {
      const cli = path.join(path.dirname(createRequire(import.meta.url).resolve("playwright/package.json")), "cli.js");
      const child = spawn(process.execPath, [cli, "install", "firefox"], { stdio: "ignore", windowsHide: true });
      child.on("error", () => resolve(false));
      child.on("exit", (code) => resolve(code === 0));
    } catch {
      resolve(false);
    }
  });
  void firefoxInstall.then((ok) => {
    // A failed download may be tried again by a later browser start.
    if (!ok) setTimeout(() => (firefoxInstall = null), 10 * 60_000).unref?.();
  });
}

async function launchBrowser(headless: boolean): Promise<Browser> {
  const wanted = (process.env["SOREQEN_BROWSER_ENGINE"] ?? "firefox").toLowerCase();
  let lastError: Error | null = null;

  if (wanted !== "chromium") {
    try {
      // Muted: the agent's pages play in the background, never in the person's headphones.
      const browser = await firefox.launch({ headless, firefoxUserPrefs: { "media.volume_scale": "0.0" } });
      engine = "firefox";
      return browser;
    } catch (err: unknown) {
      lastError = err instanceof Error ? err : new Error(String(err));
      if (/Executable doesn't exist|playwright install/i.test(lastError.message)) installFirefoxInBackground();
    }
  }

  // Chromium behind it: Playwright's own, then the system's Edge and Chrome.
  const launchOptions = [
    { name: "default chromium", opts: { headless, args: ["--mute-audio"] } },
    { name: "system msedge", opts: { channel: "msedge", headless, args: ["--mute-audio"] } },
    { name: "system chrome", opts: { channel: "chrome", headless, args: ["--mute-audio"] } },
  ];
  for (const { opts } of launchOptions) {
    try {
      const browser = await chromium.launch(opts);
      engine = "chromium";
      return browser;
    } catch (err: unknown) {
      lastError = err instanceof Error ? err : new Error(String(err));
    }
  }

  /*
   * Say what would fix it.
   *
   * Playwright ships as a library and downloads its browsers separately, so
   * the overwhelmingly common failure here is not "no browser on this
   * machine" but "nobody has run the install command yet" — and the message
   * that said "failed across all available channels" gave an agent nothing to
   * act on, which is how an installable dependency became a capability the
   * agent reported it did not have.
   */
  const detail = lastError?.message ?? "";
  if (/Executable doesn't exist|playwright install/i.test(detail)) {
    throw new Error(
      "Playwright is installed but its browser binary is not. Run " +
        "`npx playwright install firefox` in the project, then try again. " +
        "This is a one-off download, not a missing capability.",
    );
  }
  throw new Error(
    `Could not launch a browser (tried Firefox, Chromium, Edge and Chrome). ${detail}`,
  );
}

/**
 * Where a `file://` the agent asked for is allowed to point.
 *
 * ## The hole this closes
 *
 * `browser_open` resolved a relative path against **the server's working
 * directory** and turned it into a `file://` URL, with no path guard anywhere
 * in this module — every other file-touching tool goes through `guardPath`,
 * this one did not. Paired with `browser_interact`'s `evaluate_js`, which can
 * read `document.body.innerText`, that made the browser a general read
 * primitive over the whole host filesystem: `browser_open("../../.env")` then
 * one `evaluate_js` returns the gateway's provider keys, database URL and JWT
 * secret. On the hosted surface it also reaches every other tenant's
 * workspace, since those are sibling directories under one base path.
 *
 * Both calls are allowed *silently* in the default tier, so nothing asked
 * anybody.
 *
 * ## What replaces it
 *
 * Local preview is a real feature — "open index.html with no build step" is in
 * the system prompt — so it is kept and confined instead of removed: a path is
 * resolved against **the workspace root**, and a target that escapes it is
 * refused with a sentence rather than fetched. Absolute `file://` URLs are
 * held to the same boundary.
 *
 * Symlinks are resolved before the check, because a link inside the workspace
 * pointing outside it is exactly how a boundary drawn on strings gets crossed.
 */
export async function resolveBrowserTarget(
  raw: string,
  workspaceRoot: string | null,
): Promise<string> {
  const target = raw.trim();

  if (target.startsWith("localhost:") || target.startsWith("127.0.0.1:")) {
    return `http://${target}`;
  }
  if (target.startsWith("http://") || target.startsWith("https://")) return target;

  /*
   * A query or fragment belongs to the URL, not the file name.
   *
   * `index.html?probe=1` was resolved as one path and came out as
   * `index.html%3Fprobe=1`, a file that does not exist (Firefox reports
   * NS_ERROR_FILE_INVALID_PATH). It is split off first and put back after.
   */
  let suffix = "";
  let requested: string;
  if (target.startsWith("file://")) {
    const url = new URL(target.startsWith("file:///") ? target : target.replace("file://", "file:///"));
    suffix = url.search + url.hash;
    url.search = "";
    url.hash = "";
    requested = fileURLToPath(url);
  } else {
    const at = target.search(/[?#]/);
    suffix = at >= 0 ? target.slice(at) : "";
    requested = at >= 0 ? target.slice(0, at) : target;
  }

  if (!workspaceRoot) {
    throw new Error(
      `'${raw}' is not an http or https URL, and this session has no workspace to resolve a local ` +
        "file against. Open a URL instead.",
    );
  }

  const root = await realOrSelf(path.resolve(workspaceRoot));
  const absolute = path.resolve(root, requested);
  const resolved = await realOrSelf(absolute);

  const relative = path.relative(root, resolved);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(
      `Refusing to open '${raw}': it resolves outside the workspace. The browser may only open ` +
        "files inside the workspace, or an http/https URL.",
    );
  }

  return pathToFileURL(resolved).href + suffix;
}

/** The path a symlink points at, or the path itself when it is not one or
 *  does not exist yet. A missing file is refused later, by the browser. */
async function realOrSelf(target: string): Promise<string> {
  try {
    return await fs.realpath(target);
  } catch {
    return target;
  }
}

export async function toolBrowserOpen(
  sessionId: string | undefined,
  input: BrowserOpenInput,
  workspaceRoot?: string | null,
): Promise<{
  success: boolean;
  url: string;
  title: string;
  status: number;
  message: string;
}> {
  const targetUrl = await resolveBrowserTarget(input.url, workspaceRoot ?? null);

  /*
   * The browser opens the person's own dev servers on localhost — that is
   * what it is for — but never a cloud metadata service: on a machine that
   * has one, it hands out the machine's credentials to anything that asks.
   */
  try {
    const host = new URL(targetUrl).hostname.toLowerCase().replace(/^\[|\]$/g, "");
    if (/^169\.254\.|^fd00:ec2::254$|^metadata\.google\.internal$|^metadata\.azure\.com$/.test(host)) {
      return { success: false, url: targetUrl, title: "", status: 0, message: `${host} is a cloud metadata address; the browser does not open it.` };
    }
  } catch {
    // Not a URL with a host (a file path); nothing to check.
  }

  try {
    const state = getOrCreateSessionState(sessionId ?? "default");
    const browser = await getOrLaunchBrowser(input.headless ?? true, sessionId ?? "default");

    if (!state.page || state.page.isClosed()) {
      state.page = await browser.newPage();
      watchPage(state, state.page);
    }

    const response = await state.page.goto(targetUrl, {
      timeout: input.timeout_ms ?? 30000,
      waitUntil: "domcontentloaded",
    });

    const title = await state.page.title();
    const status = response?.status() ?? 200;

    return {
      success: true,
      url: targetUrl,
      title,
      status,
      message: `Successfully navigated to '${targetUrl}' (Page title: '${title}', HTTP Status: ${status})`,
    };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      success: false,
      url: targetUrl,
      title: "",
      status: 0,
      message: `Failed to open browser page: ${msg}`,
    };
  }
}

/**
 * A screenshot, kept as a file rather than carried as text.
 *
 * A PNG as base64 is hundreds of kilobytes of text. In a tool result it was
 * cut to its first and last 12,000 characters — useless to the model, and a
 * wall of characters in the transcript where a picture belonged. The image is
 * written to the session's scratchpad and the result names the file, which
 * the transcript shows as an image and the model can refer to.
 */
export async function storeScreenshot(
  shot: Awaited<ReturnType<typeof toolBrowserScreenshot>>,
  ctx: Pick<ToolExecutionContext, "sandboxRunner" | "workspaceId" | "sessionId">,
): Promise<Record<string, unknown>> {
  const { screenshotBase64, ...rest } = shot;
  if (!screenshotBase64) return rest;
  if (!ctx.sandboxRunner.writeBinaryFile) {
    return { ...rest, note: "The screenshot was taken but this workspace cannot store it." };
  }
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const file = `${scratchpadDirFor(ctx.sessionId ?? "default")}/screenshots/screenshot-${stamp}.png`;
  try {
    await ctx.sandboxRunner.writeBinaryFile(ctx.workspaceId, file, Buffer.from(screenshotBase64, "base64"));
    return { ...rest, screenshotPath: file };
  } catch (err) {
    return { ...rest, note: `The screenshot was taken but could not be stored: ${err instanceof Error ? err.message : String(err)}` };
  }
}

/** Whether an address is a page on this computer: a dev server the agent started, most often. */
export function isLocalPage(raw: string): boolean {
  try {
    const url = new URL(raw);
    if (url.protocol !== "http:" && url.protocol !== "https:") return false;
    const host = url.hostname.toLowerCase();
    return host === "localhost" || host === "127.0.0.1" || host === "[::1]" || host === "0.0.0.0" || host.endsWith(".localhost");
  } catch {
    return false;
  }
}

/**
 * A picture of the page as it is now, saved for its preview card.
 *
 * The card under a turn shows the local page the agent opened (13 Nov 2026).
 * It cannot wait for the model to take a screenshot: many turns never do, and
 * for a model that cannot read images the screenshot step is reported as
 * failed, so the card was blank. This is taken by the open itself, goes to a
 * file, and is never sent to the model: its result carries the path only.
 *
 * A client-rendered page paints after `load`, so it is given a moment to
 * settle, bounded: a dev server's hot-reload socket never goes idle.
 */
export async function capturePagePreview(
  sessionId: string | undefined,
  ctx: Pick<ToolExecutionContext, "sandboxRunner" | "workspaceId" | "sessionId">,
): Promise<string | null> {
  const state = getOrCreateSessionState(sessionId ?? "default");
  const page = state.page;
  if (!page || page.isClosed() || !ctx.sandboxRunner.writeBinaryFile) return null;
  try {
    await page.waitForLoadState("networkidle", { timeout: 1_500 }).catch(() => undefined);
    const picture = await page.screenshot({ type: "jpeg", quality: 72, scale: "css" });
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const file = `${scratchpadDirFor(ctx.sessionId ?? "default")}/previews/preview-${stamp}.jpg`;
    await ctx.sandboxRunner.writeBinaryFile(ctx.workspaceId, file, picture);
    return file;
  } catch {
    // The card falls back to its placeholder; opening the page still succeeded.
    return null;
  }
}

export async function toolBrowserScreenshot(sessionId: string | undefined, input: BrowserScreenshotInput): Promise<{
  success: boolean;
  screenshotBase64: string;
  url: string;
  title: string;
  domSummary: string;
  error?: string;
}> {
  const state = getOrCreateSessionState(sessionId ?? "default");
  if (!state.page || state.page.isClosed()) {
    return {
      success: false,
      screenshotBase64: "",
      url: "",
      title: "",
      domSummary: "",
      error: "No active browser page found. Call 'browser_open' before requesting screenshots.",
    };
  }

  try {
    const screenshot = await state.page.screenshot({
      fullPage: input.full_page ?? false,
      type: "png",
      // CSS pixels, whatever the context's scale: what the model is sent stays small.
      scale: "css",
    });

    const title = await state.page.title();
    const url = state.page.url();

    // Extract concise DOM snapshot for LLM visual reasoning
    const domSummary = await state.page.evaluate(() => {
      const headings = Array.from(document.querySelectorAll("h1, h2, h3"))
        .map((h) => `${h.tagName}: ${h.textContent?.trim() || ""}`)
        .slice(0, 10);
      const buttons = Array.from(document.querySelectorAll("button, a"))
        .map((b) => `[${b.tagName}] ${b.textContent?.trim() || ""}`)
        .filter((t) => t.length > 3)
        .slice(0, 15);
      return `Headings:\n${headings.join("\n")}\n\nInteractive Elements:\n${buttons.join("\n")}`;
    });

    return {
      success: true,
      screenshotBase64: screenshot.toString("base64"),
      url,
      title,
      domSummary,
    };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      success: false,
      screenshotBase64: "",
      url: "",
      title: "",
      domSummary: "",
      error: `Screenshot capture failed: ${msg}`,
    };
  }
}

/**
 * Read the page.
 *
 * The first half of making the browser usable: an agent that has seen a
 * numbered list of what is on screen stops inventing selectors. See
 * `browser-page.ts`.
 */
export async function toolBrowserSnapshot(
  sessionId: string | undefined,
  input: { include_text?: boolean } = {},
): Promise<{ success: boolean; url?: string; title?: string; elements?: number; page?: string; error?: string }> {
  const state = getOrCreateSessionState(sessionId ?? "default");
  if (!state.page || state.page.isClosed()) {
    return {
      success: false,
      error: "No page is open. Call browser_open first.",
    };
  }

  try {
    const snapshot = await snapshotPage(state.page);
    rememberSnapshot(state.page, snapshot);
    const rendered = renderSnapshot(
      input.include_text === false ? { ...snapshot, text: "" } : snapshot,
    );
    return {
      success: true,
      url: snapshot.url,
      title: snapshot.title,
      elements: snapshot.elements.length,
      page: rendered,
    };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return { success: false, error: `Could not read the page: ${message}` };
  }
}

/**
 * Drive the page.
 *
 * The logic lives in `browser-drive.ts`; this is the part that owns the
 * session's page and turns "no page" into a sentence rather than a crash.
 */
export async function toolBrowserInteract(
  sessionId: string | undefined,
  input: BrowserInteractInput,
  workspaceRoot?: string | null,
): Promise<DriveResult> {
  const state = getOrCreateSessionState(sessionId ?? "default");
  if ((!state.page || state.page.isClosed()) && input.action === "resize") {
    /*
     * Sizing the window before opening anything is the natural order ("at
     * mobile width, open the contact page"), and the first step of many a
     * batch. A blank page takes the size; the next open keeps it.
     */
    const browser = await getOrLaunchBrowser(true, sessionId ?? "default");
    state.page = await browser.newPage();
    watchPage(state, state.page);
  }
  if (!state.page || state.page.isClosed()) {
    return {
      success: false,
      action: input.action,
      result: "",
      error: "No page is open. Call browser_open first.",
    };
  }
  return drivePage(state.page, input as DriveInput, { workspaceRoot: workspaceRoot ?? null });
}

export async function toolBrowserConsoleLogs(sessionId: string | undefined, input: BrowserConsoleLogsInput): Promise<{
  logs: Array<{ type: string; text: string; timestamp: string }>;
  totalLogs: number;
}> {
  const state = getOrCreateSessionState(sessionId ?? "default");
  const currentLogs = [...state.logs];
  if (input.clear_after_read) {
    state.logs = [];
  }
  return {
    logs: currentLogs.map((l) => ({
      type: l.type,
      text: l.text,
      timestamp: l.timestamp.toISOString(),
    })),
    totalLogs: currentLogs.length,
  };
}

export async function closeBrowserSession(sessionId?: string): Promise<void> {
  if (sessionId) {
    /*
     * The session's own browser, and every one its sub-agents opened —
     * theirs are keyed `<session>_sub_<agent>`, and would otherwise outlive
     * the session until the idle sweep found them.
     *
     * The entry goes even when no browser was ever launched: it still holds
     * the console log, which is what filled the gateway's heap before.
     */
    const prefix = `${sessionId}_sub_`;
    for (const [id, state] of [...sessionStates]) {
      if (id !== sessionId && !id.startsWith(prefix)) continue;
      await state.browser?.close().catch(() => {});
      sessionStates.delete(id);
    }
  } else {
    for (const state of sessionStates.values()) {
      if (state.browser) {
        await state.browser.close().catch(() => {});
      }
    }
    sessionStates.clear();
  }
  closeUnusedBrowsers();
}

/*
 * For the live view (browser-live.ts): the person watching, and using, the
 * same browser the agent drives. These reach the session's own state; they do
 * not launch anything a tool call would not.
 */

/** Every browser context a session has: its own, and its sub-agents'. */
export function browserSessionsOf(sessionId: string): Array<{ key: string; owner: string; context: BrowserContext; page: Page | null }> {
  const prefix = `${sessionId}_sub_`;
  const out: Array<{ key: string; owner: string; context: BrowserContext; page: Page | null }> = [];
  for (const [key, state] of sessionStates) {
    if (key !== sessionId && !key.startsWith(prefix)) continue;
    if (!state.browser || !state.browser.browser()?.isConnected()) continue;
    out.push({ key, owner: key === sessionId ? "agent" : key.slice(prefix.length), context: state.browser, page: state.page && !state.page.isClosed() ? state.page : null });
  }
  return out;
}

/** Someone is looking at this session's browser: it is not idle. */
export function touchBrowserSession(key: string): void {
  const state = sessionStates.get(key);
  if (state) state.usedAt = Date.now();
}

/** Tell the agent, with its next browser result, what the person did. */
export function noteBrowserSession(key: string, text: string): void {
  const state = sessionStates.get(key);
  if (state) note(state, text);
}

/** Make `page` the one the session's tools act on. */
export function setActiveBrowserPage(key: string, page: Page): void {
  const state = sessionStates.get(key);
  if (state && !page.isClosed()) state.page = page;
}

/**
 * A new tab in the session's browser, opened by the person. It becomes the
 * page the agent's tools act on, as a tab the agent opened would, and the
 * agent hears so. Starts the session's (headless) browser if it has none.
 */
export async function openBrowserTab(sessionId: string, url?: string): Promise<Page> {
  const state = getOrCreateSessionState(sessionId);
  const context = await getOrLaunchBrowser(true, sessionId);
  const page = await context.newPage();
  watchPage(state, page);
  state.page = page;
  const to = url ?? newTabPage;
  if (to) await page.goto(to, { waitUntil: "domcontentloaded", timeout: 30_000 }).catch(() => undefined);
  note(state, `The person opened a new tab${url ? ` at ${shortenUrl(url)}` : ""} in the browser panel; it is now the page these tools act on.`);
  return page;
}

/**
 * The page a tab the person opens starts on, instead of a blank one: set by
 * the app that serves it (the desktop runtime's SoreQen new tab page).
 */
let newTabPage: string | null = null;

export function setNewTabPage(url: string | null): void {
  newTabPage = url;
}

export function isNewTabPage(url: string): boolean {
  return newTabPage !== null && url.split(/[?#]/)[0] === newTabPage.split(/[?#]/)[0];
}
