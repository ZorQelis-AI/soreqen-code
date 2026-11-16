/**
 * Handing the agent a map before it starts looking.
 *
 * ## What this replaces
 *
 * Every measured turn opened the same way: two or three `list_directory`
 * calls and a `grep_search`, purely to work out where things live. That is the
 * agent paying, on every single turn, to rediscover something that has not
 * changed since the last one — and paying twice, because each answer comes
 * back as a tool result that then sits in the context for the rest of the turn.
 *
 * The system prompt already carried a file tree, but only the top thirty
 * entries at depth 1. In a monorepo that is a list of package directories: it
 * tells the model that `packages/` exists, which it could have guessed, and
 * nothing about what is in it.
 *
 * ## What a map is
 *
 * Files, and the names they export, with signatures and without bodies. Not a
 * summary, not documentation, not an index of everything — a symbol table.
 * It answers the two questions that actually cause the exploratory calls:
 * *where would this live*, and *what is it called*.
 *
 * The second is worth as much as the first. A model that cannot see the shape
 * of a codebase invents plausible names — `getUserById` in a repo whose
 * convention is `findUser` — and then spends a turn discovering that its
 * import does not resolve. Names are cheap to include and expensive to guess.
 *
 * ## Why it goes in the system prompt
 *
 * Because the system prompt is the cached prefix. A map delivered as a tool
 * result is paid for in full every turn it stays in the window; the same bytes
 * in a stable prefix are paid for once and then read at cache rates. That is
 * the difference between this being an optimisation and being an expense.
 *
 * It also means the map must be **stable**. Anything that varies between
 * turns — a timestamp, an unordered set, a file count that drifts — breaks the
 * prefix match and silently turns every request into a cache miss. Everything
 * here is sorted, and nothing carries a clock.
 *
 * ## Staleness, and why a wrong map is worse than none
 *
 * A map that claims a function exists when the agent deleted it two turns ago
 * will be believed. So it is fingerprinted by the paths and sizes of the files
 * it was built from, and rebuilt when that changes. The fingerprint is cheap —
 * one directory walk — and it is checked before the map is used, not on a
 * timer.
 */

import type { SandboxRunner } from "@sqcode/sandbox-runner";
import { estimateTokens } from "@sqcode/shared";

/** Where the cached map lives, inside the workspace so it survives a restart
 *  and moves with the project. */
const CACHE_PATH = ".soreqen/repo-map.json";

/** Default share of the prompt the map may occupy. Roughly 8 KB of text —
 *  enough for several hundred symbols, small against a 32k window, and far
 *  cheaper than the four exploratory tool calls it replaces. */
const DEFAULT_TOKEN_BUDGET = 2_200;

/** Files past this size are listed but not parsed. A 400 KB generated client
 *  contributes a thousand meaningless symbols and crowds out the code someone
 *  actually writes. */
const MAX_PARSE_BYTES = 180_000;

/**
 * The most files opened to build one map.
 *
 * Measured rather than guessed. On the ZorQelis monorepo the token budget
 * admits **44 files**; the first version of this cap read 1,200 to choose
 * those 44, which is twenty-seven files opened per file printed and took 13
 * seconds at the front of a turn.
 *
 * The purpose of reading more candidates than fit is only to let the
 * symbol-count term reorder them — a file that ranks well on its path but is
 * empty should lose to one that ranks slightly worse and exports fifteen
 * things. Several times the budget is plenty of room for that; an order of
 * magnitude is not buying anything.
 */
const MAX_FILES_PARSED = 300;

/** Files read at once. Enough to keep the syscall queue busy, few enough not
 *  to exhaust descriptors on a machine also running the user's dev server. */
const READ_CONCURRENCY = 24;

/** Directories that are never part of the map. Build output and dependencies
 *  are not what anyone means by "the codebase". */
export const SKIP_DIRS =
  /(^|\/)(node_modules|\.git|\.soreqen|dist|build|out|coverage|\.next|\.turbo|\.venv|venv|__pycache__|target|vendor|\.cache|\.idea|\.vscode)(\/|$)/;

/** Generated or vendored files that pass the directory filter. */
export const SKIP_FILES = /\.(min|bundle|generated|d)\.[cm]?[jt]sx?$|\.lock$|-lock\.json$|\.map$/;

export const PARSEABLE = /\.(ts|tsx|mts|cts|js|jsx|mjs|cjs|py|go|rs|java|kt|rb|php|cs|swift|c|cc|cpp|cxx|h|hh|hpp|hxx|inl)$/;

export interface SymbolEntry {
  /** `function`, `class`, `const`, `type`, `interface`, `def`, `struct`… */
  kind: string;
  name: string;
  /** The declaration line, trimmed and truncated. No body. */
  signature: string;
  line: number;
  /** Last line of its body, where known (`extractDeclarations`). */
  end?: number;
}

export interface FileEntry {
  path: string;
  symbols: SymbolEntry[];
}

/** Where one declaration lives. */
export interface SymbolLocation {
  file: string;
  line: number;
  kind: string;
  signature: string;
}

/**
 * Every declaration the map's pass saw, by name.
 *
 * ## Why this is free
 *
 * `buildRepoMap` already opens several hundred source files and runs
 * `extractSymbols` over each one. It then throws almost all of that away — the
 * rendered map only has room for the few dozen most important files. Keeping
 * the parse results costs a map in memory and a slightly larger cache file.
 *
 * ## What it replaces
 *
 * `find_symbol_definition` shelled out to `git grep` with a regex assembled
 * from the symbol name, which was wrong three ways: it only searched *tracked*
 * files, so a symbol in a file not yet committed was invisible; it failed
 * outright in a directory that is not a git repository; and it returned every
 * textual near-miss — a comment, a string, a similarly-named local — leaving
 * the model to sort real declarations from noise, in context it paid for.
 *
 * A lookup is exact, instant, and returns the declaration line rather than
 * every line the name appears on.
 *
 * ## Its honest limit
 *
 * The index covers the files the map actually opened — `MAX_FILES_PARSED` of
 * them, ranked by path. On a large repository the tail is not in here, so a
 * miss is not proof of absence and the caller falls back to a search. That
 * distinction is carried in the result rather than hidden, because "not found"
 * and "not indexed" are different answers and an agent that confuses them
 * concludes a symbol does not exist.
 */
export interface SymbolIndex {
  /** Lower-cased name → every declaration with that name. */
  byName: Map<string, SymbolLocation[]>;
  /** How many files the index was built from. */
  filesIndexed: number;
  /** Files that exist and were not opened, so a miss can be qualified. */
  filesNotIndexed: number;
}

/** Look a symbol up. Case-insensitive, because a model asking for `Foo` when
 *  the declaration is `foo` has still told you what it wants. */
export function lookupSymbol(index: SymbolIndex, name: string): SymbolLocation[] {
  return index.byName.get(name.toLowerCase()) ?? [];
}

/** An index covering nothing, for callers with no map. Every lookup misses,
 *  and `filesNotIndexed` says so rather than implying the repository is
 *  empty. */
export function emptySymbolIndex(): SymbolIndex {
  return { byName: new Map(), filesIndexed: 0, filesNotIndexed: 0 };
}

export interface RepoMap {
  /** Rendered text, ready to drop into the prompt. */
  text: string;
  /** Files actually described, after the budget was applied. */
  filesIncluded: number;
  /** Files known but omitted for budget. Reported so the model knows the map
   *  is partial rather than believing the repo is small. */
  filesOmitted: number;
  symbolCount: number;
  approxTokens: number;
  /** Identifies the workspace state this was built from. */
  fingerprint: string;
  /**
   * Declarations found while building the map.
   *
   * Not serialised into the cache file — see `CACHE_VERSION`. Rebuilding it
   * from the cached `files` would need the file list, which the cache does not
   * keep either, so a cache hit returns an empty index and the symbol tools
   * fall back to searching. That is the honest trade: the map's job is the
   * prompt, and paying a full parse on every turn to keep an index warm would
   * undo the caching that makes the map affordable at all.
   */
  symbols: SymbolIndex;
}

interface CachedMap extends RepoMap {
  version: number;
}

/** Bumped when the rendering changes, so an old cache is discarded rather
 *  than served in a format the prompt no longer expects. */
const CACHE_VERSION = 2;

/**
 * Declaration patterns, per language family.
 *
 * Regex rather than a parser, deliberately. A real parse would be more
 * accurate and would mean a TypeScript compiler instance, a Python runtime and
 * a Go toolchain in the loop — for a summary whose entire purpose is to be
 * cheap. The failure mode of a regex here is a missing symbol or an
 * occasionally odd signature, which costs the agent one `grep_search`; the
 * failure mode of the parser approach is that the feature is too slow to
 * enable.
 *
 * Only *exported* or top-level declarations are matched. A map of every local
 * helper is longer than the code.
 */
const PATTERNS: { test: RegExp; rules: { re: RegExp; kind: string }[] }[] = [
  {
    test: /\.(ts|tsx|mts|cts|js|jsx|mjs|cjs)$/,
    rules: [
      { re: /^export\s+(?:default\s+)?(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)/, kind: "function" },
      { re: /^export\s+(?:abstract\s+)?class\s+([A-Za-z_$][\w$]*)/, kind: "class" },
      { re: /^export\s+interface\s+([A-Za-z_$][\w$]*)/, kind: "interface" },
      { re: /^export\s+type\s+([A-Za-z_$][\w$]*)/, kind: "type" },
      { re: /^export\s+enum\s+([A-Za-z_$][\w$]*)/, kind: "enum" },
      { re: /^export\s+(?:const|let|var)\s+([A-Za-z_$][\w$]*)/, kind: "const" },
    ],
  },
  {
    test: /\.py$/,
    rules: [
      // Top-level only: an indented `def` is a method, and the class above it
      // is already listed.
      { re: /^(?:async\s+)?def\s+([A-Za-z_]\w*)/, kind: "def" },
      { re: /^class\s+([A-Za-z_]\w*)/, kind: "class" },
    ],
  },
  {
    test: /\.go$/,
    rules: [
      { re: /^func\s+(?:\([^)]*\)\s*)?([A-Z]\w*)/, kind: "func" },
      { re: /^type\s+([A-Z]\w*)/, kind: "type" },
    ],
  },
  {
    test: /\.rs$/,
    rules: [
      { re: /^pub\s+(?:async\s+)?fn\s+(\w+)/, kind: "fn" },
      { re: /^pub\s+struct\s+(\w+)/, kind: "struct" },
      { re: /^pub\s+enum\s+(\w+)/, kind: "enum" },
      { re: /^pub\s+trait\s+(\w+)/, kind: "trait" },
    ],
  },
  {
    test: /\.(java|kt|cs|swift)$/,
    rules: [
      { re: /^\s*(?:public|internal)\s+(?:final\s+|abstract\s+|static\s+)*class\s+(\w+)/, kind: "class" },
      { re: /^\s*(?:public|internal)\s+interface\s+(\w+)/, kind: "interface" },
      { re: /^\s*(?:public|internal)\s+(?:static\s+)?[\w<>\[\],\s?]+\s+(\w+)\s*\(/, kind: "method" },
    ],
  },
  {
    test: /\.rb$/,
    rules: [
      { re: /^\s*class\s+([A-Z]\w*)/, kind: "class" },
      { re: /^\s*module\s+([A-Z]\w*)/, kind: "module" },
      { re: /^\s*def\s+(self\.)?(\w+)/, kind: "def" },
    ],
  },
  {
    test: /\.php$/,
    rules: [
      { re: /^\s*(?:final\s+|abstract\s+)?class\s+(\w+)/, kind: "class" },
      { re: /^\s*(?:public\s+)?function\s+(\w+)/, kind: "function" },
    ],
  },
];

/** Signatures are one line and never a body. Long generic parameter lists get
 *  cut; the name and shape survive, which is what the map is for. */
const MAX_SIGNATURE_CHARS = 110;

/**
 * Every declaration, not only the public ones: what the code graph and the
 * index's chunking need (29 Sep 2026). The repository map keeps to
 * `PATTERNS` — exported names are what fits a picture of a whole project —
 * but a call graph without private functions, methods and the functions
 * declared inside a long function body cannot say who calls what.
 */
const CONTROL_WORDS = /^(if|for|while|switch|catch|return|function|else|do|try|with|await|typeof|new|super|constructor)$/;
const ALL_PATTERNS: { test: RegExp; rules: { re: RegExp; kind: string }[] }[] = [
  {
    test: /\.(ts|tsx|mts|cts|js|jsx|mjs|cjs)$/,
    rules: [
      { re: /^\s*(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)/, kind: "function" },
      { re: /^\s*(?:export\s+)?(?:default\s+)?(?:abstract\s+)?class\s+([A-Za-z_$][\w$]*)/, kind: "class" },
      { re: /^(?:export\s+)?(?:declare\s+)?interface\s+([A-Za-z_$][\w$]*)/, kind: "interface" },
      { re: /^(?:export\s+)?(?:declare\s+)?type\s+([A-Za-z_$][\w$]*)\s*[=<]/, kind: "type" },
      { re: /^(?:export\s+)?(?:const\s+)?enum\s+([A-Za-z_$][\w$]*)/, kind: "enum" },
      // A function held in a constant, at any depth: `const launchTurn = async (…) =>`.
      { re: /^\s*(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::[^=]+)?=\s*(?:async\s+)?(?:function\b|\([^)]*\)\s*(?::[^=]+)?=>|\([^)]*$|[A-Za-z_$][\w$]*\s*=>|useCallback\(|useMemo\()/, kind: "function" },
      { re: /^(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)/, kind: "const" },
      // A method: indented, a name, parameters, and a body opening on the same line.
      { re: /^\s+(?:(?:public|private|protected|static|readonly|override|async|get|set)\s+)*\*?([A-Za-z_$][\w$]*)\s*(?:<[^>]*>)?\([^)]*\)\s*(?::\s*[^{;=]+)?\{\s*$/, kind: "method" },
    ],
  },
  {
    test: /\.py$/,
    rules: [
      { re: /^\s*(?:async\s+)?def\s+([A-Za-z_]\w*)/, kind: "def" },
      { re: /^\s*class\s+([A-Za-z_]\w*)/, kind: "class" },
    ],
  },
  {
    test: /\.go$/,
    rules: [
      { re: /^func\s+(?:\([^)]*\)\s*)?(\w+)/, kind: "func" },
      { re: /^type\s+(\w+)/, kind: "type" },
    ],
  },
  {
    test: /\.rs$/,
    rules: [
      { re: /^\s*(?:pub(?:\([^)]*\))?\s+)?(?:const\s+)?(?:async\s+)?(?:unsafe\s+)?fn\s+(\w+)/, kind: "fn" },
      { re: /^\s*(?:pub(?:\([^)]*\))?\s+)?struct\s+(\w+)/, kind: "struct" },
      { re: /^\s*(?:pub(?:\([^)]*\))?\s+)?enum\s+(\w+)/, kind: "enum" },
      { re: /^\s*(?:pub(?:\([^)]*\))?\s+)?trait\s+(\w+)/, kind: "trait" },
      { re: /^\s*impl(?:<[^>]*>)?\s+(?:[\w:<>]+\s+for\s+)?(\w+)/, kind: "impl" },
    ],
  },
  {
    test: /\.(c|cc|cpp|cxx|h|hh|hpp|hxx|inl)$/,
    rules: [
      { re: /^\s*(?:template\s*<[^>]*>\s*)?(?:class|struct)\s+(?:[A-Z_]+\s+)?(\w+)\s*(?:final\s*)?(?::[^;{]*)?\{?\s*$/, kind: "class" },
      { re: /^\s*(?:namespace)\s+(\w+)/, kind: "namespace" },
      // A function definition: a return type, a (possibly qualified) name, parameters, a body.
      { re: /^(?:[\w:<>,*&\s]+?\s+[*&]?)((?:\w+::)*~?\w+)\s*\([^;]*\)\s*(?:const\s*)?(?:noexcept\s*)?(?:override\s*)?\{?\s*$/, kind: "function" },
    ],
  },
  // Java, Kotlin, C#, Swift, Ruby and PHP: the map's own rules already list their methods.
  ...PATTERNS.filter((p) => /java|rb|php/.test(p.test.source)),
];

export function extractDeclarations(path: string, content: string): SymbolEntry[] {
  const found = extractWith(ALL_PATTERNS, path, content).filter((s) => !CONTROL_WORDS.test(s.name));
  // Qualified C++ names (`Engine::tick`) are known by their last part too.
  const named = found.map((s) => (s.name.includes("::") ? { ...s, name: s.name.split("::").pop()! } : s));
  return withExtents(named, content.split("\n"), /\.(py|rb)$/.test(path));
}

/**
 * Where each declaration ends: the first line back at its own indentation
 * that closes it (`}` or `};` in a brace language), or, in Python, the first
 * non-blank line indented no deeper than it. What lets a call deep inside a
 * long function be credited to the function it is in, and not to whichever
 * small helper happened to be declared above it.
 */
function withExtents(symbols: SymbolEntry[], lines: string[], byIndent: boolean): SymbolEntry[] {
  const indentOf = (l: string): number => l.length - l.trimStart().length;
  return symbols.map((s) => {
    const start = s.line - 1;
    const own = indentOf(lines[start] ?? "");
    const opener = lines[start] ?? "";
    // One-liners: `const x = () => 1;`, `type T = …;`, `fn f() {}`.
    if (!byIndent && /;\s*$|\}\s*;?\s*$/.test(opener) && (opener.match(/\{/g)?.length ?? 0) <= (opener.match(/\}/g)?.length ?? 0)) {
      return { ...s, end: s.line };
    }
    for (let i = start + 1; i < lines.length; i++) {
      const line = lines[i]!;
      if (!line.trim()) continue;
      const indent = indentOf(line);
      if (byIndent) {
        if (indent <= own) return { ...s, end: i };
      } else if (indent < own || (indent === own && /^\s*\}/.test(line))) {
        // `)` at its own indentation closes a parameter list, not the body.
        return { ...s, end: indent < own ? i : i + 1 };
      }
    }
    return { ...s, end: lines.length };
  });
}

export function extractSymbols(path: string, content: string): SymbolEntry[] {
  return extractWith(PATTERNS, path, content);
}

function extractWith(table: typeof PATTERNS, path: string, content: string): SymbolEntry[] {
  const family = table.find((p) => p.test.test(path));
  if (!family) return [];

  const out: SymbolEntry[] = [];
  const lines = content.split("\n");

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    // Cheap rejection before running six regexes on a line of prose.
    if (line.length === 0 || line.length > 400) continue;

    for (const { re, kind } of family.rules) {
      const m = re.exec(line);
      if (!m) continue;
      // Ruby's `def self.name` puts the name in the second group.
      const name = (m[2] ?? m[1])!;
      let signature = line.trim().replace(/\s*\{\s*$/, "").replace(/;$/, "");
      if (signature.length > MAX_SIGNATURE_CHARS) {
        signature = `${signature.slice(0, MAX_SIGNATURE_CHARS - 1)}…`;
      }
      out.push({ kind, name, signature, line: i + 1 });
      break;
    }
  }

  return out;
}

/**
 * How likely a file is to matter to whoever is asking.
 *
 * The budget always binds on a real repository, so something has to be cut,
 * and cutting arbitrarily produces a map that is worse than a shorter honest
 * one. The ordering is by how often a file turns out to be the answer:
 *
 *   - entry points, because they name everything else;
 *   - shallow paths, because depth correlates with specificity;
 *   - files with more exports, because a module with twelve exported names is
 *     load-bearing and a file with one is usually a leaf;
 *   - tests last — useful, but the agent can find them from the file they test.
 */
/**
 * Everything about a file's importance that its *path* already tells you.
 *
 * Split out from `importance` so the map can decide what to open before
 * opening anything — see the candidate selection in `buildRepoMap`. Every term
 * here was already in the original scoring; only the symbol count needed the
 * file, and that is the one term left to `importance`.
 */
export function pathImportance(path: string): number {
  const name = path.split("/").pop() ?? "";
  const depth = path.split("/").length;

  let score = 0;
  if (/^(index|main|app|server|cli|mod|__init__)\.[\w]+$/.test(name)) score += 60;
  if (/(^|\/)(src|lib|packages|app|cmd)(\/|$)/.test(path)) score += 10;
  if (/\.(test|spec)\.[\w]+$|(^|\/)(tests?|__tests__|spec)(\/|$)/.test(path)) score -= 45;
  if (/(^|\/)(examples?|fixtures?|mocks?|scripts?|docs?)(\/|$)/.test(path)) score -= 25;
  score -= depth * 3;

  return score;
}

function importance(file: FileEntry): number {
  return pathImportance(file.path) + Math.min(file.symbols.length, 20) * 2;
}

/**
 * Render the map.
 *
 * Sorted by path, not by score. Score decides *what* is included; presentation
 * follows the directory structure, because that is how a person and a model
 * both read a repository — and because a stable order is what makes the prompt
 * prefix cacheable.
 */
function render(files: FileEntry[], omitted: number): string {
  const lines: string[] = [];
  const sorted = [...files].sort((a, b) => a.path.localeCompare(b.path));

  let currentDir = "";
  for (const file of sorted) {
    const slash = file.path.lastIndexOf("/");
    const dir = slash === -1 ? "." : file.path.slice(0, slash);
    const base = slash === -1 ? file.path : file.path.slice(slash + 1);

    if (dir !== currentDir) {
      lines.push(`${dir}/`);
      currentDir = dir;
    }

    if (file.symbols.length === 0) {
      lines.push(`  ${base}`);
      continue;
    }

    lines.push(`  ${base}`);
    for (const s of file.symbols) {
      lines.push(`    ${s.kind} ${s.name}`);
    }
  }

  if (omitted > 0) {
    lines.push("");
    lines.push(
      `(${omitted} more source file${omitted === 1 ? "" : "s"} not listed — this map is ` +
        `truncated to fit. Use list_directory or grep_search for anything not shown.)`,
    );
  }

  return lines.join("\n");
}

/**
 * Paths and sizes, hashed.
 *
 * Not content hashes: reading every file to decide whether to read every file
 * is the wrong shape. Path-and-size catches creation, deletion, renaming and
 * any edit that changes a file's length, which covers essentially every change
 * that alters the *symbol table*. An edit that preserves byte count and
 * changes an exported name is the miss, and it costs one stale entry until the
 * next size-changing edit — against a full content hash on every turn, which
 * costs a full read of the repository.
 */
function fingerprintOf(entries: { path: string; sizeBytes: number }[]): string {
  const material = entries
    .map((e) => `${e.path}:${e.sizeBytes}`)
    .sort()
    .join("\n");

  // FNV-1a. Not cryptographic and does not need to be — it detects change, it
  // does not resist an adversary.
  let hash = 0x811c9dc5;
  for (let i = 0; i < material.length; i++) {
    hash ^= material.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return `${(hash >>> 0).toString(16)}-${entries.length}`;
}

export interface BuildOptions {
  tokenBudget?: number;
  /** Skip the cache. Used by the `/map` command, where the point is to see
   *  the current state. */
  force?: boolean;
}

/**
 * Build, or reuse, the map for a workspace.
 *
 * Never throws. A workspace that cannot be walked produces an empty map and
 * the turn proceeds exactly as it did before this file existed — the map is an
 * accelerator, and an accelerator that can fail a turn is a liability.
 */
export async function buildRepoMap(
  runner: SandboxRunner,
  workspaceId: string,
  options: BuildOptions = {},
): Promise<RepoMap> {
  const budget = options.tokenBudget ?? DEFAULT_TOKEN_BUDGET;
  const empty: RepoMap = {
    text: "",
    filesIncluded: 0,
    filesOmitted: 0,
    symbolCount: 0,
    approxTokens: 0,
    fingerprint: "",
    symbols: emptySymbolIndex(),
  };

  try {
    const all = await runner.listDirectory(workspaceId, ".", true, 8);
    const sources = all
      .filter((e) => e.type === "file")
      .filter((e) => !SKIP_DIRS.test(e.path))
      .filter((e) => !SKIP_FILES.test(e.path))
      .filter((e) => PARSEABLE.test(e.path))
      .map((e) => ({
        path: e.path.replace(/\\/g, "/"),
        sizeBytes: e.sizeBytes,
        // Size and mtime together: what makes a file's parse reusable.
        version: `${e.sizeBytes}:${new Date(e.modifiedAt as Date | string).getTime()}`,
      }));

    if (sources.length === 0) return empty;

    const fingerprint = fingerprintOf(sources);

    if (!options.force) {
      const cached = await readCache(runner, workspaceId);
      if (cached && cached.version === CACHE_VERSION && cached.fingerprint === fingerprint) {
        /*
         * A cache hit skips the parse. The symbol index comes from the files
         * this process has already parsed, when it has; after a restart there
         * are none, and the symbol tools treat an empty index as "not
         * indexed" rather than "not found", and search instead.
         */
        const known = parsedFiles.get(workspaceId);
        const warm = known
          ? sources.flatMap((src) => {
              const hit = known.get(src.path);
              return hit && hit.version === src.version ? [{ path: src.path, symbols: hit.symbols }] : [];
            })
          : [];
        return { ...cached, symbols: warm.length > 0 ? indexFrom(warm, sources.length - warm.length) : emptySymbolIndex() };
      }
    }

    /*
     * Choose what to read *before* reading it.
     *
     * This loop used to read every parseable file in the workspace, one at a
     * time, and then throw most of the results away at the budgeting step
     * below. On this repository that is a few hundred files and nobody
     * noticed. On a real monorepo it is the reason the agent "doesn't work on
     * big projects": ten thousand sequential `readFile` calls, each one going
     * through `guardPath`'s `existsSync` + `realpathSync` + `statSync`, before
     * the first token is ever sent. The map is an accelerator, and it was
     * costing minutes to build a 2,200-token summary.
     *
     * The fix is that the budget is knowable in advance. A file's score
     * depends on its path, its size and its symbol count — and only the last
     * of those needs the file open. So rank by the path-only part first, keep
     * a generous multiple of what could possibly fit, and read that. The
     * symbol count then reorders the survivors, which is the part it was
     * always really doing.
     */
    const candidates = [...sources]
      .sort((a, b) => pathImportance(b.path) - pathImportance(a.path))
      .slice(0, MAX_FILES_PARSED);

    const skippedWithoutReading = sources.length - candidates.length;

    /*
     * Read them together, a few at a time.
     *
     * Sequentially awaiting thousands of small reads spends nearly all of its
     * wall clock waiting. A bounded window keeps the syscall queue busy
     * without opening ten thousand descriptors at once.
     */
    const files: FileEntry[] = [];
    let symbolCount = 0;
    const known = parsedFilesFor(workspaceId);

    for (let i = 0; i < candidates.length; i += READ_CONCURRENCY) {
      const window = candidates.slice(i, i + READ_CONCURRENCY);
      const batch = await Promise.all(
        window.map(async (source): Promise<FileEntry> => {
          if (source.sizeBytes > MAX_PARSE_BYTES) return { path: source.path, symbols: [] };
          /*
           * Unchanged since this process last parsed it: reuse that.
           *
           * The whole-map cache above is all or nothing — one edited file
           * changes the fingerprint, and every file was read and parsed again
           * to rebuild a map that differs by one entry. Now only the files
           * whose size or mtime moved are opened.
           */
          const hit = known.get(source.path);
          if (hit && hit.version === source.version) return { path: source.path, symbols: hit.symbols };
          try {
            const { content } = await runner.readFile(workspaceId, source.path);
            const symbols = extractSymbols(source.path, content);
            known.set(source.path, { version: source.version, symbols });
            return { path: source.path, symbols };
          } catch {
            // Unreadable file. Listing the path is still better than
            // pretending it is not there.
            return { path: source.path, symbols: [] };
          }
        }),
      );
      for (const entry of batch) {
        symbolCount += entry.symbols.length;
        files.push(entry);
      }
    }

    /*
     * Fit the budget by dropping whole files, worst-scoring first.
     *
     * Dropping individual symbols would fit more names into the same space and
     * would be worse: a file listed with four of its nine exports reads as a
     * complete description of a file that does not have the other five, and
     * the model stops looking. A file that is absent is honestly absent, and
     * the footer says how many there are.
     */
    const ranked = [...files].sort((a, b) => importance(b) - importance(a));
    const kept: FileEntry[] = [];
    let used = 0;

    for (const file of ranked) {
      const cost = estimateTokens(
        `${file.path}\n${file.symbols.map((s) => `${s.kind} ${s.name}`).join("\n")}`,
      );
      if (used + cost > budget) continue;
      kept.push(file);
      used += cost;
    }

    /*
     * The footer counts everything left out, including what was never opened.
     *
     * Reporting only the files that lost the budget contest would tell a user
     * with a 40,000-file monorepo that 300 files were omitted. The number that
     * matters is how much of their repository this summary does not describe.
     */
    const omitted = files.length - kept.length + skippedWithoutReading;
    const text = render(kept, omitted);

    /*
     * The index is built from every file that was *opened*, not every file
     * that was *printed*.
     *
     * The map's budget admits a few dozen files; the parse pass covered
     * several hundred. Indexing what was parsed rather than what survived the
     * budget makes the index an order of magnitude more useful for nothing —
     * the work is already done and the results are already in hand.
     */
    const symbols = indexFrom(files, skippedWithoutReading);

    const map: CachedMap = {
      version: CACHE_VERSION,
      symbols,
      text,
      filesIncluded: kept.length,
      filesOmitted: omitted,
      symbolCount,
      approxTokens: estimateTokens(text),
      fingerprint,
    };

    await writeCache(runner, workspaceId, map);
    return map;
  } catch {
    return empty;
  }
}

/** The symbol index for a set of parsed files. */
function indexFrom(files: FileEntry[], notIndexed: number): SymbolIndex {
  const byName = new Map<string, SymbolLocation[]>();
  for (const file of files) {
    for (const symbol of file.symbols) {
      const key = symbol.name.toLowerCase();
      const bucket = byName.get(key);
      const location: SymbolLocation = {
        file: file.path,
        line: symbol.line,
        kind: symbol.kind,
        signature: symbol.signature,
      };
      if (bucket) bucket.push(location);
      else byName.set(key, [location]);
    }
  }
  return { byName, filesIndexed: files.length, filesNotIndexed: notIndexed };
}

/**
 * Each file's symbols, as last parsed, by workspace — reused while the file's
 * size and mtime are unchanged. In memory only: a restart parses once more,
 * and the on-disk map cache covers the prompt meanwhile.
 */
const parsedFiles = new Map<string, Map<string, { version: string; symbols: FileEntry["symbols"] }>>();
/** Workspaces kept, most recently used last. Enough for every open session. */
const MAX_PARSED_WORKSPACES = 24;

function parsedFilesFor(workspaceId: string): Map<string, { version: string; symbols: FileEntry["symbols"] }> {
  let known = parsedFiles.get(workspaceId);
  if (known) parsedFiles.delete(workspaceId);
  else known = new Map();
  parsedFiles.set(workspaceId, known);
  while (parsedFiles.size > MAX_PARSED_WORKSPACES) parsedFiles.delete(parsedFiles.keys().next().value!);
  return known;
}

async function readCache(
  runner: SandboxRunner,
  workspaceId: string,
): Promise<CachedMap | null> {
  try {
    const { content } = await runner.readFile(workspaceId, CACHE_PATH);
    const parsed = JSON.parse(content) as CachedMap;
    return typeof parsed.text === "string" ? parsed : null;
  } catch {
    return null;
  }
}

async function writeCache(
  runner: SandboxRunner,
  workspaceId: string,
  map: CachedMap,
): Promise<void> {
  try {
    /*
     * The index is not written.
     *
     * A `Map` serialises to `{}`, so leaving it in would put a misleading
     * empty object in the cache file and grow it for nothing. More to the
     * point, the cache exists to make the *prompt* cheap, and the prompt does
     * not contain the index — persisting it would trade disk and parse time
     * for something no reader of this file wants.
     */
    const { symbols: _symbols, ...persistable } = map;
    await runner.writeFile(workspaceId, CACHE_PATH, JSON.stringify(persistable), true);
  } catch {
    // A map that cannot be cached is still a map. The next turn rebuilds it.
  }
}

/** The map as it appears in the system prompt, with the framing the model
 *  needs to use it correctly — including the part where it is not exhaustive. */
export function renderForPrompt(map: RepoMap): string {
  if (!map.text) return "No source files were found to map.";
  return (
    `${map.text}\n\n` +
    `This map lists exported names only, with no bodies, and may be slightly ` +
    `behind edits made in this turn. Read a file before editing it; do not treat ` +
    `absence from this map as proof something does not exist.`
  );
}
