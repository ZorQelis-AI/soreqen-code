/**
 * Not reading the same file twice in one turn.
 *
 * ## The waste
 *
 * A turn that reads a file, edits it, and reads it back pays three full round
 * trips and puts three copies of the file in the context. The third read is
 * usually the model checking work it just did — reasonable behaviour that
 * happens to be free to satisfy, because we already know the answer.
 *
 * The same pattern shows up in `grep_search` (the model searches for a symbol,
 * gets distracted, searches again), in `list_directory` (twice for the same
 * directory, several passes apart), and in `find_symbol_definition`, which is
 * frequently called for a symbol whose definition is already in the transcript.
 *
 * ## The rule that keeps it correct
 *
 * Only **read-only** tools are cached, and every cached entry is dropped the
 * moment anything could have changed what it observed.
 *
 * "Anything could have changed it" is interpreted broadly and deliberately:
 *
 *   - a write to a path invalidates every entry mentioning that path;
 *   - `run_command` invalidates the **entire** workspace cache, because a
 *     command is opaque — `npm run build` rewrites a directory, `git checkout`
 *     rewrites everything, and there is no way to tell from the string which.
 *
 * That last rule gives up a lot of hits. It is still the right rule: a stale
 * read is a confident wrong answer about the user's own source, discovered
 * later, and no hit rate is worth that. The cache's job is to remove obviously
 * redundant reads, not to be clever.
 *
 * ## Scope
 *
 * One turn. The cache is created in the loop and dropped when the turn ends,
 * so nothing survives to become stale between messages, and no invalidation
 * has to reason about time. Cross-turn caching of *prompt prefixes* is a
 * different mechanism entirely and lives in the providers.
 */

import type { LLMToolCall } from "./types.js";

/**
 * Tools whose result depends only on state nothing in this list can change.
 *
 * Kept narrower than `PARALLEL_SAFE_TOOLS`, which it resembles.
 * `browser_screenshot` is parallel-safe but not cacheable — the page is a live
 * thing that animates, loads and responds to timers, so two screenshots a
 * second apart legitimately differ, and returning the first as the second is a
 * bug that looks like the browser being broken.
 */
const CACHEABLE = new Set([
  "read_file",
  "list_directory",
  "grep_search",
  "glob",
  "find_symbol_definition",
  "find_symbol_references",
]);

/**
 * Tools whose results do not depend on the workspace at all.
 *
 * A web search or a URL fetch survives a `run_command`, because no command in
 * the sandbox changes what a search engine returns. Tracked separately so the
 * blanket invalidation does not throw away the most expensive entries in the
 * cache for no reason.
 */
const EXTERNAL = new Set(["web_search", "fetch_url_content", "research"]);

interface Entry {
  content: string;
  success: boolean;
  /** Workspace-relative paths this result depends on, lower-cased. Empty for
   *  external results. */
  dependsOn: string[];
  /** True when nothing in the sandbox can affect it. */
  external: boolean;
}

export interface CacheStats {
  hits: number;
  misses: number;
  /** Rough tokens not re-sent because of a hit. Reported on the turn result,
   *  because a saving nobody measures is a saving nobody believes. */
  tokensSaved: number;
  invalidations: number;
}

/**
 * A stable key for a call.
 *
 * Object key order is insertion order in JavaScript, and a model streaming
 * tool arguments does not guarantee field order between calls — so
 * `{path, start_line}` and `{start_line, path}` describe the same read and
 * must produce the same key. Sorting the keys is the whole fix.
 */
export function cacheKey(name: string, input: Record<string, unknown>): string {
  const sorted = Object.keys(input)
    .sort()
    .map((k) => `${k}=${JSON.stringify(input[k])}`)
    .join("&");
  return `${name}(${sorted})`;
}

/** Paths a read-only call observes, for targeted invalidation. */
function dependenciesOf(input: Record<string, unknown>): string[] {
  const raw = input["path"];
  if (typeof raw === "string" && raw.length > 0) {
    return [raw.replace(/\\/g, "/").toLowerCase()];
  }
  // A search with no path root reads the whole workspace, so any write
  // invalidates it. Represented as the root, which every path is under.
  return ["."];
}

export class ToolResultCache {
  private entries = new Map<string, Entry>();
  private stats: CacheStats = { hits: 0, misses: 0, tokensSaved: 0, invalidations: 0 };

  /** A previous identical call's result, if it is still valid. */
  get(call: LLMToolCall): { content: string; success: boolean } | null {
    if (!this.isCacheable(call.name)) return null;
    const hit = this.entries.get(cacheKey(call.name, call.input));
    if (!hit) {
      this.stats.misses++;
      return null;
    }
    this.stats.hits++;
    this.stats.tokensSaved += Math.ceil(hit.content.length / 3.5);
    return { content: hit.content, success: hit.success };
  }

  set(call: LLMToolCall, content: string, success: boolean): void {
    if (!this.isCacheable(call.name)) return;
    /*
     * Failures are not cached.
     *
     * A failed read is very often transient — a file the agent is about to
     * create, a directory a command is about to make — and caching the failure
     * means the agent is told "not found" for the rest of the turn about a
     * file that now exists. The cost of re-running a failed read is a round
     * trip; the cost of caching it is the agent giving up on work it could do.
     */
    if (!success) return;

    this.entries.set(cacheKey(call.name, call.input), {
      content,
      success,
      dependsOn: EXTERNAL.has(call.name) ? [] : dependenciesOf(call.input),
      external: EXTERNAL.has(call.name),
    });
  }

  /**
   * Drop what a write could have changed.
   *
   * Prefix matching on the path, so writing `src/auth.ts` invalidates a
   * directory listing of `src` and a repo-wide grep, not only the exact read
   * of that file. Both directions are checked: an entry for `src/auth.ts` is
   * invalidated by a write to `src`, and an entry for `src` is invalidated by
   * a write to `src/auth.ts`.
   */
  invalidatePath(path: string): void {
    const target = path.replace(/\\/g, "/").toLowerCase();
    let dropped = 0;
    for (const [key, entry] of this.entries) {
      if (entry.external) continue;
      const affected = entry.dependsOn.some(
        (dep) => dep === "." || dep === target || dep.startsWith(`${target}/`) || target.startsWith(`${dep}/`),
      );
      if (affected) {
        this.entries.delete(key);
        dropped++;
      }
    }
    this.stats.invalidations += dropped;
  }

  /**
   * Drop everything the sandbox can touch.
   *
   * Called after any `run_command`, `git_operation` or `install_package` —
   * every one of which can rewrite arbitrary parts of the workspace with no
   * way to know which from the arguments. External results survive.
   */
  invalidateWorkspace(): void {
    let dropped = 0;
    for (const [key, entry] of this.entries) {
      if (entry.external) continue;
      this.entries.delete(key);
      dropped++;
    }
    this.stats.invalidations += dropped;
  }

  /** Apply the right invalidation for a call that just ran. */
  observeMutation(call: LLMToolCall): void {
    switch (call.name) {
      case "write_file":
      case "edit_file": {
        const path = String(call.input["path"] ?? "");
        if (path) this.invalidatePath(path);
        else this.invalidateWorkspace();
        return;
      }
      case "run_command":
      case "run_tests":
      case "git_operation":
      case "install_package":
      case "spawn_subagent":
        this.invalidateWorkspace();
        return;
      default:
        return;
    }
  }

  private isCacheable(name: string): boolean {
    return CACHEABLE.has(name) || EXTERNAL.has(name);
  }

  snapshot(): CacheStats {
    return { ...this.stats };
  }

  get size(): number {
    return this.entries.size;
  }
}

/** True for tools whose repeated identical call can be served from cache. */
export function isCacheableTool(name: string): boolean {
  return CACHEABLE.has(name) || EXTERNAL.has(name);
}
