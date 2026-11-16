/**
 * A screenshot is stored as a file, and the result names it instead of
 * carrying the image as text.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { LocalSandboxRunner } from "@sqcode/sandbox-runner";
import { storeScreenshot } from "./browser-tools.js";

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);

describe("storeScreenshot", () => {
  const ws = `shot_ws_${Date.now()}`;
  let dir: string;
  let runner: LocalSandboxRunner;

  beforeEach(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "sqcode_shot_"));
    runner = new LocalSandboxRunner(dir);
    await runner.createWorkspace(ws, { storagePath: dir });
  });

  afterEach(async () => {
    await runner.destroyWorkspace(ws);
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });

  const shot = (base64: string) => ({ success: true, screenshotBase64: base64, url: "http://x", title: "X", domSummary: "" });

  it("writes the image to the session scratchpad and returns its path, not its bytes", async () => {
    const result = await storeScreenshot(shot(PNG.toString("base64")), {
      sandboxRunner: runner,
      workspaceId: ws,
      sessionId: "sess/1",
    });
    expect(result).not.toHaveProperty("screenshotBase64");
    const file = result["screenshotPath"] as string;
    expect(file).toMatch(/^\.soreqen\/scratch\/sess_1\/screenshots\/screenshot-.+\.png$/);
    expect(fs.readFileSync(path.join(dir, file))).toEqual(PNG);
    expect(result).toMatchObject({ success: true, url: "http://x", title: "X" });
  });

  it("passes a failed capture through without a path", async () => {
    const result = await storeScreenshot({ ...shot(""), success: false, error: "No page" }, { sandboxRunner: runner, workspaceId: ws });
    expect(result).toEqual({ success: false, url: "http://x", title: "X", domSummary: "", error: "No page" });
  });
});
