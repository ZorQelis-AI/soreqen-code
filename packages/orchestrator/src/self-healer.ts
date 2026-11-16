/**
 * Checking the agent's work before it claims to be finished.
 *
 * ## Why this was rewritten
 *
 * The previous version was never called. `agent-loop.ts` collected
 * `modifiedFiles` under a comment saying "for self-healing verification", the
 * README advertised a "Closed-Loop Self-Healing" engine, and the only caller
 * of `verifyCodeIntegrity` was its own unit test. The loop went straight from
 * the model saying "done" to reporting success.
 *
 * That is the single biggest gap between what the system claimed and what it
 * did, because an agent's most expensive failure is not a crash — it is a
 * confident, plausible, broken change that a person only discovers later.
 *
 * ## What it does now
 *
 * Runs the project's **own** checks, not guessed ones. If `package.json`
 * defines `typecheck`, that is the command the maintainer intends; inventing
 * `npx tsc --noEmit` instead can pick up a different tsconfig, a different
 * strictness, or fail on files the project never compiles. Only when nothing
 * is declared does it fall back to a sensible default.
 *
 * ## What it deliberately does not do
 *
 * It does not run the test suite by default. Tests can take minutes, can
 * require services that are not up, and can fail for reasons that have nothing
 * to do with the edit — and a verification step that cries wolf gets ignored,
 * which is worse than not having one. Type and syntax checking is fast,
 * deterministic, and fails almost exclusively for real reasons.
 */

import type { SandboxRunner } from "@sqcode/sandbox-runner";

export interface VerificationResult {
  passed: boolean;
  type: "typecheck" | "syntax" | "none" | "unavailable";
  /** What was run, so a failure can be reproduced by hand. */
  command?: string;
  output: string;
  /** The lines worth showing the model. Trimmed, because a thousand-line
   *  compiler dump costs more context than it is worth. */
  diagnostics?: string[];
}

/** How long any single check may take. Generous enough for a cold `tsc` on a
 *  mid-sized project, short enough not to strand a turn. */
const CHECK_TIMEOUT_MS = 60_000;

/** Diagnostics shown to the model. Enough to see a pattern, not so many that
 *  they crowd out the code being fixed. */
const MAX_DIAGNOSTICS = 12;

interface PackageJsonShape {
  scripts?: Record<string, string>;
}

async function readPackageScripts(
  workspaceId: string,
  sandboxRunner: SandboxRunner,
): Promise<Record<string, string>> {
  try {
    const raw = await sandboxRunner.readFile(workspaceId, "package.json");
    const parsed = JSON.parse(raw.content) as PackageJsonShape;
    return parsed.scripts ?? {};
  } catch {
    // No package.json, or unreadable, or not JSON. All mean "no declared
    // scripts", which is a fact rather than an error.
    return {};
  }
}

async function exists(
  workspaceId: string,
  sandboxRunner: SandboxRunner,
  path: string,
): Promise<boolean> {
  try {
    await sandboxRunner.readFile(workspaceId, path);
    return true;
  } catch {
    return false;
  }
}

/** Compiler and interpreter errors, in the shapes the common tools emit. */
function extractDiagnostics(output: string): string[] {
  const lines = output.split(/\r?\n/);
  const interesting = lines.filter((l) =>
    /error TS\d+|SyntaxError|IndentationError|^\s*File "|error:|ERROR in/i.test(l),
  );
  const chosen = interesting.length > 0 ? interesting : lines.filter((l) => l.trim());
  return chosen.slice(0, MAX_DIAGNOSTICS).map((l) => l.trim());
}

export class SelfHealer {
  /**
   * Verify the files a turn changed.
   *
   * Returns `passed: true` when there was nothing to check — an agent that
   * edited only Markdown has not broken the build, and blocking on a check
   * that cannot run would strand it.
   */
  static async verifyCodeIntegrity(
    workspaceId: string,
    sandboxRunner: SandboxRunner,
    modifiedFiles: string[],
  ): Promise<VerificationResult> {
    if (modifiedFiles.length === 0) {
      return { passed: true, type: "none", output: "No files were modified." };
    }

    const touchedTs = modifiedFiles.filter((f) => /\.(ts|tsx|mts|cts)$/.test(f));
    const touchedPy = modifiedFiles.filter((f) => f.endsWith(".py"));

    if (touchedTs.length === 0 && touchedPy.length === 0) {
      return {
        passed: true,
        type: "none",
        output: "No compiled or interpreted sources were modified; nothing to verify.",
      };
    }

    if (touchedTs.length > 0) {
      const scripts = await readPackageScripts(workspaceId, sandboxRunner);

      /*
       * The project's own command wins.
       *
       * A maintainer who wrote a `typecheck` script has already decided which
       * config, which files and which strictness are correct. Guessing
       * `npx tsc --noEmit` instead can compile a different set entirely and
       * report failures the project would never see in CI — which teaches the
       * agent to "fix" things that were not broken.
       */
      const declared =
        scripts["typecheck"] ??
        scripts["type-check"] ??
        scripts["tsc"] ??
        (scripts["lint"]?.includes("tsc") ? scripts["lint"] : undefined);

      let command: string;
      if (declared) {
        command = `npm run --silent ${scripts["typecheck"] ? "typecheck" : scripts["type-check"] ? "type-check" : scripts["tsc"] ? "tsc" : "lint"}`;
      } else if (await exists(workspaceId, sandboxRunner, "tsconfig.json")) {
        command = "npx --yes tsc --noEmit";
      } else {
        // TypeScript files with no tsconfig and no script: there is no
        // project-level definition of "compiles", so there is nothing
        // meaningful to check. Say so rather than inventing a verdict.
        return {
          passed: true,
          type: "unavailable",
          output: "TypeScript files changed, but the project declares no typecheck script or tsconfig.json.",
        };
      }

      const res = await sandboxRunner.execCommand(workspaceId, {
        command,
        timeoutMs: CHECK_TIMEOUT_MS,
      });

      const combined = `${res.stdout ?? ""}\n${res.stderr ?? ""}`.trim();
      if (res.exitCode !== 0) {
        return {
          passed: false,
          type: "typecheck",
          command,
          output: combined,
          diagnostics: extractDiagnostics(combined),
        };
      }
    }

    if (touchedPy.length > 0) {
      const files = touchedPy.map((f) => JSON.stringify(f)).join(" ");
      const command = `python -m py_compile ${files}`;
      const res = await sandboxRunner.execCommand(workspaceId, {
        command,
        timeoutMs: CHECK_TIMEOUT_MS,
      });

      const combined = `${res.stdout ?? ""}\n${res.stderr ?? ""}`.trim();
      if (res.exitCode !== 0) {
        return {
          passed: false,
          type: "syntax",
          command,
          output: combined,
          diagnostics: extractDiagnostics(combined),
        };
      }
    }

    return {
      passed: true,
      type: "typecheck",
      output: "Changed sources compile cleanly.",
    };
  }

  /** The message handed back to the model when verification fails. Phrased as
   *  evidence rather than instruction: it reports what the project's own tools
   *  said, and leaves the diagnosis to the agent. */
  static feedbackFor(result: VerificationResult): string {
    const lines = [
      `Your changes do not pass the project's own checks.`,
      result.command ? `Command: ${result.command}` : "",
      "",
      ...(result.diagnostics ?? []).map((d) => `  ${d}`),
      "",
      "Fix these before finishing. If a diagnostic is pre-existing and unrelated to your",
      "change, say so explicitly rather than silently leaving it.",
    ];
    return lines.filter((l) => l !== "").join("\n");
  }
}
