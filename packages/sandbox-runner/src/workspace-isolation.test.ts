/**
 * Where a workspace's files actually go.
 *
 * These tests exist because the gateway's tenant isolation was real in the
 * database and absent on disk. Two owners got two workspace rows, two
 * ownership checks that both passed, and the same directory — so `guardPath`
 * confined every write correctly, to the wrong boundary.
 *
 * Nothing in the existing suite could see it: every test passed `storagePath`
 * explicitly, which is the one case that was never broken.
 */

import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { LocalSandboxRunner } from "./local-runner.js";

let base: string;
let runner: LocalSandboxRunner;

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), "sq-iso-"));
  runner = new LocalSandboxRunner(base);
});

afterEach(() => {
  rmSync(base, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

describe("workspace isolation", () => {
  it("gives each workspace its own directory when none is named", async () => {
    const a = await runner.createWorkspace("ws_alpha");
    const b = await runner.createWorkspace("ws_beta");

    expect(a.workspacePath).not.toBe(b.workspacePath);
    expect(a.workspacePath).not.toBe(base);
    expect(a.workspacePath).toContain("ws_alpha");
  });

  it("keeps two tenants' files apart", async () => {
    await runner.createWorkspace("ws_alpha");
    await runner.createWorkspace("ws_beta");

    await runner.writeFile("ws_alpha", "secret.txt", "alpha's data");

    // Beta must not see it, by any of the three ways it could ask.
    await expect(runner.readFile("ws_beta", "secret.txt")).rejects.toThrow();

    const betaListing = await runner.listDirectory("ws_beta", ".", true, 3);
    expect(betaListing.map((e) => e.path)).not.toContain("secret.txt");

    // And alpha still has it — the isolation is not just an absence.
    const back = await runner.readFile("ws_alpha", "secret.txt");
    expect(back.content).toBe("alpha's data");
  });

  it("writes inside the workspace, not beside it", async () => {
    const ws = await runner.createWorkspace("ws_gamma");
    await runner.writeFile("ws_gamma", "hello.txt", "in the workspace");

    expect(existsSync(join(ws.workspacePath, "hello.txt"))).toBe(true);
    // The exact symptom that found this: the file appearing in the parent of
    // every workspace.
    expect(existsSync(join(base, "hello.txt"))).toBe(false);
  });

  it("honours an explicit storagePath, because that is how the CLI opens a repo", async () => {
    const repo = mkdtempSync(join(tmpdir(), "sq-repo-"));
    try {
      const ws = await runner.createWorkspace("local_cwd", { storagePath: repo });
      expect(ws.workspacePath).toBe(repo);

      await runner.writeFile("local_cwd", "note.md", "written in place");
      expect(readFileSync(join(repo, "note.md"), "utf8")).toBe("written in place");
      // Not in a `local_cwd` subdirectory of the user's project.
      expect(existsSync(join(repo, "local_cwd"))).toBe(false);
    } finally {
      rmSync(repo, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  });

  it("refuses an id that was never created instead of inventing one", async () => {
    await expect(runner.readFile("never_existed", "anything.txt")).rejects.toThrow(
      /does not exist/i,
    );
  });

  it("stays destroyed once destroyed", async () => {
    await runner.createWorkspace("ws_temp");
    await runner.writeFile("ws_temp", "f.txt", "x");
    await runner.destroyWorkspace("ws_temp");

    // Previously the next call resurrected it — rooted at the shared parent.
    await expect(runner.readFile("ws_temp", "f.txt")).rejects.toThrow(/destroyed/i);
  });
});
