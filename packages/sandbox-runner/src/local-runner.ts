/**
 * Local Process Sandbox Runner
 * Production-Grade V2 Implementation (Intelligent Background Daemon Management)
 */

import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import type {
  SandboxRunner,
  SandboxOptions,
  ExecCommandOptions,
  ExecCommandResult,
  FileEntry,
  ListOptions,
  ProcessEvent,
  ProcessInfo,
  ProcessStopper,
  StartProcessOptions,
  WorkspaceInspection,
} from "./types.js";
import { guardPath, validateCommandSafety, validateProgramSafety } from "./security.js";
import { ENV_ALLOWLIST, HARD_BUFFER_LIMIT, clampOutput, killTree, shellInvocation } from "./shell.js";
import { ProcessManager } from "./process-manager.js";
import { stripTerminalCodes } from "./pty.js";
import { killOsTree, killStrays, listOsProcesses, selfAndAncestors, strayRoots, tooBroad } from "./os-processes.js";

/**
 * Directory names a walk never enters.
 *
 * Dependencies, build output, virtualenvs and editor state. All of it is
 * reproducible from a manifest, none of it is what anyone means by "the
 * codebase", and together they are the overwhelming majority of the files in a
 * real project.
 */
const NEVER_WALK = new Set([
  ".git",
  "node_modules",
  ".soreqen",
  "dist",
  "build",
  "out",
  "coverage",
  ".next",
  ".nuxt",
  ".turbo",
  ".venv",
  "venv",
  "__pycache__",
  ".mypy_cache",
  ".pytest_cache",
  "target",
  "vendor",
  ".gradle",
  ".cache",
  ".idea",
  ".vscode",
  ".terraform",
  "Pods",
]);

/**
 * The most entries one listing returns.
 *
 * A recursive listing of a large repository can run to hundreds of thousands
 * of entries, all of which are held in memory, serialised, and — if a tool
 * asked for them — sent to a model. Truncating is the honest failure: the
 * caller gets a large, useful sample instead of an out-of-memory crash.
 */
const MAX_LISTED_ENTRIES = 20_000;

/** The most entries one listing looks at, kept or not: a filtered walk of a huge tree stops here. */
const MAX_VISITED_ENTRIES = 500_000;

interface LocalWorkspaceRecord {
  id: string;
  path: string;
  createdAt: Date;
  status: "active" | "stopped" | "destroyed";
  /** Made by the runner for this workspace alone, rather than handed to it (`storagePath`: a user's repository). */
  owned: boolean;
  /** Where `.soreqen/` resolves, outside the workspace; see `SandboxOptions.dataPath`. */
  dataPath?: string;
}

const within = (root: string, p: string): boolean => {
  const rel = path.relative(path.resolve(root), p);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
};

/** A path from a drive or a share on Windows; from `/` anywhere else. */
const isFullPath = (raw: string): boolean =>
  process.platform === "win32" ? /^[A-Za-z]:[\\/]/.test(raw) || /^\\\\[^\\]/.test(raw) : raw.startsWith("/");

/** The root as written and as it really is: on macOS a temp folder under /var is /private/var. */
function rootForms(root: string): string[] {
  const resolved = path.resolve(root);
  try {
    const real = fs.realpathSync(resolved);
    return real === resolved ? [resolved] : [resolved, real];
  } catch {
    return [resolved];
  }
}

/**
 * `target` as a path inside the project, for `guardPath`.
 *
 * A full path that is already inside the project names that file, whichever
 * form of the project's path it was written in. A path written from the
 * root, `/src/app.ts` (or `\src\app.ts`), means the project's own `src`:
 * models write it that way, and `elsewhereOnDisk` has already claimed the
 * ones that name a real place outside the project. Anything else is relative
 * already.
 *
 * Before this, both cases went to `guardPath` as they were, and it stripped
 * the slash from every one of them, so on Linux and macOS a full path inside
 * the project was read and written under the project a second time.
 */
function projectPath(ws: LocalWorkspaceRecord, target: string): string {
  const raw = target.trim();
  if (isFullPath(raw)) {
    const full = path.resolve(raw);
    for (const root of rootForms(ws.path)) {
      if (within(root, full)) return path.relative(root, full) || ".";
    }
  }
  if (/^[\\/](?![\\/])/.test(raw)) return raw.replace(/^[\\/]+/, "");
  return raw;
}

/**
 * `target` as a place on disk outside both the workspace and its data folder,
 * or null when it is one of theirs (or not a full path at all).
 *
 * A drive path (`C:\…`) or a share (`\\server\…`) is unambiguous. A path from
 * the root on Linux or macOS is not: models write `/src/app.ts` meaning the
 * project's `src`, and that has always resolved inside the workspace. It
 * still does, unless the project has no such place and the computer does.
 */
function elsewhereOnDisk(ws: LocalWorkspaceRecord, target: string): string | null {
  const raw = target.trim();
  let full: string | null = null;
  if (/^[A-Za-z]:[\\/]/.test(raw) || /^\\\\[^\\]/.test(raw)) {
    full = path.resolve(raw);
  } else if (process.platform !== "win32" && raw.startsWith("/")) {
    const inProject = path.resolve(ws.path, raw.slice(1));
    if (fs.existsSync(inProject) || fs.existsSync(path.dirname(inProject))) return null;
    if (fs.existsSync(raw) || fs.existsSync(path.dirname(raw))) full = path.resolve(raw);
  }
  if (!full) return null;
  const inside = (root: string): boolean => rootForms(root).some((r) => within(r, full!));
  if (inside(ws.path) || (ws.dataPath && inside(ws.dataPath))) return null;
  return full;
}

/**
 * Where a project folder's `.soreqen/` is kept: `<home>/projects/<name>-<hash>`.
 *
 * The name is there to be read; the hash of the full path is what keeps two
 * folders called `app` apart. One folder always gets the same place, so its
 * checkpoints and task state are found again in the next session.
 */
export function projectDataPath(folder: string, soreqenHome: string): string {
  const abs = path.resolve(folder);
  const key = process.platform === "win32" ? abs.toLowerCase() : abs;
  const name = (path.basename(abs) || "project").replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 40);
  return path.join(soreqenHome, "projects", `${name}-${createHash("sha256").update(key).digest("hex").slice(0, 8)}`);
}

/** What under `.soreqen/` the person writes, and so stays in the project. */
const PROJECT_OWNED = ["skills", "mcp.json", "rules.md"];

/**
 * Moves what SoreQen generated in `<project>/.soreqen/` to the data folder.
 *
 * Moves, never deletes: each entry is renamed only when nothing of that name
 * is there yet, and one that cannot be moved (in use, on another drive) is
 * left where it is. The project's `.soreqen/` goes only once it is empty —
 * a person's own skills keep it.
 */
function moveOutOfProject(project: string, dataPath: string): void {
  const old = path.join(project, ".soreqen");
  let names: string[];
  try {
    names = fs.readdirSync(old);
  } catch {
    return;
  }
  for (const name of names) {
    if (PROJECT_OWNED.includes(name)) continue;
    const to = path.join(dataPath, name);
    if (fs.existsSync(to)) continue;
    try {
      fs.renameSync(path.join(old, name), to);
    } catch {
      // In use, or across drives: left in place.
    }
  }
  try {
    if (fs.readdirSync(old).length === 0) fs.rmdirSync(old);
  } catch {
    // Not empty, or gone.
  }
}

export class LocalSandboxRunner implements SandboxRunner {
  private workspaces = new Map<string, LocalWorkspaceRecord>();
  private defaultBaseDir: string;
  private runningDaemons = new Map<string, ChildProcess[]>();
  /** Commands run through `startProcess`. See `process-manager.ts`. */
  private readonly processes = new ProcessManager({ ownsDir: (dir) => this.ownsDir(dir) });

  constructor(baseDir?: string) {
    this.defaultBaseDir = baseDir ?? process.cwd();
  }

  /**
   * Resolve a workspace, and refuse an id that names none.
   *
   * ## What this used to do
   *
   * It created one. An unknown id — a typo, a stale id from a previous
   * process, an id belonging to a workspace that had just been destroyed —
   * silently produced a live record whose path was `defaultBaseDir`, the
   * directory *containing* every workspace. The function is named
   * `getWorkspaceOrThrow` and could not throw.
   *
   * Two consequences, both quiet. A destroyed workspace came back to life on
   * the next tool call, so `destroyWorkspace` did not end anything. And a
   * caller holding any string at all got a working sandbox rooted at the
   * shared parent — where `guardPath` would then correctly confine it, having
   * been handed the wrong boundary to confine it to.
   *
   * Throwing is the whole fix. A tool call against an id that does not exist
   * is a bug in the caller, and the caller is the one place it can be found.
   */
  private async getWorkspaceOrThrow(workspaceId: string): Promise<LocalWorkspaceRecord> {
    const ws = this.workspaces.get(workspaceId);
    if (!ws) {
      throw new Error(
        `Workspace '${workspaceId}' does not exist. Create it with createWorkspace() first.`,
      );
    }
    if (ws.status !== "active") {
      throw new Error(`Workspace '${workspaceId}' is ${ws.status} and cannot be used.`);
    }
    return ws;
  }

  async createWorkspace(
    workspaceId: string,
    options?: Partial<SandboxOptions>,
  ): Promise<WorkspaceInspection> {
    /*
     * A workspace with no directory named for it gets its own, not the shared
     * parent.
     *
     * This defaulted to `defaultBaseDir` itself, so every workspace the
     * gateway created — which passes no `storagePath`, because "give me a
     * sandbox" is the whole request — resolved to the *same* directory. Two
     * tenants got two database rows, two ownership checks that both passed,
     * and one folder on disk. The isolation was real everywhere except where
     * the files are.
     *
     * `storagePath` still wins outright, because that is how the CLI says
     * "the workspace is this repository, which already exists" — and putting
     * a subdirectory under someone's project would be the same bug pointing
     * the other way.
     */
    const targetDir = options?.storagePath ?? path.join(this.defaultBaseDir, workspaceId);

    if (!fs.existsSync(targetDir)) {
      fs.mkdirSync(targetDir, { recursive: true });
    }

    const record: LocalWorkspaceRecord = {
      id: workspaceId,
      path: targetDir,
      createdAt: new Date(),
      status: "active",
      owned: !options?.storagePath,
    };
    if (options?.dataPath) {
      fs.mkdirSync(options.dataPath, { recursive: true });
      record.dataPath = path.resolve(options.dataPath);
      moveOutOfProject(targetDir, record.dataPath);
    }

    this.workspaces.set(workspaceId, record);
    this.runningDaemons.set(workspaceId, []);

    return {
      workspaceId,
      status: "active",
      workspacePath: targetDir,
      createdAt: record.createdAt,
    };
  }

  dataPathOf(workspaceId: string): string | null {
    return this.workspaces.get(workspaceId)?.dataPath ?? null;
  }

  /**
   * A deleted session's task state and artifacts, gone with it.
   *
   * They were never removed: a session's `.soreqen/state/<id>.json` and
   * `.soreqen/artifacts/<id>/` (megabytes, for a long one) stayed for ever
   * after the session itself was deleted (28 Sep 2026 audit). Only those two
   * places, by the same names the engine gives them, resolved like every
   * other `.soreqen/` path — so nothing of the project can be touched.
   */
  async removeSessionData(workspaceId: string, sessionId: string): Promise<void> {
    const ws = this.workspaces.get(workspaceId);
    if (!ws) return;
    const safe = sessionId.replace(/[^\w.-]/g, "_");
    if (!safe || safe === "." || safe === "..") return;
    const stateDir = this.resolve(ws, ".soreqen/state");
    try {
      for (const name of fs.readdirSync(stateDir)) {
        if (name === `${safe}.json` || (name.startsWith(`${safe}_sub_`) && name.endsWith(".json"))) {
          fs.rmSync(path.join(stateDir, name), { force: true });
        }
      }
    } catch {
      // No state kept.
    }
    fs.rmSync(this.resolve(ws, `.soreqen/artifacts/${safe}`), { recursive: true, force: true });
  }

  /**
   * A path the workspace was given, on disk.
   *
   * Inside the project, as ever — unless the workspace keeps `.soreqen/`
   * elsewhere: then `.soreqen/…` (bar what the person owns) resolves into the
   * data folder, and so does an absolute path already inside it, which is
   * how the agent is shown its scratchpad. Each is confined to its own root.
   */
  private resolve(ws: LocalWorkspaceRecord, target: string): string {
    const data = ws.dataPath;
    /*
     * A full path to somewhere else on this computer is taken as given.
     *
     * This runner is the person's own machine — a cloud sandbox is
     * `@sqcode/sandbox-cloud` — and `run_command` could always reach any
     * folder on it. Only the file tools could not: asked to read
     * `D:\Notes\plan.md`, the agent was refused and went round through the
     * shell instead (reported 1 Oct 2026). Whether a write out there needs
     * asking about is the mode's question; see `isOutsideWorkspace`.
     */
    const elsewhere = elsewhereOnDisk(ws, target);
    if (elsewhere) return elsewhere;
    if (data) {
      const raw = target.trim();
      if (path.isAbsolute(raw)) {
        for (const root of rootForms(data)) {
          const rel = path.relative(root, path.resolve(raw));
          if (rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel))) return guardPath(data, rel);
        }
      }
      const slashed = raw.replace(/\\/g, "/").replace(/^\.\//, "");
      const m = /^\.soreqen(?:\/+(.*))?$/.exec(slashed);
      if (m) {
        const rest = (m[1] ?? "").replace(/\/+$/, "");
        const owned = PROJECT_OWNED.some((o) => rest === o || rest.startsWith(`${o}/`));
        if (!owned) return guardPath(data, rest);
      }
    }
    return guardPath(ws.path, projectPath(ws, target));
  }

  /** Whether a file tool's path lands outside the project and its data folder. */
  isOutsideWorkspace(workspaceId: string, target: string): boolean {
    const ws = this.workspaces.get(workspaceId);
    return ws ? elsewhereOnDisk(ws, target) !== null : false;
  }

  private workspaceDir(workspaceId: string): string {
    return this.workspaces.get(workspaceId)?.path ?? path.join(this.defaultBaseDir, workspaceId);
  }

  /**
   * Whether a directory is one this runner made for a single workspace — the
   * only kind anything may be killed for merely running from. A directory it
   * was handed is the user's: their own terminal's dev server runs there too.
   */
  private ownsDir(dir: string): boolean {
    const key = (p: string): string => {
      const r = path.resolve(p);
      return process.platform === "win32" ? r.toLowerCase() : r;
    };
    const d = key(dir);
    if (key(path.dirname(d)) !== key(this.defaultBaseDir)) return false;
    const ws = [...this.workspaces.values()].find((w) => key(w.path) === d);
    return ws ? ws.owned : true;
  }

  async killStrayProcesses(workspaceId: string): Promise<number> {
    // What its commands were seen to start, by id — then, in a directory of its own, whatever else runs there.
    const leftovers = await this.processes.killLeftovers(workspaceId).catch(() => 0);
    const dir = this.workspaceDir(workspaceId);
    if (!this.ownsDir(dir)) return leftovers;
    return leftovers + (await killStrays(dir)).length;
  }

  async sweepOrphans(isLive: (workspaceId: string) => Promise<boolean>): Promise<{ workspaceId: string; killed: number }[]> {
    const all = await listOsProcesses();
    if (all.length === 0) return [];
    const slashes = (s: string): string => s.split("\\").join("/").toLowerCase();
    const base = `${slashes(this.defaultBaseDir).replace(/\/+$/, "")}/`;
    // A base shared with other things — Temp itself, the host's directory — would make every folder in it look like a workspace.
    if (base.length < 9 || tooBroad(this.defaultBaseDir)) return [];
    // The workspaces something is still running from, by the directory in its command line.
    const ids = new Set<string>();
    for (const p of all) {
      const cmd = slashes(p.cmd);
      const at = cmd.indexOf(base);
      if (at === -1) continue;
      const id = /^[\w-]+/.exec(cmd.slice(at + base.length))?.[0];
      if (id) ids.add(id);
    }
    const protect = selfAndAncestors(all);
    const out: { workspaceId: string; killed: number }[] = [];
    for (const id of ids) {
      if (await isLive(id).catch(() => true)) continue;
      const roots = strayRoots(all, path.join(this.defaultBaseDir, id), protect);
      await Promise.all(roots.map((r) => killOsTree(r.pid)));
      if (roots.length > 0) out.push({ workspaceId: id, killed: roots.length });
    }
    return out;
  }

  /*
   * Everything this runner started, stopped before the host exits.
   *
   * Without it, restarting the gateway orphaned every background command it
   * had started: a dev server kept its port, and the next one the agent
   * started failed with "address in use" for a reason nobody could see.
   */
  async shutdown(): Promise<void> {
    await this.processes.stopAll();
    for (const daemons of this.runningDaemons.values()) {
      for (const child of daemons) killTree(child);
    }
    this.runningDaemons.clear();
  }

  writeProcessInput(workspaceId: string, processId: string, data: string): boolean {
    return this.processes.write(workspaceId, processId, data);
  }

  async destroyWorkspace(workspaceId: string): Promise<void> {
    await this.processes.stopWorkspace(workspaceId);
    // The whole tree: `child.kill` on Windows ends the shell and orphans what it started.
    for (const child of this.runningDaemons.get(workspaceId) ?? []) killTree(child);
    this.runningDaemons.delete(workspaceId);
    await this.killStrayProcesses(workspaceId).catch(() => 0);

    const ws = this.workspaces.get(workspaceId);
    if (ws) {
      ws.status = "destroyed";
    }
  }

  async readFile(
    workspaceId: string,
    filePath: string,
    startLine?: number,
    endLine?: number,
  ): Promise<{ content: string; totalLines: number }> {
    const ws = await this.getWorkspaceOrThrow(workspaceId);
    const target = this.resolve(ws, filePath);

    if (!fs.existsSync(target)) {
      throw new Error(`File not found: '${filePath}' in workspace '${workspaceId}'`);
    }

    const stat = fs.statSync(target);
    if (stat.isDirectory()) {
      throw new Error(`Path is a directory, not a file: '${filePath}'`);
    }

    const rawContent = fs.readFileSync(target, "utf-8");
    const lines = rawContent.split(/\r?\n/);
    const totalLines = lines.length;

    if (startLine === undefined && endLine === undefined) {
      return { content: rawContent, totalLines };
    }

    const s = Math.max(1, startLine ?? 1);
    const e = Math.min(totalLines, endLine ?? totalLines);

    if (s > e) {
      return { content: "", totalLines };
    }

    const sliced = lines.slice(s - 1, e).join("\n");
    return { content: sliced, totalLines };
  }

  async writeFile(
    workspaceId: string,
    filePath: string,
    content: string,
    overwrite = true,
  ): Promise<{ bytesWritten: number; path: string }> {
    const ws = await this.getWorkspaceOrThrow(workspaceId);
    const target = this.resolve(ws, filePath);

    if (fs.existsSync(target) && !overwrite) {
      throw new Error(`File already exists and overwrite is false: '${filePath}'`);
    }

    const parentDir = path.dirname(target);
    if (!fs.existsSync(parentDir)) {
      fs.mkdirSync(parentDir, { recursive: true });
    }

    fs.writeFileSync(target, content, "utf-8");
    const bytesWritten = Buffer.byteLength(content, "utf-8");

    return { bytesWritten, path: filePath };
  }

  async readBinaryFile(workspaceId: string, filePath: string): Promise<Uint8Array> {
    const ws = await this.getWorkspaceOrThrow(workspaceId);
    const target = this.resolve(ws, filePath);
    if (!fs.existsSync(target)) {
      throw new Error(`File not found: '${filePath}' in workspace '${workspaceId}'`);
    }
    if (fs.statSync(target).isDirectory()) {
      throw new Error(`Path is a directory, not a file: '${filePath}'`);
    }
    return new Uint8Array(fs.readFileSync(target));
  }

  async writeBinaryFile(
    workspaceId: string,
    filePath: string,
    data: Uint8Array,
  ): Promise<{ bytesWritten: number; path: string }> {
    const ws = await this.getWorkspaceOrThrow(workspaceId);
    const target = this.resolve(ws, filePath);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, data);
    return { bytesWritten: data.byteLength, path: filePath };
  }

  async statFile(
    workspaceId: string,
    filePath: string,
  ): Promise<{ sizeBytes: number; modifiedAt: Date; type: "file" | "directory" } | null> {
    const ws = await this.getWorkspaceOrThrow(workspaceId);
    const target = this.resolve(ws, filePath);
    try {
      const stat = fs.statSync(target);
      return { sizeBytes: stat.size, modifiedAt: stat.mtime, type: stat.isDirectory() ? "directory" : "file" };
    } catch {
      return null;
    }
  }

  async startProcess(workspaceId: string, options: StartProcessOptions): Promise<ProcessInfo> {
    const ws = await this.getWorkspaceOrThrow(workspaceId);
    const cwd = options.cwd ? this.resolve(ws, options.cwd) : ws.path;
    return this.processes.start(workspaceId, ws.path, cwd, options);
  }

  getProcess(workspaceId: string, processId: string): ProcessInfo | null {
    return this.processes.get(workspaceId, processId);
  }

  listProcesses(workspaceId: string): ProcessInfo[] {
    return this.processes.list(workspaceId);
  }

  readProcessOutput(workspaceId: string, processId: string, maxChars?: number): string {
    return this.processes.output(workspaceId, processId, maxChars);
  }

  readRecentProcessOutput(workspaceId: string, processId: string, maxChars: number): string {
    return this.processes.recentOutput(workspaceId, processId, maxChars);
  }

  stopProcess(workspaceId: string, processId: string, by: ProcessStopper): Promise<ProcessInfo | null> {
    return this.processes.stop(processId, by, workspaceId);
  }

  detachProcess(workspaceId: string, processId: string): boolean {
    return this.processes.detach(workspaceId, processId);
  }

  processExited(workspaceId: string, processId: string): Promise<ProcessInfo> | null {
    return this.processes.exited(workspaceId, processId);
  }

  onProcessEvent(listener: (event: ProcessEvent) => void): () => void {
    return this.processes.onEvent(listener);
  }

  async listDirectory(
    workspaceId: string,
    dirPath = ".",
    recursive = false,
    maxDepth = 3,
    options: ListOptions = {},
  ): Promise<FileEntry[]> {
    const ws = await this.getWorkspaceOrThrow(workspaceId);
    const target = this.resolve(ws, dirPath);

    if (!fs.existsSync(target)) {
      throw new Error(`Directory not found: '${dirPath}' in workspace '${workspaceId}'`);
    }
    const inData = Boolean(ws.dataPath) && !path.relative(ws.dataPath!, target).startsWith("..") && !path.isAbsolute(path.relative(ws.dataPath!, target));
    // A folder elsewhere on the computer lists as full paths, which the file tools take back as given.
    const elsewhere = !inData && !within(ws.path, target);
    const listingRoot = inData
      ? { dir: ws.dataPath!, prefix: ".soreqen/" }
      : elsewhere
        ? { dir: target, prefix: `${target.replace(/\\/g, "/").replace(/\/$/, "")}/` }
        : { dir: ws.path, prefix: "" };

    const entries: FileEntry[] = [];
    let truncated = false;
    const maxKept = Math.min(options.maxEntries ?? MAX_LISTED_ENTRIES, MAX_LISTED_ENTRIES);
    // A filtered walk passes over what it does not keep, so it may look at far more than it returns; still bounded.
    let visited = 0;
    const stop = (): void => {
      truncated = true;
      options.onTruncated?.();
    };

    const walk = (currentDir: string, currentDepth: number) => {
      if (currentDepth > maxDepth || truncated) return;

      let items: fs.Dirent[];
      try {
        items = fs.readdirSync(currentDir, { withFileTypes: true });
      } catch {
        // A directory we cannot read is not a reason to fail the listing.
        return;
      }

      for (const item of items) {
        if (truncated) return;
        /*
         * Do not descend into it, rather than filter it out afterwards.
         *
         * This used to skip only `.git` and `node_modules` by name, so a walk
         * of a real project still descended through `dist`, `.next`,
         * `target`, `.venv` and `vendor` — calling `statSync` on every
         * generated file in them — and every caller then threw those results
         * away. On a large monorepo that is the single slowest thing the agent
         * does before it has said a word, and it is pure waste: nobody has
         * ever wanted a build artefact in a directory listing.
         */
        if (NEVER_WALK.has(item.name)) continue;

        const fullItemPath = path.join(currentDir, item.name);
        // Named as it was asked for: a listing of the data folder still says `.soreqen/…`.
        const relPath = listingRoot.prefix + path.relative(listingRoot.dir, fullItemPath).replace(/\\/g, "/");

        let type: "file" | "directory" | "symlink" = "file";
        if (item.isDirectory()) type = "directory";
        else if (item.isSymbolicLink()) type = "symlink";

        if (++visited > MAX_VISITED_ENTRIES) {
          stop();
          return;
        }
        if (options.include && !options.include(relPath, type)) {
          if (recursive && item.isDirectory() && !item.isSymbolicLink()) walk(fullItemPath, currentDepth + 1);
          continue;
        }

        /*
         * `lstat`, and never follow.
         *
         * `statSync` on a symlink reports the target — so a link pointing
         * outside the workspace was listed with the size and mtime of a file
         * the caller is not allowed to see, and a link to a directory could be
         * walked straight through the boundary `guardPath` exists to hold.
         */
        let sizeBytes = 0;
        let modifiedAt = new Date(0);
        try {
          const stat = fs.lstatSync(fullItemPath);
          sizeBytes = stat.size;
          modifiedAt = stat.mtime;
        } catch {
          // Vanished between readdir and lstat. Report it, sizeless.
        }

        entries.push({ path: relPath, name: item.name, type, sizeBytes, modifiedAt });

        if (entries.length >= maxKept) {
          stop();
          return;
        }

        // Symlinked directories are listed but never descended into.
        if (recursive && item.isDirectory() && !item.isSymbolicLink()) {
          walk(fullItemPath, currentDepth + 1);
        }
      }
    };

    walk(target, 1);
    return entries;
  }

  async execCommand(workspaceId: string, options: ExecCommandOptions): Promise<ExecCommandResult> {
    const ws = await this.getWorkspaceOrThrow(workspaceId);

    if ((options.command === undefined) === (options.argv === undefined)) {
      throw new Error(
        "execCommand needs exactly one of `command` (a shell line) or `argv` (a program and its arguments).",
      );
    }

    /*
     * The denylist reads a command line; `argv` has none.
     *
     * An argv call cannot inject, because there is no shell to inject into —
     * the program is `argv[0]` and everything after it is literal. So the
     * check runs on the shell path, and on the argv path the program name is
     * checked instead, which is both cheaper and exact.
     */
    if (options.command !== undefined) {
      validateCommandSafety(options.command);
    } else {
      validateProgramSafety(options.argv!);
    }

    /*
     * Already cancelled? Do not start.
     *
     * The signal is checked here and wired to the child below, because
     * cancellation used to stop at the tool boundary: the model's stream was
     * aborted and whatever `run_command` had already started ran to
     * completion. On the hosted surface that is a closed browser tab still
     * occupying a container.
     */
    if (options.signal?.aborted) {
      return {
        exitCode: 130,
        stdout: "",
        stderr: "Cancelled before the command started.",
        durationMs: 0,
        timedOut: false,
      };
    }

    const cwd = options.cwd ? this.resolve(ws, options.cwd) : ws.path;
    const timeoutMs = options.timeoutMs ?? 60000;
    const isWindows = process.platform === "win32";

    let commandStr = (options.command ?? "").trim();
    let isDaemon = options.isBackground ?? false;

    /*
     * The caller says whether this is a daemon. We no longer guess.
     *
     * There used to be a list of fourteen substrings — "vite", "npm start",
     * "serve ." — and any command merely *containing* one was treated as a
     * background server: resolved after 1.5 seconds with a **synthesised**
     * `exitCode: 0`, discarding the real result. So `grep -r vite .` reported
     * success and no matches, and a dev server that crashed on boot reported
     * success. A fabricated exit code is the worst thing a runner can return,
     * because everything above it is entitled to believe it.
     *
     * A trailing `&` is kept, because that is the user writing "background"
     * in the only notation a shell has.
     */
    if (commandStr.endsWith("&")) {
      isDaemon = true;
      commandStr = commandStr.replace(/&+$/, "").trim();
    }

    const startTime = Date.now();

    return new Promise((resolve) => {
      let stdout = "";
      let stderr = "";
      let timedOut = false;
      let settled = false;

      /*
       * A shell, or no shell at all.
       *
       * `argv` spawns the program directly — no interpreter between the
       * arguments and the process, which is the whole point of offering it.
       */
      const useShell = options.command !== undefined;
      /*
       * One invocation, shared with the process manager.
       *
       * This used to build its own PowerShell command line — the same flags,
       * minus the status line that `shellInvocation` exists to add. PowerShell
       * reports *any* failure as exit 1, so on this path `npm test` failing
       * with 3, or a program exiting 7, all arrived as 1. The background path
       * used `shellInvocation` and got the real code, so the two halves of
       * `run_command` disagreed about what a command did.
       *
       * That signal is what the whole verification story rests on: whether
       * the tests passed, whether a fix worked, whether to retry. There is no
       * version of this worth having twice.
       */
      const shell = useShell ? shellInvocation(commandStr) : null;
      // `npx`, `npm`, `pnpm`… are .cmd scripts on Windows, which cannot be started without a shell.
      const shim = shell ? null : windowsNodeShim(options.argv![0]!);
      const bin = shell ? shell.bin : (shim?.bin ?? options.argv![0]!);
      const binArgs = shell ? shell.args : [...(shim?.args ?? []), ...options.argv!.slice(1)];

      const allowedEnv: NodeJS.ProcessEnv = {};
      for (const key of ENV_ALLOWLIST) {
        const value = process.env[key];
        if (value !== undefined) allowedEnv[key] = value;
      }

      const child = spawn(bin, binArgs, {
        cwd,
        env: {
          ...allowedEnv,
          PYTHONUNBUFFERED: "1",
          ...options.env,
          WORKSPACE_ROOT: ws.path,
          NODE_ENV: "development",
        },
        /*
         * A process group of its own, so it can actually be killed.
         *
         * Without this the child is not a group leader, so the
         * `process.kill(-pid)` in the timeout below fails with ESRCH and falls
         * back to killing only the shell — leaving the command it spawned
         * running as an orphan. The timeout appeared to work and did not.
         */
        detached: !isWindows,
      });

      if (isDaemon) {
        const daemons = this.runningDaemons.get(workspaceId) ?? [];
        daemons.push(child);
        this.runningDaemons.set(workspaceId, daemons);
      }

      /*
       * Settle on the timeout, whatever the kill did.
       *
       * The old version set `timedOut` and waited for `close`. When the kill
       * failed — which it always did, see below — `close` never fired and the
       * promise hung for ever, taking the agent turn with it. A timeout that
       * depends on a successful kill is not a timeout.
       */
      const finishTimedOut = (): void => {
        if (settled) return;
        settled = true;
        resolve({
          exitCode: 124,
          stdout: clampOutput(stdout),
          stderr: `${clampOutput(stderr)}\nExecution timed out after ${timeoutMs}ms`,
          durationMs: Date.now() - startTime,
          timedOut: true,
          pid: child.pid,
        });
      };

      /*
       * Cancellation kills the process, not just the wait.
       *
       * Without this, aborting a turn abandoned the promise while the command
       * carried on: a `pnpm build` kept a core busy for two minutes after the
       * user pressed Ctrl-C, and on the hosted surface it kept a container.
       */
      const onAbort = (): void => {
        if (settled) return;
        killTree(child);
        settled = true;
        clearTimeout(timer);
        resolve({
          exitCode: 130,
          stdout: clampOutput(stdout),
          stderr: `${clampOutput(stderr)}\nCancelled.`,
          durationMs: Date.now() - startTime,
          timedOut: false,
          pid: child.pid,
        });
      };
      options.signal?.addEventListener("abort", onAbort, { once: true });

      const timer = setTimeout(() => {
        if (settled) return;
        timedOut = true;
        killTree(child);
        /*
         * A short grace period, then settle regardless.
         *
         * If SIGKILL worked, `close` fires within milliseconds and this timer
         * finds the promise already settled. If it did not, the caller still
         * gets an answer rather than waiting on a process nobody can reach.
         */
        setTimeout(finishTimedOut, 2_000).unref?.();
      }, timeoutMs);

      /*
       * Streamed in full, stored bounded.
       *
       * The live callbacks still see every byte — that is what makes a build
       * scroll in the terminal as it runs. What is bounded is the copy that
       * outlives the command and ends up in the model's context.
       */
      // Decoded by the stream, so a character split across two chunks survives.
      child.stdout?.setEncoding("utf8");
      child.stderr?.setEncoding("utf8");
      child.stdout?.on("data", (data) => {
        const str = data.toString();
        if (stdout.length < HARD_BUFFER_LIMIT) stdout += str;
        options.onStdout?.(str);
      });

      child.stderr?.on("data", (data) => {
        const str = data.toString();
        if (stderr.length < HARD_BUFFER_LIMIT) stderr += str;
        options.onStderr?.(str);
      });

      // If daemon process, wait 1500ms to verify startup and return early without blocking
      if (isDaemon) {
        setTimeout(() => {
          if (!settled) {
            settled = true;
            clearTimeout(timer);
            const durationMs = Date.now() - startTime;
            resolve({
              exitCode: 0,
              stdout: `[Background server process started with PID ${child.pid}]\n${stdout}`,
              stderr,
              durationMs,
              timedOut: false,
              pid: child.pid,
            });
          }
        }, 1500);
      }

      /*
       * Settled when the command exits, not only when its pipes close.
       *
       * `close` waits for every process holding stdout — including anything
       * the command started and left running (a daemon, a build service), which
       * inherits the pipe. The command itself was finished; the caller waited
       * for as long as what it left behind lived, up to the whole timeout. See
       * the same fix in `process-manager.ts`.
       */
      child.on("exit", (code) => {
        setTimeout(() => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          (child.stdout as { unref?: () => void } | null)?.unref?.();
          (child.stderr as { unref?: () => void } | null)?.unref?.();
          resolve({
            exitCode: timedOut ? 124 : (code ?? 0),
            stdout:
              clampOutput(stripTerminalCodes(stdout)) +
              "\n[The command finished, but a process it started is still running and holding its output. It was not waited for.]",
            stderr: clampOutput(stripTerminalCodes(stderr)),
            durationMs: Date.now() - startTime,
            timedOut,
            pid: child.pid,
          });
        }, 1_500).unref?.();
      });

      child.on("close", (code) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        const durationMs = Date.now() - startTime;
        resolve({
          exitCode: timedOut ? 124 : (code ?? 0),
          stdout: clampOutput(stripTerminalCodes(stdout)),
          stderr: timedOut
            ? `${clampOutput(stripTerminalCodes(stderr))}\nExecution timed out after ${timeoutMs}ms`
            : clampOutput(stripTerminalCodes(stderr)),
          durationMs,
          timedOut,
          pid: child.pid,
        });
      });

      child.on("error", (err) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        const durationMs = Date.now() - startTime;
        resolve({
          exitCode: 1,
          stdout: clampOutput(stdout),
          stderr: `${clampOutput(stderr)}\n${err.message}`,
          durationMs,
          timedOut: false,
        });
      });
    });
  }

  async getDiff(workspaceId: string): Promise<string> {
    const ws = await this.getWorkspaceOrThrow(workspaceId);
    const res = await this.execCommand(workspaceId, {
      command: "git diff HEAD",
      cwd: ws.path,
      timeoutMs: 5000,
    });
    return res.stdout;
  }

  async inspectWorkspace(workspaceId: string): Promise<WorkspaceInspection | null> {
    const ws = this.workspaces.get(workspaceId);
    if (!ws || ws.status === "destroyed") return null;
    return {
      workspaceId: ws.id,
      status: ws.status,
      workspacePath: ws.path,
      createdAt: ws.createdAt,
    };
  }
}

/*
 * A Node program's Windows launcher, run without the launcher.
 *
 * On Windows `npx`, `npm`, `pnpm` and every globally installed Node tool are
 * .cmd scripts, and Node will not start a .cmd without a shell (EINVAL since
 * the batch-file fix, ENOENT for a bare name). So `run_tests`, which runs
 * `npx vitest run <filter>` as an argument list precisely so that no shell
 * reads the filter, failed on every Windows machine with "spawn npx ENOENT".
 *
 * The script it would have run is read out of the launcher (the last
 * `%~dp0\...js` path in it, which is how npm writes them) and started with
 * Node directly: the same program, the same arguments, still no shell.
 */
export function windowsNodeShim(program: string): { bin: string; args: string[] } | null {
  if (process.platform !== "win32" || /[\/]/.test(program) || path.extname(program)) return null;
  const dirs = (process.env["PATH"] ?? "").split(path.delimiter).filter(Boolean);
  for (const dir of dirs) {
    // A real executable earlier on the PATH is started as it is.
    if (fs.existsSync(path.join(dir, `${program}.exe`))) return null;
    const launcher = path.join(dir, `${program}.cmd`);
    if (!fs.existsSync(launcher)) continue;
    let text: string;
    try {
      text = fs.readFileSync(launcher, "utf8");
    } catch {
      return null;
    }
    const scripts = [...text.matchAll(/%~?dp0%?\\([^"%\r\n]+?\.(?:[cm]?js|exe))\b/gi)].map((m) => m[1]!);
    const script = scripts[scripts.length - 1];
    if (!script) return null;
    const full = path.join(dir, script);
    if (!fs.existsSync(full)) return null;
    // Some launchers wrap a native program (pnpm's does): that is started directly.
    if (/\.exe$/i.test(full)) return { bin: full, args: [] };
    const node = path.join(dir, "node.exe");
    return { bin: fs.existsSync(node) ? node : "node", args: [full] };
  }
  return null;
}
