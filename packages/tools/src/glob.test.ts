/**
 * `glob` (29 Sep 2026): models call it by name, and SoreQen had to answer
 * "the `glob` tool doesn't exist".
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { LocalSandboxRunner } from "@sqcode/sandbox-runner";
import { globMatcher } from "./search.js";
import { executeTool } from "./dispatcher.js";

describe("glob patterns", () => {
  it("reads them as ripgrep does", () => {
    const ts = globMatcher("*.ts");
    expect(ts("src/a/b.ts")).toBe(true); // no slash: the name, at any depth
    expect(ts("src/a/b.tsx")).toBe(false);
    expect(globMatcher("src/**/*.test.ts")("src/a/b/c.test.ts")).toBe(true);
    expect(globMatcher("src/**/*.test.ts")("src/c.test.ts")).toBe(true);
    expect(globMatcher("src/*.ts")("src/a/b.ts")).toBe(false);
    expect(globMatcher("*.{js,jsx}")("x/y.jsx")).toBe(true);
    expect(globMatcher("README*")("docs/README.md")).toBe(true);
    expect(globMatcher("a+b.(1).txt")("a+b.(1).txt")).toBe(true);
  });
});

describe("the glob tool", () => {
  const ws = `glob_ws_${Date.now()}`;
  let dir: string;
  let runner: LocalSandboxRunner;
  beforeAll(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "sqcode_glob_"));
    for (const f of ["src/app.ts", "src/deep/x.test.ts", "src/view.tsx", "node_modules/pkg/index.ts", "README.md"]) {
      fs.mkdirSync(path.dirname(path.join(dir, f)), { recursive: true });
      fs.writeFileSync(path.join(dir, f), "x");
    }
    runner = new LocalSandboxRunner(dir);
    await runner.createWorkspace(ws, { storagePath: dir });
  });
  afterAll(async () => {
    await runner.destroyWorkspace(ws);
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });

  it("finds files by pattern, never inside node_modules", async () => {
    const res = (await executeTool("glob", { pattern: "**/*.ts" }, { workspaceId: ws, sandboxRunner: runner })) as {
      success: boolean;
      data: { files: string[] };
    };
    expect(res.success).toBe(true);
    expect([...res.data.files].sort()).toEqual(["src/app.ts", "src/deep/x.test.ts"]);
  });

  it("asks for a pattern rather than listing everything", async () => {
    const res = (await executeTool("glob", {}, { workspaceId: ws, sandboxRunner: runner })) as { success: boolean; error?: string };
    expect(res.success).toBe(false);
    expect(res.error).toMatch(/pattern/);
  });
});

describe("searching a big folder elsewhere on the computer (15 Oct 2026)", () => {
  /*
   * A model project on another drive: 100,000 clips in data/, code beside
   * it. The listing's 20,000 entries were all spent in data/, and glob and
   * grep said "no file matches" for the code and the README.
   */
  const ws = `glob_far_${Date.now()}`;
  let home: string;
  let far: string;
  let runner: LocalSandboxRunner;
  beforeAll(async () => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), "sqcode_glob_home_"));
    far = fs.mkdtempSync(path.join(os.tmpdir(), "sqcode_glob_far_"));
    fs.mkdirSync(path.join(far, "data", "clips"), { recursive: true });
    for (let i = 0; i < 20_500; i++) fs.writeFileSync(path.join(far, "data", "clips", `c${i}.npz`), "");
    fs.mkdirSync(path.join(far, "scripts"));
    fs.writeFileSync(path.join(far, "scripts", "export_onnx.py"), "import torch\n");
    fs.writeFileSync(path.join(far, "README.md"), "python -m train --max-steps 40000\n");
    runner = new LocalSandboxRunner(home);
    await runner.createWorkspace(ws, { storagePath: home });
  }, 120_000);
  afterAll(async () => {
    await runner.destroyWorkspace(ws);
    fs.rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    fs.rmSync(far, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    // Deleting 20,500 files takes time on a loaded machine.
  }, 120_000);

  const run = async (tool: string, input: Record<string, unknown>) =>
    (await executeTool(tool, input, { workspaceId: ws, sandboxRunner: runner })) as { success: boolean; data: Record<string, unknown> };

  it("finds the code past the data, by a pattern read from the folder searched", async () => {
    const all = await run("glob", { pattern: "**/*export*", path: far });
    expect(all.data["files"]).toEqual([`${far.replace(/\\/g, "/")}/scripts/export_onnx.py`]);
    const scoped = await run("glob", { pattern: "scripts/*.py", path: far });
    expect(scoped.data["count"]).toBe(1);
  }, 60_000);

  it("finds text past the data", async () => {
    const res = await run("grep_search", { query: "max-steps", path: far });
    expect(String(res.data)).toMatch(/^1 match in 1 file\n/);
  }, 60_000);
});
