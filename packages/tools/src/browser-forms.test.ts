/**
 * The form failures of 18 Oct 2026, each on a page built to fail the same way.
 *
 * An outreach session filled seventeen providers' contact forms and 73 of
 * its 548 browser steps failed: a long message that could never finish
 * typing, a survey popup over the submit button, an agreement box drawn over
 * a hidden checkbox, dropdowns that were not <select>s, ids that were not
 * there, and waits for "idle" on pages that never go quiet.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Browser, Page } from "playwright";
import { drivePage, rememberSnapshot, snapshotPage } from "./browser-drive.js";

const FORM = `
<!doctype html><html><body style="font-family:sans-serif">
  <textarea id="message" maxlength="5000" style="width:400px;height:80px"></textarea>
  <input name="country" placeholder="Country">
  <label class="agree" style="display:inline-flex;gap:6px;cursor:pointer">
    <span class="box" style="display:inline-block;width:14px;height:14px;border:1px solid #333"></span>
    <input id="terms" type="checkbox" style="position:absolute;opacity:0;width:0;height:0">
    I have read and agree to the terms
  </label>
  <div class="ant-select" role="combobox" tabindex="0" id="size" style="width:200px;border:1px solid #999;padding:4px">Company size</div>
  <ul id="menu" role="listbox" style="display:none">
    <li role="option">1-30</li><li role="option">31-200</li><li role="option">200+</li>
  </ul>
  <button id="send" type="button">Submit</button>
  <div id="survey" style="position:fixed;inset:0;background:rgba(0,0,0,.4)">
    <div role="dialog" aria-label="How satisfied are you?" style="background:#fff;margin:40px;padding:20px">How satisfied are you? <button id="close">Close</button></div>
  </div>
  <div id="result"></div>
  <script>
    document.getElementById('size').addEventListener('click', () => { document.getElementById('menu').style.display = 'block'; });
    for (const li of document.querySelectorAll('#menu li')) li.addEventListener('click', () => {
      document.getElementById('size').textContent = li.textContent;
      document.getElementById('menu').style.display = 'none';
    });
    document.getElementById('send').addEventListener('click', () => {
      document.getElementById('result').textContent = 'sent ' + document.getElementById('message').value.length +
        ' terms=' + document.getElementById('terms').checked + ' size=' + document.getElementById('size').textContent;
    });
  </script>
</body></html>`;

/**
 * A Chromium that starts here, found the way the browser tools find one:
 * Playwright's own, else the system's Chrome or Edge. CI runners have Chrome
 * but no Playwright download, and these tests failed there with "Executable
 * doesn't exist" instead of using it (16 Nov 2026). Skipped only where no
 * Chromium at all can start.
 */
async function startableChromium(): Promise<(() => Promise<Browser>) | null> {
  let pw: typeof import("playwright");
  try {
    pw = await import("playwright");
  } catch {
    return null;
  }
  for (const channel of [undefined, "chrome", "msedge"]) {
    const start = () => pw.chromium.launch({ headless: true, ...(channel ? { channel } : {}) });
    try {
      await (await start()).close();
      return start;
    } catch {
      // Not this one.
    }
  }
  return null;
}

const launch = await startableChromium();
const maybe = launch ? describe : describe.skip;

maybe("forms that used to defeat the browser tools", () => {
  let browser: Browser;
  let page: Page;

  beforeAll(async () => {
    browser = await launch!();
    page = await browser.newPage();
    await page.goto(`data:text/html,${encodeURIComponent(FORM)}`);
    rememberSnapshot(page, await snapshotPage(page));
  }, 120_000);

  afterAll(async () => {
    await browser?.close().catch(() => undefined);
  }, 60_000);

  it("types a 3,000-character message, which used to time out every time", async () => {
    const message = `Hello team,\n\n${"We are evaluating providers for SoreQen Code. ".repeat(65)}`.slice(0, 3_000);
    const started = Date.now();
    // Covered by the survey, so it is set directly, and said so.
    const typed = await drivePage(page, { action: "type", selector: "#message", value: message });
    expect(typed.success, typed.error).toBe(true);
    expect(Date.now() - started).toBeLessThan(15_000);
    expect(await page.locator("#message").inputValue()).toBe(message);
  }, 60_000);

  it("finds the field a guessed id meant", async () => {
    const typed = await drivePage(page, { action: "type", selector: "#country", value: "India" });
    expect(typed.success, typed.error).toBe(true);
    expect(typed.result).toMatch(/Nothing matches '#country', so \[name="country" i\] was used/);
    expect(await page.locator("[name=country]").inputValue()).toBe("India");
  }, 30_000);

  it("lists the agreement box drawn over a hidden checkbox, by its words, and ticks it", async () => {
    const snapshot = await snapshotPage(page);
    rememberSnapshot(page, snapshot);
    const box = snapshot.elements.find((e) => e.role === "checkbox");
    expect(box?.name).toMatch(/agree to the terms/);
    const checked = await drivePage(page, { action: "check", ref: box!.ref });
    expect(checked.success, checked.error).toBe(true);
    expect(await page.locator("#terms").isChecked()).toBe(true);
  }, 30_000);

  it("chooses from a dropdown that is not a <select>", async () => {
    const chosen = await drivePage(page, { action: "select_option", selector: "#size", value: "31-200" });
    expect(chosen.success, chosen.error).toBe(true);
    expect(await page.locator("#size").innerText()).toBe("31-200");
  }, 30_000);

  it("clicks the button under the survey, says what covered it, and does not take 15 seconds to", async () => {
    const started = Date.now();
    const sent = await drivePage(page, { action: "click", selector: "#send" });
    expect(sent.success, sent.error).toBe(true);
    expect(sent.result).toMatch(/covered by div.*How satisfied are you/);
    expect(Date.now() - started).toBeLessThan(12_000);
    expect(await page.locator("#result").innerText()).toBe("sent 3000 terms=true size=31-200");
  }, 30_000);

  it("waits for idle on a page that never goes quiet without failing", async () => {
    // Busy from the moment it loads, as the failing pages were: a poll every 100 ms, each answered after 200.
    const busy = await browser.newPage();
    await busy.route("https://poll.test/**", (route) => setTimeout(() => void route.fulfill({ body: "ok" }).catch(() => undefined), 200));
    await busy.goto(`data:text/html,${encodeURIComponent("<p>Busy</p><script>setInterval(() => fetch('https://poll.test/p', { mode: 'no-cors' }).catch(() => {}), 100)</script>")}`);
    const idle = await drivePage(busy, { action: "wait_for", until: "idle", timeout_ms: 3_000 });
    await busy.close();
    expect(idle.success, idle.error).toBe(true);
    expect(idle.result).toMatch(/ready/);
  }, 30_000);

  it("says a waited-for text did not appear, not that an element was found", async () => {
    const missing = await drivePage(page, { action: "wait_for", text: "Thank you for your message", timeout_ms: 1_500 });
    expect(missing.success).toBe(false);
    expect(missing.error).toMatch(/"Thank you for your message" did not appear within 2s/);
    expect(missing.error).not.toMatch(/element was found/);
  }, 30_000);
});
