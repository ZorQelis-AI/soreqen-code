/**
 * The files an agent was working on, handed back after a checkpoint.
 *
 * A checkpoint cuts the older conversation and with it every file the agent
 * had read there. Its decisions survive in the task state; the code does not,
 * so the first thing a long run did after each checkpoint was read the same
 * files again — a step and a full round of thinking per file, several times
 * an hour (reported 29 Sep 2026). The files it was actually working on are
 * few and knowable: the ones the task state records it reading or changing
 * most recently. They go back into the context with the checkpoint, as they
 * are on disk now, and are recorded as read.
 *
 * What does not come back: a file still in the kept conversation (it is
 * already there), one deleted since, and anything past the budget. A file
 * too large to restore is described by its code-graph outline instead.
 */

import type { SandboxRunner } from "@sqcode/sandbox-runner";
import { PARSEABLE } from "../repo-map.js";
import type { LLMMessage } from "../types.js";
import { fileText, graphOf } from "./code-graph.js";
import type { RepoIndex } from "./repo-index.js";
import { contentHash, normalisePath, type TaskStateStore } from "./task-state.js";

export const RESTORE_MAX_FILES = 6;
/** In characters (about 24k tokens), all files together. */
export const RESTORE_BUDGET_CHARS = 96_000;
/** A single file past this is outlined, not restored. */
const RESTORE_FILE_CHARS = 32_000;

/** Paths whose content the kept conversation already shows: read, written or edited there. */
function pathsIn(history: LLMMessage[]): Set<string> {
  const out = new Set<string>();
  for (const m of history) {
    for (const call of m.toolCalls ?? []) {
      const path = (call.input as { path?: unknown })?.path;
      if (typeof path === "string" && ["read_file", "write_file", "edit_file"].includes(call.name)) out.add(normalisePath(path));
    }
  }
  return out;
}

export async function restoreWorkingFiles(input: {
  store: TaskStateStore;
  runner: SandboxRunner;
  workspaceId: string;
  index: RepoIndex | null;
  /** The conversation as it is after the cut. */
  kept: LLMMessage[];
  /**
   * At most this many characters. Restoring more than the room between the kept
   * tail and the next checkpoint would bring that checkpoint on at once.
   */
  budgetChars?: number;
}): Promise<{ text: string; files: string[] } | null> {
  const budget = Math.min(RESTORE_BUDGET_CHARS, input.budgetChars ?? RESTORE_BUDGET_CHARS);
  if (budget < 2_000) return null;
  const present = pathsIn(input.kept);
  /*
   * Being worked on: files it changed, first; then source files it read. Not a
   * document it read and moved past — a run reading thirty notes in turn had
   * the last of them restored after every checkpoint, and the room it took
   * brought the next checkpoint straight on.
   */
  const changed = (a: string): boolean => a === "edit" || a === "write";
  const candidates = Object.entries(input.store.state.files)
    .filter(([path, record]) => {
      if (record.lastAction === "delete" || present.has(normalisePath(path)) || path.startsWith(".soreqen/")) return false;
      return changed(record.lastAction) || (record.lastAction === "read" && PARSEABLE.test(path));
    })
    .sort((a, b) => Number(changed(b[1].lastAction)) - Number(changed(a[1].lastAction)) || b[1].step - a[1].step)
    .slice(0, RESTORE_MAX_FILES * 2);

  const parts: string[] = [];
  const restored: string[] = [];
  let used = 0;
  for (const [path] of candidates) {
    if (restored.length >= RESTORE_MAX_FILES || used >= budget) break;
    let content: string;
    try {
      content = (await input.runner.readFile(input.workspaceId, path)).content;
    } catch {
      continue; // Gone since.
    }
    if (content.slice(0, 1024).includes("\u0000")) continue;
    if (content.length > Math.min(RESTORE_FILE_CHARS, budget) || used + content.length > budget) {
      const outline = input.index ? fileText(input.index, graphOf(input.index), path) : null;
      if (outline && used + outline.length <= budget) {
        parts.push(`### ${path} — too large to restore whole (${content.split("\n").length} lines); its outline:\n${outline}\nRead only the line ranges you need.`);
        used += outline.length;
      }
      continue;
    }
    const lines = content.split("\n");
    const numbered = lines.map((l, i) => `${String(i + 1).padStart(4)}  ${l}`).join("\n");
    parts.push(`### ${path} (${lines.length} lines, as it is now)\n\`\`\`\n${numbered}\n\`\`\``);
    used += numbered.length;
    restored.push(path);
    // Its content is in the context again: reading it is not needed, and editing from it is safe.
    input.store.recordFile(path, "read", contentHash(content));
  }
  if (parts.length === 0) return null;
  return {
    text:
      `Files you were working on, restored as they are on disk now, so there is no need to read them again ` +
      `(read one again only if it changes):\n\n${parts.join("\n\n")}`,
    files: restored,
  };
}
