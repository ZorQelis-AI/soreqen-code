/**
 * Connector tools, offered by name until one is needed.
 *
 * Every tool of every connected app (MCP server) went to the model in full on
 * every request. Three connectors came to about 35,000 tokens of schemas: a
 * new session opened at 68,700 tokens with nothing said yet, 43,300 of them
 * tools, and a checkpoint could never bring a session below about 100,000
 * (reported 29 Oct 2026). Most turns use none of them.
 *
 * So past `DEFER_EXTERNAL_TOOLS_AT`, connector tools are listed by name in one
 * small tool, `load_tools`, and a tool's definition joins the tool list once
 * the model loads it, or once it has been called in the conversation. SoreQen's
 * own tools, and an app's tools that are not an MCP server's (the connectors
 * manager), are always offered. The list in `load_tools` is the same text on
 * every request, so the cached prefix holds; loading appends to the tool list.
 */

import type { ExternalToolDefinition } from "./external-tools.js";
import type { LLMMessage } from "./types.js";

export const LOAD_TOOLS = "load_tools";

/** Connector schemas larger than this (in tokens, about 12,000 characters) are deferred. Smaller ones cost less than a step spent loading them. */
export const DEFER_EXTERNAL_TOOLS_AT = 3_000;

/** A tool that may be deferred: an MCP server's. */
export function isDeferrable(name: string): boolean {
  return name.startsWith("mcp__");
}

/** Whether these connector tools are worth deferring. */
export function shouldDefer(definitions: ExternalToolDefinition[]): boolean {
  const deferrable = definitions.filter((d) => isDeferrable(d.name));
  return deferrable.length > 0 && JSON.stringify(deferrable).length / 4 > DEFER_EXTERNAL_TOOLS_AT;
}

/** `mcp__<server>__<tool>`, split. */
export function splitToolName(name: string): { server: string; tool: string } {
  const rest = name.startsWith("mcp__") ? name.slice(5) : name;
  const at = rest.indexOf("__");
  return at < 0 ? { server: "", tool: rest } : { server: rest.slice(0, at), tool: rest.slice(at + 2) };
}

/** Connector tools already in use earlier in the conversation: called, or named in a load_tools call. */
export function loadedIn(history: readonly LLMMessage[]): Set<string> {
  const loaded = new Set<string>();
  for (const m of history) {
    for (const call of m.toolCalls ?? []) {
      if (isDeferrable(call.name)) loaded.add(call.name);
      if (call.name === LOAD_TOOLS) {
        const names = call.input["names"];
        if (Array.isArray(names)) for (const n of names) if (typeof n === "string" && isDeferrable(n)) loaded.add(n);
      }
    }
  }
  return loaded;
}

/** The first sentence of a description, short. */
function gist(description: string, max = 90): string {
  const first = description.replace(/\s+/g, " ").trim().split(/(?<=[.!?])\s/)[0] ?? "";
  return first.length > max ? `${first.slice(0, max - 1).trimEnd()}…` : first;
}

/** The `load_tools` definition, listing every connector tool by server. */
export function loadToolsDefinition(definitions: ExternalToolDefinition[]): ExternalToolDefinition {
  const byServer = new Map<string, string[]>();
  for (const d of definitions) {
    if (!isDeferrable(d.name)) continue;
    const { server, tool } = splitToolName(d.name);
    const line = d.description ? `${tool}: ${gist(d.description)}` : tool;
    byServer.set(server, [...(byServer.get(server) ?? []), line]);
  }
  const listing = [...byServer.entries()].map(([server, tools]) => `${server} (call as mcp__${server}__<tool>):\n${tools.map((t) => `  - ${t}`).join("\n")}`);
  return {
    name: LOAD_TOOLS,
    description: [
      "Load tools from the apps the person connected (MCP servers) before calling them. Their full definitions are left",
      "out of your tool list until needed, to keep the context small. Name the tools you need, or a server for all of",
      "its tools; they are in your tool list from your next step, for the rest of the session. Loading costs nothing:",
      "load what the task needs without asking. Available:",
      ...listing,
    ].join("\n"),
    input_schema: {
      type: "object",
      properties: {
        names: {
          type: "array",
          items: { type: "string" },
          description: "Tool names (mcp__server__tool, or just the tool's name) or server names, to load all of a server's tools",
        },
      },
      required: ["names"],
    },
  };
}

/** The connector tools a load_tools call asks for, and the names that matched none. */
export function resolveToolNames(asked: unknown, definitions: ExternalToolDefinition[]): { found: string[]; unknown: string[] } {
  const names = (Array.isArray(asked) ? asked : typeof asked === "string" ? [asked] : []).filter(
    (n): n is string => typeof n === "string" && n.trim().length > 0,
  );
  const deferrable = definitions.filter((d) => isDeferrable(d.name)).map((d) => d.name);
  const found = new Set<string>();
  const unknown: string[] = [];
  for (const raw of names) {
    const name = raw.trim();
    const lower = name.toLowerCase();
    const matches = deferrable.filter((full) => {
      const { server, tool } = splitToolName(full);
      return (
        full.toLowerCase() === lower ||
        `${server}__${tool}`.toLowerCase() === lower ||
        tool.toLowerCase() === lower ||
        server.toLowerCase() === lower
      );
    });
    if (matches.length === 0) unknown.push(name);
    for (const m of matches) found.add(m);
  }
  return { found: [...found], unknown };
}
