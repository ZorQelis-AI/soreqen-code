/**
 * What the model is told about a tool that ran.
 *
 * The bug being pinned here is the worst one found in the whole review:
 * a tool returning `{ success: false, error: "..." }` with no `data` was
 * rendered as the string **"Execution succeeded."** — because the renderer
 * read only `data`. The model then reasoned from that, reported the task done,
 * and every later step was built on it.
 */

import { describe, expect, it } from "vitest";
import { formatToolResult } from "./tool-result.js";

describe("failures are stated as failures", () => {
  it("never reports a failure as success", () => {
    const out = formatToolResult({ success: false, error: "File not found: src/nope.ts" });
    expect(out).not.toContain("succeeded");
    expect(out).toContain("FAILED");
    expect(out).toContain("File not found: src/nope.ts");
  });

  it("says so even when the tool gave no reason", () => {
    const out = formatToolResult({ success: false });
    expect(out).toContain("FAILED");
  });

  /*
   * A tool can fail *and* produce useful output — a test runner exits non-zero
   * and still prints the report, which is the most valuable thing available.
   * Reporting only the error throws away the diagnosis.
   */
  it("keeps the output of a failed tool alongside the reason", () => {
    const out = formatToolResult({
      success: false,
      error: "2 tests failed",
      data: "FAIL src/a.test.ts\n  expected 1 to be 2",
    });
    expect(out).toContain("2 tests failed");
    expect(out).toContain("expected 1 to be 2");
  });
});

describe("successes", () => {
  it("passes a string result through untouched", () => {
    // File contents and command output are already what the model wants;
    // wrapping them in JSON quotes and escaping every newline makes them
    // larger and harder to read.
    expect(formatToolResult({ success: true, data: "line one\nline two" })).toBe(
      "line one\nline two",
    );
  });

  it("does not prefix success with a marker", () => {
    // The absence of a FAILED line is the signal. Prefixing every good result
    // spends tokens on the common case for nothing.
    expect(formatToolResult({ success: true, data: "ok" })).toBe("ok");
  });

  it("serialises structured data compactly", () => {
    const out = formatToolResult({ success: true, data: { path: "a.ts", bytes: 12 } });
    expect(out).toBe('{"path":"a.ts","bytes":12}');
    // Pretty-printing is for people, and no person reads this. Two-space
    // indent on a deep object is roughly a third of its tokens, re-sent on
    // every iteration of the turn.
    expect(out).not.toContain("\n  ");
  });

  it("handles a tool that returns nothing", () => {
    expect(formatToolResult({ success: true })).toBe("");
  });
});

describe("size", () => {
  it("clips a very large result and says how much it dropped", () => {
    const out = formatToolResult({ success: true, data: "x".repeat(200_000) });
    expect(out.length).toBeLessThan(30_000);
    expect(out).toContain("omitted");
  });

  it("keeps both ends when clipping", () => {
    const data = "HEAD" + "y".repeat(200_000) + "TAIL";
    const out = formatToolResult({ success: true, data });
    expect(out.startsWith("HEAD")).toBe(true);
    expect(out.endsWith("TAIL")).toBe(true);
  });

  it("survives data that cannot be serialised", () => {
    const circular: Record<string, unknown> = { name: "loop" };
    circular["self"] = circular;
    expect(() => formatToolResult({ success: true, data: circular })).not.toThrow();
  });
});
