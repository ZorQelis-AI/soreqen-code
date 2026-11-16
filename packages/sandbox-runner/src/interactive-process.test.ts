/**
 * A command that asks a question can be answered.
 *
 * Before, every command ran with stdin closed: a prompt read end-of-file and
 * the command failed. Skipped where no pseudo-terminal can load.
 */
import { describe, expect, it } from "vitest";
import os from "node:os";
import { ProcessManager } from "./process-manager.js";
import { loadPty, stripTerminalCodes } from "./pty.js";

const prompt =
  process.platform === "win32"
    ? `$n = Read-Host 'Project name'; Write-Output "created $n"`
    : `read -p 'Project name: ' n; echo "created $n"`;

describe.skipIf(!loadPty())("interactive processes", () => {
  it("asks, takes the answer, and finishes with it", async () => {
    const pm = new ProcessManager();
    const cwd = os.tmpdir();
    const info = pm.start("ws", cwd, cwd, { command: prompt, interactive: true });
    expect(info.interactive).toBe(true);
    expect(info.background).toBe(true); // a terminal never sends EOF

    const deadline = Date.now() + 15_000;
    while (!pm.output("ws", info.id).includes("Project name") && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 100));
    }
    expect(pm.write("ws", info.id, "moon-base\r")).toBe(true);

    const done = await pm.exited("ws", info.id)!;
    expect(done.exitCode).toBe(0);
    const out = pm.output("ws", info.id);
    expect(out).toContain("created moon-base");
    // Terminal codes are stripped before anyone reads the output.
    expect(out).not.toMatch(/\x1b/);
  }, 30_000);

  it("refuses input to a process that has no terminal", () => {
    const pm = new ProcessManager();
    const cwd = os.tmpdir();
    const info = pm.start("ws", cwd, cwd, { command: "echo hi", background: true });
    expect(pm.write("ws", info.id, "y\r")).toBe(false);
  });
});

describe("stripTerminalCodes", () => {
  it("removes colour, cursor and window-title sequences", () => {
    expect(stripTerminalCodes("\x1b]0;Title\x07\x1b[32mok\x1b[0m\r\n\x1b[?25l")).toBe("ok\n");
  });
});
