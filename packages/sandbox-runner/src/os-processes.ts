/**
 * Processes the process manager has lost track of.
 *
 * ## How they are lost
 *
 * Every command runs as `shell → command → whatever it starts`, and the
 * manager holds the shell. Killing the shell's tree reaches everything — as
 * long as the shell is alive. When the gateway dies abruptly (a crash, its
 * terminal closed, a hard stop), Windows does not take its children with it;
 * the shell then dies on its broken output pipe, and what it started — `npm
 * run dev`, and the Vite under it — lives on with no parent, holding a port,
 * known to nothing. The next gateway has no record of it, deleting the
 * session finds nothing to stop, and `taskkill /T` cannot walk down from a
 * shell that no longer exists. Found on 24 Sep 2026: Vite still serving
 * :5173 for a session deleted hours before.
 *
 * ## Finding them again
 *
 * A stray is recognised by where it runs: its command line names the
 * workspace directory, as every tool started from `node_modules/.bin` does.
 * From there the launchers above it — `cmd /c vite`, `npm run dev` — are
 * climbed to, so the whole tree goes, and the climb stops at anything that is
 * not a launcher, at the gateway itself, and at anything that is not dead-ended
 * (a live parent that is not a launcher is somebody's terminal, and is left
 * alone).
 */

import { execFile, spawn } from "node:child_process";
import os from "node:os";
import path from "node:path";

export interface OsProcess {
  pid: number;
  ppid: number;
  name: string;
  cmd: string;
}

const isWindows = process.platform === "win32";
// Built from code points, not an escape in the source: C0 controls and DEL.
const CONTROL_CHARS = new RegExp(`[${String.fromCharCode(0)}-${String.fromCharCode(31)}${String.fromCharCode(127)}]`, "g");

/** Programs that only exist to start another: safe to climb through, and to kill with what they started. */
const LAUNCHER = /^(node|node\.exe|cmd|cmd\.exe|npm|npx|pnpm|yarn|bun|sh|bash|dash|conhost\.exe)$/i;

/**
 * Whether a parent only started the stray, and goes with it.
 *
 * A shell wrapper (`cmd /c vite`) always. Node only when it is a package
 * runner (`npm run dev`, `npx`, pnpm, yarn) or itself runs from the
 * workspace — never an arbitrary Node program, which could be an editor, a
 * website's dev server, or this very host.
 */
function isLauncherFor(parent: OsProcess, dir: string): boolean {
  if (!LAUNCHER.test(parent.name)) return false;
  if (!/^node(\.exe)?$/i.test(parent.name)) return true;
  return /npm-cli\.js|npx-cli\.js|[\\/]pnpm|[\\/]yarn|[\\/]bun|[\\/]\.bin[\\/]/i.test(parent.cmd) || runsFrom(parent.cmd, dir);
}

/** Every process on the machine, with its parent and command line. Empty if they cannot be listed. */
export function listOsProcesses(): Promise<OsProcess[]> {
  return new Promise((resolve) => {
    if (isWindows) {
      execFile(
        "powershell.exe",
        [
          "-NoProfile",
          "-NonInteractive",
          "-Command",
          "Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,Name,CommandLine | ConvertTo-Json -Compress",
        ],
        { windowsHide: true, maxBuffer: 64 * 1024 * 1024, timeout: 30_000 },
        (err, stdout) => {
          if (err) return resolve([]);
          try {
            /*
             * Windows PowerShell's ConvertTo-Json leaves some control characters
             * unescaped, so one process with an odd command line made the whole
             * list unreadable — and the sweep silently found nothing. The
             * compressed output has no whitespace of its own to lose.
             */
            const rows = JSON.parse(stdout.replace(CONTROL_CHARS, " ")) as
              | { ProcessId: number; ParentProcessId: number; Name: string; CommandLine: string | null }[]
              | { ProcessId: number; ParentProcessId: number; Name: string; CommandLine: string | null };
            resolve(
              (Array.isArray(rows) ? rows : [rows]).map((r) => ({
                pid: r.ProcessId,
                ppid: r.ParentProcessId,
                name: r.Name ?? "",
                cmd: r.CommandLine ?? "",
              })),
            );
          } catch {
            resolve([]);
          }
        },
      );
    } else {
      execFile("ps", ["-eo", "pid=,ppid=,comm=,args="], { maxBuffer: 64 * 1024 * 1024, timeout: 30_000 }, (err, stdout) => {
        if (err) return resolve([]);
        resolve(
          stdout
            .split("\n")
            .map((line) => /^\s*(\d+)\s+(\d+)\s+(\S+)\s*(.*)$/.exec(line))
            .filter((m): m is RegExpExecArray => m !== null)
            .map((m) => ({ pid: Number(m[1]), ppid: Number(m[2]), name: path.basename(m[3]!), cmd: m[4] ?? "" })),
        );
      });
    }
  });
}

/** `ps`'s cumulative CPU time, `[[dd-]hh:]mm:ss[.ff]`, in seconds. */
export function psSeconds(time: string): number {
  const [days, rest] = time.includes("-") ? [Number(time.split("-")[0]), time.split("-")[1]!] : [0, time];
  const parts = rest.split(":").map(Number);
  const seconds = parts.reduce((sum, p) => sum * 60 + (Number.isFinite(p) ? p : 0), 0);
  return days * 86_400 + seconds;
}

/**
 * The CPU time used so far by a process and everything below it, in seconds,
 * or null when the system will not say. What tells a job that is working
 * quietly (a training run logging to its own file) from one that has hung.
 */
export function treeCpuSeconds(pid: number): Promise<number | null> {
  return new Promise((resolve) => {
    const total = (rows: { pid: number; ppid: number; seconds: number }[]): number | null => {
      const children = new Map<number, number[]>();
      for (const r of rows) if (r.pid !== r.ppid) children.set(r.ppid, [...(children.get(r.ppid) ?? []), r.pid]);
      const byPid = new Map(rows.map((r) => [r.pid, r.seconds]));
      if (!byPid.has(pid)) return null;
      let sum = 0;
      const queue = [pid];
      const seen = new Set<number>();
      while (queue.length > 0 && seen.size < 500) {
        const next = queue.shift()!;
        if (seen.has(next)) continue;
        seen.add(next);
        sum += byPid.get(next) ?? 0;
        queue.push(...(children.get(next) ?? []));
      }
      return sum;
    };
    if (isWindows) {
      execFile(
        "powershell.exe",
        [
          "-NoProfile",
          "-NonInteractive",
          "-Command",
          "Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,KernelModeTime,UserModeTime | ConvertTo-Json -Compress",
        ],
        { windowsHide: true, maxBuffer: 32 * 1024 * 1024, timeout: 30_000 },
        (err, stdout) => {
          if (err) return resolve(null);
          try {
            const raw = JSON.parse(stdout) as
              | { ProcessId: number; ParentProcessId: number; KernelModeTime: number | null; UserModeTime: number | null }[]
              | { ProcessId: number; ParentProcessId: number; KernelModeTime: number | null; UserModeTime: number | null };
            // Both in units of 100 nanoseconds.
            const rows = (Array.isArray(raw) ? raw : [raw]).map((r) => ({
              pid: r.ProcessId,
              ppid: r.ParentProcessId,
              seconds: ((Number(r.KernelModeTime) || 0) + (Number(r.UserModeTime) || 0)) / 1e7,
            }));
            resolve(total(rows));
          } catch {
            resolve(null);
          }
        },
      );
      return;
    }
    execFile("ps", ["-eo", "pid=,ppid=,time="], { maxBuffer: 16 * 1024 * 1024, timeout: 30_000 }, (err, stdout) => {
      if (err) return resolve(null);
      const rows = stdout
        .split("\n")
        .map((line) => /^\s*(\d+)\s+(\d+)\s+(\S+)/.exec(line))
        .filter((m): m is RegExpExecArray => m !== null)
        .map((m) => ({ pid: Number(m[1]), ppid: Number(m[2]), seconds: psSeconds(m[3]!) }));
      resolve(total(rows));
    });
  });
}

const norm = (s: string): string => s.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();

/**
 * Whether sweeping a directory would reach things that are not a workspace's.
 *
 * Temp, home and the host's own directory — or anything above them — are named
 * by the command lines of shells, editors and the host's own tools: a sweep of
 * `%TEMP%` matched the very shell that ran it, because its command line
 * exports TEMP. A workspace is always a directory of its own below these.
 */
export function tooBroad(dir: string): boolean {
  const d = norm(path.resolve(dir));
  return [os.tmpdir(), os.homedir(), process.cwd()].map((p) => norm(path.resolve(p))).some((p) => p === d || p.startsWith(`${d}/`));
}

/** Whether a command line runs from inside a directory. */
export function runsFrom(cmd: string, dir: string): boolean {
  const d = norm(dir);
  if (d.length < 8) return false; // Never match a root, a drive, or something as broad.
  const c = norm(cmd);
  return c.includes(`${d}/`) || c.endsWith(d) || c.includes(`${d}"`) || c.includes(`${d} `);
}

/**
 * The tops of the process trees running from `dir`: each process whose
 * command line names it, climbed through the launchers that started it.
 * `protect` are processes never climbed into or returned — the gateway and
 * its ancestors.
 */
export function strayRoots(all: OsProcess[], dir: string, protect: Set<number>): OsProcess[] {
  if (tooBroad(dir)) return [];
  const byPid = new Map(all.map((p) => [p.pid, p]));
  const roots = new Map<number, OsProcess>();
  for (const p of all) {
    if (protect.has(p.pid) || !runsFrom(p.cmd, dir)) continue;
    let top = p;
    for (let depth = 0; depth < 8; depth++) {
      const parent = byPid.get(top.ppid);
      if (!parent || protect.has(parent.pid) || !isLauncherFor(parent, dir)) break;
      top = parent;
    }
    roots.set(top.pid, top);
  }
  // A root inside another root's tree is killed with it.
  const inside = (p: OsProcess, ancestor: number): boolean => {
    for (let q = byPid.get(p.ppid), depth = 0; q && depth < 32; q = byPid.get(q.ppid), depth++) if (q.pid === ancestor) return true;
    return false;
  };
  return [...roots.values()].filter((r) => ![...roots.keys()].some((other) => other !== r.pid && inside(r, other)));
}

/** This process and every ancestor it has: never to be killed by a sweep. */
export function selfAndAncestors(all: OsProcess[]): Set<number> {
  const byPid = new Map(all.map((p) => [p.pid, p]));
  const out = new Set<number>([process.pid]);
  for (let p = byPid.get(process.pid), depth = 0; p && depth < 32; p = byPid.get(p.ppid), depth++) out.add(p.ppid);
  return out;
}

/** Kill a process and everything below it. Resolves when the kill has been issued and answered. */
export function killOsTree(pid: number): Promise<void> {
  return new Promise((resolve) => {
    if (isWindows) {
      const killer = spawn("taskkill", ["/F", "/T", "/PID", String(pid)], { stdio: "ignore", windowsHide: true });
      killer.once("error", () => resolve());
      killer.once("exit", () => resolve());
      return;
    }
    try {
      process.kill(-pid, "SIGKILL"); // Its process group, when it leads one.
    } catch {
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        // Already gone.
      }
    }
    resolve();
  });
}

/** A remembered process: its id, and the program it was, so a reused id is never mistaken for it. */
export interface Remembered {
  pid: number;
  name: string;
}

/** Everything below `pid`, as it stands. */
export function descendantsOf(all: OsProcess[], pid: number): Remembered[] {
  const children = new Map<number, OsProcess[]>();
  for (const p of all) {
    if (p.pid === p.ppid) continue;
    const list = children.get(p.ppid) ?? [];
    list.push(p);
    children.set(p.ppid, list);
  }
  const out: Remembered[] = [];
  const queue = [pid];
  const seen = new Set<number>([pid]);
  while (queue.length > 0 && out.length < 200) {
    for (const child of children.get(queue.shift()!) ?? []) {
      if (seen.has(child.pid)) continue;
      seen.add(child.pid);
      out.push({ pid: child.pid, name: child.name });
      queue.push(child.pid);
    }
  }
  return out;
}

/**
 * Kill remembered processes that are still the program they were.
 *
 * For a tree whose top has already died — a shell killed with its host, or a
 * command that exited while what it started kept running — this is the only
 * way down: nothing links the survivors to anything still alive, and a server
 * started as `node server.js` does not even name its directory.
 */
export async function killRemembered(remembered: Remembered[], all?: OsProcess[]): Promise<number> {
  if (remembered.length === 0) return 0;
  const now = all ?? (await listOsProcesses());
  const current = new Map(now.map((p) => [p.pid, p.name.toLowerCase()]));
  const protect = selfAndAncestors(now);
  const live = remembered.filter((r) => !protect.has(r.pid) && current.get(r.pid) === r.name.toLowerCase());
  await Promise.all(live.map((r) => killOsTree(r.pid)));
  return live.length;
}

/**
 * Kill every process still running from `dir` that nobody tracks. Returns
 * what was killed, for the log.
 */
export async function killStrays(dir: string): Promise<OsProcess[]> {
  const all = await listOsProcesses();
  if (all.length === 0) return [];
  const roots = strayRoots(all, dir, selfAndAncestors(all));
  await Promise.all(roots.map((r) => killOsTree(r.pid)));
  return roots;
}
