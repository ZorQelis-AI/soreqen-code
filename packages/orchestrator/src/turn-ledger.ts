/**
 * What the turn actually did, recorded as it happens.
 *
 * ## Why the model cannot be the source of this
 *
 * A turn's closing summary used to be written from memory: the model recalled
 * which files it had touched and what it had verified, hundreds of steps and
 * several context compactions after the fact. That produces two failures, and
 * the second is the expensive one.
 *
 * The first is omission — a file changed at step 12 missing from the list.
 * Annoying, visible, easily corrected.
 *
 * The second is **invention**: "ran the test suite — all passing" in a turn
 * where no test ever ran. There is nothing dishonest about it; a model
 * summarising a long transcript reports what a turn like that usually
 * contains. But the person reads it as evidence, and it is not evidence.
 *
 * So the ledger watches the tool calls. Every entry here is a call that was
 * actually dispatched and a result that actually came back. The model still
 * writes the prose — it is the only thing that knows *why* — but the facts
 * underneath it come from here, handed to it just before it writes, and shown
 * to the person whether or not the prose agrees with them.
 *
 * ## Every call, not only the ones with a section
 *
 * The model is told the record is the whole record, so a call missing from it
 * is a call it will retract. It was missing browser checks (`browser_batch`
 * at three widths) and a specialist's `run_tests` (reported 18 Nov 2026: the
 * final check said they "are not in the turn record ... should be treated as
 * not having happened", though the browser panel showed every one). So
 * browser calls have their own lines, every other tool is counted by name,
 * and a sub-agent's record is folded into its parent's, marked as its.
 *
 * ## Deleted files
 *
 * There is no delete tool, so a deletion is a `run_command` that removed
 * something. Those are recorded as commands and not as deletions: a ledger
 * that guessed at `rm` syntax across two shells would state deletions that did
 * not happen, which is the exact failure it exists to prevent.
 */

export interface LedgerCommand {
  command: string;
  description?: string;
  exitCode?: number | null;
  ok: boolean;
}

export interface LedgerCheck {
  /** `typecheck`, `tests`, `review`, `lint`, … */
  kind: string;
  detail: string;
  passed: boolean;
}

export interface LedgerSubagent {
  role: string;
  task: string;
  status: string;
}

export interface LedgerBrowserCall {
  /** What it did, as a person would say it: "opened http://localhost:5173", "batch of 4: open, screenshot, …". */
  detail: string;
  ok: boolean;
  /** Set when a sub-agent made the call. */
  by?: string;
}

export interface TurnLedgerSnapshot {
  created: string[];
  modified: string[];
  commands: LedgerCommand[];
  checks: LedgerCheck[];
  subagents: LedgerSubagent[];
  questions: string[];
  browser: LedgerBrowserCall[];
  /** Calls of every tool without a section of its own, by name. */
  otherTools: Record<string, number>;
  toolCalls: number;
  failedCalls: number;
}

/** A URL or path short enough for one line. */
function shortText(raw: unknown, max = 100): string {
  const text = typeof raw === "string" ? raw.trim() : "";
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

/** One browser call, described from its input. */
function browserDetail(tool: string, input: Record<string, unknown>): string {
  if (tool === "browser_batch") {
    const steps = Array.isArray(input["steps"]) ? (input["steps"] as Record<string, unknown>[]) : [];
    const actions = steps.map((st) => String(st?.["action"] ?? "?"));
    const url = steps.map((st) => st?.["url"]).find((u) => typeof u === "string");
    const width = steps.map((st) => st?.["width"] ?? st?.["viewport"]).find((w) => w !== undefined);
    return (
      `batch of ${steps.length}: ${actions.slice(0, 8).join(", ")}${actions.length > 8 ? ", …" : ""}` +
      (url ? ` (${shortText(url)})` : "") +
      (width !== undefined ? ` at width ${typeof width === "object" ? JSON.stringify(width) : String(width)}` : "")
    );
  }
  const verb = tool.replace(/^browser_/, "").replace(/_/g, " ");
  const action = typeof input["action"] === "string" ? input["action"] : "";
  const target = shortText(input["url"] ?? input["selector"] ?? input["text"] ?? "");
  return [verb, action && action !== verb ? action : "", target].filter(Boolean).join(" ");
}

/** A path as it should appear in a summary: forward slashes, no `./`. */
function tidyPath(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const path = raw.trim().replace(/\\/g, "/").replace(/^\.\//, "");
  return path || null;
}

export class TurnLedger {
  /** Files that did not exist before this turn wrote them. */
  private readonly created = new Set<string>();
  /** Files this turn changed that already existed. */
  private readonly modified = new Set<string>();
  private readonly commands: LedgerCommand[] = [];
  private readonly checks: LedgerCheck[] = [];
  private readonly subagents: LedgerSubagent[] = [];
  private readonly questions: string[] = [];
  private readonly browser: LedgerBrowserCall[] = [];
  private readonly otherTools = new Map<string, number>();
  private toolCalls = 0;
  private failedCalls = 0;

  /**
   * Record one executed call.
   *
   * `data` is the tool's own result payload — the same object the model is
   * shown — so nothing here can claim more than the tool reported.
   */
  record(tool: string, input: Record<string, unknown>, result: { success: boolean; data?: unknown }): void {
    this.toolCalls++;
    if (!result.success) this.failedCalls++;

    const data = (result.data ?? {}) as Record<string, unknown>;

    switch (tool) {
      case "write_file": {
        const path = tidyPath(data["path"] ?? input["path"]);
        if (!path || !result.success) break;
        /*
         * `created` is the tool's word, not a guess.
         *
         * `toolWriteFile` knows whether the file existed, because it had to
         * decide whether `overwrite` applied. Re-deriving it here from the
         * absence of an earlier read would be wrong for a file the agent
         * never read and right only by luck.
         */
        if (data["created"] === true) this.created.add(path);
        else if (this.created.has(path)) {
          // A file this turn created and then rewrote is still created.
        } else this.modified.add(path);
        break;
      }
      case "edit_file": {
        const path = tidyPath(data["path"] ?? input["path"]);
        if (!path || !result.success) break;
        if (!this.created.has(path)) this.modified.add(path);
        break;
      }
      case "run_command": {
        const command = typeof input["command"] === "string" ? input["command"] : null;
        if (!command) break;
        const exit = data["exitCode"];
        this.commands.push({
          command: command.length > 160 ? `${command.slice(0, 160)}…` : command,
          ...(typeof input["description"] === "string" && input["description"]
            ? { description: input["description"] }
            : {}),
          exitCode: typeof exit === "number" ? exit : null,
          ok: result.success,
        });
        break;
      }
      case "run_tests": {
        const summary =
          typeof data["summary"] === "string"
            ? data["summary"]
            : typeof data["output"] === "string"
              ? String(data["output"]).split("\n").filter(Boolean).slice(-1)[0] ?? ""
              : "";
        this.checks.push({
          kind: "tests",
          detail: summary.slice(0, 200) || (result.success ? "passed" : "failed"),
          passed: result.success,
        });
        break;
      }
      case "git_operation": {
        const op = typeof input["operation"] === "string" ? input["operation"] : "git";
        this.commands.push({ command: `git ${op}`, ok: result.success, exitCode: null });
        break;
      }
      case "install_package": {
        const name = typeof input["package_name"] === "string" ? input["package_name"] : "";
        this.commands.push({ command: `install ${name}`.trim(), ok: result.success, exitCode: null });
        break;
      }
      case "spawn_subagent": {
        const role = typeof data["role"] === "string" ? data["role"] : String(input["role"] ?? "");
        const task = String(input["task_prompt"] ?? "");
        this.subagents.push({
          role,
          task: task.length > 120 ? `${task.slice(0, 120)}…` : task,
          status: result.success ? "started" : "refused",
        });
        break;
      }
      case "ask_user": {
        const batch = Array.isArray(input["questions"]) ? (input["questions"] as unknown[]) : [];
        for (const q of [input, ...batch]) {
          const question = q && typeof q === "object" ? (q as Record<string, unknown>)["question"] : undefined;
          if (typeof question === "string" && question) this.questions.push(question.slice(0, 200));
        }
        break;
      }
      default:
        if (tool.startsWith("browser_")) {
          this.browser.push({ detail: browserDetail(tool, input), ok: result.success });
        } else {
          this.otherTools.set(tool, (this.otherTools.get(tool) ?? 0) + 1);
        }
        break;
    }
  }

  /**
   * A sub-agent's record, folded into this one.
   *
   * Its calls are this turn's calls: a specialist's tests and browser checks
   * are what the parent's summary reports, so they must be in the record the
   * summary is checked against. Commands, checks and browser calls say whose
   * they were.
   */
  absorb(role: string, sub: TurnLedgerSnapshot | undefined): void {
    if (!sub) return;
    const by = role || "sub-agent";
    for (const f of sub.created) if (!this.modified.has(f)) this.created.add(f);
    for (const f of sub.modified) if (!this.created.has(f)) this.modified.add(f);
    for (const c of sub.commands) this.commands.push({ ...c, description: `${c.description ?? c.command} (by ${by})` });
    for (const c of sub.checks) this.checks.push({ ...c, kind: `${c.kind} (by ${by})` });
    for (const b of sub.browser ?? []) this.browser.push({ ...b, by: b.by ?? by });
    for (const [tool, n] of Object.entries(sub.otherTools ?? {})) this.otherTools.set(tool, (this.otherTools.get(tool) ?? 0) + n);
    for (const q of sub.questions) this.questions.push(q);
    for (const a of sub.subagents) this.subagents.push(a);
    this.toolCalls += sub.toolCalls;
    this.failedCalls += sub.failedCalls;
  }

  /** A check the loop ran itself — the typecheck, the affected tests, the
   *  self-review — which never passes through `record` because the model
   *  never called it. */
  recordCheck(check: LedgerCheck): void {
    this.checks.push(check);
  }

  /** How a delegated specialist ended, once it has. */
  recordSubagentOutcome(role: string, status: string): void {
    const entry = [...this.subagents].reverse().find((a) => a.role === role && a.status === "started");
    if (entry) entry.status = status;
  }

  snapshot(): TurnLedgerSnapshot {
    return {
      created: [...this.created].sort(),
      modified: [...this.modified].sort(),
      commands: [...this.commands],
      checks: [...this.checks],
      subagents: [...this.subagents],
      questions: [...this.questions],
      browser: [...this.browser],
      otherTools: Object.fromEntries([...this.otherTools.entries()].sort(([a], [b]) => a.localeCompare(b))),
      toolCalls: this.toolCalls,
      failedCalls: this.failedCalls,
    };
  }

  /** Did this turn change anything at all? */
  touchedFiles(): boolean {
    return this.created.size > 0 || this.modified.size > 0;
  }

  /**
   * The facts, as the model is shown them immediately before it writes its
   * summary.
   *
   * Phrased as a record rather than as instructions about what to say,
   * because a model given a list of headings fills every heading — including
   * "Tests" in a turn with no tests. Given a record with no tests in it, and
   * told the record is all there is, it says so.
   */
  render(): string {
    const s = this.snapshot();
    const lines: string[] = [];

    const list = (title: string, items: string[]): void => {
      if (items.length === 0) return;
      lines.push(`${title}:`);
      for (const item of items.slice(0, 40)) lines.push(`  - ${item}`);
      if (items.length > 40) lines.push(`  - … and ${items.length - 40} more`);
    };

    list("Files created", s.created);
    list("Files modified", s.modified);

    if (s.commands.length > 0) {
      const shown = s.commands.slice(-15);
      lines.push("Commands run:");
      for (const c of shown) {
        const status = c.ok ? "ok" : `FAILED${c.exitCode != null ? ` (exit ${c.exitCode})` : ""}`;
        lines.push(`  - ${c.description ?? c.command} [${status}]`);
      }
      if (s.commands.length > shown.length) {
        lines.push(`  - … and ${s.commands.length - shown.length} earlier commands`);
      }
    }

    if (s.checks.length > 0) {
      lines.push("Verification:");
      for (const c of s.checks) lines.push(`  - ${c.kind}: ${c.passed ? "passed" : "FAILED"} — ${c.detail}`);
    } else {
      lines.push("Verification: nothing was run this turn.");
    }

    if (s.browser.length > 0) {
      const shown = s.browser.slice(-20);
      lines.push("Browser:");
      for (const b of shown) lines.push(`  - ${b.detail}${b.by ? ` (by ${b.by})` : ""} [${b.ok ? "ok" : "FAILED"}]`);
      if (s.browser.length > shown.length) lines.push(`  - … and ${s.browser.length - shown.length} earlier browser calls`);
    }

    if (s.subagents.length > 0) {
      lines.push("Delegated:");
      for (const a of s.subagents) lines.push(`  - ${a.role} (${a.status}): ${a.task}`);
    }

    if (s.questions.length > 0) {
      lines.push("Asked the user:");
      for (const q of s.questions) lines.push(`  - ${q}`);
    }

    const others = Object.entries(s.otherTools);
    if (others.length > 0) {
      lines.push(`Other tool calls: ${others.map(([tool, n]) => (n > 1 ? `${tool} ×${n}` : tool)).join(", ")}`);
    }

    lines.push(
      `Tool calls: ${s.toolCalls}` + (s.failedCalls > 0 ? `, of which ${s.failedCalls} failed` : ""),
    );

    return lines.join("\n");
  }
}

/**
 * What the check of a closing summary said, read generously.
 *
 * The model is asked to answer exactly VERIFIED, or a short "Correction: …".
 * Models do not always: some repeat the summary back, and a repeat taken for
 * a correction put the summary on screen twice — the very bug the check was
 * built to end (reported 27 Sep 2026; seen again 28 Sep in a test whose model
 * did exactly that). So:
 *
 *   - empty, or opening with VERIFIED (a few words after it are fine): verified;
 *   - opening with "Correction": the correction, as written;
 *   - mostly the summary's own words again: a repeat, so verified;
 *   - anything else: new information, shown as a correction.
 */
export function readSummaryCheck(summary: string, reply: string): { verified: boolean; correction: string } {
  const text = reply.trim();
  if (!text) return { verified: true, correction: "" };
  if (/^\**verified\b/i.test(text) && text.length <= 80) return { verified: true, correction: "" };
  if (/^\**correction\b/i.test(text)) return { verified: false, correction: text };
  const words = (s: string): string[] => s.toLowerCase().match(/[a-z0-9][a-z0-9_.\-/]{2,}/g) ?? [];
  const said = new Set(words(summary));
  const replyWords = words(text);
  const repeated = replyWords.length > 0 ? replyWords.filter((w) => said.has(w)).length / replyWords.length : 1;
  if (repeated >= 0.6) return { verified: true, correction: "" };
  return { verified: false, correction: `Correction: ${text}` };
}
