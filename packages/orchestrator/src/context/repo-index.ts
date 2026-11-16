/**
 * What the repository contains, and how its parts relate.
 *
 * The repository map (`repo-map.ts`) is a picture for the prompt: a few
 * dozen files and their declarations. This is the machinery behind retrieval:
 * every indexable file with its content hash, its declarations, what it
 * imports and what imports it, which tests exercise it, and its text cut into
 * chunks at declaration boundaries so a search can return one function rather
 * than a whole file.
 *
 * ## Kept current, cheaply
 *
 * Built once per workspace and kept in memory across steps and turns. A file
 * the agent writes is marked dirty and re-read before the next retrieval;
 * the rest is re-checked against the directory listing (size and mtime) at
 * most once per turn. Nothing is re-read that has not changed, and nothing
 * stale is ever returned: a chunk carries the hash of the content it was cut
 * from, and a dirty file is re-indexed before it can be retrieved.
 */

import type { SandboxRunner } from "@sqcode/sandbox-runner";
import { estimateTokens } from "@sqcode/shared";
import { PARSEABLE, SKIP_DIRS, SKIP_FILES, extractDeclarations, pathImportance, type SymbolEntry } from "../repo-map.js";
import { contentHash, normalisePath } from "./task-state.js";
import { stem, termCounts, terms } from "./text.js";

/** Text files worth searching besides source: docs, config, styles, schemas. */
const TEXT_FILES = /\.(md|mdx|json|ya?ml|toml|css|scss|less|html|vue|svelte|sql|prisma|graphql|gql|sh|ps1|env\.example)$/i;
const TEST_FILE = /\.(test|spec)\.[\w]+$|(^|\/)(tests?|__tests__|spec)\//;

export const MAX_INDEX_FILES = 2_500;
/** Where import aliases are declared. */
const CONFIG_FILE = /(^|\/)(tsconfig[\w.-]*|jsconfig)\.json$/;
const SKIPPED_SEGMENT = /(^|\/)(node_modules|dist|build|\.next|\.git|\.soreqen|coverage)(\/|$)/;
const MAX_FILE_BYTES = 256 * 1024;
const READ_CONCURRENCY = 16;
const MAX_CHUNK_LINES = 80;
const WINDOW_LINES = 60;

export interface IndexedFile {
  path: string;
  hash: string;
  /** Size and mtime as listed: whether the file needs reading again. */
  version: string;
  isTest: boolean;
  isCode: boolean;
  lines: number;
  symbols: SymbolEntry[];
  /** Import specifiers as written. */
  specifiers: string[];
  /** Workspace paths this file imports, resolved from `specifiers`. */
  imports: string[];
  /** Names it exports. */
  exports: string[];
  chunkIds: string[];
  importance: number;
}

export interface Chunk {
  id: string;
  path: string;
  start: number;
  end: number;
  /** The declaration this chunk begins with, when it begins with one. */
  symbol?: string;
  kind?: string;
  signature?: string;
  text: string;
  /** Hash of this chunk's text, for deduplication against what is already in context. */
  hash: string;
  /** Hash of the whole file it was cut from: its revision. */
  fileHash: string;
  terms: Map<string, number>;
  stems: Map<string, number>;
  length: number;
  tokens: number;
}

export interface IndexStats {
  files: number;
  chunks: number;
  symbols: number;
  edges: number;
  tests: number;
  builtMs: number;
  truncated: boolean;
}

function isIndexable(path: string): boolean {
  if (SKIP_DIRS.test(path) || SKIP_FILES.test(path)) return false;
  return PARSEABLE.test(path) || TEXT_FILES.test(path);
}

/** Import specifiers in a file, by language. */
export function importSpecifiers(path: string, content: string): string[] {
  const out = new Set<string>();
  if (/\.(ts|tsx|mts|cts|js|jsx|mjs|cjs|vue|svelte)$/.test(path)) {
    for (const m of content.matchAll(/(?:import|export)\s+(?:[^'"`;]*?\sfrom\s+)?['"]([^'"]+)['"]/g)) out.add(m[1]!);
    for (const m of content.matchAll(/(?:require|import)\(\s*['"]([^'"]+)['"]\s*\)/g)) out.add(m[1]!);
  } else if (/\.py$/.test(path)) {
    for (const m of content.matchAll(/^\s*from\s+([.\w]+)\s+import\s/gm)) out.add(m[1]!);
    for (const m of content.matchAll(/^\s*import\s+([\w.]+)/gm)) out.add(m[1]!);
  } else if (/\.go$/.test(path)) {
    for (const m of content.matchAll(/"([\w./-]+)"/g)) out.add(m[1]!);
  }
  return [...out];
}

/** Names a file exports. */
export function exportedNames(path: string, content: string, symbols: SymbolEntry[]): string[] {
  const out = new Set<string>();
  if (/\.(ts|tsx|mts|cts|js|jsx|mjs|cjs)$/.test(path)) {
    for (const m of content.matchAll(/export\s+(?:default\s+)?(?:async\s+)?(?:function\*?|class|const|let|var|type|interface|enum)\s+([A-Za-z_$][\w$]*)/g)) {
      out.add(m[1]!);
    }
    for (const m of content.matchAll(/export\s*\{([^}]+)\}/g)) {
      for (const part of m[1]!.split(",")) {
        const name = part.trim().split(/\s+as\s+/).pop()?.trim();
        if (name) out.add(name);
      }
    }
  } else if (/\.py$/.test(path)) {
    for (const s of symbols) if (!s.name.startsWith("_")) out.add(s.name);
  }
  return [...out].slice(0, 200);
}

/**
 * Path aliases from a `tsconfig.json` or `jsconfig.json`: `"@/*": ["src/*"]`,
 * and `baseUrl` for bare imports. Without them every `@/components/Button` in a
 * Next or Vite app was an import to nowhere — no dependency edge, no "one
 * import away", no test found for the file it tests.
 */
export interface AliasConfig {
  /** The directory the config sits in, workspace-relative ("" for the root). */
  dir: string;
  /** Directory `paths` targets and bare imports resolve against. */
  base: string;
  hasBaseUrl: boolean;
  paths: { pattern: string; targets: string[] }[];
}

/** JSON with comments and trailing commas, as tsconfig files are written. */
export function parseJsonc(text: string): unknown {
  let out = "";
  let inString = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (inString) {
      out += ch;
      if (ch === "\\") out += text[++i] ?? "";
      else if (ch === '"') inString = false;
    } else if (ch === '"') {
      inString = true;
      out += ch;
    } else if (ch === "/" && text[i + 1] === "/") {
      while (i < text.length && text[i] !== "\n") i++;
      out += "\n";
    } else if (ch === "/" && text[i + 1] === "*") {
      i += 2;
      while (i < text.length && !(text[i] === "*" && text[i + 1] === "/")) i++;
      i++;
    } else out += ch;
  }
  try {
    return JSON.parse(out.replace(/,(\s*[}\]])/g, "$1"));
  } catch {
    return null;
  }
}

/**
 * A config's aliases, following `extends` to relative parents (the child's
 * settings win). `read` returns a workspace file's text, or null.
 */
export async function loadAliasConfig(path: string, read: (p: string) => Promise<string | null>): Promise<AliasConfig | null> {
  const dir = path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "";
  let baseUrl: string | undefined;
  let baseFrom = dir;
  let paths: Record<string, string[]> | undefined;
  let pathsFrom = dir;
  let current: string | null = path;
  for (let depth = 0; current && depth < 4; depth++) {
    const text = await read(current);
    if (text === null) break;
    const json = parseJsonc(text) as { extends?: unknown; compilerOptions?: { baseUrl?: unknown; paths?: unknown } } | null;
    if (!json) break;
    const at: string = current;
    const here: string = at.includes("/") ? at.slice(0, at.lastIndexOf("/")) : "";
    const options = json.compilerOptions ?? {};
    if (baseUrl === undefined && typeof options.baseUrl === "string") {
      baseUrl = options.baseUrl;
      baseFrom = here;
    }
    if (paths === undefined && options.paths && typeof options.paths === "object") {
      paths = options.paths as Record<string, string[]>;
      pathsFrom = here;
    }
    const parent = typeof json.extends === "string" && json.extends.startsWith(".") ? json.extends : null;
    current = parent ? joinPath(here, parent.endsWith(".json") ? parent : `${parent}.json`) : null;
  }
  if (baseUrl === undefined && !paths) return null;
  // `paths` resolve against baseUrl when there is one, else against their own config.
  const base = baseUrl !== undefined ? joinPath(baseFrom, baseUrl) : pathsFrom;
  return {
    dir,
    base,
    hasBaseUrl: baseUrl !== undefined,
    paths: Object.entries(paths ?? {})
      .filter(([, targets]) => Array.isArray(targets))
      .map(([pattern, targets]) => ({ pattern, targets: targets.filter((t) => typeof t === "string") })),
  };
}

/** The config that governs a file: the nearest one at or above its directory. */
function aliasConfigFor(from: string, configs: AliasConfig[]): AliasConfig | null {
  let best: AliasConfig | null = null;
  for (const c of configs) {
    const within = c.dir === "" || from === c.dir || from.startsWith(`${c.dir}/`);
    if (within && (!best || c.dir.length > best.dir.length)) best = c;
  }
  return best;
}

function resolveModule(base: string, exists: (p: string) => boolean): string | null {
  const stripped = base.replace(/\.(m|c)?js$|\.jsx$/, "");
  const candidates = [
    base,
    ...[".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs", ".vue", ".svelte"].map((e) => `${stripped}${e}`),
    ...["index.ts", "index.tsx", "index.js", "index.jsx"].map((i) => `${stripped}/${i}`),
  ];
  for (const c of candidates) if (exists(c)) return c;
  return null;
}

/** Resolve an import to a workspace path, when it names one. */
export function resolveImport(
  from: string,
  spec: string,
  exists: (p: string) => boolean,
  aliases: AliasConfig[] = [],
): string | null {
  const dir = from.includes("/") ? from.slice(0, from.lastIndexOf("/")) : "";
  if (/\.py$/.test(from)) {
    let base: string;
    if (spec.startsWith(".")) {
      const dots = /^\.+/.exec(spec)![0].length;
      const up = dir.split("/").filter(Boolean).slice(0, Math.max(0, dir.split("/").filter(Boolean).length - (dots - 1)));
      base = [...up, ...spec.slice(dots).split(".").filter(Boolean)].join("/");
    } else {
      base = spec.replace(/\./g, "/");
    }
    for (const c of [`${base}.py`, `${base}/__init__.py`]) if (exists(c)) return c;
    return null;
  }
  if (spec.startsWith(".")) return resolveModule(joinPath(dir, spec), exists);

  // A bare specifier: an alias, a baseUrl-relative path, or a package (null).
  const config = aliasConfigFor(dir, aliases);
  if (!config) return null;
  for (const { pattern, targets } of config.paths) {
    const star = pattern.indexOf("*");
    let rest: string | null = null;
    if (star === -1) rest = spec === pattern ? "" : null;
    else {
      const prefix = pattern.slice(0, star);
      const suffix = pattern.slice(star + 1);
      if (spec.startsWith(prefix) && spec.endsWith(suffix) && spec.length >= prefix.length + suffix.length) {
        rest = spec.slice(prefix.length, spec.length - suffix.length);
      }
    }
    if (rest === null) continue;
    for (const target of targets) {
      const found = resolveModule(joinPath(config.base, target.replace("*", rest)), exists);
      if (found) return found;
    }
  }
  return config.hasBaseUrl ? resolveModule(joinPath(config.base, spec), exists) : null;
}

function joinPath(dir: string, rel: string): string {
  const parts = dir ? dir.split("/") : [];
  for (const seg of rel.split("/")) {
    if (seg === "." || seg === "") continue;
    if (seg === "..") parts.pop();
    else parts.push(seg);
  }
  return parts.join("/");
}

/**
 * Cut a file into chunks at declaration boundaries.
 *
 * A chunk is one declaration and what follows it up to the next, so a search
 * that matches a function returns that function. Long stretches are split
 * into windows; the preamble — imports, module comments — is a chunk of its
 * own, because "what does this file depend on" is a real question.
 */
export function chunkFile(path: string, content: string, symbols: SymbolEntry[], fileHash: string): Chunk[] {
  const lines = content.split("\n");
  const starts = [...new Set(symbols.map((s) => s.line).filter((l) => l >= 1 && l <= lines.length))].sort((a, b) => a - b);
  const bySymbolLine = new Map(symbols.map((s) => [s.line, s]));
  const spans: { start: number; end: number; symbol?: SymbolEntry }[] = [];

  if (starts.length === 0) {
    // Prose or config: headings, or plain windows.
    const headings = /\.(md|mdx)$/i.test(path)
      ? lines.map((l, i) => (/^#{1,4}\s/.test(l) ? i + 1 : 0)).filter(Boolean)
      : [];
    const bounds = headings.length > 0 ? (headings[0] === 1 ? headings : [1, ...headings]) : [1];
    for (let i = 0; i < bounds.length; i++) {
      spans.push({ start: bounds[i]!, end: (bounds[i + 1] ?? lines.length + 1) - 1 });
    }
  } else {
    if (starts[0]! > 1) spans.push({ start: 1, end: starts[0]! - 1 });
    for (let i = 0; i < starts.length; i++) {
      const sym = bySymbolLine.get(starts[i]!);
      spans.push({ start: starts[i]!, end: (starts[i + 1] ?? lines.length + 1) - 1, ...(sym ? { symbol: sym } : {}) });
    }
  }

  const chunks: Chunk[] = [];
  for (const span of spans) {
    const size = span.end - span.start + 1 > MAX_CHUNK_LINES ? WINDOW_LINES : MAX_CHUNK_LINES;
    for (let s = span.start; s <= span.end; s += size) {
      const e = Math.min(span.end, s + size - 1);
      const text = lines.slice(s - 1, e).join("\n");
      if (!text.trim()) continue;
      const list = terms(`${path.replace(/[/.]/g, " ")} ${text}`);
      const first = s === span.start ? span.symbol : undefined;
      chunks.push({
        id: `${path}#${s}`,
        path,
        start: s,
        end: e,
        ...(first ? { symbol: first.name, kind: first.kind, signature: first.signature } : {}),
        text,
        hash: contentHash(text),
        fileHash,
        terms: termCounts(list),
        stems: termCounts(list.map(stem)),
        length: list.length,
        tokens: estimateTokens(text),
      });
    }
  }
  return chunks;
}

export class RepoIndex {
  readonly files = new Map<string, IndexedFile>();
  readonly chunks = new Map<string, Chunk>();
  readonly importedBy = new Map<string, Set<string>>();
  readonly symbolDefs = new Map<string, { path: string; line: number; chunkId: string }[]>();
  /** Chunks containing each term — the inverted index lexical search runs on. */
  readonly postings = new Map<string, Set<string>>();
  readonly df = new Map<string, number>();
  avgLength = 1;
  stats: IndexStats = { files: 0, chunks: 0, symbols: 0, edges: 0, tests: 0, builtMs: 0, truncated: false };
  /** Files written since they were last indexed. */
  private readonly dirty = new Set<string>();
  private listedVersions = new Map<string, string>();
  /** tsconfig/jsconfig files, and the aliases read from them. */
  private configPaths: string[] = [];
  aliasConfigs: AliasConfig[] = [];
  lastRefresh = 0;
  /** Bumped whenever the derived tables are rebuilt: what the code graph keys its cache on. */
  revision = 0;

  constructor(
    private readonly runner: SandboxRunner,
    private readonly workspaceId: string,
  ) {}

  /** The file changed (the agent wrote it); re-read it before it is next retrieved. */
  markDirty(path: string): void {
    this.dirty.add(normalisePath(path));
  }

  hasDirty(): boolean {
    return this.dirty.size > 0;
  }

  /**
   * Bring the index up to date.
   *
   * `full` re-lists the workspace and re-reads whatever changed size or mtime
   * — once per turn. Otherwise only the files the agent itself wrote are
   * re-read, which is every change a step can make that matters.
   */
  async refresh(full: boolean): Promise<string[]> {
    const started = Date.now();
    const changed = new Set<string>(this.dirty);
    this.dirty.clear();

    if (full || this.files.size === 0) {
      const listing = await this.runner.listDirectory(this.workspaceId, ".", true, 10).catch(() => []);
      const wanted = listing
        .filter((e) => e.type === "file")
        .map((e) => ({
          path: normalisePath(e.path),
          size: e.sizeBytes,
          version: `${e.sizeBytes}:${new Date(e.modifiedAt as Date | string).getTime()}`,
        }))
        .filter((e) => isIndexable(e.path) && e.size <= MAX_FILE_BYTES)
        .sort((a, b) => pathImportance(b.path) - pathImportance(a.path));
      this.stats.truncated = wanted.length > MAX_INDEX_FILES;
      const kept = wanted.slice(0, MAX_INDEX_FILES);
      const present = new Set(kept.map((e) => e.path));
      for (const path of [...this.files.keys()]) if (!present.has(path)) this.removeFile(path);
      this.listedVersions = new Map(kept.map((e) => [e.path, e.version]));
      for (const e of kept) if (this.files.get(e.path)?.version !== e.version) changed.add(e.path);
      this.configPaths = listing
        .filter((e) => e.type === "file")
        .map((e) => normalisePath(e.path))
        .filter((p) => CONFIG_FILE.test(p) && !SKIPPED_SEGMENT.test(p))
        .slice(0, 50);
    }

    // Aliases first: they decide where every bare import resolves.
    const configsChanged = full || this.files.size === 0 || [...changed].some((p) => CONFIG_FILE.test(p));
    if (configsChanged) await this.loadAliases();

    const paths = [...changed].filter((p) => !CONFIG_FILE.test(p) || isIndexable(p));
    for (let i = 0; i < paths.length; i += READ_CONCURRENCY) {
      await Promise.all(paths.slice(i, i + READ_CONCURRENCY).map((p) => this.indexFile(p)));
    }
    if (paths.length > 0 || configsChanged) this.rebuildDerived();
    this.lastRefresh = Date.now();
    if (full) this.stats.builtMs = Date.now() - started;
    return paths;
  }

  private async loadAliases(): Promise<void> {
    const read = (p: string): Promise<string | null> =>
      this.runner.readFile(this.workspaceId, p).then((r) => r.content, () => null);
    const loaded = await Promise.all(this.configPaths.map((p) => loadAliasConfig(p, read).catch(() => null)));
    this.aliasConfigs = loaded.filter((c): c is AliasConfig => c !== null);
  }

  private async indexFile(path: string): Promise<void> {
    let content: string;
    try {
      content = (await this.runner.readFile(this.workspaceId, path)).content;
    } catch {
      this.removeFile(path);
      return;
    }
    if (content.length > MAX_FILE_BYTES) {
      this.removeFile(path);
      return;
    }
    this.removeFile(path);
    const hash = contentHash(content);
    const isCode = PARSEABLE.test(path);
    const symbols = isCode ? extractDeclarations(path, content) : [];
    const chunks = chunkFile(path, content, symbols, hash);
    for (const c of chunks) this.chunks.set(c.id, c);
    this.files.set(path, {
      path,
      hash,
      version: this.listedVersions.get(path) ?? `w:${hash}`,
      isTest: TEST_FILE.test(path),
      isCode,
      lines: content.split("\n").length,
      symbols,
      specifiers: importSpecifiers(path, content),
      imports: [],
      exports: isCode ? exportedNames(path, content, symbols) : [],
      chunkIds: chunks.map((c) => c.id),
      importance: pathImportance(path),
    });
  }

  private removeFile(path: string): void {
    const file = this.files.get(path);
    if (!file) return;
    for (const id of file.chunkIds) this.chunks.delete(id);
    this.files.delete(path);
  }

  /** Import edges, symbol table, and the statistics lexical ranking needs. */
  private rebuildDerived(): void {
    const exists = (p: string): boolean => this.files.has(p);
    this.importedBy.clear();
    let edges = 0;
    for (const file of this.files.values()) {
      const resolved = new Set<string>();
      for (const spec of file.specifiers) {
        const target = resolveImport(file.path, spec, exists, this.aliasConfigs);
        if (target && target !== file.path) resolved.add(target);
      }
      file.imports = [...resolved];
      for (const target of file.imports) {
        let set = this.importedBy.get(target);
        if (!set) this.importedBy.set(target, (set = new Set()));
        set.add(file.path);
        edges++;
      }
    }

    this.symbolDefs.clear();
    this.postings.clear();
    this.df.clear();
    let total = 0;
    let symbols = 0;
    for (const chunk of this.chunks.values()) {
      total += chunk.length;
      for (const term of chunk.terms.keys()) {
        this.df.set(term, (this.df.get(term) ?? 0) + 1);
        let set = this.postings.get(term);
        if (!set) this.postings.set(term, (set = new Set()));
        set.add(chunk.id);
      }
      if (chunk.symbol) {
        const key = chunk.symbol.toLowerCase();
        const list = this.symbolDefs.get(key) ?? [];
        list.push({ path: chunk.path, line: chunk.start, chunkId: chunk.id });
        this.symbolDefs.set(key, list);
        symbols++;
      }
    }
    this.avgLength = this.chunks.size > 0 ? total / this.chunks.size : 1;
    this.revision++;
    this.stats = {
      ...this.stats,
      files: this.files.size,
      chunks: this.chunks.size,
      symbols,
      edges,
      tests: [...this.files.values()].filter((f) => f.isTest).length,
    };
  }

  /** Files one import away, either direction. */
  neighbours(path: string): { imports: string[]; importedBy: string[] } {
    const p = normalisePath(path);
    return { imports: this.files.get(p)?.imports ?? [], importedBy: [...(this.importedBy.get(p) ?? [])] };
  }

  /**
   * Tests that exercise a file: those that import it, and the one named
   * after it (`auth.ts` → `auth.test.ts`) even when the import goes through
   * an index.
   */
  testsFor(path: string): string[] {
    const p = normalisePath(path);
    const out = new Set<string>();
    for (const importer of this.importedBy.get(p) ?? []) if (this.files.get(importer)?.isTest) out.add(importer);
    const base = p.replace(/\.[\w]+$/, "").split("/").pop() ?? "";
    if (base) {
      for (const f of this.files.values()) {
        if (!f.isTest) continue;
        const name = f.path.split("/").pop() ?? "";
        if (name.startsWith(`${base}.test.`) || name.startsWith(`${base}.spec.`) || name === `test_${base}.py`) out.add(f.path);
      }
    }
    return [...out];
  }

  /** A file's declarations, one line each: the cheapest useful view of it. */
  outline(path: string, max = 14): string {
    const file = this.files.get(normalisePath(path));
    if (!file) return "";
    const sigs = file.symbols.slice(0, max).map((s) => `  ${s.line}: ${s.signature}`);
    const more = file.symbols.length > max ? `\n  … ${file.symbols.length - max} more declarations` : "";
    return sigs.join("\n") + more;
  }

  chunksOf(path: string): Chunk[] {
    return (this.files.get(normalisePath(path))?.chunkIds ?? []).map((id) => this.chunks.get(id)!).filter(Boolean);
  }
}

/** One index per workspace, kept across steps and turns. */
const indexes = new Map<string, RepoIndex>();
/**
 * Kept least-recently-used. Each holds up to `MAX_INDEX_FILES` files' text, so
 * twelve large repositories could pin most of a gigabyte; six is still more
 * projects than anyone works in at once.
 */
const MAX_INDEXES = 6;

export function indexFor(runner: SandboxRunner, workspaceId: string): RepoIndex {
  let index = indexes.get(workspaceId);
  if (index) {
    indexes.delete(workspaceId);
  } else {
    index = new RepoIndex(runner, workspaceId);
  }
  indexes.set(workspaceId, index);
  while (indexes.size > MAX_INDEXES) indexes.delete(indexes.keys().next().value!);
  return index;
}

/** For tests. */
export function resetIndexes(): void {
  indexes.clear();
}
