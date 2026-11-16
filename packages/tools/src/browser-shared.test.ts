/**
 * Sessions share one browser and keep their own contexts (29 Sep 2026): one
 * Chromium for all of them instead of one each, and still no session seeing
 * another's cookies.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { chromium } from "playwright";
import { browserStats, closeBrowserSession, toolBrowserOpen, toolBrowserSnapshot } from "./browser-tools.js";

let server: http.Server | null = null;
let base = "";
let hasBrowser = false;
const A = `shared_a_${Date.now()}`;
const B = `shared_b_${Date.now()}`;

beforeAll(async () => {
  try {
    await (await chromium.launch()).close();
    hasBrowser = true;
  } catch {
    hasBrowser = false;
  }
  server = http.createServer((req, res) => {
    if (req.url === "/set") res.setHeader("Set-Cookie", "who=session-a; Path=/");
    res.writeHead(200, { "Content-Type": "text/html" });
    res.end(`<!doctype html><title>Cookies</title><p id="c">cookies: <script>document.write(document.cookie || "none")</script></p>`);
  });
  await new Promise<void>((r) => server!.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}, 60_000);

afterAll(async () => {
  await closeBrowserSession(A);
  await closeBrowserSession(B);
  server?.close();
});

describe("one browser for every session", () => {
  it("gives each session its own context in a single browser, and closes it with the last", async () => {
    if (!hasBrowser) return;
    expect((await toolBrowserOpen(A, { url: `${base}/set` })).success).toBe(true);
    expect((await toolBrowserOpen(B, { url: `${base}/show` })).success).toBe(true);
    expect(await browserStats()).toEqual({ browsers: 1, contexts: 2 });

    // B never sees the cookie A was given.
    const seenByB = JSON.stringify(await toolBrowserSnapshot(B, {}));
    expect(seenByB).toContain("cookies: none");
    await toolBrowserOpen(A, { url: `${base}/show` });
    expect(JSON.stringify(await toolBrowserSnapshot(A, {}))).toContain("who=session-a");

    await closeBrowserSession(A);
    expect(await browserStats()).toEqual({ browsers: 1, contexts: 1 });
    await closeBrowserSession(B);
    expect((await browserStats()).browsers).toBe(0);
  }, 60_000);
});
