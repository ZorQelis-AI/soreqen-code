/**
 * SoreQen CLI Configuration Manager
 */

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import dotenv from "dotenv";
import { OWN_KEY_PROVIDERS, modelList, type OwnKeyProvider, type PermissionTier } from "@sqcode/shared";

/*
 * Nothing is loaded at import. A bare `dotenv.config()` stood here and read
 * the working directory's `.env` whole, endpoint addresses included, before
 * `loadEnvFiles` could filter it: the 1 Oct guard below was dead code, and a
 * cloned repository's `OPENAI_BASE_URL` received the person's key (audit,
 * 13 Nov 2026). It also printed dotenv's banner on every start.
 */

/**
 * Every place configuration may live, in priority order.
 *
 * Only the working directory used to be read, so the CLI knew its keys only
 * when started inside the folder that held them. Run from any real project —
 * which is the point of a coding agent — and `SOREQEN_MODELS` and every key
 * vanished: `/model deepseek-4.1-flash` had nothing to switch to, and without
 * an OpenCode key the CLI refused to start at all.
 *
 *   1. `~/.soreqen/.env` — the keys that should follow a person everywhere.
 *   2. `.env` at the root of this SoreQen Code checkout — a local build works
 *      from any directory without copying secrets around.
 *   3. `.env` in the directory the CLI was started in — a project can fill in
 *      what the person has not set, never replace it.
 *
 * The person's own files come first (13 Nov 2026). With the project first, a
 * cloned repository's `OPENAI_API_KEY` silently replaced the person's, and
 * every prompt and file the agent read went to an account the repository's
 * author can read the logs of.
 *
 * dotenv never overwrites a variable that is already set, so reading them in
 * this order makes the first one to define a value the one that counts, and
 * the real environment beats all three.
 */
export function envFileCandidates(cwd = process.cwd()): string[] {
  const here = dirname(fileURLToPath(import.meta.url)); // packages/cli/dist or src
  return [
    join(homedir(), ".soreqen", ".env"),
    resolve(here, "..", "..", "..", ".env"),
    join(cwd, ".env"),
  ];
}

/** Keys the project's `.env` supplied, so the CLI can say where a credential came from. */
export const fromProjectEnv = new Set<string>();

/** Load every configuration file that exists. Called at CLI start, not at
 *  import, so tests that import the loader see only the environment they set. */
export function loadEnvFiles(cwd = process.cwd(), candidates = envFileCandidates(cwd)): string[] {
  const loaded: string[] = [];
  // The project's file is always the last candidate.
  const projectFile = candidates[candidates.length - 1];
  for (const path of candidates) {
    if (!existsSync(path)) continue;
    if (path === projectFile) {
      /*
       * A project may override settings, but not where SoreQen's requests go.
       *
       * The project's `.env` is read first, so a cloned repository carrying
       * `OPENAI_BASE_URL=https://someone-elses-proxy` would have received the
       * keys from `~/.soreqen/.env` with every request (audit, 1 Oct 2026).
       * Endpoint addresses come from the person's own files or environment.
       */
      let parsed: Record<string, string> = {};
      try {
        parsed = dotenv.parse(readFileSync(path));
      } catch {
        continue;
      }
      for (const [key, value] of Object.entries(parsed)) {
        if (/(BASE_URL|API_BASE|ENDPOINT|_URL)$/i.test(key)) continue;
        if (process.env[key] === undefined) {
          process.env[key] = value;
          fromProjectEnv.add(key);
        }
      }
    } else {
      dotenv.config({ path, quiet: true } as dotenv.DotenvConfigOptions);
    }
    loaded.push(path);
  }
  return loaded;
}

export type ProviderId = "opencode" | "openai" | "anthropic" | "openrouter" | "deepseek" | "soreqen" | "mock";

export interface CliConfig {
  apiKey: string;
  baseURL?: string;
  model: string;
  provider: ProviderId;
  permissionTier: PermissionTier;
  workspacePath: string;
}

export { OWN_KEY_PROVIDERS, type OwnKeyProvider } from "@sqcode/shared";

/** Thrown when the CLI has no credential. Distinct so a caller can tell a
 *  configuration problem from a network or provider failure. */
export class MissingApiKeyError extends Error {
  constructor() {
    super(
      "SoreQen Code needs a model to talk to. Either:\n\n" +
        "  soreqen login          sign in with your SoreQen account (Plus and Pro include hosted models)\n" +
        "  soreqen keys set ...   use your own API key\n\n" +
        "or set one of these in a .env file beside your project or in ~/.soreqen/.env:\n" +
        "  OPENCODE_API_KEY, ANTHROPIC_API_KEY, OPENAI_API_KEY, OPENROUTER_API_KEY, DEEPSEEK_API_KEY\n\n" +
        "SoreQen Code will not fall back to a shared key.",
    );
    this.name = "MissingApiKeyError";
  }
}

/** Thrown when a provider's key is set but it has no model to use. */
export class MissingModelError extends Error {
  constructor(provider: OwnKeyProvider) {
    super(`${provider.label} needs a model: set ${provider.modelVars[0]}, or pass --model.`);
    this.name = "MissingModelError";
  }
}

const firstSet = (vars: string[]): string | undefined => {
  for (const v of vars) {
    const value = process.env[v]?.trim();
    if (value) return value;
  }
  return undefined;
};

/** The first provider with a key set, with its key. */
export function ownKeyProvider(): { provider: OwnKeyProvider; apiKey: string } | null {
  for (const provider of OWN_KEY_PROVIDERS) {
    const apiKey = firstSet(provider.keyVars);
    if (apiKey) return { provider, apiKey };
  }
  return null;
}

export function loadCliConfig(overrides?: Partial<CliConfig>): CliConfig {
  /*
   * No default key, deliberately.
   *
   * This used to end in `|| "sk-…"` — a live credential compiled into the
   * package. That is the worst shape the mistake can take, because the CLI
   * then *works* for someone who has configured nothing: every install
   * silently bills one account, nobody sees a missing-key error, and the key
   * ships to every machine that runs `npm i`. A tool that refuses to start is
   * a five-second fix; a tool that quietly spends someone else's money is
   * found on the invoice.
   *
   * The key and the provider are chosen **together**, from one ordered list,
   * and so are its base URL and model.
   */
  const found = ownKeyProvider();
  const byOverride = overrides?.provider ? OWN_KEY_PROVIDERS.find((p) => p.id === overrides.provider) : undefined;
  // A key on the command line with nothing else is taken as the first provider's, as `-k` always was.
  const provider = byOverride ?? found?.provider ?? (overrides?.apiKey ? OWN_KEY_PROVIDERS[0] : undefined);
  const apiKey = overrides?.apiKey || (byOverride ? firstSet(byOverride.keyVars) : found?.apiKey) || "";
  if (!apiKey || !provider) {
    if (overrides?.apiKey && overrides.baseURL && overrides.model) {
      // A fully specified endpoint on the command line needs no provider entry.
      return finish(overrides, overrides.apiKey, overrides.baseURL, overrides.model, "openai");
    }
    throw new MissingApiKeyError();
  }
  const baseURL = overrides?.baseURL || firstSet(provider.baseURLVars) || provider.defaultBaseURL;
  const model = overrides?.model || modelList(firstSet(provider.modelVars))[0] || provider.defaultModel;
  if (!model) throw new MissingModelError(provider);
  return finish(overrides, apiKey, baseURL, model, provider.id);
}

function finish(
  overrides: Partial<CliConfig> | undefined,
  apiKey: string,
  baseURL: string | undefined,
  model: string,
  provider: ProviderId,
): CliConfig {
  const permissionTier =
    (overrides?.permissionTier as PermissionTier) ||
    (process.env.SOREQEN_PERMISSION_TIER as PermissionTier) ||
    "guarded_autonomy";

  /*
   * Resolved, not taken as given.
   *
   * `--workspace .` and `--workspace ../thing` are perfectly reasonable things
   * to type, and an unresolved relative path then travels into the sandbox
   * runner, into checkpoint git commands, and onto the banner — where it reads
   * as "." and tells the user nothing about which directory they are in.
   */
  const workspacePath = resolve(overrides?.workspacePath || process.cwd());

  return {
    apiKey,
    ...(baseURL ? { baseURL } : {}),
    model,
    provider,
    permissionTier,
    workspacePath,
  };
}
