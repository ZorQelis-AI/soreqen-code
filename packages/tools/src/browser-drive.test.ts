/**
 * The browser tools against a real page.
 *
 * Playwright is a real dependency here and these drive a real Chromium, so
 * they skip themselves when it is not installed rather than failing a suite on
 * a machine that never asked for a browser.
 *
 * The page is served from a `data:` URL: no fixture files, no server to start,
 * and the markup under test is visible in the test that asserts against it.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Browser, Page } from "playwright";
import { renderSnapshot } from "./browser-page.js";
import { drivePage, rememberSnapshot, snapshotPage } from "./browser-drive.js";

const PAGE = `
<!doctype html><html><body style="font-family:sans-serif">
  <h1>Sign in</h1>
  <label for="email">Email address</label>
  <input id="email" type="email" placeholder="you@example.com">
  <label>Password <input id="pw" type="password"></label>
  <label><input id="remember" type="checkbox"> Remember me</label>
  <select id="plan"><option value="free">Free</option><option value="pro">Pro</option></select>
  <button id="go" type="button">Sign in</button>
  <a href="#help">Forgot password?</a>
  <button id="hidden" style="display:none">Invisible</button>
  <div id="result"></div>
  <div style="height:2400px"></div>
  <button id="bottom" type="button">At the bottom</button>
  <script>
    // Listens for keystrokes, not for a value being assigned — the thing
    // Playwright's fill() is invisible to.
    let keys = 0;
    document.getElementById('email').addEventListener('keyup', () => { keys++; });
    document.getElementById('go').addEventListener('click', () => {
      document.getElementById('result').textContent = 'Signed in as ' +
        document.getElementById('email').value + ' (' + keys + ' keystrokes)';
    });
  </script>
</body></html>`;

let chromium: typeof import("playwright").chromium | null = null;
try {
  ({ chromium } = await import("playwright"));
} catch {
  chromium = null;
}

const canRun = chromium !== null;
const maybe = canRun ? describe : describe.skip;

maybe("driving a real page", () => {
  let browser: Browser;
  let page: Page;

  beforeAll(async () => {
    browser = await chromium!.launch({ headless: true });
    page = await browser.newPage();
    await page.goto(`data:text/html,${encodeURIComponent(PAGE)}`);
  }, 120_000);

  afterAll(async () => {
    await browser?.close().catch(() => undefined);
  }, 60_000);

  const refresh = async (): Promise<void> => {
    rememberSnapshot(page, await snapshotPage(page));
  };

  it("lists every interactive element with the name a person would use", async () => {
    const snapshot = await snapshotPage(page);
    rememberSnapshot(page, snapshot);

    const named = snapshot.elements.map((e) => `${e.role}:${e.name}`);
    expect(named).toContain("textbox:Email address");
    expect(named).toContain("button:Sign in");
    expect(named).toContain("link:Forgot password?");
    expect(named.some((n) => n.startsWith("checkbox:"))).toBe(true);
    expect(named.some((n) => n.startsWith("combobox:"))).toBe(true);

    // A hidden control is not something a person can interact with.
    expect(named).not.toContain("button:Invisible");

    // And every element is numbered, which is the whole point.
    expect(snapshot.elements.map((e) => e.ref)).toEqual(
      snapshot.elements.map((_, i) => i + 1),
    );
  }, 30_000);

  it("renders the snapshot as something a model can read", async () => {
    const snapshot = await snapshotPage(page);
    const text = renderSnapshot(snapshot);
    expect(text).toContain("Interactive elements (use the number as `ref`):");
    expect(text).toMatch(/\[\d+\] textbox\s+"Email address"\s+\(empty\)/);
    expect(text).toContain("Sign in");
  }, 30_000);

  it("types with real keystrokes, so a component listening for them sees it", async () => {
    await refresh();
    const snapshot = await snapshotPage(page);
    const email = snapshot.elements.find((e) => e.name === "Email address")!;

    const typed = await drivePage(page, {
      action: "type",
      ref: email.ref,
      value: "ved@example.com",
    });
    expect(typed.success).toBe(true);

    await refresh();
    const clicked = await drivePage(page, { action: "click", text: "Sign in" });
    expect(clicked.success).toBe(true);

    /*
     * The keystroke count is the assertion that matters. `fill()` sets the
     * value and fires one `input` event; this page counts `keyup`, as an
     * autocomplete or a debounced search box does. A count of 15 means the
     * field was genuinely typed into.
     */
    const result = await page.textContent("#result");
    expect(result).toContain("ved@example.com");
    expect(result).toMatch(/\(1[0-9] keystrokes\)/);
  }, 60_000);

  it("checks a checkbox and selects an option by its label", async () => {
    await refresh();
    const checked = await drivePage(page, { action: "check", selector: "#remember" });
    expect(checked.success).toBe(true);
    expect(await page.isChecked("#remember")).toBe(true);

    const selected = await drivePage(page, { action: "select_option", selector: "#plan", value: "Pro" });
    expect(selected.success).toBe(true);
    expect(await page.inputValue("#plan")).toBe("pro");
  }, 45_000);

  it("scrolls in both directions, and says when it is already at the end", async () => {
    await drivePage(page, { action: "scroll", direction: "top" });
    const down = await drivePage(page, { action: "scroll", direction: "bottom" });
    expect(down.success).toBe(true);
    expect(await page.evaluate(() => window.scrollY)).toBeGreaterThan(100);

    const again = await drivePage(page, { action: "scroll", direction: "bottom" });
    expect(again.result).toContain("Already at the bottom");

    const up = await drivePage(page, { action: "scroll", direction: "top" });
    expect(up.success).toBe(true);
    expect(await page.evaluate(() => window.scrollY)).toBe(0);
  }, 45_000);

  it("scrolls a referenced element into view", async () => {
    await drivePage(page, { action: "scroll", direction: "top" });
    await refresh();
    const snapshot = await snapshotPage(page);
    const bottom = snapshot.elements.find((e) => e.name === "At the bottom")!;

    const scrolled = await drivePage(page, { action: "scroll", direction: "element", ref: bottom.ref });
    expect(scrolled.success).toBe(true);
    expect(await page.evaluate(() => window.scrollY)).toBeGreaterThan(100);
  }, 45_000);

  it("says what is on the page when it cannot find what was asked for", async () => {
    await refresh();
    const missing = await drivePage(page, { action: "click", text: "Definitely Not Here" });

    expect(missing.success).toBe(false);
    /*
     * The whole reason this rewrite exists. A Playwright timeout names the
     * selector and nothing else, so the agent guesses again. This names what
     * *is* there, which is the only thing that changes the next action.
     */
    expect(missing.error).toContain("Definitely Not Here");
    expect(missing.error).toContain("What is actually on the page");
    expect(missing.error).toContain("Sign in");
    expect(missing.error).toContain("Use one of these numbers as `ref`");
  }, 45_000);

  it("returns a fresh view of the page after every action", async () => {
    await refresh();
    const acted = await drivePage(page, { action: "hover", text: "Sign in" });
    expect(acted.success).toBe(true);
    expect(acted.snapshot).toContain("Interactive elements");
  }, 45_000);

  it("tells a stale ref apart from a missing element", async () => {
    await refresh();
    const stale = await drivePage(page, { action: "click", ref: 9_999 });
    expect(stale.success).toBe(false);
    expect(stale.error).toContain("does not have that many elements");
  }, 30_000);

  it("waits for text rather than asserting against the page being replaced", async () => {
    await page.evaluate(() => {
      const div = document.getElementById("result")!;
      div.textContent = "";
      setTimeout(() => {
        div.textContent = "Loaded late";
      }, 600);
    });

    const waited = await drivePage(page, { action: "wait_for", until: "text", text: "Loaded late" });
    expect(waited.success).toBe(true);
    expect(await page.textContent("#result")).toContain("Loaded late");
  }, 30_000);
});
