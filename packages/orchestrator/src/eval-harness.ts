/**
 * Measuring whether a change made the agent worse.
 *
 * ## Why this exists before the thing it measures
 *
 * Model routing is the largest margin lever available, and it is also the
 * easiest way to quietly degrade the product. A policy that cuts spend by 40%
 * and task success by 5% looks like a win on the only dashboard anyone is
 * watching, and the 5% arrives later as support tickets, individually
 * unattributable. The same is true of a smaller context budget, a more
 * aggressive compaction rule, a cheaper verification step — every one of the
 * optimisations in this codebase trades something that is measured against
 * something that was not.
 *
 * So: a small, honest harness that runs real tasks end to end in a throwaway
 * workspace and reports **success, cost and time** for a configuration. It is
 * not a benchmark and does not pretend to be one. Eight tasks cannot tell you
 * a model is good. They can tell you that a change you just made broke three
 * of them, which is the question actually being asked.
 *
 * ## What makes a task here worth having
 *
 * Each one asserts on the **workspace afterwards**, never on the agent's prose.
 * "Did it say it fixed the test" and "did it fix the test" are different
 * questions, and only the second is worth measuring — an agent that has
 * learned to describe success convincingly is the specific failure this guards
 * against.
 *
 * Several tasks assert on what did *not* happen: an untouched unrelated file,
 * an absent hardcoded credential, a test that was not weakened to make it
 * pass. Those are where cheaper configurations fail first, and a harness made
 * only of "did it do the thing" would score them as unchanged.
 */

import type { SandboxRunner } from "@sqcode/sandbox-runner";
import type { LLMProvider } from "./types.js";
import type { Effort } from "@sqcode/shared";
import { runAgentTurn } from "./agent-loop.js";
import type { RoutingPolicy } from "./model-router.js";

export interface EvalContext {
  readFile: (path: string) => Promise<string | null>;
  exec: (command: string) => Promise<{ exitCode: number; stdout: string; stderr: string }>;
  /** The agent's final message, for the rare assertion that is genuinely
   *  about what it reported rather than what it did. */
  finalResponse: string;
  /** Files the turn wrote to, as reported by the loop. */
  modifiedFiles: string[];
}

export interface EvalTask {
  id: string;
  /** One line, shown in the report. */
  description: string;
  /** Files the workspace starts with. */
  fixture: Record<string, string>;
  prompt: string;
  /** Runs after the turn. Returns why it failed, or null if it passed. */
  check: (ctx: EvalContext) => Promise<string | null>;
  /** Loop passes allowed. Kept low: a task that needs thirty steps is not
   *  measuring what this harness measures. */
  maxIterations?: number;
}

export interface TaskResult {
  taskId: string;
  passed: boolean;
  failure?: string;
  estimatedTokens: number;
  toolCalls: number;
  durationMs: number;
  stopReason: string;
  error?: string;
}

export interface EvalRun {
  label: string;
  results: TaskResult[];
  passed: number;
  total: number;
  totalTokens: number;
  totalMs: number;
}

export interface EvalConfig {
  /** Names this run in the comparison table. */
  label: string;
  llmProvider: LLMProvider;
  model?: string;
  effort?: Effort;
  routing?: RoutingPolicy;
  /** Fresh workspace per task, created and destroyed by the harness. */
  sandboxRunner: SandboxRunner;
}

/**
 * Run one task in its own workspace.
 *
 * The workspace is created, seeded, used and destroyed inside this function,
 * so a task that leaves the workspace in a strange state cannot affect the
 * next one — which matters more than it sounds, because the tasks most worth
 * having are the ones that go wrong.
 */
export async function runTask(task: EvalTask, config: EvalConfig): Promise<TaskResult> {
  const workspaceId = `eval_${task.id}_${Date.now()}`;
  const started = Date.now();

  try {
    await config.sandboxRunner.createWorkspace(workspaceId);

    for (const [path, content] of Object.entries(task.fixture)) {
      await config.sandboxRunner.writeFile(workspaceId, path, content, true);
    }

    const turn = await runAgentTurn({
      workspaceId,
      sessionId: `eval_${task.id}`,
      mode: "bypass",
      userMessage: task.prompt,
      sandboxRunner: config.sandboxRunner,
      llmProvider: config.llmProvider,
      model: config.model,
      effort: config.effort,
      routing: config.routing,
      maxIterations: task.maxIterations ?? 15,
    });

    const ctx: EvalContext = {
      readFile: async (path) => {
        try {
          const res = await config.sandboxRunner.readFile(workspaceId, path);
          return res.content;
        } catch {
          return null;
        }
      },
      exec: async (command) => {
        const res = await config.sandboxRunner.execCommand(workspaceId, {
          command,
          timeoutMs: 60_000,
        });
        return { exitCode: res.exitCode, stdout: res.stdout ?? "", stderr: res.stderr ?? "" };
      },
      finalResponse: turn.finalResponse,
      modifiedFiles: turn.modifiedFiles,
    };

    const failure = await task.check(ctx);

    return {
      taskId: task.id,
      passed: failure === null,
      ...(failure ? { failure } : {}),
      estimatedTokens: turn.estimatedTokensUsed,
      toolCalls: turn.toolCallsExecuted,
      durationMs: Date.now() - started,
      stopReason: turn.stopReason,
    };
  } catch (err: unknown) {
    /*
     * A crashed task is a failed task, not a missing data point.
     *
     * Silently skipping errors is how a harness reports 8/8 for a
     * configuration that could not complete a single turn.
     */
    return {
      taskId: task.id,
      passed: false,
      estimatedTokens: 0,
      toolCalls: 0,
      durationMs: Date.now() - started,
      stopReason: "error",
      error: err instanceof Error ? err.message : String(err),
    };
  } finally {
    try {
      await config.sandboxRunner.destroyWorkspace(workspaceId);
    } catch {
      // A workspace that will not delete is a mess, not a result.
    }
  }
}

/** Run every task under one configuration. Sequential on purpose: concurrent
 *  runs contend for the same rate limit and the timings stop meaning
 *  anything. */
export async function runEval(tasks: EvalTask[], config: EvalConfig): Promise<EvalRun> {
  const results: TaskResult[] = [];
  for (const task of tasks) {
    results.push(await runTask(task, config));
  }

  return {
    label: config.label,
    results,
    passed: results.filter((r) => r.passed).length,
    total: results.length,
    totalTokens: results.reduce((sum, r) => sum + r.estimatedTokens, 0),
    totalMs: results.reduce((sum, r) => sum + r.durationMs, 0),
  };
}

/**
 * The comparison, as text.
 *
 * Deliberately shows quality and cost side by side and never a single score
 * combining them. There is no exchange rate between "one more task passes" and
 * "twelve thousand fewer tokens" that is not a policy decision, and a harness
 * that invents one has made that decision on the reader's behalf and hidden it
 * in an arithmetic mean.
 */
export function formatComparison(runs: EvalRun[]): string {
  if (runs.length === 0) return "No runs.";

  const lines: string[] = [];
  const width = Math.max(...runs.map((r) => r.label.length), 12);

  lines.push(
    `${"config".padEnd(width)}  ${"passed".padStart(7)}  ${"tokens".padStart(10)}  ${"time".padStart(8)}`,
  );
  lines.push("-".repeat(width + 32));

  for (const run of runs) {
    lines.push(
      `${run.label.padEnd(width)}  ` +
        `${`${run.passed}/${run.total}`.padStart(7)}  ` +
        `${run.totalTokens.toLocaleString().padStart(10)}  ` +
        `${`${(run.totalMs / 1000).toFixed(1)}s`.padStart(8)}`,
    );
  }

  // Per-task detail, since the aggregate hides which task regressed — and
  // "which one" is the entire reason anybody runs this.
  const taskIds = [...new Set(runs.flatMap((r) => r.results.map((t) => t.taskId)))];
  lines.push("");
  lines.push("by task:");
  for (const id of taskIds) {
    const marks = runs
      .map((run) => {
        const result = run.results.find((t) => t.taskId === id);
        if (!result) return "?";
        return result.passed ? "pass" : "FAIL";
      })
      .join("  ");
    lines.push(`  ${id.padEnd(24)} ${marks}`);
  }

  const failures = runs.flatMap((run) =>
    run.results
      .filter((r) => !r.passed)
      .map((r) => `  ${run.label} / ${r.taskId}: ${r.failure ?? r.error ?? "unknown"}`),
  );
  if (failures.length > 0) {
    lines.push("");
    lines.push("failures:");
    lines.push(...failures);
  }

  return lines.join("\n");
}
