/**
 * Commands as processes: run, watch, wait for, stop.
 *
 * ## What changed, and why
 *
 * `run_command` blocked the turn until the command finished or a 60-second
 * timeout hit, and a background command was reported as started and then lost:
 * its later output, its exit and its lifetime were invisible to the agent and to
 * the person watching. So the agent could not start a server and check it was
 * up, could not start a long build and do something else meanwhile, and nobody
 * could stop a command short of stopping everything.
 *
 * Now every command is a process with an id:
 *
 * - **Foreground** — waited for, up to ten minutes, and its output returned.
 * - **Background** — returns at once with a `process_id` and runs until stopped
 *   or it exits. `process_status` reads it, `stop_process` ends it, `wait` waits
 *   for it — or for a line such as "ready" in its output.
 * - **`wait`** also works as a plain timer, for "check again in two minutes",
 *   without spending a token while it waits. Every wait ends the moment the
 *   person sends a message.
 */

import {
  ProcessStatusInputSchema,
  SendProcessInputInputSchema,
  StopProcessInputSchema,
  WaitInputSchema,
  type ProcessStatusInput,
  type SendProcessInputInput,
  type StopProcessInput,
  type WaitInput,
} from "@sqcode/shared";
import type { ProcessInfo } from "@sqcode/sandbox-runner";
import type { ToolExecutionContext, ToolResult } from "./types.js";

/** How long a background command is watched before `run_command` returns, to
 *  catch one that fails on start, and its first output. */
const BACKGROUND_SETTLE_MS = 2_000;
/** Output a foreground command returns to the model, at most. */
const FOREGROUND_OUTPUT_CHARS = 96 * 1024;
/** How often a wait checks for a message or for the text it is waiting for. */
const WAIT_POLL_MS = 400;

export function formatDuration(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${String(s % 60).padStart(2, "0")}s`;
  return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, "0")}m`;
}

function describeProcess(p: ProcessInfo): Record<string, unknown> {
  const elapsed = (p.endedAt ?? Date.now()) - p.startedAt;
  return {
    process_id: p.id,
    command: p.command,
    ...(p.description ? { description: p.description } : {}),
    status: p.status,
    background: p.background,
    ...(p.interactive ? { interactive: true } : {}),
    exit_code: p.exitCode,
    [p.status === "running" ? "running_for" : "ran_for"]: formatDuration(elapsed),
    ...(p.stoppedBy ? { stopped_by: p.stoppedBy } : {}),
    ...(p.lingering
      ? {
          note:
            "The command has finished, but a process it started (a daemon, server or build service) is still " +
            "running and holding its output. It is not waited for. If you did not mean to leave it running, find and stop it.",
        }
      : {}),
  };
}

const ESC = String.fromCharCode(27);
const TERMINAL_CODES = new RegExp(`${ESC}\\[[0-?]*[ -/]*[@-~]|${ESC}\\][^${String.fromCharCode(7)}${ESC}]*(?:${String.fromCharCode(7)}|${ESC}\\\\)?`, "g");

/** Output as a person reads it. A runner may or may not have stripped these already. */
function stripCodes(text: string): string {
  return text.replace(TERMINAL_CODES, "");
}

/** For `until_output`: no terminal codes, any case, runs of whitespace as one space. */
export function comparable(text: string): string {
  return stripCodes(text).toLowerCase().replace(/\s+/g, " ").trim();
}

/** A line saying a dev server or service is up, in the words the common tools use. */
export const READY_SIGNAL =
  /\bready in\b|\bready on\b|\blocal:\s+https?:\/\/|\blistening (?:on|at)\b|\bserver (?:is )?running (?:at|on)\b|\bcompiled successfully\b|\bstarted server on\b|\bapp running at\b|\baccepting connections\b|\bready - started\b/i;

/** How long after the output says "ready" a wait for other text gives up and says so. */
const READY_GRACE_MS = 15_000;
/** A waited-for program that has printed nothing at all for this long is not going to print the line. */
const SILENT_GIVE_UP_MS = 45_000;

function lineAround(text: string, index: number): string {
  const start = text.lastIndexOf("\n", index) + 1;
  const end = text.indexOf("\n", index);
  return text.slice(start, end === -1 ? undefined : end).trim().slice(0, 160);
}

function lastLines(text: string, count: number): string {
  const lines = text.split(/\r?\n/);
  return lines.length > count ? lines.slice(-count).join("\n") : text;
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
  });
}

export function runnerTracksProcesses(ctx: ToolExecutionContext): boolean {
  const r = ctx.sandboxRunner;
  return Boolean(r.startProcess && r.processExited && r.getProcess && r.readProcessOutput);
}

/** How often a waiting tool looks for a message the person chose to send now. */
const URGENT_POLL_MS = 400;

/**
 * Settles once the person has chosen to send a message now (see
 * `urgentMessages`), so whatever is being waited on can be left to run.
 */
export function whenUrgent(urgent: () => number, signal?: AbortSignal): { promise: Promise<"urgent">; cancel: () => void } {
  let timer: ReturnType<typeof setInterval> | undefined;
  const promise = new Promise<"urgent">((resolve) => {
    timer = setInterval(() => {
      if (signal?.aborted) return clearInterval(timer);
      if (urgent() > 0) {
        clearInterval(timer);
        resolve("urgent");
      }
    }, URGENT_POLL_MS);
  });
  return { promise, cancel: () => clearInterval(timer) };
}

/** `run_command` on a runner that tracks processes. */
export async function runCommandAsProcess(
  options: {
    command: string;
    description?: string;
    cwd?: string;
    background: boolean;
    timeoutMs: number;
    interactive?: boolean;
  },
  ctx: ToolExecutionContext,
): Promise<ToolResult<Record<string, unknown>>> {
  const runner = ctx.sandboxRunner;
  // A terminal never sends end-of-file, so interactive always means background.
  if (options.interactive) options = { ...options, background: true };
  let started: Awaited<ReturnType<NonNullable<typeof runner.startProcess>>>;
  try {
    started = await runner.startProcess!(ctx.workspaceId, {
      command: options.command,
      background: options.background,
      ...(options.interactive ? { interactive: true } : {}),
    ...(options.cwd ? { cwd: options.cwd } : {}),
    ...(options.description ? { description: options.description } : {}),
    ...(options.background ? {} : { timeoutMs: options.timeoutMs, signal: ctx.signal }),
      ...(ctx.sessionId ? { sessionId: ctx.sessionId } : {}),
      ...(ctx.callId ? { callId: ctx.callId } : {}),
    });
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : String(err) };
  }
  const exited = runner.processExited!(ctx.workspaceId, started.id)!;

  if (options.background) {
    const early = await Promise.race([exited, sleep(BACKGROUND_SETTLE_MS, ctx.signal).then(() => null)]);
    const info = early ?? runner.getProcess!(ctx.workspaceId, started.id) ?? started;
    const output = runner.readProcessOutput!(ctx.workspaceId, started.id, 12_000);

    if (info.status !== "running") {
      return {
        success: info.exitCode === 0,
        data: { ...describeProcess(info), output, note: "It ended during startup." },
        ...(info.exitCode !== 0
          ? { error: `The background command exited during startup (code ${info.exitCode ?? "none"}).` }
          : {}),
      };
    }

    return {
      success: true,
      data: {
        ...describeProcess(info),
        output_so_far: output,
        note: info.interactive
          ? "Running in a terminal. If the output above ends in a question, answer it with send_process_input; " +
            "read more with process_status, and stop it with stop_process."
          : "Running in the background until you stop it with stop_process or it exits. " +
            "Read its output with process_status; wait for it to finish, or for a line such as 'ready', with wait.",
      },
    };
  }

  /*
   * The person chose to send a message now: the command is no longer waited
   * on, but it is not stopped either. It goes on as if it had been started in
   * the background, and its end is reported like any background command's.
   */
  const urgent = ctx.urgentMessages ? whenUrgent(ctx.urgentMessages, ctx.signal) : null;
  const settled = urgent ? await Promise.race([exited, urgent.promise]) : await exited;
  urgent?.cancel();
  if (settled === "urgent") {
    const now = runner.getProcess!(ctx.workspaceId, started.id) ?? started;
    if (now.status === "running") {
      runner.detachProcess?.(ctx.workspaceId, started.id);
      return {
        success: true,
        data: {
          ...describeProcess(now),
          output_so_far: runner.readProcessOutput!(ctx.workspaceId, started.id, 12_000),
          note:
            "Still running, no longer waited on: the person sent a message that could not wait, and it is " +
            "below. Read it first. The command was not stopped; it is stopped at its timeout " +
            `(${formatDuration(options.timeoutMs)}) if it has not ended by then. Check it with process_status or wait.`,
        },
      };
    }
  }
  const info = settled === "urgent" ? await exited : settled;
  const output = runner.readProcessOutput!(ctx.workspaceId, started.id, FOREGROUND_OUTPUT_CHARS);
  const error =
    info.status === "timed_out"
      ? `Timed out after ${formatDuration(options.timeoutMs)} and was stopped. If it needs longer, run it with ` +
        "run_in_background: true and wait for it."
      : info.stoppedBy === "user"
        ? "The user stopped this command."
        : info.stoppedBy === "cancelled"
          ? "Cancelled."
          : info.status === "failed"
            ? "The command could not be started."
            : info.exitCode !== 0
              ? `Command exited with code ${info.exitCode}`
              : undefined;

  return {
    success: info.status === "exited" && info.exitCode === 0,
    data: { ...describeProcess(info), output },
    ...(error ? { error } : {}),
  };
}

export async function toolProcessStatus(
  input: ProcessStatusInput,
  ctx: ToolExecutionContext,
): Promise<ToolResult<Record<string, unknown>>> {
  const parsed = ProcessStatusInputSchema.parse(input ?? {});
  const runner = ctx.sandboxRunner;
  if (!runner.listProcesses || !runner.getProcess || !runner.readRecentProcessOutput) {
    return { success: false, error: "This workspace does not keep track of processes." };
  }

  if (!parsed.process_id) {
    const all = runner.listProcesses(ctx.workspaceId);
    return {
      success: true,
      data: {
        processes: all.map(describeProcess),
        ...(all.length === 0 ? { note: "No commands have been started in this workspace yet." } : {}),
      },
    };
  }

  const info = runner.getProcess(ctx.workspaceId, parsed.process_id);
  if (!info) {
    return {
      success: false,
      error: `There is no process '${parsed.process_id}' in this workspace. Call process_status without process_id to list them.`,
    };
  }
  const recent = runner.readRecentProcessOutput(ctx.workspaceId, info.id, 64_000);
  return { success: true, data: { ...describeProcess(info), output: lastLines(recent, parsed.tail_lines ?? 80) } };
}

/**
 * Answer an interactive process, and see what it said back.
 *
 * Returns the output since the answer, after a short wait — the question
 * this answer leads to, or the error it caused — so one call is one turn of
 * the conversation with the program rather than a write and a separate read.
 */
export async function toolSendProcessInput(
  input: SendProcessInputInput,
  ctx: ToolExecutionContext,
): Promise<ToolResult<Record<string, unknown>>> {
  const parsed = SendProcessInputInputSchema.parse(input ?? {});
  const runner = ctx.sandboxRunner;
  if (!runner.writeProcessInput || !runner.getProcess || !runner.readRecentProcessOutput) {
    return { success: false, error: "This workspace cannot send input to processes." };
  }
  const before = runner.getProcess(ctx.workspaceId, parsed.process_id);
  if (!before) return { success: false, error: `No process '${parsed.process_id}' in this workspace.` };

  const text = parsed.press_enter === false ? parsed.text : `${parsed.text}\r`;
  if (!runner.writeProcessInput(ctx.workspaceId, parsed.process_id, text)) {
    return {
      success: false,
      error:
        before.status !== "running"
          ? `The process has already ${before.status === "exited" ? `exited (code ${before.exitCode})` : before.status}.`
          : "That process was not started with interactive: true, so its input is closed. Start it again interactively.",
    };
  }

  await sleep(parsed.wait_ms ?? 1_500, ctx.signal);
  const info = runner.getProcess(ctx.workspaceId, parsed.process_id) ?? before;
  return {
    success: true,
    data: {
      ...describeProcess(info),
      output: runner.readRecentProcessOutput(ctx.workspaceId, parsed.process_id, 6_000),
    },
  };
}

export async function toolStopProcess(
  input: StopProcessInput,
  ctx: ToolExecutionContext,
): Promise<ToolResult<Record<string, unknown>>> {
  const parsed = StopProcessInputSchema.parse(input ?? {});
  const runner = ctx.sandboxRunner;
  if (!runner.getProcess || !runner.stopProcess) {
    return { success: false, error: "This workspace does not keep track of processes." };
  }
  const info = runner.getProcess(ctx.workspaceId, parsed.process_id);
  if (!info) {
    return { success: false, error: `There is no process '${parsed.process_id}' in this workspace.` };
  }
  if (info.status !== "running") {
    return { success: true, data: { ...describeProcess(info), note: "It had already ended." } };
  }
  const stopped = await runner.stopProcess(ctx.workspaceId, info.id, "agent");
  return { success: true, data: describeProcess(stopped ?? info) };
}

export async function toolWait(input: WaitInput, ctx: ToolExecutionContext): Promise<ToolResult<Record<string, unknown>>> {
  const parsed = WaitInputSchema.parse(input ?? {});
  const runner = ctx.sandboxRunner;
  const startedAt = Date.now();

  let target: ProcessInfo | null = null;
  if (parsed.process_id) {
    if (!runner.getProcess) return { success: false, error: "This workspace does not keep track of processes." };
    target = runner.getProcess(ctx.workspaceId, parsed.process_id);
    if (!target) return { success: false, error: `There is no process '${parsed.process_id}' in this workspace.` };
  }
  // A line that has not come in three minutes is usually a wrong guess at the wording; an exit can take longer.
  const limitMs = (parsed.seconds ?? (target ? (parsed.until_output ? 180 : 600) : 60)) * 1000;
  const pattern = target ? parsed.until_output : undefined;

  type Outcome = "elapsed" | "exited" | "matched" | "ready" | "silent" | "message" | "news" | "cancelled";
  /** What ended the wait early, when news did. */
  let news = "";
  const wanted = pattern ? comparable(pattern) : "";
  /** When the output first said the server was up, while the text waited for had not appeared. */
  let readySince = 0;
  let readyLine = "";
  const outcome = await new Promise<Outcome>((resolve) => {
    let done = false;
    const checks = (): Outcome | null => {
      if (ctx.signal?.aborted) return "cancelled";
      if ((ctx.pendingMessages?.() ?? 0) > 0) return "message";
      if (target) {
        const current = runner.getProcess?.(ctx.workspaceId, target.id);
        if (wanted) {
          const output = runner.readRecentProcessOutput?.(ctx.workspaceId, target.id, 64_000) ?? "";
          // Compared as a person reads it: no colour codes, any case, any spacing.
          if (comparable(output).includes(wanted)) return "matched";
          /*
           * The text never came, but the server plainly did.
           *
           * A model guesses the line it will see — "Local: http://localhost:5173"
           * when the server took 5174, "Ready" when it prints "ready in". Waiting
           * out the whole limit for a guess, with the server already up, is the
           * wait that looks stuck. A little grace, then say so.
           */
          /*
           * Nothing at all, for a long while.
           *
           * Some programs hold their output back when they are not writing to a
           * terminal, and then the line never comes however long the wait. A
           * server that is up but silent looked like an agent that had stopped.
           */
          if (!output.trim() && current?.status === "running" && Date.now() - startedAt >= SILENT_GIVE_UP_MS) return "silent";
          const ready = READY_SIGNAL.exec(stripCodes(output));
          if (ready) {
            if (!readySince) {
              readySince = Date.now();
              readyLine = lineAround(stripCodes(output), ready.index);
            } else if (Date.now() - readySince >= READY_GRACE_MS) {
              return "ready";
            }
          }
        }
        if (!current || current.status !== "running") return "exited";
      }
      // Checked last, so the process waited on ending is reported as itself.
      const told = ctx.newsWaiting?.();
      if (told) {
        news = told;
        return "news";
      }
      return null;
    };
    const finish = (result: Outcome): void => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      clearInterval(poll);
      ctx.signal?.removeEventListener("abort", onAbort);
      resolve(result);
    };
    const onAbort = (): void => finish("cancelled");
    const timer = setTimeout(() => finish("elapsed"), limitMs);
    const poll = setInterval(() => {
      const result = checks();
      if (result) finish(result);
    }, WAIT_POLL_MS);
    ctx.signal?.addEventListener("abort", onAbort, { once: true });
    if (target) void runner.processExited?.(ctx.workspaceId, target.id)?.then(() => finish(pattern ? (checks() ?? "exited") : "exited"));
    const immediate = checks();
    if (immediate) finish(immediate);
  });

  const waited = formatDuration(Date.now() - startedAt);
  const current = target ? (runner.getProcess?.(ctx.workspaceId, target.id) ?? target) : null;
  const notes: Record<Outcome, string> = {
    elapsed: current?.status === "running"
      ? "The time ran out and it is still running. Wait again, check it with process_status, or stop it."
      : "The time is up.",
    exited: "The process has ended.",
    matched: "The output now contains the text you were waiting for.",
    ready:
      `The text you waited for ("${pattern ?? ""}") has not appeared, but the output shows it is ready: ` +
      `"${readyLine}". Check the output below — the port or wording may differ from what you expected.`,
    silent:
      `It is still running but has printed nothing in ${waited}, so "${pattern ?? ""}" may never appear ` +
      "(some programs hold output back when not in a terminal). Check it directly instead: open its URL, " +
      "or run a quick request against it.",
    message: "The user sent a message, which you will read next. Take it into account before waiting again.",
    news: `${news}; you will read about it next. Take it into account before waiting again.`,
    cancelled: "Cancelled.",
  };

  return {
    success: true,
    data: {
      waited,
      reason: outcome,
      note: notes[outcome],
      ...(current
        ? {
            process: describeProcess(current),
            output_tail: lastLines(runner.readRecentProcessOutput?.(ctx.workspaceId, current.id, 32_000) ?? "", 40),
          }
        : {}),
    },
  };
}
