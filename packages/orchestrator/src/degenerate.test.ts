/**
 * A response caught repeating itself while it streams (see `degenerate.ts`),
 * the same step taken again (see `repetition.ts`), and what is read whole.
 */

import { describe, expect, it } from "vitest";
import { DegenerationWatch, isDegenerate } from "./degenerate.js";
import { stableResult, stepFingerprint } from "./repetition.js";
import { documentLimit, wholeLimit } from "./tool-result.js";

const prose =
  "The parser reads the header first, then each record in turn. A record that fails validation is kept aside with " +
  "the reason, so the report can list every problem at once instead of stopping at the first. Dates are parsed in " +
  "the file's own timezone, which the header names, and converted once at the end. Amounts stay as integers of the " +
  "smallest unit until they are shown. The tests cover an empty file, a header with no records, a record with a " +
  "missing field, a duplicated id, a negative amount and a date in the wrong format, each with the message a person " +
  "would read. Every one of those cases has its own fixture, named for what it checks, and the fixtures are small " +
  "enough to read in a glance. The report itself is plain text with one line per problem, the record's position " +
  "first, then the field, then what was wrong and what was expected instead. A summary at the end counts each kind.";

describe("a looping response", () => {
  it("is caught: one phrase over and over, with its formatting drifting", () => {
    const variants = ["The dump settles it: 248068 is ", "The dump settles it: **248068** is ", "The dump settles it: `248068` is "];
    let text = "";
    for (let i = 0; text.length < 6_000; i++) text += variants[i % 3];
    expect(isDegenerate(text)).toBe(true);
  });

  it("is not confused with prose, a long list or code", () => {
    expect(isDegenerate(prose + prose.split(" ").reverse().join(" "))).toBe(false);
    const list = Array.from({ length: 200 }, (_, i) => `- item ${i}: src/module_${i}/index.ts exports handler${i}()`).join("\n");
    expect(isDegenerate(list)).toBe(false);
    const code = Array.from({ length: 120 }, (_, i) => `  const value${i} = compute(input[${i}], options.scale * ${i});`).join("\n");
    expect(isDegenerate(code)).toBe(false);
  });

  it("is checked a few times per response, not per token", () => {
    const watch = new DegenerationWatch(600);
    const loop = "again and again and again ".repeat(400);
    let caughtAt = -1;
    for (let n = 1; n <= loop.length; n += 7) {
      if (watch.check(loop.slice(0, n))) {
        caughtAt = n;
        break;
      }
    }
    expect(caughtAt).toBeGreaterThan(2_400);
    expect(caughtAt).toBeLessThan(3_200);
  });
});

describe("the same step, again", () => {
  it("is the same whatever process id and run time it got, and different when the result is", () => {
    const a = '{"process_id":"p_01189fd8f571","command":"ls","status":"exited","ran_for":"0s","output":"skills"}';
    const b = '{"process_id":"p_3680c0563fae","command":"ls","status":"exited","ran_for":"1s","output":"skills"}';
    expect(stableResult(a)).toBe(stableResult(b));
    const calls = [{ id: "1", name: "run_command", input: { command: "ls" } }];
    expect(stepFingerprint("Let me check.", calls, [a])).toBe(stepFingerprint("Let me check.", calls, [b]));
    expect(stepFingerprint("Let me check.", calls, [a])).not.toBe(
      stepFingerprint("Let me check.", calls, [a.replace("skills", "skills, docs")]),
    );
  });
});

describe("documents read whole", () => {
  it("include sub-agent reports and every app's tools", () => {
    expect(documentLimit("spawn_subagent")).toBe(48_000);
    expect(documentLimit("subagent_status")).toBe(48_000);
    expect(documentLimit("research")).toBeGreaterThanOrEqual(48_000);
    expect(documentLimit("mcp__notion__fetch_page")).toBe(24_000);
    expect(documentLimit("read_file")).toBeUndefined();
    expect(wholeLimit("read_file")).toBeGreaterThan(0);
    expect(wholeLimit("mcp__linear__get_issue")).toBe(24_000);
  });
});
