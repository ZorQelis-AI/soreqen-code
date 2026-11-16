/**
 * How a command is started, what it may inherit, and how it is killed.
 *
 * Shared by the one-shot `execCommand` and the process manager, so the two
 * paths that run model-chosen commands cannot drift apart on any of the three.
 */

import { spawn, type ChildProcess } from "node:child_process";

/**
 * Environment variables a spawned command may inherit.
 *
 * Never the parent's environment wholesale. This process holds the API keys
 * the agent bills to, the gateway's signing secrets and a database URL, and
 * `run_command` runs whatever the model decided to run — including a
 * dependency's install script and a cloned repository's test suite. Spreading
 * `process.env` handed every one of those the lot.
 *
 * The list is what a build actually needs to work.
 */
export const ENV_ALLOWLIST = [
  "PATH",
  "Path",
  "HOME",
  "USERPROFILE",
  "TMPDIR",
  "TEMP",
  "TMP",
  "LANG",
  "LC_ALL",
  "TZ",
  "SHELL",
  "COMSPEC",
  "SYSTEMROOT",
  "WINDIR",
  "PATHEXT",
  "PROCESSOR_ARCHITECTURE",
  "NUMBER_OF_PROCESSORS",
  "TERM",
  "COLUMNS",
  "APPDATA",
  "LOCALAPPDATA",
  "PROGRAMFILES",
  "PROGRAMDATA",
  "NVM_DIR",
  "PNPM_HOME",
  "npm_config_registry",
];

export function allowedEnvironment(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const key of ENV_ALLOWLIST) {
    const value = process.env[key];
    if (value !== undefined) env[key] = value;
  }
  return env;
}

/**
 * The most output kept from one command.
 *
 * Unbounded accumulation was two problems in one: a runaway command could
 * exhaust memory, and whatever it produced went into the model's context
 * whole. A failing build that prints 40,000 lines of stack traces cost more
 * tokens than the rest of the turn put together, to say something the first
 * hundred lines already said.
 */
export const MAX_CAPTURED_BYTES = 96 * 1024;

/** Where appending stops entirely. Above the reporting cap so `clampOutput`
 *  still has a real head and tail to keep, but bounded so a command emitting
 *  gigabytes cannot exhaust memory before the timeout reaches it. */
export const HARD_BUFFER_LIMIT = 4 * 1024 * 1024;

/**
 * Keep the beginning and the end, drop the middle.
 *
 * A compiler names the file it is unhappy about early and summarises at the
 * end; a test runner does the same. The middle of a long log is the part
 * nobody reads, and saying how much was dropped is what stops the model
 * treating the remainder as the whole story.
 */
export function clampOutput(text: string): string {
  if (Buffer.byteLength(text, "utf-8") <= MAX_CAPTURED_BYTES) return text;
  const half = Math.floor(MAX_CAPTURED_BYTES / 2);
  const head = text.slice(0, half);
  const tail = text.slice(-half);
  const droppedBytes = Buffer.byteLength(text, "utf-8") - MAX_CAPTURED_BYTES;
  return `${head}\n\n… [${droppedBytes.toLocaleString()} bytes of output elided — re-run narrowed, or grep the log, if you need the middle] …\n\n${tail}`;
}

/**
 * The shell a command line runs under: PowerShell on Windows, bash elsewhere.
 *
 * PowerShell's `-Command` reports any failure as exit code 1, so `npm test`
 * failing with 3, or a program exiting 2, all read as 1 — and an exit code the
 * agent reasons from must be the real one. The status line passes the last
 * program's own code through. It goes on a line of its own, so a command ending
 * in a `#` comment cannot swallow it.
 */
export function shellInvocation(
  command: string,
  options: { interactive?: boolean } = {},
): { bin: string; args: string[] } {
  if (process.platform === "win32") {
    const script = `${command}\nif (-not $?) { if ($LASTEXITCODE) { exit $LASTEXITCODE }; exit 1 }; exit 0`;
    // `-NonInteractive` makes PowerShell refuse to prompt even inside a
    // terminal, which is the one place an interactive command runs.
    const flags = options.interactive ? ["-NoProfile"] : ["-NoProfile", "-NonInteractive"];
    return { bin: "powershell.exe", args: [...flags, "-Command", script] };
  }
  return { bin: "/bin/bash", args: ["-c", command] };
}

/**
 * Kill a command and everything it started.
 *
 * Two bugs lived in an earlier version, one per platform.
 *
 * On Windows it called `require("child_process")` inside a package declared
 * `"type": "module"`, where `require` is not defined. The ReferenceError was
 * caught by the surrounding `try`, so the `taskkill /T` tree-kill — the only
 * thing on Windows that reaches grandchildren — had never once run.
 *
 * On POSIX it called `process.kill(-pid)` on a child spawned without
 * `detached`, so the child was not a process-group leader and the negative pid
 * named no group. That threw ESRCH and fell back to killing the shell alone,
 * leaving the actual command running. `detached` at the spawn site is the
 * other half of this fix.
 */
export function killTree(child: Pick<ChildProcess, "pid" | "kill">): void {
  if (child.pid === undefined) return;

  if (process.platform === "win32") {
    /*
     * Spawned, not `execSync`'d.
     *
     * This runs inside the gateway, which serves every session's stream and
     * turn from one event loop. `taskkill /T` walks the whole tree and can
     * take seconds on a dev server with watchers — and for all of that time
     * `execSync` froze every other session too. Nothing here needs the answer
     * before returning: callers wait on the child's own exit, with a grace
     * timer for a kill that cannot be observed.
     */
    const fallback = (): void => {
      try {
        child.kill("SIGKILL");
      } catch {
        /* already dead */
      }
    };
    try {
      const killer = spawn("taskkill", ["/F", "/T", "/PID", String(child.pid)], {
        stdio: "ignore",
        windowsHide: true,
      });
      killer.once("error", fallback);
      // Non-zero also means "already gone", when the fallback is harmless.
      killer.once("exit", (code) => {
        if (code !== 0) fallback();
      });
    } catch {
      fallback();
    }
    return;
  }

  try {
    // Negative pid = the whole process group, which `detached: true` created.
    process.kill(-child.pid, "SIGKILL");
  } catch {
    try {
      child.kill("SIGKILL");
    } catch {
      /* already dead */
    }
  }
}
