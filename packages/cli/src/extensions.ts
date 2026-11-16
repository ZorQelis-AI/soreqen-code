/**
 * Skills and MCP servers, as the CLI sets them up.
 *
 * Everything lives in `~/.soreqen/`, shared with the desktop app, so a skill
 * switched off or a server added in one is the same in the other:
 *
 *   config.json      { "disabledSkills": [...] }
 *   skills/<name>/SKILL.md   the person's own skills, the only folder of them read
 *   mcp.json         the person's own MCP servers
 *   mcp-trust.json   which projects' servers they agreed to run
 */

import { homedir } from "node:os";
import { join } from "node:path";
import chalk from "chalk";
import { BUILTIN_SKILLS, SkillSet, readUserSkills, skillName, type SkillOptions } from "@sqcode/orchestrator";
import { McpTrust, connectMcp, type McpHub, type McpServerEntry } from "@sqcode/mcp";
import { ask, loadUserConfig, saveUserConfig } from "./setup.js";

export function soreqenHome(): string {
  return process.env["SOREQEN_HOME"]?.trim() || join(homedir(), ".soreqen");
}

/**
 * The person's skills: `~/.soreqen/skills`, and no other folder. Reading
 * `~/.agents/skills` and `~/.claude/skills` too was undone on 16 Oct 2026:
 * skills installed for other agents are not SoreQen's.
 */
function personalSkills(): ReturnType<typeof readUserSkills> {
  return readUserSkills(join(soreqenHome(), "skills"));
}

/** What the agent gets: all of SoreQen's skills minus what is off, plus the person's own. */
export async function skillOptions(): Promise<SkillOptions> {
  return {
    disabled: loadUserConfig().disabledSkills ?? [],
    custom: (await personalSkills()).skills,
    userDir: join(soreqenHome(), "skills"),
  };
}

/** Switch a skill on or off. Returns the canonical name, or null when there is no such skill. */
export async function setSkillEnabled(raw: string, enabled: boolean): Promise<string | null> {
  const name = skillName(raw);
  const mine = (await personalSkills()).skills;
  const known = [...BUILTIN_SKILLS, ...mine].some((s) => s.name === name);
  if (!known) return null;
  const off = new Set(loadUserConfig().disabledSkills ?? []);
  if (enabled) off.delete(name);
  else off.add(name);
  saveUserConfig({ disabledSkills: [...off].sort() });
  return name;
}

/** `/skills` and `soreqen skills`: every skill, whether it is on, and what it is for. */
export async function describeSkills(): Promise<string[]> {
  const { skills: custom, problems } = await personalSkills();
  const off = new Set(loadUserConfig().disabledSkills ?? []);
  const all = SkillSet.from({ custom }).list();
  const lines: string[] = [];
  for (const [kind, heading] of [
    ["always", "Always on: applied to every task"],
    ["conditional", "Conditional: loaded when a task calls for them"],
  ] as const) {
    lines.push(chalk.bold(heading));
    for (const s of all.filter((x) => x.kind === kind)) {
      const state = off.has(s.name) ? chalk.red("off") : chalk.green("on ");
      const from = s.source === "user" ? chalk.cyan(" (yours)") : "";
      lines.push(`  ${state} ${s.name.padEnd(20)} ${chalk.dim(s.description)}${from}`);
    }
    lines.push("");
  }
  if (problems.length > 0) {
    lines.push(chalk.yellow.bold("Not loaded: fix these in ~/.soreqen/skills"));
    for (const p of problems) lines.push(chalk.yellow(`  ! ${p}`));
    lines.push("");
  }
  lines.push(chalk.dim("  soreqen skills disable <name> · enable <name> · your own go in ~/.soreqen/skills/<name>/SKILL.md"));
  return lines;
}

function describeServer(s: McpServerEntry): string {
  const c = s.config;
  return c.type === "stdio" || !c.type ? `${c.command} ${(c.args ?? []).join(" ")}`.trim() : `${c.type} ${c.url}`;
}

/**
 * Connect this project's MCP servers.
 *
 * A project's own servers (`.mcp.json`, `.soreqen/mcp.json`) are commands a
 * repository wants run on this machine, so the person is shown exactly what
 * they are and asked — once per configuration. Without a terminal to ask in,
 * they are left off and the person is told how to allow them.
 */
export async function openMcp(projectDir: string, interactive: boolean): Promise<McpHub> {
  const home = soreqenHome();
  let opened = await connectMcp({ soreqenHome: home, projectDir });
  for (const problem of opened.configs.problems) console.log(chalk.yellow(`  MCP: ${problem}`));

  if (!opened.trusted && opened.configs.project.length > 0 && opened.configs.projectHash) {
    if (!interactive) {
      console.log(chalk.dim(`  This project configures ${opened.configs.project.length} MCP server(s); run \`soreqen mcp trust\` here to allow them.`));
    } else {
      console.log(`\n  ${chalk.bold("This project wants to run MCP servers:")}`);
      for (const s of opened.configs.project) console.log(`    ${chalk.cyan(s.name.padEnd(16))} ${describeServer(s)}  ${chalk.dim(s.file)}`);
      console.log(chalk.dim("  They run as programs on this computer, with your permissions. Only allow ones you trust."));
      const answer = (await ask("  Allow them for this folder? [y/N] ")).trim().toLowerCase();
      if (answer === "y" || answer === "yes") {
        new McpTrust(join(home, "mcp-trust.json")).trust(projectDir, opened.configs.projectHash);
        await opened.hub.close();
        opened = await connectMcp({ soreqenHome: home, projectDir });
      }
    }
  }

  const failed = opened.hub.status().filter((s) => s.state === "failed");
  for (const s of failed) console.log(chalk.yellow(`  MCP server ${s.name} is not available: ${s.error}`));
  return opened.hub;
}

/** `/mcp` and `soreqen mcp list`. */
export function describeMcp(hub: McpHub | null): string[] {
  const status = hub?.status() ?? [];
  if (status.length === 0) {
    return [
      chalk.dim("No MCP servers. Add one:"),
      chalk.dim("  soreqen mcp add <name> -- <command> [args…]      e.g. soreqen mcp add fs -- npx -y @modelcontextprotocol/server-filesystem ."),
      chalk.dim("  soreqen mcp add <name> --url https://…/mcp"),
      chalk.dim("or put a .mcp.json in the project."),
    ];
  }
  return status.map((s) => {
    const mark =
      s.state === "connected" ? chalk.green("●") : s.state === "failed" ? chalk.red("●") : chalk.dim("○");
    const detail =
      s.state === "connected"
        ? chalk.dim(`${s.tools.length} tool${s.tools.length === 1 ? "" : "s"}: ${s.tools.slice(0, 6).join(", ")}${s.tools.length > 6 ? ", …" : ""}`)
        : chalk.dim(s.state === "untrusted" ? "not allowed yet: soreqen mcp trust" : s.error ?? s.state);
    const extra = s.features?.length ? chalk.cyan(` +${s.features.join(", ")}`) : "";
    const log = s.log?.length ? `\n${s.log.slice(-2).map((l) => `      ${chalk.dim(l)}`).join("\n")}` : "";
    return `${mark} ${s.name.padEnd(16)} ${chalk.dim(`${s.origin} · ${s.transport}`)}  ${detail}${extra}${log}`;
  });
}

/** A running MCP tool's progress, for the spinner: "3/10 · fetching issues". */
export function progressDetail(p: { progress?: number; total?: number; message?: string }): string | undefined {
  const count =
    p.progress === undefined ? "" : p.total !== undefined && p.total > 0 ? (p.total === 100 ? `${Math.round(p.progress)}%` : `${p.progress}/${p.total}`) : String(p.progress);
  const message = p.message?.replace(/\s+/g, " ").trim().slice(0, 60) ?? "";
  return [count, message].filter(Boolean).join(" · ") || undefined;
}

/**
 * `/prompt server/name key=value …`: which prompt, and its arguments.
 * Values may be quoted to hold spaces. Null when there is no `server/name`.
 */
export function parsePromptCommand(spec: string): { server: string; name: string; args: Record<string, string> } | null {
  const head = /^([A-Za-z0-9_-]+)[/:]([^\s]+)/.exec(spec.trim());
  if (!head) return null;
  const args: Record<string, string> = {};
  const rest = spec.trim().slice(head[0].length);
  for (const m of rest.matchAll(/([A-Za-z_][\w-]*)=(?:"([^"]*)"|'([^']*)'|(\S+))/g)) {
    args[m[1]!] = m[2] ?? m[3] ?? m[4] ?? "";
  }
  return { server: head[1]!, name: head[2]!, args };
}

/** `/prompts`: what the connected servers offer the person to start from. */
export async function describePrompts(hub: McpHub | null): Promise<string[]> {
  const prompts = (await hub?.listPrompts()) ?? [];
  if (prompts.length === 0) return [chalk.dim("No connected MCP server offers prompts.")];
  const lines: string[] = [];
  for (const p of prompts) {
    const args = p.arguments.map((a) => (a.required ? `${a.name}=…` : `[${a.name}=…]`)).join(" ");
    lines.push(`${chalk.bold(`${p.server}/${p.name}`)}${args ? ` ${chalk.dim(args)}` : ""}`);
    if (p.description) lines.push(`  ${chalk.dim(p.description)}`);
  }
  lines.push("", chalk.dim("Use one: /prompt server/name key=value …  (quote values with spaces)"));
  return lines;
}

/**
 * Fill in a prompt for `/prompt`, or say what is missing. The text is sent as
 * the person's own next message: MCP prompts are theirs to choose, never the
 * agent's, which is why they are a command and not a tool.
 */
export async function fillPrompt(hub: McpHub | null, spec: string): Promise<{ text: string } | { error: string }> {
  const parsed = parsePromptCommand(spec);
  if (!parsed) return { error: "Say which prompt: /prompt server/name key=value …  (/prompts lists them)" };
  if (!hub) return { error: "No MCP servers are connected." };
  const known = (await hub.listPrompts()).find((p) => p.server === parsed.server && p.name === parsed.name);
  if (!known) return { error: `No prompt ${parsed.server}/${parsed.name}. /prompts lists them.` };
  const missing = known.arguments.filter((a) => a.required && !(a.name in parsed.args)).map((a) => a.name);
  if (missing.length > 0) return { error: `${parsed.server}/${parsed.name} needs ${missing.map((m) => `${m}=…`).join(" ")}` };
  try {
    const { text } = await hub.getPrompt(parsed.server, parsed.name, parsed.args);
    return text.trim() ? { text } : { error: `${parsed.server}/${parsed.name} came back empty.` };
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) };
  }
}
