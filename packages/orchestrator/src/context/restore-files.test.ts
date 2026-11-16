/**
 * After a checkpoint, the files the agent was working on come back with it
 * (29 Sep 2026): long runs used to spend the steps after every checkpoint
 * reading the same files again.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { LocalSandboxRunner } from "@sqcode/sandbox-runner";
import { RepoIndex } from "./repo-index.js";
import { restoreWorkingFiles } from "./restore-files.js";
import { TaskStateStore, emptyTaskState } from "./task-state.js";

const ws = `restore_ws_${Date.now()}`;
let dir: string;
let runner: LocalSandboxRunner;

beforeAll(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "sqcode_restore_"));
  fs.mkdirSync(path.join(dir, "src"));
  fs.writeFileSync(path.join(dir, "src/game.ts"), "export function tick(dt: number) {\n  return dt * 2;\n}\n");
  fs.writeFileSync(path.join(dir, "src/still-here.ts"), "export const x = 1;\n");
  fs.writeFileSync(path.join(dir, "src/huge.ts"), `export function big() {\n${"  const v = 1;\n".repeat(3000)}}\n`);
  runner = new LocalSandboxRunner(dir);
  await runner.createWorkspace(ws, { storagePath: dir });
});
afterAll(() => fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));

describe("restoring the working files after a checkpoint", () => {
  it("brings back what was being worked on, skips what the kept conversation has, and outlines what is too big", async () => {
    const store = new TaskStateStore(emptyTaskState("s"));
    store.recordFile("src/game.ts", "edit");
    store.recordFile("src/still-here.ts", "read");
    store.recordFile("src/huge.ts", "read");
    store.recordFile("src/gone.ts", "read");
    const index = new RepoIndex(runner, ws);
    await index.refresh(true);

    const restored = await restoreWorkingFiles({
      store,
      runner,
      workspaceId: ws,
      index,
      kept: [{ role: "assistant", content: "", toolCalls: [{ id: "r1", name: "read_file", input: { path: "src/still-here.ts" } }] }],
    });

    expect(restored).not.toBeNull();
    expect(restored!.files).toEqual(["src/game.ts"]);
    expect(restored!.text).toContain("return dt * 2;");
    expect(restored!.text).not.toContain("export const x = 1;");
    expect(restored!.text).toMatch(/src\/huge\.ts — too large to restore whole[\s\S]*export function big/);
    expect(restored!.text).not.toContain("gone.ts");
    // Its content is in context again, so it counts as read.
    expect(store.state.files["src/game.ts"]?.lastAction).toBe("edit");
    expect(store.state.files["src/game.ts"]?.hash).toBeTruthy();
  });
});
