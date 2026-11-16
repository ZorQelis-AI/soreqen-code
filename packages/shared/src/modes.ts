/**
 * The four modes.
 *
 * ## Why a mode is not a tier
 *
 * The system already had `PermissionTier` — four values describing what the
 * agent is *permitted* to do. Tiers are a server-side fact: a workspace is
 * provisioned at a tier, and the gateway clamps every request against it so a
 * client can narrow access but never widen it. That property is load-bearing
 * and is not changing.
 *
 * A **mode** is a different thing wearing similar clothes. It is what the
 * person driving the session picks, right now, in the composer or with
 * `/mode` — and it says how they want to work, not what the workspace allows.
 * Two of the four modes are not expressible as a tier at all:
 *
 *   - **plan** is read-only *plus* an obligation to produce a plan. The tier
 *     half is enforcement; the plan half is behaviour, and lives in the
 *     prompt.
 *   - **auto** is guarded autonomy *plus* a different rule for deciding what
 *     to ask about — see below. Same tier, different judgment.
 *
 * So modes resolve down to a tier for enforcement and carry the rest as
 * explicit flags. The clamp still applies to the resolved tier, which means a
 * read-only workspace stays read-only no matter which mode is selected. Mode
 * is a preference; tier is a boundary. Confusing the two is how a permission
 * model ends up living in a dropdown.
 *
 * ## The rule that makes `auto` defensible
 *
 * "SoreQen handles the permission decision" is easy to say and easy to get
 * wrong. A mode that silently approves whatever it feels like is not a
 * feature, it is bypass mode with better marketing.
 *
 * The rule is narrow and mechanical:
 *
 *   > **If a checkpoint can undo it, don't ask. If it can't, ask.**
 *
 * A checkpoint snapshots the workspace's files before the turn. It therefore
 * restores anything that only touched those files — every edit, every write,
 * every local `rm`, a failed refactor across forty files. It restores nothing
 * that left the machine or left the moment: a `git push` other people have
 * pulled, a published package, a dropped table, an install script that ran,
 * a `sudo` that changed the host.
 *
 * So `auto` asks about exactly the actions whose consequences outlive the
 * undo, and nothing else. That is a rule you can state to a user in one
 * sentence, predict the behaviour of without reading the source, and audit
 * afterwards — which is the whole bar for an automatic permission decision.
 *
 * It also has an honest precondition: `auto` is only as safe as the
 * checkpoint. When checkpointing is unavailable — no git, a workspace that
 * could not be snapshotted — `auto` degrades to asking about writes, because
 * the premise of its own rule has stopped being true. See
 * `autoModeRequiresCheckpoint`.
 */

import { z } from "zod";
import { PermissionTierSchema, type PermissionTier } from "./models.js";

export const AgentModeSchema = z.enum(["auto", "manual", "bypass", "plan"]);
export type AgentMode = z.infer<typeof AgentModeSchema>;

export interface ModeDefinition {
  id: AgentMode;
  /** Shown in the mode picker. Title case, two words at most. */
  label: string;
  /** The one-line explanation under the label. Says what happens, not what
   *  it is called. */
  summary: string;
  /** The tier this mode enforces. The workspace's own tier still clamps it. */
  tier: PermissionTier;
  /**
   * How this mode decides what to confirm.
   *
   *   - `every-change` — anything that mutates asks. (manual)
   *   - `irreversible-only` — asks only where a checkpoint cannot help. (auto)
   *   - `never` — asks nothing; hard denials still apply. (bypass)
   *   - `n/a` — nothing mutates, so nothing can be asked about. (plan)
   */
  confirmations: "every-change" | "irreversible-only" | "never" | "n/a";
  /** Whether the agent must produce a plan and stop instead of editing. */
  planFirst: boolean;
  /** Whether to take a workspace checkpoint before the turn. */
  checkpoint: boolean;
  /** True for modes that need a visible warning before they are entered. */
  requiresAcknowledgement: boolean;
  /** A single glyph-free word for compact UI. */
  shortLabel: string;
}

export const AGENT_MODES: Record<AgentMode, ModeDefinition> = {
  auto: {
    id: "auto",
    label: "Auto",
    summary: "Asks only before changes that can’t be undone.",
    tier: "guarded_autonomy",
    confirmations: "irreversible-only",
    planFirst: false,
    checkpoint: true,
    requiresAcknowledgement: false,
    shortLabel: "auto",
  },
  manual: {
    id: "manual",
    label: "Manual",
    summary: "Asks before every edit and command.",
    tier: "propose_only",
    confirmations: "every-change",
    planFirst: false,
    // Nothing is applied without a yes, so a checkpoint has little to restore
    // — but it costs almost nothing and covers the case where a person
    // approves twelve edits and regrets the shape of the whole change rather
    // than any one of them.
    checkpoint: true,
    requiresAcknowledgement: false,
    shortLabel: "manual",
  },
  bypass: {
    id: "bypass",
    label: "Bypass",
    summary: "Never asks. Blocked actions stay blocked.",
    tier: "full_autonomy",
    confirmations: "never",
    planFirst: false,
    // The mode that most needs an undo is the one that never stops to ask
    // for one.
    checkpoint: true,
    requiresAcknowledgement: true,
    shortLabel: "bypass",
  },
  plan: {
    id: "plan",
    label: "Plan",
    summary: "Reads and plans. Changes nothing.",
    tier: "read_only",
    confirmations: "n/a",
    planFirst: true,
    // Nothing can change, so there is nothing to restore.
    checkpoint: false,
    requiresAcknowledgement: false,
    shortLabel: "plan",
  },
};

export const DEFAULT_MODE: AgentMode = "auto";

/** Every mode, in the order a picker should show them: least to most
 *  permissive, so the dangerous one is never the first thing under the
 *  cursor. */
export const MODE_ORDER: readonly AgentMode[] = ["plan", "manual", "auto", "bypass"] as const;

export function modeDefinition(mode: AgentMode): ModeDefinition {
  return AGENT_MODES[mode];
}

/** The tier a mode enforces. Callers pass this to the guardrails and to the
 *  gateway, where the workspace's own tier clamps it further. */
export function tierForMode(mode: AgentMode): PermissionTier {
  return AGENT_MODES[mode].tier;
}

/**
 * Parse a mode from user input, tolerantly.
 *
 * People type `/mode bypass-permissions`, `/mode Plan`, `/mode read only`.
 * The aliases cost nothing and the alternative is an error message for
 * someone who was unambiguously right about what they wanted.
 */
const ALIASES: Record<string, AgentMode> = {
  auto: "auto",
  automatic: "auto",
  guarded: "auto",
  guarded_autonomy: "auto",
  manual: "manual",
  ask: "manual",
  always_ask: "manual",
  propose: "manual",
  propose_only: "manual",
  bypass: "bypass",
  bypass_permissions: "bypass",
  "bypass-permission": "bypass",
  yolo: "bypass",
  full: "bypass",
  full_autonomy: "bypass",
  dangerous: "bypass",
  plan: "plan",
  planning: "plan",
  read_only: "plan",
  readonly: "plan",
  dry_run: "plan",
};

export function parseMode(raw: string): AgentMode | null {
  const key = raw.trim().toLowerCase().replace(/[\s-]+/g, "_");
  return ALIASES[key] ?? ALIASES[key.replace(/_/g, "-")] ?? null;
}

/**
 * The mode a tier corresponds to, for surfaces that only know about tiers.
 *
 * Lossy on purpose and only used for display: `guarded_autonomy` maps to
 * `auto` because that is the mode a person would have picked to get it, even
 * though `auto` also implies checkpointing that a bare tier says nothing
 * about. Never use this to make a permission decision — go the other way.
 */
export function modeForTier(tier: PermissionTier): AgentMode {
  switch (tier) {
    case "read_only":
      return "plan";
    case "propose_only":
      return "manual";
    case "full_autonomy":
      return "bypass";
    default:
      return "auto";
  }
}

/**
 * Whether `auto`'s premise holds.
 *
 * `auto` skips confirmations on the grounds that a checkpoint makes the result
 * undoable. If there is no checkpoint, that grounds is gone and the mode
 * would be approving writes on the strength of an argument that no longer
 * applies. Callers degrade to `manual`'s confirmation rule in that case —
 * loudly, so the user knows why they are suddenly being asked.
 */
export function autoModeRequiresCheckpoint(mode: AgentMode, checkpointAvailable: boolean): boolean {
  return mode === "auto" && !checkpointAvailable;
}

/** Modes as flat data, for a dropdown or a `--help` listing. */
export function listModes(): ModeDefinition[] {
  return MODE_ORDER.map((m) => AGENT_MODES[m]);
}

export const AgentModeConfigSchema = z.object({
  mode: AgentModeSchema.default(DEFAULT_MODE),
  /** Present only for surfaces that still speak tiers. Ignored when `mode`
   *  is set, because the mode already implies one. */
  permissionTier: PermissionTierSchema.optional(),
});
export type AgentModeConfig = z.infer<typeof AgentModeConfigSchema>;
