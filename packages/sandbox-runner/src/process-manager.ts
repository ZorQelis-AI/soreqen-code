/**
 * Every command the agent runs, as a process that can be watched and stopped.
 *
 * ## Why this exists
 *
 * A command used to be a promise. A foreground one blocked the turn until it
 * finished or hit a 60-second timeout; a background one was spawned, reported
 * as started after a second and a half, and then forgotten — nothing could read
 * what it printed afterwards, ask whether it was still alive, wait for it, or
 * stop it. Neither could a person: a runaway build could only be ended by
 * stopping the whole turn.
 *
 * Here each command is a process with an id and a lifetime of its own:
 *
 * - **Foreground** processes are waited for, and killed at their timeout.
 * - **Background** processes run until the agent or the person stops them, they
 *   exit, or the workspace is torn down. They outlive the turn that started them.
 * - Output is kept — the first part and the latest — and streamed as it arrives.
 * - Anyone holding the id can stop it, and the reason is recorded: a process
 *   stopped by the person reads differently to the agent than one that crashed.
 *
 * Standard input is closed. A command that prompts for input receives
 * end-of-file and fails fast, instead of waiting for an answer nobody can type.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { allowedEnvironment, killTree, shellInvocation } from "./shell.js";
import { validateCommandSafety } from "./security.js";
import type { ProcessEvent, ProcessInfo, ProcessStopper, StartProcessOptions } from "./types.js";
import { createTerminalStripper, loadPty, stripTerminalCodes } from "./pty.js";
import { descendantsOf, killRemembered, listOsProcesses, treeCpuSeconds, type Remembered } from "./os-processes.js";

/** The first part of a command's output, kept whole: errors are named early. */
const HEAD_CHARS = 48 * 1024;
/** The latest output, kept for as long as the process runs. */
const TAIL_CHARS = 256 * 1024;
/** Output is sent in batches this often, not once per write. */
const FLUSH_MS = 150;
/** The most unsent output held between flushes. */
const PENDING_CHARS = 64 * 1024;
/** Finished processes remembered per workspace, oldest forgotten first. */
const KEEP_FINISHED = 60;
/** How long a killed process has to report its exit before it is declared gone. */
const KILL_GRACE_MS = 3_000;
/** After a command exits, how long its last output may take to arrive before it is reported finished. */
const EXIT_GRACE_MS = 1_500;
/**
 * How often a "running" command is checked for still existing.
 *
 * A pseudo-terminal on Windows (ConPTY) does not always report that its
 * command ended — not while anything else is still attached to it — and a
 * command whose end was never reported said "running" for hours, with a Stop
 * that could no longer reach it (28 Sep 2026). A process the system no longer
 * has is finished, however quietly it went.
 */
const LIVENESS_MS = 20_000;

/** Whether the system still has a process with this id. */
export function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM: it exists, it is just not ours to signal.
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

interface Entry {
  info: ProcessInfo;
  child: Pick<ChildProcess, "pid" | "kill">;
  /** Set for a process running in a pseudo-terminal. */
  write?: (data: string) => void;
  head: string;
  tail: string;
  total: number;
  pending: string;
  flushTimer: ReturnType<typeof setTimeout> | null;
  timeoutTimer: ReturnType<typeof setTimeout> | null;
  exited: Promise<ProcessInfo>;
  /** The workspace directory it runs in: how the reaper finds what its shell left behind. */
  root: string;
  /** The program at the top of the tree, to check its id still means it. */
  shell: string;
  /** What it had started, last time anyone looked. See `snapshot`. */
  tree: Remembered[];
  resolveExit: (info: ProcessInfo) => void;
  /** When it last printed anything. */
  lastOutputAt?: number;
  /** Where it runs: what a relative log path in its command is read from. */
  cwd: string;
  /** When it was last seen working (using the CPU, or writing its log) while quiet here. */
  activeAt?: number;
  /** Its processes' CPU time at the last look, in seconds. */
  cpuSample?: { at: number; seconds: number };
  /** A look under way, so the sweep does not start a second. */
  looking?: boolean;
}

/**
 * A background job that has stopped making progress.
 *
 * A command the agent starts in the background has no timeout: a server is
 * meant to run until stopped. A *job* — tests, a type check, a lint, a build,
 * an install — is meant to end, and one that does not was showing in the
 * sidebar as "Background 1h 08m" long after the turn that started it had
 * moved on and forgotten it (reported 1 Oct 2026). Only commands that read as
 * a finite job, and none that read as a server or a watcher, are judged.
 */
const JOB =
  /\b(test|tests|vitest|jest|mocha|pytest|tsc|typecheck|type-check|lint|eslint|ruff|mypy|build|compile|install|ci|cargo (build|test|check)|go (build|test|vet)|gradlew?|mvn|dotnet (build|test)|prisma generate)\b/i;
const NOT_A_JOB = /\b(dev|serve|server|start|preview|watch|--watch|-w|storybook|tail -f|nodemon|docker compose up|up -d)\b/i;
/** Silent this long, a job is looked at to see whether it has hung. */
const JOB_SILENCE_MS = 15 * 60_000;
/** Running this long, it is looked at however much it prints. */
const JOB_LIFETIME_MS = 90 * 60_000;
/** The CPU a job's processes must use between two looks to be called working. */
const BUSY_CPU_SECONDS = 2;
/** The least time between two looks at the same job's CPU. */
const LOOK_EVERY_MS = 5 * 60_000;

/**
 * The words of a command that say what it runs.
 *
 * Not its PowerShell cmdlets, quoted text or paths: `if (Test-Path "runs\…")`
 * at the front of a training launch matched `test`, so a 100-hour training
 * run was judged as a test job, and stopped (14 Oct 2026).
 */
export function commandWords(command: string): string {
  return command
    .replace(/"[^"]*"|'[^']*'/g, " ")
    .replace(/\b[A-Z][a-z]+-[A-Z][A-Za-z]+\b/g, " ")
    .replace(/\S*[\\/]\S*/g, " ")
    .replace(/\$env:\S+/gi, " ");
}

/** Whether a command reads as a finite job (tests, a build, an install) rather than a server or anything else. */
export function isJob(command: string): boolean {
  const words = commandWords(command);
  return JOB.test(words) && !NOT_A_JOB.test(words);
}

/**
 * Why a background job looks hung, or null.
 *
 * Only a reason to look: silence is not stuck. A training run that writes its
 * progress to its own log prints nothing here for hours, and one that prints
 * every second can run for days. `ProcessManager.sweep` stops a job only when
 * its processes have also stopped using the CPU and its log has stopped
 * growing; `activeAt` is the last time they were seen working.
 */
export function hungJob(
  entry: {
    info: Pick<ProcessInfo, "background" | "interactive" | "command" | "startedAt">;
    lastOutputAt?: number;
    activeAt?: number;
  },
  now: number,
): string | null {
  const { info } = entry;
  if (!info.background || info.interactive) return null;
  if (!isJob(info.command)) return null;
  const working = entry.activeAt ?? 0;
  const quiet = now - Math.max(entry.lastOutputAt ?? info.startedAt, working);
  if (quiet >= JOB_SILENCE_MS) return `no output for ${Math.round((now - (entry.lastOutputAt ?? info.startedAt)) / 60_000)} minutes`;
  if (now - info.startedAt >= JOB_LIFETIME_MS && now - working >= JOB_SILENCE_MS) {
    return `still running after ${Math.round((now - info.startedAt) / 60_000)} minutes`;
  }
  return null;
}

/**
 * The files a command's output is sent to: `> log`, `*> "x.log"`, `2>> err`,
 * `| tee run.log`, `| Out-File out.txt`, `| Tee-Object -FilePath t.log`.
 * Their growing is a job's sign of life when nothing reaches its output here.
 */
export function outputFilesOf(command: string): string[] {
  const out: string[] = [];
  const re = /(?:(?:^|[\s;|&(])(?:\d|\*|&)?>>?|\bOut-File(?:\s+-(?:File|Literal)Path)?|\bTee-Object(?:\s+-(?:File|Literal)Path)?|\btee(?:\s+-a)?)\s*("[^"]+"|'[^']+'|[^\s;|&<>()]+)/gi;
  for (let m = re.exec(command); m; m = re.exec(command)) {
    const target = m[1]!.replace(/^["']|["']$/g, "");
    if (!target || target.startsWith("&") || target.startsWith("-") || /^(\$null|nul|\/dev\/null)$/i.test(target)) continue;
    out.push(target);
  }
  return out;
}

export interface ProcessManagerOptions {
  /**
   * Whether a workspace directory is the runner's own, made for that one
   * workspace — the only kind the reaper may sweep by directory. Without it
   * the reaper kills by remembered process id alone: a workspace that is the
   * user's repository must never lose the dev server they started from their
   * own terminal.
   */
  ownsDir?: (dir: string) => boolean;
  /** A process tree's CPU time in seconds (`treeCpuSeconds`); replaced in tests. */
  cpuSeconds?: (pid: number) => Promise<number | null>;
}

export class ProcessManager {
  private readonly entries = new Map<string, Entry>();
  private readonly listeners = new Set<(event: ProcessEvent) => void>();

  private liveness: ReturnType<typeof setInterval> | null = null;

  constructor(private readonly options: ProcessManagerOptions = {}) {}

  /** Finish every "running" command whose process is gone. Checked while any runs. */
  sweep(isAlive: (pid: number) => boolean = processAlive, now = Date.now()): void {
    for (const entry of this.entries.values()) {
      const pid = entry.info.pid;
      if (entry.info.status !== "running" || pid === undefined) continue;
      const hung = hungJob(entry, now);
      if (hung) void this.lookAtQuietJob(entry, hung, now);
      if (Date.now() - entry.info.startedAt < LIVENESS_MS) continue; // Just started: let it report itself.
      if (!isAlive(pid)) {
        this.flush(entry);
        this.finish(entry, entry.info.exitCode ?? null);
      }
    }
    this.watchLiveness();
  }

  /**
   * Stop a quiet job only if it has really stopped working.
   *
   * Quiet here is not idle: a job whose output goes to a file (`*> run.log`)
   * or to a log of its own prints nothing to this manager, and one that prints
   * a progress line a second may still be training at hour forty. So before
   * anything is stopped: has a file its command writes to changed recently,
   * and have its processes used the CPU between two looks five minutes
   * apart? Either one, and it is left to run. Neither, and it has hung.
   * When the CPU cannot be read, nothing is stopped.
   */
  private async lookAtQuietJob(entry: Entry, reason: string, now: number): Promise<void> {
    if (entry.looking || entry.info.status !== "running" || entry.info.pid === undefined) return;
    if (entry.cpuSample && now - entry.cpuSample.at < LOOK_EVERY_MS) return;
    entry.looking = true;
    try {
      for (const file of outputFilesOf(entry.info.command)) {
        const stat = await fs.promises.stat(path.resolve(entry.cwd, file)).catch(() => null);
        if (stat && now - stat.mtimeMs < JOB_SILENCE_MS) {
          entry.activeAt = now;
          return;
        }
      }
      const seconds = await (this.options.cpuSeconds ?? treeCpuSeconds)(entry.info.pid);
      const before = entry.cpuSample;
      entry.cpuSample = { at: now, seconds: seconds ?? before?.seconds ?? 0 };
      if (seconds === null || !before) return;
      if (seconds - before.seconds >= BUSY_CPU_SECONDS) {
        entry.activeAt = now;
        return;
      }
      if (entry.info.status !== "running") return;
      const idle = Math.max(1, Math.round((now - before.at) / 60_000));
      entry.tail += `\n[SoreQen stopped this background job: ${reason}, and in the last ${idle} minutes its processes used no CPU and wrote no log.]\n`;
      await this.stop(entry.info.id, "timeout");
    } finally {
      entry.looking = false;
    }
  }

  private watchLiveness(): void {
    const anyRunning = [...this.entries.values()].some((e) => e.info.status === "running");
    if (anyRunning && !this.liveness) {
      this.liveness = setInterval(() => this.sweep(), LIVENESS_MS);
      this.liveness.unref?.();
    } else if (!anyRunning && this.liveness) {
      clearInterval(this.liveness);
      this.liveness = null;
    }
  }

  onEvent(listener: (event: ProcessEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit(event: ProcessEvent): void {
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch {
        // A listener's failure is its own.
      }
    }
  }

  start(workspaceId: string, workspaceRoot: string, cwd: string, options: StartProcessOptions): ProcessInfo {
    const command = options.command.trim();
    validateCommandSafety(command);

    const isWindows = process.platform === "win32";
    const { bin, args } = shellInvocation(command, { interactive: options.interactive ?? false });
    const env = {
      ...allowedEnvironment(),
      /*
       * Python holds its output back when it is not writing to a terminal, so
       * `python -m http.server` never printed "Serving HTTP" and a wait for that
       * line sat until the person stopped the server.
       */
      PYTHONUNBUFFERED: "1",
      ...options.env,
      WORKSPACE_ROOT: workspaceRoot,
      NODE_ENV: "development",
    };

    const pty = options.interactive ? loadPty() : null;
    if (options.interactive && !pty) {
      throw new Error(
        "Interactive commands need a pseudo-terminal, which is not available on this host. " +
          "Run the command with its non-interactive flags instead (e.g. --yes, --default, or the answers as arguments).",
      );
    }
    const term = pty ? pty.spawn(bin, args, { name: "xterm-256color", cols: 120, rows: 40, cwd, env }) : null;
    const child: Pick<ChildProcess, "pid" | "kill" | "on" | "stdout" | "stderr"> | null = term
      ? null
      : spawn(bin, args, {
          cwd,
          env,
          stdio: ["ignore", "pipe", "pipe"],
          // A process group of its own, so the whole tree can be killed.
          detached: !isWindows,
          windowsHide: true,
        });
    const pid = term ? term.pid : child!.pid;

    const info: ProcessInfo = {
      id: `p_${randomUUID().replace(/-/g, "").slice(0, 12)}`,
      workspaceId,
      command,
      // An interactive process is always a background one: see `interactive`.
      background: (options.background ?? false) || Boolean(term),
      ...(term ? { interactive: true } : {}),
      status: "running",
      exitCode: null,
      startedAt: Date.now(),
      ...(options.sessionId ? { sessionId: options.sessionId } : {}),
      ...(options.callId ? { callId: options.callId } : {}),
      ...(options.description ? { description: options.description } : {}),
      ...(options.cwd ? { cwd: options.cwd } : {}),
      ...(pid !== undefined ? { pid } : {}),
    };

    let resolveExit!: (info: ProcessInfo) => void;
    const exited = new Promise<ProcessInfo>((resolve) => {
      resolveExit = resolve;
    });

    const entry: Entry = {
      info,
      child: term
        ? { pid: term.pid, kill: (() => (term.kill(), true)) as ChildProcess["kill"] }
        : child!,
      ...(term ? { write: (data: string) => term.write(data) } : {}),
      head: "",
      tail: "",
      total: 0,
      pending: "",
      flushTimer: null,
      timeoutTimer: null,
      exited,
      resolveExit,
      root: workspaceRoot,
      cwd,
      shell: path.basename(bin),
      tree: [],
    };
    this.entries.set(info.id, entry);
    this.register();
    // What it starts, remembered while the tree is whole — dev servers spawn theirs within seconds.
    for (const delay of [700, 3_000, 12_000]) setTimeout(() => void this.snapshot(entry), delay).unref?.();

    const append = (data: Buffer | string): void => {
      const text = data.toString();
      if (!text) return;
      entry.lastOutputAt = Date.now();
      entry.total += text.length;
      if (entry.head.length < HEAD_CHARS) entry.head += text.slice(0, HEAD_CHARS - entry.head.length);
      entry.tail += text;
      if (entry.tail.length > TAIL_CHARS * 1.25) entry.tail = entry.tail.slice(-TAIL_CHARS);
      entry.pending += text;
      if (entry.pending.length > PENDING_CHARS) entry.pending = entry.pending.slice(-PENDING_CHARS);
      if (!entry.flushTimer) {
        entry.flushTimer = setTimeout(() => this.flush(entry), FLUSH_MS);
        entry.flushTimer.unref?.();
      }
    };

    if (term) {
      term.onData((data) => append(stripTerminalCodes(data)));
      term.onExit(({ exitCode }) => this.finish(entry, exitCode));
    } else {
      /*
       * Text, decoded by the stream, with terminal codes removed as it
       * arrives. Decoding each Buffer alone split a multi-byte character (`➜`)
       * that straddled two chunks into `�`; and colour codes — which tools like
       * Vite write even into a pipe — broke `Local: http://localhost:5173`
       * into pieces no `wait until_output` could match.
       */
      const out = createTerminalStripper();
      const err = createTerminalStripper();
      child!.stdout?.setEncoding("utf8");
      child!.stderr?.setEncoding("utf8");
      child!.stdout?.on("data", (d: string) => append(out.push(d)));
      child!.stderr?.on("data", (d: string) => append(err.push(d)));
      const drain = (): void => append(out.end() + err.end());
      child!.on("error", (e) => {
        append(`\n${e.message}\n`);
        this.finish(entry, null, "failed");
      });
      child!.on("close", (code) => {
        drain();
        this.finish(entry, code);
      });
      /*
       * Finished when the command exits — not when its output pipes close.
       *
       * `close` waits for every holder of the pipes, and a command that
       * starts something long-lived (a daemon, a build service, a server
       * launched by a script) hands the pipes to it. The command was done in a
       * second; the wait lasted as long as whatever it left behind — up to the
       * whole timeout. After a short grace for the last output, it is reported
       * finished, and said to have left something running.
       */
      child!.on("exit", (code) => {
        const grace = setTimeout(() => {
          if (entry.info.status !== "running") return;
          drain();
          entry.info.lingering = true;
          this.finish(entry, code);
          // The leftover holder must not keep this server's event loop alive either.
          (child!.stdout as { unref?: () => void } | null)?.unref?.();
          (child!.stderr as { unref?: () => void } | null)?.unref?.();
        }, EXIT_GRACE_MS);
        grace.unref?.();
      });
    }

    if (!info.background && options.timeoutMs && options.timeoutMs > 0) {
      entry.timeoutTimer = setTimeout(() => void this.stop(info.id, "timeout"), options.timeoutMs);
      entry.timeoutTimer.unref?.();
    }

    // Stopping a turn stops what it is waiting on. A background process was
    // started to outlive the wait, so it is left running.
    if (!info.background && options.signal) {
      if (options.signal.aborted) void this.stop(info.id, "cancelled");
      else options.signal.addEventListener("abort", () => void this.stop(info.id, "cancelled"), { once: true });
    }

    this.emit({ type: "started", process: { ...info } });
    this.watchLiveness();
    return { ...info };
  }

  private flush(entry: Entry): void {
    if (entry.flushTimer) clearTimeout(entry.flushTimer);
    entry.flushTimer = null;
    if (!entry.pending) return;
    const chunk = entry.pending;
    entry.pending = "";
    this.emit({ type: "output", process: { ...entry.info }, chunk });
  }

  private finish(entry: Entry, code: number | null, forced?: "failed"): void {
    if (entry.info.status !== "running") return;
    if (entry.timeoutTimer) clearTimeout(entry.timeoutTimer);
    this.flush(entry);

    const stoppedBy = entry.info.stoppedBy;
    entry.info.status =
      forced === "failed"
        ? "failed"
        : stoppedBy === "timeout"
          ? "timed_out"
          : stoppedBy
            ? "stopped"
            : "exited";
    entry.info.exitCode = code;
    entry.info.endedAt = Date.now();

    this.emit({ type: "exited", process: { ...entry.info } });
    this.register();
    entry.resolveExit({ ...entry.info });
    this.prune(entry.info.workspaceId);
  }

  private prune(workspaceId: string): void {
    const finished = [...this.entries.values()]
      .filter((e) => e.info.workspaceId === workspaceId && e.info.status !== "running")
      .sort((a, b) => (a.info.endedAt ?? 0) - (b.info.endedAt ?? 0));
    for (const old of finished.slice(0, Math.max(0, finished.length - KEEP_FINISHED))) {
      this.entries.delete(old.info.id);
    }
  }

  private find(workspaceId: string, processId: string): Entry | null {
    const entry = this.entries.get(processId);
    // One workspace can never reach another's processes, even by id.
    return entry && entry.info.workspaceId === workspaceId ? entry : null;
  }

  get(workspaceId: string, processId: string): ProcessInfo | null {
    const entry = this.find(workspaceId, processId);
    return entry ? { ...entry.info } : null;
  }

  list(workspaceId: string): ProcessInfo[] {
    return [...this.entries.values()]
      .filter((e) => e.info.workspaceId === workspaceId)
      .map((e) => ({ ...e.info }))
      .sort((a, b) => a.startedAt - b.startedAt);
  }

  /**
   * What a process has printed, up to `maxChars` of it.
   *
   * Whole when it fits. Otherwise the beginning and the latest output with a
   * count of what was left out between them, since those are the two parts a
   * failure is described in.
   */
  output(workspaceId: string, processId: string, maxChars = HEAD_CHARS + TAIL_CHARS): string {
    const entry = this.find(workspaceId, processId);
    if (!entry) return "";
    const tailStart = entry.total - entry.tail.length;
    const whole =
      tailStart <= entry.head.length
        ? entry.head.slice(0, tailStart) + entry.tail
        : `${entry.head}\n\n… [${(tailStart - entry.head.length).toLocaleString()} characters of output not kept] …\n\n${entry.tail}`;
    if (whole.length <= maxChars) return whole;
    const half = Math.floor(maxChars / 2);
    return `${whole.slice(0, half)}\n\n… [${(whole.length - maxChars).toLocaleString()} characters elided] …\n\n${whole.slice(-half)}`;
  }

  /** The latest output only, for a page that needs to catch up on a live process. */
  recentOutput(workspaceId: string, processId: string, maxChars: number): string {
    const entry = this.find(workspaceId, processId);
    if (!entry) return "";
    return entry.tail.length > maxChars ? entry.tail.slice(-maxChars) : entry.tail;
  }

  async stop(processId: string, by: ProcessStopper, workspaceId?: string): Promise<ProcessInfo | null> {
    const entry = workspaceId ? this.find(workspaceId, processId) : (this.entries.get(processId) ?? null);
    if (!entry) return null;
    if (entry.info.status !== "running") return { ...entry.info };

    entry.info.stoppedBy = by;
    killTree(entry.child);
    // If the kill cannot be observed, the process is declared gone rather
    // than left "running" for ever.
    const grace = setTimeout(() => this.finish(entry, null), KILL_GRACE_MS);
    grace.unref?.();
    const info = await entry.exited;
    clearTimeout(grace);
    return info;
  }

  /**
   * A foreground command nobody waits on any more, from now on a background
   * one: its end is then reported like any background command's. Its time
   * limit and its tie to the turn stay as they were.
   */
  detach(workspaceId: string, processId: string): boolean {
    const entry = this.find(workspaceId, processId);
    if (!entry || entry.info.status !== "running") return false;
    entry.info.background = true;
    return true;
  }

  /** Resolves when the process has exited, however it ended. */
  exited(workspaceId: string, processId: string): Promise<ProcessInfo> | null {
    const entry = this.find(workspaceId, processId);
    return entry ? entry.exited : null;
  }

  /**
   * Type into an interactive process.
   *
   * Refused — false — for one that is not running or not in a terminal: a
   * pipe-backed process has its stdin closed, and pretending the text went
   * somewhere would leave the agent waiting on an answer nobody received.
   */
  write(workspaceId: string, processId: string, data: string): boolean {
    const entry = this.find(workspaceId, processId);
    if (!entry || !entry.write || entry.info.status !== "running") return false;
    entry.write(data);
    return true;
  }

  /** Stop everything still running, in every workspace. */
  async stopAll(): Promise<void> {
    const running = [...this.entries.values()].filter((e) => e.info.status === "running");
    await Promise.all(running.map((e) => this.stop(e.info.id, "shutdown")));
    this.register();
  }

  /** Remember what a command has started, while it is still attached to it. */
  private async snapshot(entry: Entry): Promise<void> {
    if (entry.info.status !== "running" || entry.info.pid === undefined) return;
    const all = await listOsProcesses();
    /*
     * The command's own id, as the program it became. `bash -c "node
     * server.js"` replaces itself with node, so on Linux and macOS the id the
     * reaper knows as `bash` is `node` a moment later, and "still the program
     * it was" never matched: a host killed outright left the server running
     * (found by the first Linux and macOS CI run, 16 Nov 2026). Windows'
     * PowerShell never does this, which is why only POSIX missed it.
     */
    const self = all.find((p) => p.pid === entry.info.pid);
    const became =
      self && self.name.toLowerCase() !== entry.shell.toLowerCase() ? [{ pid: self.pid, name: self.name }] : [];
    const found = [...became, ...descendantsOf(all, entry.info.pid)];
    const known = new Set(entry.tree.map((r) => `${r.pid}:${r.name.toLowerCase()}`));
    const added = found.filter((r) => !known.has(`${r.pid}:${r.name.toLowerCase()}`));
    if (added.length === 0) return;
    entry.tree = [...entry.tree, ...added].slice(-200);
    this.register();
  }

  /**
   * Kill what a workspace's commands started and left behind — processes
   * whose command has exited or been lost, but which are still the program
   * they were remembered as.
   */
  async killLeftovers(workspaceId: string): Promise<number> {
    const remembered = [...this.entries.values()].filter((e) => e.info.workspaceId === workspaceId).flatMap((e) => e.tree);
    return killRemembered(remembered);
  }

  // ---- the reaper ----------------------------------------------------------------

  private registry: string | null = null;

  /**
   * Keep the reaper's list of running process trees current, and start the
   * reaper with the first one. With nothing running the list is removed,
   * which is also what tells a reaper that its host shut down properly.
   * See `reaper.ts`.
   */
  private register(): void {
    if (process.env["SOREQEN_NO_REAPER"] === "1") return;
    /*
     * A running command by its own id; one that has exited only by what it
     * left running, since its own id may already belong to something else.
     */
    const roots = [...this.entries.values()]
      .filter((e) => (e.info.status === "running" && e.info.pid !== undefined) || (e.info.lingering && e.tree.length > 0))
      .map((e) => ({
        ...(e.info.status === "running" ? { pid: e.info.pid!, name: e.shell } : {}),
        ...(this.options.ownsDir?.(e.root) ? { dir: e.root } : {}),
        tree: e.tree,
      }));
    try {
      if (roots.length === 0) {
        if (this.registry) fs.rmSync(this.registry, { force: true });
        this.registry = null;
        return;
      }
      if (!this.registry) {
        const script = reaperScript();
        if (!script) return; // No reaper to promise anything to: no list pretending there is one.
        const dir = path.join(os.tmpdir(), "soreqen-reaper");
        fs.mkdirSync(dir, { recursive: true });
        forgetDeadRegistries(dir);
        this.registry = path.join(dir, `${process.pid}-${randomUUID().slice(0, 8)}.json`);
        fs.writeFileSync(this.registry, JSON.stringify({ roots }));
        const reaper = spawn(process.execPath, [script, String(process.pid), this.registry], {
          detached: true,
          stdio: "ignore",
          windowsHide: true,
        });
        reaper.on("error", () => undefined);
        reaper.unref();
        return;
      }
      fs.writeFileSync(this.registry, JSON.stringify({ roots }));
    } catch {
      // A reaper is insurance; failing to keep one never fails a command.
    }
  }

  async stopWorkspace(workspaceId: string): Promise<void> {
    const running = [...this.entries.values()].filter(
      (e) => e.info.workspaceId === workspaceId && e.info.status === "running",
    );
    await Promise.all(running.map((e) => this.stop(e.info.id, "shutdown")));
    await this.killLeftovers(workspaceId).catch(() => 0);
    for (const [id, entry] of this.entries) {
      if (entry.info.workspaceId === workspaceId) this.entries.delete(id);
    }
  }
}

/**
 * The compiled reaper, which Node can run on its own.
 *
 * Beside this module when it is itself compiled. Run from source — tests, a
 * dev server under tsx — the sibling is `src/reaper.js`, which does not
 * exist: the reaper started, found no script, and exited at once, and every
 * such host had no reaper at all while its list said otherwise.
 */
function reaperScript(): string | null {
  const beside = fileURLToPath(new URL("./reaper.js", import.meta.url));
  const built = path.join(path.dirname(beside), "..", "dist", "reaper.js");
  return [beside, built].find((f) => fs.existsSync(f)) ?? null;
}

/**
 * Remove the lists of hosts long dead whose reaper never finished — killed
 * itself, or the machine restarted under it. Only removed, never acted on:
 * after that long, an id it names may belong to something else entirely.
 */
function forgetDeadRegistries(dir: string): void {
  for (const name of fs.readdirSync(dir)) {
    const file = path.join(dir, name);
    const host = Number(/^(\d+)-/.exec(name)?.[1]);
    try {
      if (!host || Date.now() - fs.statSync(file).mtimeMs < 5 * 60_000) continue;
      try {
        process.kill(host, 0);
        continue; // Still running.
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === "EPERM") continue;
      }
      fs.rmSync(file, { force: true });
    } catch {
      // Somebody else's to clear.
    }
  }
}
