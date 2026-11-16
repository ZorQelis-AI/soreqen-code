/**
 * Background commands the agent can check on, wait for and stop — and a wait
 * that ends when the person speaks.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { LocalSandboxRunner } from "@sqcode/sandbox-runner";
import { toolRunCommand } from "./implementations.js";
import { toolProcessStatus, toolStopProcess, toolWait } from "./process-tools.js";
import type { ToolExecutionContext } from "./types.js";

const node = (script: string): string => `node -e "${script.replace(/"/g, '\\"')}"`;

describe("process tools", () => {
  const workspaceId = `proc_tools_ws_${Date.now()}`;
  let runner: LocalSandboxRunner;
  let dir: string;
  let ctx: ToolExecutionContext;

  beforeEach(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "sqcode_proc_tools_"));
    runner = new LocalSandboxRunner(dir);
    await runner.createWorkspace(workspaceId, { storagePath: dir });
    ctx = { workspaceId, sandboxRunner: runner, sessionId: "s1", callId: "call_1" };
  });

  afterEach(async () => {
    await runner.destroyWorkspace(workspaceId);
    try {
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    } catch {
      // Windows can hold a handle briefly.
    }
  });

  it("starts a server in the background, waits for it to be ready, reads it and stops it", async () => {
    const started = await toolRunCommand(
      {
        command: node("setTimeout(() => console.log('server ready'), 2500); setInterval(() => {}, 1000)"),
        description: "Start a slow server",
        run_in_background: true,
      },
      ctx,
    );
    expect(started.success).toBe(true);
    expect(started.data?.status).toBe("running");
    const id = String(started.data?.process_id);
    expect(runner.getProcess(workspaceId, id)).toMatchObject({ callId: "call_1", sessionId: "s1", description: "Start a slow server" });

    const waited = await toolWait({ process_id: id, until_output: "server ready", seconds: 20 }, ctx);
    expect(waited.data?.reason).toBe("matched");

    const status = await toolProcessStatus({ process_id: id }, ctx);
    expect(status.data?.status).toBe("running");
    expect(status.data?.output).toContain("server ready");

    const stopped = await toolStopProcess({ process_id: id }, ctx);
    expect(stopped.data).toMatchObject({ status: "stopped", stopped_by: "agent" });

    const listed = await toolProcessStatus({}, ctx);
    expect((listed.data?.processes as unknown[]).length).toBe(1);
  }, 30_000);

  it("ends a wait as soon as the person sends a message", async () => {
    let pending = 0;
    setTimeout(() => {
      pending = 1;
    }, 300);
    const began = Date.now();
    const waited = await toolWait({ seconds: 30 }, { ...ctx, pendingMessages: () => pending });
    expect(waited.data?.reason).toBe("message");
    expect(Date.now() - began).toBeLessThan(5_000);
  }, 10_000);

  it("reports a foreground failure with its real exit code and output", async () => {
    const res = await toolRunCommand({ command: node("console.error('boom'); process.exit(4)") }, ctx);
    expect(res.success).toBe(false);
    expect(res.data).toMatchObject({ status: "exited", exit_code: 4 });
    expect(res.data?.output).toContain("boom");
    expect(res.error).toContain("code 4");
  }, 20_000);

  // Reported 24 Sep 2026: "the command already ran and it's still waiting".

  it("returns when a command exits, even if something it started still holds its output", async () => {
    fs.writeFileSync(
      path.join(dir, "spawner.js"),
      "require('child_process').spawn(process.execPath, ['-e', 'setTimeout(() => {}, 20000)'], { stdio: 'inherit', detached: true }).unref();\n" +
        "console.log('done');\n",
    );
    const began = Date.now();
    const res = await toolRunCommand({ command: "node spawner.js" }, ctx);
    expect(Date.now() - began).toBeLessThan(8_000);
    expect(res.success).toBe(true);
    expect(res.data).toMatchObject({ status: "exited", exit_code: 0 });
    expect(res.data?.output).toContain("done");
    expect(String(res.data?.note)).toMatch(/still running/);
  }, 20_000);

  it("matches until_output through colour codes, case and spacing — as Vite prints it", async () => {
    // Vite's real bytes, colour codes and all, written in pieces.
    fs.writeFileSync(
      path.join(dir, "vite-like.js"),
      "const e = String.fromCharCode(27);\n" +
        "process.stdout.write(`\\n  ${e}[32m${e}[1mVITE${e}[22m v7.3.6${e}[39m  ${e}[2mready in ${e}[0m${e}[1m630${e}[22m ms\\n\\n`);\n" +
        "process.stdout.write(`  ${e}[32m➜${e}[39m  ${e}[1mLocal${e}[22m:   ${e}[36mhttp://localhost:${e}[1m5173${e}[22m/${e}[39m\\n`);\n" +
        "setInterval(() => {}, 1000);\n",
    );
    const started = await toolRunCommand({ command: "node vite-like.js", run_in_background: true }, ctx);
    const id = String(started.data?.process_id);
    for (const until of ["Local:", "localhost:5173", "http://localhost:5173/", "local: http://localhost:5173", "READY IN"]) {
      const waited = await toolWait({ process_id: id, until_output: until, seconds: 10 }, ctx);
      expect(waited.data?.reason, until).toBe("matched");
    }
    expect(String((await toolProcessStatus({ process_id: id }, ctx)).data?.output)).toContain("➜  Local:   http://localhost:5173/");
    await toolStopProcess({ process_id: id }, ctx);
  }, 30_000);

  it("stops waiting for text that never comes once the output says the server is ready", async () => {
    fs.writeFileSync(path.join(dir, "ready.js"), "console.log('  Local:   http://localhost:5174/');\nsetInterval(() => {}, 1000);\n");
    const started = await toolRunCommand({ command: "node ready.js", run_in_background: true }, ctx);
    const id = String(started.data?.process_id);
    const began = Date.now();
    // The model guessed the port it usually gets.
    const waited = await toolWait({ process_id: id, until_output: "localhost:5173", seconds: 120 }, ctx);
    expect(waited.data?.reason).toBe("ready");
    expect(Date.now() - began).toBeLessThan(25_000);
    expect(String(waited.data?.note)).toContain("http://localhost:5174/");
    await toolStopProcess({ process_id: id }, ctx);
  }, 40_000);
  it("stops waiting on a foreground command when the person sends a message now, and leaves it running", async () => {
    let urgent = 0;
    setTimeout(() => (urgent = 1), 1_000);
    const began = Date.now();
    const result = await toolRunCommand(
      { command: node("setInterval(() => console.log('epoch'), 300)"), description: "A long job" },
      { ...ctx, urgentMessages: () => urgent },
    );
    expect(Date.now() - began).toBeLessThan(10_000);
    expect(result.success).toBe(true);
    expect(result.data?.status).toBe("running");
    expect(String(result.data?.note)).toContain("could not wait");
    // From now on a background job, so its end is reported like one's (14 Oct 2026: it was not).
    expect(runner.getProcess(ctx.workspaceId, String(result.data?.process_id))?.background).toBe(true);
    await toolStopProcess({ process_id: String(result.data?.process_id) }, ctx);
  }, 30_000);
});
