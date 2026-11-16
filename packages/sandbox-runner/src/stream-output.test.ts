/**
 * Output that arrives in pieces, and commands that finish before their pipes do.
 *
 * Both behind one report: "the command already ran and it's still waiting".
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { LocalSandboxRunner } from "./local-runner.js";
import { createTerminalStripper } from "./pty.js";

const ESC = String.fromCharCode(27);

describe("stripping terminal codes from a stream", () => {
  it("removes a colour code cut in half between two chunks", () => {
    const s = createTerminalStripper();
    const out = s.push(`Local:   http://localhost:${ESC}[`) + s.push(`1m5173${ESC}[22m/`) + s.end();
    expect(out).toBe("Local:   http://localhost:5173/");
  });

  it("joins a CRLF split between chunks, and passes plain text straight through", () => {
    const s = createTerminalStripper();
    expect(s.push("line one\r") + s.push("\nline two") + s.end()).toBe("line one\nline two");
    const plain = createTerminalStripper();
    expect(plain.push("no codes here") + plain.end()).toBe("no codes here");
  });

  it("drops an escape left unfinished at the very end", () => {
    const s = createTerminalStripper();
    expect(s.push(`done${ESC}[3`) + s.end()).toBe("done");
  });
});

describe("a command that exits while something it started holds its output", () => {
  const ws = `stream_ws_${Date.now()}`;
  let dir: string;
  let runner: LocalSandboxRunner;

  beforeEach(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "sqc_stream_"));
    runner = new LocalSandboxRunner(dir);
    await runner.createWorkspace(ws, { storagePath: dir });
    fs.writeFileSync(
      path.join(dir, "spawner.js"),
      "require('child_process').spawn(process.execPath, ['-e', 'setTimeout(() => {}, 15000)'], { stdio: 'inherit', detached: true }).unref();\n" +
        "console.log('finished ➜ ok');\n",
    );
  });

  afterEach(async () => {
    await runner.destroyWorkspace(ws).catch(() => undefined);
    try {
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    } catch {
      // The leftover child holds the directory until it exits.
    }
  });

  it("is settled by execCommand when it exits, not when the leftover exits", async () => {
    const began = Date.now();
    const res = await runner.execCommand(ws, { command: "node spawner.js", timeoutMs: 60_000 });
    expect(Date.now() - began).toBeLessThan(8_000);
    expect(res.exitCode).toBe(0);
    expect(res.stdout).toContain("finished ➜ ok");
    expect(res.stdout).toMatch(/still running/);
  }, 20_000);
});
