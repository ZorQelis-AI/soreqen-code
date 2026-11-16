/**
 * Diffs, and the one property that makes them worth reading.
 *
 * A diff is what a person reads to decide whether to approve a change. The
 * previous implementation walked both files with two cursors and never
 * re-synchronised after an insertion, so adding one line to a file marked
 * every subsequent line as both removed and added. Everything below is
 * ultimately checking that unchanged lines are reported as unchanged, because
 * a diff that claims everything changed is one nobody reads — and an unread
 * diff is an approval given blind.
 */

import { describe, expect, it } from "vitest";
import { createUnifiedDiff } from "./diff-utils.js";

const lines = (diff: string): string[] => diff.split("\n");
const added = (diff: string): string[] =>
  lines(diff).filter((l) => l.startsWith("+") && !l.startsWith("+++"));
const removed = (diff: string): string[] =>
  lines(diff).filter((l) => l.startsWith("-") && !l.startsWith("---"));

describe("insertions", () => {
  const before = "function f() {\n  return 1;\n}\n";
  const after = "/** Doc. */\nfunction f() {\n  return 1;\n}\n";

  /*
   * The regression. This exact shape — a comment added above a short function
   * — produced a ten-line diff in which nothing was recognisably unchanged.
   */
  it("reports one added line and nothing removed", () => {
    const diff = createUnifiedDiff("a.js", before, after);
    expect(added(diff)).toEqual(["+/** Doc. */"]);
    expect(removed(diff)).toEqual([]);
  });

  it("keeps the untouched lines as context", () => {
    const diff = createUnifiedDiff("a.js", before, after);
    expect(diff).toContain(" function f() {");
    expect(diff).toContain("   return 1;");
  });

  it("re-synchronises after an insertion in the middle", () => {
    const a = ["one", "two", "three", "four", "five"].join("\n");
    const b = ["one", "two", "INSERTED", "three", "four", "five"].join("\n");
    const diff = createUnifiedDiff("a.txt", a, b);
    expect(added(diff)).toEqual(["+INSERTED"]);
    expect(removed(diff)).toEqual([]);
  });
});

describe("deletions", () => {
  it("reports one removed line and nothing added", () => {
    const a = ["one", "two", "three"].join("\n");
    const b = ["one", "three"].join("\n");
    const diff = createUnifiedDiff("a.txt", a, b);
    expect(removed(diff)).toEqual(["-two"]);
    expect(added(diff)).toEqual([]);
  });
});

describe("modifications", () => {
  it("reports a changed line as one removal and one addition", () => {
    const a = ["one", "two", "three"].join("\n");
    const b = ["one", "TWO", "three"].join("\n");
    const diff = createUnifiedDiff("a.txt", a, b);
    expect(removed(diff)).toEqual(["-two"]);
    expect(added(diff)).toEqual(["+TWO"]);
  });
});

describe("hunk headers", () => {
  /*
   * Every consumer that shows line numbers derives them from `@@`. Without
   * them the widget's diff viewer has nothing to number, and a diff cannot be
   * checked against the real file.
   */
  it("emits a hunk header", () => {
    const a = Array.from({ length: 40 }, (_, i) => `line ${i}`).join("\n");
    const b = a.replace("line 20", "line twenty");
    const diff = createUnifiedDiff("a.txt", a, b);
    expect(diff).toMatch(/^@@ -\d+,\d+ \+\d+,\d+ @@$/m);
  });

  it("starts the hunk near the change, not at line 1", () => {
    const a = Array.from({ length: 40 }, (_, i) => `line ${i}`).join("\n");
    const b = a.replace("line 20", "line twenty");
    const header = lines(createUnifiedDiff("a.txt", a, b)).find((l) => l.startsWith("@@"))!;
    const start = Number(/-(\d+),/.exec(header)![1]);
    expect(start).toBeGreaterThan(15);
    expect(start).toBeLessThanOrEqual(21);
  });

  it("omits the long unchanged middle between two distant edits", () => {
    const a = Array.from({ length: 200 }, (_, i) => `line ${i}`).join("\n");
    const b = a.replace("line 5", "line five").replace("line 190", "line one-ninety");
    const diff = createUnifiedDiff("a.txt", a, b);
    // Two separate hunks, and nothing like 200 lines of output.
    expect(diff.match(/^@@/gm)).toHaveLength(2);
    expect(lines(diff).length).toBeLessThan(30);
  });

  it("merges two nearby edits into a single hunk", () => {
    const a = Array.from({ length: 40 }, (_, i) => `line ${i}`).join("\n");
    const b = a.replace("line 20", "twenty").replace("line 22", "twenty-two");
    const diff = createUnifiedDiff("a.txt", a, b);
    expect(diff.match(/^@@/gm)).toHaveLength(1);
  });

  it("counts the lines each side actually has", () => {
    const a = "one\ntwo\nthree";
    const b = "one\ntwo\nEXTRA\nthree";
    const header = lines(createUnifiedDiff("a.txt", a, b)).find((l) => l.startsWith("@@"))!;
    const [, oldCount, newCount] = /@@ -\d+,(\d+) \+\d+,(\d+) @@/.exec(header)!;
    expect(Number(newCount)).toBe(Number(oldCount) + 1);
  });
});

describe("edge cases", () => {
  it("returns nothing when the content is identical", () => {
    expect(createUnifiedDiff("a.txt", "same\n", "same\n")).toBe("");
  });

  it("handles a new file with no previous content", () => {
    const diff = createUnifiedDiff("new.txt", "", "hello\nworld");
    expect(added(diff)).toEqual(["+hello", "+world"]);
  });

  it("handles a file emptied entirely", () => {
    const diff = createUnifiedDiff("gone.txt", "hello\nworld", "");
    expect(removed(diff)).toEqual(["-hello", "-world"]);
  });

  it("names the file on both sides", () => {
    const diff = createUnifiedDiff("src/a.ts", "a", "b");
    expect(diff).toContain("--- a/src/a.ts");
    expect(diff).toContain("+++ b/src/a.ts");
  });

  it("treats CRLF and LF the same, rather than reporting every line changed", () => {
    // Otherwise a file written on Windows and read back looks entirely rewritten.
    const diff = createUnifiedDiff("a.txt", "one\r\ntwo\r\nthree", "one\ntwo\nthree");
    expect(diff).toBe("");
  });

  it("does not stall on a large whole-file rewrite", () => {
    const a = Array.from({ length: 4_000 }, (_, i) => `old ${i}`).join("\n");
    const b = Array.from({ length: 4_000 }, (_, i) => `new ${i}`).join("\n");
    const started = Date.now();
    const diff = createUnifiedDiff("big.txt", a, b);
    expect(Date.now() - started).toBeLessThan(3_000);
    expect(diff.length).toBeGreaterThan(0);
  });

  it("stays fast on a one-line edit in a large file", () => {
    // The prefix/suffix trim is what makes this cheap; without it the LCS
    // table would be 16 million cells for a one-character change.
    const a = Array.from({ length: 4_000 }, (_, i) => `line ${i}`).join("\n");
    const b = a.replace("line 2000", "line two thousand");
    const started = Date.now();
    const diff = createUnifiedDiff("big.txt", a, b);
    expect(Date.now() - started).toBeLessThan(500);
    expect(added(diff)).toEqual(["+line two thousand"]);
  });
});
