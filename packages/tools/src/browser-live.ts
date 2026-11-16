/**
 * The agent's browser, live, for the person to watch and use.
 *
 * The agent drives a headless browser (browser-tools.ts: Firefox, or
 * Chromium where Firefox is not installed yet): one context per session, its
 * pages, the one its tools act on. This streams the page itself: frames while
 * it moves (Playwright's screencast, which both engines support), a sharp
 * full-resolution capture once it settles, and the person's mouse, wheel and
 * keys sent back as real input. Nothing is injected into the page.
 *
 * - **Same browser, same pages.** A tab the person opens is a tab in the
 *   agent's context, and becomes the page the agent's tools act on; the agent
 *   is told so with its next browser result. A tab the agent opens (a popup,
 *   or the agent's own `browser_open`) is followed by the view.
 * - **The panel's size.** A page on screen is laid out at the panel's size,
 *   as in any browser window, unless the agent chose a size for it (a phone
 *   width), which is kept. When nobody is watching, it goes back to the size
 *   the agent's pages have by default.
 * - **Closing the view stops nothing.** It stops the frames. The agent keeps
 *   its browser, and the idle sweep still closes it when nobody uses it.
 */

import { createHash } from "node:crypto";
import type { Page } from "playwright";
import { chosenViewports } from "./browser-drive.js";
import {
  browserSessionsOf,
  isNewTabPage,
  noteBrowserSession,
  openBrowserTab,
  setActiveBrowserPage,
  touchBrowserSession,
} from "./browser-tools.js";

export interface LiveTab {
  id: string;
  /** Empty for SoreQen's new tab page. */
  url: string;
  title: string;
  /** The page this tab's owner acts on. */
  active: boolean;
  /** "agent", or the sub-agent's name. */
  owner: string;
}

export interface LiveState {
  tabs: LiveTab[];
  /** The tab on screen, or null when the session has no browser yet. */
  viewing: string | null;
}

export interface LiveFrame {
  tab: string;
  /** Base64 JPEG. */
  data: string;
  /** The page's size in CSS pixels, which input coordinates are in. */
  width: number;
  height: number;
  /** A full-resolution capture of a page at rest, rather than a frame of one moving. */
  sharp?: boolean;
}

export type LiveInput =
  | { kind: "move"; x: number; y: number }
  | { kind: "down" | "up"; x: number; y: number; button?: "left" | "right" | "middle"; clicks?: number }
  | { kind: "wheel"; x: number; y: number; dx: number; dy: number }
  | { kind: "key"; key: string }
  | { kind: "text"; text: string };

/** The size the agent's pages have when nobody is watching (Playwright's default). */
const DEFAULT_VIEWPORT = { width: 1280, height: 720 };

const ids = new WeakMap<Page, string>();
let nextId = 1;

function idOf(page: Page): string {
  let id = ids.get(page);
  if (!id) {
    id = `t${nextId++}`;
    ids.set(page, id);
  }
  return id;
}

interface Found {
  page: Page;
  key: string;
}

function allPages(sessionId: string): Array<Found & { owner: string; active: boolean }> {
  const out: Array<Found & { owner: string; active: boolean }> = [];
  for (const s of browserSessionsOf(sessionId)) {
    for (const page of s.context.pages()) {
      if (page.isClosed()) continue;
      out.push({ page, key: s.key, owner: s.owner, active: page === s.page });
    }
  }
  return out;
}

function find(sessionId: string, tab: string): Found | null {
  return allPages(sessionId).find((p) => idOf(p.page) === tab) ?? null;
}

/** What a person typed in the address bar, as a URL. */
export function addressToUrl(typed: string): string {
  const t = typed.trim();
  if (!t) return "about:blank";
  if (/^(https?|file|about):/i.test(t)) return t;
  if (/^javascript:/i.test(t)) return "about:blank";
  if (/^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?(\/|$)/i.test(t)) return `http://${t}`;
  if (/^[\w-]+(\.[\w-]+)+(:\d+)?(\/\S*)?$/.test(t) && !/\s/.test(t)) return `https://${t}`;
  return `https://duckduckgo.com/?q=${encodeURIComponent(t)}`;
}

/** How many tabs the session's browser has open (0 when it has none). */
export function liveTabCount(sessionId: string): number {
  return allPages(sessionId).length;
}

/** Open a tab (the person's "+"), optionally at an address. */
export async function liveOpenTab(sessionId: string, address?: string): Promise<string> {
  const page = await openBrowserTab(sessionId, address ? addressToUrl(address) : undefined);
  return idOf(page);
}

/** Put a tab in front: the page its owner's tools act on from now. */
export function liveSelectTab(sessionId: string, tab: string): boolean {
  const found = find(sessionId, tab);
  if (!found) return false;
  setActiveBrowserPage(found.key, found.page);
  void found.page.bringToFront().catch(() => undefined);
  noteBrowserSession(found.key, `The person switched the browser to the tab at ${found.page.url()}; it is now the page these tools act on.`);
  return true;
}

export async function liveCloseTab(sessionId: string, tab: string): Promise<boolean> {
  const found = find(sessionId, tab);
  if (!found) return false;
  const url = found.page.url();
  await found.page.close().catch(() => undefined);
  const rest = allPages(sessionId).filter((p) => p.key === found.key);
  const next = rest[rest.length - 1];
  if (next && !rest.some((p) => p.active)) setActiveBrowserPage(found.key, next.page);
  noteBrowserSession(found.key, `The person closed the tab at ${url}.`);
  return true;
}

export async function liveNavigate(
  sessionId: string,
  tab: string,
  action: "go" | "back" | "forward" | "reload",
  address?: string,
): Promise<{ ok: boolean; error?: string }> {
  const found = find(sessionId, tab);
  if (!found) return { ok: false, error: "That tab is closed." };
  touchBrowserSession(found.key);
  casts.get(found.page)?.wake();
  try {
    if (action === "back") await found.page.goBack({ timeout: 15_000 });
    else if (action === "forward") await found.page.goForward({ timeout: 15_000 });
    else if (action === "reload") await found.page.reload({ timeout: 30_000 });
    else {
      const url = addressToUrl(address ?? "");
      await found.page.goto(url, { waitUntil: "domcontentloaded", timeout: 30_000 });
      noteBrowserSession(found.key, `The person navigated the browser to ${found.page.url()}.`);
    }
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message.split("\n")[0] : String(err) };
  }
}

/** Pages laid out at a panel's size, to be put back when nobody is watching. */
const fitted = new WeakSet<Page>();
/** Sessions whose agent has been told the panel is sizing its pages. */
const toldAboutFit = new Set<string>();

/**
 * Lay the page out at the panel's size, as a browser window would be: the
 * frames are then the panel's pixels, not a desktop page shrunk into it (which
 * is what made it look blurred). A size the agent chose itself is kept, and
 * the panel shows that page scaled to fit.
 */
export async function liveFit(sessionId: string, tab: string, panelWidth: number, panelHeight: number): Promise<boolean> {
  const found = find(sessionId, tab);
  if (!found || panelWidth < 50 || panelHeight < 50) return false;
  if (chosenViewports.has(found.page)) return false;
  const width = Math.max(320, Math.min(3840, Math.round(panelWidth)));
  const height = Math.max(240, Math.min(2400, Math.round(panelHeight)));
  const size = found.page.viewportSize();
  if (size && Math.abs(size.width - width) < 2 && Math.abs(size.height - height) < 2) return true;
  await found.page.setViewportSize({ width, height }).catch(() => undefined);
  fitted.add(found.page);
  casts.get(found.page)?.resized();
  if (!toldAboutFit.has(found.key)) {
    toldAboutFit.add(found.key);
    noteBrowserSession(
      found.key,
      `The person is watching this browser in a panel, so pages are laid out at the panel's size (${width}×${height} now). ` +
        "To check a layout at a particular width, use browser_drive's resize; that size is kept.",
    );
  }
  return true;
}

/** Put pages the panel sized back to the agent's default size. */
function unfit(sessionId: string): void {
  for (const { page, key } of allPages(sessionId)) {
    if (!fitted.has(page)) continue;
    fitted.delete(page);
    toldAboutFit.delete(key);
    if (chosenViewports.has(page)) continue;
    void page.setViewportSize(DEFAULT_VIEWPORT).catch(() => undefined);
  }
}

/** Playwright's name for a key, from a DOM KeyboardEvent's `key` plus modifiers. */
export function playwrightKey(key: string): string {
  const parts = key.split("+");
  const last = parts.pop() ?? "";
  const named: Record<string, string> = { " ": "Space", Esc: "Escape", Del: "Delete", Left: "ArrowLeft", Right: "ArrowRight", Up: "ArrowUp", Down: "ArrowDown" };
  return [...parts, named[last] ?? last].join("+");
}

export async function liveInput(sessionId: string, tab: string, input: LiveInput): Promise<boolean> {
  const found = find(sessionId, tab);
  if (!found) return false;
  touchBrowserSession(found.key);
  const { page } = found;
  /*
   * Someone is using the page: frames at once, not at the next look.
   *
   * Except for a pointer moving over it. A hover changes a little and settles,
   * and streaming for it showed soft frames between sharp ones on every move,
   * which read as a page that kept blurring and refreshing. One sharp look
   * after the pointer rests shows the hover; the rest look catches anything
   * that keeps moving.
   */
  if (input.kind === "move") casts.get(page)?.look();
  else casts.get(page)?.wake();
  try {
    switch (input.kind) {
      case "move":
        await page.mouse.move(input.x, input.y);
        break;
      case "down":
        await page.mouse.move(input.x, input.y);
        await page.mouse.down({ button: input.button ?? "left", clickCount: input.clicks ?? 1 });
        break;
      case "up":
        await page.mouse.move(input.x, input.y);
        await page.mouse.up({ button: input.button ?? "left", clickCount: input.clicks ?? 1 });
        break;
      case "wheel":
        await page.mouse.move(input.x, input.y);
        await page.mouse.wheel(input.dx, input.dy);
        break;
      case "key":
        await page.keyboard.press(playwrightKey(input.key));
        break;
      case "text":
        await page.keyboard.insertText(input.text.slice(0, 10_000));
        break;
    }
    return true;
  } catch {
    return false;
  }
}

/*
 * One screencast per page, however many are watching it.
 *
 * Playwright runs one screencast per page, so a second window watching the
 * same tab shares the first one's frames instead of starting a second cast
 * that would stop the first.
 */
type FrameListener = (frame: LiveFrame) => void;
interface Cast {
  listeners: Set<FrameListener>;
  /** The newest frame, for a window that starts watching an existing cast. */
  last: LiveFrame | null;
  /** Someone used the page: stream frames again now. */
  wake: () => void;
  /** The page's size changed: frames at the new size. */
  resized: () => void;
  /** The pointer moved: one sharp look once it rests, rather than a stream of soft frames. */
  look: () => void;
  stop: () => void;
}
const casts = new Map<Page, Cast>();

/** How long a page must be still before it is captured at full quality. */
const SETTLE_MS = 220;
/**
 * JPEG quality of moving frames. Text stays readable while it scrolls; the
 * still page that follows is captured sharp anyway (`SETTLE_MS`).
 */
const STREAM_QUALITY = 72;
/** About 30 frames a second at most, which is more than the engines produce. */
const FRAME_GAP_MS = 33;
/** Still for this long, the screencast stops and the page is only looked at now and then. */
const REST_AFTER_MS = 4_000;
/** How often a page at rest is looked at for a change. */
const REST_LOOK_MS = 1_000;

function digest(data: Buffer): string {
  return createHash("sha1").update(data).digest("hex");
}

/*
 * One page's frames, cheap at rest.
 *
 * Firefox's screencast is a steady ~24 frames a second whether or not the
 * page changes, and the frames of a still page are byte-for-byte the same.
 * So repeats are dropped (a still page sends nothing, and settles into one
 * sharp capture), and after a few seconds without a change the screencast
 * stops altogether: the page is looked at once a second, and streaming
 * starts again on the first change, or at once when someone uses the page.
 */
function startCast(page: Page): Cast {
  const tab = idOf(page);
  let stopped = false;
  let streaming = false;
  let settleTimer: ReturnType<typeof setTimeout> | null = null;
  let lastAt = 0;
  let pending: LiveFrame | null = null;
  let gapTimer: ReturnType<typeof setTimeout> | null = null;
  let capturing = false;
  let lastFrameHash = "";
  let lastChangeAt = Date.now();
  let restLook = "";
  let lastSharpHash = "";
  /** A moving frame went out after the last sharp one, so the screen shows a soft picture. */
  let softOnScreen = true;

  const cast: Cast = {
    listeners: new Set(),
    last: null,
    wake: () => undefined,
    resized: () => undefined,
    look: () => undefined,
    stop: () => undefined,
  };

  const deliver = (frame: LiveFrame): void => {
    cast.last = frame;
    for (const listener of cast.listeners) listener(frame);
  };
  const throttled = (frame: LiveFrame): void => {
    const wait = lastAt + FRAME_GAP_MS - Date.now();
    if (wait <= 0) {
      lastAt = Date.now();
      deliver(frame);
      return;
    }
    pending = frame;
    gapTimer ??= setTimeout(() => {
      gapTimer = null;
      if (stopped || !pending) return;
      lastAt = Date.now();
      deliver(pending);
      pending = null;
    }, wait);
  };

  /** The page at rest, captured at high quality: no compression smear on still text. */
  const sharp = async (): Promise<void> => {
    if (stopped || capturing || page.isClosed()) return;
    capturing = true;
    try {
      const size = page.viewportSize() ?? DEFAULT_VIEWPORT;
      // Device pixels: on a 150% screen the panel gets 1.5 pixels for every CSS pixel, as a browser would draw it.
      const shot = await page.screenshot({ type: "jpeg", quality: 88, scale: "device", timeout: 5_000 });
      // The same picture again is not news: resending it is what made a still page look like it was refreshing.
      const hash = digest(shot);
      if (hash === lastSharpHash && !softOnScreen) return;
      lastSharpHash = hash;
      softOnScreen = false;
      if (!stopped) throttled({ tab, data: shot.toString("base64"), width: size.width, height: size.height, sharp: true });
    } catch {
      // Navigating; the next frame or the next rest catches up.
    } finally {
      capturing = false;
    }
  };
  const settleSoon = (): void => {
    if (settleTimer) clearTimeout(settleTimer);
    settleTimer = setTimeout(() => {
      settleTimer = null;
      void sharp();
    }, SETTLE_MS);
  };

  /*
   * The frame size is given every time. Left out, Playwright takes the
   * browser's default viewport (1280×720) shrunk to fit 800 pixels, once, at
   * the start: every frame was an 800×450 picture whatever the page's real
   * size, and the panel stretched it into a blur.
   */
  const stream = (): void => {
    if (streaming || stopped || page.isClosed()) return;
    streaming = true;
    lastChangeAt = Date.now();
    /*
     * Moving frames at the page's own size, not the screen's pixels: on a
     * 150% screen and a wide panel that was 2,400 by 1,350 at quality 85,
     * up to 30 times a second, every one of them base64 through the event
     * stream and decoded in the window, which is what made the panel lag
     * (13 Nov 2026). A quarter to a half of that now; the page settles into
     * one sharp capture at the screen's resolution once it is still.
     */
    const css = page.viewportSize() ?? DEFAULT_VIEWPORT;
    void page.screencast
      .start({
        quality: STREAM_QUALITY,
        size: { width: css.width, height: css.height },
        onFrame: ({ data }) => {
          if (stopped || !streaming) return;
          const hash = digest(data);
          if (hash === lastFrameHash) return;
          lastFrameHash = hash;
          lastChangeAt = Date.now();
          const css = page.viewportSize() ?? DEFAULT_VIEWPORT;
          softOnScreen = true;
          throttled({ tab, data: data.toString("base64"), width: css.width, height: css.height });
          settleSoon();
        },
      })
      .then(() => {
        if (stopped || !streaming) void page.screencast.stop().catch(() => undefined);
      })
      .catch(() => {
        streaming = false;
      });
  };
  const rest = (): void => {
    if (!streaming) return;
    streaming = false;
    restLook = "";
    void page.screencast.stop().catch(() => undefined);
  };

  // A frame at once: a page that never repaints sends no screencast frame.
  void sharp();
  stream();

  const timer = setInterval(() => {
    if (stopped || page.isClosed()) return;
    if (streaming) {
      if (Date.now() - lastChangeAt > REST_AFTER_MS) rest();
      return;
    }
    // At rest: a small, quick look, and streaming again if anything moved.
    void page
      .screenshot({ type: "jpeg", quality: 40, scale: "css", timeout: 3_000 })
      .then((shot) => {
        const hash = digest(shot);
        if (restLook && hash !== restLook) {
          lastFrameHash = "";
          stream();
        }
        restLook = hash;
      })
      .catch(() => undefined);
  }, REST_LOOK_MS);
  timer.unref?.();

  cast.wake = () => {
    lastChangeAt = Date.now();
    stream();
  };
  cast.look = () => {
    if (!streaming) settleSoon();
  };
  cast.resized = () => {
    // The size is fixed when a screencast starts, so a new size is a new screencast.
    if (streaming) {
      streaming = false;
      void page.screencast
        .stop()
        .catch(() => undefined)
        .then(() => {
          lastFrameHash = "";
          stream();
        });
    } else {
      lastFrameHash = "";
      stream();
    }
    settleSoon();
  };
  cast.stop = () => {
    stopped = true;
    clearInterval(timer);
    if (settleTimer) clearTimeout(settleTimer);
    if (gapTimer) clearTimeout(gapTimer);
    if (streaming) void page.screencast.stop().catch(() => undefined);
    streaming = false;
  };
  return cast;
}

/** Watch one page's frames. Returns the function that stops watching. */
function watchFrames(page: Page, listener: FrameListener): () => void {
  let cast = casts.get(page);
  if (!cast) {
    cast = startCast(page);
    casts.set(page, cast);
  } else if (cast.last) {
    // A second window joins mid-stream: what is on screen now, without waiting for a change.
    listener(cast.last);
  }
  cast.listeners.add(listener);
  const mine = cast;
  return () => {
    mine.listeners.delete(listener);
    if (mine.listeners.size === 0 && casts.get(page) === mine) {
      casts.delete(page);
      mine.stop();
    }
  };
}

/** Watchers per session, so the last one to leave puts the pages' sizes back. */
const watchers = new Map<string, number>();

/**
 * Watch a session's browser: its tabs whenever they change, and frames of the
 * one on screen. The view follows the agent: when a page becomes the one its
 * owner acts on (a popup, a new `browser_open`, the person's own choice), the
 * view moves to it. Returns the function that stops watching.
 */
export function watchLiveBrowser(
  sessionId: string,
  on: { state: (s: LiveState) => void; frame: (f: LiveFrame) => void },
): () => void {
  let stopped = false;
  let viewing: Page | null = null;
  let unwatch: (() => void) | null = null;
  let lastState = "";
  const lastActive = new Map<string, Page | null>();
  watchers.set(sessionId, (watchers.get(sessionId) ?? 0) + 1);

  const view = (page: Page | null): void => {
    if (page === viewing) return;
    unwatch?.();
    unwatch = null;
    viewing = page;
    if (!page || stopped) return;
    unwatch = watchFrames(page, (f) => {
      if (!stopped && viewing === page) on.frame(f);
    });
  };

  const poll = async (): Promise<void> => {
    if (stopped) return;
    const pages = allPages(sessionId);
    for (const s of browserSessionsOf(sessionId)) touchBrowserSession(s.key);

    // Follow the agent: a page that just became its owner's active one goes on screen.
    let follow: Page | null = null;
    for (const p of pages) {
      if (!p.active) continue;
      if (lastActive.get(p.key) !== p.page) follow = p.page;
      lastActive.set(p.key, p.page);
    }
    const stillOpen = viewing && pages.some((p) => p.page === viewing);
    const next = follow ?? (stillOpen ? viewing : (pages.find((p) => p.active && p.owner === "agent") ?? pages.find((p) => p.active) ?? pages[0])?.page ?? null);
    if (next !== viewing) view(next);

    const tabs: LiveTab[] = await Promise.all(
      pages.map(async (p) => {
        const url = p.page.url();
        const home = isNewTabPage(url);
        return {
          id: idOf(p.page),
          url: home ? "" : url,
          title: home ? "New tab" : await p.page.title().catch(() => ""),
          active: p.active,
          owner: p.owner,
        };
      }),
    );
    const state: LiveState = { tabs, viewing: viewing ? idOf(viewing) : null };
    const text = JSON.stringify(state);
    if (text !== lastState && !stopped) {
      lastState = text;
      on.state(state);
    }
  };

  const timer = setInterval(() => void poll().catch(() => undefined), 400);
  timer.unref?.();
  void poll().catch(() => undefined);

  return () => {
    if (stopped) return;
    stopped = true;
    clearInterval(timer);
    unwatch?.();
    const left = (watchers.get(sessionId) ?? 1) - 1;
    if (left > 0) {
      watchers.set(sessionId, left);
    } else {
      watchers.delete(sessionId);
      unfit(sessionId);
    }
  };
}
