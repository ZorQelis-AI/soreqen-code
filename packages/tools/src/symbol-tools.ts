/**
 * Finding where something is declared, and where it is used.
 *
 * ## Definitions: two mechanisms, in order of how much they know
 *
 * **The index**, when the orchestrator has one. `buildRepoMap` opens several
 * hundred source files at the top of every turn and extracts their
 * declarations; asking it is a map lookup that returns the declaration itself.
 *
 * **A search**, otherwise. Slower, covers the whole workspace, and returns
 * every textual near-miss — a mention in a comment, a similarly-named local,
 * an import line — which the model then pays to sift.
 *
 * Which one answered is reported, because it changes what a *negative* answer
 * is worth.
 *
 * ## References: search to narrow, then lex to decide
 *
 * The index holds declarations, not call sites, so finding every *use* of a
 * name genuinely means reading files. A text search is the right way to pick
 * which ones — and the wrong way to say what it found, because `\bname\b`
 * matches prose in a comment exactly as well as a call.
 *
 * So the search narrows to candidate files, and each is then lexed by
 * `references.ts`, which knows which bytes are code. What comes back is
 * classified — call, definition, import, type, mention — with comment and
 * string hits counted and left out of the list.
 *
 * ## What both replaced
 *
 * `git grep`, with a regex assembled from the symbol name and interpolated
 * into a shell command. Wrong four ways: the escaping was for a regex and not
 * a shell, so a backtick in a symbol name was command substitution in a tool
 * on the `read_only` allowlist; the path was not escaped at all; `git grep`
 * only searches *tracked* files, so anything uncommitted was invisible; and it
 * failed outright outside a git repository.
 */

import type { SandboxRunner as Runner } from "@sqcode/sandbox-runner";
import type { FindSymbolDefinitionInput, FindSymbolReferencesInput } from "@sqcode/shared";
import { searchWorkspace } from "./search.js";
import { CODE_KINDS, findReferences, type ReferenceKind } from "./references.js";

/**
 * Answer a symbol lookup from an index, or say there is no index.
 *
 * Declared structurally rather than imported from the orchestrator, because
 * the dependency runs the other way: the orchestrator imports these tools.
 *
 * `null` means *no index exists*, which is a different answer from an empty
 * array — "I have not looked" against "I looked and it is not there". A tool
 * that reports the first as the second teaches the model a symbol does not
 * exist, and it writes a second copy of it.
 */
export type SymbolLookup = (
  name: string,
) => { file: string; line: number; kind: string; signature: string }[] | null;

/** Declarations returned before the list is trimmed. Enough to show that a
 *  name is defined in several places, few enough not to fill the context. */
const MAX_DEFINITIONS = 10;
const MAX_REFERENCES = 25;

/** Files opened to classify their hits. A name that appears in more files than
 *  this is a name the answer cannot usefully enumerate anyway; the count is
 *  still reported so the model knows the list was cut. */
const MAX_FILES_CLASSIFIED = 200;
/** Reads in flight. Same figure as the repo map's, for the same reason: these
 *  are IO waits, and the OS handles a couple of dozen far better than one. */
const READ_CONCURRENCY = 24;

export interface SymbolDefinitionResult {
  symbol: string;
  found: boolean;
  /** Which mechanism answered. A miss from the index means "not in the
   *  indexed files"; a miss from a search means "not in the workspace". */
  source: "index" | "search";
  definitions: Array<{ file: string; line: number; declaration: string }>;
  note?: string;
}

export async function toolFindSymbolDefinition(
  input: FindSymbolDefinitionInput,
  workspaceId: string,
  sandboxRunner: Runner,
  lookup?: SymbolLookup,
): Promise<SymbolDefinitionResult> {
  const { symbol_name, file_path } = input;

  // The index first, because it already knows and costs nothing to ask.
  const indexed = lookup?.(symbol_name);
  if (indexed && indexed.length > 0) {
    const scoped = file_path
      ? indexed.filter((d) => d.file === file_path || d.file.endsWith(`/${file_path}`))
      : indexed;

    if (scoped.length > 0) {
      return {
        symbol: symbol_name,
        found: true,
        source: "index",
        definitions: scoped.slice(0, MAX_DEFINITIONS).map((d) => ({
          file: d.file,
          line: d.line,
          declaration: d.signature,
        })),
      };
    }
  }

  const escaped = symbol_name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  // Declarations in TypeScript, JavaScript, Python, Go, Rust and friends.
  const pattern = `(^|\\s)(export\\s+)?(function|class|interface|type|const|let|var|def|struct|enum)\\s+${escaped}(\\s|\\(|:|=|\\{|<)`;

  const outcome = await searchWorkspace(sandboxRunner, workspaceId, {
    pattern,
    isRegex: true,
    caseSensitive: true,
    path: file_path ?? ".",
  });

  const definitions = outcome.hits.map((h) => ({
    file: h.file,
    line: h.line,
    declaration: h.text.trim().slice(0, 400),
  }));

  const found = definitions.length > 0;
  return {
    symbol: symbol_name,
    found,
    source: "search",
    definitions: definitions.slice(0, MAX_DEFINITIONS),
    ...(found
      ? {}
      : {
          /*
           * A miss is qualified, never bare.
           *
           * Saying only "found: false" invites the model to conclude the
           * symbol does not exist. Naming the engine and the scope lets it
           * weigh that — and matters most when the engine was the builtin
           * fallback, which is present precisely because ripgrep was not.
           */
          note:
            `No declaration of '${symbol_name}' found in ${file_path ?? "the workspace"} ` +
            `(searched with ${outcome.engine}). It may be generated, imported from a ` +
            `dependency, or declared in a form this pattern does not recognise.`,
        }),
  };
}

export interface SymbolReferencesResult {
  symbol: string;
  found: boolean;
  /** Uses in code. Comments and strings are counted separately and are not
   *  in here. */
  totalReferences: number;
  references: Array<{
    file: string;
    line: number;
    column: number;
    kind: ReferenceKind;
    codeSnippet: string;
  }>;
  /** How many code references of each kind, across every file. A rename needs
   *  to know it is touching four call sites and one declaration before it
   *  reads a single line. */
  byKind: Partial<Record<ReferenceKind, number>>;
  /** Mentions in prose and in string literals. Reported, not listed: knowing
   *  six comments name this function is useful; six lines of prose is not. */
  inCommentsOrStrings: number;
  truncated?: boolean;
  note?: string;
}

/*
 * Where in a file a name is worth reading first.
 *
 * A declaration answers "what is this"; call sites answer "what breaks if I
 * change it". Imports and type positions matter for a rename and rarely for
 * understanding, so they sort below both.
 */
const KIND_PRIORITY: Record<ReferenceKind, number> = {
  definition: 0,
  call: 1,
  type: 2,
  mention: 3,
  import: 4,
  comment: 5,
  string: 6,
};

export async function toolFindSymbolReferences(
  input: FindSymbolReferencesInput,
  workspaceId: string,
  sandboxRunner: Runner,
): Promise<SymbolReferencesResult> {
  const { symbol_name, path: searchPath } = input;
  const escaped = symbol_name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

  /*
   * Two passes, and the second is the point.
   *
   * The search finds *files* that contain the name — which is what a text
   * search is genuinely good at, and why it is still the first step. Each
   * candidate file is then read once and lexed, so every occurrence can be
   * told apart: a call, a declaration, an import, a type position, or a
   * mention inside a comment.
   *
   * Before this, the search's raw output *was* the answer. Asked for
   * `guardPath` in this repository it returned 23 lines, five of which were
   * call sites and the rest imports, prose in block comments, and a test name
   * in a string. The model paid for all 23 and had to sort them itself — and a
   * comment that names a function is indistinguishable from a call once it is
   * one line in a list, which is how "update all the references" becomes an
   * edit to somebody's documentation.
   */
  const outcome = await searchWorkspace(sandboxRunner, workspaceId, {
    pattern: `\\b${escaped}\\b`,
    isRegex: true,
    caseSensitive: true,
    path: searchPath ?? ".",
    maxHits: 2_000,
  });

  const allCandidates = [...new Set(outcome.hits.map((h) => h.file))];
  const candidateFiles = allCandidates.slice(0, MAX_FILES_CLASSIFIED);

  const all: Array<{
    file: string;
    line: number;
    column: number;
    kind: ReferenceKind;
    codeSnippet: string;
  }> = [];

  /*
   * Read the candidates concurrently.
   *
   * Serially this is one round trip per file, and a common name in a large
   * repository is a hundred files — the exact case the user described as "will
   * not work in Large Directories". The reads are IO, so overlapping them costs
   * nothing and turns a hundred sequential waits into a handful.
   */
  let cursor = 0;
  const classifyOne = async (): Promise<void> => {
    for (;;) {
      const index = cursor++;
      const file = candidateFiles[index];
      if (file === undefined) return;

      let content: string;
      try {
        content = (await sandboxRunner.readFile(workspaceId, file)).content;
      } catch {
        // Vanished or unreadable between the search and now. Its search hits are
        // dropped rather than reported unclassified, because an unclassified hit
        // is exactly the thing this tool exists to stop producing.
        continue;
      }
      for (const ref of findReferences(file, content, symbol_name)) {
        all.push({
          file,
          line: ref.line,
          column: ref.column,
          kind: ref.kind,
          codeSnippet: ref.text,
        });
      }
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(READ_CONCURRENCY, candidateFiles.length) }, classifyOne),
  );

  const code = all.filter((r) => CODE_KINDS.includes(r.kind));
  const prose = all.length - code.length;

  const byKind: Partial<Record<ReferenceKind, number>> = {};
  for (const ref of code) byKind[ref.kind] = (byKind[ref.kind] ?? 0) + 1;

  code.sort(
    (a, b) =>
      KIND_PRIORITY[a.kind] - KIND_PRIORITY[b.kind] ||
      a.file.localeCompare(b.file) ||
      a.line - b.line,
  );

  const found = code.length > 0;
  return {
    symbol: symbol_name,
    found,
    totalReferences: code.length,
    references: code.slice(0, MAX_REFERENCES),
    byKind,
    inCommentsOrStrings: prose,
    ...(code.length > MAX_REFERENCES ||
    outcome.truncated ||
    allCandidates.length > candidateFiles.length
      ? { truncated: true }
      : {}),
    ...(found
      ? {}
      : {
          note:
            `No code references to '${symbol_name}' in ${searchPath ?? "the workspace"}` +
            (prose > 0
              ? ` — though it is named in ${prose} comment(s) or string(s).`
              : ` (searched with ${outcome.engine}).`),
        }),
  };
}
