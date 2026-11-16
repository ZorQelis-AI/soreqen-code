/**
 * A way back.
 *
 * ## What this is for
 *
 * The reason people run a coding agent on the tightest setting is almost never
 * that they want to approve each edit. It is that they have no way back if a
 * turn goes wrong. Approving twenty diffs is not enjoyable; it is insurance,
 * bought at the only price on offer.
 *
 * A checkpoint is the cheaper insurance. Snapshot the workspace before the
 * turn, and a bad turn costs one keystroke instead of an afternoon of `git
 * diff` archaeology. That changes what people are willing to let the agent do,
 * which is worth more than any single accuracy improvement — and it is the
 * entire justification for `auto` mode's rule that reversible actions need no
 * confirmation.
 *
 * ## Why a shadow repository
 *
 * The obvious implementations are all wrong in the same way: they use the
 * user's own git state.
 *
 *   - `git stash` moves their working tree out from under them, and a stash
 *     that fails to pop is a new disaster.
 *   - `git add -A` + `git write-tree` writes the user's index, so an agent
 *     turn silently stages everything they had carefully left unstaged.
 *   - A commit on their branch pollutes the history they are about to push.
 *
 * So checkpoints live in a **separate git directory** — `.soreqen/checkpoints.git`
 * — pointed at the same working tree. Its index, its refs and its objects are
 * ours. The user's `.git` is never read from, written to, or even required to
 * exist: checkpoints work in a directory that has never seen git.
 *
 * ## What it does not restore
 *
 * Files in the workspace, and nothing else. Not a pushed commit, not a
 * published package, not a dropped table, not a package's install script that
 * has already run, not a request that already left the machine. This boundary
 * is not an implementation limit to be papered over later — it is the exact
 * line `auto` mode uses to decide what to ask about, so it needs to be
 * *stated*, not approximated. See `modes.ts`.
 *
 * ## Restoring is itself checkpointed
 *
 * `restore` snapshots the current state before overwriting it. Undo that
 * cannot be undone is a second way to lose work, and the whole point of this
 * file is to have fewer of those.
 */

import type { SandboxRunner } from "@sqcode/sandbox-runner";

/** Where the shadow repository lives, relative to the workspace root. */
const SHADOW_DIR = ".soreqen/checkpoints.git";

/**
 * A `.soreqen/…` path as a shell command has to name it.
 *
 * The runner resolves `.soreqen/…` for its own file operations, into a data
 * folder outside the project when the workspace keeps one there
 * (`SandboxOptions.dataPath`). A command line is not a file operation — git
 * is handed the string as written — so it gets the real place.
 */
export function commandPath(runner: SandboxRunner, workspaceId: string, rel: string): string {
  const data = runner.dataPathOf?.(workspaceId);
  if (!data || !rel.startsWith(".soreqen/")) return rel;
  return `${data.replace(/\\/g, "/")}/${rel.slice(".soreqen/".length)}`;
}

/**
 * Never snapshotted, whatever the project's own `.gitignore` says.
 *
 * A workspace with no `.gitignore` — a fresh directory, a non-JS project that
 * grew a `node_modules` — would otherwise have a few hundred megabytes of
 * dependencies copied into the object store on every turn, which turns a
 * safety feature into the slowest thing in the product.
 *
 * These are all directories that are reproducible from a manifest. Losing
 * them to a restore costs an install; keeping them costs every checkpoint.
 */
const ALWAYS_EXCLUDE = [
  ".soreqen/",
  "node_modules/",
  ".venv/",
  "venv/",
  "__pycache__/",
  ".mypy_cache/",
  ".pytest_cache/",
  "dist/",
  "build/",
  ".next/",
  ".turbo/",
  ".nuxt/",
  "target/",
  ".gradle/",
  "*.pyc",
  ".DS_Store",
];

/** Checkpoints kept per workspace. Twenty turns is far more history than
 *  anyone reaches back through, and the objects are shared, so the cost of
 *  keeping them is close to zero. */
const MAX_CHECKPOINTS = 20;

/**
 * How much history to let accumulate before trimming.
 *
 * Retention runs once per batch rather than once per checkpoint. Objects are
 * shared between snapshots, so carrying an extra ten commits costs almost
 * nothing on disk — while re-running the trim on every turn costs a process
 * launch per retained commit, every turn, for ever.
 */
const PRUNE_BATCH = 10;

/**
 * Separates the hash from the subject in `git log --format=%H%x1f%s`.
 *
 * A control character, so it cannot occur inside a commit subject. Written as
 * an escape rather than embedded literally: an invisible byte in source is
 * something the next reader deletes by accident and cannot see they have.
 */
const UNIT_SEPARATOR = "\u001f";

/** A checkpoint should never be the slow part of a turn. If git cannot do it
 *  in this long, something is wrong with the workspace and the turn should
 *  proceed uncheckpointed rather than stall. */
const GIT_TIMEOUT_MS = 30_000;

export interface Checkpoint {
  /** The shadow commit. Opaque to callers; pass it back to `restore`. */
  id: string;
  /** When it was taken. */
  createdAt: string;
  /** The prompt this checkpoint precedes, trimmed for display. */
  label: string;
  /** Files differing from the previous checkpoint, for the listing. Empty on
   *  the first checkpoint, where everything is "new" and saying so is noise. */
  changedFiles: string[];
}

export interface CheckpointResult {
  ok: boolean;
  checkpoint?: Checkpoint;
  /** Why it could not be taken. Present exactly when `ok` is false, and
   *  phrased for a user, because `auto` mode shows it as the reason it has
   *  started asking about writes. */
  reason?: string;
}

export interface RestoreResult {
  ok: boolean;
  /** Files the restore changed on disk. */
  restoredFiles: string[];
  /** The checkpoint taken of the pre-restore state, so the undo is undoable. */
  undoId?: string;
  reason?: string;
}

interface GitOutcome {
  exitCode: number;
  stdout: string;
  stderr: string;
}

/**
 * Run one git command against the shadow repository.
 *
 * `-c core.hooksPath=/dev/null` matters more than it looks: a repository with
 * a `pre-commit` hook that runs the test suite would make every checkpoint
 * take minutes, and a hook that calls `exit 1` would make checkpointing fail
 * for reasons that have nothing to do with checkpointing. The user's hooks
 * are for the user's commits.
 */
async function git(
  runner: SandboxRunner,
  workspaceId: string,
  args: string,
): Promise<GitOutcome> {
  const res = await runner.execCommand(workspaceId, {
    command:
      `git --git-dir="${commandPath(runner, workspaceId, SHADOW_DIR)}" --work-tree=. ` +
      `-c core.hooksPath=/dev/null -c gc.auto=0 -c core.autocrlf=false ${args}`,
    timeoutMs: GIT_TIMEOUT_MS,
  });
  return {
    exitCode: res.exitCode,
    stdout: (res.stdout ?? "").trim(),
    stderr: (res.stderr ?? "").trim(),
  };
}

/**
 * Workspaces whose shadow repository is known to exist in this process.
 *
 * Setting it up costs several process spawns, and process spawn is the
 * expensive operation here — on Windows it is 50–150ms each, so an unmemoised
 * setup added most of a second to the front of every turn before the model was
 * even called. The check is per-process and per-workspace; a `false` entry is
 * never cached, because a workspace that could not be set up once may be
 * fixable (git installed, permissions corrected) and re-probing costs one
 * command.
 */
const initialised = new Set<string>();

/**
 * Create the shadow repository if it is not there.
 *
 * Idempotent: `git init` on an existing repository is a no-op, and the config
 * and exclude writes are unconditional so a workspace set up by an older
 * version picks up a newer exclude list. Memoised per process, because this is
 * several process spawns and process spawn is the expensive part.
 */
async function ensureShadowRepo(
  runner: SandboxRunner,
  workspaceId: string,
): Promise<{ ok: boolean; reason?: string }> {
  if (initialised.has(workspaceId)) return { ok: true };

  try {
    /*
     * The exclude file is written first, and it is what creates the directory.
     *
     * `git init --git-dir=.soreqen/checkpoints.git` fails outright when
     * `.soreqen` does not exist — "fatal: Invalid path … No such file or
     * directory" — because `--git-dir` names a location git expects to be
     * reachable, not one it will build a path to. So the directory has to
     * exist first, and writing the exclude file into it is the one operation
     * that has to happen anyway.
     *
     * It is written with `writeFile` rather than a shell command, which is the
     * second lesson this function learned the hard way. The first version used
     * `printf`, then a heredoc, `mkdir -p`, `||` and `>/dev/null` — all
     * POSIX-only, and the local sandbox runs **PowerShell on Windows**, where
     * every one of those is either a syntax error or silently different. The
     * effect was that checkpointing failed on Windows entirely, which takes
     * `auto` mode's whole premise with it: the mode reports "no checkpoint
     * available" and quietly stops relaxing anything, on the platform the
     * product is being developed on.
     *
     * Nothing in this file may assume a shell dialect.
     */
    await runner.writeFile(
      workspaceId,
      `${SHADOW_DIR}/info/exclude`,
      `${ALWAYS_EXCLUDE.join("\n")}\n`,
      true,
    );

    /*
     * Hide the checkpoint store from the *user's* git, not only from ours.
     *
     * `.soreqen/checkpoints.git` holds a full object database of every
     * snapshot — potentially the entire workspace, several times over. Without
     * this it shows up in the user's `git status`, gets swept up by a `git add
     * -A`, and ends up committed and pushed. A safety feature that silently
     * adds megabytes to someone's repository is a safety feature they remove.
     *
     * The ignore file lives inside `.soreqen/` and covers the whole directory,
     * so it works whether or not the workspace has a `.gitignore`, and it
     * cannot be undone by a project reformatting its own.
     */
    await runner.writeFile(
      workspaceId,
      ".soreqen/.gitignore",
      [
        "# Written by SoreQen Code. This directory holds workspace snapshots",
        "# and local agent state; none of it belongs in your repository.",
        "*",
        "",
      ].join("\n"),
      true,
    );

    const init = await git(runner, workspaceId, "init --quiet");
    if (init.exitCode !== 0) {
      /*
       * Classify the failure with a direct probe rather than by reading tea
       * leaves in stderr.
       *
       * The previous version pattern-matched "no such file" as "git is
       * missing", and then reported *exactly that* for a failure that had
       * nothing to do with git being absent — sending anyone debugging it to
       * check their PATH while the real cause was a missing directory. One
       * extra spawn, once per workspace, buys an answer that is actually true.
       */
      const probe = await runner.execCommand(workspaceId, {
        command: "git --version",
        timeoutMs: 10_000,
      });
      return {
        ok: false,
        reason:
          probe.exitCode !== 0
            ? "git is not available in this workspace"
            : `could not create the checkpoint store: ${init.stderr.slice(0, 200)}`,
      };
    }

    // An identity is required for `commit` and the user's may not be set. It
    // goes into the shadow repo's own config, so it cannot affect their commits.
    await git(runner, workspaceId, 'config user.email "checkpoints@soreqen.local"');
    await git(runner, workspaceId, 'config user.name "SoreQen Checkpoints"');

    initialised.add(workspaceId);
    return { ok: true };
  } catch (err: unknown) {
    return { ok: false, reason: err instanceof Error ? err.message : String(err) };
  }
}

/** Forget a workspace's initialisation state. For tests, and for a workspace
 *  that has been destroyed and recreated under the same id. */
export function resetCheckpointState(workspaceId?: string): void {
  if (workspaceId) initialised.delete(workspaceId);
  else initialised.clear();
}

/**
 * Snapshot the workspace.
 *
 * Returns `ok: false` rather than throwing when the workspace cannot be
 * checkpointed. A turn must still run without one — an agent that refuses to
 * work in a directory git cannot handle is worse than an agent with no undo —
 * but the caller has to *know*, because `auto` mode's confirmation rule
 * depends on it.
 */
export async function createCheckpoint(
  runner: SandboxRunner,
  workspaceId: string,
  label: string,
): Promise<CheckpointResult> {
  try {
    const ready = await ensureShadowRepo(runner, workspaceId);
    if (!ready.ok) return { ok: false, reason: ready.reason };

    const trimmed = label.replace(/\s+/g, " ").trim().slice(0, 120) || "checkpoint";

    const add = await git(runner, workspaceId, "add -A");
    if (add.exitCode !== 0) {
      return { ok: false, reason: `could not stage the workspace: ${add.stderr.slice(0, 200)}` };
    }

    /*
     * The message goes through a file, not through the command line.
     *
     * A checkpoint's label is the user's own prompt, so it can contain
     * anything: quotes, backticks, `$`, semicolons, a newline. `-m` with
     * `JSON.stringify` looks like it handles that and does not — JSON's `\"`
     * is a C escape, and PowerShell escapes with a backtick and doubles its
     * quotes, so a prompt containing a quotation mark broke the command on
     * Windows and would have been an injection point on POSIX.
     *
     * `-F` takes the message verbatim from a file, which has no quoting rules
     * at all. The file lives inside the shadow git dir, which is on the
     * exclude list, so it is never itself snapshotted.
     *
     * `--allow-empty` because two turns in a row that change nothing must each
     * still produce a checkpoint — otherwise the ids callers are holding start
     * pointing at the wrong moment in the session.
     */
    const messagePath = `${SHADOW_DIR}/SOREQEN_CHECKPOINT_MSG`;
    await runner.writeFile(workspaceId, messagePath, trimmed, true);

    const commit = await git(
      runner,
      workspaceId,
      `commit --allow-empty --quiet --cleanup=verbatim -F "${commandPath(runner, workspaceId, messagePath)}"`,
    );
    if (commit.exitCode !== 0) {
      return {
        ok: false,
        reason: `could not record the checkpoint: ${commit.stderr.slice(0, 200)}`,
      };
    }

    const head = await git(runner, workspaceId, "rev-parse HEAD");
    const id = head.stdout.split(/\s+/)[0] ?? "";
    if (!/^[0-9a-f]{40}$/.test(id)) {
      return { ok: false, reason: "the checkpoint was written but could not be identified" };
    }

    /*
     * Pruning is fire-and-forget.
     *
     * It is housekeeping on a history nobody is reading right now, and it was
     * costing two to four extra spawns on the critical path to decide, almost
     * every time, that there was nothing to do. Failures are already ignored;
     * making it not block is the same decision applied to latency.
     */
    /*
     * Awaited now, because it is finally safe to await.
     *
     * It was fire-and-forget to keep a few git spawns off the critical path,
     * and that is exactly what let it race a restore. Now that it only writes
     * a ref it is fast and it touches nothing anyone else is reading, so the
     * ordering guarantee is worth far more than the milliseconds.
     */
    await prune(runner, workspaceId).catch(() => undefined);

    return {
      ok: true,
      checkpoint: {
        id,
        createdAt: new Date().toISOString(),
        label: trimmed,
        // Populated by `listCheckpoints` when a listing is actually asked for.
        // Computing it here cost a spawn per turn for a field used only by a
        // command the user has to type.
        changedFiles: [],
      },
    };
  } catch (err: unknown) {
    return { ok: false, reason: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * Put the workspace back.
 *
 * Two commands, and both are needed. `read-tree -u --reset` moves the index
 * and the working tree to the checkpoint, which removes files that existed
 * then and do not now. It cannot remove files created *since*, because those
 * were never in the index — `clean -fd` does that.
 *
 * Note the missing `-x` on `clean`: ignored files are left alone. Restoring a
 * checkpoint should not delete someone's `.env` or force a re-install of
 * `node_modules`, and neither was ever snapshotted, so removing them would be
 * destroying state the checkpoint never claimed to manage.
 */
export async function restoreCheckpoint(
  runner: SandboxRunner,
  workspaceId: string,
  checkpointId: string,
): Promise<RestoreResult> {
  try {
    const ready = await ensureShadowRepo(runner, workspaceId);
    if (!ready.ok) return { ok: false, restoredFiles: [], reason: ready.reason };

    const known = await git(runner, workspaceId, `cat-file -t ${checkpointId}`);
    if (known.exitCode !== 0 || known.stdout !== "commit") {
      return {
        ok: false,
        restoredFiles: [],
        reason: `no checkpoint with id '${checkpointId.slice(0, 12)}' exists in this workspace`,
      };
    }

    // What is about to change, captured before it does — `diff` against the
    // target is meaningless once the tree matches it.
    const diff = await git(runner, workspaceId, `diff --name-only ${checkpointId}`);
    const restoredFiles =
      diff.exitCode === 0 && diff.stdout ? diff.stdout.split("\n").filter(Boolean) : [];

    /*
     * The undo of the undo.
     *
     * Restoring is destructive by design. Someone who rewinds one turn too far
     * has just lost real work to a safety feature, which is the least
     * forgivable way to lose it.
     */
    const undo = await createCheckpoint(
      runner,
      workspaceId,
      `before restoring ${checkpointId.slice(0, 8)}`,
    );

    const read = await git(runner, workspaceId, `read-tree -u --reset ${checkpointId}`);
    if (read.exitCode !== 0) {
      return {
        ok: false,
        restoredFiles: [],
        reason: `could not restore: ${read.stderr.slice(0, 200)}`,
      };
    }

    const clean = await git(runner, workspaceId, "clean -fd --quiet");
    if (clean.exitCode !== 0) {
      // The tree is already correct for everything that was tracked; only
      // newly-created files may remain. Worth reporting, not worth failing.
      return {
        ok: true,
        restoredFiles,
        undoId: undo.checkpoint?.id,
        reason: `restored, but some new files could not be removed: ${clean.stderr.slice(0, 160)}`,
      };
    }

    return { ok: true, restoredFiles, undoId: undo.checkpoint?.id };
  } catch (err: unknown) {
    return {
      ok: false,
      restoredFiles: [],
      reason: err instanceof Error ? err.message : String(err),
    };
  }
}

/** Checkpoints in this workspace, newest first. */
export async function listCheckpoints(
  runner: SandboxRunner,
  workspaceId: string,
): Promise<Checkpoint[]> {
  try {
    const ready = await ensureShadowRepo(runner, workspaceId);
    if (!ready.ok) return [];

    // A unit separator between fields and a record separator between commits:
    // subjects contain spaces, and a checkpoint label is the user's own prompt,
    // which can contain anything at all including newlines.
    const log = await git(
      runner,
      workspaceId,
      `log --max-count=${MAX_CHECKPOINTS} "--format=%H%x1f%cI%x1f%s%x1e"`,
    );
    if (log.exitCode !== 0 || !log.stdout) return [];

    return log.stdout
      .split("\x1e")
      .map((r) => r.trim())
      .filter(Boolean)
      .map((record) => {
        const [id, createdAt, label] = record.split("\x1f");
        return {
          id: id ?? "",
          createdAt: createdAt ?? "",
          label: label ?? "checkpoint",
          changedFiles: [],
        };
      })
      .filter((c) => c.id.length > 0);
  } catch {
    return [];
  }
}

/**
 * Drop checkpoints past the retention limit.
 *
 * The history is rewritten to start at the newest kept commit, and the
 * unreachable objects are collected. Failure is ignored on purpose: a
 * workspace with slightly too many checkpoints is not a problem, and a turn
 * that fails because housekeeping did is.
 */
/**
 * Drop history past the retention limit, without ever touching the files.
 *
 * ## What the previous version did, and why it was the worst bug in the repo
 *
 * It ran `git rebase --onto <graft> <cutoff> HEAD` on a shadow repository
 * whose `--work-tree` is **the user's actual project directory** — and it ran
 * it *unawaited*, from `createCheckpoint`, so it executed concurrently with
 * whatever the agent did next.
 *
 * A rebase checks out every intermediate commit in turn. For the seconds it
 * runs, the files on disk are being rewritten underneath the agent. That is
 * how it destroyed data: `restoreCheckpoint` uses `clean -fd` *without* `-x`
 * specifically so a restore never deletes someone's `.env` — but that
 * protection depends on `.gitignore` being present on disk at the instant
 * `clean` runs, and a concurrent rebase passes through commits where it is
 * not. The repository's own test caught it (`leaves ignored files alone on
 * restore`) and it read as a flake, because it only fires once a workspace has
 * accumulated enough checkpoints to trigger pruning at all.
 *
 * It also did not work. `rebase … HEAD` detaches HEAD, leaves the branch
 * pointing at the full original history, and therefore frees nothing when
 * `gc --prune=now` follows. Verified directly: 22 commits in, 22 commits
 * after, HEAD detached.
 *
 * ## What this does instead
 *
 * Rewrites the branch **ref** and nothing else. `commit-tree` builds a new
 * root holding the cutoff's tree; each retained commit is re-created on top of
 * it with `commit-tree`, reusing the existing tree objects — so no file is
 * ever written, no index is touched, and the working tree is not involved at
 * any point. Then `update-ref` moves the branch, and `gc` can finally free
 * what is no longer reachable.
 */
async function prune(runner: SandboxRunner, workspaceId: string): Promise<void> {
  try {
    const count = await git(runner, workspaceId, "rev-list --count HEAD");
    const total = Number.parseInt(count.stdout, 10);

    /*
     * Hysteresis: prune in batches, not on every checkpoint.
     *
     * Triggering at `> MAX_CHECKPOINTS` meant this ran on *every single turn*
     * once a workspace passed twenty — rebuilding twenty commits each time to
     * drop one. Waiting until there is a batch worth removing makes the
     * amortised cost per turn negligible, and the only thing anyone loses is a
     * slightly longer tail of history, which is free: the objects are shared.
     */
    if (!Number.isFinite(total) || total < MAX_CHECKPOINTS + PRUNE_BATCH) return;

    const branch = await git(runner, workspaceId, "symbolic-ref --quiet HEAD");
    if (branch.exitCode !== 0 || !branch.stdout) return;

    /*
     * Hashes and subjects together, in one spawn.
     *
     * Asking `git log -1 --format=%s` per commit is twenty extra process
     * launches, and a process launch on Windows is tens of milliseconds. One
     * `log` with a record separator gives the same information for the cost of
     * one.
     */
    const listed = await git(
      runner,
      workspaceId,
      `log --reverse --max-count=${MAX_CHECKPOINTS} --format=%H%x1f%s HEAD`,
    );
    if (listed.exitCode !== 0 || !listed.stdout) return;

    const entries = listed.stdout
      .split(/\r?\n/)
      .map((line) => line.split(UNIT_SEPARATOR))
      .filter((parts): parts is [string, string] => Boolean(parts[0]))
      .map(([hash, subject]) => ({ hash, subject: subject ?? "checkpoint" }));
    if (entries.length === 0) return;

    /*
     * Rebuild the retained chain on a new, parentless root.
     *
     * Each `commit-tree` reuses the existing tree object, so nothing is
     * written to the working tree and no file is touched — which is the entire
     * difference between this and the rebase it replaces.
     */
    const messagePath = `${SHADOW_DIR}/SOREQEN_PRUNE_MSG`;
    let parent = "";
    for (const [index, entry] of entries.entries()) {
      const message = index === 0 ? "checkpoint history trimmed" : entry.subject;
      await runner.writeFile(workspaceId, messagePath, message, true);

      const rebuilt = await git(
        runner,
        workspaceId,
        `commit-tree ${entry.hash}^{tree}` +
          (parent ? ` -p ${parent}` : "") +
          ` -F "${commandPath(runner, workspaceId, messagePath)}"`,
      );
      if (rebuilt.exitCode !== 0 || !rebuilt.stdout) return;
      parent = rebuilt.stdout.split(/\s+/)[0] ?? "";
      if (!parent) return;
    }

    /*
     * Move the branch, not the working tree.
     *
     * `update-ref` writes 41 bytes into `refs/`. Nothing is checked out,
     * nothing on disk changes, and HEAD stays attached to the branch it was
     * already on — all three of which the rebase got wrong.
     */
    const moved = await git(runner, workspaceId, `update-ref ${branch.stdout} ${parent}`);
    if (moved.exitCode !== 0) return;

    await git(runner, workspaceId, "reflog expire --expire=now --all");
    await git(runner, workspaceId, "gc --prune=now --quiet");
  } catch {
    // Housekeeping. Never fatal.
  }
}

/**
 * Whether this workspace can be checkpointed at all.
 *
 * Called once per turn before the mode's confirmation rule is chosen, so
 * `auto` can degrade honestly instead of assuming an undo it does not have.
 */
export async function checkpointsAvailable(
  runner: SandboxRunner,
  workspaceId: string,
): Promise<boolean> {
  const ready = await ensureShadowRepo(runner, workspaceId);
  return ready.ok;
}

/** A short, human id for display — the same first-eight convention git uses,
 *  so it can be pasted back into git commands against the shadow repo. */
export function shortId(id: string): string {
  return id.slice(0, 8);
}
