/**
 * A command's exit code is the real one.
 *
 * Everything above the runner is entitled to believe this number: the
 * self-healer reads it to decide whether a fix worked, the test selector reads
 * it to decide whether the tests passed, and the agent reads it to decide
 * whether to try something else. A number that is merely *non-zero* is not
 * enough — a build tool that exits 2 for "config error" and 1 for "test
 * failures" is telling you which, and flattening both to 1 throws that away.
 *
 * The bug: `execCommand` built its own PowerShell command line instead of
 * using `shellInvocation`, so on Windows every failure arrived as 1. The
 * background path used `shellInvocation` and reported the truth — so the two
 * halves of `run_command` disagreed, and only one of them was right.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { LocalSandboxRunner } from "./local-runner.js";

describe("exit codes survive the shell", () => {
  const wsId = "exit_ws";
  let runner: LocalSandboxRunner;
  let dir: string;

  beforeAll(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "sqcode_exit_"));
    runner = new LocalSandboxRunner(dir);
    await runner.createWorkspace(wsId, { storagePath: dir });
  });

  afterAll(async () => {
    await runner.destroyWorkspace(wsId);
    try {
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    } catch {
      // ignore
    }
  });

  it("reports the program's own code, not a flattened 1", async () => {
    for (const code of [0, 1, 2, 3, 7, 42]) {
      const res = await runner.execCommand(wsId, {
        command: `node -e "process.exit(${code})"`,
        timeoutMs: 30_000,
      });
      expect(res.exitCode, `node exiting ${code}`).toBe(code);
    }
  }, 60_000);

  it("still reports success for a command that succeeds", async () => {
    const res = await runner.execCommand(wsId, { command: "node -e \"console.log('ok')\"", timeoutMs: 30_000 });
    expect(res.exitCode).toBe(0);
    expect(res.stdout).toContain("ok");
  }, 30_000);

  it("agrees with the background path about the same command", async () => {
    /*
     * The divergence itself, pinned. These were two different invocations of
     * the same shell, and a turn could see either one depending on whether it
     * asked for a background process.
     */
    const foreground = await runner.execCommand(wsId, {
      command: `node -e "process.exit(5)"`,
      timeoutMs: 30_000,
    });

    const started = await runner.startProcess(wsId, {
      command: `node -e "process.exit(5)"`,
      background: false,
      timeoutMs: 30_000,
    });

    // Give the process a moment to finish and be recorded.
    for (let i = 0; i < 60; i++) {
      const info = await runner.getProcess(wsId, started.id);
      if (info && info.status !== "running") {
        expect(info.exitCode).toBe(foreground.exitCode);
        expect(info.exitCode).toBe(5);
        return;
      }
      await new Promise((r) => setTimeout(r, 100));
    }
    throw new Error("the background process never finished");
  }, 45_000);
});
