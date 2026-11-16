/**
 * Running the tests that the change actually touches.
 *
 * ## The gap this closes
 *
 * Verification runs a typecheck and deliberately not the suite. That reasoning
 * is sound and is written out in `self-healer.ts`: a slow check that fails for
 * unrelated reasons gets ignored, and an ignored check is worse than none.
 *
 * But it holds for the *whole* suite, not for the four tests covering the file
 * that was just edited. Those are fast, they fail almost exclusively for real
 * reasons, and they catch the one class of bug a typechecker structurally
 * cannot: code that compiles and does the wrong thing. That is the most common
 * shape of a bad agent turn.
 *
 * ## Finding them
 *
 * Two signals, in order of confidence:
 *
 *   1. **Naming convention.** `src/auth.ts` and `src/auth.test.ts` are related
 *      by an agreement the whole ecosystem keeps. Cheap and almost never wrong.
 *   2. **Imports.** A test that imports the changed module covers it, whatever
 *      it is called. Found with one `grep` for the module's basename across
 *      test files — which also catches integration tests that a naming rule
 *      never would.
 *
 * ## What it refuses to do
 *
 * If nothing is found, it runs **nothing**. The tempting fallback — "no
 * targeted tests, so run the whole suite" — turns a fast check into the slow
 * one it was designed to replace, at exactly the moment the agent has the
 * least idea what it broke. Reporting "no tests cover these files" is honest
 * and is itself useful information about the change.
 */

import type { SandboxRunner } from "@sqcode/sandbox-runner";

/** Ceiling on a targeted run. Past this it is not a targeted run any more. */
const TEST_TIMEOUT_MS = 120_000;

/** More than this many test files and the selection is too broad to be worth
 *  the "targeted" claim — a change touching thirty modules wants the full
 *  suite, run deliberately, not a long list pretending to be narrow. */
const MAX_TEST_FILES = 12;

export interface TestSelection {
  /** Test files chosen. Empty means nothing covers the change. */
  files: string[];
  /** The command to run them, ready to execute. Null when `files` is empty or
   *  no runner could be identified. */
  command: string | null;
  /** Which signal found each file, for the explanation. */
  reason: "convention" | "imports" | "mixed" | "none";
  /** Set when a runner could not be determined, so the caller can say why
   *  nothing ran rather than implying the tests passed. */
  note?: string;
}

export interface TestRunOutcome {
  ran: boolean;
  passed: boolean;
  command?: string;
  files: string[];
  output: string;
  /** The lines worth showing the model. */
  failures?: string[];
}

const TEST_FILE = /(\.|_)(test|spec)\.[\w]+$|(^|\/)test_[\w]+\.py$|_test\.go$/;

/** Candidate test paths for a source file, by convention. */
function conventionalCandidates(sourcePath: string): string[] {
  const path = sourcePath.replace(/\\/g, "/");
  const slash = path.lastIndexOf("/");
  const dir = slash === -1 ? "" : path.slice(0, slash);
  const base = slash === -1 ? path : path.slice(slash + 1);
  const dot = base.lastIndexOf(".");
  if (dot <= 0) return [];
  const stem = base.slice(0, dot);
  const ext = base.slice(dot + 1);

  const withDir = (d: string, f: string): string => (d ? `${d}/${f}` : f);

  if (ext === "py") {
    return [
      withDir(dir, `test_${stem}.py`),
      withDir(dir, `${stem}_test.py`),
      `tests/test_${stem}.py`,
      `test/test_${stem}.py`,
      withDir(dir, `tests/test_${stem}.py`),
    ];
  }

  if (ext === "go") {
    return [withDir(dir, `${stem}_test.go`)];
  }

  if (ext === "rs") {
    // Rust keeps unit tests in the file. An integration test in `tests/` is
    // the only separate thing to look for.
    return [`tests/${stem}.rs`];
  }

  // TypeScript / JavaScript, where the conventions are many and all common.
  const exts = [ext, ext.replace(/^t/, "j"), ext.replace(/^j/, "t")];
  const out: string[] = [];
  for (const e of new Set(exts)) {
    out.push(
      withDir(dir, `${stem}.test.${e}`),
      withDir(dir, `${stem}.spec.${e}`),
      withDir(dir, `__tests__/${stem}.test.${e}`),
      withDir(dir, `__tests__/${stem}.${e}`),
      `test/${stem}.test.${e}`,
      `tests/${stem}.test.${e}`,
    );
  }
  return out;
}

async function fileExists(
  runner: SandboxRunner,
  workspaceId: string,
  path: string,
): Promise<boolean> {
  try {
    await runner.readFile(workspaceId, path, 1, 1);
    return true;
  } catch {
    return false;
  }
}

/**
 * Test files that import one of the changed modules.
 *
 * Searched by basename without extension, which is what appears in an import
 * specifier in every language here — `from "./auth"`, `import auth`,
 * `from .auth import`. Over-matches on short or generic stems, which is why
 * the result is capped and why convention matches are preferred.
 */
async function importersOf(
  runner: SandboxRunner,
  workspaceId: string,
  changedFiles: string[],
): Promise<string[]> {
  const stems = [
    ...new Set(
      changedFiles
        .map((f) => f.replace(/\\/g, "/").split("/").pop() ?? "")
        .map((b) => b.replace(/\.[\w]+$/, ""))
        .filter((s) => s.length >= 3 && !/^(index|main|mod|init|__init__)$/.test(s)),
    ),
  ];
  if (stems.length === 0) return [];

  const pattern = stems.map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|");

  try {
    const res = await runner.execCommand(workspaceId, {
      // `-l` for names only: the matching lines are not interesting, only
      // which files matched.
      command:
        `grep -rlE "(${pattern})" --include="*.test.*" --include="*.spec.*" ` +
        `--include="test_*.py" --include="*_test.go" --include="*_test.py" . ` +
        `2>/dev/null | head -${MAX_TEST_FILES * 2}`,
      timeoutMs: 20_000,
    });
    if (!res.stdout) return [];
    return res.stdout
      .split(/\r?\n/)
      .map((l) => l.trim().replace(/^\.\//, ""))
      .filter((l) => l.length > 0 && TEST_FILE.test(l))
      .filter((l) => !/node_modules|\.soreqen|dist\//.test(l));
  } catch {
    return [];
  }
}

interface PackageJsonShape {
  scripts?: Record<string, string>;
  devDependencies?: Record<string, string>;
  dependencies?: Record<string, string>;
}

/**
 * The command that runs a specific list of test files.
 *
 * Not `npm test`. A project's `test` script usually runs the whole suite and
 * often does setup around it, and appending file paths to an arbitrary script
 * produces something between "ignored" and "wrong". The runner is identified
 * and invoked directly, which is the only way `--` file filtering behaves
 * predictably.
 */
async function commandFor(
  runner: SandboxRunner,
  workspaceId: string,
  files: string[],
): Promise<{ command: string | null; note?: string }> {
  const quoted = files.map((f) => JSON.stringify(f)).join(" ");

  if (files.every((f) => f.endsWith(".py"))) {
    return { command: `python -m pytest -q ${quoted}` };
  }
  if (files.every((f) => f.endsWith(".go"))) {
    const dirs = [...new Set(files.map((f) => `./${f.split("/").slice(0, -1).join("/")}`))];
    return { command: `go test ${dirs.join(" ")}` };
  }

  let pkg: PackageJsonShape = {};
  try {
    const raw = await runner.readFile(workspaceId, "package.json");
    pkg = JSON.parse(raw.content) as PackageJsonShape;
  } catch {
    return {
      command: null,
      note: "no package.json, so the test runner could not be identified",
    };
  }

  const deps = { ...pkg.dependencies, ...pkg.devDependencies };
  const script = pkg.scripts?.["test"] ?? "";

  if ("vitest" in deps || script.includes("vitest")) {
    return { command: `npx --yes vitest run ${quoted}` };
  }
  if ("jest" in deps || script.includes("jest")) {
    return { command: `npx --yes jest ${quoted}` };
  }
  if ("mocha" in deps || script.includes("mocha")) {
    return { command: `npx --yes mocha ${quoted}` };
  }
  if ("@playwright/test" in deps) {
    return { command: `npx --yes playwright test ${quoted}` };
  }
  if (script.includes("node --test") || script.includes("node:test")) {
    return { command: `node --test ${quoted}` };
  }

  return {
    command: null,
    note: `a test runner could not be identified from package.json (test script: ${script || "none"})`,
  };
}

/** Which tests cover these changes. */
export async function selectTests(
  runner: SandboxRunner,
  workspaceId: string,
  changedFiles: string[],
): Promise<TestSelection> {
  // A change to a test file is covered by running that test file.
  const changedTests = changedFiles.filter((f) => TEST_FILE.test(f));
  const changedSources = changedFiles.filter((f) => !TEST_FILE.test(f));

  const byConvention: string[] = [];
  for (const source of changedSources) {
    for (const candidate of conventionalCandidates(source)) {
      if (await fileExists(runner, workspaceId, candidate)) {
        byConvention.push(candidate);
        break; // one conventional home per source file
      }
    }
  }

  const byImport =
    byConvention.length + changedTests.length >= MAX_TEST_FILES
      ? []
      : await importersOf(runner, workspaceId, changedSources);

  const files = [...new Set([...changedTests, ...byConvention, ...byImport])].slice(
    0,
    MAX_TEST_FILES,
  );

  if (files.length === 0) {
    return { files: [], command: null, reason: "none" };
  }

  const { command, note } = await commandFor(runner, workspaceId, files);

  const reason: TestSelection["reason"] =
    byConvention.length > 0 && byImport.length > 0
      ? "mixed"
      : byConvention.length > 0 || changedTests.length > 0
        ? "convention"
        : "imports";

  return { files, command, reason, ...(note ? { note } : {}) };
}

/** Failure lines from a test runner's output, across the common formats. */
function extractFailures(output: string): string[] {
  const lines = output.split(/\r?\n/);
  const interesting = lines.filter((l) =>
    /^\s*(FAIL|✕|×|✗|not ok|E\s|FAILED|--- FAIL)|AssertionError|Expected .* (to|but)|\bexpected\b.*\breceived\b/i.test(
      l,
    ),
  );
  const chosen = interesting.length > 0 ? interesting : lines.filter((l) => l.trim());
  return chosen.slice(0, 20).map((l) => l.trim());
}

/**
 * Select and run.
 *
 * `ran: false` with `passed: true` is the correct answer when nothing covers
 * the change: the check did not fail, it did not happen, and the caller must
 * be able to tell those apart — reporting "tests passed" for a run that never
 * occurred is exactly the kind of confident wrong answer this whole subsystem
 * exists to prevent.
 */
export async function runAffectedTests(
  runner: SandboxRunner,
  workspaceId: string,
  changedFiles: string[],
): Promise<TestRunOutcome> {
  const selection = await selectTests(runner, workspaceId, changedFiles);

  if (selection.files.length === 0) {
    return {
      ran: false,
      passed: true,
      files: [],
      output: "No test files cover the changed sources.",
    };
  }

  if (!selection.command) {
    return {
      ran: false,
      passed: true,
      files: selection.files,
      output: `Found ${selection.files.length} covering test file(s) but ${selection.note ?? "could not run them"}.`,
    };
  }

  try {
    const res = await runner.execCommand(workspaceId, {
      command: selection.command,
      timeoutMs: TEST_TIMEOUT_MS,
    });
    const combined = `${res.stdout ?? ""}\n${res.stderr ?? ""}`.trim();

    if (res.timedOut) {
      /*
       * A timeout is not a failure.
       *
       * Reporting it as one sends the agent to "fix" passing code, and the
       * likeliest fix it will reach for is weakening the test. Better to say
       * the check did not complete and let the turn finish honestly.
       */
      return {
        ran: false,
        passed: true,
        command: selection.command,
        files: selection.files,
        output: `The targeted tests did not finish within ${TEST_TIMEOUT_MS / 1000}s and were not counted.`,
      };
    }

    return {
      ran: true,
      passed: res.exitCode === 0,
      command: selection.command,
      files: selection.files,
      output: combined,
      ...(res.exitCode === 0 ? {} : { failures: extractFailures(combined) }),
    };
  } catch (err: unknown) {
    return {
      ran: false,
      passed: true,
      command: selection.command,
      files: selection.files,
      output: `The targeted tests could not be run: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

/** What the model is told when targeted tests fail. Evidence, not orders —
 *  the same posture as `SelfHealer.feedbackFor`. */
export function testFeedback(outcome: TestRunOutcome): string {
  return [
    `The tests covering your changes are failing.`,
    outcome.command ? `Command: ${outcome.command}` : "",
    `Files: ${outcome.files.join(", ")}`,
    "",
    ...(outcome.failures ?? []).map((f) => `  ${f}`),
    "",
    "Fix the code, not the test. If a failure is pre-existing and unrelated to your",
    "change, say so explicitly rather than silently leaving it.",
  ]
    .filter((l) => l !== "")
    .join("\n");
}
