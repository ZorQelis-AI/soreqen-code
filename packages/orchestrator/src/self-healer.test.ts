/**
 * Verifying the agent's work.
 *
 * This whole module was dead code until Phase 2: the README advertised a
 * closed-loop self-healing engine, `agent-loop.ts` collected `modifiedFiles`
 * "for self-healing verification", and the only caller of
 * `verifyCodeIntegrity` was a unit test. A turn went from the model saying
 * "done" straight to reported success.
 *
 * The tests below are mostly about **not crying wolf**. A verification step
 * that fails for reasons unrelated to the edit is worse than none at all: the
 * agent burns turns chasing pre-existing problems, and a person learns to
 * ignore the signal.
 */

import { describe, expect, it } from "vitest";
import { SelfHealer } from "./self-healer.js";
import type { SandboxRunner } from "@sqcode/sandbox-runner";

interface FakeOptions {
  files?: Record<string, string>;
  exec?: (command: string) => { exitCode: number; stdout?: string; stderr?: string };
}

/** A sandbox that answers from a fixed map, and records what was run. */
function fakeRunner(options: FakeOptions = {}) {
  const commands: string[] = [];
  const runner = {
    readFile: async (_ws: string, path: string) => {
      const content = options.files?.[path];
      if (content === undefined) throw new Error(`ENOENT: ${path}`);
      return { content, totalLines: content.split("\n").length };
    },
    execCommand: async (_ws: string, opts: { command: string }) => {
      commands.push(opts.command);
      const res = options.exec?.(opts.command) ?? { exitCode: 0 };
      return { exitCode: res.exitCode, stdout: res.stdout ?? "", stderr: res.stderr ?? "" };
    },
  } as unknown as SandboxRunner;
  return { runner, commands };
}

describe("deciding whether there is anything to check", () => {
  it("passes when nothing was modified", async () => {
    const { runner, commands } = fakeRunner();
    const r = await SelfHealer.verifyCodeIntegrity("ws", runner, []);
    expect(r.passed).toBe(true);
    expect(r.type).toBe("none");
    expect(commands).toEqual([]);
  });

  /*
   * Editing docs has not broken the build. Running a typecheck anyway costs a
   * minute and can only produce pre-existing failures to chase.
   */
  it("runs nothing when only docs changed", async () => {
    const { runner, commands } = fakeRunner();
    const r = await SelfHealer.verifyCodeIntegrity("ws", runner, ["README.md", "docs/a.mdx"]);
    expect(r.passed).toBe(true);
    expect(commands).toEqual([]);
  });

  /*
   * TypeScript with no tsconfig and no script means the project has no
   * definition of "compiles". Inventing one produces failures the project
   * itself would never see.
   */
  it("declines rather than guessing when the project defines no check", async () => {
    const { runner, commands } = fakeRunner({ files: {} });
    const r = await SelfHealer.verifyCodeIntegrity("ws", runner, ["src/a.ts"]);
    expect(r.passed).toBe(true);
    expect(r.type).toBe("unavailable");
    expect(commands).toEqual([]);
  });
});

describe("preferring the project's own command", () => {
  it("uses a declared typecheck script over a guessed tsc", async () => {
    const { runner, commands } = fakeRunner({
      files: { "package.json": JSON.stringify({ scripts: { typecheck: "tsc -p tsconfig.app.json" } }) },
    });
    await SelfHealer.verifyCodeIntegrity("ws", runner, ["src/a.ts"]);
    expect(commands[0]).toContain("npm run");
    expect(commands[0]).toContain("typecheck");
  });

  it("falls back to tsc only when a tsconfig exists and no script does", async () => {
    const { runner, commands } = fakeRunner({
      files: { "package.json": JSON.stringify({ scripts: { build: "vite build" } }), "tsconfig.json": "{}" },
    });
    await SelfHealer.verifyCodeIntegrity("ws", runner, ["src/a.ts"]);
    expect(commands[0]).toContain("tsc --noEmit");
  });

  it("survives a package.json that is not valid JSON", async () => {
    const { runner } = fakeRunner({ files: { "package.json": "{ broken", "tsconfig.json": "{}" } });
    const r = await SelfHealer.verifyCodeIntegrity("ws", runner, ["src/a.ts"]);
    expect(r.passed).toBe(true);
  });
});

describe("reporting a failure", () => {
  const tscOutput = [
    "src/a.ts(3,5): error TS2322: Type 'string' is not assignable to type 'number'.",
    "src/b.ts(9,1): error TS2554: Expected 2 arguments, but got 1.",
    "some unrelated chatter",
  ].join("\n");

  it("fails when the project's check fails", async () => {
    const { runner } = fakeRunner({
      files: { "package.json": JSON.stringify({ scripts: { typecheck: "tsc" } }) },
      exec: () => ({ exitCode: 2, stdout: tscOutput }),
    });
    const r = await SelfHealer.verifyCodeIntegrity("ws", runner, ["src/a.ts"]);
    expect(r.passed).toBe(false);
    expect(r.type).toBe("typecheck");
  });

  it("extracts the diagnostics and leaves out the noise", async () => {
    const { runner } = fakeRunner({
      files: { "package.json": JSON.stringify({ scripts: { typecheck: "tsc" } }) },
      exec: () => ({ exitCode: 2, stdout: tscOutput }),
    });
    const r = await SelfHealer.verifyCodeIntegrity("ws", runner, ["src/a.ts"]);
    expect(r.diagnostics).toHaveLength(2);
    expect(r.diagnostics?.[0]).toContain("TS2322");
  });

  it("records the command, so a person can reproduce it", async () => {
    const { runner } = fakeRunner({
      files: { "package.json": JSON.stringify({ scripts: { typecheck: "tsc" } }) },
      exec: () => ({ exitCode: 1, stdout: "error TS1005: ';' expected." }),
    });
    const r = await SelfHealer.verifyCodeIntegrity("ws", runner, ["src/a.ts"]);
    expect(r.command).toBeTruthy();
  });

  it("caps how many diagnostics reach the model", async () => {
    const many = Array.from({ length: 60 }, (_, i) => `src/x.ts(${i},1): error TS2322: nope.`).join(
      "\n",
    );
    const { runner } = fakeRunner({
      files: { "package.json": JSON.stringify({ scripts: { typecheck: "tsc" } }) },
      exec: () => ({ exitCode: 2, stdout: many }),
    });
    const r = await SelfHealer.verifyCodeIntegrity("ws", runner, ["src/x.ts"]);
    // A thousand-line dump costs more context than it is worth, and the
    // pattern is visible in the first dozen.
    expect(r.diagnostics!.length).toBeLessThanOrEqual(12);
  });
});

describe("the message handed back to the model", () => {
  it("reports evidence and names the command", () => {
    const feedback = SelfHealer.feedbackFor({
      passed: false,
      type: "typecheck",
      command: "npm run --silent typecheck",
      output: "...",
      diagnostics: ["src/a.ts(3,5): error TS2322: bad."],
    });
    expect(feedback).toContain("npm run --silent typecheck");
    expect(feedback).toContain("TS2322");
  });

  /*
   * Pre-existing failures are the main way a verification loop wastes turns,
   * so the agent is told explicitly that saying so is an acceptable answer.
   */
  it("gives the agent a way out for unrelated failures", () => {
    const feedback = SelfHealer.feedbackFor({
      passed: false,
      type: "typecheck",
      output: "",
      diagnostics: ["x"],
    });
    expect(feedback).toMatch(/pre-existing/i);
  });
});

describe("python", () => {
  it("compiles only the python files that changed", async () => {
    const { runner, commands } = fakeRunner();
    await SelfHealer.verifyCodeIntegrity("ws", runner, ["app/main.py", "README.md"]);
    expect(commands[0]).toContain("py_compile");
    expect(commands[0]).toContain("app/main.py");
    expect(commands[0]).not.toContain("README.md");
  });

  it("reports a syntax error", async () => {
    const { runner } = fakeRunner({
      exec: () => ({ exitCode: 1, stderr: 'File "app/main.py", line 3\n    SyntaxError: bad' }),
    });
    const r = await SelfHealer.verifyCodeIntegrity("ws", runner, ["app/main.py"]);
    expect(r.passed).toBe(false);
    expect(r.type).toBe("syntax");
  });
});
