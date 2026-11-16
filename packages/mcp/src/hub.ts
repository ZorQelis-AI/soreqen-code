/**
 * Connected MCP servers, offered to the agent as tools.
 *
 * Implements the orchestrator's `ExternalTools`, so the agent loop sees
 * `mcp__<server>__<tool>` tools with their own descriptions and schemas and
 * never the protocol. Each server is connected independently and in parallel:
 * one that is slow, misconfigured or missing its command fails on its own,
 * with a reason the person can act on, and takes nothing else down with it.
 */

import { createHash } from "node:crypto";
import { basename } from "node:path";
import { pathToFileURL } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import {
  CreateMessageRequestSchema,
  ErrorCode,
  ListRootsRequestSchema,
  LoggingMessageNotificationSchema,
  McpError,
  ResourceListChangedNotificationSchema,
  ResourceUpdatedNotificationSchema,
  ToolListChangedNotificationSchema,
} from "@modelcontextprotocol/sdk/types.js";
import type { ExternalCallContext, ExternalToolDefinition, ExternalToolInfo, ExternalTools } from "@sqcode/orchestrator";
import type { ToolResult } from "@sqcode/tools";
import { descendantsOf, killRemembered, listOsProcesses } from "@sqcode/sandbox-runner";
import { expandVars, missingVars, type McpOrigin, type McpServerEntry } from "./config.js";
import { SignInRequired, StoredOAuth } from "./oauth.js";
import { UnauthorizedError } from "@modelcontextprotocol/sdk/client/auth.js";

/**
 * `configured`: set up but not started, because nothing has needed it yet.
 * `signin`: it signs in through the browser, and that has not happened (or has expired).
 */
export type McpServerState = "connected" | "failed" | "disabled" | "untrusted" | "configured" | "signin";

export interface McpServerStatus {
  name: string;
  origin: McpOrigin;
  state: McpServerState;
  /** Why it is not connected, in words the person can act on. */
  error?: string;
  tools: string[];
  transport: "stdio" | "http" | "sse";
  /** What else it offers besides tools. */
  features?: ("resources" | "prompts" | "logging")[];
  /** Its latest log messages, newest last. */
  log?: string[];
}

/** A prompt a server offers the person (MCP prompts are theirs to pick, not the agent's). */
export interface McpPromptInfo {
  server: string;
  name: string;
  title?: string;
  description?: string;
  arguments: { name: string; description?: string; required?: boolean }[];
}

export interface McpHubOptions {
  /** Where `${VAR}` values come from. Default: this process's environment. */
  env?: Record<string, string | undefined>;
  /** Working directory for stdio servers that do not set one: the project. */
  cwd?: string;
  /** How long one server may take to connect and list its tools. */
  connectTimeoutMs?: number;
  /** After a server fails to connect, how long before a call may try it again. */
  retryAfterMs?: number;
  clientName?: string;
  clientVersion?: string;
  /** Project servers the person has NOT agreed to: listed, never started. */
  untrusted?: readonly McpServerEntry[];
  /** Folders servers may work in (MCP roots). Default: `cwd`, when there is one. */
  roots?: readonly string[];
  /** Where browser sign-ins (OAuth) are kept: servers marked `oauth` use them. */
  oauthDir?: string;
}

interface Tool {
  exposed: string;
  server: string;
  tool: string;
  definition: ExternalToolDefinition;
  readOnly: boolean;
  declaredReadOnly: boolean;
  autoApproved: boolean;
}

/** Whether a config list (`true`, or a list of names) covers `tool`. */
function covers(list: string[] | boolean | undefined, tool: string): boolean {
  return list === true || (Array.isArray(list) && list.includes(tool));
}

interface Connection {
  entry: McpServerEntry;
  client: Client;
  closed: boolean;
  instructions?: string;
  stderr: string[];
  /** Kept for the stdio server's pid, to take down what it started when it goes. */
  transport?: Transport;
  /** Calls to this server in progress: where its progress, logs and sampling requests go. */
  active: ExternalCallContext[];
  log: string[];
  /** Its resources and templates, listed once and dropped when it says the list changed. */
  resources?: Promise<ResourceListing>;
  /** Resources it said changed since the agent last read them. */
  updated: Set<string>;
  subscribed: Set<string>;
}

interface ResourceListing {
  resources: { uri: string; name: string; description?: string; mimeType?: string }[];
  templates: { uriTemplate: string; name: string; description?: string }[];
}

/** The two tools through which the agent reaches every server's resources. */
export const LIST_RESOURCES = "list_mcp_resources";
export const READ_RESOURCE = "read_mcp_resource";
const RESOURCE_TOOLS: ExternalToolDefinition[] = [
  {
    name: LIST_RESOURCES,
    description:
      "List what connected MCP servers offer to read — documents, records, schemas, files — as resources with URIs, plus URI templates you can fill in. Optionally for one server.",
    input_schema: { type: "object", properties: { server: { type: "string", description: "Only this server's" } }, required: [] },
  },
  {
    name: READ_RESOURCE,
    description: "Read one MCP resource by its URI (from list_mcp_resources, or a filled-in template).",
    input_schema: {
      type: "object",
      properties: {
        server: { type: "string", description: "The server that offers it" },
        uri: { type: "string", description: "The resource's URI" },
      },
      required: ["server", "uri"],
    },
  },
];

/** The text of an MCP message's content (one block, or a list of them). */
function contentText(content: unknown): string {
  const blocks = Array.isArray(content) ? content : [content];
  return blocks
    .map((b) => {
      const block = b as ContentBlock | null;
      if (!block) return "";
      if (block.type === "text") return block.text ?? "";
      if (block.type === "resource") return block.resource?.text ?? `[resource: ${block.resource?.uri ?? "unknown"}]`;
      return `[${block.type} omitted]`;
    })
    .join("\n");
}

/** The process a stdio connection runs, while it runs. */
function pidOf(conn: Connection): number | undefined {
  return conn.transport instanceof StdioClientTransport ? (conn.transport.pid ?? undefined) : undefined;
}

const DEFAULT_CONNECT_MS = 30_000;
const DEFAULT_CALL_MS = 120_000;
/** After a failed connect, how long calls report the failure rather than spawn the server again. */
const RETRY_AFTER_MS = 30_000;
/** Provider limit on a function name (OpenAI's, the strictest). */
const MAX_NAME = 64;

/**
 * `mcp__<server>__<tool>`, in the characters every provider accepts, at most 64 of them.
 *
 * Cleaning is lossy — `get.item` and `get_item` both become `get_item` — so
 * `hashed` asks for a name that also carries a hash of the real one, which the
 * hub uses whenever the plain name is already someone else's.
 */
export function exposedName(server: string, tool: string, hashed = false): string {
  const clean = (s: string) => s.replace(/[^A-Za-z0-9_-]/g, "_");
  const name = `mcp__${clean(server)}__${clean(tool)}`;
  if (name.length <= MAX_NAME && !hashed) return name;
  const hash = createHash("sha256").update(`${server}/${tool}`).digest("hex").slice(0, 6);
  return `${name.slice(0, MAX_NAME - 7)}_${hash}`;
}

/** A server's JSON Schema, in the shape the model's tool list requires. */
export function toolSchema(input: unknown): ExternalToolDefinition["input_schema"] {
  const schema = input && typeof input === "object" ? { ...(input as Record<string, unknown>) } : {};
  delete schema["$schema"];
  const properties = schema["properties"] && typeof schema["properties"] === "object" ? (schema["properties"] as Record<string, unknown>) : {};
  const required = Array.isArray(schema["required"]) ? (schema["required"] as unknown[]).filter((r): r is string => typeof r === "string") : [];
  return { ...schema, type: "object", properties, required };
}

interface ContentBlock {
  type: string;
  text?: string;
  data?: string;
  mimeType?: string;
  uri?: string;
  name?: string;
  resource?: { uri?: string; text?: string; blob?: string; mimeType?: string };
}

/** Roughly how many bytes a base64 string holds, for a note in place of the data. */
function base64Bytes(data: string): number {
  return Math.floor((data.length * 3) / 4) - (data.endsWith("==") ? 2 : data.endsWith("=") ? 1 : 0);
}

/**
 * An MCP `CallToolResult`, as the loop's `ToolResult`.
 *
 * The loop carries one image per tool result. When a server returns more, the
 * first is attached and every other one is named in the text, so the model
 * knows they exist and can ask for them one at a time — never silently lost.
 */
export function toToolResult(
  result: { content?: ContentBlock[]; isError?: boolean; structuredContent?: unknown },
  source: string,
): ToolResult {
  const parts: string[] = [];
  let image: ToolResult["image"];
  let images = 0;
  for (const block of result.content ?? []) {
    switch (block.type) {
      case "text":
        parts.push(block.text ?? "");
        break;
      case "image": {
        images += 1;
        const type = block.mimeType ?? "unknown type";
        if (block.data && block.mimeType && !image) {
          image = { base64: block.data, mediaType: block.mimeType, source };
          parts.push(`[image ${images}: ${type} — attached]`);
        } else {
          parts.push(`[image ${images}: ${type} — not attached; only one image per tool result reaches you]`);
        }
        break;
      }
      case "audio":
        parts.push(`[audio: ${block.mimeType ?? "unknown type"}${block.data ? `, ${base64Bytes(block.data)} bytes` : ""} — not playable here]`);
        break;
      case "resource": {
        const r = block.resource;
        if (typeof r?.text === "string") parts.push(r.text);
        else if (typeof r?.blob === "string") parts.push(`[binary resource: ${r.uri ?? "unknown"} (${r.mimeType ?? "unknown type"}, ${base64Bytes(r.blob)} bytes) — not shown]`);
        else parts.push(`[resource: ${r?.uri ?? "unknown"}]`);
        break;
      }
      case "resource_link":
        parts.push(`[link: ${block.name ?? ""} ${block.uri ?? ""}]`.replace(/\s+/g, " "));
        break;
      default:
        parts.push(`[${block.type} content omitted]`);
    }
  }
  if (parts.length === 0 && result.structuredContent !== undefined) parts.push(JSON.stringify(result.structuredContent));
  const text = parts.join("\n").trim();
  if (result.isError) return { success: false, error: text || "The tool reported an error and said nothing more." };
  return { success: true, data: text || "(the tool returned nothing)", ...(image ? { image } : {}) };
}

function fence(source: string, content: string): string {
  const safe = content.replace(/<\/?untrusted-content/gi, "&lt;untrusted-content");
  return `<untrusted-content source="${source}">\n${safe}\n</untrusted-content>`;
}

function reason(err: unknown, conn?: { stderr: string[] }): string {
  const message = err instanceof Error ? err.message : String(err);
  const code = (err as { code?: string } | null)?.code;
  const tail = conn?.stderr.slice(-3).join(" ").trim();
  /*
   * A command that does not exist, however the platform says so: ENOENT from a
   * direct spawn, or — on Windows, where cross-spawn goes through cmd.exe —
   * cmd's own "is not recognized", arriving as a closed connection.
   */
  if (code === "ENOENT" || /is not recognized as an internal or external command|command not found|No such file or directory/i.test(tail ?? "")) {
    return "its command was not found — is it installed and on PATH?";
  }
  return tail ? `${message} (it said: ${tail.slice(0, 300)})` : message;
}

async function withTimeout<T>(work: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${what} took longer than ${Math.round(ms / 1000)} s`)), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Close connections and take down what their servers started.
 *
 * Closing a stdio client ends the server's stdin, then signals the process it
 * spawned — which, on Windows, is `cmd.exe` wrapping `npx` wrapping the real
 * server. Signal the wrapper and the server lives on, parentless, for good.
 * So the tree under each server is noted *before* closing, while it is still
 * connected to its root, and whatever of it outlives the close is killed.
 * `killRemembered` checks each process is still the program it was, so a pid
 * the system has since reused is left alone.
 */
async function closeConnections(conns: readonly Connection[]): Promise<void> {
  if (conns.length === 0) return;
  const pids = conns.map(pidOf).filter((p): p is number => typeof p === "number");
  const tree = pids.length > 0 ? await listOsProcesses().then((all) => pids.flatMap((pid) => descendantsOf(all, pid))) : [];
  await Promise.all(conns.map((c) => c.client.close().catch(() => undefined)));
  if (tree.length > 0) await killRemembered(tree).catch(() => 0);
}

export class McpHub implements ExternalTools {
  private readonly connections = new Map<string, Connection>();
  private readonly tools = new Map<string, Tool>();
  private readonly statuses = new Map<string, McpServerStatus>();
  /** Every server this hub was given, kept so one that fails or drops can be connected again. */
  private readonly entries = new Map<string, McpServerEntry>();
  /** Connects in progress: parallel calls to a dropped server share one reconnect, not one each. */
  private readonly opening = new Map<string, Promise<void>>();
  /** When a server last failed to connect. */
  private readonly failedAt = new Map<string, number>();
  private shut = false;

  private constructor(private readonly options: McpHubOptions) {}

  /** Connect every enabled server. Never throws: failures are in `status()`. */
  static async connect(servers: readonly McpServerEntry[], options: McpHubOptions = {}): Promise<McpHub> {
    const hub = new McpHub(options);
    for (const entry of servers) hub.entries.set(entry.name, entry);
    for (const entry of options.untrusted ?? []) {
      hub.statuses.set(entry.name, {
        name: entry.name,
        origin: entry.origin,
        state: "untrusted",
        error: "configured by this project and not yet approved",
        tools: [],
        transport: entry.config.type ?? "stdio",
      });
    }
    await Promise.all(servers.map((entry) => hub.ensureConnected(entry.name)));
    return hub;
  }

  /**
   * The server's live connection, connecting it if it has none.
   *
   * One connect per server at a time: the loop runs read-only tools in
   * parallel, and three calls to a server that just crashed must start one
   * replacement, not three (two of which would be orphaned). A server that
   * failed recently is not respawned on every call; the failure is reported
   * until `RETRY_AFTER_MS` has passed.
   */
  private async ensureConnected(server: string): Promise<Connection | undefined> {
    const live = this.connections.get(server);
    if (live && !live.closed) return live;
    const entry = this.entries.get(server);
    if (!entry || this.shut) return undefined;
    const failed = this.failedAt.get(server);
    if (failed !== undefined && Date.now() - failed < (this.options.retryAfterMs ?? RETRY_AFTER_MS) && !this.opening.has(server)) return undefined;
    let pending = this.opening.get(server);
    if (!pending) {
      pending = (async () => {
        if (live) {
          this.connections.delete(server);
          await closeConnections([live]);
        }
        await this.open(entry);
      })().finally(() => this.opening.delete(server));
      this.opening.set(server, pending);
    }
    await pending;
    const conn = this.connections.get(server);
    return conn && !conn.closed ? conn : undefined;
  }

  private env(): Record<string, string | undefined> {
    return this.options.env ?? process.env;
  }

  private transportFor(entry: McpServerEntry, conn: { stderr: string[] }, sse = false): Transport {
    const env = this.env();
    const c = entry.config;
    if (c.type === "http" || c.type === "sse") {
      const url = new URL(expandVars(c.url ?? "", env));
      const headers = Object.fromEntries(Object.entries(c.headers ?? {}).map(([k, v]) => [k, expandVars(v, env)]));
      const requestInit = { headers };
      // Signed in through the browser: saved tokens, refreshed as needed; never a browser opened mid-turn.
      const authProvider = c.oauth && this.options.oauthDir ? new StoredOAuth(this.options.oauthDir, entry.name) : undefined;
      const options = { requestInit, ...(authProvider ? { authProvider } : {}) };
      return c.type === "sse" || sse ? new SSEClientTransport(url, options) : new StreamableHTTPClientTransport(url, options);
    }
    const transport = new StdioClientTransport({
      command: expandVars(c.command ?? "", env),
      args: (c.args ?? []).map((a) => expandVars(a, env)),
      env: Object.fromEntries(Object.entries(c.env ?? {}).map(([k, v]) => [k, expandVars(v, env)])),
      ...(c.cwd || this.options.cwd ? { cwd: c.cwd ?? this.options.cwd } : {}),
      stderr: "pipe",
    });
    transport.stderr?.on("data", (chunk: Buffer) => {
      conn.stderr.push(...chunk.toString("utf8").split(/\r?\n/).filter(Boolean));
      if (conn.stderr.length > 40) conn.stderr.splice(0, conn.stderr.length - 40);
    });
    return transport;
  }

  /** The folders servers may work in, as MCP roots. */
  private rootDirs(): readonly string[] {
    return this.roots ?? this.options.roots ?? (this.options.cwd ? [this.options.cwd] : []);
  }

  /**
   * A client that answers what servers may ask of it: the roots (the folders
   * it works in), and sampling — which it passes to the call in progress, and
   * refuses when there is none.
   */
  private newClient(conn: Connection): Client {
    const client = new Client(
      { name: this.options.clientName ?? "soreqen-code", version: this.options.clientVersion ?? "1.0.0" },
      { capabilities: { roots: { listChanged: true }, sampling: {} } },
    );
    client.setRequestHandler(ListRootsRequestSchema, async () => ({
      roots: this.rootDirs().map((dir) => ({ uri: pathToFileURL(dir).href, name: basename(dir) || dir })),
    }));
    client.setRequestHandler(CreateMessageRequestSchema, async (request) => {
      const call = conn.active[conn.active.length - 1];
      if (!call?.sample) {
        throw new McpError(
          ErrorCode.InvalidRequest,
          "SoreQen Code answers a sampling request only while one of this server's tools is running for the agent, with the person's approval.",
        );
      }
      const p = request.params;
      const result = await call.sample({
        server: conn.entry.name,
        ...(p.systemPrompt ? { systemPrompt: p.systemPrompt } : {}),
        messages: p.messages.map((m) => ({ role: m.role, text: contentText(m.content) })),
        maxTokens: p.maxTokens,
      });
      return { role: "assistant" as const, content: { type: "text" as const, text: result.text }, model: result.model, stopReason: result.stopReason };
    });
    client.setNotificationHandler(LoggingMessageNotificationSchema, async (n) => {
      const data = typeof n.params.data === "string" ? n.params.data : JSON.stringify(n.params.data);
      const line = `[${n.params.level}${n.params.logger ? ` ${n.params.logger}` : ""}] ${data}`.slice(0, 500);
      conn.log.push(line);
      if (conn.log.length > 50) conn.log.splice(0, conn.log.length - 50);
      conn.active[conn.active.length - 1]?.onProgress?.({ message: line });
      const status = this.statuses.get(conn.entry.name);
      if (status) status.log = conn.log.slice(-5);
    });
    client.setNotificationHandler(ResourceListChangedNotificationSchema, async () => {
      conn.resources = undefined;
    });
    client.setNotificationHandler(ResourceUpdatedNotificationSchema, async (n) => {
      conn.updated.add(n.params.uri);
    });
    return client;
  }

  private async open(entry: McpServerEntry): Promise<void> {
    const transport = entry.config.type ?? "stdio";
    const fail = (error: string): void => {
      this.statuses.set(entry.name, { name: entry.name, origin: entry.origin, state: "failed", error, tools: [], transport });
    };
    if (entry.config.disabled) {
      this.statuses.set(entry.name, { name: entry.name, origin: entry.origin, state: "disabled", tools: [], transport });
      return;
    }
    // Signs in through the browser and has not: say so, without asking the server to register a client nobody will use.
    if (entry.config.oauth && this.options.oauthDir && !new StoredOAuth(this.options.oauthDir, entry.name).signedIn()) {
      this.statuses.set(entry.name, { name: entry.name, origin: entry.origin, state: "signin", error: `Sign in to ${entry.name} to connect it (Settings > Connectors).`, tools: [], transport });
      return;
    }
    const missing = missingVars(entry.config, this.env());
    if (missing.length > 0) {
      fail(`needs ${missing.map((m) => `$${m}`).join(", ")} set in the environment`);
      return;
    }

    const conn = {
      entry,
      closed: false,
      stderr: [],
      active: [],
      log: [],
      updated: new Set<string>(),
      subscribed: new Set<string>(),
    } as unknown as Connection;
    conn.client = this.newClient(conn);
    const timeout = this.options.connectTimeoutMs ?? DEFAULT_CONNECT_MS;
    const start = async (sse: boolean): Promise<void> => {
      conn.transport = this.transportFor(entry, conn, sse);
      await withTimeout(conn.client.connect(conn.transport), timeout, "connecting");
    };
    try {
      try {
        await start(false);
      } catch (err) {
        // An older server speaks the SSE transport; the spec says to try it next.
        if (entry.config.type !== "http") throw err;
        conn.client = this.newClient(conn);
        await start(true);
      }
      conn.client.onclose = () => {
        conn.closed = true;
      };
      conn.instructions = conn.client.getInstructions()?.slice(0, 1_000);
      this.connections.set(entry.name, conn);
      await withTimeout(this.listTools(conn), timeout, "listing its tools");
      if (conn.client.getServerCapabilities()?.tools?.listChanged) {
        conn.client.setNotificationHandler(ToolListChangedNotificationSchema, async () => {
          await this.listTools(conn).catch(() => undefined);
        });
      }
      this.failedAt.delete(entry.name);
    } catch (err) {
      this.connections.delete(entry.name);
      this.failedAt.set(entry.name, Date.now());
      await closeConnections([conn]);
      if (entry.config.oauth && (err instanceof SignInRequired || err instanceof UnauthorizedError || /unauthori[sz]ed|401|sign in|prepareTokenRequest|authorizationCode is required|invalid_grant|invalid_token/i.test(String((err as Error)?.message ?? err)))) {
        this.statuses.set(entry.name, {
          name: entry.name,
          origin: entry.origin,
          state: "signin",
          error: `Sign in to ${entry.name} to connect it (Settings > Connectors).`,
          tools: [],
          transport,
        });
      } else fail(reason(err, conn));
    }
    // Closed while this was connecting: do not leave a server running for nobody.
    if (this.shut && this.connections.get(entry.name) === conn) {
      this.connections.delete(entry.name);
      await closeConnections([conn]);
    }
  }

  private async listTools(conn: Connection): Promise<void> {
    const server = conn.entry.name;
    const found: Tool[] = [];
    // Names already given out — other servers' tools, and this listing's so far.
    const taken = new Set([...this.tools.values()].filter((t) => t.server !== server).map((t) => t.exposed));
    /*
     * Everything that waives a confirmation comes from the person's own
     * configuration only. A project's .mcp.json cannot declare its servers
     * read-only or approved in advance — a repository vouching for itself is
     * no voucher — and a server's own hint counts for the person's servers alone.
     */
    const mine = conn.entry.origin === "user";
    const capabilities = conn.client.getServerCapabilities();
    let cursor: string | undefined;
    if (capabilities?.tools) {
      do {
        const page = await conn.client.listTools(cursor ? { cursor } : {});
        for (const t of page.tools) {
          const declared = mine && covers(conn.entry.config.readOnly, t.name);
          const hinted = mine && t.annotations?.readOnlyHint === true;
          let exposed = exposedName(server, t.name);
          if (taken.has(exposed)) exposed = exposedName(server, t.name, true);
          if (taken.has(exposed)) continue; // the same name twice in one listing: the server's mistake
          taken.add(exposed);
          found.push({
            exposed,
            server,
            tool: t.name,
            readOnly: declared || hinted,
            declaredReadOnly: declared,
            autoApproved: mine && covers(conn.entry.config.autoApprove, t.name),
            definition: {
              name: exposed,
              description: `[MCP: ${server}] ${(t.description ?? t.title ?? t.name).slice(0, 2_000)}`,
              input_schema: toolSchema(t.inputSchema),
            },
          });
        }
        cursor = page.nextCursor;
      } while (cursor && found.length < 500);
    }

    for (const [name, tool] of this.tools) if (tool.server === server) this.tools.delete(name);
    for (const tool of found) this.tools.set(tool.exposed, tool);
    const features: McpServerStatus["features"] = [];
    if (capabilities?.resources) features.push("resources");
    if (capabilities?.prompts) features.push("prompts");
    if (capabilities?.logging) features.push("logging");
    this.statuses.set(server, {
      name: server,
      origin: conn.entry.origin,
      state: "connected",
      tools: found.map((t) => t.tool),
      transport: conn.entry.config.type ?? "stdio",
      ...(features.length > 0 ? { features } : {}),
      ...(conn.log.length > 0 ? { log: conn.log.slice(-5) } : {}),
    });
  }

  status(): McpServerStatus[] {
    return [...this.statuses.values()].sort((a, b) => a.name.localeCompare(b.name));
  }

  /** Live connections that offer `feature`. */
  private offering(feature: "resources" | "prompts"): Connection[] {
    return [...this.connections.values()].filter((c) => !c.closed && c.client.getServerCapabilities()?.[feature]);
  }

  definitions(): ExternalToolDefinition[] {
    const own = [...this.tools.values()].sort((a, b) => a.exposed.localeCompare(b.exposed)).map((t) => t.definition);
    return this.offering("resources").length > 0 ? [...own, ...RESOURCE_TOOLS] : own;
  }

  describe(name: string): ExternalToolInfo | undefined {
    /*
     * Listing and reading resources is the protocol's own read operation,
     * defined by the client, not a server describing its tool — so it is
     * read-only on SoreQen's word, not the server's, and never asked about.
     */
    if (name === LIST_RESOURCES || name === READ_RESOURCE) {
      return this.offering("resources").length > 0
        ? { server: "MCP", tool: name === LIST_RESOURCES ? "list resources" : "read a resource", readOnly: true, declaredReadOnly: true, autoApproved: true }
        : undefined;
    }
    const tool = this.tools.get(name);
    return tool
      ? { server: tool.server, tool: tool.tool, readOnly: tool.readOnly, declaredReadOnly: tool.declaredReadOnly, autoApproved: tool.autoApproved }
      : undefined;
  }

  async call(name: string, input: Record<string, unknown>, context: ExternalCallContext = {}): Promise<ToolResult> {
    if (name === LIST_RESOURCES) return this.listResources(typeof input["server"] === "string" ? input["server"] : undefined);
    if (name === READ_RESOURCE) return this.readResource(String(input["server"] ?? ""), String(input["uri"] ?? ""), context);
    const tool = this.tools.get(name);
    if (!tool) return { success: false, error: `No MCP tool named ${name}.` };
    // A server that went away (crashed, or the network dropped) is reconnected here.
    const conn = await this.ensureConnected(tool.server);
    if (!conn) {
      return { success: false, error: `MCP server "${tool.server}" is not connected: ${this.statuses.get(tool.server)?.error ?? "it stopped"}.` };
    }
    // Reconnected to a server whose tool list changed: this tool may be gone.
    if (!this.tools.has(name)) {
      return { success: false, error: `MCP server "${tool.server}" no longer offers ${tool.tool}.` };
    }
    conn.active.push(context);
    try {
      const result = await conn.client.callTool({ name: tool.tool, arguments: input }, undefined, {
        ...(context.signal ? { signal: context.signal } : {}),
        timeout: conn.entry.config.timeoutMs ?? DEFAULT_CALL_MS,
        resetTimeoutOnProgress: true,
        onprogress: (p) =>
          context.onProgress?.({
            progress: p.progress,
            ...(p.total !== undefined ? { total: p.total } : {}),
            ...(typeof p.message === "string" ? { message: p.message } : {}),
          }),
      });
      return toToolResult(result as Parameters<typeof toToolResult>[0], `${tool.server}/${tool.tool}`);
    } catch (err) {
      return { success: false, error: `MCP server "${tool.server}" could not run ${tool.tool}: ${reason(err, conn)}` };
    } finally {
      conn.active.splice(conn.active.indexOf(context), 1);
    }
  }

  // --- resources -----------------------------------------------------------------

  private listing(conn: Connection): Promise<ResourceListing> {
    conn.resources ??= (async () => {
      const out: ResourceListing = { resources: [], templates: [] };
      let cursor: string | undefined;
      do {
        const page = await conn.client.listResources(cursor ? { cursor } : {});
        for (const r of page.resources) {
          out.resources.push({ uri: r.uri, name: r.name, ...(r.description ? { description: r.description } : {}), ...(r.mimeType ? { mimeType: r.mimeType } : {}) });
        }
        cursor = page.nextCursor;
      } while (cursor && out.resources.length < 200);
      const templates = await conn.client.listResourceTemplates().catch(() => ({ resourceTemplates: [] }));
      for (const t of templates.resourceTemplates.slice(0, 50)) {
        out.templates.push({ uriTemplate: t.uriTemplate, name: t.name, ...(t.description ? { description: t.description } : {}) });
      }
      return out;
    })();
    // A listing that failed is not kept: the next ask tries again.
    conn.resources.catch(() => (conn.resources = undefined));
    return conn.resources;
  }

  private async listResources(server?: string): Promise<ToolResult> {
    const conns = this.offering("resources").filter((c) => !server || c.entry.name === server);
    if (conns.length === 0) {
      return { success: false, error: server ? `MCP server "${server}" is not connected or offers no resources.` : "No connected MCP server offers resources." };
    }
    const lines: string[] = [];
    for (const conn of conns) {
      lines.push(`## ${conn.entry.name}`);
      try {
        const { resources, templates } = await withTimeout(this.listing(conn), DEFAULT_CONNECT_MS, "listing its resources");
        if (resources.length === 0 && templates.length === 0) lines.push("(nothing listed)");
        for (const r of resources) {
          const about = [r.name !== r.uri ? r.name : "", r.description ?? "", r.mimeType ? `(${r.mimeType})` : ""].filter(Boolean).join(" — ");
          lines.push(`- ${r.uri}${about ? ` — ${about}` : ""}${conn.updated.has(r.uri) ? " [changed since you last read it]" : ""}`);
        }
        if (templates.length > 0) {
          lines.push("Templates (fill in the {placeholders}, then read_mcp_resource):");
          for (const t of templates) lines.push(`- ${t.uriTemplate} — ${t.name}${t.description ? `: ${t.description}` : ""}`);
        }
      } catch (err) {
        lines.push(`(could not list: ${reason(err, conn)})`);
      }
    }
    return { success: true, data: lines.join("\n") };
  }

  private async readResource(server: string, uri: string, context: ExternalCallContext): Promise<ToolResult> {
    if (!uri) return { success: false, error: "read_mcp_resource needs a uri." };
    const conn = await this.ensureConnected(server);
    if (!conn?.client.getServerCapabilities()?.resources) {
      return { success: false, error: `MCP server "${server}" is not connected or offers no resources.` };
    }
    try {
      const result = await conn.client.readResource({ uri }, { ...(context.signal ? { signal: context.signal } : {}), timeout: conn.entry.config.timeoutMs ?? DEFAULT_CALL_MS });
      conn.updated.delete(uri);
      // Hear about changes to what the agent has read, when the server can say.
      if (conn.client.getServerCapabilities()?.resources?.subscribe && !conn.subscribed.has(uri)) {
        conn.subscribed.add(uri);
        void conn.client.subscribeResource({ uri }).catch(() => conn.subscribed.delete(uri));
      }
      const blocks: ContentBlock[] = result.contents.map((c) => {
        const item = c as { uri: string; mimeType?: string; text?: string; blob?: string };
        if (typeof item.blob === "string" && item.mimeType?.startsWith("image/")) return { type: "image", data: item.blob, mimeType: item.mimeType };
        return { type: "resource", resource: item };
      });
      return toToolResult({ content: blocks }, `${server}:${uri}`);
    } catch (err) {
      return { success: false, error: `MCP server "${server}" could not read ${uri}: ${reason(err, conn)}` };
    }
  }

  // --- prompts -------------------------------------------------------------------

  /** Every connected server's prompts, for the person to pick from (`/prompts`). */
  async listPrompts(): Promise<McpPromptInfo[]> {
    const out: McpPromptInfo[] = [];
    await Promise.all(
      this.offering("prompts").map(async (conn) => {
        try {
          let cursor: string | undefined;
          do {
            const page = await withTimeout(conn.client.listPrompts(cursor ? { cursor } : {}), DEFAULT_CONNECT_MS, "listing its prompts");
            for (const p of page.prompts) {
              out.push({
                server: conn.entry.name,
                name: p.name,
                ...(p.title ? { title: p.title } : {}),
                ...(p.description ? { description: p.description } : {}),
                arguments: (p.arguments ?? []).map((a) => ({
                  name: a.name,
                  ...(a.description ? { description: a.description } : {}),
                  ...(a.required ? { required: true } : {}),
                })),
              });
            }
            cursor = page.nextCursor;
          } while (cursor && out.length < 500);
        } catch {
          // A server whose prompts cannot be listed offers none this time.
        }
      }),
    );
    return out.sort((a, b) => a.server.localeCompare(b.server) || a.name.localeCompare(b.name));
  }

  /**
   * One prompt, filled in, as the text of a message from the person. Several
   * messages come back as one, each under its role, so a multi-part prompt
   * still arrives as one thing the person sent.
   */
  async getPrompt(server: string, name: string, args: Record<string, string> = {}): Promise<{ description?: string; text: string }> {
    const conn = await this.ensureConnected(server);
    if (!conn?.client.getServerCapabilities()?.prompts) throw new Error(`MCP server "${server}" is not connected or offers no prompts.`);
    const result = await conn.client.getPrompt({ name, arguments: args }, { timeout: conn.entry.config.timeoutMs ?? DEFAULT_CALL_MS });
    const parts = result.messages.map((m) => ({ role: m.role, text: contentText(m.content) }));
    const text =
      parts.length === 1 && parts[0]!.role === "user"
        ? parts[0]!.text
        : parts.map((p) => `[${p.role}]\n${p.text}`).join("\n\n");
    return { ...(result.description ? { description: result.description } : {}), text };
  }

  // --- roots ---------------------------------------------------------------------

  private roots?: readonly string[];

  /** Change the folders servers may work in, and tell every connected server. */
  setRoots(dirs: readonly string[]): void {
    this.roots = [...dirs];
    for (const conn of this.connections.values()) {
      if (!conn.closed) void conn.client.sendRootsListChanged().catch(() => undefined);
    }
  }

  /**
   * The agent's view of what is connected. Server-written instructions are
   * the server author's words, so they are fenced like any other content the
   * agent did not get from the person.
   */
  promptSection(options: { deferred?: boolean } = {}): string {
    const connected = this.status().filter((s) => s.state === "connected" && (s.tools.length > 0 || s.features?.includes("resources")));
    if (connected.length === 0) return "";
    const lines = [
      "## MCP SERVERS",
      "Tools named mcp__<server>__<tool> come from these servers, which the person connected. They act outside",
      "the workspace — nothing a checkpoint can undo — so use them for what the task needs, and you may be asked",
      "to confirm ones that change things.",
    ];
    if (options.deferred) {
      // Their definitions (and their own instructions) cost thousands of tokens on every request; see load_tools.
      lines.push("Their tools are not in your tool list until you load them: call load_tools with the names you need (load_tools lists them), then call them.");
    }
    if (connected.some((s) => s.features?.includes("resources"))) {
      lines.push("Servers marked [resources] also offer things to read: list them with list_mcp_resources, read one with read_mcp_resource.");
    }
    for (const s of connected) {
      const conn = this.connections.get(s.name);
      const about = conn?.entry.config.description ? ` — ${conn.entry.config.description}` : "";
      const extra = s.features?.includes("resources") ? " [resources]" : "";
      lines.push(`- ${s.name}${about} (${s.tools.length} tool${s.tools.length === 1 ? "" : "s"})${extra}`);
      if (conn?.instructions && !options.deferred) lines.push(fence(`MCP server ${s.name}`, conn.instructions));
    }
    return lines.join("\n");
  }

  /** A server's own instructions, fenced as its words; given with its tools when they are loaded. */
  instructions(server: string): string | undefined {
    const conn = this.connections.get(server);
    return conn?.instructions ? fence(`MCP server ${server}`, conn.instructions) : undefined;
  }

  async close(): Promise<void> {
    this.shut = true;
    const conns = [...this.connections.values()];
    this.connections.clear();
    this.tools.clear();
    await closeConnections(conns);
  }
}
