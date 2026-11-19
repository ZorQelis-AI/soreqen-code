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

/*
 * 18 Nov 2026: a turn that checked a page with browser_batch at three widths
 * was told by its own final check that the browser checks and two run_tests
 * calls "are not in the turn record ... should be treated as not having
 * happened". Browser calls had no section, and a specialist's calls were not
 * in its parent's record at all.
 */
describe("TurnLedger: every call is in the record", () => {
  it("lists browser calls, with what they opened", () => {
    const ledger = new TurnLedger();
    ledger.record("edit_file", { path: "src/App.tsx" }, { success: true, data: { path: "src/App.tsx" } });
    ledger.record(
      "browser_batch",
      { steps: [{ action: "open", url: "http://localhost:5173" }, { action: "resize", width: 390 }, { action: "screenshot" }] },
      { success: true },
    );
    ledger.record("browser_open", { url: "http://localhost:5173/settings" }, { success: false });
    const text = ledger.render();
    expect(text).toContain("Browser:");
    expect(text).toContain("batch of 3: open, resize, screenshot (http://localhost:5173)");
    expect(text).toContain("open http://localhost:5173/settings [FAILED]");
    expect(ledger.snapshot().browser).toHaveLength(2);
  });

  it("counts every other tool by name, so nothing called is absent", () => {
    const ledger = new TurnLedger();
    ledger.record("read_file", { path: "a.ts" }, { success: true });
    ledger.record("read_file", { path: "b.ts" }, { success: true });
    ledger.record("grep", { pattern: "x" }, { success: true });
    expect(ledger.render()).toContain("Other tool calls: grep, read_file ×2");
  });

  it("folds a sub-agent's record into its parent's, marked as its", () => {
    const sub = new TurnLedger();
    sub.record("edit_file", { path: "src/b.ts" }, { success: true, data: { path: "src/b.ts" } });
    sub.record("run_tests", {}, { success: true, data: { summary: "12 passed" } });
    sub.record("browser_batch", { steps: [{ action: "open", url: "http://localhost:3000" }] }, { success: true });
    sub.record("run_command", { command: "pnpm build", description: "Build" }, { success: true, data: { exitCode: 0 } });

    const parent = new TurnLedger();
    parent.record("spawn_subagent", { role: "tester", task_prompt: "check it" }, { success: true, data: { role: "tester" } });
    parent.absorb("tester", sub.snapshot());

    const snap = parent.snapshot();
    expect(snap.modified).toEqual(["src/b.ts"]);
    expect(parent.touchedFiles()).toBe(true);
    const text = parent.render();
    expect(text).toContain("tests (by tester): passed — 12 passed");
    expect(text).toContain("Build (by tester) [ok]");
    expect(text).toContain("batch of 1: open (http://localhost:3000) (by tester) [ok]");
    expect(snap.toolCalls).toBe(5);
  });
});
