/**
 * The browser tools against the things a real app does that a plain page does
 * not: dialogs, new tabs, failing API calls, file inputs, web components,
 * iframes and a viewport that is not a laptop's.
 *
 * Runs a real Chromium; skipped where none is installed.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { chromium } from "playwright";
import {
  closeBrowserSession,
  takeBrowserNotes,
  toolBrowserInteract,
  toolBrowserOpen,
  toolBrowserSnapshot,
} from "./browser-tools.js";

const SESSION = `audit_${Date.now()}`;
let root = "";
let server: http.Server | null = null;
let base = "";

const PAGE = `<!doctype html><html><head><title>Audit page</title></head><body>
<h1>Audit</h1>
<button id="del" onclick="document.getElementById('out').textContent = confirm('Delete this item?') ? 'deleted' : 'kept'">Delete item</button>
<p id="out">nothing yet</p>
<a href="/second.html" target="_blank">Open in new tab</a>
<button id="api" onclick="fetch('/definitely-missing.json').catch(()=>{})">Load data</button>
<input type="file" id="picker" aria-label="Attachment" onchange="document.getElementById('fname').textContent = this.files[0].name">
<p id="fname">no file</p>
<fancy-button></fancy-button>
<iframe srcdoc="<button onclick=&quot;this.textContent='framed clicked'&quot;>Framed button</button>"></iframe>
<p id="size"></p>
<script>
customElements.define('fancy-button', class extends HTMLElement {
  constructor() { super(); const r = this.attachShadow({ mode: 'open' });
    r.innerHTML = '<button onclick="this.textContent=\\'shadow clicked\\'">Shadow button</button>'; }
});
const size = () => document.getElementById('size').textContent = 'width ' + innerWidth;
addEventListener('resize', size); size();
</script></body></html>`;

let hasBrowser = false;
beforeAll(async () => {
  try {
    const b = await chromium.launch();
    await b.close();
    hasBrowser = true;
  } catch {
    hasBrowser = false;
  }
  root = await fs.mkdtemp(path.join(os.tmpdir(), "sqc-browser-audit-"));
  await fs.writeFile(path.join(root, "index.html"), PAGE);
  await fs.writeFile(path.join(root, "report.pdf"), "%PDF-1.4 test");
  await fs.writeFile(path.join(root, "second.html"), "<!doctype html><title>Second tab</title><p>second</p>");
  await fs.writeFile(path.join(os.tmpdir(), "outside-secret.txt"), "nope");

  // Served over HTTP: from a file:// page, fetch never issues a request and
  // Chromium refuses to open a data: URL in a new tab.
  server = http.createServer((req, res) => {
    const name = (req.url ?? "/").split("?")[0] === "/" ? "index.html" : (req.url ?? "").slice(1);
    fs.readFile(path.join(root, name))
      .then((body) => {
        res.writeHead(200, { "Content-Type": "text/html" });
        res.end(body);
      })
      .catch(() => {
        res.writeHead(404);
        res.end("missing");
      });
  });
  await new Promise<void>((r) => server!.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}, 60_000);

afterAll(async () => {
  await closeBrowserSession(SESSION);
  await new Promise((r) => server?.close(r));
  await fs.rm(root, { recursive: true, force: true }).catch(() => undefined);
});

/** The ref of the element whose snapshot line contains `name`. */
async function refOf(name: string): Promise<number> {
  const snap = await toolBrowserSnapshot(SESSION, {});
  const line = String(snap.page ?? "").split("\n").find((l) => l.includes(name));
  const ref = Number(/\[(\d+)\]/.exec(line ?? "")?.[1]);
  if (!ref) throw new Error(`No element named ${name} in:\n${snap.page}`);
  return ref;
}

describe("browser tools, audited", () => {
  it("opens the page", async () => {
    if (!hasBrowser) return;
    const opened = await toolBrowserOpen(SESSION, { url: `${base}/` }, root);
    expect(opened.success).toBe(true);
    takeBrowserNotes(SESSION);
  }, 60_000);

  it("accepts a confirm dialog and reports what it said", async () => {
    if (!hasBrowser) return;
    const result = await toolBrowserInteract(SESSION, { action: "click", ref: await refOf("Delete item") }, root);
    expect(result.success).toBe(true);
    expect(result.snapshot).toContain("deleted");
    expect(takeBrowserNotes(SESSION).join("\n")).toContain('confirm dialog said "Delete this item?"');
  }, 60_000);

  it("reports an API request that failed", async () => {
    if (!hasBrowser) return;
    await toolBrowserInteract(SESSION, { action: "click", ref: await refOf("Load data") }, root);
    await new Promise((r) => setTimeout(r, 500));
    const notes = takeBrowserNotes(SESSION).join("\n");
    expect(notes).toMatch(/Request failed: .*definitely-missing\.json/);
  }, 60_000);

  it("finds and clicks a button inside a shadow root", async () => {
    if (!hasBrowser) return;
    const result = await toolBrowserInteract(SESSION, { action: "click", ref: await refOf("Shadow button") }, root);
    expect(result.success).toBe(true);
    expect(result.snapshot).toContain("shadow clicked");
  }, 60_000);

  it("finds and clicks a button inside a same-origin iframe", async () => {
    if (!hasBrowser) return;
    const result = await toolBrowserInteract(SESSION, { action: "click", ref: await refOf("Framed button") }, root);
    expect(result.success).toBe(true);
    expect(result.snapshot).toContain("framed clicked");
  }, 60_000);

  it("uploads a workspace file, and refuses one from outside it", async () => {
    if (!hasBrowser) return;
    const ref = await refOf("Attachment");
    const ok = await toolBrowserInteract(SESSION, { action: "upload", ref, files: ["report.pdf"] }, root);
    expect(ok.success).toBe(true);
    expect(ok.snapshot).toContain("report.pdf");

    const outside = await toolBrowserInteract(
      SESSION,
      { action: "upload", ref, files: [path.join("..", "outside-secret.txt")] },
      root,
    );
    expect(outside.success).toBe(false);
    expect(outside.error).toMatch(/outside the workspace|no file/);
  }, 60_000);

  it("resizes the viewport to a phone", async () => {
    if (!hasBrowser) return;
    const result = await toolBrowserInteract(SESSION, { action: "resize", device: "mobile" }, root);
    expect(result.success).toBe(true);
    expect(result.snapshot).toContain("width 390");
  }, 60_000);

  it("follows a link that opens a new tab", async () => {
    if (!hasBrowser) return;
    await toolBrowserInteract(SESSION, { action: "click", ref: await refOf("Open in new tab") }, root);
    await new Promise((r) => setTimeout(r, 800));
    expect(takeBrowserNotes(SESSION).join("\n")).toContain("A new tab opened");
    const snap = await toolBrowserSnapshot(SESSION, {});
    expect(snap.title).toBe("Second tab");
  }, 60_000);
});
