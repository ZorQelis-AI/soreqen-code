import { markDefaultModel, usageFromGateway } from "@sqcode/shared";
import { mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/*
 * The home directory is redirected before the module is loaded, so nothing
 * here can read or overwrite the credentials of whoever runs the tests.
 */
const home = mkdtempSync(join(tmpdir(), "sqc_home_"));
vi.mock("node:os", async (importOriginal) => {
  const os = await importOriginal<typeof import("node:os")>();
  return { ...os, homedir: () => home };
});

const account = await import("./account.js");
const { loadCliConfig, MissingModelError } = await import("./config.js");

const TOKEN = `sqc_${"x".repeat(43)}`;

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

describe("signing in", () => {
  afterEach(() => account.clearAccount());

  it("shows the code, opens the browser, waits through pending and slow_down, and saves the token", async () => {
    const polls = [
      jsonResponse(400, { error: "authorization_pending" }),
      jsonResponse(400, { error: "slow_down" }),
      jsonResponse(200, { access_token: TOKEN, token_type: "bearer", user: { email: "ved@example.com", name: "Ved", plan: "pro" } }),
    ];
    const calls: string[] = [];
    const fetchImpl = (async (url: string) => {
      calls.push(String(url));
      if (String(url).endsWith("/api/code/device")) {
        return jsonResponse(200, {
          device_code: "d".repeat(43),
          user_code: "BCDF-GHJK",
          verification_uri: "https://soreqen.test/code/activate",
          verification_uri_complete: "https://soreqen.test/code/activate?code=BCDF-GHJK",
          expires_in: 600,
          interval: 5,
        });
      }
      return polls.shift()!;
    }) as unknown as typeof fetch;
    const waits: number[] = [];
    let shown = "";
    let opened = "";

    const signedIn = await account.deviceLogin({
      url: "https://soreqen.test",
      fetchImpl,
      sleep: async (ms) => void waits.push(ms),
      onCode: (s) => (shown = s.user_code),
      open: (u) => (opened = u),
    });

    expect(shown).toBe("BCDF-GHJK");
    expect(opened).toBe("https://soreqen.test/code/activate?code=BCDF-GHJK");
    // RFC 8628: slow_down adds five seconds to the interval.
    expect(waits).toEqual([5_000, 5_000, 10_000]);
    expect(signedIn).toMatchObject({ token: TOKEN, email: "ved@example.com", plan: "pro", url: "https://soreqen.test" });
    expect(account.loadAccount("https://soreqen.test")?.token).toBe(TOKEN);
    // A token for one SoreQen is never offered to another.
    expect(account.loadAccount("https://soreqen.com")).toBeNull();
    if (process.platform !== "win32") expect(statSync(account.credentialsPath()).mode & 0o777).toBe(0o600);
  });

  it("stops with a reason when the code is denied", async () => {
    const fetchImpl = (async (url: string) =>
      String(url).endsWith("/device")
        ? jsonResponse(200, { device_code: "d".repeat(43), user_code: "BCDF-GHJK", verification_uri: "u", verification_uri_complete: "u", expires_in: 600, interval: 1 })
        : jsonResponse(400, { error: "access_denied" })) as unknown as typeof fetch;
    await expect(
      account.deviceLogin({ url: "https://soreqen.test", fetchImpl, sleep: async () => undefined, onCode: () => undefined, open: () => undefined }),
    ).rejects.toThrow(/denied/);
    expect(account.loadAccount("https://soreqen.test")).toBeNull();
  });

  it("says it could not reach SoreQen, rather than failing obscurely, when offline", async () => {
    const fetchImpl = (async () => {
      throw new Error("ENOTFOUND");
    }) as unknown as typeof fetch;
    await expect(
      account.deviceLogin({ url: "https://soreqen.test", fetchImpl, onCode: () => undefined, open: () => undefined }),
    ).rejects.toThrow(/Could not reach https:\/\/soreqen.test/);
  });

  it("says SoreQen is limiting sign-ins, not that it is unreachable, on a 429", async () => {
    const fetchImpl = (async () => jsonResponse(429, { error: "slow_down", error_description: "Too many sign-ins started from here." })) as unknown as typeof fetch;
    const login = account.deviceLogin({ url: "https://soreqen.test", fetchImpl, onCode: () => undefined, open: () => undefined });
    await expect(login).rejects.toThrow(/Too many sign-ins/);
    await expect(login).rejects.not.toThrow(/Could not reach/);
  });
});

describe("usage", () => {
  it("shows the credits, then a bar, the credits used and a reset time for each window", () => {
    const now = Date.UTC(2026, 8, 25, 12);
    const at = (inMs: number) => new Date(now + inMs).toISOString();
    const usage = usageFromGateway({
      plan: "plus",
      credits: { plan: { granted: 14_187, remaining: 14_000, period_end: at(20 * 86_400_000) }, purchased: { remaining: 1_600, next_expiry: at(300 * 86_400_000) }, spendable_now: 2_043 },
      windows: {
        five_hour: { used: 221, limit: 443, used_percent: 50, resets_at: at(90 * 60_000) },
        weekly: { used: 187, limit: 3_546, used_percent: 5, resets_at: at(3 * 3_600_000) },
        burst: { active: false, used: 0, limit: 2_978, ends_at: null, available_at: null },
      },
      flex: { balance_usd: 4.5 },
    });
    const lines = account.describeUsage(usage, now);
    expect(lines[1]).toBe("Credits you can spend now: 2,043");
    expect(lines[2]).toContain("14,000 of 14,187");
    expect(lines[3]).toContain("Bought credits: 1,600");
    expect(lines[4]).toBe("  Flex: $4.50");
    expect(lines[5]).toMatch(/^5-hour\s+█{10}░{10}\s+221 \/ 443\s+resets in 2 h$/);
    expect(lines[6]).toContain("resets in 3 h");
    expect(lines[7]).toMatch(/^Month .*187 \/ 14,187\s+resets on /);
    expect(lines.join(" ")).toContain("Burst Day: available");
  });

  it("tells a Free account how to get credits, and that its own keys work", () => {
    const usage = usageFromGateway({ plan: "free", credits: { plan: null, purchased: { remaining: 0, next_expiry: null }, spendable_now: 0 }, windows: null, flex: { balance_usd: 0 } });
    expect(usage.hosted).toBe(true);
    expect(usage.allowed).toBe(false);
    expect(account.describeUsage(usage).join(" ")).toMatch(/Buy credits at soreqen\.com\/credits.*own API keys/);
  });

  it("lists Flow models with their credits, the default marked, and Flex under soreqen/flex/", () => {
    const signedIn = { url: "https://soreqen.test", token: "sqc_x", email: "a@b.c", savedAt: 0 } as Parameters<typeof account.hostedEntries>[0];
    const entries = account.hostedEntries(
      signedIn,
      markDefaultModel({
        default_model: "mimo-v2.6-flash",
        data: [
          { id: "soreqen-auto", name: "SoreQen Auto", auto: true, credits_per_request: 1 },
          { id: "mimo-v2.6-flash", name: "MiMo V2.6 Flash", credits_per_request: 1, context_window: 262_144 },
          { id: "grok-4.7", name: "Grok 4.7", credits_per_request: 88.2, context_window: 2_000_000, price_cliff_tokens: 200_000 },
        ],
      }),
      [{ id: "anthropic/claude-opus-5.5", name: "Claude Opus 5.5", price: { input: 4, output: 20 } }],
    );
    expect(entries.map((e) => e.id)).toEqual(["soreqen/soreqen-auto", "soreqen/mimo-v2.6-flash", "soreqen/grok-4.7", "soreqen/flex/anthropic/claude-opus-5.5"]);
    expect(entries[1]).toMatchObject({ isDefault: true, label: "MiMo V2.6 Flash · \u2248 1 credit a request" });
    // Compacted below the price cliff.
    expect(entries[2]!.contextWindow).toBe(200_000);
    expect(entries[3]).toMatchObject({ baseURL: "https://soreqen.test/api/code/v1/flex", upstreamModel: "anthropic/claude-opus-5.5" });
  });
});

describe("own keys in ~/.soreqen/.env", () => {
  beforeEach(() => writeFileSync(account.userEnvPath(), "# my keys\nOPENAI_API_KEY=old\nOTHER=keep me\n"));

  it("replaces, adds and removes variables, and leaves everything else as it was", () => {
    account.writeUserEnv({ OPENAI_API_KEY: "sk-new", OPENROUTER_API_KEY: "sk-or 1", OTHER: null });
    expect(readFileSync(account.userEnvPath(), "utf8")).toBe('# my keys\nOPENAI_API_KEY=sk-new\nOPENROUTER_API_KEY="sk-or 1"\n');
    expect(process.env["OPENAI_API_KEY"]).toBe("sk-new");
    account.writeUserEnv({ OPENAI_API_KEY: null, OPENROUTER_API_KEY: null });
  });

  it("shows a key only by its ends", () => {
    expect(account.maskKey("sk-proj-abcdefghijklmnop")).toBe("sk-p…mnop");
    expect(account.maskKey("short")).toBe("••••");
  });
});

describe("own-key providers", () => {
  const vars = ["OPENCODE_API_KEY", "MIMO_API_KEY", "ANTHROPIC_API_KEY", "OPENAI_API_KEY", "OPENROUTER_API_KEY", "DEEPSEEK_API_KEY", "OPENAI_BASE_URL", "OPENAI_MODEL", "OPENROUTER_MODEL"];
  beforeEach(() => {
    for (const v of vars) vi.stubEnv(v, "");
  });
  afterEach(() => vi.unstubAllEnvs());

  it("sends an OpenAI key to OpenAI, not to the first provider's URL", () => {
    vi.stubEnv("OPENAI_API_KEY", "sk-openai");
    vi.stubEnv("OPENAI_MODEL", "gpt-6-luna");
    expect(loadCliConfig()).toMatchObject({ provider: "openai", baseURL: "https://api.openai.com/v1", model: "gpt-6-luna" });
  });

  it("asks for a model where a provider has no sensible default", () => {
    vi.stubEnv("OPENROUTER_API_KEY", "sk-or");
    expect(() => loadCliConfig()).toThrow(MissingModelError);
    vi.stubEnv("OPENROUTER_MODEL", "deepseek/deepseek-chat");
    expect(loadCliConfig()).toMatchObject({ provider: "openrouter", baseURL: "https://openrouter.ai/api/v1" });
  });
});
