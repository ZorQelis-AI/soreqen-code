/**
 * Which MCP servers to connect, and whether the person agreed to them.
 *
 * ## Where servers are configured
 *
 *   ~/.soreqen/mcp.json              the person's own, for every project
 *   <project>/.mcp.json               the project's (the format Claude Code
 *   <project>/.soreqen/mcp.json       and other agents use, so one file serves all)
 *
 *   { "mcpServers": {
 *       "github": { "command": "npx", "args": ["-y", "@modelcontextprotocol/server-github"],
 *                   "env": { "GITHUB_TOKEN": "${GITHUB_TOKEN}" } },
 *       "docs":   { "type": "http", "url": "https://example.com/mcp",
 *                   "headers": { "Authorization": "Bearer ${DOCS_TOKEN}" } } } }
 *
 * `${VAR}` (and `${VAR:-default}`) is filled from the environment, so a
 * config file can be committed without the secret in it.
 *
 * ## Why a project's servers need the person's say-so
 *
 * A stdio server is a command. A repository that ships `.mcp.json` is a
 * repository asking to run a program on the machine of whoever opens it —
 * cloning something is not agreeing to that. So a project's servers are
 * connected only once the person has trusted *that* configuration for *that*
 * folder, recorded by a hash of it: change a command or an argument and it
 * must be agreed to again.
 */

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

export interface McpServerConfig {
  /** stdio (a command) is assumed when there is a `command`; http when there is a `url`. */
  type?: "stdio" | "http" | "sse";
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
  url?: string;
  headers?: Record<string, string>;
  /** Kept in the file, not connected. */
  disabled?: boolean;
  /** Tools that may run without asking: their names, or `true` for all of this server's. */
  autoApprove?: string[] | boolean;
  /**
   * Tools the person vouches only read: their names, or `true` for all of this
   * server's. Needed for servers that do not annotate their tools (most do
   * not), so plan mode can still use their lookups — and the only way a
   * project's server gets read-only treatment, since its own annotations are
   * not trusted.
   */
  readOnly?: string[] | boolean;
  /** How long one call may take (default two minutes). */
  timeoutMs?: number;
  /** What it is for, in a few words; shown to the agent. */
  description?: string;
  /**
   * Signs in through the person's browser (OAuth). Its tokens are kept apart,
   * in `~/.soreqen/mcp-auth/`, never in this file.
   */
  oauth?: boolean;
  /** The connector it was added from (Settings > Connectors), for its name and icon there. */
  connector?: string;
}

export type McpOrigin = "user" | "project";

export interface McpServerEntry {
  name: string;
  config: McpServerConfig;
  origin: McpOrigin;
  /** The file it came from. */
  file: string;
}

export const SERVER_NAME = /^[A-Za-z0-9_-]{1,32}$/;

/** Parse one config file. Bad entries are reported and skipped, never guessed at. */
export function parseMcpConfig(
  text: string,
  origin: McpOrigin,
  file: string,
): { servers: McpServerEntry[]; problems: string[] } {
  const problems: string[] = [];
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return { servers: [], problems: [`${file} is not valid JSON.`] };
  }
  const table = (raw as { mcpServers?: unknown } | null)?.mcpServers;
  if (!table || typeof table !== "object" || Array.isArray(table)) {
    return { servers: [], problems: [`${file} has no "mcpServers" object.`] };
  }
  const servers: McpServerEntry[] = [];
  for (const [name, value] of Object.entries(table as Record<string, unknown>)) {
    if (!SERVER_NAME.test(name)) {
      problems.push(`${file}: "${name}" is not a usable server name (letters, digits, - and _, up to 32).`);
      continue;
    }
    const checked = checkServer(value);
    if (typeof checked === "string") {
      problems.push(`${file}: ${name}: ${checked}`);
      continue;
    }
    servers.push({ name, config: checked, origin, file });
  }
  return { servers, problems };
}

function strings(v: unknown): v is string[] {
  return Array.isArray(v) && v.every((s) => typeof s === "string");
}

function record(v: unknown): v is Record<string, string> {
  return !!v && typeof v === "object" && !Array.isArray(v) && Object.values(v).every((s) => typeof s === "string");
}

function checkServer(value: unknown): McpServerConfig | string {
  if (!value || typeof value !== "object" || Array.isArray(value)) return "not an object";
  const v = value as Record<string, unknown>;
  const type = v["type"] ?? (typeof v["url"] === "string" ? "http" : "stdio");
  if (type !== "stdio" && type !== "http" && type !== "sse") return `type must be "stdio", "http" or "sse"`;
  const out: McpServerConfig = { type };
  if (type === "stdio") {
    if (typeof v["command"] !== "string" || !v["command"].trim()) return "a stdio server needs a command";
    out.command = v["command"];
    if (v["args"] !== undefined) {
      if (!strings(v["args"])) return "args must be a list of strings";
      out.args = v["args"];
    }
    if (v["env"] !== undefined) {
      if (!record(v["env"])) return "env must map names to strings";
      out.env = v["env"];
    }
    if (typeof v["cwd"] === "string") out.cwd = v["cwd"];
  } else {
    if (typeof v["url"] !== "string") return `an ${type} server needs a url`;
    out.url = v["url"];
    if (v["headers"] !== undefined) {
      if (!record(v["headers"])) return "headers must map names to strings";
      out.headers = v["headers"];
    }
  }
  if (v["disabled"] === true) out.disabled = true;
  if (v["autoApprove"] === true || strings(v["autoApprove"])) out.autoApprove = v["autoApprove"];
  if (v["readOnly"] === true || strings(v["readOnly"])) out.readOnly = v["readOnly"];
  if (typeof v["timeoutMs"] === "number" && v["timeoutMs"] > 0) out.timeoutMs = Math.min(v["timeoutMs"], 30 * 60_000);
  if (typeof v["description"] === "string") out.description = v["description"].slice(0, 200);
  if (v["oauth"] === true && type !== "stdio") out.oauth = true;
  if (typeof v["connector"] === "string" && /^[a-z0-9_-]{1,40}$/.test(v["connector"])) out.connector = v["connector"];
  return out;
}

/** `${VAR}` and `${VAR:-default}`, from `env`. Unset without a default: empty. */
export function expandVars(text: string, env: Record<string, string | undefined>): string {
  return text.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-([^}]*))?\}/g, (_, name: string, fallback?: string) => env[name] ?? fallback ?? "");
}

/** Variables a config refers to that are not set, so the person can be told which. */
export function missingVars(config: McpServerConfig, env: Record<string, string | undefined>): string[] {
  const text = JSON.stringify([config.args, config.env, config.url, config.headers, config.command]);
  const missing = new Set<string>();
  for (const m of text.matchAll(/\$\{([A-Za-z_][A-Za-z0-9_]*)(:-)?/g)) {
    if (!m[2] && env[m[1]!] === undefined) missing.add(m[1]!);
  }
  return [...missing];
}

function readIf(file: string, origin: McpOrigin): { servers: McpServerEntry[]; problems: string[] } {
  if (!existsSync(file)) return { servers: [], problems: [] };
  try {
    return parseMcpConfig(readFileSync(file, "utf8"), origin, file);
  } catch (err) {
    return { servers: [], problems: [`${file} could not be read: ${err instanceof Error ? err.message : String(err)}`] };
  }
}

export interface McpConfigs {
  user: McpServerEntry[];
  project: McpServerEntry[];
  /** Identifies this exact project configuration, for trust. Null when there is none. */
  projectHash: string | null;
  problems: string[];
}

/**
 * Every server configured for a project, the person's and the project's.
 *
 * A name defined in both is the person's: their own file is theirs to
 * override a project with, never the other way round.
 */
export function readMcpConfigs(opts: { soreqenHome: string; projectDir?: string | null }): McpConfigs {
  const user = readIf(join(opts.soreqenHome, "mcp.json"), "user");
  const project = { servers: [] as McpServerEntry[], problems: [] as string[] };
  if (opts.projectDir) {
    const dir = resolve(opts.projectDir);
    for (const file of [join(dir, ".mcp.json"), join(dir, ".soreqen", "mcp.json")]) {
      const read = readIf(file, "project");
      project.problems.push(...read.problems);
      for (const s of read.servers) {
        if (!project.servers.some((p) => p.name === s.name)) project.servers.push(s);
      }
    }
  }
  const mine = new Set(user.servers.map((s) => s.name));
  const theirs = project.servers.filter((s) => !mine.has(s.name));
  return {
    user: user.servers,
    project: theirs,
    projectHash: theirs.length > 0 ? configHash(theirs) : null,
    problems: [...user.problems, ...project.problems],
  };
}

/** A stable hash of what the servers would run: names, commands, args, urls, env. */
export function configHash(servers: readonly McpServerEntry[]): string {
  const canonical = [...servers]
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((s) => [s.name, s.config.type, s.config.command, s.config.args, s.config.env, s.config.cwd, s.config.url, s.config.headers, s.config.disabled ?? false]);
  return createHash("sha256").update(JSON.stringify(canonical)).digest("hex");
}

/**
 * The person's decisions about projects' servers: `~/.soreqen/mcp-trust.json`,
 * folder → the hash of the configuration they agreed to.
 */
export class McpTrust {
  constructor(private readonly file: string) {}

  private read(): Record<string, string> {
    try {
      const raw = JSON.parse(readFileSync(this.file, "utf8")) as unknown;
      return raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, string>) : {};
    } catch {
      return {};
    }
  }

  private key(projectDir: string): string {
    const dir = resolve(projectDir);
    return process.platform === "win32" ? dir.toLowerCase() : dir;
  }

  isTrusted(projectDir: string, hash: string | null): boolean {
    return hash !== null && this.read()[this.key(projectDir)] === hash;
  }

  trust(projectDir: string, hash: string): void {
    this.write({ ...this.read(), [this.key(projectDir)]: hash });
  }

  revoke(projectDir: string): void {
    const all = this.read();
    delete all[this.key(projectDir)];
    this.write(all);
  }

  private write(all: Record<string, string>): void {
    mkdirSync(dirname(this.file), { recursive: true });
    writeFileSync(`${this.file}.tmp`, JSON.stringify(all, null, 2), { encoding: "utf8", mode: 0o600 });
    renameSync(`${this.file}.tmp`, this.file);
  }
}

/** Add or replace one of the person's own servers in `~/.soreqen/mcp.json`. */
export function saveUserServer(soreqenHome: string, name: string, config: McpServerConfig): void {
  if (!SERVER_NAME.test(name)) throw new Error(`"${name}" is not a usable server name (letters, digits, - and _, up to 32).`);
  const checked = checkServer(config);
  if (typeof checked === "string") throw new Error(checked);
  editUserFile(soreqenHome, (servers) => {
    servers[name] = checked;
  });
}

/** Remove one of the person's own servers. Returns whether it was there. */
export function removeUserServer(soreqenHome: string, name: string): boolean {
  let found = false;
  editUserFile(soreqenHome, (servers) => {
    found = name in servers;
    delete servers[name];
  });
  return found;
}

function editUserFile(soreqenHome: string, change: (servers: Record<string, unknown>) => void): void {
  const file = join(soreqenHome, "mcp.json");
  let doc: { mcpServers?: Record<string, unknown> } & Record<string, unknown> = {};
  if (existsSync(file)) {
    try {
      doc = JSON.parse(readFileSync(file, "utf8")) as typeof doc;
    } catch {
      throw new Error(`${file} is not valid JSON; fix it by hand before changing it here.`);
    }
  }
  const servers = { ...(doc.mcpServers ?? {}) };
  change(servers);
  mkdirSync(soreqenHome, { recursive: true });
  writeFileSync(`${file}.tmp`, `${JSON.stringify({ ...doc, mcpServers: servers }, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  renameSync(`${file}.tmp`, file);
}
