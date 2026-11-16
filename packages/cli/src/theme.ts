/**
 * How the CLI looks, decided in one place.
 *
 * ## Why this exists
 *
 * `ui.ts` carried six hardcoded hex values (`#DB7F14`, `#E9A23F`, `#A99C8D`,
 * `#FAF7F2`, `#332C25`, `#241E19`) scattered across a dozen call sites, while
 * `@sqcode/shared` already defined every one of them as a brand token. Two
 * copies of a palette drift, and the terminal is the copy nobody notices
 * drifting.
 *
 * ## Terminals are not browsers
 *
 * Three things a web palette can assume and a terminal cannot:
 *
 *   - **Colour may not exist.** `NO_COLOR` is set, output is piped to a file,
 *     or the terminal is 16-colour. Chalk handles the mechanics, but a design
 *     that *encodes meaning only in colour* becomes unreadable — so every
 *     state here is distinguishable by glyph and wording too.
 *   - **Width is unknown and changes.** A rule of `"─".repeat(60)` wraps into
 *     two ragged lines in an 80-column window with any indent, and looks lost
 *     in a 200-column one.
 *   - **Not every glyph renders.** Emoji in particular are double-width in
 *     some terminals and single in others, which silently breaks every aligned
 *     column after them. The set below is box-drawing and geometric shapes,
 *     which are far more widely supported, with an ASCII fallback for the rest.
 */

import chalk from "chalk";
import { tokens } from "@sqcode/shared";

const ui = tokens.ui;

/** True when the terminal can render the box-drawing and geometric glyphs
 *  below. Windows consoles outside Terminal.app-alikes historically cannot,
 *  and a row of `?` is worse than plain ASCII. */
const unicode =
  process.platform !== "win32" ||
  Boolean(process.env["WT_SESSION"]) ||
  process.env["TERM_PROGRAM"] === "vscode" ||
  process.env["TERM"] === "xterm-256color";

export const glyph = unicode
  ? {
      bar: "▌",
      dot: "·",
      arrow: "›",
      run: "▸",
      ok: "✓",
      fail: "✗",
      pending: "○",
      active: "◐",
      warn: "▲",
      stop: "■",
      rule: "─",
    }
  : {
      bar: "|",
      dot: "-",
      arrow: ">",
      run: ">",
      ok: "+",
      fail: "x",
      pending: "o",
      active: "*",
      warn: "!",
      stop: "#",
      rule: "-",
    };

/**
 * The working indicator. A terminal cannot draw the SoreQen mark, so it is
 * carried by its silhouette — a headline over a point, a downward triangle —
 * which forms and then turns a quarter at a time, in the brand colour. It
 * replaces a generic braille spinner that could have belonged to any tool.
 */
export const markFrames: readonly string[] = unicode
  ? ["▿", "▽", "▽", "◁", "◁", "△", "△", "▷", "▷", "▽"]
  : ["v", "V", "V", "<", "<", "^", "^", ">", ">", "V"];

export const c = {
  brand: chalk.hex(ui.accent),
  brandDim: chalk.hex(ui.accentHover),
  accent: chalk.hex(ui.accentGlow),
  text: chalk.hex(ui.text),
  muted: chalk.hex(ui.muted),
  faint: chalk.hex(ui.border),
  ok: chalk.hex(ui.accent),
  warn: chalk.yellow,
  danger: chalk.hex(ui.danger),
};

/** Usable width, clamped so the layout neither wraps in a narrow window nor
 *  stretches into an unreadable line in a very wide one. */
export function width(): number {
  const raw = process.stdout.columns ?? 80;
  return Math.max(40, Math.min(raw - 4, 96));
}

/** A hairline the width of the content area. */
export function rule(): string {
  return c.faint(glyph.rule.repeat(width()));
}

/**
 * Shorten to fit, keeping the end.
 *
 * The end, because these are mostly paths and commands: `…/src/auth/login.ts`
 * identifies a file, while `/Users/someone/very/long/…` identifies nobody.
 */
export function truncate(value: string, max: number): string {
  if (value.length <= max) return value;
  if (max <= 1) return value.slice(0, max);
  return "…" + value.slice(-(max - 1));
}

/**
 * How a mode should look.
 *
 * The mode is the line with the safety consequence now — it is what the person
 * actually selected, and the tier sits underneath it as a ceiling they usually
 * did not set. Colour follows the same logic as `tierStyle`: red is not a
 * warning that something is wrong, it is a reminder of what is switched on.
 *
 * Every mode is also distinguishable by its word alone, because a terminal
 * with `NO_COLOR` set, or output piped to a file, has no colour at all — and
 * "which mode am I in" is the last question that should require colour vision
 * or a working palette to answer.
 */
export function modeStyle(mode: string): { label: string; paint: (s: string) => string } {
  switch (mode) {
    case "plan":
      return { label: "plan", paint: (s) => c.accent(s) };
    case "manual":
      return { label: "manual", paint: (s) => c.text(s) };
    case "bypass":
      return { label: "bypass", paint: (s) => c.danger.bold(s) };
    case "auto":
    default:
      return { label: "auto", paint: (s) => c.brand(s) };
  }
}

/**
 * How an effort tier should look.
 *
 * Only Apex is coloured. The five platform tiers are ordinary settings and
 * highlighting all of them would make none of them stand out; Apex is the one
 * that costs materially more and the one a user should notice they left on.
 */
export function effortStyle(effort: string): { label: string; paint: (s: string) => string } {
  if (effort === "apex") return { label: "apex", paint: (s) => c.brandDim.bold(s) };
  return { label: effort, paint: (s) => c.muted(s) };
}

/**
 * How a permission tier should look.
 *
 * The tier is the workspace's ceiling rather than the user's selection, so it
 * is shown more quietly than the mode — but it keeps its colour coding,
 * because a session whose *ceiling* is full autonomy is worth noticing even
 * when the mode in force is narrower.
 */
export function tierStyle(tier: string): { label: string; paint: (s: string) => string } {
  switch (tier) {
    case "read_only":
      return { label: "read only", paint: (s) => c.muted(s) };
    case "propose_only":
      return { label: "propose only", paint: (s) => c.accent(s) };
    case "full_autonomy":
      return { label: "full autonomy", paint: (s) => c.danger.bold(s) };
    case "guarded_autonomy":
    default:
      return { label: "guarded autonomy", paint: (s) => c.brand(s) };
  }
}

/** `~` for the home directory, so the workspace line reads like a path a
 *  person recognises rather than a machine-specific absolute. */
export function prettyPath(absolute: string): string {
  const home = process.env["HOME"] ?? process.env["USERPROFILE"] ?? "";
  const normalised = absolute.replace(/\\/g, "/");
  const homeNorm = home.replace(/\\/g, "/");
  if (homeNorm && normalised.startsWith(homeNorm)) {
    return "~" + normalised.slice(homeNorm.length);
  }
  return normalised;
}
