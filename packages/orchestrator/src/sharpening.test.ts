/**
 * The five smaller mechanisms, tested where they can be wrong.
 *
 * Repo map, tool cache, test selection, self-review parsing and model routing.
 * Each one is an optimisation, and the risk with an optimisation is never that
 * it fails to help — it is that it changes an answer. So the emphasis
 * throughout is on the invalidation, the refusal, and the fallback, rather
 * than on the happy path.
 */

import { describe, expect, it } from "vitest";
import { extractSymbols, renderForPrompt, type RepoMap } from "./repo-map.js";
import { ToolResultCache, cacheKey, isCacheableTool } from "./tool-cache.js";
import { selectTests, testFeedback, type TestRunOutcome } from "./test-selector.js";
import { parseVerdict, reviewFeedback } from "./self-review.js";
import { classifyStep, policyFromEnv, routeStep, DEFAULT_POLICY } from "./model-router.js";
import { cacheBreakpointIndex, sealPrefix, stablePrefixLength } from "./prefix-cache.js";
import { compactHistory } from "./context-manager.js";
import type { LLMMessage, LLMToolCall } from "./types.js";
import type { SandboxRunner } from "@sqcode/sandbox-runner";

const call = (name: string, input: Record<string, unknown> = {}): LLMToolCall => ({
  id: `c_${Math.random()}`,
  name,
  input,
});

// ---------------------------------------------------------------------------
// repo map
// ---------------------------------------------------------------------------

describe("repo map: symbol extraction", () => {
  it("lists exported TypeScript declarations", () => {
    const src = [
      "import { x } from './x.js';",
      "export function makeThing(a: number): Thing {",
      "  return { a };",
      "}",
      "export class Widget extends Base {}",
      "export interface Options { a: string }",
      "export type Handler = () => void;",
      "export const LIMIT = 10;",
      "export enum Colour { Red }",
    ].join("\n");

    const names = extractSymbols("src/a.ts", src).map((s) => `${s.kind} ${s.name}`);
    expect(names).toEqual([
      "function makeThing",
      "class Widget",
      "interface Options",
      "type Handler",
      "const LIMIT",
      "enum Colour",
    ]);
  });

  it("ignores anything not exported, which is most of a file", () => {
    const src = "function helper() {}\nconst internal = 1;\nclass Private {}\n";
    expect(extractSymbols("src/a.ts", src)).toEqual([]);
  });

  it("keeps signatures on one line and drops the body brace", () => {
    const [sym] = extractSymbols("src/a.ts", "export function f(a: number): void {\n  body();\n}");
    expect(sym?.signature).toBe("export function f(a: number): void");
  });

  it("records line numbers, so a symbol can be jumped to", () => {
    const src = "\n\nexport const A = 1;\n";
    expect(extractSymbols("src/a.ts", src)[0]?.line).toBe(3);
  });

  it("reads top-level Python definitions and skips methods", () => {
    const src = ["class Thing:", "    def method(self):", "        pass", "", "def helper():", "    pass"].join("\n");
    const names = extractSymbols("app/x.py", src).map((s) => s.name);
    // `method` is indented, so it belongs to the class already listed.
    expect(names).toEqual(["Thing", "helper"]);
  });

  it("reads exported Go and Rust declarations", () => {
    expect(extractSymbols("m.go", "func Exported() {}\nfunc unexported() {}").map((s) => s.name)).toEqual(
      ["Exported"],
    );
    expect(extractSymbols("m.rs", "pub fn go() {}\nfn hidden() {}").map((s) => s.name)).toEqual(["go"]);
  });

  it("returns nothing for a language it does not parse", () => {
    expect(extractSymbols("style.css", ".a { color: red }")).toEqual([]);
  });
});

describe("repo map: how it is presented", () => {
  const map: RepoMap = {
    text: "src/\n  a.ts\n    function f",
    filesIncluded: 1,
    filesOmitted: 3,
    symbolCount: 1,
    approxTokens: 12,
    fingerprint: "abc-1",
  };

  it("warns the model that the map is not proof of absence", () => {
    // The dangerous misreading: treating a partial map as a complete index and
    // concluding a symbol does not exist.
    const out = renderForPrompt(map);
    expect(out).toMatch(/absence/i);
    expect(out).toMatch(/read a file before editing/i);
  });

  it("says something sensible for an empty workspace", () => {
    const empty = { ...map, text: "" };
    expect(renderForPrompt(empty)).toMatch(/no source files/i);
  });
});

// ---------------------------------------------------------------------------
// tool cache
// ---------------------------------------------------------------------------

describe("tool cache", () => {
  it("serves an identical repeat read", () => {
    const cache = new ToolResultCache();
    const read = call("read_file", { path: "src/a.ts" });
    cache.set(read, "contents", true);
    expect(cache.get(call("read_file", { path: "src/a.ts" }))?.content).toBe("contents");
  });

  it("keys on arguments regardless of the order they arrived in", () => {
    // A model streaming tool arguments gives no ordering guarantee, so
    // `{path, start_line}` and `{start_line, path}` are the same read.
    expect(cacheKey("read_file", { path: "a", start_line: 1 })).toBe(
      cacheKey("read_file", { start_line: 1, path: "a" }),
    );
  });

  it("does not cache a write", () => {
    const cache = new ToolResultCache();
    const write = call("write_file", { path: "a.ts", content: "x" });
    cache.set(write, "ok", true);
    expect(cache.get(write)).toBeNull();
  });

  it("does not cache a failure, which is usually transient", () => {
    // A file the agent is about to create must not be "not found" for the
    // rest of the turn.
    const cache = new ToolResultCache();
    const read = call("read_file", { path: "new.ts" });
    cache.set(read, "ENOENT", false);
    expect(cache.get(read)).toBeNull();
  });

  it("drops a read after a write to the same path", () => {
    const cache = new ToolResultCache();
    cache.set(call("read_file", { path: "src/a.ts" }), "old", true);
    cache.observeMutation(call("edit_file", { path: "src/a.ts" }));
    expect(cache.get(call("read_file", { path: "src/a.ts" }))).toBeNull();
  });

  it("drops a directory listing after a write inside it", () => {
    const cache = new ToolResultCache();
    cache.set(call("list_directory", { path: "src" }), "a.ts", true);
    cache.observeMutation(call("write_file", { path: "src/b.ts" }));
    expect(cache.get(call("list_directory", { path: "src" }))).toBeNull();
  });

  it("drops a repo-wide search after any write", () => {
    const cache = new ToolResultCache();
    cache.set(call("grep_search", { query: "TODO" }), "none", true);
    cache.observeMutation(call("write_file", { path: "deep/nested/file.ts" }));
    expect(cache.get(call("grep_search", { query: "TODO" }))).toBeNull();
  });

  /*
   * The conservative rule that gives up hits on purpose. A command is opaque:
   * `npm run build` rewrites a directory, `git checkout` rewrites everything,
   * and the argument string does not say which.
   */
  it("drops everything workspace-derived after a command", () => {
    const cache = new ToolResultCache();
    cache.set(call("read_file", { path: "a.ts" }), "x", true);
    cache.set(call("list_directory", { path: "." }), "y", true);
    cache.observeMutation(call("run_command", { command: "npm run build" }));
    expect(cache.get(call("read_file", { path: "a.ts" }))).toBeNull();
    expect(cache.get(call("list_directory", { path: "." }))).toBeNull();
  });

  it("keeps a web result across a command, which cannot have changed it", () => {
    const cache = new ToolResultCache();
    const search = call("web_search", { query: "vitest docs" });
    cache.set(search, "results", true);
    cache.observeMutation(call("run_command", { command: "npm run build" }));
    expect(cache.get(search)?.content).toBe("results");
  });

  it("does not cache a screenshot, which is of a live page", () => {
    expect(isCacheableTool("browser_screenshot")).toBe(false);
    expect(isCacheableTool("read_file")).toBe(true);
  });

  it("reports what it saved, so the number is checkable", () => {
    const cache = new ToolResultCache();
    const read = call("read_file", { path: "a.ts" });
    cache.set(read, "x".repeat(350), true);
    cache.get(read);
    const stats = cache.snapshot();
    expect(stats.hits).toBe(1);
    expect(stats.tokensSaved).toBeGreaterThan(90);
  });
});

// ---------------------------------------------------------------------------
// test selection
// ---------------------------------------------------------------------------

/** A runner that only knows about a fixed set of files. */
function fakeRunner(files: Record<string, string>): SandboxRunner {
  return {
    createWorkspace: async () => ({
      workspaceId: "w",
      status: "active" as const,
      workspacePath: "/w",
      createdAt: new Date(),
    }),
    destroyWorkspace: async () => undefined,
    readFile: async (_w: string, path: string) => {
      const content = files[path];
      if (content === undefined) throw new Error(`ENOENT ${path}`);
      return { content, totalLines: content.split("\n").length };
    },
    writeFile: async (_w: string, path: string) => ({ bytesWritten: 0, path }),
    listDirectory: async () => [],
    execCommand: async () => ({
      exitCode: 1,
      stdout: "",
      stderr: "",
      durationMs: 0,
      timedOut: false,
    }),
    getDiff: async () => "",
    inspectWorkspace: async () => null,
  };
}

describe("test selection", () => {
  it("finds a sibling test by convention", async () => {
    const runner = fakeRunner({
      "src/auth.ts": "x",
      "src/auth.test.ts": "y",
      "package.json": JSON.stringify({ devDependencies: { vitest: "1" } }),
    });
    const sel = await selectTests(runner, "w", ["src/auth.ts"]);
    expect(sel.files).toContain("src/auth.test.ts");
    expect(sel.command).toMatch(/vitest/);
  });

  it("finds a Python test under its own convention", async () => {
    const runner = fakeRunner({ "app/parse.py": "x", "app/test_parse.py": "y" });
    const sel = await selectTests(runner, "w", ["app/parse.py"]);
    expect(sel.files).toEqual(["app/test_parse.py"]);
    expect(sel.command).toMatch(/pytest/);
  });

  it("treats a changed test file as covering itself", async () => {
    const runner = fakeRunner({
      "src/a.test.ts": "y",
      "package.json": JSON.stringify({ devDependencies: { vitest: "1" } }),
    });
    const sel = await selectTests(runner, "w", ["src/a.test.ts"]);
    expect(sel.files).toEqual(["src/a.test.ts"]);
  });

  /*
   * The refusal that matters. "No targeted tests, so run the whole suite"
   * turns a fast check into the slow one it exists to replace, at the moment
   * the agent has least idea what it broke.
   */
  it("runs nothing when nothing covers the change", async () => {
    const runner = fakeRunner({ "src/lonely.ts": "x" });
    const sel = await selectTests(runner, "w", ["src/lonely.ts"]);
    expect(sel.files).toEqual([]);
    expect(sel.command).toBeNull();
    expect(sel.reason).toBe("none");
  });

  it("says why it could not run tests it did find", async () => {
    const runner = fakeRunner({ "src/a.ts": "x", "src/a.test.ts": "y" });
    const sel = await selectTests(runner, "w", ["src/a.ts"]);
    expect(sel.files).toContain("src/a.test.ts");
    expect(sel.command).toBeNull();
    expect(sel.note).toMatch(/package\.json/);
  });

  it("picks the runner the project actually uses", async () => {
    const jest = fakeRunner({
      "src/a.ts": "x",
      "src/a.test.ts": "y",
      "package.json": JSON.stringify({ devDependencies: { jest: "29" } }),
    });
    expect((await selectTests(jest, "w", ["src/a.ts"])).command).toMatch(/jest/);
  });

  it("tells the model to fix the code, not the test", () => {
    const outcome: TestRunOutcome = {
      ran: true,
      passed: false,
      command: "npx vitest run src/a.test.ts",
      files: ["src/a.test.ts"],
      output: "1 failed",
      failures: ["FAIL src/a.test.ts > adds"],
    };
    const msg = testFeedback(outcome);
    expect(msg).toMatch(/fix the code, not the test/i);
    expect(msg).toContain("src/a.test.ts");
  });
});

// ---------------------------------------------------------------------------
// self-review
// ---------------------------------------------------------------------------

describe("self-review verdict parsing", () => {
  it("reads a clean verdict", () => {
    const v = parseVerdict("VERDICT: OK");
    expect(v.clean).toBe(true);
    expect(v.ran).toBe(true);
  });

  it("reads concerns as separate items", () => {
    const v = parseVerdict("VERDICT: CONCERNS\n- src/a.ts: left a console.log\n- src/b.ts: renamed a variable nobody asked about");
    expect(v.clean).toBe(false);
    expect(v.concerns).toHaveLength(2);
    expect(v.concerns[0]).toContain("console.log");
  });

  it("tolerates a preamble and a code fence", () => {
    // A review thrown away on a formatting deviation is a review that silently
    // stops working the day the model changes.
    const v = parseVerdict("Looking at this diff...\n```\nVERDICT: OK\n```");
    expect(v.clean).toBe(true);
  });

  /*
   * The one thing it must not do is guess. An unparseable answer is reported
   * as "did not run", never as clean — otherwise a broken reviewer silently
   * becomes an approving one.
   */
  it("reports an unparseable answer as not-run rather than as clean", () => {
    const v = parseVerdict("I think this looks fine to me overall.");
    expect(v.ran).toBe(false);
    expect(v.clean).toBe(false);
  });

  it("does not block the turn when it says CONCERNS and lists none", () => {
    const v = parseVerdict("VERDICT: CONCERNS\n");
    expect(v.clean).toBe(true);
    expect(v.note).toBeTruthy();
  });

  it("frames feedback as evidence the agent may argue with", () => {
    const msg = reviewFeedback({ clean: false, ran: true, concerns: ["src/a.ts: scope creep"] });
    expect(msg).toMatch(/evidence, not an instruction/i);
    expect(msg).toContain("scope creep");
  });
});

// ---------------------------------------------------------------------------
// model routing
// ---------------------------------------------------------------------------

const assistantWith = (names: string[]): LLMMessage => ({
  role: "assistant",
  content: "",
  toolCalls: names.map((n) => ({ id: n, name: n, input: {} })),
});

describe("model routing", () => {
  it("calls the opening pass orientation", () => {
    expect(classifyStep([], 1)).toBe("orientation");
  });

  it("stays on orientation while only reading", () => {
    expect(classifyStep([assistantWith(["read_file", "grep_search"])], 3)).toBe("orientation");
  });

  it("switches to synthesis when about to write", () => {
    expect(classifyStep([assistantWith(["edit_file"])], 3)).toBe("synthesis");
  });

  it("switches to synthesis after a plan is posted", () => {
    expect(classifyStep([assistantWith(["update_todo_list"])], 3)).toBe("synthesis");
  });

  /*
   * The pass after a failure is the hardest in the turn, and exactly where a
   * cheap model produces a plausible wrong fix that then has to be undone.
   */
  it("switches to synthesis after a failed tool result, whatever came before", () => {
    const history: LLMMessage[] = [
      assistantWith(["read_file"]),
      { role: "tool", toolCallId: "read_file", content: "error TS2304: cannot find name" },
    ];
    expect(classifyStep(history, 4)).toBe("synthesis");
  });

  it("calls a pass with no tool calls a summary", () => {
    expect(classifyStep([{ role: "assistant", content: "Done." }], 5)).toBe("summary");
  });

  it("is off by default", () => {
    expect(DEFAULT_POLICY.enabled).toBe(false);
    const d = routeStep(DEFAULT_POLICY, [], 1);
    expect(d.model).toBe(DEFAULT_POLICY.strongModel);
    expect(d.reason).toMatch(/disabled/);
  });

  it("uses the fast model only for orientation and summary", () => {
    const policy = { enabled: true, strongModel: "big", fastModel: "small" };
    expect(routeStep(policy, [], 1).model).toBe("small");
    expect(routeStep(policy, [assistantWith(["edit_file"])], 3).model).toBe("big");
    expect(routeStep(policy, [{ role: "assistant", content: "done" }], 6).model).toBe("small");
  });

  /*
   * Every uncertainty resolves to the strong model. A routing bug should cost
   * money, not quality: one of those is visible on a dashboard the same day.
   */
  it("falls back to the strong model when no fast model is configured", () => {
    const policy = { enabled: true, strongModel: "big" };
    expect(routeStep(policy, [], 1).model).toBe("big");
  });

  it("is switched off entirely at the top effort tier", () => {
    const policy = { enabled: true, strongModel: "big", fastModel: "small" };
    const d = routeStep(policy, [], 1, "apex");
    expect(d.model).toBe("big");
    expect(d.reason).toMatch(/one model throughout/);
  });

  it("stays enabled at the tiers that permit it", () => {
    const policy = { enabled: true, strongModel: "big", fastModel: "small" };
    expect(routeStep(policy, [], 1, "medium").model).toBe("small");
  });

  it("requires both the flag and a fast model before enabling itself", () => {
    expect(policyFromEnv({ SOREQEN_MODEL_ROUTING: "1" }).enabled).toBe(false);
    expect(policyFromEnv({ SOREQEN_FAST_MODEL: "small" }).enabled).toBe(false);
    expect(
      policyFromEnv({ SOREQEN_MODEL_ROUTING: "1", SOREQEN_FAST_MODEL: "small" }).enabled,
    ).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// cross-turn prefix caching
// ---------------------------------------------------------------------------

const msg = (i: number): LLMMessage => ({ role: "user", content: `message number ${i}` });

describe("prefix sealing", () => {
  const history = [msg(1), msg(2), msg(3), msg(4), msg(5), msg(6)];

  it("seals nothing until there is enough to seal", () => {
    expect(sealPrefix([msg(1), msg(2)], 10_000, null)).toBeNull();
  });

  it("seals a prefix and recognises it next turn", () => {
    const seal = sealPrefix(history, 10_000, null);
    expect(seal).not.toBeNull();
    expect(stablePrefixLength([...history, msg(7)], seal)).toBe(seal!.length);
  });

  it("never seals the final message, which is this turn's live exchange", () => {
    const seal = sealPrefix(history, 10_000, null);
    expect(seal!.length).toBeLessThan(history.length);
  });

  /*
   * The property the whole mechanism rests on. A prefix that differs by one
   * byte is a complete cache miss — silently, with no error, at a price that
   * looks the same as before.
   */
  it("refuses a seal whose content has changed underneath it", () => {
    const seal = sealPrefix(history, 10_000, null);
    const edited = [...history];
    edited[1] = { role: "user", content: "message number two, edited" };
    expect(stablePrefixLength(edited, seal)).toBe(0);
  });

  it("refuses a seal after the history got shorter", () => {
    const seal = sealPrefix(history, 10_000, null);
    expect(stablePrefixLength([msg(1), msg(2)], seal)).toBe(0);
  });

  it("breaks the seal rather than freeze more than it can afford", () => {
    // When the head alone approaches the budget, keeping the seal would make
    // compaction refuse to touch messages it must touch.
    const huge = Array.from({ length: 6 }, () => ({
      role: "user" as const,
      content: "x".repeat(40_000),
    }));
    expect(sealPrefix(huge, 1_000, null)).toBeNull();
  });

  it("places no cache breakpoint when nothing is sealed", () => {
    expect(cacheBreakpointIndex(history, null)).toBeNull();
  });

  it("places the breakpoint at the end of the sealed region", () => {
    const seal = sealPrefix(history, 10_000, null);
    expect(cacheBreakpointIndex(history, seal)).toBe(seal!.length - 1);
  });
});

describe("compaction respects the seal", () => {
  /** A history whose middle is large enough that compaction must act. */
  const big: LLMMessage[] = [
    { role: "user", content: "the original goal" },
    { role: "assistant", content: "ok" },
    { role: "tool", toolCallId: "t1", content: "A".repeat(60_000) },
    { role: "tool", toolCallId: "t2", content: "B".repeat(60_000) },
    { role: "assistant", content: "thinking" },
    { role: "user", content: "and now this" },
  ];

  it("returns the frozen region byte-for-byte", () => {
    const out = compactHistory(big, { maxTokens: 2_000, frozenPrefixLength: 4 });
    for (let i = 0; i < 4; i++) {
      expect(out[i]).toEqual(big[i]);
    }
  });

  it("still compacts when nothing is frozen", () => {
    const out = compactHistory(big, { maxTokens: 2_000 });
    const before = JSON.stringify(big).length;
    expect(JSON.stringify(out).length).toBeLessThan(before);
  });

  it("ignores a stale seal longer than the history", () => {
    // Must not protect indices past the end, or reclaim nothing at all.
    const out = compactHistory(big, { maxTokens: 2_000, frozenPrefixLength: 99 });
    expect(out.length).toBeGreaterThan(0);
  });
});
