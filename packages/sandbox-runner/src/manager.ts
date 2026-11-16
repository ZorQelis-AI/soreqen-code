/**
 * The shared local runner.
 *
 * SoreQen Code runs on the person's own machine — in the CLI and in the
 * desktop app — so tools run directly in the folders they open, guarded by
 * the path and command checks in `security.ts`, with no container in between.
 *
 * The Docker runner for a cloud machine lives in `@sqcode/sandbox-cloud`,
 * which only the gateway loads, and only when asked to (`SOREQEN_SANDBOX=docker`).
 */

import type { SandboxRunner } from "./types.js";
import { LocalSandboxRunner } from "./local-runner.js";

let runnerInstance: SandboxRunner | undefined;

export function getSandboxRunner(): SandboxRunner {
  runnerInstance ??= new LocalSandboxRunner();
  return runnerInstance;
}

export function resetSandboxRunner(): void {
  runnerInstance = undefined;
}
