/**
 * Several browser steps in one call (2 Oct 2026): "resize, open, screenshot"
 * was three round trips, each with a sentence of narration.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { chromium } from "playwright";
import { LocalSandboxRunner } from "@sqcode/sandbox-runner";
import { executeTool } from "./dispatcher.js";
import { closeBrowserSession } from "./browser-tools.js";
import type { ToolExecutionContext } from "./types.js";

let server: http.Server | null = null;
let base = "";
let hasBrowser = false;
let dir = "";
let ctx: ToolExecutionContext;
const SESSION = `batch_${Date.now()}`;
const WS = `batch_ws_${Date.now()}`;

beforeAll(async () => {
  try {
    await (await chromium.launch()).close();
    hasBrowser = true;
  } catch {
    hasBrowser = false;
  }
  server = http.createServer((req, res) => {
    res.writeHead(200, { "Content-Type": "text/html" });
    res.end(`<!doctype html><title>${req.url === "/contact" ? "Contact" : "Home"}</title><h1>${req.url}</h1><button>Send</button>`);
  });
  await new Promise<void>((r) => server!.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "sqcode_batch_"));
  const runner = new LocalSandboxRunner(dir);
  await runner.createWorkspace(WS, { storagePath: dir });
  ctx = { sandboxRunner: runner, workspaceId: WS, sessionId: SESSION } as unknown as ToolExecutionContext;
}, 60_000);

afterAll(async () => {
  await closeBrowserSession(SESSION);
  server?.close();
  fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

describe("browser_batch", () => {
  it("runs the steps in order and returns every screenshot, labelled by step", async () => {
    if (!hasBrowser) return;
    const result = await executeTool(
      "browser_batch",
      {
        steps: [
          { action: "open", url: `${base}/` },
          { action: "resize", device: "mobile" },
          { action: "open", url: `${base}/contact` },
          { action: "screenshot" },
          { action: "resize", device: "desktop" },
          { action: "screenshot", full_page: true },
        ],
      },
      ctx,
    );
    expect(result.success).toBe(true);
    const data = result.data as { steps: Array<Record<string, unknown>>; page_now?: string };
    expect(data.steps.map((s) => s["action"])).toEqual(["open", "resize", "open", "screenshot", "resize", "screenshot"]);
    expect(data.steps[2]).toMatchObject({ ok: true, title: "Contact" });
    expect(result.images).toHaveLength(2);
    expect(result.images![0]!.source).toBe(`step 4 screenshot of ${base}/contact`);
    expect(result.images![1]!.source).toContain("step 6");
    // Saved to the workspace as well, for the transcript.
    expect(fs.existsSync(path.join(dir, String(data.steps[3]!["saved"])))).toBe(true);
  }, 60_000);

  it("stops at the first step that fails and says which, and how many did not run", async () => {
    if (!hasBrowser) return;
    const result = await executeTool(
      "browser_batch",
      {
        steps: [
          { action: "open", url: `${base}/` },
          { action: "click", selector: "#does-not-exist", timeout_ms: 500 },
          { action: "screenshot" },
          { action: "screenshot" },
        ],
      },
      ctx,
    );
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/^Step 2 \(click\) failed/);
    expect((result.data as { skipped?: string }).skipped).toBe("2 later steps did not run.");
    expect(result.images).toBeUndefined();
  }, 60_000);

  it("refuses an unknown action and an empty batch", async () => {
    const empty = await executeTool("browser_batch", { steps: [] }, ctx);
    expect(empty.success).toBe(false);
    const odd = await executeTool("browser_batch", { steps: [{ action: "teleport" }] }, ctx);
    expect(odd.success).toBe(false);
    expect(odd.error).toContain("Unknown action 'teleport'");
  });
});

describe("forgiving spellings", () => {
  it("resizes before anything is open, and takes a screenshot asked of browser_interact", async () => {
    if (!hasBrowser) return;
    const fresh = { ...ctx, sessionId: `${SESSION}_fresh` } as ToolExecutionContext;
    const sized = await executeTool("browser_batch", { steps: [{ action: "resize", device: "mobile" }, { action: "open", url: `${base}/` }] }, fresh);
    expect(sized.success).toBe(true);
    const shot = await executeTool("browser_interact", { action: "screenshot" }, fresh);
    expect(shot.success).toBe(true);
    expect(shot.image?.mediaType).toBe("image/png");
    await closeBrowserSession(fresh.sessionId);
  }, 60_000);
});
