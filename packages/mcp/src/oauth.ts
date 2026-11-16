/**
 * Signing in to an MCP server in the person's browser (OAuth), and keeping
 * what that sign-in gave.
 *
 * Most hosted MCP servers (Linear, Notion, Canva, Figma, Vercel, Stripe and
 * many more) answer an unauthenticated request with 401 and the address of
 * their authorization server, which lets any client register itself and send
 * the person to a sign-in page (RFC 9728, RFC 7591, PKCE). The MCP SDK runs
 * that dance; this file is the part the SDK leaves to the client: where the
 * registration, the tokens and the PKCE verifier are kept, and what "send the
 * person to the sign-in page" means here.
 *
 * Kept per server in `~/.soreqen/mcp-auth/<server>.json`, readable by the
 * person only. Never in `mcp.json`, which is a file people copy and share.
 *
 * Two kinds of provider from one class:
 *
 *   - interactive (a host is given): the sign-in page opens in the person's
 *     browser and comes back to the runtime's callback address. Used when the
 *     person presses Connect.
 *   - quiet (no host): used while connecting for a turn. Saved tokens are used
 *     and refreshed; when a fresh sign-in is needed it does not open a browser
 *     in the middle of someone's work, it says the server needs signing in.
 */

import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { auth, type OAuthClientProvider } from "@modelcontextprotocol/sdk/client/auth.js";
import type {
  OAuthClientInformationMixed,
  OAuthClientMetadata,
  OAuthTokens,
} from "@modelcontextprotocol/sdk/shared/auth.js";

/** What an interactive sign-in needs from the host. */
export interface OAuthHost {
  /** Where the authorization server sends the browser back to. */
  redirectUrl: string;
  /** Open the sign-in page in the person's browser. */
  open: (url: string) => void;
}

/** A client the person registered with the provider themselves (Google, Slack and others that allow no self-registration). */
export interface StaticOAuthClient {
  client_id: string;
  client_secret?: string;
}

interface Stored {
  client?: OAuthClientInformationMixed;
  /** The redirect address the client above was registered with. */
  clientRedirect?: string;
  tokens?: OAuthTokens;
  /** When the tokens were saved, for "connected since". */
  savedAt?: number;
  verifier?: string;
  state?: string;
  /** Set while the person is signing in, cleared when it completes. */
  pendingSince?: number;
  /** A client the person registered with the provider themselves. */
  ownClient?: StaticOAuthClient;
}

/** Thrown by a quiet provider instead of opening a browser. */
export class SignInRequired extends Error {
  constructor(readonly server: string) {
    super(`Sign in to ${server} to connect it (Settings > Connectors).`);
    this.name = "SignInRequired";
  }
}

/**
 * The redirect a quiet provider names when it holds tokens but no record of
 * the address its client was registered with (a sign-in saved before that
 * was kept). Never visited: a quiet provider refreshes, and any sign-in it
 * would need stops at `redirectToAuthorization`.
 */
const QUIET_REDIRECT = "http://127.0.0.1/desktop/connectors/callback";

export class StoredOAuth implements OAuthClientProvider {
  private readonly file: string;
  /** The tokens this provider last handed to the SDK, by refresh (or access) token; see `invalidateCredentials`. */
  private served: string | undefined;

  constructor(
    private readonly dir: string,
    private readonly server: string,
    private readonly host?: OAuthHost,
    private readonly staticClient?: StaticOAuthClient,
  ) {
    this.file = join(dir, `${server}.json`);
  }

  private read(): Stored {
    try {
      return JSON.parse(readFileSync(this.file, "utf8")) as Stored;
    } catch {
      return {};
    }
  }

  private write(patch: Partial<Stored>): void {
    mkdirSync(this.dir, { recursive: true });
    const next = { ...this.read(), ...patch };
    for (const key of Object.keys(next) as (keyof Stored)[]) if (next[key] === undefined) delete next[key];
    writeFileSync(`${this.file}.tmp`, JSON.stringify(next, null, 2), { encoding: "utf8", mode: 0o600 });
    renameSync(`${this.file}.tmp`, this.file);
  }

  /**
   * The quiet provider answers with the address its client was registered
   * for. Without one, the SDK (1.30) takes a provider for a machine client
   * (client_credentials): it never tried the refresh token, so every
   * connection after the access token expired failed, which read as the
   * connector signing itself out after a few hours (15 Oct 2026). With one,
   * it refreshes; and a sign-in it cannot do quietly still stops at
   * `redirectToAuthorization`.
   */
  get redirectUrl(): string | undefined {
    return this.host?.redirectUrl ?? this.read().clientRedirect ?? (this.read().tokens ? QUIET_REDIRECT : undefined);
  }

  get clientMetadata(): OAuthClientMetadata {
    return {
      client_name: "SoreQen Code",
      client_uri: "https://soreqen.com",
      redirect_uris: this.redirectUrl ? [this.redirectUrl] : [],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: (this.staticClient ?? this.read().ownClient)?.client_secret ? "client_secret_post" : "none",
    };
  }

  state(): string {
    const state = randomBytes(18).toString("hex");
    this.write({ state });
    return state;
  }

  clientInformation(): OAuthClientInformationMixed | undefined {
    if (this.staticClient) return this.staticClient;
    const stored = this.read();
    if (stored.ownClient) return stored.ownClient;
    if (!stored.client) return undefined;
    // Registered for a redirect this launch does not listen on (the port changes): register again to sign in.
    if (this.host && stored.clientRedirect && stored.clientRedirect !== this.host.redirectUrl) return undefined;
    return stored.client;
  }

  saveClientInformation(client: OAuthClientInformationMixed): void {
    this.write({ client, ...(this.host ? { clientRedirect: this.host.redirectUrl } : {}) });
  }

  tokens(): OAuthTokens | undefined {
    const tokens = this.read().tokens;
    this.served = tokens?.refresh_token ?? tokens?.access_token;
    return tokens;
  }

  saveTokens(tokens: OAuthTokens): void {
    this.write({ tokens, savedAt: Date.now(), pendingSince: undefined, state: undefined, verifier: undefined });
  }

  redirectToAuthorization(url: URL): void {
    if (!this.host) throw new SignInRequired(this.server);
    this.write({ pendingSince: Date.now() });
    this.host.open(url.toString());
  }

  saveCodeVerifier(verifier: string): void {
    this.write({ verifier });
  }

  codeVerifier(): string {
    const verifier = this.read().verifier;
    if (!verifier) throw new Error(`No sign-in to ${this.server} is in progress.`);
    return verifier;
  }

  /**
   * What the SDK asks to forget when a refresh or a sign-in is refused.
   *
   * Only the tokens it was given. The desktop app connects once per open
   * folder, so when an access token expires several connections refresh at
   * once; a provider that rotates refresh tokens accepts the first and
   * refuses the rest, and each refused one used to delete the stored tokens,
   * including the fresh ones the first had just saved: signed out, by its
   * own success. Tokens that changed since they were handed out are someone
   * else's newer sign-in, and stay. And a refused client or refresh is never
   * reason to forget everything: the person's sign-in record is only the
   * tokens and the registration, cleared separately.
   */
  invalidateCredentials(scope: "all" | "client" | "tokens" | "verifier" | "discovery"): void {
    const stored = this.read();
    const current = stored.tokens?.refresh_token ?? stored.tokens?.access_token;
    const stale = this.served === undefined || current === this.served;
    if (scope === "all") {
      this.write({ client: undefined, clientRedirect: undefined, verifier: undefined, ...(stale ? { tokens: undefined } : {}) });
    } else if (scope === "client") this.write({ client: undefined, clientRedirect: undefined });
    else if (scope === "tokens") {
      if (stale) this.write({ tokens: undefined });
    } else if (scope === "verifier") this.write({ verifier: undefined });
  }

  /** Use a client the person registered with the provider themselves, from now on. */
  setOwnClient(client: StaticOAuthClient | null): void {
    this.write({ ownClient: client ?? undefined, tokens: undefined });
  }

  /** Whether this server has been signed in to (it may still need a refresh). */
  signedIn(): boolean {
    return Boolean(this.read().tokens?.access_token);
  }

  /** When the current sign-in was saved. */
  since(): number | undefined {
    return this.read().savedAt;
  }

  forget(): void {
    rmSync(this.file, { force: true });
  }
}

/** The server a sign-in's `state` belongs to, so the callback knows what it finishes. */
export function serverForState(dir: string, state: string): string | null {
  if (!state || !existsSync(dir)) return null;
  for (const name of readdirSync(dir)) {
    if (!name.endsWith(".json")) continue;
    try {
      const stored = JSON.parse(readFileSync(join(dir, name), "utf8")) as Stored;
      if (stored.state && stored.state === state) return name.slice(0, -5);
    } catch {
      // Not ours, or torn.
    }
  }
  return null;
}

/**
 * Begin signing in to a server: "connected" when saved tokens (or a refresh)
 * are enough, "redirect" when the sign-in page has been opened in the browser.
 */
export async function startSignIn(o: { dir: string; server: string; url: string; host: OAuthHost }): Promise<"connected" | "redirect"> {
  const provider = new StoredOAuth(o.dir, o.server, o.host);
  const result = await auth(provider, { serverUrl: o.url });
  return result === "AUTHORIZED" ? "connected" : "redirect";
}

/** The browser came back with a code: exchange it for tokens. Returns the server it was for. */
export async function finishSignIn(o: {
  dir: string;
  state: string;
  code: string;
  host: OAuthHost;
  urlOf: (server: string) => string | undefined;
}): Promise<string> {
  const server = serverForState(o.dir, o.state);
  if (!server) throw new Error("This sign-in is not one SoreQen Code started, or it has already finished.");
  const url = o.urlOf(server);
  if (!url) throw new Error(`${server} is no longer set up.`);
  const result = await auth(new StoredOAuth(o.dir, server, o.host), { serverUrl: url, authorizationCode: o.code });
  if (result !== "AUTHORIZED") throw new Error(`${server} did not accept the sign-in.`);
  return server;
}
