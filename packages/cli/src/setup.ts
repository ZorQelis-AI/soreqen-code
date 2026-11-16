/**
 * First run: how will SoreQen Code reach a model?
 *
 * Two answers, and the CLI asks rather than guessing:
 *
 *   1. Sign in with a SoreQen account. Plus and Pro include hosted models,
 *      within the plan's limits; a Free account signs in and then adds a key.
 *   2. Bring your own API key: pick a provider, paste the key (not echoed),
 *      and pick a model — from the provider's own list where it has one.
 *
 * Runs when nothing is configured and there is a person at the terminal, and
 * again on `soreqen setup`. Keys go to `~/.soreqen/.env`, the default model to
 * `~/.soreqen/config.json`; both readable only by their owner.
 */

import { createInterface } from "node:readline";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import chalk from "chalk";
import {
  HOSTED_PREFIX,
  LoginError,
  deviceLogin,
  describeUsage,
  fetchHostedModels,
  fetchUsage,
  writeUserEnv,
  type Account,
} from "./account.js";
import { OWN_KEY_PROVIDERS, type OwnKeyProvider } from "./config.js";

export function userConfigPath(): string {
  return join(homedir(), ".soreqen", "config.json");
}

export interface UserConfig {
  /** The model a new session starts on, unless the session or `--model` says otherwise. */
  model?: string;
  /** Skills switched off, by name. Shared with the desktop app. */
  disabledSkills?: string[];
}

export function loadUserConfig(): UserConfig {
  try {
    const raw = JSON.parse(readFileSync(userConfigPath(), "utf8")) as UserConfig;
    return raw && typeof raw === "object" ? raw : {};
  } catch {
    return {};
  }
}

export function saveUserConfig(config: UserConfig): void {
  mkdirSync(dirname(userConfigPath()), { recursive: true });
  writeFileSync(userConfigPath(), `${JSON.stringify({ ...loadUserConfig(), ...config }, null, 2)}\n`, "utf8");
}

/** A line of input, optionally not echoed (for keys). */
export function ask(question: string, options: { hidden?: boolean } = {}): Promise<string> {
  return new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    if (options.hidden) {
      // Echo nothing but the prompt: the key must not sit in the scrollback.
      const out = rl as unknown as { _writeToOutput: (s: string) => void; output: NodeJS.WriteStream };
      out._writeToOutput = (s: string) => {
        if (s.includes(question)) out.output.write(s);
        else if (s === "\r\n" || s === "\n") out.output.write(s);
      };
    }
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

async function choose<T>(title: string, items: T[], label: (item: T) => string, fallback = 0): Promise<T> {
  console.log(`\n  ${chalk.bold(title)}`);
  items.forEach((item, i) => console.log(`   ${chalk.cyan(String(i + 1).padStart(2))}  ${label(item)}`));
  for (;;) {
    const answer = await ask(`  ${chalk.dim(`Choose 1-${items.length} [${fallback + 1}]:`)} `);
    if (!answer) return items[fallback]!;
    const n = Number(answer);
    if (Number.isInteger(n) && n >= 1 && n <= items.length) return items[n - 1]!;
  }
}

/** Models a provider lists, for the picker. Empty when it has no listing or the key is refused. */
export async function listProviderModels(provider: OwnKeyProvider, apiKey: string, baseURL?: string): Promise<{ ok: boolean; models: string[] }> {
  try {
    const url =
      provider.id === "anthropic" ? "https://api.anthropic.com/v1/models" : `${(baseURL ?? provider.defaultBaseURL ?? "").replace(/\/$/, "")}/models`;
    const res = await fetch(url, {
      headers:
        provider.id === "anthropic"
          ? { "x-api-key": apiKey, "anthropic-version": "2023-06-01" }
          : { authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(15_000),
    });
    if (res.status === 401 || res.status === 403) return { ok: false, models: [] };
    if (!res.ok) return { ok: true, models: [] };
    const body = (await res.json()) as { data?: { id?: string }[] };
    return { ok: true, models: (body.data ?? []).map((m) => String(m.id ?? "")).filter(Boolean).sort() };
  } catch {
    return { ok: true, models: [] };
  }
}

async function pickModel(models: string[], suggested?: string): Promise<string> {
  if (models.length === 0) {
    for (;;) {
      const typed = await ask(`  ${chalk.dim(`Model name${suggested ? ` [${suggested}]` : ""}:`)} `);
      if (typed || suggested) return typed || suggested!;
    }
  }
  if (models.length <= 25) {
    const at = suggested ? Math.max(0, models.indexOf(suggested)) : 0;
    return choose("Which model?", models, (m) => m, at);
  }
  console.log(`\n  ${models.length} models are available. Type part of a name to narrow the list.`);
  for (;;) {
    const filter = (await ask(`  ${chalk.dim("Search:")} `)).toLowerCase();
    const hits = models.filter((m) => m.toLowerCase().includes(filter)).slice(0, 25);
    if (hits.length === 1) return hits[0]!;
    if (hits.length > 1) return choose("Which model?", hits, (m) => m);
    console.log(chalk.yellow("  Nothing matched."));
  }
}

/** The own-key half of setup. Returns the model id chosen. */
export async function setupOwnKey(): Promise<string> {
  const provider = await choose("Which provider is your key for?", OWN_KEY_PROVIDERS, (p) => `${p.label.padEnd(20)} ${chalk.dim(p.keyUrl)}`);
  let apiKey = "";
  let listed: { ok: boolean; models: string[] } = { ok: true, models: [] };
  for (;;) {
    apiKey = await ask(`\n  ${provider.label} API key ${chalk.dim("(not shown as you type)")}: `, { hidden: true });
    if (!apiKey) continue;
    process.stdout.write(chalk.dim("  Checking the key… "));
    listed = await listProviderModels(provider, apiKey);
    if (listed.ok) {
      console.log(chalk.green("ok"));
      break;
    }
    console.log(chalk.red(`${provider.label} refused that key. Try again.`));
  }
  const model = await pickModel(listed.models, provider.defaultModel);
  writeUserEnv({ [provider.keyVars[0]!]: apiKey, [provider.modelVars[0]!]: model });
  saveUserConfig({ model });
  console.log(chalk.green(`\n  ✔ Saved. SoreQen Code will use ${provider.label} · ${model}.`));
  console.log(chalk.dim(`    Keys live in ~/.soreqen/.env. Change them any time with \`soreqen setup\`.\n`));
  return model;
}

/** The sign-in half of setup. Returns the account, and the hosted model chosen when the plan has them. */
export async function setupSignIn(): Promise<{ account: Account; model?: string } | null> {
  let account: Account;
  try {
    account = await deviceLogin({
      onCode: (start) => {
        console.log(`\n  Opening ${chalk.underline(start.verification_uri)} in your browser.`);
        console.log(`  Check that it shows this code, then approve:  ${chalk.bold.cyan(start.user_code)}\n`);
        console.log(chalk.dim(`  (If the browser did not open, go to ${start.verification_uri_complete})`));
        console.log(chalk.dim("  Waiting for approval…"));
      },
    });
  } catch (err) {
    console.log(chalk.red(`\n  ${err instanceof LoginError ? err.message : String(err)}\n`));
    return null;
  }
  console.log(chalk.green(`\n  ✔ Signed in as ${account.email || account.name || "your SoreQen account"}.`));
  try {
    const usage = await fetchUsage(account);
    if (!usage.hosted) {
      for (const line of describeUsage(usage)) console.log(`  ${line}`);
      return { account };
    }
    const models = await fetchHostedModels(account);
    if (models.length === 0) return { account };
    const picked = await choose("Which SoreQen model?", models, (m) =>
      `${m.name.padEnd(28)} ${chalk.dim(m.context_window ? `${Math.round(m.context_window / 1000)}k context` : "")}`,
    );
    const model = `${HOSTED_PREFIX}${picked.id}`;
    saveUserConfig({ model });
    return { account, model };
  } catch {
    return { account };
  }
}

/**
 * The whole first-run conversation. Resolves once something usable is
 * configured, or rejects if the person gives up (Ctrl-C ends the process anyway).
 */
export async function runSetup(): Promise<{ account: Account | null; model?: string }> {
  console.log(`\n  ${chalk.bold("Welcome to SoreQen Code.")} How should it reach a model?`);
  const way = await choose(
    "Choose one",
    [
      { id: "signin", label: `Sign in with SoreQen    ${chalk.dim("Plus and Pro include hosted models")}` },
      { id: "key", label: `Use my own API key       ${chalk.dim("OpenAI, Anthropic, OpenRouter, DeepSeek, OpenCode")}` },
    ],
    (o) => o.label,
  );
  if (way.id === "signin") {
    const signedIn = await setupSignIn();
    if (signedIn?.model) return { account: signedIn.account, model: signedIn.model };
    console.log(`\n  ${chalk.dim("No hosted models on this account, so add your own key to continue.")}`);
    return { account: signedIn?.account ?? null, model: await setupOwnKey() };
  }
  return { account: null, model: await setupOwnKey() };
}
