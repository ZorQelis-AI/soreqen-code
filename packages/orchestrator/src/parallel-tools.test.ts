/**
 * Running tools at the same time, without changing what the model asked for.
 *
 * The loop used to execute every tool call in a plain `for` loop. Reading five
 * files cost five sequential round trips into the sandbox for work with no
 * ordering requirement — the largest avoidable latency in a turn, and on the
 * hosted surface, billed wall-clock time.
 *
 * Batching that is only safe under one rule: **a batch never crosses a
 * sequential call.** These tests exist for the failure that rule prevents,
 * which is not "slow" but "wrong": a write silently overtaken by a read that
 * was supposed to see it. That kind of bug surfaces much later, as a file with
 * the wrong contents and nothing to attribute it to.
 */

import { describe, expect, it } from "vitest";
import { isParallelSafe, PARALLEL_SAFE_TOOLS, SOREQEN_TOOL_DEFINITIONS } from "@sqcode/shared";

/**
 * The batching decision, extracted exactly as the loop performs it.
 *
 * Kept here rather than reaching into `runAgentTurn`, because the loop needs
 * an LLM, a sandbox and a permission tier to run at all — and the property
 * being tested is pure. Any change to the loop's grouping must be mirrored
 * here, which is the trade: a tiny duplication for a test that runs in a
 * millisecond and states the rule outright.
 */
function planBatches(names: string[]): string[][] {
  const batches: string[][] = [];
  let cursor = 0;
  while (cursor < names.length) {
    if (!isParallelSafe(names[cursor]!)) {
      batches.push([names[cursor]!]);
      cursor++;
      continue;
    }
    let end = cursor;
    while (end < names.length && isParallelSafe(names[end]!)) end++;
    batches.push(names.slice(cursor, end));
    cursor = end;
  }
  return batches;
}

describe("what may run concurrently", () => {
  it("treats pure reads as parallel-safe", () => {
    for (const t of ["read_file", "list_directory", "grep_search", "find_symbol_definition"]) {
      expect(isParallelSafe(t)).toBe(true);
    }
  });

  it("never parallelises anything that mutates", () => {
    for (const t of [
      "write_file",
      "edit_file",
      "run_command",
      "run_tests",
      "git_operation",
      "install_package",
      "update_todo_list",
      "spawn_subagent",
    ]) {
      expect(isParallelSafe(t)).toBe(false);
    }
  });

  it("keeps the two browser calls that drive the page sequential", () => {
    // browser_screenshot and browser_console_logs only read, and are only
    // safe *because* these two are not batched alongside them.
    expect(isParallelSafe("browser_open")).toBe(false);
    expect(isParallelSafe("browser_interact")).toBe(false);
  });

  it("lists only tools that actually exist", () => {
    const real = new Set(SOREQEN_TOOL_DEFINITIONS.map((t) => t.name));
    for (const name of PARALLEL_SAFE_TOOLS) {
      expect(real.has(name), `${name} is not a real tool`).toBe(true);
    }
  });

  it("says no to an unknown tool rather than guessing", () => {
    expect(isParallelSafe("some_future_tool")).toBe(false);
  });
});

describe("grouping preserves the order the model asked for", () => {
  it("batches a run of reads into one round trip", () => {
    expect(planBatches(["read_file", "read_file", "read_file"])).toEqual([
      ["read_file", "read_file", "read_file"],
    ]);
  });

  it("runs a lone write by itself", () => {
    expect(planBatches(["write_file"])).toEqual([["write_file"]]);
  });

  /*
   * The one that matters. [read, write, read] must never become
   * [read, read] + [write] — that would run the second read against the file
   * as it was *before* the write, and the model asked for the opposite.
   */
  it("never hoists a read across a write", () => {
    expect(planBatches(["read_file", "write_file", "read_file"])).toEqual([
      ["read_file"],
      ["write_file"],
      ["read_file"],
    ]);
  });

  it("splits at every sequential call, however many reads surround it", () => {
    expect(
      planBatches([
        "read_file",
        "grep_search",
        "edit_file",
        "read_file",
        "list_directory",
        "run_command",
        "read_file",
      ]),
    ).toEqual([
      ["read_file", "grep_search"],
      ["edit_file"],
      ["read_file", "list_directory"],
      ["run_command"],
      ["read_file"],
    ]);
  });

  it("keeps consecutive writes in their own batches, in order", () => {
    expect(planBatches(["write_file", "write_file"])).toEqual([["write_file"], ["write_file"]]);
  });

  it("covers every call exactly once, in the original order", () => {
    const calls = [
      "read_file",
      "write_file",
      "grep_search",
      "read_file",
      "run_tests",
      "list_directory",
    ];
    expect(planBatches(calls).flat()).toEqual(calls);
  });

  it("handles an empty turn", () => {
    expect(planBatches([])).toEqual([]);
  });
});
