/**
 * The codebase as a graph: what each symbol is, what uses it, what it uses,
 * and what a change to it reaches.
 *
 * ## Why
 *
 * Asked "where is the session store written", an agent without this greps,
 * reads three files, greps again for the callers, and reads two more — five
 * or six tool calls and a few thousand tokens of file it mostly did not need,
 * and all of it read again after the next checkpoint. The repository index
 * (repo-index.ts) already knows every file's declarations, imports, importers
 * and tests; this adds the symbol layer — callers and callees — and answers
 * each of those questions in one call and a few hundred tokens. (The idea, as
 * asked for on 29 Sep 2026, after colbymchenry/codegraph.)
 *
 * ## How edges are found
 *
 * By name, within scope: an identifier in a declaration's body refers to a
 * symbol when that name is declared in the same file or exported by a file it
 * imports (following one level of re-export, for barrels). That is what an
 * import graph can resolve without a type checker. It misses dynamic dispatch
 * and methods called through an object, and it can mistake a local that
 * shadows an import for the import; answers say they are found by name, so
 * the agent treats them as leads, not proof.
 *
 * ## Kept current
 *
 * Rebuilt from the index whenever its revision changes — the index re-reads a
 * file the agent writes before the next step — so the graph grows as a new
 * codebase is written and follows every edit. Building it walks the indexed
 * text once: tens of milliseconds for a few thousand files.
 */

import type { RepoIndex } from "./repo-index.js";

export interface GraphNode {
  key: string;
  path: string;
  name: string;
  kind: string;
  line: number;
  /** Last line of the declaration's chunk, when known. */
  end?: number;
  signature: string;
}

/** An occurrence: who uses whom, and on which line. */
interface Use {
  from: string;
  to: string;
  line: number;
}

/** Top-level code in a file, outside any declaration. */
const TOP = "(top level)";

/** Lines that bring names in rather than use them: ES/TS, CommonJS, Python, Go, Rust. */
const IMPORT_LINE = /^(import\b|export\s+(\*|\{[^}]*\})\s+from\b|export\s+\*|from\s+[\w.]+\s+import\b|use\s+[\w:]+|const\s+\{?[\w\s,]+\}?\s*=\s*require\(|[}\w\s,]*\}\s*from\s+['"])/;

const KEYWORDS = new Set(
  (
    "abstract and any are as async await boolean break case catch class const constructor continue def default del delete do elif else enum " +
    "except export extends false final finally float for from function func get global go if impl implements import in instanceof int " +
    "interface is lambda let long match mod module namespace new nil none not null number object of or override package pass private " +
    "protected pub public raise readonly return self set static string struct super switch symbol this throw throws true try type typeof " +
    "undefined unknown use var void where while with yield"
  ).split(" "),
);

export class CodeGraph {
  readonly nodes = new Map<string, GraphNode>();
  /** Lowercased name → node keys. */
  readonly byName = new Map<string, string[]>();
  readonly callees = new Map<string, Map<string, number>>();
  readonly callers = new Map<string, Map<string, number>>();
  edges = 0;
  builtMs = 0;

  constructor(private readonly index: RepoIndex) {
    const started = Date.now();
    this.build();
    this.builtMs = Date.now() - started;
  }

  private add(node: GraphNode): void {
    this.nodes.set(node.key, node);
    const key = node.name.toLowerCase();
    const list = this.byName.get(key) ?? [];
    list.push(node.key);
    this.byName.set(key, list);
  }

  private build(): void {
    // Nodes: every declaration, its extent taken from the chunk that starts with it.
    const firstByName = new Map<string, Map<string, string>>();
    for (const file of this.index.files.values()) {
      if (!file.isCode) continue;
      const own = new Map<string, string>();
      const chunkEnds = new Map(this.index.chunksOf(file.path).map((c) => [c.start, c.end]));
      for (const sym of file.symbols) {
        const key = `${file.path}:${sym.line}#${sym.name}`;
        const end = sym.end ?? chunkEnds.get(sym.line);
        this.add({ key, path: file.path, name: sym.name, kind: sym.kind, line: sym.line, ...(end ? { end } : {}), signature: sym.signature });
        if (!own.has(sym.name)) own.set(sym.name, key);
      }
      firstByName.set(file.path, own);
    }

    // What a name means in each file: its own declarations, then what its imports export.
    const exportedDef = (path: string, name: string, depth: number): string | undefined => {
      const def = firstByName.get(path)?.get(name);
      if (def) return def;
      if (depth >= 1) return undefined;
      const file = this.index.files.get(path);
      for (const next of file?.imports ?? []) {
        const found = exportedDef(next, name, depth + 1);
        if (found) return found;
      }
      return undefined;
    };

    const uses: Use[] = [];
    for (const file of this.index.files.values()) {
      if (!file.isCode) continue;
      const scope = new Map<string, string>(firstByName.get(file.path));
      for (const imported of file.imports) {
        const target = this.index.files.get(imported);
        if (!target) continue;
        const names = target.exports.length > 0 ? target.exports : target.symbols.map((s) => s.name);
        for (const name of names) {
          if (scope.has(name)) continue;
          const def = exportedDef(imported, name, 0);
          if (def) scope.set(name, def);
        }
      }
      if (scope.size === 0) continue;

      // Each line belongs to the innermost declaration whose body contains it.
      const declared = [...this.nodes.values()].filter((n) => n.path === file.path).sort((a, b) => a.line - b.line);
      const enclosing = (line: number): string | undefined => {
        let found: GraphNode | undefined;
        for (const n of declared) {
          if (n.line > line) break;
          if ((n.end ?? n.line) >= line) found = n;
        }
        return found?.key;
      };
      for (const chunk of this.index.chunksOf(file.path)) {
        const lines = chunk.text.split("\n");
        let inImport = false;
        for (let i = 0; i < lines.length; i++) {
          const line = lines[i]!;
          const trimmed = line.trimStart();
          if (!trimmed || trimmed.startsWith("//") || trimmed.startsWith("#") || trimmed.startsWith("*") || trimmed.startsWith("/*")) continue;
          // An import names a symbol; it does not use it — across every line of `import {\n a,\n b\n} from "x"`.
          if (inImport) {
            if (/\bfrom\s+['"]|^\}\s*;?\s*$|\)\s*;?\s*$/.test(trimmed)) inImport = false;
            continue;
          }
          if (IMPORT_LINE.test(trimmed)) {
            if (/^(import|export)\b/.test(trimmed) && !/\bfrom\s+['"]|['"]\s*;?\s*$/.test(trimmed)) inImport = true;
            else if (/^from\s+[\w.]+\s+import\s*\(\s*$/.test(trimmed)) inImport = true;
            continue;
          }
          const lineNo = chunk.start + i;
          const from = enclosing(lineNo) ?? `${file.path}#${TOP}`;
          // On its own declaration line a symbol's name is the declaration, not a use; what it extends or takes is.
          const declaring = this.nodes.get(from);
          const ownName = declaring && declaring.line === lineNo ? declaring.name : null;
          for (const m of line.matchAll(/[A-Za-z_$][\w$]*/g)) {
            const name = m[0];
            if (name.length < 3 || name === ownName || KEYWORDS.has(name.toLowerCase())) continue;
            // `obj.name` is a property, not the symbol of that name.
            if (m.index! > 0 && line[m.index! - 1] === ".") continue;
            const to = scope.get(name);
            if (to && to !== from) uses.push({ from, to, line: lineNo });
          }
        }
      }
    }

    for (const use of uses) {
      let out = this.callees.get(use.from);
      if (!out) this.callees.set(use.from, (out = new Map()));
      if (!out.has(use.to)) {
        out.set(use.to, use.line);
        this.edges++;
      }
      let back = this.callers.get(use.to);
      if (!back) this.callers.set(use.to, (back = new Map()));
      if (!back.has(use.from)) back.set(use.from, use.line);
    }
  }

  /** Nodes named `name`, in `path` when given. Exact case first. */
  find(name: string, path?: string): GraphNode[] {
    const keys = this.byName.get(name.toLowerCase()) ?? [];
    let nodes = keys.map((k) => this.nodes.get(k)!).filter(Boolean);
    if (path) nodes = nodes.filter((n) => n.path === path || n.path.endsWith(`/${path}`) || n.path.endsWith(path));
    const exact = nodes.filter((n) => n.name === name);
    return (exact.length > 0 ? exact : nodes).sort((a, b) => importanceOf(this.index, b.path) - importanceOf(this.index, a.path));
  }

  label(key: string): string {
    const node = this.nodes.get(key);
    if (node) return `${node.name} (${node.kind}) ${node.path}:${node.line}`;
    const [path] = key.split("#");
    return `${path} ${TOP}`;
  }

  /** Symbols whose names match `query`: exact, then prefix, then substring, then initials (`gUS` → getUserSession). */
  search(query: string, limit = 30): GraphNode[] {
    const q = query.toLowerCase();
    const scored: { node: GraphNode; score: number }[] = [];
    for (const node of this.nodes.values()) {
      const n = node.name.toLowerCase();
      let score = 0;
      if (n === q) score = 100;
      else if (n.startsWith(q)) score = 60;
      else if (n.includes(q)) score = 40;
      else if (initials(node.name).startsWith(q)) score = 30;
      else if (node.signature.toLowerCase().includes(q)) score = 10;
      if (score > 0) scored.push({ node, score: score + importanceOf(this.index, node.path) });
    }
    return scored.sort((a, b) => b.score - a.score).slice(0, limit).map((s) => s.node);
  }

  /** Everything that reaches `start` through `edges`, up to `depth` steps away. */
  reach(start: string[], edges: Map<string, Map<string, number>>, depth: number, limit = 200): Map<string, number> {
    const seen = new Map<string, number>(start.map((s) => [s, 0]));
    let frontier = start;
    for (let d = 1; d <= depth && frontier.length > 0; d++) {
      const next: string[] = [];
      for (const key of frontier) {
        for (const other of edges.get(key)?.keys() ?? []) {
          if (seen.has(other)) continue;
          seen.set(other, d);
          next.push(other);
          if (seen.size >= limit) return seen;
        }
      }
      frontier = next;
    }
    for (const s of start) seen.delete(s);
    return seen;
  }
}

function initials(name: string): string {
  return name
    .replace(/[_-]+/g, " ")
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .split(/\s+/)
    .map((w) => w[0] ?? "")
    .join("")
    .toLowerCase();
}

function importanceOf(index: RepoIndex, path: string): number {
  return Math.min(20, index.files.get(path)?.importance ?? 0);
}

const graphs = new WeakMap<RepoIndex, { revision: number; graph: CodeGraph }>();

/** The graph for an index as it stands now, rebuilt only when the index changed. */
/**
 * The file a node key belongs to. Keys are "path:line#name"; splitting at the
 * first ":" cut a Windows path at its drive letter, so notes said a file was
 * "used by C" (found 5 Oct 2026).
 */
export function keyPath(key: string): string {
  return key.split("#")[0]!.replace(/:\d+$/, "");
}

export function graphOf(index: RepoIndex): CodeGraph {
  const cached = graphs.get(index);
  if (cached && cached.revision === index.revision) return cached.graph;
  const graph = new CodeGraph(index);
  graphs.set(index, { revision: index.revision, graph });
  return graph;
}

// ---- answers, as the agent reads them -------------------------------------

const MAX_LIST = 25;

function list(title: string, items: string[], max = MAX_LIST): string[] {
  if (items.length === 0) return [];
  const shown = items.slice(0, max).map((i) => `  ${i}`);
  return [`${title} (${items.length}):`, ...shown, ...(items.length > max ? [`  … ${items.length - max} more`] : [])];
}

function where(graph: CodeGraph, entries: Map<string, number>): string[] {
  return [...entries].map(([key, line]) => {
    const node = graph.nodes.get(key);
    const [path] = key.split("#");
    return node ? `${node.path}:${line} in ${node.name}` : `${path}:${line} (top level)`;
  });
}

export function overviewText(index: RepoIndex, graph: CodeGraph): string {
  const files = [...index.files.values()];
  const dirs = new Map<string, number>();
  const langs = new Map<string, number>();
  for (const f of files) {
    const top = f.path.includes("/") ? f.path.split("/").slice(0, f.path.split("/").length > 2 ? 2 : 1).join("/") : ".";
    dirs.set(top, (dirs.get(top) ?? 0) + 1);
    const ext = /\.([\w]+)$/.exec(f.path)?.[1] ?? "other";
    langs.set(ext, (langs.get(ext) ?? 0) + 1);
  }
  const hubs = files
    .filter((f) => f.isCode)
    .map((f) => ({ path: f.path, n: index.importedBy.get(f.path)?.size ?? 0 }))
    .filter((h) => h.n > 0)
    .sort((a, b) => b.n - a.n)
    .slice(0, 12)
    .map((h) => `${h.path} — imported by ${h.n}`);
  const entries = files
    .filter((f) => f.isCode && !f.isTest && (index.importedBy.get(f.path)?.size ?? 0) === 0 && f.imports.length > 0)
    .sort((a, b) => b.importance - a.importance)
    .slice(0, 10)
    .map((f) => f.path);
  const byCount = (m: Map<string, number>) => [...m].sort((a, b) => b[1] - a[1]);
  return [
    `Codebase: ${files.length} files indexed${index.stats.truncated ? " (large repository: the least important files were left out)" : ""}, ${graph.nodes.size} declarations, ${index.stats.edges} import edges, ${graph.edges} use edges, ${files.filter((f) => f.isTest).length} test files.`,
    `Languages: ${byCount(langs).slice(0, 8).map(([e, n]) => `${e} ${n}`).join(", ")}`,
    ...list("Directories", byCount(dirs).map(([d, n]) => `${d}/ — ${n} files`), 20),
    ...list("Most depended on", hubs),
    ...list("Entry points (import others, imported by none)", entries),
  ].join("\n");
}

export function fileText(index: RepoIndex, graph: CodeGraph, path: string): string | null {
  const file = index.files.get(path) ?? [...index.files.values()].find((f) => f.path.endsWith(`/${path}`) || f.path.endsWith(path));
  if (!file) return null;
  const nodes = [...graph.nodes.values()].filter((n) => n.path === file.path).sort((a, b) => a.line - b.line);
  const outline = nodes.map((n) => {
    const users = [...(graph.callers.get(n.key)?.keys() ?? [])].filter((k) => !k.startsWith(`${file.path}:`) && !k.startsWith(`${file.path}#`)).length;
    return `${n.line}${n.end ? `-${n.end}` : ""}: ${n.signature}${users ? `   ← used from ${users} place${users === 1 ? "" : "s"} elsewhere` : ""}`;
  });
  return [
    `${file.path} — ${file.lines} lines${file.isTest ? ", a test file" : ""}`,
    ...list("Declarations (line range: signature)", outline, 60),
    ...(file.exports.length ? [`Exports: ${file.exports.slice(0, 40).join(", ")}${file.exports.length > 40 ? ", …" : ""}`] : []),
    ...list("Imports", file.imports),
    ...list("Imported by", [...(index.importedBy.get(file.path) ?? [])]),
    ...list("Tests", index.testsFor(file.path)),
  ].join("\n");
}

export function symbolText(index: RepoIndex, graph: CodeGraph, name: string, path?: string): string | null {
  const found = graph.find(name, path);
  if (found.length === 0) return null;
  return found
    .slice(0, 3)
    .map((node) => {
      const callers = graph.callers.get(node.key) ?? new Map<string, number>();
      const callees = graph.callees.get(node.key) ?? new Map<string, number>();
      return [
        `${node.name} — ${node.kind} at ${node.path}:${node.line}${node.end ? `-${node.end}` : ""}`,
        `  ${node.signature}`,
        ...list("Used by", where(graph, callers)),
        ...list("Uses", [...callees.keys()].map((k) => graph.label(k))),
        ...list("Tests for its file", index.testsFor(node.path), 10),
      ].join("\n");
    })
    .concat(found.length > 3 ? [`… and ${found.length - 3} more declarations named ${name}`] : [])
    .join("\n\n");
}

export function impactText(index: RepoIndex, graph: CodeGraph, target: { name?: string; path?: string }, depth: number): string | null {
  if (target.name) {
    const nodes = graph.find(target.name, target.path);
    if (nodes.length === 0) return null;
    const reached = graph.reach(nodes.map((n) => n.key), graph.callers, depth);
    const files = new Set([...reached.keys()].map(keyPath));
    for (const n of nodes) files.add(n.path);
    const tests = new Set<string>();
    for (const f of files) for (const t of index.testsFor(f)) tests.add(t);
    for (const f of files) if (index.files.get(f)?.isTest) tests.add(f);
    const byDepth = [...reached].sort((a, b) => a[1] - b[1]).map(([k, d]) => `${"  ".repeat(d - 1)}${graph.label(k)}`);
    return [
      `Changing ${target.name} reaches ${reached.size} use${reached.size === 1 ? "" : "s"} in ${files.size} file${files.size === 1 ? "" : "s"} (up to ${depth} steps, found by name):`,
      ...byDepth.slice(0, 60).map((l) => `  ${l}`),
      ...(byDepth.length > 60 ? [`  … ${byDepth.length - 60} more`] : []),
      ...list("Tests to run", [...tests]),
    ].join("\n");
  }
  const file = target.path ? index.files.get(target.path) ?? [...index.files.values()].find((f) => f.path.endsWith(target.path!)) : undefined;
  if (!file) return null;
  const importers = new Map<string, Map<string, number>>();
  for (const [to, froms] of index.importedBy) importers.set(to, new Map([...froms].map((f) => [f, 0])));
  const reached = graph.reach([file.path], importers, depth);
  const tests = new Set<string>(index.testsFor(file.path));
  for (const f of reached.keys()) {
    if (index.files.get(f)?.isTest) tests.add(f);
    for (const t of index.testsFor(f)) tests.add(t);
  }
  const byDepth = [...reached].sort((a, b) => a[1] - b[1]).map(([f, d]) => `${"  ".repeat(d - 1)}${f}`);
  return [
    `Changing ${file.path} reaches ${reached.size} file${reached.size === 1 ? "" : "s"} that import it (up to ${depth} steps):`,
    ...byDepth.slice(0, 60).map((l) => `  ${l}`),
    ...(byDepth.length > 60 ? [`  … ${byDepth.length - 60} more`] : []),
    ...list("Tests to run", [...tests]),
  ].join("\n");
}

export function searchText(graph: CodeGraph, query: string): string {
  const found = graph.search(query);
  if (found.length === 0) return `No declaration matches "${query}". Try grep_search for text that is not a declared name.`;
  return [`Declarations matching "${query}" (${found.length}${found.length >= 30 ? "+" : ""}):`, ...found.map((n) => `  ${n.path}:${n.line}  ${n.signature}`)].join("\n");
}

/** A file's place in the graph, in a line: for the working set, beside the files in focus. */
export function neighbourhoodLine(index: RepoIndex, graph: CodeGraph, path: string): string | null {
  const file = index.files.get(path);
  if (!file || !file.isCode) return null;
  const users = new Set<string>();
  for (const n of graph.nodes.values()) {
    if (n.path !== path) continue;
    for (const from of graph.callers.get(n.key)?.keys() ?? []) {
      const p = keyPath(from);
      if (p !== path) users.add(p);
    }
  }
  const tests = index.testsFor(path);
  const parts = [
    users.size ? `used by ${[...users].slice(0, 4).join(", ")}${users.size > 4 ? ` +${users.size - 4}` : ""}` : "",
    file.imports.length ? `imports ${file.imports.slice(0, 3).join(", ")}${file.imports.length > 3 ? ` +${file.imports.length - 3}` : ""}` : "",
    tests.length ? `tests ${tests.slice(0, 2).join(", ")}` : "",
  ].filter(Boolean);
  return parts.length ? `${path}: ${parts.join("; ")}` : null;
}
