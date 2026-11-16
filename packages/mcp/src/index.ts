export * from "./config.js";
export * from "./hub.js";
export * from "./oauth.js";

import { join } from "node:path";
import { McpTrust, readMcpConfigs, type McpConfigs } from "./config.js";
import { McpHub, type McpHubOptions } from "./hub.js";

/**
 * Connect the servers for one project: the person's own, and the project's
 * if the person has agreed to this exact configuration.
 *
 * What a host (the CLI, the desktop app) calls when a session opens a folder.
 * Untrusted project servers are listed in the hub's status as `untrusted`, so
 * the host can offer to approve them — they are never started.
 */
export async function connectMcp(opts: {
  soreqenHome: string;
  projectDir?: string | null;
  hub?: Omit<McpHubOptions, "untrusted">;
}): Promise<{ hub: McpHub; configs: McpConfigs; trusted: boolean }> {
  const configs = readMcpConfigs({ soreqenHome: opts.soreqenHome, projectDir: opts.projectDir ?? null });
  const trust = new McpTrust(join(opts.soreqenHome, "mcp-trust.json"));
  const trusted = !!opts.projectDir && trust.isTrusted(opts.projectDir, configs.projectHash);
  const hub = await McpHub.connect(trusted ? [...configs.user, ...configs.project] : configs.user, {
    ...(opts.projectDir ? { cwd: opts.projectDir } : {}),
    oauthDir: join(opts.soreqenHome, "mcp-auth"),
    ...(opts.hub ?? {}),
    untrusted: trusted ? [] : configs.project,
  });
  return { hub, configs, trusted };
}
