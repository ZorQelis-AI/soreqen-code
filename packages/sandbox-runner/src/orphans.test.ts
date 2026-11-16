/**
 * Processes nobody tracks any more — found by where they run, and killed.
 *
 * Reported 24 Sep 2026: Vite still serving :5173 for a session deleted hours
 * before. Its shell had died with the gateway that started it; `npm run dev`
 * and Vite lived on with no parent and no record anywhere.
 */

import { spawn } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { LocalSandboxRunner } from "./local-runner.js";
import { killStrays, runsFrom, strayRoots, tooBroad, type OsProcess } from "./os-processes.js";

/** A port nothing else here uses — a fixed one is still held by a server a failed run left behind. */
const freshPort = (): number => 20_000 + Math.floor(Math.random() * 20_000);

const listening = (port: number): Promise<boolean> =>
  new Promise((resolve) => {
    const s = net.connect(port, "127.0.0.1");
    s.once("connect", () => (s.destroy(), resolve(true)));
    s.once("error", () => resolve(false));
  });

async function until(check: () => Promise<boolean>, ms: number): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await check()) return true;
    await new Promise((r) => setTimeout(r, 250));
  }
  return check();
}

/** A server that runs from `dir` (its script lives there), started so that it outlives its launcher. */
function orphanServer(dir: string, port: number): void {
  fs.writeFileSync(path.join(dir, "server.js"), `require("http").createServer((q, s) => s.end("ok")).listen(${port});`);
  // The launcher starts the server detached and exits at once: the server is an orphan, like Vite was.
  const launcher = spawn(
    process.execPath,
    ["-e", `require("child_process").spawn(process.execPath, [${JSON.stringify(path.join(dir, "server.js"))}], { detached: true, stdio: "ignore" }).unref()`],
    { stdio: "ignore", windowsHide: true },
  );
  launcher.unref();
}

describe("finding strays", () => {
  const dir = "C:/Temp/soreqen-docker-sandboxes/ws123";
  const table = (rows: [number, number, string, string][]): OsProcess[] => rows.map(([pid, ppid, name, cmd]) => ({ pid, ppid, name, cmd }));

  it("climbs from the server through the launchers that started it — as Vite was found", () => {
    const all = table([
      [7048, 5228, "node.exe", `"node" "C:\\Temp\\soreqen-docker-sandboxes\\ws123\\node_modules\\.bin\\..\\vite\\bin\\vite.js"`],
      [5228, 11648, "cmd.exe", "C:\\WINDOWS\\system32\\cmd.exe /d /s /c vite"],
      [11648, 20048, "node.exe", `"C:\\nvm4w\\nodejs\\node.exe" C:\\nvm4w\\nodejs/node_modules/npm/bin/npm-cli.js run dev`],
      // 20048, the shell, is gone.
    ]);
    expect(strayRoots(all, dir, new Set()).map((p) => p.pid)).toEqual([11648]);
  });

  it("never climbs into a terminal, an unrelated Node program, or the host", () => {
    const all = table([
      [1, 0, "explorer.exe", "explorer"],
      [2, 1, "powershell.exe", "powershell.exe"], // somebody's own terminal
      [3, 2, "node.exe", `node C:\\Temp\\soreqen-docker-sandboxes\\ws123\\server.js`],
      [4, 1, "node.exe", "node C:\\apps\\editor\\main.js"], // an editor, not a package runner
      [5, 4, "node.exe", `node C:\\Temp\\soreqen-docker-sandboxes\\ws123\\other.js`],
      [6, 1, "node.exe", "node dist/start.js"], // the host
      [7, 6, "cmd.exe", "cmd /c vite"],
      [8, 7, "node.exe", `node C:\\Temp\\soreqen-docker-sandboxes\\ws123\\node_modules\\vite\\bin\\vite.js`],
    ]);
    const roots = strayRoots(all, dir, new Set([6])).map((p) => p.pid).sort();
    // The strays themselves, and cmd (a launcher) — never 2, 4 or 6.
    expect(roots).toEqual([3, 5, 7]);
  });

  it("never sweeps Temp, home, the host's directory, or anything above them", () => {
    for (const broad of [os.tmpdir(), os.homedir(), process.cwd(), path.dirname(os.tmpdir())]) {
      expect(tooBroad(broad)).toBe(true);
      expect(strayRoots(table([[9, 1, "node.exe", `node ${broad}\\x.js`]]), broad, new Set())).toEqual([]);
    }
    expect(tooBroad(path.join(os.tmpdir(), "soreqen-docker-sandboxes", "ws123"))).toBe(false);
  });

  it("matches a directory whole, and never a root", () => {
    expect(runsFrom(`node C:\\Temp\\soreqen-docker-sandboxes\\ws123\\a.js`, dir)).toBe(true);
    expect(runsFrom(`node C:\\Temp\\soreqen-docker-sandboxes\\ws1234\\a.js`, dir)).toBe(false);
    expect(runsFrom("node C:\\anything.js", "C:/")).toBe(false);
  });
});

describe("killing strays, for real", () => {
  let base: string;
  beforeEach(() => {
    base = fs.mkdtempSync(path.join(os.tmpdir(), "sqc_strays_"));
  });
  afterEach(() => {
    try {
      fs.rmSync(base, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    } catch {
      // A process may still be letting go of it.
    }
  });

  it("kills an orphaned server by the directory it runs from", async () => {
    const dir = path.join(base, "wsA");
    fs.mkdirSync(dir);
    const port = freshPort();
    orphanServer(dir, port);
    expect(await until(() => listening(port), 10_000)).toBe(true);
    const killed = await killStrays(dir);
    expect(killed.length).toBeGreaterThan(0);
    expect(await until(async () => !(await listening(port)), 10_000)).toBe(true);
  }, 40_000);

  it("sweeps a deleted workspace's orphans at start-up, and leaves a live one's alone", async () => {
    const runner = new LocalSandboxRunner(base);
    fs.mkdirSync(path.join(base, "deadws"));
    fs.mkdirSync(path.join(base, "livews"));
    const [dead, live] = [freshPort(), freshPort() + 1];
    orphanServer(path.join(base, "deadws"), dead);
    orphanServer(path.join(base, "livews"), live);
    expect(await until(async () => (await listening(dead)) && (await listening(live)), 10_000)).toBe(true);

    const swept = await runner.sweepOrphans(async (id) => id === "livews");
    expect(swept.map((s) => s.workspaceId)).toEqual(["deadws"]);
    expect(await until(async () => !(await listening(dead)), 10_000)).toBe(true);
    expect(await listening(live)).toBe(true);

    await killStrays(path.join(base, "livews"));
  }, 40_000);

  it("kills by directory only in a workspace directory of its own — never in a repository it was handed", async () => {
    const runner = new LocalSandboxRunner(base);
    const repo = path.join(base, "users-repo");
    fs.mkdirSync(repo);
    await runner.createWorkspace("cli", { storagePath: repo });
    await runner.createWorkspace("owned");
    // The user's own dev server, started from their terminal, in the repository the workspace is.
    const [theirs, ours] = [freshPort(), freshPort() + 1];
    orphanServer(repo, theirs);
    orphanServer(path.join(base, "owned"), ours);
    expect(await until(async () => (await listening(theirs)) && (await listening(ours)), 10_000)).toBe(true);

    await runner.killStrayProcesses("cli");
    await runner.killStrayProcesses("owned");
    expect(await until(async () => !(await listening(ours)), 10_000)).toBe(true);
    expect(await listening(theirs)).toBe(true);

    await killStrays(repo);
  }, 40_000);
});

describe("the reaper", () => {
  it("kills what a host started once the host is killed outright", async () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), "sqc_reaper_"));
    const dir = path.join(base, "ws");
    fs.mkdirSync(dir);
    // A pid file, so the server is killed even if the reaper is not what killed it.
    const port = freshPort();
    const pidFile = path.join(base, "server.pid");
    fs.writeFileSync(
      path.join(dir, "server.js"),
      `require("fs").writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); require("http").createServer((q, s) => s.end("ok")).listen(${port});`,
    );
    // A stand-in gateway: starts a background server through the real process manager, then waits to be killed.
    const manager = new URL("./process-manager.js", import.meta.url).href.replace(/\/src\//, "/dist/");
    const host = spawn(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `import { ProcessManager } from ${JSON.stringify(manager)};
         const m = new ProcessManager();
         m.start("ws", ${JSON.stringify(dir)}, ${JSON.stringify(dir)}, { command: "node server.js", background: true });
         setInterval(() => {}, 1000);`,
      ],
      { stdio: "ignore", windowsHide: true, env: { ...process.env, SOREQEN_NO_REAPER: "" } },
    );
    try {
      expect(await until(() => listening(port), 15_000)).toBe(true);
      // Long enough for the manager to have noted what the command started.
      await new Promise((r) => setTimeout(r, 4_000));
      // Killed outright: no shutdown hook runs, exactly the case that orphaned Vite.
      host.kill("SIGKILL");
      expect(await until(async () => !(await listening(port)), 15_000)).toBe(true);
    } finally {
      host.kill("SIGKILL");
      try {
        process.kill(Number(fs.readFileSync(pidFile, "utf8")));
      } catch {
        // Gone already — the reaper's work.
      }
      try {
        fs.rmSync(base, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
      } catch {
        // Let go of later.
      }
    }
  }, 60_000);
});

