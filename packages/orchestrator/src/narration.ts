/**
 * Noticing a model that writes a line before every call.
 *
 * Seen 15 Oct 2026 in a session that built and trained a small model: of its
 * ninety steps, nearly every one opened with a sentence saying what the next
 * call would do ("Re-running the self-tests to confirm the charset fix.",
 * "Checking its progress now."). Each call is already a row that says what it
 * does, so the conversation read as a running commentary on itself, and the
 * person asked for fewer, better lines.
 *
 * The prompt asks for quiet work and some models narrate regardless. So a run
 * of steps that each carried text is noticed, and the model is told once in
 * the turn. A step with calls and no text ends the run: that is the quiet the
 * prompt asks for. Text is never removed; the model is only told.
 */

/** Steps in a row, each with calls and a line of text, before the model is told. */
export const NARRATED_AT = 5;

export const NARRATION_TELL =
  "A note on how you are working: you have written a line before each of your last few calls. The person sees " +
  "every call as a row that already says what it does, so those lines repeat the rows and make the work read as " +
  "noise. From here, make your calls without text unless you have something the rows cannot show: a finding that " +
  "changes the plan, a decision between real options, or a problem. Your final answer is not affected: write it in full.";

export class NarrationWatch {
  private run = 0;
  private told = false;

  /** One step that made calls. Returns the reminder, once per turn, when enough steps in a row narrated. */
  observe(text: string, calls: number): string | null {
    if (calls === 0) return null;
    if (!text.trim()) {
      this.run = 0;
      return null;
    }
    this.run++;
    if (this.run < NARRATED_AT || this.told) return null;
    this.told = true;
    return NARRATION_TELL;
  }
}
