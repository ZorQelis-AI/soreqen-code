/**
 * Keeping the CLI current: a quiet notice when a newer version is published,
 * and `soreqen update` to install it.
 *
 * ## Never in the way
 *
 * The notice at startup is read from the *last* check's result, saved in
 * `~/.soreqen/update-check.json`, so starting SoreQen never waits on the
 * network. A fresh check runs in the background at most once a day and only
 * informs the next start. `SOREQEN_NO_UPDATE_CHECK=1` turns it off, as does
 * running from a source checkout, which is updated with git, not npm.
 *
 * ## Which version
 *
 * Whatever the npm registry says `latest` is for this package's own name, read
 * from its package.json — so the check follows the package wherever it is
 * published, and a release is launched by `npm publish`, nothing else.
 */

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { soreqenHome } from "./extensions.js";

const DAY_MS = 24 * 3_600_000;

export interface PackageInfo {
  name: string;
  version: string;
  /** Not published: a workspace build. */
  private: boolean;
  /** Where the package is installed. */
  dir: string;
}

export function packageInfo(): PackageInfo {
  const dir = join(dirname(fileURLToPath(import.meta.url)), "..");
  try {
    const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8")) as { name?: string; version?: string; private?: boolean };
    return { name: pkg.name ?? "", version: pkg.version ?? "0.0.0", private: pkg.private === true, dir };
  } catch {
    return { name: "", version: "0.0.0", private: true, dir };
  }
}

/** `1.2.10` > `1.2.9`; a pre-release is older than its release. */
export function isNewer(candidate: string, current: string): boolean {
  const parse = (v: string) => {
    const [core = "", pre] = v.replace(/^v/, "").split("-", 2);
    return { nums: core.split(".").map((n) => Number(n) || 0), pre: pre ?? null };
  };
  const a = parse(candidate);
  const b = parse(current);
  for (let i = 0; i < 3; i++) {
    if ((a.nums[i] ?? 0) !== (b.nums[i] ?? 0)) return (a.nums[i] ?? 0) > (b.nums[i] ?? 0);
  }
  if (a.pre === b.pre) return false;
  if (a.pre === null) return true; // 1.0.0 is newer than 1.0.0-beta
  if (b.pre === null) return false;
  return a.pre > b.pre;
}

interface Cache {
  checkedAt: number;
  latest: string | null;
}

function cachePath(): string {
  return join(soreqenHome(), "update-check.json");
}

function readCache(): Cache | null {
  try {
    return JSON.parse(readFileSync(cachePath(), "utf8")) as Cache;
  } catch {
    return null;
  }
}

function checksDisabled(info: PackageInfo): boolean {
  return info.private || !info.name || process.env["SOREQEN_NO_UPDATE_CHECK"] === "1" || process.env["CI"] === "true";
}

/**
 * The newest published version, from the registry: a version, "unpublished"
 * when the registry has never heard of the name, or null when it could not be
 * asked.
 */
export async function latestVersion(name: string, fetchImpl: typeof fetch = fetch): Promise<string | "unpublished" | null> {
  const registry = (process.env["SOREQEN_UPDATE_REGISTRY"] ?? "https://registry.npmjs.org").replace(/\/+$/, "");
  try {
    const res = await fetchImpl(`${registry}/${name.replace("/", "%2f")}/latest`, {
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(4_000),
    });
    if (res.status === 404) return "unpublished";
    if (!res.ok) return null;
    const body = (await res.json()) as { version?: unknown };
    return typeof body.version === "string" ? body.version : null;
  } catch {
    return null;
  }
}

async function refresh(info: PackageInfo): Promise<string | "unpublished" | null> {
  const found = await latestVersion(info.name);
  const latest = found === "unpublished" ? null : found;
  try {
    mkdirSync(dirname(cachePath()), { recursive: true });
    writeFileSync(cachePath(), JSON.stringify({ checkedAt: Date.now(), latest } satisfies Cache));
  } catch {
    // A read-only home: no cache, and a check on every start instead.
  }
  return found;
}

/**
 * The notice for this start, from what the last check found — and a new
 * check in the background when that one is a day old. Returns null when
 * there is nothing to say.
 */
export function updateNotice(info: PackageInfo = packageInfo()): string | null {
  if (checksDisabled(info)) return null;
  const cache = readCache();
  if (!cache || Date.now() - cache.checkedAt > DAY_MS) {
    // Not awaited: its answer is for the next start.
    void refresh(info);
  }
  if (cache?.latest && isNewer(cache.latest, info.version)) {
    return `SoreQen Code ${cache.latest} is available (you have ${info.version}). Run \`soreqen update\`.`;
  }
  return null;
}

/** How this copy was installed, so it is updated the same way. */
export function installer(info: PackageInfo): { command: string; args: string[] } | { source: true } {
  // Both separators, whatever this system uses, so a path reads the same everywhere.
  const path = info.dir.replace(/\\/g, "/").toLowerCase();
  // Run from the monorepo: updated with git.
  if (!path.includes("/node_modules/") && existsSync(join(info.dir, "src"))) return { source: true };
  const spec = `${info.name}@latest`;
  if (path.includes("/pnpm/") || path.includes("/.pnpm/")) return { command: "pnpm", args: ["add", "-g", spec] };
  if (path.includes("/.bun/")) return { command: "bun", args: ["add", "-g", spec] };
  if (path.includes("/yarn/")) return { command: "yarn", args: ["global", "add", spec] };
  return { command: "npm", args: ["install", "-g", spec] };
}

/** `soreqen update`. Returns the process exit code. */
export async function runUpdate(log: (line: string) => void = console.log): Promise<number> {
  const info = packageInfo();
  const how = installer(info);
  if ("source" in how) {
    log(`This is SoreQen Code from source (${info.dir}). Update it with \`git pull\` and \`pnpm build\`.`);
    return 0;
  }
  if (info.private || !info.name) {
    log("This build of SoreQen Code is not a published package, so there is nothing to update from.");
    return 0;
  }
  log(`Checking for a newer SoreQen Code than ${info.version}…`);
  const latest = await refresh(info);
  if (latest === "unpublished") {
    log(`${info.name} is not on the package registry yet, so there is nothing newer to install.`);
    return 0;
  }
  if (!latest) {
    log("Could not reach the package registry. Try again, or check your connection.");
    return 1;
  }
  if (!isNewer(latest, info.version)) {
    log(`You have the latest version (${info.version}).`);
    return 0;
  }
  log(`Installing ${latest} with: ${how.command} ${how.args.join(" ")}`);
  // Windows runs npm, pnpm and yarn through .cmd shims, which only a shell starts.
  const result = spawnSync(`${how.command} ${how.args.join(" ")}`, [], { stdio: "inherit", shell: true });
  if (result.status !== 0) {
    log(`The install did not finish (exit ${result.status ?? "unknown"}). You can run it yourself: ${how.command} ${how.args.join(" ")}`);
    return result.status ?? 1;
  }
  log(`Updated to SoreQen Code ${latest}.`);
  return 0;
}
