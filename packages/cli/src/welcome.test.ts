import { describe, expect, it } from "vitest";
import { COMMANDS, matchCommands, resultSummary, toolParts, visible, welcomeLines } from "./welcome.js";

const state = {
  version: "0.2.0",
  name: "Ved Sainani",
  model: "mimo-v2.6-flash",
  mode: "auto",
  effort: "medium",
  workspaceDir: "/home/ved/projects/a-rather-long-project-folder-name/packages/cli",
  recent: [
    { text: "fix the failing auth test in src/auth/session.test.ts and then run the whole suite", age: "2h ago" },
    { text: "fix the failing auth test in src/auth/session.test.ts and then run the whole suite", age: "2h ago" },
  ],
};

describe("the welcome screen", () => {
  for (const cols of [50, 80, 120, 200]) {
    it(`keeps every line inside a ${cols}-column window`, () => {
      for (const line of welcomeLines(state, cols)) expect(visible(line)).toBeLessThanOrEqual(cols);
    });
  }

  it("greets by first name, reads requests from their start, and lists each once", () => {
    const text = welcomeLines(state, 120).join("\n");
    expect(text).toContain("Welcome back Ved!");
    expect(text).toContain("fix the failing auth test");
    expect(text.match(/fix the failing auth test/g)).toHaveLength(1);
  });

  it("draws the wordmark only where it fits", () => {
    expect(welcomeLines(state, 120).some((l) => l.includes("███"))).toBe(true);
    expect(welcomeLines(state, 50).some((l) => l.includes("███"))).toBe(false);
  });
});

describe("the command palette", () => {
  it("lists every command for a bare slash, and narrows as you type", () => {
    expect(matchCommands("/")).toHaveLength(COMMANDS.length);
    expect(matchCommands("/mo").map((m) => m.name).slice(0, 2)).toEqual(["/model", "/mode"]);
    expect(matchCommands("/che")[0]!.name).toBe("/checkpoints");
    // Words that only appear in a description still find the command.
    expect(matchCommands("/rewind")[0]!.name).toBe("/rewind");
  });

  it("is quiet once a command has arguments, or for ordinary text", () => {
    expect(matchCommands("/model gpt")).toEqual([]);
    expect(matchCommands("fix the bug")).toEqual([]);
  });

  it("offers no Apex effort", () => {
    expect(COMMANDS.find((c) => c.name === "/effort")!.args).not.toMatch(/apex/i);
  });
});

describe("tool lines", () => {
  it("names the action and its target", () => {
    expect(toolParts("read_file", { path: "src/a.ts" })).toEqual({ verb: "Read", target: "src/a.ts" });
    expect(toolParts("research", { question: "q", depth: "deep" }).verb).toBe("Deep research");
    expect(toolParts("mcp__github__create_issue", {})).toEqual({ verb: "github", target: "create issue" });
  });

  it("summarises results from the text the model reads", () => {
    expect(resultSummary("read_file", JSON.stringify({ totalLines: 42, content: "" }), true)).toBe("42 lines");
    expect(resultSummary("grep_search", JSON.stringify({ matchCount: 1 }), true)).toBe("1 match");
    expect(resultSummary("grep_search", "14 matches in 3 files\nsrc/a.ts\n  3: x", true)).toBe("14 matches in 3 files");
    expect(resultSummary("grep_search", 'No matches for "x" in . (searched with ripgrep).', true)).toBe("no matches");
    expect(resultSummary("edit_file", JSON.stringify({ diff: "--- a\n+++ b\n-x\n+y\n+z" }), true)).toBe("+2 -1");
    expect(resultSummary("run_command", "FAILED: exited with code 2\n\n{}", false)).toBe("failed: exited with code 2");
    expect(resultSummary("research", { data: { sources: [1, 2], report: "r" } }, true)).toBe("2 sources read, report written");
  });

  it("summarises the compact results the model now reads (6 Nov 2026)", () => {
    expect(resultSummary("edit_file", JSON.stringify({ path: "a.ts", lines: "370-372", added: 3, removed: 1 }), true)).toBe("+3 -1");
    expect(resultSummary("list_directory", "24 entries in src (paths relative to it; folders end in /):\na.ts  1.0 KB", true)).toBe("24 entries");
    expect(resultSummary("list_directory", "the project folder is empty.", true)).toBe("empty");
    expect(resultSummary("glob", "12+ files match **/*.ts, newest first:\nsrc/a.ts", true)).toBe("12 files");
    expect(resultSummary("glob", "No file matches **/*.rs.", true)).toBe("no files");
  });
});
