/**
 * A read or a command repeated with the same result, said in the result.
 *
 * 30 Oct 2026: on a long turn MiMo read the same lines of factory.js three
 * times and state.js twice, and ran one listing twice, each time as if it were
 * new — its reasoning re-planned from the working set every step and lost that
 * it had already looked. The turn's read cache could not answer the repeats,
 * because every write in between empties it.
 *
 * The output is still given whole: the earlier copy may have been condensed out
 * of view since, and a repeat that came back empty would be a worse loop. The
 * note is what tells the model that it is going round.
 */

/** What a result has to have for its repeat to be recognised. */
interface Observed {
  success: boolean;
  data?: unknown;
}

export class RepeatNotes {
  private readonly seen = new Map<string, string>();

  /** The note for a result that repeats one from earlier this turn, or null. Remembers it either way. */
  note(tool: string, input: Record<string, unknown>, result: Observed): string | null {
    if (!result.success) return null;
    const key = keyOf(tool, input);
    const value = key ? valueOf(tool, result.data) : null;
    if (!key || value === null) return null;
    const before = this.seen.get(key);
    this.seen.set(key, value);
    if (before !== value) return null;
    return tool === "read_file"
      ? "You already read these same lines earlier in this turn, and they have not changed since. Go on from where you were instead of reading them again."
      : "You already ran this command earlier in this turn, and it printed the same. Go on from where you were instead of running it again.";
  }
}

/** What was asked: a file and its range, or a command's text. Null for anything else. */
function keyOf(tool: string, input: Record<string, unknown>): string | null {
  if (tool === "read_file") {
    const path = input["path"];
    return typeof path === "string" ? ["read", path, input["start_line"] ?? "", input["end_line"] ?? ""].join("\u0000") : null;
  }
  if (tool === "run_command") {
    const command = input["command"];
    return typeof command === "string" ? `run\u0000${command.trim()}` : null;
  }
  return null;
}

/** What came back, without what differs every time (a process id, how long it took). */
function valueOf(tool: string, data: unknown): string | null {
  if (!data || typeof data !== "object") return null;
  const d = data as Record<string, unknown>;
  if (tool === "read_file") return typeof d["content"] === "string" ? d["content"] : null;
  // A command still running has not said everything yet.
  if (d["status"] === "running" || typeof d["output"] !== "string") return null;
  return JSON.stringify([d["exit_code"] ?? null, d["output"]]);
}
