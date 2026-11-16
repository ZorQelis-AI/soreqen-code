/**
 * Turning a tool's result into something the model can reason about.
 *
 * ## The bug this was written to fix
 *
 * The loop rendered every result as:
 *
 * ```ts
 * resultString = toolRes.data ? JSON.stringify(toolRes.data, null, 2)
 *                             : "Execution succeeded.";
 * ```
 *
 * `ToolResult` carries `{ success, data, error, diff }`, and that expression
 * reads exactly one of those fields. So a tool returning
 * `{ success: false, error: "File not found" }` — a failure, with no `data` —
 * was handed to the model as **"Execution succeeded."**
 *
 * The model then reasons from that: it believes the file was written, moves
 * on, and reports the task done. Every later step is built on it. This is the
 * worst possible failure mode for an agent, because it is not a crash — it is
 * a confident, coherent, wrong outcome that costs a person their trust before
 * they find it.
 *
 * Even when `data` *was* present, `success` never reached the model: a failed
 * call and a successful one produced identically-shaped text, so nothing in
 * the transcript distinguished them.
 *
 * ## What it does now
 *
 * Failure is stated first and in words, because a model skims the head of a
 * tool result exactly as a person does. Success is unmarked — the absence of a
 * failure line is the signal, and prefixing every good result with "OK" would
 * spend tokens on the common case to no benefit.
 */

import type { ToolResult } from "@sqcode/tools";
import { readable } from "./context-hygiene.js";

/** How much of one tool's output may reach the history before it is trimmed.
 *  The context manager caps this again later; this is the earlier, cheaper
 *  cut, so a 40 MB command output never becomes a 40 MB string in memory. */
export const MAX_RESULT_CHARS = 24_000;

/**
 * Tools whose output is a document to read whole, not a log to skim: a
 * research report, a skill's text. Cut at the usual 24,000 characters, a Max
 * research report (30,000 to 50,000) reached the agent with its middle
 * replaced by "characters omitted", and then the context gateway cut that
 * again to a few key lines (found 5 Oct 2026). These keep their whole text up
 * to these sizes, here and in the gateway (`DOCUMENT_THRESHOLDS`).
 */
export const DOCUMENT_LIMITS: Record<string, number> = {
  research: 80_000,
  use_skill: 48_000,
  // A primary source being read (docs, a paper, a changelog): 10,000 by default, up to this when asked.
  fetch_url_content: 24_000,
  /*
   * A sub-agent's report is the whole point of having sent it: what it found,
   * what it changed, what failed. Over 6,000 characters it reached the lead
   * as a 3,200-character digest and a file to read (reported 13 Oct 2026:
   * "it truncates sub-agent reports and deep research results").
   */
  spawn_subagent: 48_000,
  subagent_status: 48_000,
  /*
   * A search writes itself to fit (`SEARCH_RESULT_BUDGET`, 10,000): every
   * file named, the real count, as many lines as fit. At the usual 6,000 it
   * was digested to "key lines", which for a list of matches is a random few
   * (reported 18 Oct 2026).
   */
  grep_search: 12_000,
};

/** An app's tool (a connector, an MCP server): a page, a ticket, a thread. Read whole up to this. */
const APP_TOOL_LIMIT = 24_000;

/** The document limit for a tool, if its output is a document; see `DOCUMENT_LIMITS`. */
export function documentLimit(tool: string): number | undefined {
  return DOCUMENT_LIMITS[tool] ?? (tool.startsWith("mcp__") ? APP_TOOL_LIMIT : undefined);
}

/**
 * The most of a file one read returns, on the largest windows: about 50,000
 * tokens, some 5,000 lines of code.
 *
 * It was 24,000 characters, and a bigger file was turned into an outline and
 * then cut to its head and tail; past 16,000 the context gateway cut even that
 * to 3,200 characters of "key lines" before the model saw it once. A 523-line
 * Java file reached the agent that way, and the transcript showed the outline
 * instead of the code (reported 29 Oct 2026: "it should be fully shown to it,
 * not just top, bottom and truncated"). A file is now returned whole up to the
 * window's share (`readFileLimit`), and past that in consecutive pages of real
 * lines, each naming the next, so nothing in the middle is ever skipped.
 */
export const READ_FILE_MAX = 200_000;

/**
 * How much of a file one read returns, for a model with this window: an eighth
 * of it, between the usual 24,000 characters and `READ_FILE_MAX`. A 1M model
 * reads 200,000 at once, a 128k one 61,000, a 32k one 24,000.
 */
export function readFileLimit(windowTokens?: number): number {
  if (!windowTokens || windowTokens <= 0) return READ_FILE_MAX;
  return Math.max(MAX_RESULT_CHARS, Math.min(READ_FILE_MAX, Math.floor(windowTokens * 4 * 0.12)));
}

/**
 * What stays whole while fresh, in the history: the documents above, and a
 * file read. A ranged read the agent asked for is what it edits from; cut at
 * 10,000 characters, its middle came back as "omitted" and the agent read the
 * same lines again in smaller pieces, step after step (seen 6 Oct 2026). A
 * read is already paged where it is shaped (`readFileLimit`), so this only
 * stops the later passes cutting it a second time.
 */
export const WHOLE_LIMITS: Record<string, number> = { ...DOCUMENT_LIMITS, read_file: READ_FILE_MAX };

/** What stays whole while fresh, for a tool; see `WHOLE_LIMITS`. */
export function wholeLimit(tool: string): number | undefined {
  return WHOLE_LIMITS[tool] ?? documentLimit(tool);
}

/**
 * Render a tool result for the model.
 *
 * Compact JSON, not pretty-printed. Indentation exists so people can read
 * nested structures, and no person reads this — two-space indent on a deep
 * object is roughly a third of its tokens spent on whitespace, every
 * iteration, for the life of the turn.
 */
export function formatToolResult(result: ToolResult, options: { clip?: boolean; limit?: number } = {}): string {
  const body = renderBody(result, options.clip !== false, options.limit ?? MAX_RESULT_CHARS);

  /*
   * Warnings go at the front, above the JSON.
   *
   * A successful-but-damaging result — an edit that applied and left the file
   * unbalanced — carries its warning inside `data`, where it is one key among
   * several in a serialised object and reads as data rather than as something
   * to act on. A model skims the head of a tool result exactly as a person
   * does, so a warning buried at position four of a JSON blob is a warning
   * that arrives too late to change the next action.
   *
   * This is the same lesson as `FAILED:` below, applied one severity down.
   */
  const warnings = warningsOf(result);
  const prefix = warnings.length > 0 ? `${warnings.map((w) => `WARNING: ${w}`).join("\n")}\n\n` : "";

  if (result.success) return prefix ? `${prefix}${body}` : body;

  /*
   * The reason, then the evidence.
   *
   * A tool can fail *and* return data — a test runner exits non-zero and still
   * produces a report, and that report is the most useful thing on the screen.
   * Reporting only the error would throw away the diagnosis; reporting only
   * the data would hide the failure.
   */
  const reason = result.error?.trim() || "The tool reported failure without a reason.";
  const failed = body ? `FAILED: ${reason}\n\n${body}` : `FAILED: ${reason}`;
  return prefix ? `${prefix}${failed}` : failed;
}

/** Warnings a tool attached to an otherwise-successful result. */
function warningsOf(result: ToolResult): string[] {
  const data = result.data;
  if (!data || typeof data !== "object") return [];
  const raw = (data as { warnings?: unknown }).warnings;
  if (!Array.isArray(raw)) return [];
  return raw.filter((w): w is string => typeof w === "string");
}

function renderBody(result: ToolResult, clipped: boolean, limit: number): string {
  const cut = clipped ? (text: string) => clipResult(text, limit) : (text: string) => text;
  if (result.data === undefined || result.data === null) return "";

  // A string result is already the thing the model wants — file contents,
  // command output. Wrapping it in JSON quotes and escaping every newline
  // makes it both larger and harder to read.
  if (typeof result.data === "string") return cut(result.data);

  try {
    // A document (a fetched page, a report) reads as text: its fields as "key: value" and its long text unescaped.
    if (limit !== MAX_RESULT_CHARS) return cut(readable(JSON.stringify(result.data)));
    return cut(JSON.stringify(result.data));
  } catch {
    // Circular or otherwise unserialisable. Saying so beats throwing inside
    // the loop over a result that was probably fine.
    return "[result could not be serialised]";
  }
}

export function clipResult(text: string, limit = MAX_RESULT_CHARS): string {
  if (text.length <= limit) return text;
  const keep = Math.floor(limit / 2);
  return (
    text.slice(0, keep) +
    `\n\n[... ${(text.length - limit).toLocaleString()} characters omitted. ` +
    `Narrow the query if you need what is missing. ...]\n\n` +
    text.slice(-keep)
  );
}
