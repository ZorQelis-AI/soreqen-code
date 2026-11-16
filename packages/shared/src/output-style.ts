/**
 * Output styles: how the agent talks while it works.
 *
 * A style changes the *voice* of a turn, never its permissions or its effort.
 * The mode decides what the agent may do and the effort decides how hard it
 * works; the style decides how much it explains, how much it volunteers, and
 * how long its report is. Keeping those three separate is what lets someone
 * run Bypass at Apex effort and still ask for terse answers.
 *
 * Each style is a short block appended to the system prompt. They are written
 * as instructions about *behaviour a reader can see* — what to include, what
 * to leave out — because a style described in adjectives ("be friendly") is a
 * style no model follows consistently.
 */

import { z } from "zod";

export const OUTPUT_STYLES = ["default", "proactive", "concise", "explanatory", "learning"] as const;
export type OutputStyle = (typeof OUTPUT_STYLES)[number];
export const OutputStyleSchema = z.enum(OUTPUT_STYLES);

export interface OutputStyleSpec {
  id: OutputStyle;
  label: string;
  /** One line, shown under the label in a picker. */
  summary: string;
  /** Appended to the system prompt. Empty for the default. */
  instructions: string;
}

export const OUTPUT_STYLE: Record<OutputStyle, OutputStyleSpec> = {
  default: {
    id: "default",
    label: "Default",
    summary: "Brief progress notes and a structured report at the end.",
    instructions: "",
  },
  proactive: {
    id: "proactive",
    label: "Proactive",
    summary: "Takes initiative on the obvious follow-through, and says what it did.",
    instructions: [
      "Output style: PROACTIVE.",
      "- Carry the task through to the result the user evidently wants, not only the literal request:",
      "  add or update tests for what you build, fix a defect you discover in code you are already",
      "  changing, update documentation your change made wrong, and verify end to end without being asked.",
      "- Do not wait for permission on follow-through that is clearly inside the task's intent. Anything",
      "  that would expand the scope materially (a new feature, a refactor of unrelated code, a new",
      "  dependency) still belongs in your summary as a recommendation, not in the diff.",
      "- In your final report, add a short 'Also did' list for everything beyond the literal request.",
    ].join("\n"),
  },
  concise: {
    id: "concise",
    label: "Concise",
    summary: "As few words as possible. Short updates and a two-line summary.",
    instructions: [
      "Output style: CONCISE.",
      "- Keep progress notes to a short clause, or omit them when the tool call speaks for itself.",
      "- No preamble, no restating the task, no closing pleasantries.",
      "- Replace the report template with at most two or three lines: what changed and how it was verified.",
      "- Prefer a file path and a verb over a paragraph. Use lists only when there are several items.",
    ].join("\n"),
  },
  explanatory: {
    id: "explanatory",
    label: "Explanatory",
    summary: "Explains the reasoning behind choices and the patterns in the codebase.",
    instructions: [
      "Output style: EXPLANATORY.",
      "- While working, add brief insights that help the user understand the codebase and your choices:",
      "  why this approach over the alternatives, what convention the code follows, what a non-obvious",
      "  line is guarding against.",
      "- Format each as a short block starting with '**Insight:**' and two or three concise points.",
      "  Place them next to the work they explain, not all at the end.",
      "- Keep insights specific to this code. Generic programming advice is noise.",
    ].join("\n"),
  },
  learning: {
    id: "learning",
    label: "Learning",
    summary: "Teaches as it goes and leaves small, meaningful pieces for you to write.",
    instructions: [
      "Output style: LEARNING.",
      "- Act as a patient pair-programmer who wants the user to learn by doing.",
      "- Explain what you are about to do and why before significant steps, in plain language.",
      "- Do the routine and boilerplate work yourself. When there is a small, genuinely instructive",
      "  decision — a core algorithm, an error-handling policy, a data-structure choice of 2 to 10 lines —",
      "  leave exactly one clearly marked `TODO(human)` in the code with the surrounding structure in place,",
      "  and finish your message with a 'Your turn' section: the file, what to implement, and the",
      "  trade-offs to consider. Leave at most one such TODO per turn, and never one that stops the",
      "  project from building or running.",
      "- Add short '**Insight:**' notes about the codebase's patterns where they help understanding.",
    ].join("\n"),
  },
};

export const DEFAULT_OUTPUT_STYLE: OutputStyle = "default";

export function isOutputStyle(value: string): value is OutputStyle {
  return (OUTPUT_STYLES as readonly string[]).includes(value);
}

export function parseOutputStyle(raw: string): OutputStyle | null {
  const key = raw.trim().toLowerCase();
  return isOutputStyle(key) ? key : null;
}
