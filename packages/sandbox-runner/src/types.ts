/**
 * SoreQen Code Sandbox Runner Types and Interfaces
 * Production-Grade V2 Specification (Daemon & Background Process Management)
 */

export interface SandboxOptions {
  workspaceId: string;
  image?: string;
  cpuLimit?: number; // e.g. 2.0 CPUs
  memoryLimitMb?: number; // e.g. 2048 MB
  execTimeoutMs?: number; // e.g. 60000 ms
  storagePath?: string;
  /**
   * Where the workspace's own `.soreqen/` lives, when not inside it.
   *
   * SoreQen keeps checkpoints, task state, saved tool output and its
   * scratchpad under `.soreqen/`. In a sandbox that is invisible; in a
   * person's own project folder it was a directory SoreQen created in their
   * project. Given this, every `.soreqen/…` path resolves here instead —
   * except the files the person writes themselves (`skills/`, `mcp.json`,
   * `rules.md`), which stay in the project where they put them.
   */
  dataPath?: string;
  environment?: Record<string, string>;
  networkMode?: string;
}

export interface ExecCommandOptions {
  /**
   * A shell command line.
   *
   * For `run_command` only, where a shell is the feature — the user asked for
   * a pipeline and expects one. Everything the *agent's own tools* run uses
   * `argv` instead, because a tool that assembles a shell string from model
   * output is a command injection with extra steps, and three of them were.
   *
   * Exactly one of `command` and `argv` must be given.
   */
  command?: string;
  /**
   * A program and its arguments, run without a shell.
   *
   * No quoting, no escaping, no metacharacters: `argv[0]` is executed and the
   * rest are handed to it as literal arguments, so a search query containing
   * `$(rm -rf ~)` is a search for that text and nothing else.
   */
  argv?: string[];
  cwd?: string;
  timeoutMs?: number;
  isBackground?: boolean;
  env?: Record<string, string>;
  onStdout?: (data: string) => void;
  onStderr?: (data: string) => void;
  /**
   * Aborts the running command, killing its whole process group.
   *
   * Cancellation used to stop at the tool boundary: the turn's signal aborted
   * the model stream and the loop between tool calls, but a command already
   * running had no way to hear about it and ran to completion. A cancelled
   * turn kept spending CPU — and, on the hosted surface, kept a container.
   */
  signal?: AbortSignal;
}

export interface ExecCommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  durationMs: number;
  timedOut: boolean;
  pid?: number;
}

export interface FileEntry {
  path: string;
  name: string;
  type: "file" | "directory" | "symlink";
  sizeBytes: number;
  modifiedAt: Date;
}

/**
 * A listing that keeps only what its caller wants, decided during the walk.
 *
 * A search used to list everything and filter afterwards, so the listing's
 * cap was spent on whatever came first: in a project with 100,000 audio
 * clips in `data/`, the 20,000 entries were all clips, `scripts/` and the
 * code were never reached, and glob and grep said "no file matches" for
 * files that were there (15 Oct 2026). Kept entries count toward the cap;
 * the rest are passed over unexamined.
 */
export interface ListOptions {
  /** Whether to keep an entry (its path as the listing names it). Directories are walked either way. */
  include?: (path: string, type: FileEntry["type"]) => boolean;
  /** The most entries kept. */
  maxEntries?: number;
  /** Called when the walk stopped at a limit before covering everything. */
  onTruncated?: () => void;
}

export interface WorkspaceInspection {
  workspaceId: string;
  status: "active" | "stopped" | "destroyed";
  workspacePath: string;
  containerId?: string;
  createdAt: Date;
}

export type ProcessStatus = "running" | "exited" | "stopped" | "timed_out" | "failed";

/** Who or what ended a process that did not exit by itself. */
export type ProcessStopper = "user" | "agent" | "timeout" | "cancelled" | "shutdown";

export interface ProcessInfo {
  id: string;
  workspaceId: string;
  /** The session whose agent started it, so its events reach that session. */
  sessionId?: string;
  /** The tool call that started it. */
  callId?: string;
  command: string;
  /** What it does, in a few words, as the agent described it. */
  description?: string;
  cwd?: string;
  background: boolean;
  /** Running in a pseudo-terminal, and so able to take input. */
  interactive?: boolean;
  pid?: number;
  status: ProcessStatus;
  /** Null while running, and when it was killed rather than exiting. */
  exitCode: number | null;
  startedAt: number;
  endedAt?: number;
  stoppedBy?: ProcessStopper;
  /** It exited, but something it started still holds its output open — a
   *  daemon or server it launched, which is still running. */
  lingering?: boolean;
}

export type ProcessEvent =
  | { type: "started"; process: ProcessInfo }
  | { type: "output"; process: ProcessInfo; chunk: string }
  | { type: "exited"; process: ProcessInfo };

export interface StartProcessOptions {
  command: string;
  cwd?: string;
  description?: string;
  /** Runs until stopped, and is not tied to the caller's signal. */
  background?: boolean;
  /** Foreground only. */
  timeoutMs?: number;
  env?: Record<string, string>;
  sessionId?: string;
  callId?: string;
  /** Foreground only: stops the process when aborted. */
  signal?: AbortSignal;
  /**
   * Run in a pseudo-terminal, so a program that asks questions can be
   * answered with `writeProcessInput`. Always runs in the background: a
   * terminal never sends end-of-file, so a prompt nobody answers would
   * otherwise hold a foreground wait until it timed out.
   */
  interactive?: boolean;
}

export interface SandboxRunner {
  /**
   * Whether a file tool's path lands outside the workspace and its data
   * folder — somewhere else on the person's computer. A runner that confines
   * every path to the workspace leaves this out.
   */
  isOutsideWorkspace?(workspaceId: string, target: string): boolean;
  /**
   * The folder a workspace's `.soreqen/` resolves to, when it is outside the
   * workspace (see `SandboxOptions.dataPath`); null when it is inside. For a
   * shell command, which the runner cannot rewrite: it must name the real
   * place, not `.soreqen/`.
   */
  dataPathOf?(workspaceId: string): string | null;
  /**
   * Remove what the agent kept for one session — its task state (its
   * sub-agents' too) and its saved large outputs — when the session is
   * deleted. Nothing else: never a file of the project.
   */
  removeSessionData?(workspaceId: string, sessionId: string): Promise<void>;
  createWorkspace(
    workspaceId: string,
    options?: Partial<SandboxOptions>,
  ): Promise<WorkspaceInspection>;
  destroyWorkspace(workspaceId: string): Promise<void>;
  readFile(
    workspaceId: string,
    filePath: string,
    startLine?: number,
    endLine?: number,
  ): Promise<{ content: string; totalLines: number }>;
  writeFile(
    workspaceId: string,
    filePath: string,
    content: string,
    overwrite?: boolean,
  ): Promise<{ bytesWritten: number; path: string }>;
  /**
   * A file's bytes, for what is not text: an attached image, a download.
   *
   * Optional, like the two below, so a runner that only ever serves source
   * files — and every test double — need not implement it. A caller checks
   * for it and reports the capability as unavailable when it is absent.
   */
  readBinaryFile?(workspaceId: string, filePath: string): Promise<Uint8Array>;
  writeBinaryFile?(
    workspaceId: string,
    filePath: string,
    data: Uint8Array,
  ): Promise<{ bytesWritten: number; path: string }>;
  /**
   * Commands as processes with a lifetime: started, watched, waited for and
   * stopped by id. Optional, like the file methods above; `run_command` falls
   * back to `execCommand` on a runner without them.
   */
  startProcess?(workspaceId: string, options: StartProcessOptions): Promise<ProcessInfo>;
  getProcess?(workspaceId: string, processId: string): ProcessInfo | null;
  listProcesses?(workspaceId: string): ProcessInfo[];
  /** Beginning and latest output, within `maxChars`. */
  readProcessOutput?(workspaceId: string, processId: string, maxChars?: number): string;
  /** Latest output only, within `maxChars`. */
  readRecentProcessOutput?(workspaceId: string, processId: string, maxChars: number): string;
  stopProcess?(workspaceId: string, processId: string, by: ProcessStopper): Promise<ProcessInfo | null>;
  /** A running foreground command no longer waited on, marked a background one. */
  detachProcess?(workspaceId: string, processId: string): boolean;
  /** Resolves when the process exits; null for an unknown id. */
  processExited?(workspaceId: string, processId: string): Promise<ProcessInfo> | null;
  /** Stop every process in every workspace: the host is shutting down. */
  shutdown?(): Promise<void>;
  /**
   * Kill whatever is still running from a workspace that nothing tracks — left
   * by a host that died, or a shell killed without its children. Returns how
   * many process trees were killed. See `os-processes.ts`.
   */
  killStrayProcesses?(workspaceId: string): Promise<number>;
  /**
   * Kill processes still running from workspaces that no longer belong to
   * anyone, as told by `isLive`. For a host starting up after one that died.
   */
  sweepOrphans?(isLive: (workspaceId: string) => Promise<boolean>): Promise<{ workspaceId: string; killed: number }[]>;
  /** Type into an interactive process. False when it is not running or not interactive. */
  writeProcessInput?(workspaceId: string, processId: string, data: string): boolean;
  onProcessEvent?(listener: (event: ProcessEvent) => void): () => void;
  /** Size and modification time, or null when nothing is at the path. */
  statFile?(
    workspaceId: string,
    filePath: string,
  ): Promise<{ sizeBytes: number; modifiedAt: Date; type: "file" | "directory" } | null>;
  listDirectory(
    workspaceId: string,
    dirPath?: string,
    recursive?: boolean,
    maxDepth?: number,
    options?: ListOptions,
  ): Promise<FileEntry[]>;
  execCommand(workspaceId: string, options: ExecCommandOptions): Promise<ExecCommandResult>;
  getDiff(workspaceId: string): Promise<string>;
  inspectWorkspace(workspaceId: string): Promise<WorkspaceInspection | null>;
}
