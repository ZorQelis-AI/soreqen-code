/**
 * The classifier's contract, stated as tests.
 *
 * The tool's whole value is the claim "this occurrence is a call, and that one
 * is prose". If the claim is wrong the tool is worse than the text search it
 * replaced — a search that returns noise is merely expensive, but a classifier
 * that mislabels prose as code will get an agent to edit a comment during a
 * rename and report the rename complete.
 *
 * So every case here is a shape that actually occurs in this repository.
 */

import { describe, it, expect } from "vitest";
import { findReferences, CODE_KINDS } from "./references.js";

const kindsAt = (content: string, name: string, path = "a.ts") =>
  findReferences(path, content, name).map((r) => `${r.line}:${r.kind}`);

describe("findReferences", () => {
  it("separates a call from the comment that describes it", () => {
    const src = [
      "// guardPath resolves the path first",
      "const target = guardPath(root, file);",
    ].join("\n");

    expect(kindsAt(src, "guardPath")).toEqual(["1:comment", "2:call"]);
  });

  it("finds the name inside a block comment, however it is indented", () => {
    const src = ["/**", " * Walks through `guardPath` before touching disk.", " */", "run();"].join(
      "\n",
    );

    expect(kindsAt(src, "guardPath")).toEqual(["2:comment"]);
  });

  it("classifies an import as an import, not a use", () => {
    const src = `import { guardPath, validateCommandSafety } from "./security.js";`;
    expect(kindsAt(src, "guardPath")).toEqual(["1:import"]);
  });

  it("classifies a declaration as a definition", () => {
    const src = "export function guardPath(root: string, rel: string): string {\n  return rel;\n}";
    expect(kindsAt(src, "guardPath")).toEqual(["1:definition"]);
  });

  it("classifies a type position", () => {
    const src = "let scope: OwnerScope = forOwner(id);";
    expect(kindsAt(src, "OwnerScope")).toEqual(["1:type"]);
  });

  it("classifies a value passed by name as a mention", () => {
    const src = "register(guardPath);";
    expect(kindsAt(src, "guardPath")).toEqual(["1:mention"]);
  });

  it("knows a test name in a string is not a call", () => {
    const src = `it("guardPath throws on traversal", () => {});`;
    expect(kindsAt(src, "guardPath")).toEqual(["1:string"]);
  });

  it("returns to code after a template literal's interpolation closes", () => {
    const src = "const msg = `ran ${guardPath(a)} times`;\nguardPath(b);";
    // Inside `${…}` is code; the backticks around it are not.
    expect(kindsAt(src, "guardPath")).toEqual(["1:call", "2:call"]);
  });

  it("does not match a longer identifier that contains the name", () => {
    const src = "guardPathFor(x);\nmyGuardPath(y);\nguardPath(z);";
    expect(kindsAt(src, "guardPath")).toEqual(["3:call"]);
  });

  it("handles a call with an explicit type argument", () => {
    const src = "const s = parse<Config>(raw);";
    expect(kindsAt(src, "parse")).toEqual(["1:call"]);
  });

  it("treats a Python # comment as a comment and a def as a definition", () => {
    const src = ["# guard_path keeps us inside the root", "def guard_path(root):", "    pass"].join(
      "\n",
    );

    expect(kindsAt(src, "guard_path", "a.py")).toEqual(["1:comment", "2:definition"]);
  });

  it("treats a Python docstring as a string", () => {
    const src = ['"""Calls guard_path first."""', "guard_path(root)"].join("\n");
    expect(kindsAt(src, "guard_path", "a.py")).toEqual(["1:string", "2:call"]);
  });

  it("does not treat // inside a string as starting a comment", () => {
    const src = ['const url = "https://example.com/guardPath";', "guardPath(x);"].join("\n");
    expect(kindsAt(src, "guardPath")).toEqual(["1:string", "2:call"]);
  });

  it("reports a column, so a caller can point at the name and not the line", () => {
    const refs = findReferences("a.ts", "  const t = guardPath(x);", "guardPath");
    expect(refs[0]?.column).toBe(13);
  });

  it("returns nothing for an empty name rather than matching everywhere", () => {
    expect(findReferences("a.ts", "anything at all", "")).toEqual([]);
  });

  it("keeps comment and string out of the code kinds", () => {
    expect(CODE_KINDS).not.toContain("comment");
    expect(CODE_KINDS).not.toContain("string");
  });

  /*
   * The measurement that motivated the whole change, as a regression test.
   *
   * This is the real shape of `guardPath` usage in sandbox-runner: a handful of
   * calls buried in imports and prose. If a future edit to the lexer starts
   * counting comments as code, this fails loudly with the exact number.
   */
  it("counts only the code uses in a realistic file", () => {
    const src = [
      "/**",
      " * Everything goes through guardPath before it touches disk.",
      " */",
      `import { guardPath } from "./security.js";`,
      "",
      "export function readFile(root: string, rel: string) {",
      "  const target = guardPath(root, rel);   // guardPath throws on escape",
      "  return read(target);",
      "}",
      "",
      "export function writeFile(root: string, rel: string) {",
      "  return write(guardPath(root, rel));",
      "}",
    ].join("\n");

    const refs = findReferences("local-runner.ts", src, "guardPath");
    const code = refs.filter((r) => CODE_KINDS.includes(r.kind));

    expect(refs).toHaveLength(5);
    expect(code.map((r) => r.kind)).toEqual(["import", "call", "call"]);
  });
});
