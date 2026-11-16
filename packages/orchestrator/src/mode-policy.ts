/**
 * The mode layer, on top of the tier layer.
 *
 * ## Two questions, asked in order
 *
 * `guardrails.ts` answers *may this happen at all* — a boundary the workspace
 * sets, that a client cannot widen. This file answers *does a person need to
 * be asked first* — a preference the person driving the session sets, that
 * cannot loosen the boundary underneath it.
 *
 * Keeping them separate is what stops the permission model from migrating into
 * a dropdown. Every decision here runs the tier check first and can only ever
 * make the answer *more* restrictive:
 *
 *   deny → stays denied, in every mode, including bypass.
 *   allow → a mode may still decide to ask.
 *   confirm → a mode may not decide to stop asking, except bypass, which is
 *             the mode whose entire definition is that it does not ask.
 *
 * ## What each mode does with the answer
 *
 * **plan** — enforced as `read_only`, so mutation is denied outright rather
 * than confirmed. A plan-mode session that could write behind a prompt would
 * be a manual-mode session with a misleading name.
 *
 * **manual** — enforced as `propose_only`. Everything that changes anything
 * asks, exactly once, per action.
 *
 * **auto** — enforced as `guarded_autonomy`, then the reversibility rule
 * decides. Reversible work proceeds silently; anything a checkpoint cannot
 * take back asks, with the reason stated. If the workspace could not be
 * checkpointed, the rule's premise is gone and it falls back to `manual`'s
 * behaviour — loudly, since a mode that quietly stops being what it says it
 * is, is worse than one that never worked.
 *
 * **bypass** — enforced as `full_autonomy`, then every confirmation is
 * skipped. Note the ordering: the *tier* check still runs, so the hard
 * denylist still applies. "Accepts all permissions" is a statement about
 * prompts, not about the sandbox's structural limits — there is no prompt
 * behind which a fork bomb becomes acceptable.
 */

import type { PermissionTier } from "@sqcode/shared";
import { type AgentMode, tierForMode } from "@sqcode/shared";
import type { LLMToolCall } from "./types.js";
import { evaluateToolPermission, type PermissionCheckResult } from "./guardrails.js";
import { classifyReversibility } from "./reversibility.js";

export interface ModeDecisionContext {
  mode: AgentMode;
  /** Whether a checkpoint was taken for this turn. `auto`'s rule depends on
   *  it; every other mode ignores it. */
  checkpointAvailable: boolean;
  /**
   * The workspace's own ceiling.
   *
   * The narrower of this and the mode's tier is what gets enforced, so a
   * read-only workspace stays read-only even if someone selects bypass. The
   * gateway does this clamp too; doing it here as well means the orchestrator
   * is safe when called directly, which the CLI does.
   */
  workspaceTier?: PermissionTier;
}

export interface ModeDecision extends PermissionCheckResult {
  /** The tier that was actually enforced, after clamping. */
  effectiveTier: PermissionTier;
  /** Present when the mode changed the tier's answer, so the reason shown to
   *  a user says which layer decided. */
  decidedBy: "tier" | "mode";
  /** True when `auto` fell back because there was no checkpoint. Surfaced so
   *  the interface can say why it started asking. */
  degraded?: boolean;
}

const RANK: PermissionTier[] = ["read_only", "propose_only", "guarded_autonomy", "full_autonomy"];

/** The narrower of two tiers. */
export function clampTier(a: PermissionTier, b: PermissionTier): PermissionTier {
  return RANK[Math.min(RANK.indexOf(a), RANK.indexOf(b))]!;
}

export function evaluateForMode(toolCall: LLMToolCall, ctx: ModeDecisionContext): ModeDecision {
  const modeTier = tierForMode(ctx.mode);
  const effectiveTier = ctx.workspaceTier ? clampTier(modeTier, ctx.workspaceTier) : modeTier;

  const base = evaluateToolPermission(toolCall, effectiveTier);

  // A denial is a denial. No mode reaches past it — that is the point of
  // having a layer underneath.
  if (!base.allowed) {
    return { ...base, effectiveTier, decidedBy: "tier" };
  }

  if (ctx.mode === "bypass") {
    /*
     * The only place a confirmation is dropped.
     *
     * Everything reaching here already passed the hard denylist, so what is
     * being skipped is the *ask*, not the check. That is what the mode says on
     * the label, and a mode that quietly kept prompting would be worse than
     * not offering it.
     */
    return {
      allowed: true,
      requiresConfirmation: false,
      reason: base.requiresConfirmation
        ? `Approved without asking (bypass mode): ${base.reason ?? "sensitive action"}`
        : undefined,
      effectiveTier,
      decidedBy: base.requiresConfirmation ? "mode" : "tier",
    };
  }

  if (ctx.mode === "auto") {
    if (!ctx.checkpointAvailable) {
      /*
       * The premise failed, so the *relaxation* does not apply.
       *
       * `auto` skips confirmations because a checkpoint makes the result
       * undoable. Without one that argument is gone, so the relaxation is
       * withdrawn and the tier's own judgment stands.
       *
       * What it deliberately does **not** do is start asking about ordinary
       * edits. The first version of this did, and it was wrong in a way worth
       * recording: before checkpoints existed, `guarded_autonomy` edited files
       * without asking and nobody had an undo — that was the baseline, and it
       * was fine. Making `auto` *stricter* than that baseline because a
       * snapshot failed is a regression wearing safety's clothes. It fires on
       * every workspace without git, and it broke every caller that had no
       * confirmation handler at all: the prompt goes unanswered, the edit is
       * refused, and the agent silently cannot work.
       *
       * So the degradation is: you lose the undo, and you lose the relaxation.
       * You do not gain prompts you never used to get.
       *
       * The reversibility check below is kept, because it is strictly better
       * than the tier's static list and catches one-way actions that list
       * misses. That part is an improvement, not a regression, so it survives
       * the premise failing.
       */
      if (base.requiresConfirmation) {
        return { ...base, effectiveTier, decidedBy: "tier", degraded: true };
      }
      const verdict = classifyReversibility(toolCall);
      if (!verdict.reversible && !MUTATING_TOOLS.has(toolCall.name)) {
        return {
          allowed: true,
          requiresConfirmation: true,
          reason:
            `This ${verdict.reason}, and this workspace could not be checkpointed — ` +
            `so there is no way back from it.`,
          effectiveTier,
          decidedBy: "mode",
          degraded: true,
        };
      }
      if (!verdict.reversible && OUTSIDE_THE_WORKSPACE.has(toolCall.name)) {
        return {
          allowed: true,
          requiresConfirmation: true,
          reason: `This ${verdict.reason}, and there is no checkpoint to fall back on.`,
          effectiveTier,
          decidedBy: "mode",
          degraded: true,
        };
      }
      return { ...base, effectiveTier, decidedBy: "tier", degraded: true };
    }

    /*
     * The relaxation stops at the workspace's own ceiling.
     *
     * `auto` may waive a confirmation that *its own tier* — guarded_autonomy —
     * would have asked for, because a checkpoint covers the action. It may not
     * waive one that a **narrower workspace tier** imposed. A workspace
     * provisioned as `propose_only` means "a person approves each change here",
     * and that is a server-side fact about the workspace, not a preference the
     * session can reason its way out of by observing that the change happens
     * to be undoable.
     *
     * Without this check, selecting Auto on a propose-only workspace silently
     * turned it into guarded autonomy — the mode widening access past the tier,
     * which is the one thing the whole two-layer design exists to prevent. The
     * tier was clamped correctly and then ignored, which is the most
     * comfortable kind of bug: every layer looks right on its own.
     */
    const relaxable = effectiveTier === modeTier;

    const verdict = classifyReversibility(toolCall);
    if (verdict.reversible) {
      if (!relaxable) {
        return { ...base, effectiveTier, decidedBy: "tier" };
      }
      /*
       * The whole point of the mode.
       *
       * This overrides a *mode-tier* confirmation: `guarded_autonomy` asks
       * about a recursive delete inside the workspace and `auto` does not,
       * because a checkpoint restores it exactly. Overriding downward happens
       * here and nowhere else, only on a verdict this file can defend, and
       * only when the workspace has not asked for something stricter.
       */
      return { allowed: true, requiresConfirmation: false, effectiveTier, decidedBy: "mode" };
    }

    return {
      allowed: true,
      requiresConfirmation: true,
      reason: `This ${verdict.reason}. A checkpoint cannot undo it, so SoreQen is asking first.`,
      effectiveTier,
      decidedBy: "mode",
    };
  }

  // plan and manual take the tier's answer unchanged: read_only denies
  // mutation outright, propose_only confirms each one.
  return { ...base, effectiveTier, decidedBy: "tier" };
}

/**
 * Tools that change the workspace.
 *
 * Used only by `auto`'s degraded path, to decide what to ask about when there
 * is no checkpoint. The list is the complement of the read-only set in
 * `guardrails.ts`; it is spelled out rather than derived so that a new tool
 * added to neither list defaults to *asking*.
 */
const MUTATING_TOOLS = new Set([
  "edit_file",
  "write_file",
  "run_command",
  "git_operation",
  "install_package",
  "browser_interact",
  "browser_batch",
]);

/*
 * `spawn_subagent` is deliberately absent.
 *
 * This set is an *exemption* from degraded `auto`'s "ask about anything
 * irreversible" rule, not a list of things to gate — adding a tool here makes
 * it ask *less*. A sub-agent runs a full nested turn with the parent's own
 * mode, so it can do anything the parent could; leaving it out is what keeps
 * degraded `auto` asking before one starts.
 */

/**
 * Tools whose effects land outside the workspace by nature.
 *
 * These still ask in degraded `auto`, because a checkpoint was never going to
 * help with them and the tier's static list does not catch all of them —
 * `install_package` in particular runs arbitrary install scripts and is
 * allowed outright by `guarded_autonomy`.
 */
const OUTSIDE_THE_WORKSPACE = new Set(["install_package", "git_operation"]);

/**
 * One line describing how this mode will behave, for the banner and the
 * mode-change confirmation.
 *
 * Written from the user's side — what will happen to them — rather than from
 * the policy's, because "propose_only, clamped against workspace tier" is
 * true and tells nobody anything.
 */
export function describeModeBehaviour(mode: AgentMode, checkpointAvailable: boolean): string {
  switch (mode) {
    case "plan":
      return "Reads and investigates only. It will write a plan and stop; nothing changes until you say so.";
    case "manual":
      return "Asks before every change. Each edit, command, and commit needs your approval.";
    case "auto":
      return checkpointAvailable
        ? "Works without asking, and stops only for things a checkpoint cannot undo — pushes, publishes, installs, anything leaving this machine."
        : "This workspace cannot be checkpointed, so Auto is asking before changes it cannot undo for you.";
    case "bypass":
      return "Never asks. Every permission is granted automatically; only structurally unsafe actions are still refused.";
  }
}
