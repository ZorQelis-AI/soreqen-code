/**
 * A text search's result, as the agent reads it.
 *
 * ## Why not JSON
 *
 * `grep_search` returned `{"matches":[{"file":…,"line":…,"content":…}, …]}`:
 * the file's path repeated on every hit, every line up to 400 characters
 * whatever part of it matched, and punctuation around all of it. Two hundred
 * hits came to 60,000 to 100,000 characters, which the result renderer cut in
 * the middle at 24,000 and the context gateway then cut again to a 3,200
 * character digest of "key lines" (reported 18 Oct 2026: "the grep results
 * are too long and getting truncated").
 *
 * ## The shape now
 *
 * ```
 * 14 matches in 3 files
 * src/session.ts
 *   12: export function openSession(id: string) {
 *   88: return openSession(next);
 * docs/api.md (9 matches, first 3 shown)
 *   4: Call openSession with the id …
 * ```
 *
 * The count is always the real one. Every file is named. A long line is shown
 * around its match, not from its start. When everything does not fit the
 * budget, fewer lines are shown per file before any file is dropped, and the
 * files past the budget are still listed with their counts, so the agent
 * knows exactly what it is not seeing and where to narrow.
 *
 * Widgets and the CLI read this shape back (`parseSearchResult` in the
 * widget's tool-view), so the first line and the two-space hit indent are a
 * format, not decoration.
 */

import type { SearchOutcome } from "./search.js";

/** What one result may take: under the context gateway's limit for this tool, so it is never digested. */
export const SEARCH_RESULT_BUDGET = 10_000;
/** Characters of a line shown; a longer one is shown around its match. */
const LINE_MAX = 200;
/** Of those, how many come before the match. */
const LEAD = 60;
/** The most lines shown from one file: past this, the file is better read than listed. */
const MAX_PER_FILE = 50;

interface Group {
  file: string;
  hits: SearchOutcome["hits"];
}

function count(n: number): string {
  return n.toLocaleString("en-US");
}

function plural(n: number, one: string, many: string): string {
  return `${count(n)} ${n === 1 ? one : many}`;
}

/** A line as shown: its indentation dropped, and a long one cut around the match. */
export function shownLine(text: string, column?: number): string {
  const body = text.trimStart();
  const at = column === undefined ? 0 : Math.max(0, column - (text.length - body.length));
  const trimmed = body.trimEnd();
  if (trimmed.length <= LINE_MAX) return trimmed;
  const start = Math.max(0, Math.min(at - LEAD, trimmed.length - LINE_MAX));
  const end = start + LINE_MAX;
  return `${start > 0 ? "…" : ""}${trimmed.slice(start, end)}${end < trimmed.length ? "…" : ""}`;
}

function groupsOf(hits: SearchOutcome["hits"]): Group[] {
  const byFile = new Map<string, Group>();
  for (const hit of hits) {
    let group = byFile.get(hit.file);
    if (!group) {
      group = { file: hit.file, hits: [] };
      byFile.set(hit.file, group);
    }
    group.hits.push(hit);
  }
  return [...byFile.values()];
}

export interface SearchResultInput {
  query: string;
  path: string;
  outcome: SearchOutcome;
  outputMode?: "content" | "files";
  caseSensitive?: boolean;
}

export function formatSearchResult(input: SearchResultInput): string {
  const { outcome } = input;
  const groups = groupsOf(outcome.hits);
  const total = outcome.hits.length;

  if (total === 0) return noMatches(input);

  const capped = outcome.capped === true;
  const partial = outcome.truncated && !capped;
  let header = `${count(total)}${capped ? "+" : ""} ${total === 1 && !capped ? "match" : "matches"} in ${plural(groups.length, "file", "files")}`;
  if (capped) header += ` (the search stopped at ${count(total)}: narrow the path, the query or includes for the rest)`;
  if (partial) header += " (the folder is too large to search whole and part of it was not read: give a narrower path)";

  if (input.outputMode === "files") {
    return fitList(header, groups, SEARCH_RESULT_BUDGET);
  }

  const room = SEARCH_RESULT_BUDGET - header.length - 1;
  const lines = groups.map((g) => g.hits.map((h) => `  ${h.line}: ${shownLine(h.text, h.column)}`));
  // A file's own line, at its longest: "path (1,234 matches, first 12 shown)".
  const headCost = groups.map((g) => g.file.length + 1 + (g.hits.length > 1 ? 36 : 0));

  /*
   * Every file with its first line, while that fits; past it, the rest are
   * named with their counts (room kept for that list).
   */
  let fit = 0;
  let used = 0;
  const firstCost = (i: number): number => headCost[i]! + lines[i]![0]!.length + 1;
  const allFirst = groups.reduce((sum, _g, i) => sum + firstCost(i), 0);
  const limit = allFirst <= room ? room : room * 0.7;
  for (; fit < groups.length && used + firstCost(fit) <= limit; fit++) used += firstCost(fit);
  const rest = groups.slice(fit);
  const listed = rest.length > 0 ? fitList("Also matching (lines not shown):", rest, room - used) : "";
  used += listed.length + (listed ? 1 : 0);

  /*
   * Then more lines, a round at a time across the files, so the room left
   * goes to every file evenly rather than all to the first.
   */
  const everything = groups.reduce((sum, _g, i) => sum + headCost[i]! + lines[i]!.reduce((s, l) => s + l.length + 1, 0), 0);
  const take = groups.map((g, i) => (everything <= room ? g.hits.length : i < fit ? 1 : 0));
  for (let added = everything > room; added; ) {
    added = false;
    for (let i = 0; i < fit; i++) {
      const next = lines[i]![take[i]!];
      if (next === undefined || take[i]! >= MAX_PER_FILE) continue;
      if (used + next.length + 1 > room) continue;
      used += next.length + 1;
      take[i]!++;
      added = true;
    }
  }

  const blocks = groups.slice(0, fit).map((g, i) => {
    const n = take[i]!;
    const head = n < g.hits.length ? `${g.file} (${count(g.hits.length)} matches, first ${count(n)} shown)` : g.file;
    return [head, ...lines[i]!.slice(0, n)].join("\n");
  });
  return [header, ...blocks, ...(listed ? [listed] : [])].join("\n");
}

/** File names with their counts, as many as fit, and how many more there are. */
function fitList(head: string, groups: Group[], budget: number): string {
  const lines = [head];
  let used = head.length;
  for (let i = 0; i < groups.length; i++) {
    const line = `${groups[i]!.file} (${count(groups[i]!.hits.length)})`;
    if (used + line.length + 1 > budget - 40) {
      lines.push(`… and ${plural(groups.length - i, "more file", "more files")}`);
      break;
    }
    lines.push(line);
    used += line.length + 1;
  }
  return lines.join("\n");
}

/**
 * Nothing found, and enough said that the agent can tell "not there" from
 * "searched wrongly": which engine looked, how the query was read, and
 * whether part of the folder went unread.
 */
function noMatches(input: SearchResultInput): string {
  const { outcome } = input;
  const notes: string[] = [];
  if (outcome.mode === "literal" && /[|\\]/.test(input.query)) {
    notes.push("The query was searched as literal text; leave is_regex unset (or true) to read '|' as 'or'.");
  }
  if (input.caseSensitive) notes.push("The search was case-sensitive.");
  if (outcome.truncated) notes.push("The folder is too large to search whole, so part of it was not read: give a narrower path.");
  return (
    `No matches for ${JSON.stringify(input.query)} in ${input.path} ` +
    `(searched with ${outcome.engine === "ripgrep" ? "ripgrep" : "the built-in scan"}` +
    `${outcome.mode === "both" ? ", as a pattern and as text" : outcome.mode === "regex" ? ", as a pattern" : ""}).` +
    (notes.length > 0 ? ` ${notes.join(" ")}` : "")
  );
}
