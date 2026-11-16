/**
 * Checkpoints, against a real filesystem and a real git.
 *
 * Mocking git here would test nothing worth testing. The entire value of this
 * module is that a specific sequence of git commands produces a specific state
 * on disk — that `read-tree -u --reset` really does delete a file that existed
 * at the checkpoint, that `clean -fd` really does remove one created since,
 * and that neither of them touches the user's own repository. None of that is
 * observable through a fake.
 *
 * The one property everything else depends on: **a restore must not be able to
 * lose work that a restore could have saved.** Hence the undo-of-the-undo.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, existsSync, writeFileSync, readFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execSync } from "node:child_process";
import { LocalSandboxRunner } from "@sqcode/sandbox-runner";
import {
  checkpointsAvailable,
  createCheckpoint,
  listCheckpoints,
  resetCheckpointState,
  restoreCheckpoint,
  shortId,
} from "./checkpoint.js";

/** Skips the whole suite where git is genuinely absent, rather than reporting
 *  a failure that says nothing about this code. */
const hasGit = (() => {
  try {
    execSync("git --version", { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
})();

const wsId = "checkpoint_test_ws";
let root: string;
let runner: LocalSandboxRunner;

const file = (name: string): string => join(root, name);
const write = (name: string, content: string): void => {
  const full = file(name);
  mkdirSync(join(full, ".."), { recursive: true });
  writeFileSync(full, content, "utf-8");
};
const read = (name: string): string | null =>
  existsSync(file(name)) ? readFileSync(file(name), "utf-8") : null;

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), "sqcode-ckpt-"));
  runner = new LocalSandboxRunner(root);
  await runner.createWorkspace(wsId, { storagePath: root });
  resetCheckpointState();
});

afterAll(() => {
  try {
    rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  } catch {
    // Windows sometimes holds a git lock briefly. A temp directory left
    // behind is not worth failing a suite over.
  }
});

describe.runIf(hasGit)("checkpoints", () => {
  it("reports availability before anything has been snapshotted", async () => {
    expect(await checkpointsAvailable(runner, wsId)).toBe(true);
  });

  it("takes a checkpoint and returns an identifiable id", async () => {
    write("src/a.txt", "one");
    const res = await createCheckpoint(runner, wsId, "first");
    expect(res.ok).toBe(true);
    expect(res.checkpoint?.id).toMatch(/^[0-9a-f]{40}$/);
    expect(res.checkpoint?.label).toBe("first");
  });

  it("restores a modified file", async () => {
    write("src/a.txt", "one");
    const snap = await createCheckpoint(runner, wsId, "before edit");
    write("src/a.txt", "two");
    expect(read("src/a.txt")).toBe("two");

    const restored = await restoreCheckpoint(runner, wsId, snap.checkpoint!.id);
    expect(restored.ok).toBe(true);
    expect(read("src/a.txt")).toBe("one");
  });

  it("removes a file created after the checkpoint", async () => {
    // `read-tree -u --reset` alone cannot do this: the file was never in the
    // index, so `clean -fd` is what removes it. Both commands are needed and
    // this is the one that proves the second.
    const snap = await createCheckpoint(runner, wsId, "before create");
    write("src/new.txt", "brand new");
    expect(read("src/new.txt")).toBe("brand new");

    await restoreCheckpoint(runner, wsId, snap.checkpoint!.id);
    expect(read("src/new.txt")).toBeNull();
  });

  it("brings back a file deleted after the checkpoint", async () => {
    write("src/doomed.txt", "still here");
    const snap = await createCheckpoint(runner, wsId, "before delete");
    rmSync(file("src/doomed.txt"));
    expect(read("src/doomed.txt")).toBeNull();

    await restoreCheckpoint(runner, wsId, snap.checkpoint!.id);
    expect(read("src/doomed.txt")).toBe("still here");
  });

  it("restores a whole directory of changes at once", async () => {
    write("src/x.txt", "x1");
    write("src/y.txt", "y1");
    const snap = await createCheckpoint(runner, wsId, "before refactor");

    write("src/x.txt", "x2");
    write("src/y.txt", "y2");
    write("src/z.txt", "z2");

    await restoreCheckpoint(runner, wsId, snap.checkpoint!.id);
    expect(read("src/x.txt")).toBe("x1");
    expect(read("src/y.txt")).toBe("y1");
    expect(read("src/z.txt")).toBeNull();
  });

  /*
   * The property that makes the feature safe to use.
   *
   * Restoring is destructive by design. Someone who rewinds one turn too far
   * has just lost real work to a safety feature, which is the least forgivable
   * way to lose it.
   */
  it("checkpoints the pre-restore state, so the undo is undoable", async () => {
    write("src/precious.txt", "version one");
    const first = await createCheckpoint(runner, wsId, "v1");
    write("src/precious.txt", "version two");

    const restored = await restoreCheckpoint(runner, wsId, first.checkpoint!.id);
    expect(read("src/precious.txt")).toBe("version one");
    expect(restored.undoId).toBeDefined();

    // Rewound too far — go back to where we were.
    await restoreCheckpoint(runner, wsId, restored.undoId!);
    expect(read("src/precious.txt")).toBe("version two");
  });

  it("reports which files a restore will change", async () => {
    write("src/tracked.txt", "a");
    const snap = await createCheckpoint(runner, wsId, "listing");
    write("src/tracked.txt", "b");

    const restored = await restoreCheckpoint(runner, wsId, snap.checkpoint!.id);
    expect(restored.restoredFiles.some((f) => f.includes("tracked.txt"))).toBe(true);
  });

  it("lists checkpoints newest first, with their labels", async () => {
    await createCheckpoint(runner, wsId, "older entry");
    await createCheckpoint(runner, wsId, "newer entry");
    const list = await listCheckpoints(runner, wsId);
    expect(list.length).toBeGreaterThanOrEqual(2);
    expect(list[0]?.label).toBe("newer entry");
  });

  it("records a checkpoint even when nothing changed", async () => {
    // Without `--allow-empty` two consecutive no-op turns would share an id,
    // and every id a caller holds would start pointing at the wrong moment.
    const a = await createCheckpoint(runner, wsId, "same");
    const b = await createCheckpoint(runner, wsId, "same");
    expect(a.checkpoint?.id).not.toBe(b.checkpoint?.id);
  });

  it("refuses an id it does not know rather than doing something arbitrary", async () => {
    const res = await restoreCheckpoint(runner, wsId, "0".repeat(40));
    expect(res.ok).toBe(false);
    expect(res.reason).toMatch(/no checkpoint/i);
  });

  it("survives a label containing quotes and newlines", async () => {
    // The label is the user's own prompt, which can contain anything.
    const res = await createCheckpoint(runner, wsId, 'fix the "quoted" thing\nand more');
    expect(res.ok).toBe(true);
    expect(res.checkpoint?.label).not.toContain("\n");
  });

  it("hides itself from the workspace's own git", async () => {
    // A full object database of every snapshot must never end up in someone's
    // repository. Without this it shows up in their `git status`, is swept up
    // by `git add -A`, and gets pushed.
    await createCheckpoint(runner, wsId, "ignore file");
    const ignore = read(".soreqen/.gitignore");
    expect(ignore).not.toBeNull();
    expect(ignore).toContain("*");
  });

  it("does not create or touch a .git in the workspace", async () => {
    // The user's own repository must be untouched — no stash, no staged index,
    // no commit on their branch. The shadow repo is somewhere else entirely.
    await createCheckpoint(runner, wsId, "isolation");
    expect(existsSync(join(root, ".git"))).toBe(false);
    expect(existsSync(join(root, ".soreqen", "checkpoints.git"))).toBe(true);
  });

  it("does not snapshot excluded directories", async () => {
    mkdirSync(join(root, "node_modules", "pkg"), { recursive: true });
    writeFileSync(join(root, "node_modules", "pkg", "index.js"), "module.exports = 1;", "utf-8");

    const snap = await createCheckpoint(runner, wsId, "with deps");
    const listed = await runner.execCommand(wsId, {
      command: `git --git-dir=".soreqen/checkpoints.git" ls-tree -r --name-only ${snap.checkpoint!.id}`,
      timeoutMs: 15_000,
    });
    expect(listed.stdout).not.toContain("node_modules");
  });

  it("leaves ignored files alone on restore", async () => {
    // Restoring must not delete someone's .env or force a re-install. Those
    // were never snapshotted, so removing them destroys state the checkpoint
    // never claimed to manage — hence `clean -fd` without `-x`.
    writeFileSync(join(root, ".gitignore"), "secret.env\n", "utf-8");
    const snap = await createCheckpoint(runner, wsId, "with ignore rules");
    writeFileSync(join(root, "secret.env"), "TOKEN=abc", "utf-8");

    await restoreCheckpoint(runner, wsId, snap.checkpoint!.id);
    expect(read("secret.env")).toBe("TOKEN=abc");
  });
});

describe("presentation", () => {
  it("shortens an id the way git does, so it can be pasted back", () => {
    expect(shortId("a".repeat(40))).toBe("aaaaaaaa");
    expect(shortId("abc")).toBe("abc");
  });
});
