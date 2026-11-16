/**
 * What earlier sessions established about this workspace.
 *
 * Task state belongs to one session: a new conversation in the same project
 * started knowing nothing, and re-discovered — at the cost of steps — that the
 * tests run with `pnpm vitest`, that the database is on 5433, that the API
 * lives in `src/server`. Facts like those outlive the task that found them.
 *
 * Only *facts* are carried — claims with evidence. Hypotheses stay with the
 * session that had them, and so do decisions, which answer that session's
 * request rather than describe the code. Every carried fact records the
 * revision of each file it cites; when a later session reads it, a fact whose
 * file has changed since is dropped, not shown. Knowledge that might be out of
 * date is exactly what this must never hand over silently.
 */

import type { SandboxRunner } from "@sqcode/sandbox-runner";
import { estimateTokens } from "@sqcode/shared";
import { refersTo, type StateEntry } from "./task-state.js";

export const WORKSPACE_KNOWLEDGE_PATH = ".soreqen/state/_workspace.json";
const MAX_ENTRIES = 80;
/**
 * How long a fact that cites no file is believed.
 *
 * A fact pinned to files is checked against their hashes every time it is
 * shown. One that cites none — "the database is on 5433", "tests run with
 * pnpm vitest" — has nothing to check against, and was shown for ever: the
 * port changes, the claim does not. It now lapses unless a later session
 * finds it again, which refreshes it.
 */
export const UNPINNED_TTL_MS = 14 * 24 * 60 * 60 * 1000;

/** Whether a fact may still be shown: its files unchanged, or, citing none, recently re-established. */
export function isCurrent(k: KnowledgeEntry, hashOf: (path: string) => string | undefined, now: number): boolean {
  const files = Object.entries(k.files ?? {});
  if (files.length === 0) return now - k.at <= UNPINNED_TTL_MS;
  return files.every(([p, hash]) => hashOf(p) === hash);
}

export interface KnowledgeEntry {
  text: string;
  /** Where it came from, as the session recorded it. */
  source: string;
  /** Files the evidence cites, with the content hash each had then. */
  files: Record<string, string>;
  sessionId: string;
  at: number;
}

const normalise = (text: string): string => text.toLowerCase().replace(/\s+/g, " ").replace(/[.!]+$/, "").trim();

export class WorkspaceKnowledge {
  private dirty = false;

  private constructor(
    public entries: KnowledgeEntry[],
    private readonly runner: SandboxRunner | null,
    private readonly workspaceId: string,
  ) {}

  static empty(): WorkspaceKnowledge {
    return new WorkspaceKnowledge([], null, "");
  }

  static async load(runner: SandboxRunner, workspaceId: string): Promise<WorkspaceKnowledge> {
    try {
      const { content } = await runner.readFile(workspaceId, WORKSPACE_KNOWLEDGE_PATH);
      const parsed = JSON.parse(content) as { version?: number; entries?: KnowledgeEntry[] };
      if (parsed?.version === 1 && Array.isArray(parsed.entries)) return new WorkspaceKnowledge(parsed.entries, runner, workspaceId);
    } catch {
      // None yet.
    }
    return new WorkspaceKnowledge([], runner, workspaceId);
  }

  /**
   * Carry a session's evidenced facts into workspace knowledge.
   *
   * `hashOf` gives a file's current content hash, when it is known; a fact
   * citing a file whose revision cannot be pinned is not carried, since it
   * could never be checked for staleness later.
   */
  promote(sessionId: string, entries: StateEntry[], paths: string[], hashOf: (path: string) => string | undefined): number {
    let added = 0;
    for (const e of entries) {
      if (e.kind !== "fact" || (e.status !== "active" && e.status !== "confirmed")) continue;
      const cited = paths.filter((p) => refersTo(e.source.ref, p));
      const files: Record<string, string> = {};
      for (const p of cited) {
        const hash = hashOf(p);
        if (hash) files[p] = hash;
      }
      if (cited.length > 0 && Object.keys(files).length !== cited.length) continue;
      const key = normalise(e.text);
      const existing = this.entries.find((k) => normalise(k.text) === key);
      if (existing) {
        existing.files = files;
        existing.at = Date.now();
      } else {
        this.entries.push({ text: e.text, source: e.source.ref, files, sessionId, at: Date.now() });
        added++;
      }
      this.dirty = true;
    }
    // Lapsed unpinned facts are dropped from the file, not just hidden.
    const now = Date.now();
    const before = this.entries.length;
    this.entries = this.entries.filter((k) => Object.keys(k.files ?? {}).length > 0 || now - k.at <= UNPINNED_TTL_MS);
    if (this.entries.length !== before) this.dirty = true;
    if (this.entries.length > MAX_ENTRIES) {
      this.entries.sort((a, b) => b.at - a.at);
      this.entries.length = MAX_ENTRIES;
    }
    return added;
  }

  /**
   * What a session may be shown: facts from *other* sessions whose cited
   * files are unchanged, not already in its own state.
   */
  current(
    sessionId: string,
    hashOf: (path: string) => string | undefined,
    known: StateEntry[],
    now: number = Date.now(),
  ): KnowledgeEntry[] {
    const own = new Set(known.map((e) => normalise(e.text)));
    return this.entries
      .filter((k) => k.sessionId !== sessionId && !own.has(normalise(k.text)))
      .filter((k) => isCurrent(k, hashOf, now))
      .sort((a, b) => b.at - a.at);
  }

  async save(): Promise<void> {
    if (!this.dirty || !this.runner) return;
    this.dirty = false;
    await this.runner
      .writeFile(this.workspaceId, WORKSPACE_KNOWLEDGE_PATH, JSON.stringify({ version: 1, entries: this.entries }, null, 1), true)
      .catch(() => {
        this.dirty = true;
      });
  }
}

/** The knowledge section of the working set, within a budget. */
export function renderKnowledge(entries: KnowledgeEntry[], budgetTokens: number): string {
  if (entries.length === 0 || budgetTokens < 60) return "";
  const lines = ["## WORKSPACE KNOWLEDGE (facts earlier sessions established; their files are unchanged since — still verify before relying)"];
  let used = estimateTokens(lines[0]!);
  for (const k of entries) {
    const line = `- ${k.text} (${k.source.slice(0, 80)})`;
    const cost = estimateTokens(line);
    if (used + cost > budgetTokens) break;
    lines.push(line);
    used += cost;
  }
  return lines.length > 1 ? lines.join("\n") : "";
}
