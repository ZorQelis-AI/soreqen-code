/**
 * The search result as the agent reads it: every count real, every file
 * named, and never more than the budget, so nothing downstream cuts it.
 */

import { describe, expect, it } from "vitest";
import type { SearchOutcome } from "./search.js";
import { formatSearchResult, SEARCH_RESULT_BUDGET, shownLine } from "./search-result.js";

function outcome(hits: SearchOutcome["hits"], extra: Partial<SearchOutcome> = {}): SearchOutcome {
  return { hits, engine: "builtin", truncated: false, mode: "literal", ...extra };
}

function many(files: number, perFile: number, text = "const value = lookUpTheThing(input);"): SearchOutcome["hits"] {
  const hits: SearchOutcome["hits"] = [];
  for (let f = 0; f < files; f++) for (let l = 1; l <= perFile; l++) hits.push({ file: `src/module-${f}/file-${f}.ts`, line: l * 3, text, column: 14 });
  return hits;
}

describe("formatSearchResult", () => {
  it("groups hits by file under one header with the real count", () => {
    const text = formatSearchResult({
      query: "openSession",
      path: ".",
      outcome: outcome([
        { file: "src/a.ts", line: 12, text: "  export function openSession() {", column: 18 },
        { file: "src/a.ts", line: 40, text: "return openSession(next);", column: 7 },
        { file: "docs/b.md", line: 3, text: "Call openSession", column: 5 },
      ]),
    });
    expect(text).toBe(
      ["3 matches in 2 files", "src/a.ts", "  12: export function openSession() {", "  40: return openSession(next);", "docs/b.md", "  3: Call openSession"].join("\n"),
    );
  });

  it("shows fewer lines per file before it drops a file, and stays within the budget", () => {
    const text = formatSearchResult({ query: "lookUpTheThing", path: ".", outcome: outcome(many(40, 30)) });
    expect(text.length).toBeLessThanOrEqual(SEARCH_RESULT_BUDGET);
    expect(text.split("\n")[0]).toBe("1,200 matches in 40 files");
    // Every file is still named.
    for (let f = 0; f < 40; f++) expect(text).toContain(`src/module-${f}/file-${f}.ts`);
    expect(text).toMatch(/\(30 matches, first \d+ shown\)/);
  });

  it("names the files it has no room to show lines for, then says how many more", () => {
    const text = formatSearchResult({ query: "x", path: ".", outcome: outcome(many(900, 1), { capped: true, truncated: true }) });
    expect(text.length).toBeLessThanOrEqual(SEARCH_RESULT_BUDGET);
    expect(text.split("\n")[0]).toMatch(/^900\+ matches in 900 files \(the search stopped at 900/);
    expect(text).toContain("Also matching (lines not shown):");
    expect(text).toMatch(/… and [\d,]+ more files$/);
  });

  it("lists only files when asked", () => {
    const text = formatSearchResult({ query: "x", path: ".", outcome: outcome(many(2, 3)), outputMode: "files" });
    expect(text).toBe(["6 matches in 2 files", "src/module-0/file-0.ts (3)", "src/module-1/file-1.ts (3)"].join("\n"));
  });

  it("says how the query was read when nothing matched", () => {
    const literal = formatSearchResult({ query: "a|b", path: "notes.md", outcome: outcome([], { mode: "literal" }) });
    expect(literal).toMatch(/^No matches for "a\|b" in notes\.md \(searched with the built-in scan\)\. The query was searched as literal text/);
    const both = formatSearchResult({ query: "a|b", path: ".", outcome: outcome([], { mode: "both", engine: "ripgrep" }) });
    expect(both).toBe('No matches for "a|b" in . (searched with ripgrep, as a pattern and as text).');
  });
});

describe("shownLine", () => {
  it("shows a long line around its match, not from its start", () => {
    const line = `${"x".repeat(500)}NEEDLE${"y".repeat(500)}`;
    const shown = shownLine(line, 500);
    expect(shown).toContain("NEEDLE");
    expect(shown.startsWith("…")).toBe(true);
    expect(shown.endsWith("…")).toBe(true);
    expect(shown.length).toBeLessThanOrEqual(202);
  });

  it("drops indentation and keeps the match position right", () => {
    expect(shownLine("        return value;", 15)).toBe("return value;");
  });
});
