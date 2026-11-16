/**
 * The differential structure check, against the ways edits actually go wrong.
 *
 * Two properties matter and they pull against each other: it must catch an
 * edit that broke a file, and it must stay silent about a file that was
 * already broken. A check that reports the state it *found* rather than the
 * damage it caused gets switched off, and then it catches nothing at all.
 */

import { describe, expect, it } from "vitest";
import { balanceOf, checkEditIntegrity } from "./edit-integrity.js";

const ts = (s: string) => s;

describe("balanceOf", () => {
  it("counts real structure", () => {
    expect(balanceOf("function f() { return 1; }")).toMatchObject({ curly: 0, round: 0 });
    expect(balanceOf("function f() { return 1;")).toMatchObject({ curly: 1 });
  });

  it("ignores braces inside strings", () => {
    // The reason this is a state machine and not a regex.
    expect(balanceOf(`const s = "}}}}"; const t = '{{{{';`)).toMatchObject({ curly: 0 });
  });

  it("ignores braces inside comments", () => {
    expect(balanceOf("// } } }\n/* { { { */\nconst x = 1;")).toMatchObject({ curly: 0 });
  });

  it("handles template literals and their interpolations", () => {
    expect(balanceOf("const a = `x${ y }z`;")).toMatchObject({ curly: 0 });
    // Nested, which is legal and is where naive counters fall over.
    expect(balanceOf("const a = `${ `${ b }` }`;")).toMatchObject({ curly: 0 });
    // A brace inside the *text* of a template is not structure.
    expect(balanceOf("const a = `a } b {`;")).toMatchObject({ curly: 0 });
  });

  it("notices an unterminated string or comment", () => {
    expect(balanceOf('const s = "open').unterminatedString).toBe(true);
    expect(balanceOf("/* open").unterminatedComment).toBe(true);
    expect(balanceOf("const s = `open").unterminatedString).toBe(true);
  });

  it("does not treat an escaped quote as a terminator", () => {
    expect(balanceOf('const s = "a\\"b";').unterminatedString).toBe(false);
  });
});

describe("checkEditIntegrity", () => {
  const before = ts(`export function add(a: number, b: number) {
  return a + b;
}
`);

  it("says nothing about a clean edit", () => {
    const after = before.replace("a + b", "a + b + 0");
    expect(checkEditIntegrity("src/m.ts", before, after)).toEqual({ ok: true, problems: [] });
  });

  it("catches a replacement that swallowed a closing brace", () => {
    /*
     * The commonest real failure: an `old_str` that matched slightly more or
     * less than the model intended, so the replacement's braces do not balance
     * the ones it replaced.
     */
    const after = ts(`export function add(a: number, b: number) {
  return a + b;
`);
    const report = checkEditIntegrity("src/m.ts", before, after);
    expect(report.ok).toBe(false);
    expect(report.problems[0]).toMatch(/more '\{' than '\}'/);
  });

  it("catches a stray extra closer", () => {
    const after = `${before}}\n`;
    const report = checkEditIntegrity("src/m.ts", before, after);
    expect(report.ok).toBe(false);
    expect(report.problems[0]).toMatch(/more '\}' than '\{'/);
  });

  it("catches a quote left open on a line", () => {
    // The damage is mid-file, not at EOF — the line ends, the file carries on
    // parsing, and nothing further looks wrong. Caught per line for exactly
    // that reason.
    const after = before.replace("return a + b;", 'return "oops;');
    const report = checkEditIntegrity("src/m.ts", before, after);
    expect(report.ok).toBe(false);
    expect(report.problems.join(" ")).toMatch(/unclosed quote/i);
  });

  it("catches a string left open at end of file", () => {
    const after = before.replace("}\n", 'const s = "open');
    const report = checkEditIntegrity("src/m.ts", before, after);
    expect(report.ok).toBe(false);
    expect(report.problems.join(" ")).toMatch(/unterminated|unclosed/i);
  });

  it("stays silent when the file was already unbalanced and is no worse", () => {
    /*
     * A partial refactor, a generated fragment, a file mid-rewrite. Reporting
     * the state it found would produce a warning on every subsequent edit to a
     * file the model already knows is in pieces — which is how a check earns a
     * reputation for crying wolf and stops being read.
     */
    const broken = "function f() {\n  return 1;\n";
    const stillBroken = "function f() {\n  return 2;\n";
    expect(checkEditIntegrity("src/m.ts", broken, stillBroken)).toEqual({ ok: true, problems: [] });
  });

  it("stays silent when the edit repaired the file", () => {
    const broken = "function f() {\n  return 1;\n";
    const fixed = "function f() {\n  return 1;\n}\n";
    expect(checkEditIntegrity("src/m.ts", broken, fixed)).toEqual({ ok: true, problems: [] });
  });

  it("says nothing about file types it cannot parse", () => {
    // Markdown prose is full of unmatched brackets, and guessing produces
    // noise. Silence is the honest answer.
    const report = checkEditIntegrity("README.md", "# Title", "# Title (\n\n[note");
    expect(report).toEqual({ ok: true, problems: [] });
  });

  it("checks Python brackets and triple-quoted strings", () => {
    const py = "def f(a, b):\n    return a + b\n";
    const brokenCall = "def f(a, b:\n    return a + b\n";
    expect(checkEditIntegrity("m.py", py, brokenCall).ok).toBe(false);

    const openDoc = 'def f():\n    """unclosed\n';
    expect(checkEditIntegrity("m.py", py, openDoc).ok).toBe(false);
  });

  it("treats a new file as balanced before it existed", () => {
    const report = checkEditIntegrity("src/new.ts", "", "export const x = {\n");
    expect(report.ok).toBe(false);
  });
});
