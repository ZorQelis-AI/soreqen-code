/**
 * Not paying reasoning prices for mechanical steps.
 *
 * ## The observation
 *
 * A large share of an agent turn's model calls decide almost nothing. The
 * opening pass works out where files are. Several middle passes read a file
 * and choose the next one. The closing pass writes a summary of work that is
 * already finished. In between sit two or three calls that actually design and
 * write the change — and those are the only ones where model quality changes
 * the outcome.
 *
 * On the embedded surface every token is billed to whoever runs the service,
 * so this is margin. On the CLI it is the user's own key, so it is their bill.
 * Either way it is the same waste.
 *
 * ## The rule
 *
 * Classify each pass by what it is about to do, then pick a model:
 *
 *   - **orientation** — the first pass, and any pass whose last action was a
 *     read. Cheap model.
 *   - **synthesis** — a pass following a failed check, a pass that is about to
 *     write code, a pass carrying a plan. Strong model.
 *   - **summary** — the final pass, once no tools are being called. Cheap
 *     model: it is describing work that is already done, and the facts are all
 *     in the transcript.
 *
 * ## Why this is off by default
 *
 * Because it cannot be turned on responsibly without measurement, and the
 * measurement is the hard part. A routing policy that saves 40% of spend and
 * costs 5% of task success is a bad trade that shows up as support tickets
 * rather than as a number — which is why `eval-harness.ts` exists and why this
 * file's default is `disabled`.
 *
 * The honest summary: the mechanism is here, it is tested, and it stays off
 * until a run of the harness says what it costs in quality on real tasks.
 *
 * ## And why Apex turns it off outright
 *
 * At the top effort tier the user has explicitly asked for the best answer
 * available. Handing any part of that turn to a cheaper model to save money
 * they have already agreed to spend is a straightforward breach of what they
 * bought.
 */

import type { LLMMessage } from "./types.js";
import type { Effort } from "@sqcode/shared";
import { EFFORT } from "@sqcode/shared";

export type StepKind = "orientation" | "synthesis" | "summary";

export interface RoutingPolicy {
  /** Off by default. See the note above. */
  enabled: boolean;
  /** Handles synthesis, and everything else when routing is off. */
  strongModel: string;
  /** Handles orientation and summary when routing is on. */
  fastModel?: string;
}

export interface RoutingDecision {
  model: string;
  step: StepKind;
  /** Why this model, in a clause. Recorded on the turn so a quality
   *  regression can be traced to a routing choice rather than guessed at. */
  reason: string;
}

export const DEFAULT_POLICY: RoutingPolicy = {
  enabled: false,
  strongModel: "mimo-v2.6-flash",
};

/**
 * What this pass is for.
 *
 * Decided from the history rather than from anything the model says about
 * itself, because a model announcing "now I will just quickly check something"
 * immediately before writing four files is a normal Tuesday.
 */
export function classifyStep(history: LLMMessage[], iteration: number): StepKind {
  // The opening pass has nothing to synthesise from.
  if (iteration <= 1) return "orientation";

  const recent = history.slice(-6);

  /*
   * A failed check outranks everything.
   *
   * The pass after a verification failure is the hardest one in the turn — the
   * agent has to diagnose from a compiler's opinion — and it is exactly where
   * a cheap model produces a plausible wrong fix that then has to be undone.
   */
  const failureNearby = recent.some(
    (m) =>
      m.role === "tool" &&
      typeof m.content === "string" &&
      /error|failed|exception|does not pass|cannot find|expected/i.test(m.content),
  );
  if (failureNearby) return "synthesis";

  const lastAssistant = [...history].reverse().find((m) => m.role === "assistant");
  const lastCalls = lastAssistant?.toolCalls ?? [];

  // About to write, or has just written: the decisions are here.
  if (lastCalls.some((c) => WRITING_TOOLS.has(c.name))) return "synthesis";

  // A plan was posted, which means the next pass acts on it.
  if (lastCalls.some((c) => c.name === "update_todo_list")) return "synthesis";

  // Only reads so far. Still finding its way around.
  if (lastCalls.length > 0 && lastCalls.every((c) => READING_TOOLS.has(c.name))) {
    return "orientation";
  }

  // No tool calls at all in the last assistant turn: it is talking, which at
  // this point in a turn means summarising.
  if (lastCalls.length === 0) return "summary";

  return "synthesis";
}

const WRITING_TOOLS = new Set([
  "edit_file",
  "write_file",
  "run_command",
  "git_operation",
  "install_package",
  "spawn_subagent",
]);

const READING_TOOLS = new Set([
  "process_status",
  "wait",
  "schedule_wakeup",
  "read_file",
  "list_directory",
  "grep_search",
  "glob",
  "find_symbol_definition",
  "find_symbol_references",
  "web_search",
  "fetch_url_content",
  "research",
]);

/**
 * Pick the model for this pass.
 *
 * Falls back to the strong model on every uncertainty: no fast model
 * configured, routing disabled, an effort tier that forbids it. The failure
 * direction is deliberate — a routing bug should cost money, not quality,
 * because one of those is visible on a dashboard the same day and the other is
 * not visible at all.
 */
export function routeStep(
  policy: RoutingPolicy,
  history: LLMMessage[],
  iteration: number,
  effort?: Effort,
): RoutingDecision {
  const step = classifyStep(history, iteration);

  if (effort && !EFFORT[effort].allowModelRouting) {
    return {
      model: policy.strongModel,
      step,
      reason: `effort '${effort}' uses one model throughout`,
    };
  }

  if (!policy.enabled || !policy.fastModel) {
    return { model: policy.strongModel, step, reason: "routing disabled" };
  }

  if (step === "synthesis") {
    return { model: policy.strongModel, step, reason: "this step designs or writes code" };
  }

  return {
    model: policy.fastModel,
    step,
    reason: step === "orientation" ? "this step is finding its way around" : "this step summarises finished work",
  };
}

/**
 * Where a routing policy comes from.
 *
 * Environment rather than a config file, so enabling it on the hosted surface
 * is a deploy-time decision and enabling it in the CLI is deliberate. There is
 * no UI for it on purpose: it is not a user-facing setting until the harness
 * has an opinion about it.
 */
export function policyFromEnv(env: NodeJS.ProcessEnv = process.env): RoutingPolicy {
  const strong = env["SOREQEN_MODEL"] ?? DEFAULT_POLICY.strongModel;
  const fast = env["SOREQEN_FAST_MODEL"];
  const enabled = env["SOREQEN_MODEL_ROUTING"] === "1" && Boolean(fast);
  return { enabled, strongModel: strong, ...(fast ? { fastModel: fast } : {}) };
}
