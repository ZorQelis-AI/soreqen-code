/**
 * What a checkpoint can and cannot take back.
 *
 * ## Why this file decides anything
 *
 * `auto` mode's whole claim is one sentence: *if a checkpoint can undo it,
 * don't ask; if it can't, ask*. That sentence is only worth trusting if
 * something actually answers the question, and answers it conservatively.
 * This is that something.
 *
 * The classification is deliberately **not** "is this dangerous". Danger is a
 * feeling and it drifts; every list built on it grows until it prompts for
 * everything and gets switched off. Reversibility is a property of the action
 * and the snapshot, and it can be checked.
 *
 * ## The boundary, precisely
 *
 * `checkpoint.ts` snapshots tracked, non-ignored files in the workspace. So
 * the recoverable set is exactly: **edits to files inside the workspace that
 * are not excluded from the snapshot**. Everything else is one-way:
 *
 *   - anything that leaves the machine (a push, a publish, an upload, a
 *     request carrying a body);
 *   - anything that changes the machine rather than the project (`sudo`, a
 *     service, a global install, a system path);
 *   - anything that destroys state the snapshot never held (a database, a
 *     path outside the workspace, an ignored directory);
 *   - anything whose *side effect* has already happened by the time you could
 *     restore (an install script that ran, an email that sent, a deploy).
 *
 * ## Two rules that keep this honest
 *
 * **Unrecognised means irreversible.** An unknown `run_command` is treated as
 * one-way. The failure modes are not symmetrical: wrongly asking costs one
 * keypress, wrongly proceeding can cost a production database. A classifier
 * whose default is "probably fine" is not a safety mechanism.
 *
 * **A path outside the workspace is outside the snapshot.** `rm -rf build/`
 * is a local mistake and a checkpoint fixes it. `rm -rf ~/build` is not in the
 * workspace, was never snapshotted, and is gone. The same command differs only
 * by argument, so the argument has to be read.
 */

import type { LLMToolCall } from "./types.js";

export interface ReversibilityVerdict {
  reversible: boolean;
  /** Why, in a clause that can be shown to a user after "SoreQen paused
   *  because this ". Present only when irreversible. */
  reason?: string;
}

const reversible: ReversibilityVerdict = { reversible: true };
const oneWay = (reason: string): ReversibilityVerdict => ({ reversible: false, reason });

/**
 * Tools whose every use only rearranges files inside the workspace.
 *
 * `write_file` and `edit_file` are the two that matter, and they are the two
 * `auto` mode exists to stop asking about — the overwhelming majority of what
 * an agent does, all of it undoable in one command.
 */
const WORKSPACE_ONLY_TOOLS = new Set([
  // The agent's own memory under .soreqen/, and a search over the index.
  "update_task_state",
  // Memory between sessions: SoreQen's own files, never the person's.
  "remember",
  "edit_memory",
  "forget",
  "recall",
  "use_skill",
  "retrieve_context",
  "code_graph",
  "process_status",
  "stop_process",
  "wait",
  "schedule_wakeup",
  "read_file",
  "edit_file",
  "write_file",
  "list_directory",
  "grep_search",
  "glob",
  "find_symbol_definition",
  "find_symbol_references",
  "update_todo_list",
  "run_tests",
  "web_search",
  "fetch_url_content",
  "research",
  "browser_open",
  "browser_screenshot",
  "browser_interact",
  "browser_batch",
  "browser_console_logs",
  "browser_snapshot",
  /*
   * Looking at a picture, asking a question, and reading the sub-agent roster.
   *
   * Absent from this set, an unrecognised tool is classified irreversible —
   * so in Auto without a checkpoint, `ask_user` produced "this uses a tool
   * whose effects SoreQen cannot classify" and made the person *approve the
   * agent asking them something* before they could answer it. Two prompts for
   * one question, the first of which is meaningless.
   *
   * `spawn_subagent` is deliberately not here: a specialist can edit files,
   * and its reversibility is the reversibility of whatever it does.
   */
  "view_image",
  "ask_user",
  "subagent_status",
]);

/**
 * Commands that reach past the workspace.
 *
 * Ordered roughly by how often they come up, since the first match wins and
 * the reason string is what the user reads.
 */
const ESCAPES_THE_SNAPSHOT: { pattern: RegExp; why: string }[] = [
  { pattern: /\bgit\s+push\b/, why: "publishes commits to a remote others can pull" },
  { pattern: /\bgit\s+tag\b[^|;&]*\s-[a-z]*f/, why: "moves a tag others may have fetched" },
  {
    pattern: /\b(npm|pnpm|yarn|bun)\s+publish\b|\bcargo\s+publish\b|\btwine\s+upload\b|\bgem\s+push\b/,
    why: "publishes a package to a registry, where versions cannot be unpublished",
  },
  {
    pattern: /\b(drop|truncate)\s+(table|database|schema)\b/i,
    why: "destroys database contents, which no workspace snapshot holds",
  },
  { pattern: /\bsudo\b|\bdoas\b/, why: "runs as root, outside the workspace's reach" },
  {
    pattern: /\b(ssh|scp|sftp|rsync)\b[^|;&]*\s[\w.-]+@[\w.-]+:/,
    why: "acts on a remote machine",
  },
  {
    pattern: /\b(kubectl|helm|terraform|pulumi|flyctl|vercel|netlify|heroku|aws|gcloud|az)\b\s+(apply|deploy|create|destroy|delete|up|push|publish|release|sync)/,
    why: "changes deployed infrastructure",
  },
  {
    pattern: /\bdocker\b[^|;&]*\b(push|rm|rmi|system\s+prune)\b/,
    why: "changes images or containers outside the workspace",
  },
  {
    // Sending a body somewhere. A plain GET is a read and stays reversible.
    pattern: /\b(curl|wget|http|httpie)\b[^|;&]*(-X\s*(post|put|patch|delete)|--data|-d\s|--upload-file|-T\s)/i,
    why: "sends data to an external service, which cannot be recalled",
  },
  { pattern: /\bshutdown\b|\breboot\b|\bhalt\b|\bpoweroff\b/, why: "stops the machine" },
  {
    pattern: /\b(systemctl|service|launchctl|sc\.exe)\b\s+(start|stop|restart|disable|enable)/,
    why: "changes a system service",
  },
  {
    pattern: /\b(npm|pnpm|yarn)\s+(install|add|i)\b[^|;&]*\s-{1,2}(g|global)\b/,
    why: "installs globally, outside the workspace",
  },
  { pattern: /\bgit\s+config\s+--global\b/, why: "changes git configuration for every repository" },
  {
    pattern: /\bcrontab\b|\bat\s+now\b|\bschtasks\b/i,
    why: "schedules work that will run after the session ends",
  },
  { pattern: /\bmail\b|\bsendmail\b|\bmsmtp\b/, why: "sends mail" },
];

/**
 * A path argument that is not inside the workspace.
 *
 * Absolute paths, `~`, and anything climbing out with `..`. Deliberately
 * simple and deliberately over-eager: `/tmp/x` is very probably fine, and
 * asking about it costs one keypress.
 */
const OUTSIDE_WORKSPACE = /(^|\s)(~|\/(?!\/)|[a-z]:[\\/])|(^|\s)\.\.[\\/]/i;

/** Commands that delete. Their reversibility depends entirely on where. */
const DELETES = /\brm\b|\brmdir\b|\bunlink\b|\bremove-item\b|\bdel\b|\brimraf\b|\bshred\b/i;

/**
 * Commands that carry another command inside them.
 *
 * Every one of these defeats argument inspection, because the arguments being
 * inspected belong to the wrapper rather than to the thing that will actually
 * run. They are matched anywhere in the string, not only at the start, since
 * `sudo bash -c` and `time xargs rm` are the same problem one word later.
 */
const SHELL_WRAPPERS =
  // Note `(^|\s)-exec` rather than `\b-exec`: `\b` before a hyphen asserts a
  // word character immediately to its left, so `\b-exec` matches `x-exec` and
  // never ` -exec`, which is the only way anyone writes it. The first version
  // of this line had exactly that bug and `find . -exec rm {} +` sailed
  // through as reversible.
  /\b(ba|z|k|da|fi)?sh\s+-[a-z]*c\b|\bpwsh\b|\bpowershell\b|\bcmd(\.exe)?\s+\/c\b|\beval\b|\bxargs\b|(^|\s)-{1,2}exec(dir)?\b|\bsource\b|\bnohup\b|\bwatch\b/i;

/**
 * Directories a checkpoint deliberately does not hold, per
 * `checkpoint.ts`'s exclude list. Deleting one is not recoverable by restore,
 * even though it sits inside the workspace — which is exactly the sort of
 * detail that makes a safety claim false if it is not tracked in both places.
 */
const EXCLUDED_FROM_SNAPSHOT =
  /\bnode_modules\b|\.venv\b|\bvenv\b|\.git\b(?!hub)|\.env\b|__pycache__|\btarget\b/;

function normalisedCommand(input: Record<string, unknown>): string | null {
  const raw = input["command"];
  if (typeof raw !== "string") return null;
  return raw.replace(/\s+/g, " ").trim();
}

/**
 * Can a checkpoint restore the workspace after this call?
 *
 * Answered without reference to permission tiers or modes — this is a fact
 * about the action, and the modes decide what to *do* with it.
 */
export function classifyReversibility(toolCall: LLMToolCall): ReversibilityVerdict {
  const { name, input } = toolCall;

  if (name === "git_operation") {
    const op = String(input["operation"] ?? "");
    if (op === "push" || op === "force_push") {
      return oneWay(
        op === "force_push"
          ? "force-pushes, rewriting history others may already have"
          : "pushes to a remote, where others can pull it",
      );
    }
    // Local git — commit, branch, checkout, stash — moves refs inside the
    // workspace's own `.git`, which the snapshot holds.
    return reversible;
  }

  if (name === "install_package") {
    /*
     * Not recoverable, for two independent reasons.
     *
     * `node_modules` is excluded from the snapshot, so restoring does not
     * remove what was installed — and a package's install script has already
     * executed arbitrary code by the time anyone could rewind. The lockfile
     * change is the only part a checkpoint undoes, and it is the least
     * important part.
     */
    return oneWay("installs a dependency, whose install scripts run immediately");
  }

  if (name === "spawn_subagent") {
    // A sub-agent's own calls are classified individually when it makes them.
    // Delegating is not itself an action on the world.
    return reversible;
  }

  if (name === "send_process_input") {
    /*
     * Typing into a program is running part of it. "y" to "Drop the
     * database?" is as final as the command that asked — and what a prompt
     * does with an answer cannot be read from the answer.
     */
    return oneWay("types into a running program, whose response to the answer cannot be read in advance");
  }

  if (name === "run_command") {
    const cmd = normalisedCommand(input);
    if (cmd === null) {
      return oneWay("is a command with no readable text, so its effect cannot be assessed");
    }
    const lower = cmd.toLowerCase();

    /*
     * Wrappers are opaque, and are checked before anything else.
     *
     * `bash -c '<anything>'`, `find -exec`, `xargs` and `eval` all take another
     * command as data. Classifying them means classifying a string this file
     * has not parsed, and every one of the checks below would be reading the
     * *wrapper's* arguments while the real command hides inside them —
     * `xargs rm < list.txt` looks like a path-less `rm`, and `find . -exec rm
     * {} +` looks like a `find`.
     *
     * There is no version of this that is both permissive and correct, so it
     * is not permissive. A legitimate `bash -c` costs one confirmation.
     */
    if (SHELL_WRAPPERS.test(lower)) {
      return oneWay("runs another command indirectly, so its real effect cannot be read");
    }

    for (const { pattern, why } of ESCAPES_THE_SNAPSHOT) {
      if (pattern.test(lower)) return oneWay(why);
    }

    /*
     * A plain fetch is a read.
     *
     * Recognised narrowly: no method flag, no body, and no output redirection
     * to a file — `curl -o /etc/hosts` is a write to somewhere a snapshot does
     * not reach, and `-O` writes wherever the URL's basename lands. Without
     * this, `auto` would confirm every documentation lookup, which is the kind
     * of friction that gets a mode abandoned.
     */
    if (/^(curl|wget|http|https)\b/.test(lower)) {
      const writesAFile = /\s-[oO]\b|--output\b|--remote-name\b|>/.test(cmd);
      const sendsABody = /-x\s*(post|put|patch|delete)|--data|--upload-file|\s-d\s|\s-t\s/i.test(cmd);
      if (!writesAFile && !sendsABody) return reversible;
    }

    if (DELETES.test(lower)) {
      if (EXCLUDED_FROM_SNAPSHOT.test(lower)) {
        return oneWay("deletes files that checkpoints do not hold, so a restore would not bring them back");
      }
      // Strip the command word before looking for paths, so `/usr/bin/rm`
      // does not read as a path outside the workspace.
      const args = lower.replace(/^\S+\s*/, "");
      if (OUTSIDE_WORKSPACE.test(` ${args}`)) {
        return oneWay("deletes a path outside the workspace, which no checkpoint covers");
      }
      return reversible;
    }

    // Writing to somewhere outside the workspace by redirection.
    if (/>\s*(~|\/|[a-z]:[\\/])/i.test(cmd)) {
      return oneWay("writes to a path outside the workspace");
    }

    /*
     * The default, and the important one.
     *
     * Most commands an agent runs are builds, tests, linters and formatters —
     * all reversible — but "most" is not a guarantee, and this classifier is
     * what stands between `auto` mode and a command nobody predicted. So an
     * unrecognised command is one-way, and the shape of the mistake is a
     * needless prompt rather than an unrecoverable action.
     *
     * The recognised-safe list below is what keeps that from being unbearable.
     */
    /*
     * Every command in a chain, not just the first.
     *
     * The list was matched from the start of the line only, so `ls &&
     * unknowntool --wipe` passed as `ls` (audit, 1 Oct 2026). The patterns
     * above already catch the destructive commands they know wherever they
     * sit; this makes the default — unknown means ask — hold for every link
     * of a chain or pipeline, and for what a `$( )` runs.
     */
    const parts = commandParts(lower);
    if (parts.length > 0 && parts.every((part) => RECOGNISED_SAFE.test(part))) return reversible;

    return oneWay("is a command SoreQen does not recognise, so its effects cannot be guaranteed undoable");
  }

  if (WORKSPACE_ONLY_TOOLS.has(name)) {
    // A write is only recoverable if it lands somewhere the snapshot covers.
    if (name === "write_file" || name === "edit_file") {
      const path = String(input["path"] ?? "");
      if (OUTSIDE_WORKSPACE.test(` ${path}`)) {
        return oneWay("writes to a path outside the workspace, which no checkpoint covers");
      }
      if (EXCLUDED_FROM_SNAPSHOT.test(path)) {
        return oneWay("writes to a path that checkpoints deliberately do not hold");
      }
    }
    return reversible;
  }

  return oneWay("uses a tool whose effects SoreQen cannot classify");
}

/**
 * Commands known to stay inside the workspace.
 *
 * The list is the price of making "unrecognised means irreversible" livable:
 * without it, `auto` mode would prompt on every `npm test`. Each entry is a
 * build, test, or inspection command whose entire output is workspace files
 * and stdout.
 *
 * Note what is *not* here: no shells (`bash -c` can contain anything), no
 * `find -exec`, no `xargs`, no `eval`. Those are how a safe-looking command
 * runs an unsafe one, so they fall through to the conservative default.
 */
const RECOGNISED_SAFE = new RegExp(
  "^(" +
    [
      // package scripts and runners
      "(npm|pnpm|yarn|bun)\\s+(run|test|exec|dlx|x)\\b",
      "(pnpm|yarn|bun)\\s+(build|lint|typecheck|type-check|format|check|dev|start|preview|vitest|tsc|eslint|prettier|jest)\\b",
      // the shell itself, as the links of a chain use it
      "(cd|pushd|popd|set-location|date|true|sleep|clear|cls)\\b",
      "(export|set)\\s+\\w+=",
      "\\w+=\\S*$",
      "(npm|pnpm|yarn)\\s+(install|i|add|ci)\\b(?![^|;&]*\\s-{1,2}(g|global)\\b)",
      "npx\\s",
      // language toolchains
      "(node|deno|bun)\\s",
      "(python3?|py)\\s",
      "(pytest|ruff|mypy|black|flake8|poetry|pip)\\s",
      "(tsc|eslint|prettier|vitest|jest|mocha|playwright|biome)\\b",
      "(cargo|go|dotnet|mvn|gradle|make|cmake)\\s+(build|test|check|fmt|run|clippy|vet|tidy|install)\\b",
      // inspection
      "(ls|dir|cat|head|tail|wc|stat|file|du|tree|pwd|which|echo|printf)\\b",
      "(grep|rg|ag|ack|fd|find)\\b(?![^|;&]*-exec)",
      "(diff|sort|uniq|cut|sed|awk|jq|tr)\\b",
      // PowerShell's read-only cmdlets and their aliases: the shell SoreQen Code runs on Windows. Not
      // Where-Object or ForEach-Object, whose script blocks can run anything (17 Nov 2026: a plain
      // Get-ChildItem asked for approval in Auto mode).
      "(get-childitem|gci|get-content|gc|get-item|gi|get-itemproperty|gp|get-location|gl|test-path|resolve-path|split-path|join-path|select-string|sls|measure-object|select-object|sort-object|format-table|ft|format-list|fl|format-wide|out-string|get-date|get-command|gcm|get-filehash|write-output|write-host)\\b",
      // local version control
      "git\\s+(status|log|diff|show|add|commit|branch|checkout|switch|restore|stash|fetch|merge|rebase|blame|rev-parse|ls-files|worktree|init|remote\\s+-v)\\b",
      // filesystem inside the workspace
      "(mkdir|touch|cp|mv|ln)\\b",
    ].join("|") +
    ")",
  "i",
);

/**
 * The commands a shell line runs: split at `&&`, `||`, `;`, `|` and new
 * lines outside quotes, plus whatever runs inside `$( )` or backticks.
 */
export function commandParts(line: string): string[] {
  const parts: string[] = [];
  const inner: string[] = [];
  for (const m of line.matchAll(/\$\(([^()]*)\)|`([^`]*)`/g)) inner.push((m[1] ?? m[2] ?? "").trim());
  let current = "";
  let quote: string | null = null;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]!;
    if (quote) {
      if (ch === quote) quote = null;
      current += ch;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      current += ch;
      continue;
    }
    const two = line.slice(i, i + 2);
    if (two === "&&" || two === "||") {
      parts.push(current);
      current = "";
      i++;
      continue;
    }
    // `2>&1` and `&>` redirect; they do not start a command.
    if (ch === "&" && (line[i - 1] === ">" || line[i + 1] === ">")) {
      current += ch;
      continue;
    }
    if (ch === ";" || ch === "|" || ch === "\n" || ch === "&") {
      parts.push(current);
      current = "";
      continue;
    }
    current += ch;
  }
  parts.push(current);
  // A redirection to a file is part of the command it follows, not a command: `2>&1` included.
  return [...parts, ...inner].map((p) => p.trim()).filter((p) => p && !/^\d?>/.test(p));
}

/**
 * A whole batch's verdict.
 *
 * A turn is only as reversible as its least reversible call, so this returns
 * the first one-way action rather than a majority opinion.
 */
export function firstIrreversible(calls: LLMToolCall[]): { call: LLMToolCall; reason: string } | null {
  for (const call of calls) {
    const verdict = classifyReversibility(call);
    if (!verdict.reversible) return { call, reason: verdict.reason ?? "cannot be undone" };
  }
  return null;
}
