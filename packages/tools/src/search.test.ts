/**
 * Searching without ripgrep.
 *
 * This exists because the machine these tools were developed on does not have
 * ripgrep installed, and nobody noticed for the life of the project: every
 * search tool shelled out to `rg`, treated the resulting ENOENT as "no
 * matches", and returned an empty list with `success: true`. Three symbols
 * that plainly existed came back as three confident zeroes.
 *
 * So the property under test is not "search finds things" — it is "a search
 * that could not run never looks like a search that found nothing".
 */

import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { LocalSandboxRunner } from "@sqcode/sandbox-runner";
import { searchWorkspace } from "./search.js";

describe("searchWorkspace", () => {
  let root: string;
  let runner: LocalSandboxRunner;
  const ws = "search_test_ws";

  beforeAll(async () => {
    root = mkdtempSync(join(tmpdir(), "sq-search-"));
    mkdirSync(join(root, "src"), { recursive: true });
    mkdirSync(join(root, "node_modules", "junk"), { recursive: true });

    writeFileSync(
      join(root, "src", "alpha.ts"),
      "export function findMe() {\n  return 1;\n}\nconst other = 2;\n",
      "utf-8",
    );
    writeFileSync(join(root, "src", "beta.ts"), "// findMe is mentioned here\n", "utf-8");
    writeFileSync(join(root, "notes.md"), "findMe appears in prose too\n", "utf-8");
    // Must never be searched — it is the majority of bytes in a real project.
    writeFileSync(join(root, "node_modules", "junk", "index.js"), "findMe\n", "utf-8");

    runner = new LocalSandboxRunner(root);
    await runner.createWorkspace(ws, { storagePath: root });
  });

  afterAll(() => rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));

  it("finds literal text across the workspace", async () => {
    const out = await searchWorkspace(runner, ws, { pattern: "findMe" });
    expect(out.hits.length).toBeGreaterThanOrEqual(3);
    expect(out.hits.map((h) => h.file)).toContain("src/alpha.ts");
  });

  it("never descends into dependencies or build output", async () => {
    const out = await searchWorkspace(runner, ws, { pattern: "findMe" });
    expect(out.hits.some((h) => h.file.includes("node_modules"))).toBe(false);
  });

  it("reports which engine answered", async () => {
    // The value depends on the machine; that it is *stated* does not. A caller
    // that cannot tell ripgrep from a fallback cannot weigh an empty result.
    const out = await searchWorkspace(runner, ws, { pattern: "findMe" });
    expect(["ripgrep", "builtin"]).toContain(out.engine);
  });

  it("returns an empty list for a genuine miss, not an error", async () => {
    const out = await searchWorkspace(runner, ws, { pattern: "zzz_not_present_zzz" });
    expect(out.hits).toEqual([]);
  });

  it("honours case sensitivity", async () => {
    const insensitive = await searchWorkspace(runner, ws, { pattern: "FINDME" });
    expect(insensitive.hits.length).toBeGreaterThan(0);

    const sensitive = await searchWorkspace(runner, ws, {
      pattern: "FINDME",
      caseSensitive: true,
    });
    expect(sensitive.hits).toEqual([]);
  });

  it("treats a literal pattern literally", async () => {
    // `.` matches any character as a regex and only a dot as text. Getting
    // this backwards turns a search for `a.b` into a search for almost
    // everything.
    const literal = await searchWorkspace(runner, ws, { pattern: "find.e" });
    expect(literal.hits).toEqual([]);

    const regex = await searchWorkspace(runner, ws, { pattern: "find.e", isRegex: true });
    expect(regex.hits.length).toBeGreaterThan(0);
  });

  it("filters by include glob", async () => {
    const out = await searchWorkspace(runner, ws, { pattern: "findMe", includes: ["*.md"] });
    expect(out.hits.length).toBeGreaterThan(0);
    expect(out.hits.every((h) => h.file.endsWith(".md"))).toBe(true);
  });

  it("says when it stopped early rather than implying there is no more", async () => {
    const out = await searchWorkspace(runner, ws, { pattern: "findMe", maxHits: 1 });
    expect(out.hits).toHaveLength(1);
    expect(out.truncated).toBe(true);
  });

  it("refuses an invalid regular expression instead of returning nothing", async () => {
    // Silently returning `[]` for a malformed pattern is the same failure
    // shape as the missing binary: the model reads it as "no matches".
    await expect(
      searchWorkspace(runner, ws, { pattern: "(unclosed", isRegex: true }),
    ).rejects.toThrow(/not a valid regular expression/i);
  });
  it("reads a|b|c as any of them when is_regex is not set (18 Oct 2026: 0 results)", async () => {
    const out = await searchWorkspace(runner, ws, { pattern: "nothing here|appears in prose|return 1" });
    expect(out.mode).toBe("both");
    expect(out.hits.map((h) => h.file).sort()).toEqual(["notes.md", "src/alpha.ts"]);

    // Taken at its word when it is set.
    const literal = await searchWorkspace(runner, ws, { pattern: "nothing here|appears in prose", isRegex: false });
    expect(literal.hits).toEqual([]);
  });

  it("still finds text that only reads like a pattern", async () => {
    writeFileSync(join(root, "price.txt"), "It costs $5 (plus tax).\n", "utf-8");
    const out = await searchWorkspace(runner, ws, { pattern: "$5 (plus" });
    expect(out.hits.map((h) => h.file)).toEqual(["price.txt"]);
  });

  it("filters by a glob with a folder in it", async () => {
    const out = await searchWorkspace(runner, ws, { pattern: "findMe", includes: ["src/**/*.ts"] });
    expect(out.hits.map((h) => h.file).sort()).toEqual(["src/alpha.ts", "src/beta.ts"]);
  });

  it("says where on the line the match is", async () => {
    const out = await searchWorkspace(runner, ws, { pattern: "other" });
    const hit = out.hits.find((h) => h.file === "src/alpha.ts")!;
    expect(hit.text.slice(hit.column!)).toMatch(/^other/);
  });

  it("searches inside one file when the path names a file, however it is written", async () => {
    // Reported 13 Oct 2026: grep_search on a file path showed 0 results every time.
    for (const path of ["src/alpha.ts", "./src/alpha.ts", "src\\alpha.ts", join(root, "src", "alpha.ts")]) {
      const out = await searchWorkspace(runner, ws, { pattern: "findMe", path });
      expect(out.hits.length, path).toBe(1);
    }
  });
});
