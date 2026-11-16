/**
 * The effort ladder, and the drift it is most likely to suffer.
 *
 * The first five stops are duplicated from the platform's `@soreqen/config`
 * because SoreQen Code is a separate workspace and a standalone CLI cannot
 * reach into the platform monorepo. Duplication that nobody checks becomes
 * divergence, so the numbers are pinned here: if the platform changes a
 * thinking budget, this file is where it should be noticed.
 */

import { describe, expect, it } from "vitest";
import {
  DEFAULT_EFFORT,
  EFFORT,
  EFFORTS,
  PLATFORM_EFFORTS,
  atLeast,
  effortRank,
  effortSpec,
  isEffort,
  listEfforts,
  parseEffort,
  requestsApex,
} from "./effort.js";

describe("parity with the platform's five", () => {
  it("has the same five ids, in the same order", () => {
    expect([...PLATFORM_EFFORTS]).toEqual(["low", "medium", "high", "extra", "max"]);
  });

  /*
   * The pin. These are the platform's values as of this file being written; a
   * failure here means the two definitions have drifted, and the fix is to
   * decide deliberately which one is right rather than to update the number.
   */
  it("keeps the platform's thinking budgets", () => {
    expect(EFFORT.low.thinkingBudget).toBe(2048);
    expect(EFFORT.medium.thinkingBudget).toBe(4096);
    expect(EFFORT.high.thinkingBudget).toBe(8192);
    expect(EFFORT.extra.thinkingBudget).toBe(16_384);
    expect(EFFORT.max.thinkingBudget).toBe(32_768);
    expect(EFFORT.apex.thinkingBudget).toBe(65_536);
  });

  it("defaults to the same tier the platform defaults to", () => {
    expect(DEFAULT_EFFORT).toBe("medium");
  });

  it("can list the five without offering the CLI-only sixth", () => {
    expect(listEfforts(false).map((e) => e.id)).toEqual([...PLATFORM_EFFORTS]);
    expect(listEfforts(true).map((e) => e.id)).toEqual([...EFFORTS]);
  });
});

describe("the sixth", () => {
  it("sits above max", () => {
    expect(EFFORTS[EFFORTS.length - 1]).toBe("apex");
    expect(effortRank("apex")).toBeGreaterThan(effortRank("max"));
  });

  it("is not named after anyone else's", () => {
    const label = EFFORT.apex.label.toLowerCase();
    expect(label).not.toContain("ultra");
    expect(EFFORT.apex.id).not.toContain("ultra");
  });

  /*
   * The point of the tier. A bigger thinking budget alone buys a longer
   * monologue; what makes a coding agent right is more verification per turn.
   * Each of these is a discrete thing the cheaper tiers do not do.
   */
  it("changes the shape of the turn, not just a number", () => {
    expect(EFFORT.apex.selfReviewDiff).toBe(true);
    expect(EFFORT.apex.runAffectedTests).toBe(true);
    expect(EFFORT.apex.allowDelegation).toBe(true);
    expect(EFFORT.apex.allowModelRouting).toBe(false);
    expect(EFFORT.apex.maxHealAttempts).toBeGreaterThan(EFFORT.max.maxHealAttempts);
  });

  it("samples more conservatively, not less", () => {
    // Temperature is a diversity dial, not an effort dial. Apex exists for the
    // change you want to be right, where a second plausible answer is worthless.
    expect(EFFORT.apex.temperature).toBeLessThan(EFFORT.max.temperature);
  });

  it("is the only tier that never hands a step to a cheaper model", () => {
    const noRouting = EFFORTS.filter((e) => !EFFORT[e].allowModelRouting);
    expect(noRouting).toEqual(["apex"]);
  });
});

describe("the ladder is monotonic where it should be", () => {
  it("never reduces the thinking budget as effort rises", () => {
    for (let i = 1; i < EFFORTS.length; i++) {
      expect(EFFORT[EFFORTS[i]!].thinkingBudget).toBeGreaterThanOrEqual(
        EFFORT[EFFORTS[i - 1]!].thinkingBudget,
      );
    }
  });

  it("never switches thinking off, at any tier", () => {
    for (const e of EFFORTS) expect(EFFORT[e].thinkingBudget).toBeGreaterThan(0);
  });

  it("tells the agent how to work at every tier, by name", () => {
    for (const e of EFFORTS) {
      expect(EFFORT[e].guidance).toContain(`Effort is ${EFFORT[e].label.toUpperCase()}`);
    }
  });

  it("puts no ceiling on how many steps a turn may take", () => {
    for (const e of EFFORTS) expect(EFFORT[e]).not.toHaveProperty("maxIterations");
  });

  it("never withdraws verification as effort rises", () => {
    // Once a tier runs the affected tests, no higher tier may stop.
    let sawTests = false;
    let sawReview = false;
    for (const e of EFFORTS) {
      if (EFFORT[e].runAffectedTests) sawTests = true;
      else expect(sawTests).toBe(false);
      if (EFFORT[e].selfReviewDiff) sawReview = true;
      else expect(sawReview).toBe(false);
    }
  });
});

describe("parsing", () => {
  it("accepts every canonical id", () => {
    for (const e of EFFORTS) expect(parseEffort(e)).toBe(e);
  });

  it("accepts the words people actually use", () => {
    expect(parseEffort("fast")).toBe("low");
    expect(parseEffort("maximum")).toBe("max");
    expect(parseEffort("think harder")).toBe("apex");
    expect(parseEffort("PEAK")).toBe("apex");
  });

  it("returns null rather than guessing", () => {
    expect(parseEffort("insane")).toBeNull();
    expect(parseEffort("")).toBeNull();
  });

  it("recognises isEffort as a type guard over the six", () => {
    expect(isEffort("apex")).toBe(true);
    expect(isEffort("ultra")).toBe(false);
  });
});

describe("asking for apex inside a sentence", () => {
  it("is recognised mid-thought, which is how people reach for it", () => {
    expect(requestsApex("fix the parser, apex")).toBe(true);
    expect(requestsApex("APEX: rewrite the scheduler")).toBe(true);
  });

  it("does not fire on a word that merely contains it", () => {
    // A file called `apexes.ts` must not silently triple the cost of a turn.
    expect(requestsApex("read apexes.ts")).toBe(false);
    expect(requestsApex("the apexpredator module")).toBe(false);
  });
});

describe("comparisons", () => {
  it("orders correctly at the boundaries", () => {
    expect(atLeast("apex", "max")).toBe(true);
    expect(atLeast("max", "apex")).toBe(false);
    expect(atLeast("medium", "medium")).toBe(true);
  });

  it("returns the same object the table holds", () => {
    for (const e of EFFORTS) expect(effortSpec(e)).toBe(EFFORT[e]);
  });
});
