/**
 * Signing the CLI in to a SoreQen account, and what that account allows.
 *
 * `soreqen login` uses OAuth 2.0 device authorization (RFC 8628): the CLI
 * shows a short code and opens soreqen.com, the person approves it there while
 * signed in, and the CLI receives a SoreQen Code token. No password ever
 * passes through the terminal. The token is kept in
 * `~/.soreqen/credentials.json`, readable only by its owner.
 *
 * With a token, the models of the person's plan (Plus, Pro) are reached
 * through `soreqen.com/api/code/v1` — OpenAI-compatible, metered against the
 * plan's 5-hour, weekly and monthly limits. Their own API keys keep working
 * beside it; see `config.ts`.
 */

import { spawn } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, hostname } from "node:os";
import { dirname, join } from "node:path";
import type { ModelEndpoint } from "@sqcode/orchestrator";
import {
  FLEX_PREFIX,
  effectiveWindow,
  flexDetail,
  hostedDetail,
  markDefaultModel,
  usageFromGateway,
  type FlexModel, type GatewayUsage, type HostedModel, type Usage, type WindowUsage } from "@sqcode/shared";

/** Where SoreQen lives. Overridable so a local website can be signed in to during development. */
export function soreqenUrl(env: NodeJS.ProcessEnv = process.env): string {
  return (env["SOREQEN_URL"]?.trim() || "https://soreqen.com").replace(/\/+$/, "");
}

export interface Account {
  token: string;
  email: string;
  name: string | null;
  plan: string;
  /** The SoreQen this token belongs to — a token for a development site is not sent to soreqen.com. */
  url: string;
  savedAt: number;
}

export function credentialsPath(): string {
  return join(homedir(), ".soreqen", "credentials.json");
}

/** The saved account for this SoreQen, or null. Never throws. */
export function loadAccount(url: string = soreqenUrl()): Account | null {
  try {
    const raw = JSON.parse(readFileSync(credentialsPath(), "utf8")) as Partial<Account>;
    if (typeof raw.token !== "string" || !raw.token.startsWith("sqc_") || raw.url !== url) return null;
    return {
      token: raw.token,
      email: String(raw.email ?? ""),
      name: typeof raw.name === "string" ? raw.name : null,
      plan: String(raw.plan ?? "free"),
      url: raw.url,
      savedAt: Number(raw.savedAt ?? 0),
    };
  } catch {
    return null;
  }
}

export function saveAccount(account: Account): void {
  const path = credentialsPath();
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(account, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  // writeFileSync's mode applies only when the file is created; an existing file is tightened too.
  try {
    chmodSync(path, 0o600);
  } catch {
    // Windows: ACLs, not modes. The file is in the user's own profile.
  }
}

export function clearAccount(): void {
  rmSync(credentialsPath(), { force: true });
}

/** Open a URL in the person's browser. Best effort: the URL is always printed too. */
export function openBrowser(url: string): void {
  // Over SSH, in a container, or under test there is no browser to open: the link is printed anyway.
  if (process.env["SOREQEN_NO_BROWSER"] === "1") return;
  try {
    const [cmd, args] =
      process.platform === "win32"
        ? ["rundll32", ["url.dll,FileProtocolHandler", url]]
        : process.platform === "darwin"
          ? ["open", [url]]
          : ["xdg-open", [url]];
    const child = spawn(cmd, args, { detached: true, stdio: "ignore" });
    child.on("error", () => undefined);
    child.unref();
  } catch {
    // No browser: the printed URL is the fallback.
  }
}

export interface DeviceStart {
  device_code: string;
  user_code: string;
  verification_uri: string;
  verification_uri_complete: string;
  expires_in: number;
  interval: number;
}

export class LoginError extends Error {}

/**
 * Sign in: start a device code, show it, wait for approval.
 *
 * `onCode` is told the code and URL to show; the browser is opened for the
 * person. Resolves with the saved account, or rejects with a LoginError that
 * says what happened (denied, expired, offline).
 */
export async function deviceLogin(options: {
  url?: string;
  clientName?: string;
  onCode: (start: DeviceStart) => void;
  open?: (url: string) => void;
  signal?: AbortSignal;
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
}): Promise<Account> {
  const url = options.url ?? soreqenUrl();
  const fetchImpl = options.fetchImpl ?? fetch;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));

  let started: DeviceStart;
  let res: Response;
  try {
    res = await fetchImpl(`${url}/api/code/device`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ client_name: options.clientName ?? `SoreQen Code CLI on ${hostname()}` }),
      ...(options.signal ? { signal: options.signal } : {}),
    });
  } catch (err) {
    throw new LoginError(`Could not reach ${url} to sign in (${err instanceof Error ? err.message : String(err)}).`);
  }
  // Reached, but refused: say why, not that the site was unreachable.
  if (res.status === 429) {
    const body = (await res.json().catch(() => ({}))) as { error_description?: string };
    throw new LoginError(body.error_description ?? "Too many sign-ins started from here. Wait a few minutes and try again.");
  }
  try {
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    started = (await res.json()) as DeviceStart;
  } catch (err) {
    throw new LoginError(`Could not reach ${url} to sign in (${err instanceof Error ? err.message : String(err)}).`);
  }

  options.onCode(started);
  (options.open ?? openBrowser)(started.verification_uri_complete);

  let interval = Math.max(1, started.interval) * 1000;
  const deadline = Date.now() + started.expires_in * 1000;
  while (Date.now() < deadline) {
    await sleep(interval);
    if (options.signal?.aborted) throw new LoginError("Sign-in cancelled.");
    let res: Response;
    try {
      res = await fetchImpl(`${url}/api/code/device/token`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ device_code: started.device_code }),
        ...(options.signal ? { signal: options.signal } : {}),
      });
    } catch {
      continue; // A blip while waiting is not a failure; the code is still valid.
    }
    const body = (await res.json().catch(() => ({}))) as {
      access_token?: string;
      error?: string;
      user?: { email?: string; name?: string | null; plan?: string };
    };
    if (res.ok && body.access_token) {
      const account: Account = {
        token: body.access_token,
        email: body.user?.email ?? "",
        name: body.user?.name ?? null,
        plan: body.user?.plan ?? "free",
        url,
        savedAt: Date.now(),
      };
      saveAccount(account);
      return account;
    }
    if (body.error === "slow_down") interval += 5_000;
    else if (body.error === "access_denied") throw new LoginError("Sign-in was denied on soreqen.com.");
    else if (body.error === "expired_token") throw new LoginError("The sign-in code expired. Run `soreqen login` again.");
  }
  throw new LoginError("The sign-in code expired. Run `soreqen login` again.");
}

/** Sign out: revoke this token on SoreQen, and forget it here either way. */
export async function logout(account: Account, fetchImpl: typeof fetch = fetch): Promise<void> {
  await fetchImpl(`${account.url}/api/code/logout`, {
    method: "POST",
    headers: { authorization: `Bearer ${account.token}` },
    signal: AbortSignal.timeout(10_000),
  }).catch(() => undefined);
  clearAccount();
}

/** The base URL of the hosted models, for an OpenAI-compatible client. */
export function hostedBaseURL(account: Account): string {
  return `${account.url}/api/code/v1`;
}

export type { FlexModel, HostedModel, Usage, WindowUsage } from "@sqcode/shared";

/** Thrown when the token is no longer valid: revoked on soreqen.com, or the account gone. */
export class SignedOutError extends Error {}

async function getJson<T>(account: Account, path: string, fetchImpl: typeof fetch): Promise<T> {
  const res = await fetchImpl(`${hostedBaseURL(account)}/${path}`, {
    headers: { authorization: `Bearer ${account.token}` },
    signal: AbortSignal.timeout(15_000),
  });
  if (res.status === 401) throw new SignedOutError("This device was signed out of SoreQen. Run `soreqen login`.");
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return (await res.json()) as T;
}

/** SoreQen credits: the gateway's figures, in the shape the CLI shows (`@sqcode/shared`). */
export async function fetchUsage(account: Account, fetchImpl: typeof fetch = fetch): Promise<Usage> {
  return usageFromGateway(await getJson<GatewayUsage>(account, "usage", fetchImpl));
}

/** The Flow models, SoreQen Auto first, each with its credits per request. */
export async function fetchHostedModels(account: Account, fetchImpl: typeof fetch = fetch): Promise<HostedModel[]> {
  return markDefaultModel(await getJson<{ data?: HostedModel[]; default_model?: string | null }>(account, "models", fetchImpl));
}

/** Flex's models (or, with `query`, those matching it), and any Flow model the search named. */
export async function fetchFlexModels(
  account: Account,
  query = "",
  fetchImpl: typeof fetch = fetch,
): Promise<{ models: FlexModel[]; flow: { id: string; name: string; message: string }[] }> {
  try {
    const body = await getJson<{ data?: FlexModel[]; flow_models?: { id: string; name: string; message: string }[] }>(
      account,
      `flex/models${query ? `?q=${encodeURIComponent(query)}` : ""}`,
      fetchImpl,
    );
    return { models: body.data ?? [], flow: body.flow_models ?? [] };
  } catch (err) {
    if (err instanceof SignedOutError) throw err;
    return { models: [], flow: [] };
  }
}

/** Switch Burst Day on: 84% of the weekly limit for 24 hours, once a week. */
export async function startBurst(account: Account, fetchImpl: typeof fetch = fetch): Promise<string> {
  const res = await fetchImpl(`${hostedBaseURL(account)}/burst`, {
    method: "POST",
    headers: { authorization: `Bearer ${account.token}`, "content-type": "application/json" },
    body: "{}",
    signal: AbortSignal.timeout(15_000),
  });
  if (res.status === 401) throw new SignedOutError("This device was signed out of SoreQen. Run `soreqen login`.");
  const body = (await res.json().catch(() => ({}))) as { ends_at?: string; error?: { message?: string } };
  if (!res.ok || !body.ends_at) throw new Error(body.error?.message ?? "Burst Day could not be switched on.");
  return `Burst Day is on until ${new Date(body.ends_at).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" })}: up to 84% of your weekly limit, with no 5-hour limit.`;
}

/** How a hosted model appears among the others: its own id space, so it never collides with an own-key model. */
export const HOSTED_PREFIX = "soreqen/";

/**
 * The catalogue entries for SoreQen's models: Flow (credits, the cheap default
 * marked) and Flex (dollars, at the provider's price). The cost goes in the
 * label, which is what `/model` lists; a Flow model with a price cliff is
 * compacted below it.
 */
export function hostedEntries(account: Account, models: HostedModel[], flex: FlexModel[]): ModelEndpoint[] {
  const base = hostedBaseURL(account);
  const flow = models.map((m): ModelEndpoint => {
    const detail = hostedDetail(m);
    const window = effectiveWindow(m.context_window, m.price_cliff_tokens);
    return {
      id: `${HOSTED_PREFIX}${m.id}`,
      label: detail ? `${m.name} · ${detail}` : `${m.name} · SoreQen`,
      upstreamModel: m.id,
      baseURL: base,
      apiKey: account.token,
      ...(window ? { contextWindow: window } : {}),
      ...(detail ? { detail } : {}),
      ...(m.default ? { isDefault: true } : {}),
    };
  });
  const paid = flex.map((m): ModelEndpoint => {
    const detail = flexDetail(m.price);
    return {
      id: `${FLEX_PREFIX}${m.id}`,
      label: `${m.name} · Flex${detail ? ` ${detail}` : ""}`,
      upstreamModel: m.id,
      baseURL: `${base}/flex`,
      apiKey: account.token,
      ...(m.context_window ? { contextWindow: m.context_window } : {}),
      ...(detail ? { detail } : {}),
    };
  });
  return [...flow, ...paid];
}

const n = (v: number) => v.toLocaleString("en-US", { maximumFractionDigits: 0 });

/** Credits, then a bar and a sentence per window, for `/usage` and `soreqen usage`. */
export function describeUsage(usage: Usage, now: number = Date.now()): string[] {
  const c = usage.credits;
  const lines = [`Plan: ${usage.plan}`];
  if (c) {
    lines.push(`Credits you can spend now: ${n(c.spendable_now)}`);
    if (c.plan) lines.push(`  Plan credits: ${n(c.plan.remaining)} of ${n(c.plan.granted)}, renew ${relative(Date.parse(c.plan.period_end), now)}`);
    lines.push(`  Bought credits: ${n(c.purchased.remaining)}${c.purchased.next_expiry ? ` (next expiry ${relative(Date.parse(c.purchased.next_expiry), now)})` : ""}`);
    lines.push(`  Flex: $${c.flex_usd.toFixed(2)}`);
  }
  if (!usage.windows) {
    lines.push("Plus, Pro and Elite include credits every month. Buy credits at soreqen.com/credits, or use your own API keys: soreqen keys set <provider>.");
    return lines;
  }
  const rows: [string, WindowUsage][] = [
    ["5-hour ", usage.windows.five_hour],
    ["Weekly ", usage.windows.weekly],
    ["Month  ", usage.windows.monthly],
  ];
  for (const [label, w] of rows) {
    const filled = Math.round(w.used_percent / 5);
    const bar = `${"█".repeat(filled)}${"░".repeat(20 - filled)}`;
    const amount = w.used !== undefined && w.limit !== undefined ? `${n(w.used)} / ${n(w.limit)}` : `${w.used_percent}%`;
    lines.push(`${label}  ${bar} ${amount.padStart(15)}   resets ${relative(Date.parse(w.resets_at), now)}`);
  }
  const burst = c?.burst;
  if (burst?.active) lines.push(`Burst Day: on, ${n(burst.used)} of ${n(burst.limit)} used, ends ${relative(Date.parse(burst.ends_at ?? ""), now)}`);
  else if (burst && (!burst.available_at || Date.parse(burst.available_at) <= now)) lines.push("Burst Day: available (soreqen burst): 84% of your weekly limit in 24 hours, once a week.");
  else if (burst?.available_at) lines.push(`Burst Day: available again ${relative(Date.parse(burst.available_at), now)}`);
  if (!usage.allowed && usage.message) lines.push(usage.message);
  return lines;
}

function relative(at: number, now: number): string {
  const minutes = Math.max(0, Math.round((at - now) / 60_000));
  if (minutes < 60) return `in ${minutes} min`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `in ${hours} h`;
  return `on ${new Date(at).toLocaleDateString(undefined, { day: "numeric", month: "short" })}`;
}

// ---------------------------------------------------------------------------
// Own keys: ~/.soreqen/.env
// ---------------------------------------------------------------------------

export function userEnvPath(): string {
  return join(homedir(), ".soreqen", ".env");
}

/**
 * Set (or with `value` null, remove) variables in `~/.soreqen/.env`, keeping
 * every other line — comments included — as it was.
 */
export function writeUserEnv(values: Record<string, string | null>): void {
  const path = userEnvPath();
  const lines = existsSync(path) ? readFileSync(path, "utf8").split(/\r?\n/) : [];
  const pending = new Map(Object.entries(values));
  const out: string[] = [];
  for (const line of lines) {
    const name = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/.exec(line)?.[1];
    if (name && pending.has(name)) {
      const value = pending.get(name);
      pending.delete(name);
      if (value !== null && value !== undefined) out.push(`${name}=${quote(value)}`);
      continue;
    }
    out.push(line);
  }
  while (out.length > 0 && out[out.length - 1] === "") out.pop();
  for (const [name, value] of pending) if (value !== null) out.push(`${name}=${quote(value)}`);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${out.join("\n")}\n`, { encoding: "utf8", mode: 0o600 });
  try {
    chmodSync(path, 0o600);
  } catch {
    // Windows.
  }
  // The running process sees the change at once.
  for (const [name, value] of Object.entries(values)) {
    if (value === null) delete process.env[name];
    else process.env[name] = value;
  }
}

function quote(value: string): string {
  return /^[\w@%+=:,./-]*$/.test(value) ? value : JSON.stringify(value);
}

/** A key shown safely: its first and last four characters. */
export function maskKey(key: string): string {
  return key.length <= 12 ? "••••" : `${key.slice(0, 4)}…${key.slice(-4)}`;
}
