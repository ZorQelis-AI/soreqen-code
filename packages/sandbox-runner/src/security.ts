/**
 * Sandbox Security & Path Traversal Guards
 */

import path from "node:path";
import fs from "node:fs";

export class PathTraversalError extends Error {
  constructor(attemptedPath: string, workspaceRoot: string) {
    super(
      `Security Boundary Violation: Path '${attemptedPath}' attempts to escape workspace root '${workspaceRoot}'`,
    );
    this.name = "PathTraversalError";
  }
}

export class SandboxSecurityError extends Error {
  constructor(message: string) {
    super(`Sandbox Security Error: ${message}`);
    this.name = "SandboxSecurityError";
  }
}

/**
 * Resolves and strictly validates that a relative or absolute target path
 * remains inside the assigned workspace root directory.
 */
/**
 * The workspace root, resolved once.
 *
 * `guardPath` runs on every file operation, and building a repository map
 * calls it several hundred times in a row — each one previously paying a
 * `realpathSync` on the *same* root. The root is a directory the runner owns
 * for the life of the process; resolving it repeatedly measured as a
 * meaningful fraction of the time to build a map on a large project.
 */
const realRootCache = new Map<string, string>();

function realRootOf(normalizedRoot: string): string {
  let cached = realRootCache.get(normalizedRoot);
  if (cached === undefined) {
    cached = fs.realpathSync(normalizedRoot);
    realRootCache.set(normalizedRoot, cached);
  }
  return cached;
}

/** For tests, and for a workspace destroyed and recreated at the same path. */
export function clearPathCache(): void {
  realRootCache.clear();
}

export function guardPath(workspaceRoot: string, targetPath: string): string {
  const normalizedRoot = path.resolve(workspaceRoot);

  // Clean leading slashes or Windows drive specifiers if relative path was meant
  let sanitizedTarget = targetPath.trim();
  if (sanitizedTarget.startsWith("/") || sanitizedTarget.startsWith("\\")) {
    sanitizedTarget = sanitizedTarget.slice(1);
  }

  const resolvedTarget = path.resolve(normalizedRoot, sanitizedTarget);

  // Check if resolved path starts with workspaceRoot
  const relative = path.relative(normalizedRoot, resolvedTarget);
  const isOutside = relative.startsWith("..") || path.isAbsolute(relative);

  if (isOutside) {
    throw new PathTraversalError(targetPath, workspaceRoot);
  }

  /*
   * Resolve the deepest part of the path that actually exists.
   *
   * The previous version only ran this when the *target itself* existed — so
   * it protected reads and skipped every create. A workspace containing a
   * symlinked directory, `ws/link -> /etc`, let a write to `ws/link/passwd`
   * through untouched: the target does not exist, so nothing was checked, and
   * the write went through the link. Which is the one case the whole function
   * is for.
   *
   * Walking up to the nearest existing ancestor and resolving *that* covers
   * both: an existing file is its own ancestor, and a file about to be created
   * is checked against the directory it will be created in.
   */
  let existing = resolvedTarget;
  while (!fs.existsSync(existing)) {
    const parent = path.dirname(existing);
    // `dirname` is a fixed point at the filesystem root.
    if (parent === existing) break;
    existing = parent;
  }

  try {
    const realExisting = fs.realpathSync(existing);
    const realRoot = realRootOf(normalizedRoot);
    const realRelative = path.relative(realRoot, realExisting);
    // "" means the ancestor *is* the root, which is inside it.
    if (realRelative !== "" && (realRelative.startsWith("..") || path.isAbsolute(realRelative))) {
      throw new PathTraversalError(targetPath, workspaceRoot);
    }
  } catch (err: unknown) {
    if (err instanceof PathTraversalError) throw err;
    /*
     * Deny, rather than allow.
     *
     * This block was commented "guard conservatively" and then returned the
     * path anyway — so a permissions error during validation was treated as
     * permission granted. If the boundary cannot be established, the answer
     * is no.
     */
    throw new PathTraversalError(targetPath, workspaceRoot);
  }

  return resolvedTarget;
}

/**
 * Things that have no legitimate use from inside a workspace sandbox.
 *
 * ## Why this list moved here
 *
 * There were two of these. The orchestrator's `guardrails.ts` had thirteen
 * structural patterns — fork bombs, `rm -rf /`, pipe-to-shell, reading SSH
 * keys — and this file had four. But `guardrails` is a *policy* layer that
 * only sees tool calls routed through the agent loop, while this function is
 * the last thing every command passes through whatever called it. So the
 * weaker list was the one actually enforced at the boundary, and the stronger
 * one was advice.
 *
 * One list, defined at the boundary, imported by the policy layer above it.
 * A denylist is not a security model — the real containment is `argv` for the
 * agent's own tools, plus the container — but where one exists it should at
 * least be the same one everywhere.
 */
export const HARD_DENIED: { pattern: RegExp; why: string }[] = [
  { pattern: /docker\.sock/, why: "reaching the Docker socket escapes the sandbox" },
  { pattern: /\/proc\/sys/, why: "writing kernel parameters escapes the sandbox" },
  { pattern: /\/etc\/(passwd|shadow)/, why: "reading or editing system credentials" },
  { pattern: /\bmkfs\./, why: "formatting a filesystem" },
  { pattern: /\bdd\s+if=/, why: "raw device writes" },
  {
    // Recursive delete of the filesystem root specifically. General `rm -rf
    // <path>` is ordinary work and asks for confirmation instead.
    pattern: /\brm\s+(-{1,2}[a-z-]+\s+)*\/(\s|$)|--no-preserve-root/,
    why: "deleting the filesystem root",
  },
  { pattern: /:\(\)\s*\{.*\}\s*;?\s*:/, why: "fork bomb" },
  { pattern: /\bchown\s+root\b/, why: "changing ownership to root" },
  { pattern: /\bchmod\s+0?777\s+\/(\s|$)/, why: "making the filesystem root world-writable" },
  { pattern: /\bformat\s+[a-z]:/i, why: "formatting a Windows volume" },
  {
    // Structural, not literal: `curl … | sh` always has a URL in the middle,
    // which is why the old `"curl | sh"` substring never once matched.
    pattern: /\b(curl|wget|iwr|invoke-webrequest)\b[^|;&]*\|\s*(sudo\s+)?(ba|z|k|da)?sh\b/,
    why: "piping a downloaded script straight into a shell",
  },
  {
    pattern: /\bpowershell\b[^|]*\s-e(nc|ncodedcommand)?\s/i,
    why: "base64-encoded PowerShell, which exists to hide what it runs",
  },
  { pattern: /~\/\.ssh\/|\/\.ssh\/id_/, why: "reading private keys" },
];

/**
 * Validate a shell command line against the denylist.
 *
 * Only for the shell path. Anything the agent's own tools run goes through
 * `argv`, where there is no shell to inject into and `validateProgramSafety`
 * checks the program itself.
 */
export function validateCommandSafety(command: string): void {
  const normalised = command.toLowerCase().replace(/\s+/g, " ").trim();

  for (const { pattern, why } of HARD_DENIED) {
    if (pattern.test(normalised)) {
      throw new SandboxSecurityError(`${why}. This is refused in every permission tier.`);
    }
  }
}

/**
 * Programs the agent's own tools are permitted to spawn directly.
 *
 * An `argv` call cannot inject, but it can still *name* something it has no
 * business running, so the program is checked rather than the arguments. This
 * is an allowlist because the set is small, known, and written here — unlike a
 * user's own `run_command`, which is a shell by design.
 */
const TOOL_PROGRAMS = new Set([
  "rg",
  "git",
  "node",
  "npx",
  "npm",
  "pnpm",
  "yarn",
  "python",
  "python3",
  "pytest",
  "cargo",
  "go",
  "tsc",
]);

export function validateProgramSafety(argv: string[]): void {
  const program = argv[0];
  if (!program) {
    throw new SandboxSecurityError("An argv execution needs a program to run.");
  }
  // Compare on the bare name so `/usr/bin/git` and `git.exe` are both `git`.
  const base = program
    .replace(/\\/g, "/")
    .split("/")
    .pop()!
    .replace(/\.(exe|cmd|bat)$/i, "")
    .toLowerCase();

  if (!TOOL_PROGRAMS.has(base)) {
    throw new SandboxSecurityError(
      `'${program}' is not one of the programs SoreQen's own tools may run directly. ` +
        `Use run_command if a person asked for this.`,
    );
  }
}
