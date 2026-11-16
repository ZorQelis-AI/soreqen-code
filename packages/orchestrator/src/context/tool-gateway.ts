/**
 * Tool output on its way into the model's view.
 *
 * ## Stored whole, shown condensed
 *
 * A tool result is recorded in the conversation as it came back — the
 * transcript and a reloaded session show all of it — but what the model is
 * *sent* goes through this gateway first:
 *
 *   normalised   terminal codes stripped, line endings unified, a line
 *                repeated fifty times shown once with a count
 *   large        written to a file in the workspace (an artifact) and replaced
 *                by its head, every line that reports an error or a result,
 *                its tail, and the artifact's path — which the agent can read
 *                with read_file, a range at a time, whenever it needs more
 *   stale        a file's contents read before that file was changed are
 *                labelled as such, so an old read is never mistaken for the
 *                current code; a recent read that the agent's own exact
 *                edits overtook is brought up to date instead (`patchRead`)
 *
 * The view is a pure function of the history, so the same history always
 * produces the same bytes — which is what keeps the provider's prompt cache
 * and the prefix seal valid across steps.
 */

import type { SandboxRunner } from "@sqcode/sandbox-runner";
import { condense, isFailure, readable } from "../context-hygiene.js";
import { READ_FILE_MAX, documentLimit } from "../tool-result.js";
import type { LLMMessage, LLMToolCall } from "../types.js";
import { contentHash, normalisePath } from "./task-state.js";

/** Past this, an output is shown as a digest with a reference to the whole. */
export const ARTIFACT_THRESHOLD = 6_000;
const DIGEST_CHARS = 3_200;
/**
 * A whole file is often needed whole, to edit it; only a very large one is digested.
 *
 * It was 16,000 characters, which cut a fresh read of any file past about 400
 * lines to 3,200 characters of "key lines" before the model had seen it once
 * (29 Oct 2026). A read now arrives paged to the window's share
 * (`readFileLimit`), so it is never larger than this, and the only reads
 * shortened are old ones, by the hygiene pass's ageing.
 */
export const READ_THRESHOLD = READ_FILE_MAX;


const WRITES = new Set(["write_file", "edit_file"]);

/**
 * A read this many steps old or newer is brought up to date with the agent's
 * own later edits rather than marked stale. Older ones are marked: they are
 * ageing out anyway, and patching them would move the prompt cache further back.
 */
const PATCH_RECENT_STEPS = 12;

/** A line of an edit long enough that finding it in a read means the read overlaps the edit. */
const OVERLAP_LINE = 12;

/**
 * A read, with the agent's own later edits applied to it.
 *
 * Marked STALE after every edit, a read sent the agent back to read the same
 * lines again before its next edit, and a document written in fifty small
 * edits became fifty read, think, edit-one-line steps (seen 6 Oct 2026). An
 * edit_file is exact: its old text was in the file once and is now its new
 * text. Where the read holds that old text once, swapping it in gives the
 * file as it is now, which is what a fresh read would have returned.
 *
 * Returns null whenever that is not certain: a result that is not a whole
 * read (clipped, digested), an edit placed by a looser match, old text found
 * twice, or an edit that straddles the edge of a ranged read. Those keep the
 * STALE label.
 */
export function patchRead(
  content: string,
  edits: { input: Record<string, unknown>; result: string }[],
): string | null {
  let data: Record<string, unknown>;
  try {
    const parsed = JSON.parse(content) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    data = parsed as Record<string, unknown>;
  } catch {
    return null;
  }
  if (typeof data["content"] !== "string") return null;
  let text = data["content"] as string;
  let lineDelta = 0;
  let outside = false;
  for (const { input, result } of edits) {
    const from = input["old_str"];
    const to = input["new_str"];
    if (typeof from !== "string" || typeof to !== "string" || !from) return null;
    // Applied by a looser rung of the edit ladder: the file's text differed from old_str.
    if (/"matchStrategy":"(?!exact")/.test(result)) return null;
    lineDelta += to.split("\n").length - from.split("\n").length;
    const at = text.indexOf(from);
    if (at === -1) {
      // Not in this read. Fine if no part of it is either: the edit was elsewhere in the file.
      const overlaps = from
        .split("\n")
        .map((l) => l.trim())
        .some((l) => l.length >= OVERLAP_LINE && text.includes(l));
      if (overlaps) return null;
      outside = true;
      continue;
    }
    if (text.indexOf(from, at + 1) !== -1) return null;
    text = text.slice(0, at) + to + text.slice(at + from.length);
  }
  data["content"] = text;
  if (typeof data["totalLines"] === "number") data["totalLines"] = (data["totalLines"] as number) + lineDelta;
  const note = outside
    ? "[Current: your later edits to this file are applied below, but some were outside these lines, so line numbers may have moved.]"
    : "[Current: your later edits to this file are applied below. This is the file as it is now.]";
  return `${note}\n${JSON.stringify(data)}`;
}

/** Terminal noise out, repeats folded. */
export function normalizeOutput(text: string): string {
  const cleaned = text
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, "")
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/\r\n/g, "\n")
    .replace(/[ \t]+$/gm, "");
  const lines = cleaned.split("\n");
  const out: string[] = [];
  for (let i = 0; i < lines.length; ) {
    let j = i + 1;
    while (j < lines.length && lines[j] === lines[i]) j++;
    const run = j - i;
    out.push(run >= 3 && lines[i]!.trim() ? `${lines[i]}  (×${run})` : lines.slice(i, j).join("\n"));
    i = j;
  }
  return out.join("\n");
}

/** Where a session's copy of a large output lives. Content-addressed: the same output, the same file. */
export function artifactPathFor(sessionId: string, tool: string, text: string): string {
  return `.soreqen/artifacts/${sessionId.replace(/[^\w.-]/g, "_")}/${tool}-${contentHash(text)}.txt`;
}

export interface GateStats {
  gated: number;
  staleReads: number;
  /** Reads brought up to date with the agent's own later edits. */
  patchedReads: number;
  normalizedChars: number;
  /** `text` is exactly what was hashed into `path`, so the file written is the file named. */
  artifacts: { path: string; tool: string; chars: number; text: string }[];
}

/**
 * The gateway's view of a history.
 *
 * Reads that a later successful write to the same file has overtaken get a
 * warning line; outputs over the threshold become digests with an artifact
 * reference. Everything else is returned untouched.
 */
export function gateHistory(messages: LLMMessage[], sessionId: string): { messages: LLMMessage[]; stats: GateStats } {
  const stats: GateStats = { gated: 0, staleReads: 0, patchedReads: 0, normalizedChars: 0, artifacts: [] };

  // Every call, and the index of its result, so writes can be ordered after reads.
  const calls = new Map<string, LLMToolCall>();
  for (const m of messages) for (const c of m.toolCalls ?? []) calls.set(c.id, c);
  const lastWrite = new Map<string, number>();
  /** Every successful write to a file, in order: what a read is brought up to date with. */
  const writesTo = new Map<string, { index: number; call: LLMToolCall; result: string }[]>();
  /** The step each message belongs to, and how many steps there are. */
  const stepAt: number[] = [];
  let steps = 0;
  messages.forEach((m, i) => {
    if (m.role === "assistant" && m.toolCalls?.length) steps++;
    stepAt[i] = steps;
    if (m.role !== "tool" || !m.toolCallId || typeof m.content !== "string") return;
    const call = calls.get(m.toolCallId);
    if (!call || !WRITES.has(call.name) || isFailure(m.content)) return;
    const path = typeof call.input["path"] === "string" ? normalisePath(call.input["path"] as string) : "";
    if (!path) return;
    lastWrite.set(path, i);
    writesTo.set(path, [...(writesTo.get(path) ?? []), { index: i, call, result: m.content }]);
  });

  const out = messages.map((m, i) => {
    if (m.role !== "tool" || !m.toolCallId || typeof m.content !== "string") return m;
    const call = calls.get(m.toolCallId);
    if (!call) return m;
    let content = m.content;

    // Not "[": a JSON array, a TOML table or an INI section starts with one too. Only the stubs are skipped.
    if (call.name === "read_file" && !content.startsWith("[Superseded") && !content.startsWith("[STALE: ")) {
      const path = typeof call.input["path"] === "string" ? normalisePath(call.input["path"] as string) : "";
      if (path && (lastWrite.get(path) ?? -1) > i) {
        const later = (writesTo.get(path) ?? []).filter((w) => w.index > i);
        const patched =
          steps - (stepAt[i] ?? 0) <= PATCH_RECENT_STEPS && later.every((w) => w.call.name === "edit_file")
            ? patchRead(content, later.map((w) => ({ input: w.call.input, result: w.result })))
            : null;
        if (patched) {
          content = patched;
          stats.patchedReads++;
        } else {
          content = `[STALE: ${path} was changed after this read — these contents are out of date. Read it again before editing from it.]\n${content}`;
          stats.staleReads++;
        }
      }
    }

    /*
     * A file read is not tool output like any other.
     *
     * The file *is* the full output, so a copy of it as an artifact is a
     * duplicate that goes stale the moment the file is edited — and pointing a
     * read at an artifact invites reading the artifact, whose output is large
     * again, digested again, into another artifact. So a whole-file read that
     * is very large is digested with a pointer back to the file, and a ranged
     * read is shown as it is: the agent already chose how much it wanted.
     */
    if (call.name === "read_file") {
      const ranged = call.input["start_line"] !== undefined || call.input["end_line"] !== undefined;
      if (!ranged && content.length > READ_THRESHOLD && !content.startsWith("[Superseded")) {
        const path = typeof call.input["path"] === "string" ? normalisePath(call.input["path"] as string) : "the file";
        const normalized = normalizeOutput(readable(content));
        const lines = normalized.split("\n").length;
        content = condense(
          normalized,
          DIGEST_CHARS,
          `read_file ${path} returned ${lines.toLocaleString()} lines; shown here shortened to its key lines. ` +
            `The file itself is the full output — read_file ${path} with start_line/end_line for the part you need`,
        );
        stats.gated++;
      }
    } else if (content.length > (documentLimit(call.name) ?? ARTIFACT_THRESHOLD) && !content.startsWith("[Superseded")) {
      const normalized = normalizeOutput(readable(content));
      stats.normalizedChars += Math.max(0, content.length - normalized.length);
      const artifact = artifactPathFor(sessionId, call.name, m.content);
      const lines = normalized.split("\n").length;
      content = condense(
        normalized,
        DIGEST_CHARS,
        `Output of ${call.name} (${lines.toLocaleString()} lines, ${m.content.length.toLocaleString()} chars) shortened to its key lines. ` +
          `The full output is saved at ${artifact} — read_file it with start_line/end_line for any part ` +
            `(open it with read_file, not a shell command: it may be kept outside the project)`,
      );
      stats.gated++;
      stats.artifacts.push({ path: artifact, tool: call.name, chars: m.content.length, text: m.content });
    }

    return content === m.content ? m : { ...m, content };
  });

  return { messages: out, stats };
}

/**
 * Write an artifact, once.
 *
 * The whole output, normalised — including anything the result renderer
 * clipped — so the reference in the digest leads somewhere complete.
 */
export async function storeArtifact(
  runner: SandboxRunner,
  workspaceId: string,
  path: string,
  text: string,
): Promise<boolean> {
  try {
    await runner.writeFile(workspaceId, path, normalizeOutput(text), true);
    return true;
  } catch {
    return false;
  }
}
