/**
 * What SoreQen Code looks like in a terminal.
 *
 * ## What was wrong with the old one
 *
 * A seven-line ASCII-art wordmark, six hardcoded hex values, emoji as
 * interface, and a fixed sixty-character rule. Each is a small thing; together
 * they made the tool look like a template.
 *
 * The banner was the worst of it. Block-capital ASCII art needs about 62
 * columns to be legible and degrades into noise below that — and it reprinted
 * in full on every `/clear`, spending twelve lines to say a name the user
 * already typed. Terminal real estate is the scarcest thing on the screen; the
 * header should cost as little of it as possible and then get out of the way.
 *
 * ## What replaced it
 *
 * A one-line lockup, and information ordered by how often it is needed:
 * the model and the **permission tier** first, because the tier is the only
 * line with a safety consequence; the workspace next; the commands last, dim,
 * where they can be found but do not compete.
 *
 * Emoji are gone. They are double-width in some terminals and single in
 * others, which silently misaligns every column after them, and they read as
 * clip-art next to monospaced text. See `theme.ts` for the glyph set and its
 * ASCII fallback.
 */

import readline from "node:readline";
import { format } from "node:util";
import { formatTokenCount, type ContextUsage, type TodoItem } from "@sqcode/shared";
import { formatTerminalMarkdown } from "./markdown-renderer.js";
import { resultLine, resultSummary, toolLine, toolParts, welcomeLines } from "./welcome.js";
import { c, effortStyle, glyph, markFrames, modeStyle, rule, tierStyle, truncate, width } from "./theme.js";

/** "42s", "3m 07s", "2h 05m". */
export function formatDuration(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${String(s % 60).padStart(2, "0")}s`;
  return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, "0")}m`;
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/**
 * What a tool call is doing, for the live line.
 *
 * "Creating index.html" while the model writes it — not "Thinking", which is
 * what the line used to say for the two minutes a large file takes.
 */
export function activityLabel(tool: string, input: Record<string, unknown>, pending = false): string {
  const path = typeof input["path"] === "string" ? input["path"] : "";
  const file = path ? (path.replace(/\\/g, "/").split("/").pop() ?? path) : "";
  switch (tool) {
    case "write_file":
      return file ? `Creating ${file}` : "Creating a file";
    case "edit_file":
      return file ? `Editing ${file}` : "Editing a file";
    case "read_file":
      return file ? `Reading ${file}` : "Reading";
    case "list_directory":
      return "Exploring";
    case "grep_search":
    case "glob":
    case "find_symbol_definition":
    case "find_symbol_references":
      return "Searching";
    case "run_command": {
      const description = typeof input["description"] === "string" ? input["description"].trim() : "";
      if (description && !pending) return truncate(description, 60);
      const command = typeof input["command"] === "string" ? input["command"].replace(/\s+/g, " ").trim() : "";
      return pending || !command ? "Preparing a command" : `Running ${truncate(command, 48)}`;
    }
    case "run_tests":
    case "run_affected_tests":
      return "Running tests";
    case "verify_changes":
      return "Verifying";
    case "web_search":
      return "Searching the web";
    case "fetch_url_content":
      return "Fetching";
    case "research":
      return "Researching";
    case "update_todo_list":
      return "Planning";
    case "spawn_subagent":
      return "Delegating";
    case "git_operation":
      return "Running git";
    case "install_package":
      return "Installing";
    case "use_skill":
      return "Loading a skill";
    case "list_mcp_resources":
    case "read_mcp_resource":
      return "Reading MCP resources";
    default:
      return tool.startsWith("browser_") ? "Using the browser" : (mcpToolLabel(tool) ?? "Working");
  }
}

const FRAMES = markFrames;

/** The live line under a working turn. See `createLiveLine`. */
export interface LiveLine {
  start(): void;
  set(label: string, detail?: string): void;
  setTokens(tokens: number | null): void;
  /** Hold the line still, for an approval. */
  pause(): void;
  resume(): void;
  /** Put a question where the live line was, so redraws keep it on screen. */
  ask(question: string, ask: (question: string) => Promise<string>): Promise<string>;
  /** Replace the line a message was typed on with a note of what happens to it. */
  echoQueued(text: string, note?: string): void;
  stop(): void;
}

/**
 * One line that says what the agent is doing, while it does it.
 *
 * `▽ Creating index.html 18.4 KB · 1m 04s · 12.3k tokens ❯` — the spinner, what
 * is happening this moment, how long the turn has run and how many tokens it
 * has used. It is drawn as the prompt itself, which is what lets someone keep
 * typing under a working agent: readline redraws the prompt *and* whatever has
 * been typed so far, so the line can tick without eating the input.
 *
 * Everything printed while it runs goes through `console.log`, which is routed
 * above the line for the duration, so output and the line never interleave.
 * Off when stdout is not a terminal — a pipe gets plain output.
 */
export function createLiveLine(options: {
  enabled: boolean;
  getInterface: () => readline.Interface | null;
  prompt: string;
}): LiveLine {
  const original = { log: console.log, error: console.error };
  let timer: ReturnType<typeof setInterval> | null = null;
  let startedAt = 0;
  let frame = 0;
  let label = "Thinking";
  let detail: string | undefined;
  let tokens: number | null = null;
  let paused = false;
  let question: string | null = null;

  const clear = (): void => {
    readline.clearLine(process.stdout, 0);
    readline.cursorTo(process.stdout, 0);
  };

  const line = (): string => {
    const meta = [formatDuration(Date.now() - startedAt)];
    if (tokens && tokens > 0) meta.push(`${formatTokenCount(tokens)} tokens`);
    const metaText = `· ${meta.join(" · ")}`;
    const room = Math.max(12, width() - metaText.length - 12);
    const shownLabel = truncate(label, room);
    const shownDetail = detail && shownLabel.length + 2 < room ? truncate(detail, room - shownLabel.length - 1) : "";
    return (
      `  ${c.brand(FRAMES[frame % FRAMES.length]!)} ${c.text(shownLabel)}` +
      `${shownDetail ? ` ${c.muted(shownDetail)}` : ""} ${c.faint(metaText)}`
    );
  };

  const render = (): void => {
    if (!timer) return;
    const rl = options.getInterface();
    if (paused) {
      if (rl && question !== null) {
        rl.setPrompt(question);
        rl.prompt(true);
      }
      return;
    }
    if (rl) {
      rl.setPrompt(`${line()}  ${options.prompt}`);
      rl.prompt(true);
    } else {
      process.stdout.write(`\r\x1b[2K${line()}`);
    }
  };

  const print = (write: (...args: unknown[]) => void, args: unknown[]): void => {
    if (!timer) {
      write(...args);
      return;
    }
    clear();
    write(format(...args));
    render();
  };

  return {
    start(): void {
      if (!options.enabled || timer) return;
      startedAt = Date.now();
      frame = 0;
      // Until the first step begins: connectors, the project and memory are being readied.
      label = "Waking up";
      detail = undefined;
      tokens = null;
      paused = false;
      question = null;
      console.log = (...args: unknown[]) => print(original.log, args);
      console.error = (...args: unknown[]) => print(original.error, args);
      timer = setInterval(() => {
        frame++;
        render();
      }, 120);
      timer.unref?.();
      render();
    },

    set(nextLabel: string, nextDetail?: string): void {
      label = nextLabel;
      detail = nextDetail;
    },

    setTokens(next: number | null): void {
      tokens = next;
    },

    pause(): void {
      if (!timer) return;
      paused = true;
      question = null;
      options.getInterface()?.setPrompt("");
      clear();
    },

    resume(): void {
      paused = false;
      question = null;
      render();
    },

    ask(q: string, ask: (question: string) => Promise<string>): Promise<string> {
      const rl = options.getInterface();
      if (!timer || !rl) return ask(q);
      paused = true;
      question = q;
      clear();
      rl.setPrompt(q);
      rl.prompt(true);
      return ask("");
    },

    echoQueued(text: string, note = "queued, read at the next step"): void {
      if (timer && options.getInterface()) {
        readline.moveCursor(process.stdout, 0, -1);
        clear();
      }
      console.log(
        `  ${c.brand("↳")} ${c.text(truncate(text.replace(/\s+/g, " ").trim(), Math.max(20, width() - 36)))} ` +
          `${c.faint(`· ${note}`)}`,
      );
    },

    stop(): void {
      if (!timer) return;
      clearInterval(timer);
      timer = null;
      console.log = original.log;
      console.error = original.error;
      clear();
      options.getInterface()?.setPrompt(options.prompt);
    },
  };
}

/** How full the context window is, as `/context` shows it. */
export function renderContext(usage: ContextUsage, compactsAt: string, estimated: boolean): void {
  const cells = Math.max(16, Math.min(48, width() - 12));
  const window = Math.max(1, usage.windowTokens);
  const share = (n: number): number => Math.round((Math.max(0, n) / window) * cells);
  const system = Math.min(cells, share(usage.breakdown.system));
  const tools = Math.min(cells - system, share(usage.breakdown.tools));
  const messages = Math.min(cells - system - tools, share(usage.breakdown.messages));
  const free = Math.max(0, cells - system - tools - messages);
  const percent = Math.min(100, Math.round((usage.usedTokens / window) * 100));

  console.log("");
  console.log(
    `  ${c.text.bold("Context")} ${c.muted(`${formatTokenCount(usage.usedTokens)} / ${formatTokenCount(usage.windowTokens)} tokens · ${percent}%`)}`,
  );
  console.log(
    `  ${c.warn("█".repeat(system))}${c.ok("█".repeat(tools))}${c.accent("█".repeat(messages))}${c.faint("░".repeat(free))}`,
  );
  console.log(
    `  ${c.warn("■")} ${c.muted(`system ${formatTokenCount(usage.breakdown.system)}`)}   ` +
      `${c.ok("■")} ${c.muted(`tools ${formatTokenCount(usage.breakdown.tools)}`)}   ` +
      `${c.accent("■")} ${c.muted(`messages ${formatTokenCount(usage.breakdown.messages)}`)}`,
  );
  console.log(
    `  ${c.faint(`checkpoints automatically at ${compactsAt}${estimated ? " · estimated, before this session's first request" : ""}`)}`,
  );
  console.log(`  ${c.faint("/checkpoint to checkpoint now · /checkpoint-at <tokens | percent | default> to change when")}`);
  console.log(`  ${rule()}\n`);
}

/**
 * The context engine's report, under the window meter: what the model was
 * shown last step and why. Loosely typed — it is the orchestrator's
 * `ContextDebug` as it arrived on the stream.
 */
export function renderContextEngine(debug: Record<string, unknown>): void {
  const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);
  const obj = (v: unknown): Record<string, unknown> => (v && typeof v === "object" ? (v as Record<string, unknown>) : {});
  const list = (v: unknown): Record<string, unknown>[] => (Array.isArray(v) ? (v as Record<string, unknown>[]) : []);
  const tokens = obj(debug["tokens"]);
  const budget = obj(debug["budget"]);
  const history = obj(debug["history"]);
  const retrieved = list(debug["retrieved"]);
  const checkpoints = list(debug["checkpoints"]);
  const stale = list(debug["stale"]);
  const t = (v: unknown): string => formatTokenCount(num(v));

  console.log(
    `  ${c.text.bold("Working set")} ${c.muted(
      `${t(tokens["workingSet"])} of ${t(budget["workingSet"])} · task state ${t(tokens["state"])} · evidence ${t(tokens["evidence"])} · phase ${String(debug["phase"] ?? "?")}`,
    )}`,
  );
  console.log(
    `  ${c.text.bold("History")} ${c.muted(
      `${t(tokens["history"])} sent of ${t(tokens["historyRaw"])} recorded · checkpoint at ${t(budget["checkpointAt"])} · ` +
        `${num(history["superseded"])} superseded, ${num(history["aged"])} condensed, ${num(history["gated"])} as digests, ${num(history["staleReads"])} stale reads`,
    )}`,
  );
  if (retrieved.length > 0) {
    console.log(
      `  ${c.text.bold("Retrieved")} ${c.muted(
        `${retrieved.length} of ${num(debug["considered"])} candidates${num(debug["duplicates"]) > 0 ? ` · ${num(debug["duplicates"])} duplicates skipped` : ""}`,
      )}`,
    );
    for (const item of retrieved.slice(0, 6)) {
      const lines = Array.isArray(item["lines"]) ? `:${(item["lines"] as number[]).join("-")}` : "";
      const reasons = Array.isArray(item["reasons"]) ? (item["reasons"] as string[]).slice(0, 2).join("; ") : "";
      console.log(`    ${c.accent(`${String(item["path"])}${lines}`)} ${c.faint(`${num(item["relevance"]).toFixed(2)} · ${reasons}`)}`);
    }
  }
  if (stale.length > 0) console.log(`  ${c.warn(`${stale.length} memory entries are stale: their source file changed`)}`);
  if (checkpoints.length > 0) {
    const last = checkpoints[checkpoints.length - 1]!;
    // A read-ahead keeps the history whole, so before and after are equal by design.
    const what =
      last["kind"] === "extract"
        ? `read ahead, ${num(last["extracted"])} entries saved, history kept at ${t(last["tokensAfter"])}`
        : `history cut ${t(last["tokensBefore"])} → ${t(last["tokensAfter"])}, ${num(last["extracted"])} entries saved`;
    console.log(`  ${c.faint(`${checkpoints.length} checkpoint(s) · last at step ${num(last["step"])}: ${what}`)}`);
  }
  console.log(`  ${rule()}
`);
}

let lastRenderedToolCall = "";

export interface BannerState {
  model: string;
  mode: string;
  effort: string;
  /** The workspace ceiling, when one is actually enforced. Undefined means
   *  the mode alone decides, and the banner says nothing about a tier. */
  tier?: string;
  workspaceDir: string;
  /** False when the workspace could not be snapshotted. Shown, because it
   *  changes what auto mode will do and there is no other moment the user
   *  would find out. */
  checkpoints: boolean;
  /** A newer SoreQen Code is published; see `self-update.ts`. */
  notice?: string | null;
  /** For the welcome panel. */
  version?: string;
  name?: string | null;
  recent?: { text: string; age: string }[];
}

/**
 * The header.
 *
 * Ordered by how often each item is needed and by consequence. The **mode**
 * comes first after the name, because it is the one thing on screen that
 * changes what the agent will do without asking — and because it is the thing
 * the user selected, as opposed to the tier, which is usually a property of a
 * workspace somebody else provisioned.
 *
 * The tier is shown only when it is *narrower* than the mode implies. Printing
 * "auto · guarded autonomy" on every line is two words for one fact; printing
 * "auto · limited to propose only" when a workspace has clamped the mode is
 * the difference between a confusing session and an explained one.
 */
export function renderBanner(state: BannerState): void {
  const impliedTier = { plan: "read_only", manual: "propose_only", auto: "guarded_autonomy", bypass: "full_autonomy" }[
    state.mode
  ];
  const clamped = state.tier !== undefined && impliedTier !== undefined && impliedTier !== state.tier;
  const notes: string[] = [];
  if (clamped && state.tier) notes.push(`this workspace is limited to ${tierStyle(state.tier).label}`);
  if (!state.checkpoints) notes.push("no checkpoints here: changes cannot be rewound");
  if (state.notice) notes.push(state.notice);

  console.log("");
  for (const line of welcomeLines({
    model: state.model,
    mode: modeStyle(state.mode).label,
    effort: effortStyle(state.effort).label,
    workspaceDir: state.workspaceDir,
    ...(state.version ? { version: state.version } : {}),
    ...(state.name !== undefined ? { name: state.name } : {}),
    ...(state.recent ? { recent: state.recent } : {}),
    notes,
  })) {
    console.log(line);
  }
  console.log("");
}

/**
 * What each tool is about to do, in words.
 *
 * A lookup rather than the previous sixteen-branch `if` chain — which was not
 * only long but silently fell through to "Running x..." for any tool added
 * later, so a new tool always shipped with a worse label than the others.
 * A missing entry here is now obvious in one place.
 */
/** `mcp__github__create_issue` as "github · create issue". Null for a tool that is not an MCP server's. */
export function mcpToolLabel(tool: string): string | null {
  const m = /^mcp__(.+?)__(.+)$/.exec(tool);
  return m ? `${m[1]} · ${m[2]!.replace(/_/g, " ")}` : null;
}


/** The call shown last, so its result can sit right under it. */
let lastShownCall: { id: string; label: string } | null = null;

export function renderToolStart(tool: string, input: Record<string, unknown>, callId?: string): void {
  const key = `${tool}:${JSON.stringify(input)}`;
  if (key === lastRenderedToolCall) return;
  lastRenderedToolCall = key;
  console.log(toolLine(tool, input));
  const { verb, target } = toolParts(tool, input);
  lastShownCall = { id: callId ?? key, label: truncate(`${verb} ${target}`.trim(), 40) };
}

/**
 * What came of a call, on one dim line under it. When other output came in
 * between (parallel calls, the agent's own text), the line names the call.
 */
export function renderToolResult(callId: string, tool: string, output: unknown, success: boolean): void {
  const summary = resultSummary(tool, output, success);
  // A quiet success of a step that says nothing more than "done" is not worth a line.
  if (success && summary === "done") {
    if (lastShownCall?.id === callId) lastShownCall = null;
    return;
  }
  const adjacent = lastShownCall?.id === callId;
  console.log(resultLine(truncate(summary, width() - 8), success, adjacent ? undefined : toolParts(tool, {}).verb));
  lastShownCall = null;
}

export function resetToolCallTracking(): void {
  lastRenderedToolCall = "";
}

export function renderMarkdown(content: string): void {
  console.log(formatTerminalMarkdown(content));
}

/** Diff lines shown before it is summarised instead. A long diff scrolls the
 *  conversation off the screen, which costs more than it explains — the file
 *  is on disk and can be read in full. */
const MAX_DIFF_LINES = 40;

export function renderDiff(path: string, diff: string): void {
  const lines = diff.split(/\r?\n/);
  const added = lines.filter((l) => l.startsWith("+") && !l.startsWith("+++")).length;
  const removed = lines.filter((l) => l.startsWith("-") && !l.startsWith("---")).length;

  console.log("");
  console.log(
    `  ${c.brand(glyph.bar)} ${c.text.bold(truncate(path, width() - 20))}  ` +
      `${c.ok(`+${added}`)} ${c.danger(`-${removed}`)}`,
  );

  const shown = lines.slice(0, MAX_DIFF_LINES);
  for (const line of shown) {
    if (line.startsWith("+++") || line.startsWith("---")) continue;
    if (line.startsWith("+")) console.log(`  ${c.ok(line)}`);
    else if (line.startsWith("-")) console.log(`  ${c.danger(line)}`);
    else if (line.startsWith("@@")) console.log(`  ${c.accent(line)}`);
    else console.log(`  ${c.muted(line)}`);
  }

  if (lines.length > MAX_DIFF_LINES) {
    console.log(`  ${c.faint(`… ${lines.length - MAX_DIFF_LINES} more lines`)}`);
  }
  console.log("");
}

let lastRenderedTodoListHash = "";

export function renderTodoList(items: TodoItem[]): void {
  if (!items || items.length === 0) return;

  const currentHash = JSON.stringify(items);
  if (currentHash === lastRenderedTodoListHash) return;
  lastRenderedTodoListHash = currentHash;

  const done = items.filter((i) => i.status === "completed").length;

  console.log("");
  console.log(`  ${c.brand(glyph.bar)} ${c.text.bold("Plan")} ${c.muted(`${done}/${items.length}`)}`);

  for (const item of items) {
    const title = truncate(item.title, width() - 8);
    switch (item.status) {
      case "completed":
        // Struck through *and* ticked: on a monochrome terminal the tick is
        // what still distinguishes it.
        console.log(`  ${c.ok(glyph.ok)} ${c.faint(title)}`);
        break;
      case "in_progress":
        console.log(`  ${c.brand(glyph.active)} ${c.text.bold(title)}`);
        break;
      case "failed":
        console.log(`  ${c.danger(glyph.fail)} ${c.text(title)}`);
        break;
      default:
        console.log(`  ${c.faint(glyph.pending)} ${c.muted(title)}`);
    }
  }
  console.log("");
}

/**
 * Ask before doing something consequential.
 *
 * The action is shown on its own line, unwrapped and undecorated, because it
 * is the thing being consented to and anything competing with it is noise. The
 * default is no — a stray Return must not authorise a command.
 */
export async function promptConfirmation(
  description: string,
  payload: Record<string, unknown> | undefined,
  /**
   * How to put a question to the person, supplied by whoever owns stdin.
   *
   * This used to open its own `readline` on `process.stdin` while the REPL
   * still held one. Two readers on one stream both receive every line, so a
   * single `y` resolved the approval *and* was queued by the REPL as a fresh
   * prompt — an entire unasked-for agent turn per approval. Passing the ask in
   * is what makes there be exactly one reader; see `input-router.ts`.
   */
  ask: (question: string) => Promise<string>,
): Promise<boolean> {
  console.log("");
  console.log(`  ${c.warn.bold(glyph.warn)} ${c.text.bold("Approval needed")}`);
  console.log(`  ${c.muted(truncate(description, width() - 4))}`);

  if (payload) {
    const detail = JSON.stringify(payload);
    console.log(`  ${c.faint(truncate(detail, width() - 4))}`);
  }

  const answer = await ask(`  ${c.text("Allow?")} ${c.faint("y / N")} ${c.brand(glyph.arrow)} `);
  const approved = /^y(es)?$/i.test(answer.trim());
  console.log(
    approved
      ? `  ${c.ok(glyph.ok)} ${c.muted("allowed")}\n`
      : `  ${c.danger(glyph.fail)} ${c.muted("denied")}\n`,
  );
  return approved;
}
