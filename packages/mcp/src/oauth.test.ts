/**
 * Browser sign-in to an MCP server, end to end, against a local mock of an
 * OAuth-protected server: discovery, dynamic client registration, PKCE, the
 * callback, and a turn's connection using the saved token. No browser opens:
 * the "sign-in page" is followed by hand, as the browser would.
 */

import { createServer, type IncomingMessage, type Server } from "node:http";
import { createHash, randomBytes } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { McpHub } from "./hub.js";
import { StoredOAuth, finishSignIn, startSignIn } from "./oauth.js";
import type { McpServerEntry } from "./config.js";

const read = (req: IncomingMessage): Promise<string> =>
  new Promise((r) => {
    let d = "";
    req.on("data", (c: Buffer) => (d += c.toString()));
    req.on("end", () => r(d));
  });

let server: Server;
let origin = "";
const codes = new Map<string, string>();
const tokens = new Set<string>();
const refreshTokens = new Set<string>();
let refreshes = 0;

beforeAll(async () => {
  server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", origin);
    const json = (code: number, obj: unknown): void => {
      res.writeHead(code, { "content-type": "application/json" });
      res.end(JSON.stringify(obj));
    };
    if (url.pathname.startsWith("/.well-known/oauth-protected-resource")) return json(200, { resource: `${origin}/mcp`, authorization_servers: [origin] });
    if (url.pathname === "/.well-known/oauth-authorization-server") {
      return json(200, {
        issuer: origin,
        authorization_endpoint: `${origin}/authorize`,
        token_endpoint: `${origin}/token`,
        registration_endpoint: `${origin}/register`,
        response_types_supported: ["code"],
        code_challenge_methods_supported: ["S256"],
        token_endpoint_auth_methods_supported: ["none"],
      });
    }
    if (url.pathname === "/register") return json(201, { ...(JSON.parse(await read(req)) as object), client_id: "client_1" });
    if (url.pathname === "/authorize") {
      const code = randomBytes(8).toString("hex");
      codes.set(code, url.searchParams.get("code_challenge") ?? "");
      const back = new URL(url.searchParams.get("redirect_uri")!);
      back.searchParams.set("code", code);
      back.searchParams.set("state", url.searchParams.get("state") ?? "");
      res.writeHead(302, { location: back.toString() });
      return res.end();
    }
    if (url.pathname === "/token") {
      const form = new URLSearchParams(await read(req));
      if (form.get("grant_type") === "refresh_token") {
        // Rotating, as Hostinger's are: a refresh token works once.
        if (!refreshTokens.delete(form.get("refresh_token") ?? "")) return json(400, { error: "invalid_grant" });
        refreshes++;
      } else {
        const ok = createHash("sha256").update(form.get("code_verifier") ?? "").digest("base64url") === codes.get(form.get("code") ?? "");
        if (!ok) return json(400, { error: "invalid_grant" });
      }
      const token = randomBytes(12).toString("hex");
      const refresh = randomBytes(12).toString("hex");
      tokens.add(token);
      refreshTokens.add(refresh);
      return json(200, { access_token: token, token_type: "Bearer", expires_in: 3600, refresh_token: refresh });
    }
    if (url.pathname === "/mcp") {
      if (!tokens.has((req.headers.authorization ?? "").replace(/^Bearer /, ""))) {
        res.writeHead(401, { "www-authenticate": `Bearer resource_metadata="${origin}/.well-known/oauth-protected-resource/mcp"` });
        return res.end();
      }
      const mcp = new McpServer({ name: "mock", version: "1.0.0" });
      mcp.tool("hello", "Says hello", async () => ({ content: [{ type: "text" as const, text: "hello from a signed-in server" }] }));
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
      await mcp.connect(transport);
      const raw = await read(req);
      return transport.handleRequest(req, res, raw ? JSON.parse(raw) : undefined);
    }
    res.writeHead(404);
    res.end();
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const address = server.address();
  origin = `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}`;
});

afterAll(() => {
  server.close();
});

describe("signing in to an MCP server in the browser", () => {
  it("says 'sign in' before, signs in through the callback, refuses a replay, then connects", async () => {
    const dir = mkdtempSync(join(tmpdir(), "sq-oauth-"));
    let opened: string | null = null;
    const host = { redirectUrl: "http://127.0.0.1:3917/desktop/connectors/callback", open: (u: string) => void (opened = u) };
    const entry: McpServerEntry = { name: "mock", origin: "user", file: "mcp.json", config: { type: "http", url: `${origin}/mcp`, oauth: true } };

    // A turn before signing in: no browser, no registration, just "sign in".
    let hub = await McpHub.connect([entry], { oauthDir: dir, connectTimeoutMs: 5000 });
    expect(hub.status()[0]!.state).toBe("signin");
    expect(opened).toBeNull();
    await hub.close();

    // Connect: the sign-in page opens.
    expect(await startSignIn({ dir, server: "mock", url: `${origin}/mcp`, host })).toBe("redirect");
    expect(opened).toMatch(/\/authorize\?.*code_challenge=/);

    // The browser comes back to the callback.
    const back = new URL((await fetch(opened!, { redirect: "manual" })).headers.get("location")!);
    const finish = { dir, state: back.searchParams.get("state")!, code: back.searchParams.get("code")!, host, urlOf: () => `${origin}/mcp` };
    expect(await finishSignIn(finish)).toBe("mock");
    expect(new StoredOAuth(dir, "mock").signedIn()).toBe(true);
    await expect(finishSignIn(finish)).rejects.toThrow(/not one SoreQen Code started/);

    // A turn now connects with the saved token and calls the server's tool.
    hub = await McpHub.connect([entry], { oauthDir: dir, connectTimeoutMs: 5000 });
    expect(hub.status()[0]!.state).toBe("connected");
    const out = await hub.call(hub.definitions()[0]!.name, {});
    expect(out.success).toBe(true);
    expect(JSON.stringify(out.data)).toContain("hello from a signed-in server");
    await hub.close();
  });

  it("refreshes an expired sign-in by itself while connecting for a turn (15 Oct 2026)", async () => {
    /*
     * Seen as connectors "signing out after some time": the provider used
     * while connecting had no redirect address, so the SDK took it for a
     * machine client and never used the refresh token. Every connection
     * after the access token expired asked the person to sign in again.
     */
    const dir = mkdtempSync(join(tmpdir(), "sq-oauth-refresh-"));
    let opened: string | null = null;
    const host = { redirectUrl: "http://127.0.0.1:3918/desktop/connectors/callback", open: (u: string) => void (opened = u) };
    const entry: McpServerEntry = { name: "mock", origin: "user", file: "mcp.json", config: { type: "http", url: `${origin}/mcp`, oauth: true } };
    expect(await startSignIn({ dir, server: "mock", url: `${origin}/mcp`, host })).toBe("redirect");
    const back = new URL((await fetch(opened!, { redirect: "manual" })).headers.get("location")!);
    await finishSignIn({ dir, state: back.searchParams.get("state")!, code: back.searchParams.get("code")!, host, urlOf: () => `${origin}/mcp` });

    // Hours later: every access token has expired.
    tokens.clear();
    const before = refreshes;
    const hub = await McpHub.connect([entry], { oauthDir: dir, connectTimeoutMs: 5000 });
    expect(hub.status()[0]!.state).toBe("connected");
    expect(refreshes).toBe(before + 1);
    expect((await hub.call(hub.definitions()[0]!.name, {})).success).toBe(true);
    await hub.close();
  });

  it("does not let a refused refresh delete the fresh tokens another connection just saved", () => {
    const dir = mkdtempSync(join(tmpdir(), "sq-oauth-race-"));
    const first = new StoredOAuth(dir, "mock");
    const second = new StoredOAuth(dir, "mock");
    first.saveTokens({ access_token: "a1", token_type: "Bearer", refresh_token: "r1" });
    // Both read the same tokens; the first refreshes, and the provider rotates r1 away.
    second.tokens();
    first.tokens();
    first.saveTokens({ access_token: "a2", token_type: "Bearer", refresh_token: "r2" });
    // The second's refresh with r1 is refused: what it forgets is r1, which is already gone.
    second.invalidateCredentials("tokens");
    expect(new StoredOAuth(dir, "mock").tokens()?.refresh_token).toBe("r2");
    // Refused with the tokens that are still stored, they are forgotten.
    const third = new StoredOAuth(dir, "mock");
    third.tokens();
    third.invalidateCredentials("tokens");
    expect(new StoredOAuth(dir, "mock").signedIn()).toBe(false);
  });
});
