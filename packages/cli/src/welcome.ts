/**
 * The CLI's face: the welcome screen, the prompt, the command palette, and
 * how a tool call and its result read.
 *
 * Modelled on OpenCode's terminal, which reads as one calm surface:
 *
 *   - **A wordmark, centered**: SOREQEN in block letters ("SORE" quiet,
 *     "QEN" bright, the Q's tail in Quantum Lime), a greeting, and what will
 *     answer (model, mode, effort) and where (the folder). No box around it.
 *   - **A barred prompt**: a lime bar down the left of the input, the mode,
 *     model and effort on the line under it, and the keys worth knowing
 *     under that. What was typed stays in the transcript with its bar.
 *   - **A command palette**: type `/` and every command is listed under the
 *     input, narrowing as you type; Tab completes the first.
 *   - **Tool calls as a verb and a target** (`● Read  src/auth.ts`), each
 *     answered by one dim line under it (`⎿  120 lines`).
 *
 * Everything degrades: no colour under NO_COLOR or a pipe, ASCII where the
 * terminal has no box-drawing glyphs, a smaller wordmark in a narrow window.
 */

import { c, glyph, prettyPath, truncate } from "./theme.js";

const ANSI = /\x1b\[[0-9;]*[A-Za-z]/g;
const ANSI_PART = /^\x1b\[[0-9;]*[A-Za-z]$/;

/** Printed width: what the escape codes do not take. */
export function visible(text: string): number {
  return [...text.replace(ANSI, "")].length;
}

function padEnd(text: string, w: number): string {
  return text + " ".repeat(Math.max(0, w - visible(text)));
}

function center(text: string, w: number): string {
  const room = Math.max(0, w - visible(text));
  return " ".repeat(Math.floor(room / 2)) + text;
}

/** Cut a coloured string to `w` printed columns (colour codes kept, an ellipsis added). */
function fit(text: string, w: number): string {
  if (visible(text) <= w) return text;
  let out = "";
  let shown = 0;
  for (const part of text.split(/(\x1b\[[0-9;]*[A-Za-z])/)) {
    if (ANSI_PART.test(part)) {
      out += part;
      continue;
    }
    for (const ch of part) {
      if (shown >= w - 1) return text.includes("\x1b") ? `${out}…\x1b[0m` : `${out}…`;
      out += ch;
      shown++;
    }
  }
  return out;
}

const fancy = glyph.rule === "─";
/** The bar down the left of the prompt (and of what was typed at it). */
export const BAR = fancy ? "┃" : "|";

/*
 * SOREQEN in block letters (figlet's "ANSI Regular"), one string per row.
 * The Q's tail is its own row so it can be lit.
 */
const LETTERS: Record<string, string[]> = {
  S: ["███████ ", "██      ", "███████ ", "     ██ ", "███████ "],
  O: [" ██████  ", "██    ██ ", "██    ██ ", "██    ██ ", " ██████  "],
  R: ["██████  ", "██   ██ ", "██████  ", "██   ██ ", "██   ██ "],
  E: ["███████ ", "██      ", "█████   ", "██      ", "███████ "],
  Q: [" ██████  ", "██    ██ ", "██    ██ ", "██ ▄▄ ██ ", " ██████  "],
  N: ["███    ██", "████   ██", "██ ██  ██", "██  ██ ██", "██   ████"],
};
const WORDMARK_WIDTH = 60;

/** The wordmark's rows: "SORE" quiet, "QEN" bright, the Q's tail lime. */
export function wordmarkLines(columns = process.stdout.columns ?? 80): string[] {
  if (!fancy || columns < WORDMARK_WIDTH + 4) {
    // Narrow, or no block glyphs: the name, set the same way.
    return [`${c.muted.bold("Sore")}${c.text.bold("Qen")} ${c.brand.bold("Code")}`];
  }
  const rows: string[] = [];
  for (let r = 0; r < 5; r++) {
    const sore = ["S", "O", "R", "E"].map((l) => LETTERS[l]![r]).join("");
    const qRow = LETTERS["Q"]![r]!;
    const q = r === 3 ? `${c.text.bold("██ ")}${c.brand.bold("▄▄")}${c.text.bold(" ██ ")}` : c.text.bold(qRow);
    const en = ["E", "N"].map((l) => LETTERS[l]![r]).join("");
    rows.push(`${c.muted.bold(sore)}${q}${c.text.bold(en)}`);
  }
  rows.push(`${" ".repeat(33 + 4)}${c.brand.bold("▀▀")}${" ".repeat(WORDMARK_WIDTH - 39)}`);
  return rows;
}

export interface WelcomeState {
  version?: string;
  name?: string | null;
  model: string;
  mode: string;
  effort: string;
  workspaceDir: string;
  /** What was asked here last, newest first, with how long ago. */
  recent?: { text: string; age: string }[];
  /** Warnings that belong on the first screen (a clamped tier, no checkpoints, an update). */
  notes?: string[];
}

/** The welcome screen: centered, no box, OpenCode's calm. Every line fits `columns`. */
export function welcomeLines(state: WelcomeState, columns = process.stdout.columns ?? 80): string[] {
  // Centered on the whole window; nothing wider than 100 columns.
  const w = Math.max(30, columns - 1);
  const out: string[] = [""];
  for (const line of wordmarkLines(columns)) out.push(center(fit(line, w), w));
  out.push("");

  const who = state.name?.trim() ? `Welcome back ${state.name.trim().split(/\s+/)[0]}!` : "Welcome to SoreQen Code";
  out.push(center(fit(`${c.text(who)}${state.version ? `  ${c.faint(`v${state.version}`)}` : ""}`, w), w));
  out.push("");

  const field = (label: string, value: string): string => `${c.faint(label)} ${value}`;
  const settings = [field("model", c.brand(state.model)), field("mode", c.text(state.mode)), field("effort", c.muted(state.effort))].join("   ");
  out.push(center(fit(settings, w), w));
  out.push(center(fit(c.muted(truncate(prettyPath(state.workspaceDir), Math.min(w, 100) - 4)), w), w));

  const recent = (state.recent ?? [])
    .filter((r, i, all) => all.findIndex((x) => x.text.trim() === r.text.trim()) === i)
    .slice(0, 3);
  if (recent.length > 0) {
    out.push("");
    const textW = Math.min(64, w - 16);
    const rows = recent.map((r) => {
      // A request reads from its start (unlike a path, which reads from its end).
      const text = r.text.replace(/\s+/g, " ").trim();
      return `${c.text(padEnd(text.length > textW ? `${text.slice(0, textW - 1)}…` : text, textW))}  ${c.faint(r.age)}`;
    });
    const blockW = Math.max(...rows.map(visible));
    const indent = " ".repeat(Math.max(0, Math.floor((w - blockW) / 2)));
    out.push(`${indent}${c.faint("Recent")}`);
    for (const row of rows) out.push(`${indent}${fit(row, w - indent.length)}`);
  }

  for (const note of state.notes ?? []) out.push(center(fit(`${c.warn(glyph.warn)} ${c.muted(note)}`, w), w));
  return out;
}

/* ------------------------------------------------------------------------ */
/* Commands                                                                  */
/* ------------------------------------------------------------------------ */

export interface CommandInfo {
  name: string;
  args?: string;
  description: string;
}

/** Every command, in the order the palette and /help list them. */
export const COMMANDS: CommandInfo[] = [
  { name: "/help", description: "every command and key" },
  { name: "/model", args: "[name]", description: "list models, or switch to one" },
  { name: "/mode", args: "plan|manual|auto|bypass", description: "how much SoreQen asks before acting" },
  { name: "/effort", args: "low|medium|high|extra|max", description: "how hard it thinks" },
  { name: "/style", args: "[name]", description: "how SoreQen writes" },
  { name: "/goal", args: "<objective>|stop|resume", description: "keep working, turn after turn, until it is done" },
  { name: "/new", description: "a fresh conversation" },
  { name: "/clear", description: "start this conversation over (files are kept)" },
  { name: "/rewind", args: "[turn]", description: "undo a turn's changes to the files" },
  { name: "/checkpoints", description: "the points you can rewind to" },
  { name: "/context", description: "how full the context window is" },
  { name: "/checkpoint", description: "move older turns into task memory now" },
  { name: "/checkpoint-at", args: "200k|50|default", description: "when to checkpoint" },
  { name: "/memory", args: "[forget <name>]", description: "what SoreQen remembers" },
  { name: "/skills", description: "skills, which are on, and your own" },
  { name: "/mcp", description: "MCP servers and their tools" },
  { name: "/prompts", description: "prompts your MCP servers offer" },
  { name: "/prompt", args: "server/name key=value", description: "use an MCP prompt" },
  { name: "/ps", description: "commands SoreQen started" },
  { name: "/stop", args: "<id>|all", description: "stop a running command" },
  { name: "/map", description: "the repository map it works from" },
  { name: "/rules", description: "the project rulebook" },
  { name: "/tier", description: "this workspace's permission ceiling" },
  { name: "/usage", description: "your SoreQen credits and limits" },
  { name: "/burst", description: "switch Burst Day on (once a week)" },
  { name: "/keys", description: "which of your own API keys are set" },
  { name: "/login", description: "sign in with SoreQen" },
  { name: "/logout", description: "sign this machine out" },
  { name: "/audit", description: "where the audit trail is written" },
  { name: "/cls", description: "clear the screen" },
  { name: "/exit", description: "quit" },
];

/** The commands a partly typed `/word` could be: by prefix first, then by a match anywhere. */
export function matchCommands(typed: string, commands: CommandInfo[] = COMMANDS): CommandInfo[] {
  const t = typed.trim().toLowerCase();
  if (!t.startsWith("/") || /\s/.test(t)) return [];
  if (t === "/") return commands;
  const word = t.slice(1);
  const prefix = commands.filter((cmd) => cmd.name.slice(1).startsWith(word));
  // Then by a part of the name, and from three letters on, by what the command does.
  const inside = commands.filter(
    (cmd) => !prefix.includes(cmd) && (cmd.name.includes(word) || (word.length >= 3 && cmd.description.includes(word))),
  );
  return [...prefix, ...inside];
}

/** The palette's rows: the first is the one Tab takes. */
export function paletteLines(matches: CommandInfo[], columns = process.stdout.columns ?? 80, max = 8): string[] {
  const w = Math.max(30, columns - 1);
  if (matches.length === 0) return [`  ${c.faint("no command by that name")}`];
  const nameW = Math.max(...matches.slice(0, max).map((m) => m.name.length)) + 2;
  const rows = matches.slice(0, max).map((m, i) => {
    const mark = i === 0 ? c.brand(fancy ? "›" : ">") : " ";
    const name = i === 0 ? c.brand.bold(m.name.padEnd(nameW)) : c.text(m.name.padEnd(nameW));
    const rest = `${m.args ? `${c.faint(m.args)}  ` : ""}${c.muted(m.description)}`;
    return fit(`  ${mark} ${name}${rest}`, w);
  });
  if (matches.length > max) rows.push(`    ${c.faint(`and ${matches.length - max} more · keep typing`)}`);
  return rows;
}

/* ------------------------------------------------------------------------ */
/* The prompt                                                                */
/* ------------------------------------------------------------------------ */

const EXAMPLES = [
  'Ask anything... "fix the failing test in <file>"',
  'Ask anything... "add dark mode to the settings page"',
  'Ask anything... "explain how auth works here"',
  'Ask anything... "research the best way to <do something>"',
  'Ask anything... "refactor <filepath>"',
];

/**
 * Around the idle prompt: a dim example in the input, and under it the
 * status line and the hints, or the command palette while a `/word` is being
 * typed. Drawn after readline prints the prompt; the example is erased by the
 * first key, and everything under the input is cleared when the line is
 * sent, so the transcript keeps only `┃ what was typed`.
 */
export interface PromptFrame {
  /** Before `rl.prompt()`: a blank line, to set the prompt apart. */
  before(): void;
  /** After `rl.prompt()`: the example in the input, and the lines under it. */
  after(status: string, promptWidth?: number): void;
  /** On a key, with what is now typed and where the cursor is in it. */
  key(line?: string, cursor?: number): void;
  /** On a sent line: clear what was drawn under the input. */
  sent(): void;
}

export function createPromptFrame(enabled: boolean, out: NodeJS.WriteStream = process.stdout): PromptFrame {
  let example = false;
  let drawnBelow = false;
  let n = 0;
  let status = "";
  let width = 2;

  const hints = (): string => {
    const k = (key: string, what: string): string => `${c.text(key)} ${c.muted(what)}`;
    return `  ${[k("enter", "send"), k("/", "commands"), k("?", "shortcuts"), k("ctrl+c", "stop")].join(c.faint("   "))}`;
  };

  /*
   * Draw `lines` under the input and come back to the cursor.
   *
   * Relative moves, not a saved cursor (ESC 7 / ESC 8): a saved position is a
   * place on the screen, and when drawing these lines scrolls the screen, it
   * lands rows low, where the next output then overwrote the frame.
   */
  /** Lines are drawn under the input only while it fits on one row (see `key`). */
  let quiet = false;
  const below = (lines: string[], line: string, cursor: number): void => {
    const at = width + [...line.slice(0, cursor)].length;
    out.write(`\r\n\x1b[J${lines.join("\r\n")}\x1b[${lines.length}A\x1b[${at + 1}G`);
    drawnBelow = true;
  };

  return {
    before() {
      if (!enabled) return;
      out.write("\n");
    },
    after(nextStatus: string, promptWidth = 2) {
      if (!enabled) return;
      status = nextStatus;
      width = promptWidth;
      quiet = false;
      const w = Math.max(20, (out.columns ?? 80) - 1);
      const sample = EXAMPLES[n++ % EXAMPLES.length]!;
      out.write(c.faint(truncate(sample, Math.max(10, w - promptWidth - 2))));
      below([`${c.brand(BAR)} ${status}`, hints()], "", 0);
      example = true;
    },
    key(line = "", cursor = line.length) {
      if (!enabled) return;
      if (example) {
        example = false;
        // Whatever the example left after the cursor on the input line.
        out.write("\x1b[K");
      }
      if (!drawnBelow) return;
      /*
       * Drawn again on every key, not only when the palette changes: readline
       * clears everything under the input whenever it redraws the line (a
       * backspace, a history step, a completion), and the hints went with it.
       */
      /*
       * A line about to wrap onto a second row: stop drawing under it. Every
       * key redrew the lines below at a position worked out for one row, and
       * readline's own wrapping moved the row under them, so a long message
       * came out garbled ("ew itd notes.txt…"). Cleared once instead; the
       * hints come back when the line is short again.
       */
      if (width + [...line].length >= Math.max(20, out.columns ?? 80) - 1) {
        if (!quiet && cursor === line.length) out.write("\x1b[J");
        quiet = true;
        return;
      }
      quiet = false;
      const typing = line.startsWith("/") && !/\s/.test(line.trim());
      if (typing) {
        below([`${c.brand(BAR)}`, ...paletteLines(matchCommands(line), out.columns ?? 80)], line, cursor);
      } else {
        below([`${c.brand(BAR)} ${status}`, hints()], line, cursor);
      }
    },
    sent() {
      if (!enabled || !drawnBelow) return;
      drawnBelow = false;
      example = false;
      // The cursor is on the line under the input now: clear it and below.
      out.write("\x1b[J");
    },
  };
}

/** The status under the input: mode · model · effort. */
export function promptStatus(mode: string, model: string, effort: string): string {
  return `${c.brand.bold(mode)}  ${c.text(model)} ${c.faint(glyph.dot)} ${c.muted(effort)}`;
}

/** `?`: the keys, then the commands. */
export function shortcutLines(): string[] {
  const k = (key: string, what: string): string => `  ${c.text(key.padEnd(16))}${c.muted(what)}`;
  return [
    "",
    `  ${c.brand.bold("Keys")}`,
    k("enter", "send; while it works, add to the task"),
    k("ctrl+c", "stop the turn; at the prompt, quit"),
    k("↑ / ↓", "earlier messages"),
    k("/", "the command list, narrowing as you type"),
    k("tab", "complete the first command in the list"),
    k("?", "this list"),
    "",
    `  ${c.brand.bold("Commands")}`,
    ...COMMANDS.map((cmd) => k(cmd.name, `${cmd.args ? `${cmd.args}  ` : ""}${cmd.description}`)),
    "",
  ];
}

/* ------------------------------------------------------------------------ */
/* Tool calls                                                                */
/* ------------------------------------------------------------------------ */

const s = (v: unknown): string => (typeof v === "string" ? v : v === undefined || v === null ? "" : JSON.stringify(v));

const PARTS: Record<string, (i: Record<string, unknown>) => [string, string]> = {
  read_file: (i) => ["Read", s(i["path"])],
  edit_file: (i) => ["Update", s(i["path"])],
  write_file: (i) => ["Write", s(i["path"])],
  list_directory: (i) => ["List", s(i["path"]) || "."],
  glob: (i) => ["Find", s(i["pattern"])],
  grep_search: (i) => ["Search", s(i["query"])],
  run_command: (i) => ["Bash", s(i["command"])],
  run_tests: () => ["Test", ""],
  git_operation: (i) => ["Git", s(i["operation"])],
  install_package: (i) => ["Install", s(i["package_name"])],
  web_search: (i) => ["Web search", s(i["query"])],
  fetch_url_content: (i) => ["Fetch", s(i["url"])],
  research: (i) => [i["depth"] === "deep" ? "Deep research" : "Research", s(i["question"])],
  update_todo_list: () => ["Plan", ""],
  browser_open: (i) => ["Open", s(i["url"])],
  browser_snapshot: () => ["Read page", ""],
  browser_screenshot: () => ["Screenshot", ""],
  browser_interact: (i) => ["Browser", s(i["action"])],
  browser_batch: (i) => ["Browser", Array.isArray(i["steps"]) ? (i["steps"] as Array<Record<string, unknown>>).map((x) => s(x["action"])).join(" → ") : ""],
  browser_console_logs: () => ["Console", ""],
  find_symbol_definition: (i) => ["Find", s(i["symbol_name"])],
  find_symbol_references: (i) => ["References", s(i["symbol_name"])],
  code_graph: (i) => ["Code graph", [s(i["action"]), s(i["target"] ?? i["name"] ?? i["path"] ?? i["query"])].filter(Boolean).join(" ")],
  spawn_subagent: (i) => ["Delegate", s(i["role"])],
  subagent_status: () => ["Check agents", ""],
  use_skill: (i) => ["Skill", s(i["name"])],
  remember: (i) => ["Remember", s(i["name"])],
  recall: (i) => ["Recall", s(i["name"] ?? i["query"])],
  view_image: (i) => ["View", s(i["path"])],
  ask_user: () => ["Ask", ""],
  process_status: () => ["Processes", ""],
  stop_process: (i) => ["Stop", s(i["id"] ?? i["pid"])],
  wait: (i) => ["Wait", i["seconds"] ? `${s(i["seconds"])}s` : ""],
};

export function toolParts(tool: string, input: Record<string, unknown>): { verb: string; target: string } {
  const p = PARTS[tool];
  if (p) {
    const [verb, target] = p(input);
    return { verb, target };
  }
  const m = /^mcp__(.+?)__(.+)$/.exec(tool);
  if (m) return { verb: m[1]!, target: m[2]!.replace(/_/g, " ") };
  return { verb: tool.replace(/_/g, " ").replace(/^./, (x) => x.toUpperCase()), target: "" };
}

const dotGlyph = glyph.rule === "─" ? "●" : "*";
const elbow = glyph.rule === "─" ? "⎿" : "\\_";

/** `● Read  src/auth/session.ts` */
export function toolLine(tool: string, input: Record<string, unknown>, columns = process.stdout.columns ?? 80): string {
  const { verb, target } = toolParts(tool, input);
  const room = Math.max(10, Math.min(columns, 120) - verb.length - 6);
  return `${c.brand(dotGlyph)} ${c.text.bold(verb)}${target ? `  ${c.muted(truncate(target.replace(/\s+/g, " "), room))}` : ""}`;
}

const count = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`;

/** What came of a call, in a few words. */
export function resultSummary(tool: string, output: unknown, success: boolean): string {
  /*
   * A tool result arrives as the text the model reads (orchestrator
   * tool-result.ts): optional WARNING lines, "FAILED: reason" on a failure,
   * then the data, usually as JSON. Read it back into the data.
   */
  if (typeof output === "string") {
    let body = output.replace(/^(WARNING: .*\n)+\n?/, "");
    const failed = /^FAILED: (.*)/.exec(body);
    if (failed) {
      if (!success) return `failed: ${failed[1]}`;
      body = body.slice(failed[0].length).trim();
    }
    try {
      const parsed = JSON.parse(body) as unknown;
      if (parsed && typeof parsed === "object") output = parsed;
    } catch {
      // Plain text: summarised as text below.
    }
  }
  const o = (output && typeof output === "object" ? output : {}) as Record<string, unknown>;
  const data = (o["data"] && typeof o["data"] === "object" ? o["data"] : o) as Record<string, unknown>;
  if (!success) {
    const why = s(o["error"] ?? data["error"] ?? (typeof output === "string" ? output : "")).split("\n")[0] ?? "";
    return why ? `failed: ${why}` : "failed";
  }
  const text = typeof output === "string" ? output : typeof data["content"] === "string" ? (data["content"] as string) : "";
  switch (tool) {
    case "read_file": {
      const n = typeof data["totalLines"] === "number" ? (data["totalLines"] as number) : text ? text.split("\n").length : 0;
      return n ? count(n, "line") : "read";
    }
    case "run_command":
    case "run_tests": {
      if (tool === "run_tests" && typeof data["passed"] === "boolean") return data["passed"] ? "tests passed" : "tests failed";
      const code = data["exitCode"] ?? data["exit_code"];
      const out = s(data["stdout"]).trim();
      const lines = out ? out.split("\n").length : 0;
      if (code === undefined) return "done";
      return lines ? `exit ${s(code)} · ${count(lines, "line")} of output` : `exit ${s(code)}`;
    }
    case "grep_search": {
      // "14 matches in 3 files" is the result's first line; older results were JSON with a matchCount.
      const head = /^([\d,]+\+? match(?:es)? in [\d,]+ files?)/.exec(text);
      if (head) return head[1]!;
      if (/^No matches/.test(text)) return "no matches";
      return typeof data["matchCount"] === "number" ? count(data["matchCount"] as number, "match", "matches") : "done";
    }
    case "glob": {
      // "12 files match **/*.ts, newest first:" is the result's first line; older results were JSON.
      const head = /^([\d,]+)\+? files? match/.exec(text);
      if (head) return count(Number(head[1]!.replace(/,/g, "")), "file");
      if (/^No file/.test(text)) return "no files";
      return typeof data["count"] === "number" ? count(data["count"] as number, "file") : "done";
    }
    case "list_directory": {
      // "24 entries in src (…):" likewise.
      const head = /^([\d,]+) entr(?:y|ies) in /.exec(text);
      if (head) return count(Number(head[1]!.replace(/,/g, "")), "entry", "entries");
      if (/ is empty\.$/.test(text.split("\n")[0] ?? "")) return "empty";
      return typeof data["count"] === "number" ? count(data["count"] as number, "entry", "entries") : "done";
    }
    case "edit_file": {
      // The model's copy says how big the change was; older results carried the diff itself.
      if (typeof data["added"] === "number" && typeof data["removed"] === "number") return `+${data["added"]} -${data["removed"]}`;
      const diff = s(data["diff"]);
      if (!diff) return "saved";
      const plus = (diff.match(/^\+(?!\+\+)/gm) ?? []).length;
      const minus = (diff.match(/^-(?!--)/gm) ?? []).length;
      return `+${plus} -${minus}`;
    }
    case "web_search": {
      const r = data["results"];
      return Array.isArray(r) ? count(r.length, "result") : "done";
    }
    case "research": {
      const r = data["sources"];
      return Array.isArray(r) ? `${count(r.length, "source")} read${data["report"] ? ", report written" : ""}` : "done";
    }
    case "write_file":
      return "saved";
    default:
      return "done";
  }
}

/** `  ⎿  120 lines` (or, when other output came between, `  ⎿  Read src/x.ts: 120 lines`). */
export function resultLine(summary: string, ok: boolean, label?: string): string {
  const paint = ok ? c.muted : c.danger;
  return `  ${c.muted(elbow)}  ${label ? c.muted(`${label}: `) : ""}${paint(summary)}`;
}

export { glyph };
