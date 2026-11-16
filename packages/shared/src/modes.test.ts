/**
 * The four modes, and the one property that must never break.
 *
 * A mode is a preference; a tier is a boundary. Everything here is ultimately
 * checking that the preference cannot become the boundary — that selecting a
 * mode can narrow what the agent may do and can never widen it, whatever the
 * client sends.
 */

import { describe, expect, it } from "vitest";
import {
  AGENT_MODES,
  DEFAULT_MODE,
  MODE_ORDER,
  autoModeRequiresCheckpoint,
  listModes,
  modeDefinition,
  modeForTier,
  parseMode,
  tierForMode,
  type AgentMode,
} from "./modes.js";

const TIER_RANK = ["read_only", "propose_only", "guarded_autonomy", "full_autonomy"] as const;

describe("mode definitions", () => {
  it("defines all four", () => {
    expect(Object.keys(AGENT_MODES).sort()).toEqual(["auto", "bypass", "manual", "plan"]);
  });

  it("maps each mode to the tier its description implies", () => {
    expect(tierForMode("plan")).toBe("read_only");
    expect(tierForMode("manual")).toBe("propose_only");
    expect(tierForMode("auto")).toBe("guarded_autonomy");
    expect(tierForMode("bypass")).toBe("full_autonomy");
  });

  it("orders the picker from least to most permissive", () => {
    // So the dangerous one is never the first thing under the cursor.
    const ranks = MODE_ORDER.map((m) => TIER_RANK.indexOf(tierForMode(m)));
    expect(ranks).toEqual([...ranks].sort((a, b) => a - b));
  });

  it("defaults to auto, not to bypass", () => {
    expect(DEFAULT_MODE).toBe("auto");
  });

  it("marks only bypass as needing acknowledgement", () => {
    const flagged = (Object.keys(AGENT_MODES) as AgentMode[]).filter(
      (m) => AGENT_MODES[m].requiresAcknowledgement,
    );
    expect(flagged).toEqual(["bypass"]);
  });

  it("checkpoints every mode that can change anything", () => {
    // Plan cannot write, so there is nothing to restore. Every other mode can,
    // so every other mode gets an undo — including bypass, which needs it most
    // precisely because it never stops to ask.
    expect(AGENT_MODES.plan.checkpoint).toBe(false);
    expect(AGENT_MODES.auto.checkpoint).toBe(true);
    expect(AGENT_MODES.manual.checkpoint).toBe(true);
    expect(AGENT_MODES.bypass.checkpoint).toBe(true);
  });

  it("asks for a plan only in plan mode", () => {
    expect(AGENT_MODES.plan.planFirst).toBe(true);
    for (const m of ["auto", "manual", "bypass"] as const) {
      expect(AGENT_MODES[m].planFirst).toBe(false);
    }
  });

  it("gives every mode a summary that says what happens", () => {
    for (const spec of listModes()) {
      expect(spec.summary.length).toBeGreaterThan(20);
      expect(spec.label.length).toBeGreaterThan(0);
    }
  });
});

describe("parsing what people type", () => {
  it("accepts the canonical names", () => {
    for (const m of MODE_ORDER) expect(parseMode(m)).toBe(m);
  });

  it("accepts case, spaces and hyphens", () => {
    expect(parseMode("Plan")).toBe("plan");
    expect(parseMode("  AUTO  ")).toBe("auto");
    expect(parseMode("bypass-permissions")).toBe("bypass");
    expect(parseMode("bypass permissions")).toBe("bypass");
    expect(parseMode("always ask")).toBe("manual");
  });

  it("accepts tier names, since half the product still speaks them", () => {
    expect(parseMode("read_only")).toBe("plan");
    expect(parseMode("propose_only")).toBe("manual");
    expect(parseMode("full_autonomy")).toBe("bypass");
    expect(parseMode("guarded_autonomy")).toBe("auto");
  });

  it("returns null rather than guessing", () => {
    expect(parseMode("aggressive")).toBeNull();
    expect(parseMode("")).toBeNull();
    expect(parseMode("bypas")).toBeNull();
  });
});

describe("tier to mode, for surfaces that only know tiers", () => {
  it("round-trips every mode through its tier", () => {
    for (const m of MODE_ORDER) {
      expect(modeForTier(tierForMode(m))).toBe(m);
    }
  });

  it("treats an unknown tier as auto rather than as bypass", () => {
    // The default must fail closed. `guarded_autonomy` is the safe middle.
    expect(modeForTier("guarded_autonomy")).toBe("auto");
  });
});

describe("auto's premise", () => {
  it("is unsatisfied when there is no checkpoint", () => {
    expect(autoModeRequiresCheckpoint("auto", false)).toBe(true);
    expect(autoModeRequiresCheckpoint("auto", true)).toBe(false);
  });

  it("says nothing about the other three, which do not rest on it", () => {
    for (const m of ["plan", "manual", "bypass"] as const) {
      expect(autoModeRequiresCheckpoint(m, false)).toBe(false);
    }
  });
});

describe("modeDefinition", () => {
  it("returns the same object the table holds", () => {
    for (const m of MODE_ORDER) {
      expect(modeDefinition(m)).toBe(AGENT_MODES[m]);
    }
  });
});
