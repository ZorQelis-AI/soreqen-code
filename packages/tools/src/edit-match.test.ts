/**
 * The edit ladder.
 *
 * The property under test is not "does it find things" — a fuzzy matcher that
 * always finds something is worse than no matcher. It is: **does it refuse
 * when it should**. Every rung keeps the uniqueness requirement, and the
 * ambiguous cases below matter more than the successful ones, because an
 * ambiguous match that resolves itself is a silent rewrite of a file the user
 * did not look at.
 */

import { describe, expect, it } from "vitest";
import { describeFailure, describeMatch, findEditTarget } from "./edit-match.js";

const apply = (content: string, oldStr: string, newStr: string): string => {
  const r = findEditTarget(content, oldStr, newStr);
  if (!r.ok) throw new Error(`no match: ${r.failure.reason}`);
  return content.slice(0, r.match.start) + r.match.adjustedReplacement + content.slice(r.match.end);
};

describe("rung 1: exact", () => {
  const src = "const a = 1;\nconst b = 2;\n";

  it("matches and reports itself as exact", () => {
    const r = findEditTarget(src, "const b = 2;", "const b = 3;");
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.match.strategy).toBe("exact");
  });

  it("applies the replacement verbatim", () => {
    expect(apply(src, "const b = 2;", "const b = 3;")).toBe("const a = 1;\nconst b = 3;\n");
  });

  it("adds no note, because there is nothing to disclose", () => {
    const r = findEditTarget(src, "const b = 2;", "x");
    if (r.ok) expect(describeMatch(r.match)).toBeNull();
  });

  it("refuses when the string appears twice", () => {
    const twice = "x();\ny();\nx();\n";
    const r = findEditTarget(twice, "x();", "z();");
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.failure.reason).toBe("ambiguous");
      expect(r.failure.occurrences).toBe(2);
    }
  });

  /*
   * Ambiguity is never resolved by trying harder.
   *
   * A model that supplied a string appearing three times has under-specified
   * the edit; the looser rungs would find the same three places or more.
   */
  it("does not fall through to a looser rung when ambiguous", () => {
    const twice = "  run();\n  run();\n";
    const r = findEditTarget(twice, "run();", "walk();");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.failure.bestStrategy).toBe("exact");
  });

  it("names the lines that matched, so the model can disambiguate cheaply", () => {
    const twice = "x();\ny();\nx();\n";
    const r = findEditTarget(twice, "x();", "z();");
    if (!r.ok) {
      expect(r.failure.nearest?.map((n) => n.line)).toEqual([1, 3]);
    }
  });
});

describe("rung 2: whitespace", () => {
  it("matches through a different number of spaces inside a line", () => {
    const src = "const  x   =  1;\n";
    const r = findEditTarget(src, "const x = 1;", "const x = 2;");
    expect(r.ok).toBe(true);
    if (r.ok) expect(["whitespace", "indentation"]).toContain(r.match.strategy);
  });

  it("matches through tabs where the model wrote spaces", () => {
    const src = "function f() {\n\treturn 1;\n}\n";
    const out = apply(src, "    return 1;", "    return 2;");
    expect(out).toContain("return 2;");
    expect(out).not.toContain("return 1;");
  });

  it("replaces what is in the file, not what the model quoted", () => {
    // The span removed must be the file's own bytes; using the quoted string's
    // length would truncate or overrun the real text.
    const src = "a\nconst  y  = 1;\nb\n";
    const out = apply(src, "const y = 1;", "const y = 9;");
    expect(out).toBe("a\nconst y = 9;\nb\n");
  });
});

describe("rung 3: indentation", () => {
  const src = ["class A {", "  method() {", "    return 1;", "  }", "}", ""].join("\n");

  it("finds a block quoted at the wrong nesting level", () => {
    // The commonest miss: a model quoting a method body from a class it read
    // at a different depth.
    const r = findEditTarget(src, "method() {\n  return 1;\n}", "method() {\n  return 2;\n}");
    expect(r.ok).toBe(true);
  });

  it("re-indents the replacement to sit where the match actually is", () => {
    const out = apply(src, "method() {\n  return 1;\n}", "method() {\n  return 2;\n}");
    expect(out).toContain("  method() {");
    expect(out).toContain("    return 2;");
    // Broken indentation is a syntax error in Python and a review comment
    // everywhere else, so it is worth asserting precisely.
    expect(out).toBe(["class A {", "  method() {", "    return 2;", "  }", "}", ""].join("\n"));
  });

  it("preserves relative indentation inside the replacement", () => {
    const out = apply(
      src,
      "method() {\n  return 1;\n}",
      "method() {\n  if (x) {\n    return 2;\n  }\n}",
    );
    expect(out).toContain("    if (x) {");
    expect(out).toContain("      return 2;");
  });

  it("says the match was not exact", () => {
    const r = findEditTarget(src, "method() {\n  return 1;\n}", "x");
    if (r.ok) expect(describeMatch(r.match)).toMatch(/indent/i);
  });
});

describe("rung 4: anchored", () => {
  const src = [
    "export function calculate(a, b) {",
    "  const scaled = a * FACTOR;",
    "  const offset = b + BASE;",
    "  return scaled + offset;",
    "}",
    "",
  ].join("\n");

  it("finds a span whose interior the model misremembered", () => {
    const quoted = [
      "export function calculate(a, b) {",
      "  const scaled = a * FACTOR;",
      "  const offset = b + OFFSET;", // wrong constant name
      "  return scaled + offset;",
      "}",
    ].join("\n");
    const r = findEditTarget(src, quoted, "export function calculate() { return 0; }");
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.match.strategy).toBe("anchored");
  });

  it("reports its confidence and warns the diff should be checked", () => {
    const quoted = [
      "export function calculate(a, b) {",
      "  const scaled = a * FACTOR;",
      "  const offset = b + OFFSET;",
      "  return scaled + offset;",
      "}",
    ].join("\n");
    const r = findEditTarget(src, quoted, "x");
    if (r.ok) {
      expect(r.match.confidence).toBeLessThan(1);
      expect(describeMatch(r.match)).toMatch(/resemblance|similarity/i);
    }
  });

  it("refuses anchors too short to be a fingerprint", () => {
    // `}` and `)` anchor almost anywhere, and a wrong anchored match rewrites
    // a whole span.
    const r = findEditTarget(src, "}\n)\n;", "x");
    expect(r.ok).toBe(false);
  });

  it("refuses when the interior is too different to trust", () => {
    const nothingLike = [
      "export function calculate(a, b) {",
      "  frobnicate();",
      "  wibble();",
      "  spong();",
      "}",
    ].join("\n");
    const r = findEditTarget(src, nothingLike, "x");
    expect(r.ok).toBe(false);
  });
});

describe("failing well", () => {
  const src = ["import { readFile } from 'fs';", "", "const handler = readFile;", ""].join("\n");

  it("points at the closest lines instead of just refusing", () => {
    // Saves the model a full re-read, which is a round trip and a large tool
    // result — nine times in ten the anchor is right there.
    const r = findEditTarget(src, "const handler = writeFile;", "x");
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.failure.nearest?.length).toBeGreaterThan(0);
      expect(r.failure.nearest?.[0]?.text).toContain("handler");
    }
  });

  it("writes a message that says what to do next", () => {
    const r = findEditTarget(src, "const handler = writeFile;", "x");
    if (!r.ok) {
      const msg = describeFailure("src/a.ts", r.failure);
      expect(msg).toContain("src/a.ts");
      expect(msg).toMatch(/whitespace|indentation|anchoring/);
      expect(msg).toMatch(/line \d+/);
    }
  });

  it("quotes a long changed line whole, so the next attempt can copy it", () => {
    // 23 Oct 2026: a 209-character table row the agent had rewritten itself
    // failed three times; the hint cut it at 100 characters, before the cell
    // that had changed, so the model retried the same stale old_str.
    const row = (cell: string) =>
      `| W12 | Inceptron | serverless, pay as you go | public endpoint rates update hourly | ${cell} | ` +
      "commercial use confirmed in writing via ToS | no rate limits on serverless, 429 only at capacity |";
    const file = ["# Providers", "", "| id | name | plan | rates | status | terms | limits |", row("REPLIED 20 Oct"), ""].join("\n");
    const r = findEditTarget(file, row("awaiting reply"), "x");
    expect(r.ok).toBe(false);
    if (!r.ok) {
      const msg = describeFailure("providers.md", r.failure);
      expect(msg).toContain(`line 4: ${row("REPLIED 20 Oct")}`);
      expect(msg).toMatch(/do not retry the same old_str/i);
    }
  });

  it("brings the lines after the best candidate for a multi-line target", () => {
    const file = ["function a() {", "  const total = sumAll(items);", "  return total * 2;", "}", ""].join("\n");
    const r = findEditTarget(file, "  const total = sumAll(things);\n  return total * 3;", "x");
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.failure.region?.map((n) => n.line)).toEqual([2, 3]);
      expect(describeFailure("a.ts", r.failure)).toContain("line 3:   return total * 2;");
    }
  });

  it("rejects an empty target rather than matching everywhere", () => {
    const r = findEditTarget(src, "", "x");
    expect(r.ok).toBe(false);
  });

  it("does not match across an unrelated file", () => {
    const r = findEditTarget("nothing to see", "const handler = readFile;", "x");
    expect(r.ok).toBe(false);
  });
});

describe("the ladder is ordered, not opportunistic", () => {
  it("prefers an exact match over a fuzzy one elsewhere in the file", () => {
    // `total` appears twice under whitespace-insensitive comparison and once
    // exactly, so the looser rung would find two candidates and refuse. Exact
    // wins outright and the ladder stops.
    const src = ["const  total = 0;", "const total = 1;", ""].join("\n");
    const r = findEditTarget(src, "const total = 1;", "const total = 2;");
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.match.strategy).toBe("exact");
      expect(r.match.start).toBe(src.indexOf("const total = 1;"));
    }
  });

  it("treats an exact substring inside an indented line as a real match", () => {
    // Worth pinning: `return 1;` occurs inside `  return 1;` as a substring, so
    // a file with both an indented and an unindented copy is genuinely
    // ambiguous at rung 1 and must be refused rather than resolved.
    const src = ["  return 1;", "return 1;", ""].join("\n");
    const r = findEditTarget(src, "return 1;", "return 2;");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.failure.reason).toBe("ambiguous");
  });
});
