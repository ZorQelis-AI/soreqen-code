/**
 * Kills what a host started, once the host is gone.
 *
 * A host that shuts down properly stops its processes itself. One that is
 * killed — a crash, its terminal closed, a hard stop — cannot, and on Windows
 * its children outlive it: a dev server keeps its port, known to nothing, and
 * the next host cannot even see it. This runs beside the host as a separate,
 * detached process, checks every second that the host is alive, and when it
 * is not, kills every process tree the host had registered — by process id,
 * and by workspace directory for anything whose shell has already died.
 *
 * It exits on its own when the host removes the registry (a proper shutdown,
 * where there is nothing left to do), and after its one sweep.
 *
 *   node reaper.js <host pid> <registry file>
 */

import fs from "node:fs";
import { killRemembered, killStrays, listOsProcesses, type Remembered } from "./os-processes.js";

interface Registry {
  /** `dir` only for a directory the host made for one workspace; see `ProcessManagerOptions.ownsDir`. */
  roots: { pid?: number; name?: string; dir?: string; tree?: Remembered[] }[];
}

const hostPid = Number(process.argv[2]);
const registry = process.argv[3] ?? "";

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM: it exists, it just is not ours to signal.
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

async function sweep(): Promise<void> {
  let roots: Registry["roots"] = [];
  try {
    roots = (JSON.parse(fs.readFileSync(registry, "utf8")) as Registry).roots ?? [];
  } catch {
    // Nothing readable: nothing to do.
  }
  const all = await listOsProcesses();
  // Each tree's top, if it is still the program it was; then what each had started; then by directory.
  const tops: Remembered[] = roots.flatMap((r) => (r.pid !== undefined && r.name ? [{ pid: r.pid, name: r.name }] : []));
  await killRemembered(tops, all);
  await killRemembered(roots.flatMap((r) => r.tree ?? []), all);
  for (const dir of new Set(roots.flatMap((r) => (r.dir ? [r.dir] : [])))) await killStrays(dir).catch(() => []);
  fs.rmSync(registry, { force: true });
}

if (!Number.isInteger(hostPid) || hostPid <= 0 || !registry) process.exit(0);

const timer = setInterval(() => {
  if (!fs.existsSync(registry)) process.exit(0);
  if (alive(hostPid)) return;
  clearInterval(timer);
  void sweep().finally(() => process.exit(0));
}, 1_000);
