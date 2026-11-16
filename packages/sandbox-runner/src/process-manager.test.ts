/**
 * Processes with a lifetime: started, read, waited for, stopped.
 *
 * Real child processes, because what matters is what the operating system
 * does — a timeout that does not actually kill, output that does not arrive —
 * and a mock would only agree with the code.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { LocalSandboxRunner } from "./local-runner.js";
import type { ProcessEvent } from "./types.js";

const node = (script: string): string => `node -e "${script.replace(/"/g, '\\"')}"`;

describe("processes", () => {
  const wsId = `proc_ws_${Date.now()}`;
  let runner: LocalSandboxRunner;
  let dir: string;

  beforeEach(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "sqcode_proc_"));
    runner = new LocalSandboxRunner(dir);
    await runner.createWorkspace(wsId, { storagePath: dir });
  });

  afterEach(async () => {
    await runner.destroyWorkspace(wsId);
    try {
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    } catch {
      // Windows can hold a handle briefly.
    }
  });

  it("runs a command to completion and keeps what it printed", async () => {
    const events: ProcessEvent["type"][] = [];
    const off = runner.onProcessEvent((e) => events.push(e.type));
    const started = await runner.startProcess(wsId, { command: node("console.log('hello'); process.exit(3)") });
    expect(started.status).toBe("running");

    const done = await runner.processExited(wsId, started.id)!;
    off();
    expect(done.status).toBe("exited");
    expect(done.exitCode).toBe(3);
    expect(runner.readProcessOutput(wsId, started.id)).toContain("hello");
    expect(events[0]).toBe("started");
    expect(events.at(-1)).toBe("exited");
  }, 20_000);

  it("keeps a background process running until it is stopped, and says who stopped it", async () => {
    const started = await runner.startProcess(wsId, {
      command: node("console.log('ready'); setInterval(() => {}, 1000)"),
      background: true,
      description: "A server",
    });
    await new Promise((resolve) => setTimeout(resolve, 1500));
    expect(runner.getProcess(wsId, started.id)?.status).toBe("running");
    expect(runner.readRecentProcessOutput(wsId, started.id, 100)).toContain("ready");

    const stopped = await runner.stopProcess(wsId, started.id, "user");
    expect(stopped?.status).toBe("stopped");
    expect(stopped?.stoppedBy).toBe("user");
  }, 20_000);

  it("stops a foreground command at its timeout", async () => {
    const started = await runner.startProcess(wsId, {
      command: node("setInterval(() => {}, 1000)"),
      timeoutMs: 800,
    });
    const done = await runner.processExited(wsId, started.id)!;
    expect(done.status).toBe("timed_out");
  }, 20_000);

  it("never shows one workspace another's processes", async () => {
    const otherDir = fs.mkdtempSync(path.join(os.tmpdir(), "sqcode_proc_other_"));
    await runner.createWorkspace("other_ws", { storagePath: otherDir });
    const started = await runner.startProcess(wsId, { command: node("setTimeout(() => {}, 200)") });

    expect(runner.getProcess("other_ws", started.id)).toBeNull();
    expect(await runner.stopProcess("other_ws", started.id, "user")).toBeNull();
    expect(runner.listProcesses("other_ws")).toEqual([]);

    await runner.processExited(wsId, started.id);
    await runner.destroyWorkspace("other_ws");
    fs.rmSync(otherDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }, 20_000);
});
