/**
 * Searching the workspace, whether or not ripgrep is installed.
 *
 * ## The bug this exists to fix
 *
 * Every search tool shelled out to `rg`. On a machine without ripgrep — which
 * is most Windows machines, and this one — `spawn` fails with `ENOENT`, the
 * runner reports a non-zero exit, and the tools were written as:
 *
 * ```ts
 * if (res.exitCode === 0 && res.stdout) { …collect matches… }
 * return { matches };
 * ```
 *
 * So a missing binary produced an empty match list and a successful result.
 * `grep_search` answered "no matches" for text that was plainly there, and
 * `find_symbol_definition` answered "not found" for a function on the next
 * line. The agent believes both, concludes the code does not exist, and writes
 * it again — which is the most expensive failure this system has, because
 * nothing looks broken at any point.
 *
 * Measured on this machine before the fix: three symbols that exist, three
 * confident "0 hits".
 *
 * ## What it does
 *
 * Ripgrep when it is there, because it is enormously faster and honours
 * `.gitignore`. A built-in scan when it is not — slower, but present on every
 * machine that can run Node, which is the whole point.
 *
 * And a missing binary is never mistaken for an empty result: `available`
 * says which engine answered, and a search that could not run at all is an
 * error rather than a silence.
 */

import type { SandboxRunner } from "@sqcode/sandbox-runner";

export interface SearchHit {
  file: string;
  line: number;
  /** The whole line, untrimmed (up to `LINE_KEEP` characters). */
  text: string;
  /** Where in `text` the first match starts, when known: what a long line is shown around. */
  column?: number;
}

export interface SearchOutcome {
  hits: SearchHit[];
  /** Which engine produced them. Reported to the model, because a fallback
   *  scan covers fewer files than ripgrep would and the difference is worth
   *  knowing when the answer is "nothing". */
  engine: "ripgrep" | "builtin";
  /** True when the scan stopped early at a limit, so "no more matches" is not
   *  implied by the absence of them. */
  truncated: boolean;
  /** How the query was read. */
  mode: SearchMode;
  /** True when it stopped at `maxHits`: there are more matches than `hits` holds. */
  capped?: boolean;
}

export interface SearchOptions {
  pattern: string;
  /**
   * true: a regular expression; false: literal text. Unset: a query that
   * reads as a pattern (`a|b`, `\bword\b`, `foo.*bar`) is searched both ways,
   * and anything else as literal text. See `searchModeOf`.
   */
  isRegex?: boolean;
  caseSensitive?: boolean;
  /** Directory or file to search, workspace-relative. */
  path?: string;
  /** Glob filters, ripgrep syntax: `*.ts`, `src/**\/*.tsx`. */
  includes?: string[];
  maxHits?: number;
  signal?: AbortSignal;
}

/*
 * Enough to count what matched and show the start of it.
 *
 * It was 200, and the hits went out whole as JSON, so a common word's search
 * was clipped in the middle and then digested to a few "key lines" (reported
 * 18 Oct 2026: "the grep results are too long and get truncated"). Hits are
 * now cheap to hold, and how many are *shown* is decided where the result is
 * written, in `search-result.ts`.
 */
const DEFAULT_MAX_HITS = 1_000;
/** Ripgrep's own cap, per file: one huge generated file must not use up the whole count. */
const RG_PER_FILE = 100;
/** How much of a matching line is kept; it is shortened around the match where it is shown. */
const LINE_KEEP = 2_000;

export type SearchMode = "literal" | "regex" | "both";

/** Characters that only mean something in a pattern. A lone `.` is not one: `config.ts` is text. */
const PATTERN_SYNTAX = /[|\\^$*+?()[\]{}]|\.[*+?]/;

/**
 * How a query is searched.
 *
 * An explicit `isRegex` is taken at its word. Otherwise a query that reads as
 * a pattern and compiles as one is searched as a pattern *and* as literal
 * text, a line matching either counting: `Hello Amazon|Hello AWS` finds every
 * line with either greeting, and `price ($5)` still finds itself.
 */
export function searchModeOf(pattern: string, isRegex?: boolean): SearchMode {
  if (isRegex === true) return "regex";
  if (isRegex === false || !PATTERN_SYNTAX.test(pattern)) return "literal";
  try {
    new RegExp(pattern);
    return "both";
  } catch {
    return "literal";
  }
}

/** Files the builtin scan never opens. Mirrors the runner's own walk list —
 *  build output and dependencies are not what anyone is searching for, and
 *  they are the overwhelming majority of bytes in a real project. */
const SKIP = /(^|\/)(node_modules|\.git|\.soreqen|dist|build|out|coverage|\.next|\.nuxt|\.turbo|\.venv|venv|__pycache__|target|vendor|\.cache|\.idea|\.vscode|Pods)(\/|$)/;

/** Bytes past which a file is assumed to be generated or binary. */
const MAX_FILE_BYTES = 400_000;

/**
 * Files no text search reads: data, media, archives, compiled code. A
 * project's `data/` of 100,000 clips used to fill the walk before its code
 * was reached (15 Oct 2026); now they are passed over during the walk.
 */
const NOT_TEXT =
  /\.(npz|npy|pt|pth|ckpt|safetensors|onnx|bin|pkl|pickle|h5|hdf5|parquet|arrow|feather|tfrecord|wav|mp3|flac|ogg|m4a|aac|opus|mp4|mkv|mov|avi|webm|png|jpe?g|gif|webp|bmp|ico|tiff?|psd|pdf|zip|tar|gz|tgz|bz2|xz|7z|rar|exe|dll|so|dylib|o|a|lib|class|jar|woff2?|ttf|otf|eot|sqlite|db)$/i;

/**
 * A listed path as seen from the folder searched: `src/app/x.ts` searched in
 * `src` is `app/x.ts`, and `D:/Models/Lyra/scripts/x.py` searched in
 * `D:\Models\Lyra` is `scripts/x.py`. What the skip list and a pattern are
 * judged on, so searching inside `node_modules` on purpose finds what is
 * there, and a pattern means the same in a folder elsewhere as here.
 */
function below(root: string | undefined): (path: string) => string {
  const raw = (root ?? ".").replace(/\\/g, "/").replace(/\/+$/, "");
  const r = raw === "." || raw === "" ? "" : raw.replace(/^\.\//, "");
  const prefix = r ? `${r}/`.toLowerCase() : "";
  return (path) => {
    const p = path.replace(/\\/g, "/").replace(/^\.\//, "");
    return prefix && p.toLowerCase().startsWith(prefix) ? p.slice(prefix.length) : p;
  };
}

/*
 * Probed once per process.
 *
 * The answer cannot change while the agent runs, and probing on every search
 * would add a process launch to the cheapest operation in the toolkit.
 */
let ripgrepAvailable: boolean | null = null;

async function hasRipgrep(runner: SandboxRunner, workspaceId: string): Promise<boolean> {
  if (ripgrepAvailable !== null) return ripgrepAvailable;
  try {
    const res = await runner.execCommand(workspaceId, {
      argv: ["rg", "--version"],
      timeoutMs: 5_000,
    });
    ripgrepAvailable = res.exitCode === 0;
  } catch {
    ripgrepAvailable = false;
  }
  return ripgrepAvailable;
}

/** For tests, and for a runner whose environment changed. */
export function resetSearchEngineProbe(): void {
  ripgrepAvailable = null;
}

export async function searchWorkspace(
  runner: SandboxRunner,
  workspaceId: string,
  options: SearchOptions,
): Promise<SearchOutcome> {
  const maxHits = options.maxHits ?? DEFAULT_MAX_HITS;
  const mode = searchModeOf(options.pattern, options.isRegex);
  // Built first: an explicit regex that does not compile is the agent's to hear about, whichever engine runs.
  const matcher = buildMatcher(options.pattern, mode, options.caseSensitive ?? false);

  if (await hasRipgrep(runner, workspaceId)) {
    const run = async (as: SearchMode) => {
      const argv = ["rg", "--no-heading", "--line-number", "--color=never", "--null"];
      if (!options.caseSensitive) argv.push("-i");
      if (as === "literal") argv.push("-F");
      for (const glob of options.includes ?? []) argv.push("--glob", glob);
      argv.push("--max-count", String(RG_PER_FILE));
      // Each `-e` is one pattern, and a line matching any is a match.
      const patterns = as === "both" ? [escapeRe(options.pattern), options.pattern] : [options.pattern];
      for (const p of patterns) argv.push("-e", p);
      // `src\app.ts` means a folder on every system; ripgrep on Linux and macOS would look for one file named that.
      const scope = process.platform === "win32" ? options.path : options.path?.replace(/\\/g, "/");
      argv.push("--", scope ?? ".");
      return runner.execCommand(workspaceId, { argv, timeoutMs: 20_000, signal: options.signal });
    };

    let res = await run(mode);
    /*
     * Ripgrep exits 1 for "no matches" and 2 for a real error. Only the
     * second is a failure, and conflating them is how "no matches" came to
     * mean "the search did not run".
     *
     * Its regex dialect is not JavaScript's (no lookaround, no backreferences).
     * A pattern it cannot read is searched by the builtin scan, which reads it
     * as the agent wrote it; one read both ways falls back to its literal half.
     */
    if (res.exitCode === 2 && /regex parse error|error parsing regex|look-?around|backreference/i.test(res.stderr)) {
      if (mode === "regex") return builtinSearch(runner, workspaceId, options, maxHits, matcher, mode);
      res = await run("literal");
    }
    if (res.exitCode === 2) {
      throw new Error(`Search failed: ${res.stderr.slice(0, 300) || "ripgrep reported an error"}`);
    }

    const hits = parseGrepLines(res.stdout, maxHits, matcher);
    const capped = hits.length >= maxHits;
    return { hits, engine: "ripgrep", truncated: capped, mode, ...(capped ? { capped } : {}) };
  }

  return builtinSearch(runner, workspaceId, options, maxHits, matcher, mode);
}

function parseGrepLines(stdout: string, maxHits: number, matcher: (line: string) => number): SearchHit[] {
  const hits: SearchHit[] = [];
  for (const raw of stdout.split(/\r?\n/)) {
    if (!raw.trim()) continue;
    /*
     * `file NUL line:text` (`--null`): a file name may hold colons (`C:\…`)
     * and so may the text, and a NUL is the one thing a path cannot contain.
     * Without it, the first all-digits field after a colon.
     */
    const nul = raw.indexOf("\u0000");
    const m = nul >= 0 ? /^()(\d+):([\s\S]*)$/.exec(raw.slice(nul + 1)) : /^(.*?):(\d+):([\s\S]*)$/.exec(raw);
    const file = nul >= 0 ? raw.slice(0, nul) : m?.[1];
    if (!m || !file || !m[2]) continue;
    const text = (m[3] ?? "").replace(/\r$/, "").slice(0, LINE_KEEP);
    const column = matcher(text);
    hits.push({
      file: file.replace(/\\/g, "/").replace(/^\.\//, ""),
      line: Number.parseInt(m[2], 10),
      text,
      ...(column >= 0 ? { column } : {}),
    });
    if (hits.length >= maxHits) break;
  }
  return hits;
}

/**
 * The fallback: walk and read.
 *
 * Slower than ripgrep by a wide margin and correct, which is the trade worth
 * making. Bounded on every axis — files walked, file size, hits collected — so
 * a search of a large repository is slow rather than fatal.
 */
async function builtinSearch(
  runner: SandboxRunner,
  workspaceId: string,
  options: SearchOptions,
  maxHits: number,
  matcher: (line: string) => number,
  mode: SearchMode,
): Promise<SearchOutcome> {
  /*
   * `includes` as globs, as ripgrep reads them. They were matched as a
   * suffix with the leading `*` dropped, so `*.ts` worked and `src/**\/*.tsx`
   * matched nothing at all.
   */
  const globs = (options.includes ?? []).map((g) => g.trim()).filter(Boolean).map(globMatcher);
  const included = (inside: string): boolean => globs.length === 0 || globs.some((g) => g(inside));

  /*
   * A path may be one file. Listed as a directory it listed nothing, so a
   * search scoped to a file (the most common scope an agent picks) found
   * nothing in it, every time, while read_file showed the text was there
   * (seen 6 Oct 2026; reported 13 Oct as "grep shows 0 results"). A path that
   * lists as nothing is tried as a file.
   */
  const rel = below(options.path);
  let listingCut = false;
  let entries = await runner
    .listDirectory(workspaceId, options.path ?? ".", true, 12, {
      include: (path, type) => {
        if (type !== "file") return false;
        const inside = rel(path);
        return !SKIP.test(inside) && !NOT_TEXT.test(inside) && included(inside);
      },
      onTruncated: () => {
        listingCut = true;
      },
    })
    .catch(() => []);
  if (entries.length === 0 && options.path) {
    const one = await runner.readFile(workspaceId, options.path).then(
      (r) => r.content,
      () => null,
    );
    if (one !== null) {
      entries = [{ name: options.path.split(/[\\/]/).pop() ?? options.path, path: options.path, type: "file", sizeBytes: Buffer.byteLength(one), modifiedAt: new Date(0) }];
    }
  }

  const hits: SearchHit[] = [];
  let truncated = false;

  for (const entry of entries) {
    if (options.signal?.aborted) break;
    if (entry.type !== "file") continue;

    const path = entry.path.replace(/\\/g, "/");
    if (SKIP.test(rel(path))) continue;
    if (entry.sizeBytes > MAX_FILE_BYTES) continue;
    // A file asked for by name is searched whatever the filter says.
    if (entries.length > 1 && !included(rel(path))) continue;

    let content: string;
    try {
      content = (await runner.readFile(workspaceId, entry.path)).content;
    } catch {
      continue;
    }

    // A NUL byte in the first block is the usual heuristic for "binary", and
    // reporting a match inside a compiled artefact helps nobody.
    if (content.slice(0, 1024).includes("\u0000")) continue;

    const lines = content.split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]!;
      const column = matcher(line);
      if (column < 0) continue;
      hits.push({ file: path, line: i + 1, text: line.slice(0, LINE_KEEP), column });
      if (hits.length >= maxHits) {
        truncated = true;
        break;
      }
    }
    if (truncated) break;
  }

  return { hits, engine: "builtin", truncated: truncated || listingCut, mode, ...(truncated ? { capped: true } : {}) };
}

/**
 * Where in a line the query first matches, or -1.
 *
 * Read both ways, the literal text is tried first: a line holding the query
 * exactly as written is the closest match there is.
 */
export function buildMatcher(pattern: string, mode: SearchMode, caseSensitive: boolean): (line: string) => number {
  const needle = caseSensitive ? pattern : pattern.toLowerCase();
  const literal = (line: string): number => (caseSensitive ? line : line.toLowerCase()).indexOf(needle);
  if (mode === "literal") return literal;

  let re: RegExp;
  try {
    re = new RegExp(pattern, caseSensitive ? "" : "i");
  } catch (err) {
    throw new Error(
      `'${pattern}' is not a valid regular expression: ` +
        `${err instanceof Error ? err.message : String(err)}. ` +
        "Leave is_regex unset to search for it as text.",
    );
  }
  // Without /g, `lastIndex` never carries from one line to the next.
  const regex = (line: string): number => re.exec(line)?.index ?? -1;
  if (mode === "regex") return regex;
  return (line) => {
    const at = literal(line);
    return at >= 0 ? at : regex(line);
  };
}

/**
 * Files whose path matches a glob (`glob` tool): `**\/*.ts`, `src/**\/*.test.ts`,
 * `*.{js,jsx}`, `README*`.
 *
 * Models reach for this by name — every other coding agent has it — and
 * SoreQen answered "the `glob` tool doesn't exist" (29 Sep 2026), which cost a
 * turn a detour through list_directory. Ripgrep's file listing when there is
 * one (it honours .gitignore), newest first; the same walk as the builtin
 * search when there is not.
 */
export async function findFiles(
  runner: SandboxRunner,
  workspaceId: string,
  options: { pattern: string; path?: string; maxFiles?: number; signal?: AbortSignal },
): Promise<{ files: string[]; truncated: boolean; engine: "ripgrep" | "builtin" }> {
  const max = options.maxFiles ?? 300;
  const base = (options.path ?? ".").replace(/\\/g, "/");
  if (await hasRipgrep(runner, workspaceId)) {
    const res = await runner.execCommand(workspaceId, {
      argv: ["rg", "--files", "--sortr", "modified", "--glob", options.pattern, "--", base],
      timeoutMs: 20_000,
      signal: options.signal,
    });
    if (res.exitCode === 2) throw new Error(`File search failed: ${res.stderr.slice(0, 300) || "ripgrep reported an error"}`);
    const all = res.stdout.split(/\r?\n/).filter(Boolean).map((f) => f.replace(/\\/g, "/").replace(/^\.\//, ""));
    // Nothing, from a listing that skips what .gitignore names (checkpoints, data, builds): the walk below looks there too.
    if (all.length > 0) return { files: all.slice(0, max), truncated: all.length > max, engine: "ripgrep" };
  }
  const matcher = globMatcher(options.pattern);
  const rel = below(base);
  // From the folder searched, as ripgrep reads a glob; or from the workspace root, as a model often writes one.
  const matches = (path: string): boolean => matcher(rel(path)) || matcher(path.replace(/\\/g, "/").replace(/^\.\//, ""));
  let listingCut = false;
  const entries = await runner.listDirectory(workspaceId, base, true, 12, {
    include: (path, type) => type === "file" && !SKIP.test(rel(path)) && matches(path),
    onTruncated: () => {
      listingCut = true;
    },
  });
  const found = entries
    .map((e) => ({ path: e.path.replace(/\\/g, "/").replace(/^\.\//, ""), at: new Date(e.modifiedAt).getTime() || 0 }))
    .sort((a, b) => b.at - a.at)
    .map((e) => e.path);
  return { files: found.slice(0, max), truncated: listingCut || found.length > max, engine: "builtin" };
}

/**
 * A glob as a path test, as ripgrep reads one: a pattern with no `/` matches a
 * file's name at any depth; `**` spans directories, `*` and `?` do not; `{a,b}`
 * is either.
 */
function escapeRe(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function globMatcher(pattern: string): (path: string) => boolean {
  const glob = pattern.replace(/\\/g, "/").replace(/^\.\//, "");
  let re = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i]!;
    if (c === "*") {
      if (glob[i + 1] === "*") {
        const slash = glob[i + 2] === "/";
        re += slash ? "(?:.*/)?" : ".*";
        i += slash ? 2 : 1;
      } else re += "[^/]*";
    } else if (c === "?") re += "[^/]";
    else if (c === "{") {
      const end = glob.indexOf("}", i);
      if (end === -1) re += "\\{";
      else {
        re += `(?:${glob.slice(i + 1, end).split(",").map((p) => escapeRe(p).replace(/\\\*/g, "[^/]*")).join("|")})`;
        i = end;
      }
    } else re += escapeRe(c);
  }
  const whole = new RegExp(`^${re}$`, "i");
  if (glob.includes("/")) return (path) => whole.test(path);
  return (path) => whole.test(path.slice(path.lastIndexOf("/") + 1));
}
