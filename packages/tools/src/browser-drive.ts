/**
 * Driving the page: the hands to `browser-page.ts`'s eyes.
 *
 * ## What was wrong with the old `browser_interact`
 *
 * Six actions, all of them addressed by a CSS selector the agent had to
 * invent, every failure reported as `Timeout 5000ms exceeded`:
 *
 *   - **`scroll` scrolled down 500 pixels.** Not up, not to an element, not to
 *     the bottom. A long page could not be read and an element below the fold
 *     could not be reached.
 *   - **Nothing could wait.** A click that starts a route change was followed
 *     immediately by an assertion against the page that was being replaced, so
 *     a working app looked broken roughly half the time.
 *   - **`type` used `fill`**, which sets `value` and fires one `input` event.
 *     Components that listen for keystrokes — an autocomplete, a search box
 *     that debounces `keyup` — saw nothing, so typing into them did nothing
 *     visible and the agent concluded the field was broken.
 *   - **No way back.** No `go_back`, no `reload`; a wrong click ended the run.
 *   - **`evaluate_js` was the escape hatch**, and an agent that cannot click
 *     reliably reaches for it constantly — which is how a testing tool becomes
 *     an arbitrary-execution tool.
 *
 * ## The shape now
 *
 * One action per thing a person does, each addressable three ways — by `ref`
 * from a snapshot, by `text` (the visible name), or by `selector` for the
 * cases where the agent genuinely knows one. Every action waits for the page
 * to settle before it reports, and every failure names what *is* on the page.
 */

import { promises as fs } from "node:fs";
import path from "node:path";
import type { Page } from "playwright";

/**
 * Pages whose size the agent chose (a phone, a desktop width). The browser
 * panel does not fit these to itself; it shows them as they are.
 */
export const chosenViewports = new WeakSet<Page>();
import {
  MAX_ELEMENTS,
  MAX_PAGE_TEXT,
  notFoundMessage,
  snapshotExpression,
  renderSnapshot,
  type PageElement,
  type PageSnapshot,
} from "./browser-page.js";

/**
 * How long an action waits for its element.
 *
 * Five seconds was the old value and it is too short for a cold dev server's
 * first render; thirty is long enough to be a real answer and short enough
 * that a genuinely missing element does not cost the turn a minute.
 */
const ACTION_TIMEOUT_MS = 15_000;
/**
 * How long an element is waited for to accept a click, a check or typing
 * before asking why not. The element exists by then (`locate` found it), so
 * a long wait only ever meant something covered it: 15 seconds, then a
 * failure and a guess, was most of an outreach session's 73 failed browser
 * steps (18 Oct 2026). Now the wait is short, and the reason is looked up and
 * worked around (`whyNot`, `forceAct`).
 */
const ACT_WAIT_MS = 4_000;
/** How long the page is given to go quiet after an action that changes it. */
const SETTLE_MS = 1_500;
/** Up to this many characters are typed key by key; past it, all but the end are filled at once. */
const TYPE_KEYS_MAX = 200;
/** The end of a long text, typed key by key so keystroke listeners still hear it. */
const TYPE_TAIL = 12;

export type BrowserAction =
  | "click"
  | "double_click"
  | "type"
  | "clear"
  | "press_key"
  | "select_option"
  | "check"
  | "uncheck"
  | "hover"
  | "scroll"
  | "wait_for"
  | "go_back"
  | "go_forward"
  | "reload"
  | "upload"
  | "resize";

export interface DriveInput {
  action: BrowserAction;
  /** A number from the last `browser_snapshot`. */
  ref?: number;
  /** The visible name of the element, when there is no ref. */
  text?: string;
  /** A CSS selector, for when the agent genuinely knows one. */
  selector?: string;
  /** What to type, or the option to select. */
  value?: string;
  /** A key name: `Enter`, `Tab`, `ArrowDown`, `Escape`. */
  key?: string;
  /** For `type`: press Enter afterwards. */
  submit?: boolean;
  /** For `scroll`: `down` (default), `up`, `top`, `bottom`, or `element`. */
  direction?: "down" | "up" | "top" | "bottom" | "element";
  /** For `scroll`: how far, in pixels. Default one viewport. */
  amount?: number;
  /** For `wait_for`: `text`, `selector`, `navigation`, or `idle`. */
  until?: "text" | "selector" | "navigation" | "idle";
  /** Milliseconds, for `wait_for`. */
  timeout_ms?: number;
  /** For `upload`: workspace paths. */
  files?: string[];
  /** For `resize`. */
  width?: number;
  height?: number;
  device?: "mobile" | "tablet" | "desktop";
}

/** Viewports for `resize` by name — a phone, a tablet, a laptop. */
export const DEVICE_VIEWPORTS = {
  mobile: { width: 390, height: 844 },
  tablet: { width: 820, height: 1180 },
  desktop: { width: 1280, height: 800 },
} as const;

/** What a drive may need to know about where it runs. */
export interface DriveContext {
  /** The workspace root, so an upload can only send the workspace's own files. */
  workspaceRoot?: string | null;
}

export interface DriveResult {
  success: boolean;
  action: string;
  result: string;
  error?: string;
  /** The page after the action, so the agent sees what changed without a
   *  second call. */
  snapshot?: string;
}

/**
 * The files an upload may send: inside the workspace, and there.
 *
 * The same confinement as `browser_open`'s file targets — without it, an
 * upload is a way to hand any file on the host to whatever page is open.
 * Returns an explanation instead when a path is not allowed.
 */
async function uploadPaths(files: string[], root: string | null): Promise<string[] | string> {
  if (files.length === 0) return "`upload` needs `files`: workspace paths of the files to attach.";
  if (!root) return "Uploads need a workspace, and this browser session has none.";
  const base = await fs.realpath(root).catch(() => path.resolve(root));
  const out: string[] = [];
  for (const file of files) {
    const resolved = await fs.realpath(path.resolve(base, file)).catch(() => null);
    if (!resolved) return `There is no file at '${file}' in the workspace.`;
    const rel = path.relative(base, resolved);
    if (rel.startsWith("..") || path.isAbsolute(rel)) return `Refusing to upload '${file}': it is outside the workspace.`;
    out.push(resolved);
  }
  return out;
}

/** Read the page. Exported because every other entry point needs it too. */
export async function snapshotPage(page: Page): Promise<PageSnapshot> {
  return (await page.evaluate(
    snapshotExpression({ maxElements: MAX_ELEMENTS, maxText: MAX_PAGE_TEXT }),
  )) as PageSnapshot;
}

/** The last snapshot taken for a page, so a `ref` means something. */
const lastSnapshot = new WeakMap<Page, PageSnapshot>();

export function rememberSnapshot(page: Page, snapshot: PageSnapshot): void {
  lastSnapshot.set(page, snapshot);
}

export function recallSnapshot(page: Page): PageSnapshot | null {
  return lastSnapshot.get(page) ?? null;
}

/**
 * Find the element an action is about.
 *
 * A `ref` is resolved through the selectors its snapshot recorded, tried best
 * first, then by role and accessible name. That last fallback is what makes a
 * ref survive a re-render that moved the element: the DOM path is gone, the
 * name is not.
 */
type Located = { ok: true; selector: string; frame?: string; note?: string } | { ok: false; what: string };

/** The element a located selector names, in its iframe when it has one. */
function targetOf(page: Page, found: { selector: string; frame?: string }) {
  return (found.frame ? page.frameLocator(found.frame) : page).locator(found.selector).first();
}

/**
 * The one element a guessed selector most likely meant.
 *
 * `#country`, `#company_type`, `#industry`: an id a form usually has, and
 * this form did not, so each guess failed and the next guess followed (18 Oct
 * 2026). The word in it is tried as a name, an id, a placeholder or a label,
 * and used only when exactly one visible element answers.
 */
async function nearSelector(page: Page, selector: string): Promise<string | null> {
  const word = /^(?:[a-z]+)?[#]([\w-]+)$/i.exec(selector.trim())?.[1] ?? /\[(?:name|id)\s*[*^$]?=\s*["']?([\w-]+)["']?\]/i.exec(selector)?.[1];
  if (!word || word.length < 3) return null;
  const w = word.replace(/"/g, "");
  for (const candidate of [`[name="${w}" i]`, `[id="${w}" i]`, `[name*="${w}" i]`, `[id*="${w}" i]`, `[placeholder*="${w}" i]`, `[aria-label*="${w}" i]`]) {
    const all = page.locator(candidate);
    const count = await all.count().catch(() => 0);
    if (count === 0 || count > 6) continue;
    const visible: number[] = [];
    for (let i = 0; i < count; i++) if (await all.nth(i).isVisible().catch(() => false)) visible.push(i);
    if (visible.length === 1) return count === 1 ? candidate : `${candidate} >> nth=${visible[0]}`;
  }
  // As a label: "company_type" is the field labelled "Company type".
  const byLabel = await locateByName(page, w.replace(/[-_]+/g, " "));
  return byLabel && !byLabel.frame ? byLabel.selector : null;
}

async function locate(page: Page, input: DriveInput): Promise<Located> {
  if (input.selector) {
    const count = await page.locator(input.selector).count().catch(() => 0);
    if (count > 0) return { ok: true, selector: input.selector };
    const near = await nearSelector(page, input.selector);
    if (near) return { ok: true, selector: near, note: `Nothing matches '${input.selector}', so ${near} was used.` };
    return { ok: false, what: `anything matching the selector '${input.selector}'` };
  }

  if (typeof input.ref === "number") {
    const snapshot = recallSnapshot(page);
    const element = snapshot?.elements.find((e) => e.ref === input.ref);
    if (!element) {
      return {
        ok: false,
        what: `element [${input.ref}] — no snapshot has been taken of this page, or it does not have that many elements`,
      };
    }
    /*
     * A selector that names exactly one element, first.
     *
     * One that matches several is a guess: `.first()` then acts on whichever
     * comes first in the document — which is how a click on a button inside
     * a web component landed on a different button entirely. Several matches
     * fall back to the element's role and name, and only then to the first.
     */
    const scope = element.frame ? page.frameLocator(element.frame) : page;
    const inFrame = element.frame ? { frame: element.frame } : {};
    let ambiguous: string | null = null;
    for (const selector of element.selectors) {
      const count = await scope.locator(selector).count().catch(() => 0);
      if (count === 1) return { ok: true, selector, ...inFrame };
      if (count > 1 && !ambiguous) ambiguous = selector;
    }
    const byName = await locateByName(page, element.name, element.role);
    if (byName) return { ok: true, ...byName };
    if (ambiguous) return { ok: true, selector: ambiguous, ...inFrame };
    return {
      ok: false,
      what: `element [${input.ref}] ("${element.name}") — the page has changed since the snapshot`,
    };
  }

  if (input.text) {
    const byName = await locateByName(page, input.text);
    if (byName) return { ok: true, ...byName };
    return { ok: false, what: `anything named "${input.text}"` };
  }

  return { ok: false, what: "an element — give a `ref` from a snapshot, a `text`, or a `selector`" };
}

/**
 * An element by its visible name.
 *
 * Exact first, then a prefix, because "Sign in" should not match "Sign in with
 * Google" when both are on the page — and should match it when it is the only
 * thing there.
 */
async function locateByName(page: Page, name: string, role?: string): Promise<{ selector: string; frame?: string } | null> {
  const snapshot = await snapshotPage(page).catch(() => null);
  if (!snapshot) return null;

  const wanted = name.trim().toLowerCase();
  if (!wanted) return null;
  const matches = (el: PageElement, exact: boolean): boolean => {
    if (role && el.role !== role) return false;
    const candidate = el.name.trim().toLowerCase();
    return exact ? candidate === wanted : candidate.includes(wanted);
  };

  for (const exact of [true, false]) {
    const found = snapshot.elements.find((el) => matches(el, exact));
    if (found) {
      // Inside its iframe when it is in one: a name found there was looked up on the top page and missed.
      const scope = found.frame ? page.frameLocator(found.frame) : page;
      for (const selector of found.selectors) {
        const count = await scope.locator(selector).count().catch(() => 0);
        if (count > 0) return { selector, ...(found.frame ? { frame: found.frame } : {}) };
      }
    }
  }
  return null;
}

/**
 * Why an element would not take an action, in words the next step can use:
 * covered by a dialog or a banner (named), disabled, or not shown at all.
 */
interface Obstacle {
  disabled: boolean;
  hidden: boolean;
  /** What is on top of it, described. */
  coveredBy?: string;
}

async function whyNot(target: ReturnType<typeof targetOf>): Promise<Obstacle | null> {
  return target
    .evaluate((el: Element) => {
      const html = el as HTMLElement & { disabled?: boolean };
      const style = getComputedStyle(html);
      const box = html.getBoundingClientRect();
      const hidden = box.width < 2 || box.height < 2 || style.visibility === "hidden" || style.display === "none" || Number(style.opacity) === 0;
      const disabled = html.disabled === true || html.getAttribute("aria-disabled") === "true";
      let coveredBy: string | undefined;
      if (!hidden) {
        html.scrollIntoView({ block: "center", inline: "center" });
        const r = html.getBoundingClientRect();
        const top = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
        if (top && top !== html && !html.contains(top) && !top.contains(html)) {
          // The thing a person would name: the dialog, banner or popup the top element belongs to.
          let node: Element | null = top;
          let named: Element = top;
          for (let depth = 0; node && depth < 12; depth++, node = node.parentElement) {
            const cls = typeof node.className === "string" ? node.className : "";
            const fixed = getComputedStyle(node).position === "fixed";
            if (node.getAttribute("role") === "dialog" || node.getAttribute("aria-modal") === "true" || /modal|dialog|popup|overlay|cookie|consent|banner|survey|mask/i.test(cls) || fixed) {
              named = node;
              break;
            }
          }
          const label = named.getAttribute("aria-label") || (named as HTMLElement).innerText || "";
          const cls = typeof named.className === "string" ? named.className.trim().split(/\s+/).slice(0, 2).join(".") : "";
          coveredBy = `${named.tagName.toLowerCase()}${named.id ? `#${named.id}` : ""}${cls ? `.${cls}` : ""}${label.trim() ? ` ("${label.replace(/\s+/g, " ").trim().slice(0, 80)}")` : ""}`;
        }
      }
      return { disabled, hidden, ...(coveredBy ? { coveredBy } : {}) };
    })
    .catch(() => null);
}

/**
 * Do it without the pointer: the element's own click (or its label's, for a
 * box drawn over a hidden checkbox). What a person does by closing the popup
 * first, done for them; said in the result, so nothing is hidden from the agent.
 */
async function forceAct(target: ReturnType<typeof targetOf>, action: "click" | "double_click" | "check" | "uncheck"): Promise<boolean> {
  return target
    .evaluate((el: Element, want: string) => {
      const input = el as HTMLInputElement;
      const box = input.type === "checkbox" || input.type === "radio";
      if ((want === "check" || want === "uncheck") && box && input.checked === (want === "check")) return true;
      const label = box ? (input.labels && input.labels[0]) || input.closest("label") : null;
      const clicker = (label ?? el) as HTMLElement;
      clicker.click();
      if (want === "double_click") el.dispatchEvent(new MouseEvent("dblclick", { bubbles: true, cancelable: true }));
      if ((want === "check" || want === "uncheck") && box) return input.checked === (want === "check");
      return true;
    }, action)
    .catch(() => false);
}

/** Playwright's timeout, as opposed to an error worth reporting as it is. */
function isTimeout(err: unknown): boolean {
  return /Timeout .* exceeded/i.test(err instanceof Error ? err.message : String(err));
}

/**
 * A click, double click, check or uncheck: as a person would, and when the
 * element will not take it, the reason, then the way round it.
 */
async function act(
  target: ReturnType<typeof targetOf>,
  action: "click" | "double_click" | "check" | "uncheck",
  timeout: number,
): Promise<{ ok: true; how?: string } | { ok: false; error: string }> {
  try {
    if (action === "click") await target.click({ timeout });
    else if (action === "double_click") await target.dblclick({ timeout });
    else if (action === "check") await target.check({ timeout });
    else await target.uncheck({ timeout });
    return { ok: true };
  } catch (err) {
    if (!isTimeout(err) && !/did not change its state|not checked|intercepts pointer events|not visible/i.test(String(err))) throw err;
  }
  const obstacle = await whyNot(target);
  if (obstacle?.disabled) return { ok: false, error: "The element is disabled: something on the page has to be done first (a required field, an earlier step)." };
  if (await forceAct(target, action)) {
    const why = obstacle?.coveredBy
      ? `it was covered by ${obstacle.coveredBy}, which is still open`
      : obstacle?.hidden
        ? "it is not drawn on the page itself (a styled control over a hidden one)"
        : "it would not take the pointer";
    return { ok: true, how: `Done directly on the element: ${why}.` };
  }
  return {
    ok: false,
    error: obstacle?.coveredBy
      ? `It is covered by ${obstacle.coveredBy}. Close or answer that first (its close button, or press_key Escape).`
      : `'${action}' did not take effect. Take a browser_snapshot to see the current state.`,
  };
}

/** A visible option of an open dropdown, by its text. */
async function visibleOption(page: Page, text: string): Promise<ReturnType<Page["locator"]> | null> {
  const exact = new RegExp(`^\\s*${text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*$`, "i");
  const tries = [
    page.getByRole("option", { name: text, exact: true }),
    page.getByRole("menuitem", { name: text, exact: true }),
    page.getByRole("option", { name: text }),
    page.locator("li, [role=option], [role=menuitem], [class*=option], [class*=item]").filter({ hasText: exact }),
    page.getByText(text, { exact: true }),
  ];
  for (const all of tries) {
    const count = Math.min(await all.count().catch(() => 0), 12);
    for (let i = 0; i < count; i++) {
      const one = all.nth(i);
      if (await one.isVisible().catch(() => false)) return one;
    }
  }
  return null;
}

/** The options a dropdown is showing, to name when the one asked for is not there. */
async function shownOptions(page: Page): Promise<string[]> {
  const all = page.getByRole("option");
  const count = Math.min(await all.count().catch(() => 0), 40);
  const out: string[] = [];
  for (let i = 0; i < count && out.length < 15; i++) {
    const one = all.nth(i);
    if (!(await one.isVisible().catch(() => false))) continue;
    const text = ((await one.innerText().catch(() => "")) || "").replace(/\s+/g, " ").trim();
    if (text) out.push(text.slice(0, 60));
  }
  return out;
}

/**
 * Let the page finish reacting.
 *
 * Never throws: a page with a long-poll or an animation frame loop never
 * reaches `networkidle`, and a click that worked must not be reported as a
 * failure because the page is busy doing something else.
 */
async function settle(page: Page): Promise<void> {
  await page.waitForLoadState("networkidle", { timeout: SETTLE_MS }).catch(() => undefined);
}

/** The page after an action, rendered for the model. */
async function after(page: Page): Promise<string | undefined> {
  try {
    const snapshot = await snapshotPage(page);
    rememberSnapshot(page, snapshot);
    return renderSnapshot(snapshot);
  } catch {
    return undefined;
  }
}

export async function drivePage(page: Page, input: DriveInput, context: DriveContext = {}): Promise<DriveResult> {
  const action = input.action;
  const timeout = input.timeout_ms ?? ACTION_TIMEOUT_MS;

  const fail = async (error: string, withPage = true): Promise<DriveResult> => ({
    success: false,
    action,
    result: "",
    error,
    ...(withPage ? { snapshot: await after(page) } : {}),
  });

  const done = async (result: string): Promise<DriveResult> => {
    await settle(page);
    return { success: true, action, result, snapshot: await after(page) };
  };

  try {
    switch (action) {
      /* ---- navigation, which is the thing that had no actions at all ---- */
      case "go_back": {
        const response = await page.goBack({ timeout });
        if (!response) return fail("There is nothing to go back to.");
        return done(`Went back to ${page.url()}.`);
      }
      case "go_forward": {
        const response = await page.goForward({ timeout });
        if (!response) return fail("There is nothing to go forward to.");
        return done(`Went forward to ${page.url()}.`);
      }
      case "reload": {
        await page.reload({ timeout });
        return done(`Reloaded ${page.url()}.`);
      }

      /* ---- the viewport, for checking a layout at another size ---------- */
      case "resize": {
        const preset = input.device ? DEVICE_VIEWPORTS[input.device] : null;
        const width = input.width ?? preset?.width;
        const height = input.height ?? preset?.height;
        if (!width || !height) return fail("`resize` needs `width` and `height`, or a `device`.", false);
        await page.setViewportSize({ width, height });
        chosenViewports.add(page);
        /*
         * The page hears about it later. The `resize` event and the layout
         * after it land a frame or two after this returns, so a snapshot
         * taken straight away showed the page as it was at the old size —
         * and a responsive bug looked like no bug.
         */
        await page.waitForFunction((w) => window.innerWidth === w, width, { timeout: 2_000 }).catch(() => undefined);
        await page
          .evaluate(() => new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r()))))
          .catch(() => undefined);
        return done(`The viewport is now ${width}×${height}${input.device ? ` (${input.device})` : ""}.`);
      }

      /* ---- waiting, which is how a click and its consequence are joined -- */
      case "wait_for": {
        const until = input.until ?? (input.text ? "text" : input.selector ? "selector" : "idle");
        /*
         * A wait that runs out is an answer, not a broken element: the thing
         * did not appear. It was reported as "the element was found but
         * 'wait_for' did not complete", which sent the agent hunting for an
         * element that was never the problem (18 Oct 2026).
         */
        const appeared = async (what: string, wait: Promise<unknown>): Promise<DriveResult> => {
          try {
            await wait;
            return done(`${what} appeared.`);
          } catch (err) {
            if (!isTimeout(err)) throw err;
            return fail(`${what} did not appear within ${Math.round(timeout / 1000)}s. The page as it is now is below.`);
          }
        };
        if (until === "text") {
          if (!input.text) return fail("`wait_for` with `until: text` needs the `text` to wait for.", false);
          return appeared(`"${input.text}"`, page.getByText(input.text, { exact: false }).first().waitFor({ state: "visible", timeout }));
        }
        if (until === "selector") {
          if (!input.selector) return fail("`wait_for` with `until: selector` needs a `selector`.", false);
          return appeared(`'${input.selector}'`, page.locator(input.selector).first().waitFor({ state: "visible", timeout }));
        }
        if (until === "navigation") {
          const loaded = await page.waitForLoadState("load", { timeout }).then(() => true, () => false);
          return done(loaded ? `The page finished loading: ${page.url()}.` : `${page.url()} is still loading after ${Math.round(timeout / 1000)}s; what has arrived is below.`);
        }
        /*
         * Never a failure. Analytics, chat widgets and live updates keep a
         * page's network busy for as long as it is open, and a wait for
         * silence on such a page failed every time while the page was ready.
         */
        const quiet = await page.waitForLoadState("networkidle", { timeout: Math.min(timeout, 8_000) }).then(() => true, () => false);
        return done(quiet ? "The page went quiet." : "The page is ready; it keeps loading things in the background (analytics, widgets), which is normal.");
      }

      /* ---- scrolling, which used to be 500 pixels downward and nothing --- */
      case "scroll": {
        const direction = input.direction ?? "down";
        if (direction === "element") {
          const found = await locate(page, input);
          if (!found.ok) return fail(notFoundMessage(found.what, recallSnapshot(page)));
          await targetOf(page, found).scrollIntoViewIfNeeded({ timeout });
          return done("Scrolled it into view.");
        }
        const moved = await page.evaluate(
          ({ dir, amount }: { dir: string; amount?: number }) => {
            const before = window.scrollY;
            const step = amount ?? window.innerHeight * 0.85;
            if (dir === "top") window.scrollTo(0, 0);
            else if (dir === "bottom") window.scrollTo(0, document.body.scrollHeight);
            else window.scrollBy(0, dir === "up" ? -step : step);
            return { before, after: window.scrollY, height: document.body.scrollHeight };
          },
          { dir: direction, ...(input.amount !== undefined ? { amount: input.amount } : {}) },
        );
        const atEnd = moved.before === moved.after;
        return done(
          atEnd
            ? `Already at the ${direction === "up" || direction === "top" ? "top" : "bottom"} of the page.`
            : `Scrolled to ${Math.round(moved.after)}px of ${Math.round(moved.height)}px.`,
        );
      }

      case "press_key": {
        if (!input.key) return fail("`press_key` needs a `key`, such as Enter, Tab or Escape.", false);
        if (input.ref !== undefined || input.text || input.selector) {
          const found = await locate(page, input);
          if (!found.ok) return fail(notFoundMessage(found.what, recallSnapshot(page)));
          await targetOf(page, found).press(input.key, { timeout });
        } else {
          await page.keyboard.press(input.key);
        }
        return done(`Pressed ${input.key}.`);
      }

      default:
        break;
    }

    /* ---- everything below needs an element ----------------------------- */
    const found = await locate(page, input);
    if (!found.ok) return fail(notFoundMessage(found.what, recallSnapshot(page)));
    const target = targetOf(page, found);
    // An element found by a looser route than asked says so, so the agent learns the page.
    const said = (text: string): string => (found.note ? `${found.note} ${text}` : text);
    const wait = Math.min(timeout, ACT_WAIT_MS);

    switch (action) {
      case "click":
      case "double_click":
      case "check":
      case "uncheck": {
        const outcome = await act(target, action, wait);
        if (!outcome.ok) return fail(outcome.error);
        const what = action === "click" ? "Clicked it." : action === "double_click" ? "Double-clicked it." : action === "check" ? "Checked it." : "Unchecked it.";
        return done(said(outcome.how ? `${what} ${outcome.how}` : what));
      }

      case "hover":
        await target.hover({ timeout: wait });
        return done(said("Hovered over it."));

      case "clear":
        await target.fill("", { timeout: wait }).catch(async (err: unknown) => {
          if (!isTimeout(err)) throw err;
          await target.fill("", { timeout: wait, force: true });
        });
        return done(said("Cleared it."));

      case "type": {
        /*
         * Cleared, then typed key by key, so anything listening for
         * keystrokes (an autocomplete, a search box that debounces `keyup`,
         * per-character validation) hears them. `fill` alone fires one
         * `input` event, and those components saw nothing.
         *
         * A long text is filled up to its last few characters and only those
         * are typed. Typed whole, at 12 ms a key under one 15-second limit, any
         * text past about 1,200 characters failed every time: the outreach
         * emails of 18 Oct 2026, retried and cut down by hand.
         */
        const value = input.value ?? "";
        const covered = await target.click({ timeout: wait }).then(
          () => false,
          (err: unknown) => isTimeout(err),
        );
        const force = covered ? { force: true } : {};
        await target.fill("", { timeout: wait, ...force }).catch(() => undefined);
        if (value.length > TYPE_KEYS_MAX) {
          await target.fill(value.slice(0, -TYPE_TAIL), { timeout: wait, ...force });
          await target.press("End", { timeout: wait }).catch(() => undefined);
          await target.pressSequentially(value.slice(-TYPE_TAIL), { delay: 12, timeout: wait + TYPE_TAIL * 40 });
        } else if (covered) {
          await target.fill(value, { timeout: wait, force: true });
        } else {
          await target.pressSequentially(value, { delay: 12, timeout: wait + value.length * 40 });
        }
        // A length limit or a format (a phone field dropping "+91") keeps less than it was given, silently.
        const kept = await target.inputValue({ timeout: 1_000 }).catch(() => null);
        const short =
          kept !== null && kept.length < value.replace(/\r/g, "").length
            ? ` The field now holds ${kept.length} of the ${value.length} characters typed` +
              `${kept.length <= 80 ? `: "${kept}"` : ""} (a length limit, or a format that drops some).`
            : "";
        const how = covered ? " It was covered by something, so its text was set directly." : "";
        if (input.submit) {
          await target.press("Enter", { timeout: wait });
          return done(said(`Typed it and pressed Enter.${how}${short}`));
        }
        return done(said(`Typed it.${how}${short}`));
      }

      case "select_option": {
        if (input.value === undefined) return fail("`select_option` needs the `value` to choose.", false);
        const value = input.value;
        const native = await target.evaluate((el: Element) => el.tagName === "SELECT").catch(() => false);
        if (native) {
          const chosen = await target.selectOption(value, { timeout: wait }).catch(async () => {
            // Fall back to matching the option's visible label.
            return target.selectOption({ label: value }, { timeout: wait });
          });
          return done(said(`Selected ${chosen.join(", ") || value}.`));
        }
        /*
         * A dropdown drawn by the page (a div, an input with role=combobox):
         * `selectOption` refuses anything but a <select>, which is most
         * dropdowns on modern forms. It is opened as a person opens it, and
         * the option clicked by its text; a searchable one is typed into.
         */
        const opened = await act(target, "click", wait);
        if (!opened.ok) return fail(opened.error);
        let option: Awaited<ReturnType<typeof visibleOption>> = null;
        for (let tries = 0; tries < 8 && !option; tries++) {
          option = await visibleOption(page, value);
          if (!option) await page.waitForTimeout(250);
        }
        if (!option) {
          const editable = await target.evaluate((el: Element) => el instanceof HTMLInputElement && !el.readOnly).catch(() => false);
          if (editable) {
            await target.pressSequentially(value, { delay: 12, timeout: wait + value.length * 40 }).catch(() => undefined);
            for (let tries = 0; tries < 6 && !option; tries++) {
              option = await visibleOption(page, value);
              if (!option) await page.waitForTimeout(250);
            }
          }
        }
        if (!option) {
          const options = await shownOptions(page);
          await page.keyboard.press("Escape").catch(() => undefined);
          return fail(
            `Opened the dropdown, but no option "${value}" appeared.` +
              (options.length ? ` Its options: ${options.map((o) => `"${o}"`).join(", ")}.` : " Take a browser_snapshot while it is open to see its options."),
          );
        }
        await option.click({ timeout: wait }).catch(async (err: unknown) => {
          if (!isTimeout(err)) throw err;
          await option!.evaluate((el: Element) => (el as HTMLElement).click());
        });
        return done(said(`Selected "${value}".`));
      }

      case "upload": {
        const files = await uploadPaths(input.files ?? [], context.workspaceRoot ?? null);
        if (typeof files === "string") return fail(files, false);
        await target.setInputFiles(files, { timeout });
        return done(said(`Attached ${files.length} file${files.length === 1 ? "" : "s"}.`));
      }

      default:
        return fail(`'${String(action)}' is not a browser action this tool performs.`, false);
    }
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    /*
     * A timeout means the element was found and would not cooperate — covered
     * by something, disabled, or still animating. Saying which is the
     * difference between a next action and another guess.
     */
    if (/Timeout .* exceeded/i.test(message)) {
      return fail(
        `The element was found but '${action}' did not complete in time. It may be ` +
          "covered by something, disabled, or still animating. The page as it is now is below.",
      );
    }
    return fail(`Browser action '${action}' failed: ${message}`);
  }
}
