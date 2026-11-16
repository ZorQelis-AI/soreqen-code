/**
 * Smart Loop mode: `/goal <objective>`.
 *
 * One turn of an agent ends when the model decides it has said enough, and on
 * a big objective — an engine, a compiler, a whole product — that is long
 * before the objective is met. A goal keeps going: when a turn ends, the next
 * one starts by itself, reads where the work stands, and carries on. It runs
 * for as many turns as the objective takes, hours or days, and stops for four
 * reasons only:
 *
 *   - **achieved**, and then only after a turn spent checking that it is —
 *     the first "done" of a long task is usually premature, and a goal that
 *     believed it would close with half the work missing;
 *   - **blocked**: the agent needs something only the person has (a key, an
 *     account, a decision it must not take alone);
 *   - **stuck**: turns that change nothing, or keep failing, pause it rather
 *     than burn a night's credits going round in a circle;
 *   - **stopped** by the person.
 *
 * Paused is not over: it resumes where it was. The plan lives in GOAL.md in
 * the project, not in the conversation, so it survives compaction, restarts
 * and a model change — which a days-long task will see all of.
 *
 * This file is the policy, without I/O. The API gateway (routes.ts) and the
 * CLI each run it; it lives here, in the open-source core, so both run the
 * same goal (moved from the gateway 13 Nov 2026, when the CLI gained /goal).
 */

import type { GoalState } from "@sqcode/shared";

/** Turns in a row that changed no file before a goal is paused as stuck. */
export const IDLE_LIMIT = 4;
/** Failed turns in a row before a goal is paused. */
export const FAILURE_LIMIT = 3;
/** A ceiling, so a goal nobody watches cannot run for ever. */
export const TURN_LIMIT = 2000;
const OBJECTIVE_LIMIT = 8000;

export type GoalMarker = { state: "achieved" | "continuing" | "blocked"; note: string };

/**
 * The status line a goal turn ends with: `[goal: continuing] what is next`.
 * The last one counts — a reply that quotes the format before using it must
 * not be read by its quotation.
 */
export function readGoalMarker(text: string): GoalMarker | null {
  const re = /^[\s>*_`]*\[?\s*goal\s*(?:status)?\s*:\s*(achieved|complete|completed|done|continuing|in[ -]progress|blocked)\s*\]?[\s*_`]*[:\-–—]?\s*(.*)$/gim;
  let last: GoalMarker | null = null;
  for (const m of text.matchAll(re)) {
    const word = m[1]!.toLowerCase();
    const state = word === "blocked" ? "blocked" : /^(achieved|complete|completed|done)$/.test(word) ? "achieved" : "continuing";
    last = { state, note: (m[2] ?? "").replace(/[*_`]+$/g, "").trim().slice(0, 400) };
  }
  return last;
}

/**
 * The text a goal reads its status line from: every reply of the turn, so
 * the latest status the model stated counts even when a later reply (after
 * the turn-record check sent it back to work) did not repeat it.
 */
export function goalStatusText(turn: { finalResponse: string; replies?: string[] }): string {
  return turn.replies && turn.replies.length > 0 ? turn.replies.join("\n\n") : turn.finalResponse;
}

export function newGoal(objective: string, now = Date.now()): GoalState {
  return {
    objective: objective.trim().slice(0, OBJECTIVE_LIMIT),
    status: "active",
    startedAt: now,
    updatedAt: now,
    turns: 0,
    filesChanged: 0,
    idleTurns: 0,
    failures: 0,
  };
}

/** Continuation messages start with this, so a page can show them as a divider rather than a message. */
export const GOAL_TURN_PREFIX = "[goal turn ";

const RULES = [
  "How a goal works:",
  "- You are started again automatically after every turn until the objective is achieved. There is no need to finish in one turn, and no reason to stop early: make as much solid progress as you can in each turn, then hand over cleanly.",
  "- GOAL.md in the project root is the plan and the memory of this goal: the objective, the milestones as a checklist, decisions and their reasons, what is done, what is next, known problems. Create it in the first turn; read it at the start of every turn; update it before every turn ends. The conversation will be compacted, the plan must not be.",
  "- Work milestone by milestone. Each milestone ends working: it builds, its tests pass, you have run it. Never leave the project broken at the end of a turn.",
  "- Do not ask the person questions. Make sensible, conventional choices, record them in GOAL.md, and keep going. Only stop for something only they can provide (credentials, an account, a payment, a decision with legal or irreversible consequences).",
  "- Be honest about scale. Real, working, tested code beats line count; never pad, stub or fake progress to look further along.",
  "- End every turn's reply with exactly one status line, alone on the last line:",
  "  [goal: continuing] <what this turn finished, and what the next turn starts with>",
  "  [goal: achieved] <the evidence: what you built, ran and tested that shows the whole objective is met>",
  "  [goal: blocked] <exactly what you need from the person>",
].join("\n");

/** The first turn: the objective, and how to work toward it. */
export function goalKickoff(goal: GoalState): string {
  return [
    "/goal — Smart Loop mode.",
    "",
    "Objective:",
    goal.objective,
    "",
    RULES,
    "",
    "This first turn: study the project as it is, break the objective into milestones (small enough to finish and verify one at a time, ordered so each builds on working code), write GOAL.md, and then start on the first milestone.",
  ].join("\n");
}

/** A goal's first prompt names the session by its objective, not by "/goal — Smart Loop mode." */
export function titleSourceOf(content: string): string {
  if (!content.startsWith("/goal — Smart Loop mode.")) return content;
  return /Objective:\r?\n([\s\S]*?)\r?\n\r?\nHow a goal works:/.exec(content)?.[1]?.trim() || content;
}

/** Every turn after the first. */
export function goalContinuation(goal: GoalState): string {
  const head = `${GOAL_TURN_PREFIX}${goal.turns + 1}]`;
  if (goal.verifying) {
    return [
      head,
      "You reported the goal achieved. Before it is closed, verify that claim as a skeptical reviewer would, against the objective below, not against GOAL.md's checklist:",
      "- build it from clean and run every test;",
      "- run the thing itself and exercise each part of the objective;",
      "- look for what is missing, stubbed, hard-coded or only claimed.",
      "Fix whatever falls short, then end with [goal: achieved] and the evidence only if all of it holds; otherwise update GOAL.md with what remains and end with [goal: continuing].",
      "",
      "Objective:",
      goal.objective,
    ].join("\n");
  }
  return [
    head,
    "Continue the goal. Read GOAL.md, check the project still builds, and carry on with the next unfinished milestone. Update GOAL.md before you finish, and end with the status line.",
    ...(goal.idleTurns > 0
      ? [`The last ${goal.idleTurns === 1 ? "turn" : `${goal.idleTurns} turns`} changed no files. Unless verification is genuinely what remains, get back to building.`]
      : []),
    "",
    "Objective:",
    goal.objective,
    "",
    RULES,
  ].join("\n");
}

export interface GoalTurnOutcome {
  stopReason: "completed" | "max_iterations" | "token_budget_exhausted" | "cancelled" | "failed";
  finalResponse: string;
  modifiedFiles: number;
  toolCalls: number;
  error?: string;
}

/**
 * What a finished turn means for the goal: its new state, and whether (and
 * after how long) the next turn starts.
 */
export function afterGoalTurn(goal: GoalState, turn: GoalTurnOutcome, now = Date.now()): { goal: GoalState; next: { delayMs: number } | null } {
  const base: GoalState = { ...goal, turns: goal.turns + 1, updatedAt: now, filesChanged: goal.filesChanged + turn.modifiedFiles };
  const pause = (note: string): { goal: GoalState; next: null } => ({ goal: { ...base, status: "paused", verifying: false, note }, next: null });

  if (turn.stopReason === "cancelled") return pause("Stopped. Resume when you are ready.");

  if (turn.stopReason === "failed") {
    const failures = goal.failures + 1;
    if (failures >= FAILURE_LIMIT) {
      return { goal: { ...base, failures, status: "paused", note: `Paused after ${failures} failed turns in a row${turn.error ? `: ${turn.error.slice(0, 200)}` : "."}` }, next: null };
    }
    // A provider that is down or rate-limiting: give it longer each time.
    return { goal: { ...base, failures, note: `Turn failed; trying again${turn.error ? ` (${turn.error.slice(0, 120)})` : ""}` }, next: { delayMs: 30_000 * failures } };
  }

  const marker = readGoalMarker(turn.finalResponse);
  const progressed = turn.modifiedFiles > 0;
  const idleTurns = progressed ? 0 : goal.idleTurns + 1;
  const running: GoalState = { ...base, failures: 0, idleTurns };

  if (marker?.state === "blocked") {
    return { goal: { ...running, status: "paused", verifying: false, note: marker.note || "The agent needs something from you." }, next: null };
  }
  if (marker?.state === "achieved") {
    if (goal.verifying) return { goal: { ...running, status: "achieved", verifying: false, note: marker.note || "Achieved and verified." }, next: null };
    return { goal: { ...running, verifying: true, idleTurns: 0, note: marker.note || "Reported achieved; verifying." }, next: { delayMs: 0 } };
  }

  if (running.turns >= TURN_LIMIT) return pause(`Paused after ${TURN_LIMIT} turns. Resume to keep going.`);
  if (idleTurns >= IDLE_LIMIT) return pause(`Paused: ${idleTurns} turns in a row changed no files. Resume if there is still work to do, or send a message to steer it.`);
  // A turn that ran out of steps or budget mid-milestone simply continues.
  return { goal: { ...running, verifying: false, note: marker?.note || goal.note }, next: { delayMs: 0 } };
}

export function goalOf(value: unknown): GoalState | null {
  if (!value || typeof value !== "object") return null;
  const g = value as Partial<GoalState>;
  if (typeof g.objective !== "string" || typeof g.status !== "string") return null;
  return {
    objective: g.objective,
    status: g.status,
    startedAt: Number(g.startedAt) || Date.now(),
    updatedAt: Number(g.updatedAt) || Date.now(),
    turns: Number(g.turns) || 0,
    filesChanged: Number(g.filesChanged) || 0,
    idleTurns: Number(g.idleTurns) || 0,
    failures: Number(g.failures) || 0,
    ...(g.verifying ? { verifying: true } : {}),
    ...(typeof g.note === "string" ? { note: g.note } : {}),
  };
}
