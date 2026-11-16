/**
 * Rendering a response for a terminal.
 *
 * The old test for this asserted that a heading contained "▶ Summary" — it
 * tested a decoration, so it failed the moment the decoration was replaced by
 * better typography while the *content* was untouched. These test what a
 * reader actually depends on: that the text is all there, that it fits the
 * window, and that structure survives.
 */

import { afterEach, describe, expect, it } from "vitest";
import { formatTerminalMarkdown } from "./markdown-renderer.js";

const ANSI = /\[[0-9;]*m/g;
const plain = (s: string): string => s.replace(ANSI, "");
const longest = (s: string): number =>
  Math.max(...plain(s).split("\n").map((l) => l.length));

const original = process.stdout.columns;
const setColumns = (n: number): void => {
  Object.defineProperty(process.stdout, "columns", { value: n, configurable: true });
};
afterEach(() => setColumns(original ?? 80));

describe("wrapping", () => {
  /*
   * The reason this file was rewritten. Nothing wrapped, so a paragraph ran to
   * whatever length the model produced and the terminal broke it mid-word at
   * column zero. Long answers are the common case, not the edge case.
   */
  it("wraps a long paragraph to the window", () => {
    setColumns(60);
    const para = "word ".repeat(120).trim();
    expect(longest(formatTerminalMarkdown(para))).toBeLessThanOrEqual(60);
  });

  it("keeps every word", () => {
    setColumns(50);
    const para = Array.from({ length: 80 }, (_, i) => `w${i}`).join(" ");
    const rendered = plain(formatTerminalMarkdown(para));
    for (let i = 0; i < 80; i++) expect(rendered).toContain(`w${i}`);
  });

  it("adapts when the window is wider", () => {
    const para = "word ".repeat(200).trim();
    setColumns(60);
    const narrow = plain(formatTerminalMarkdown(para)).split("\n").length;
    setColumns(120);
    const wide = plain(formatTerminalMarkdown(para)).split("\n").length;
    expect(wide).toBeLessThan(narrow);
  });

  /*
   * Escape sequences occupy no columns. Measuring the styled string naively
   * counts about eleven invisible characters per span and wraps far too early
   * — the text ends up in a narrow ribbon down the left of a wide terminal.
   */
  it("does not count colour codes as width", () => {
    setColumns(80);
    const styled = formatTerminalMarkdown("**bold** ".repeat(20).trim());
    const bare = formatTerminalMarkdown("xxxx ".repeat(20).trim());
    expect(plain(styled).split("\n").length).toBeLessThanOrEqual(
      plain(bare).split("\n").length + 1,
    );
  });

  it("leaves an unbreakable token intact rather than splitting it", () => {
    setColumns(40);
    const url = "https://example.com/a/very/long/path/that/exceeds/the/window/width";
    expect(plain(formatTerminalMarkdown(url))).toContain(url);
  });
});

describe("structure", () => {
  it("keeps heading text", () => {
    const out = plain(formatTerminalMarkdown("## Summary\n\nSome text."));
    expect(out).toContain("Summary");
    expect(out).toContain("Some text.");
  });

  it("does not leave markdown syntax in the output", () => {
    const out = plain(formatTerminalMarkdown("## Heading\n\n- **bold** item\n\n`code`"));
    expect(out).not.toContain("##");
    expect(out).not.toContain("**");
    expect(out).not.toContain("`");
  });

  it("renders list items on their own lines", () => {
    const out = plain(formatTerminalMarkdown("- one\n- two\n- three"));
    const lines = out.split("\n").filter((l) => l.trim());
    expect(lines).toHaveLength(3);
  });

  it("keeps numbered list numbers", () => {
    const out = plain(formatTerminalMarkdown("1. first\n2. second"));
    expect(out).toContain("1.");
    expect(out).toContain("2.");
  });

  it("hangs wrapped list text under the text, not the marker", () => {
    setColumns(44);
    const out = plain(formatTerminalMarkdown(`- ${"item ".repeat(30).trim()}`));
    const lines = out.split("\n").filter((l) => l.trim());
    expect(lines.length).toBeGreaterThan(1);
    // The continuation is indented past where the marker sits.
    const markerCol = lines[0]!.search(/\S/);
    const contCol = lines[1]!.search(/\S/);
    expect(contCol).toBeGreaterThan(markerCol);
  });

  it("preserves code blocks verbatim, including indentation", () => {
    const out = plain(formatTerminalMarkdown("```ts\nif (x) {\n  go();\n}\n```"));
    expect(out).toContain("if (x) {");
    expect(out).toContain("  go();");
  });

  it("does not wrap inside a code block", () => {
    setColumns(40);
    const line = "const x = " + "a".repeat(80) + ";";
    expect(plain(formatTerminalMarkdown("```\n" + line + "\n```"))).toContain(line);
  });

  it("shows a link's label and its target", () => {
    const out = plain(formatTerminalMarkdown("[the docs](https://example.com)"));
    expect(out).toContain("the docs");
    expect(out).toContain("https://example.com");
  });

  it("collapses runs of blank lines into one", () => {
    const out = plain(formatTerminalMarkdown("a\n\n\n\n\nb"));
    expect(out).not.toMatch(/\n\n\n/);
  });

  it("handles empty input", () => {
    expect(formatTerminalMarkdown("")).toBe("");
  });

  it("closes an unterminated code block rather than swallowing it", () => {
    // Models truncate. Losing the content entirely is the wrong failure.
    expect(plain(formatTerminalMarkdown("```ts\nconst a = 1;"))).toContain("const a = 1;");
  });
});

describe("underscores and code spans", () => {
  const md = (s: string): string => plain(formatTerminalMarkdown(s)).trim();
  it("leaves underscores inside a word alone, and a code span exactly as written", () => {
    // Found live: the model wrote the tool's name and the terminal showed "mcprichask_model".
    expect(md("The mcp__rich__ask_model tool returned 42.")).toBe("The mcp__rich__ask_model tool returned 42.");
    expect(md("Call `mcp__gh__create_issue` with **care**.")).toBe("Call mcp__gh__create_issue with care.");
    expect(md("`a **not bold** b`")).toBe("a **not bold** b");
  });

  it("still makes bold from underscores at the edges of words", () => {
    expect(md("this is __really__ it")).toBe("this is really it");
  });
});
