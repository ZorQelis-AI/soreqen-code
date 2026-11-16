import { describe, it, expect } from "vitest";
import { TurnLedger } from "./turn-ledger.js";

describe("TurnLedger", () => {
  it("tells a created file from a modified one, on the tool's word", () => {
    const ledger = new TurnLedger();
    ledger.record("write_file", { path: "src/new.ts" }, { success: true, data: { path: "src/new.ts", created: true } });
    ledger.record("edit_file", { path: "src/old.ts" }, { success: true, data: { path: "src/old.ts" } });

    const snapshot = ledger.snapshot();
    expect(snapshot.created).toEqual(["src/new.ts"]);
    expect(snapshot.modified).toEqual(["src/old.ts"]);
  });

  it("does not count a file it created and then edited as modified too", () => {
    const ledger = new TurnLedger();
    ledger.record("write_file", { path: "a.ts" }, { success: true, data: { path: "a.ts", created: true } });
    ledger.record("edit_file", { path: "a.ts" }, { success: true, data: { path: "a.ts" } });

    const snapshot = ledger.snapshot();
    expect(snapshot.created).toEqual(["a.ts"]);
    expect(snapshot.modified).toEqual([]);
  });

  it("ignores a write that failed", () => {
    const ledger = new TurnLedger();
    ledger.record("write_file", { path: "nope.ts" }, { success: false, data: { path: "nope.ts" } });
    expect(ledger.touchedFiles()).toBe(false);
    expect(ledger.snapshot().failedCalls).toBe(1);
  });

  it("says plainly when nothing was verified", () => {
    /*
     * The line this test pins is the whole point of the ledger: a turn with no
     * checks must produce a record that says so, because a record with an
     * empty "Verification" heading is one a model will fill in from habit.
     */
    const ledger = new TurnLedger();
    ledger.record("edit_file", { path: "a.ts" }, { success: true, data: { path: "a.ts" } });
    expect(ledger.render()).toContain("Verification: nothing was run this turn.");
  });

  it("reports a failing command as failing, with its exit code", () => {
    const ledger = new TurnLedger();
    ledger.record(
      "run_command",
      { command: "pnpm test", description: "Run the test suite" },
      { success: false, data: { exitCode: 1 } },
    );
    const rendered = ledger.render();
    expect(rendered).toContain("Run the test suite [FAILED (exit 1)]");
  });

  it("carries the loop's own checks, which the model never called", () => {
    const ledger = new TurnLedger();
    ledger.recordCheck({ kind: "typecheck", detail: "tsc --noEmit clean", passed: true });
    ledger.recordCheck({ kind: "affected tests", detail: "2 test file(s) passed", passed: true });
    const rendered = ledger.render();
    expect(rendered).toContain("typecheck: passed");
    expect(rendered).toContain("affected tests: passed");
  });

  it("updates a delegation's outcome when the specialist finishes", () => {
    const ledger = new TurnLedger();
    ledger.record(
      "spawn_subagent",
      { role: "tester", task_prompt: "run everything" },
      { success: true, data: { role: "tester" } },
    );
    expect(ledger.render()).toContain("tester (started)");
    ledger.recordSubagentOutcome("tester", "completed");
    expect(ledger.render()).toContain("tester (completed)");
  });
});

import { readSummaryCheck } from "./turn-ledger.js";

describe("reading the check of a closing summary", () => {
  const summary = "Created src/Button.tsx and added a test in tests/button.test.ts. Both pass.";

  it("takes VERIFIED, with or without a few words after it, as verified", () => {
    expect(readSummaryCheck(summary, "VERIFIED")).toEqual({ verified: true, correction: "" });
    expect(readSummaryCheck(summary, "Verified. The record matches.")).toEqual({ verified: true, correction: "" });
    expect(readSummaryCheck(summary, "")).toEqual({ verified: true, correction: "" });
  });

  it("keeps a correction as it was written", () => {
    expect(readSummaryCheck(summary, "Correction: the test was written but never run.")).toEqual({
      verified: false,
      correction: "Correction: the test was written but never run.",
    });
  });

  it("does not show the summary twice when the model repeats it instead of answering", () => {
    expect(readSummaryCheck(summary, summary).verified).toBe(true);
    expect(readSummaryCheck("Button component created successfully.", "Button component created successfully.").verified).toBe(true);
  });

  it("shows anything new, labelled as a correction", () => {
    expect(readSummaryCheck(summary, "npm test failed with 3 errors in auth.spec")).toEqual({
      verified: false,
      correction: "Correction: npm test failed with 3 errors in auth.spec",
    });
  });
});
