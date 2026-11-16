/**
 * The agent's answer, rendered for a terminal.
 *
 * ## What was wrong
 *
 * The previous renderer badged headings with `▶` and `◆`, boxed code in a
 * fixed 54-column frame, painted inline code with a background colour, and put
 * an emoji in front of images. Each was decoration standing in for typography.
 *
 * But the real problem was simpler and worse: **it never wrapped.** A
 * paragraph ran to whatever length the model produced and the terminal broke
 * it mid-word at the window edge, with no left margin, so the second line
 * started hard against column zero. Long answers — which is most useful
 * answers — arrived as a wall. No amount of colour fixes that.
 *
 * ## The approach
 *
 * Wrap to the window with a consistent left margin, and use weight, colour and
 * space to carry structure instead of glyphs. Terminals give you very few
 * typographic tools; the ones they do give — bold, one accent colour, vertical
 * rhythm, and indentation — go a long way when nothing competes with them.
 *
 * Wrapping happens *after* styling and is ANSI-aware, because an escape
 * sequence occupies no columns: measuring the styled string naively counts
 * roughly eleven invisible characters per styled span and wraps far too early.
 */

import { c, glyph, width } from "./theme.js";

// Colour codes, and the OSC 8 wrapper that makes a link clickable: neither takes a column.
const ANSI = /\x1b\[[0-9;]*m|\x1b\]8;;[^\x1b]*\x1b\\/g;

/** Columns a styled string actually occupies. */
function visibleLength(text: string): number {
  return text.replace(ANSI, "").length;
}

/**
 * Word-wrap a styled string, preserving escape sequences.
 *
 * Words longer than the line — a URL, a long path — are left to overflow
 * rather than being broken. A hard-split identifier cannot be copied,
 * double-clicked or searched for, which costs more than the ragged edge.
 */
function wrap(text: string, max: number, hangingIndent = ""): string[] {
  if (visibleLength(text) <= max) return [text];

  const words = text.split(" ");
  const lines: string[] = [];
  let current = "";
  let indent = "";

  for (const word of words) {
    const candidate = current ? `${current} ${word}` : `${indent}${word}`;
    if (visibleLength(candidate) > max && current) {
      lines.push(current);
      indent = hangingIndent;
      current = `${indent}${word}`;
    } else {
      current = candidate;
    }
  }
  if (current) lines.push(current);
  return lines;
}

const MARGIN = "  ";

export function formatTerminalMarkdown(content: string): string {
  if (!content) return "";

  const w = width();
  const lines = content.split(/\r?\n/);
  const out: string[] = [];

  let inCode = false;
  let codeLang = "";
  let codeLines: string[] = [];

  const flushCode = (): void => {
    /*
     * A left gutter, not a box.
     *
     * A drawn frame has to pick a width, and any width is wrong for some
     * window or some line of code — the old 54-column box wrapped raggedly on
     * anything longer. A gutter marks the block just as clearly, costs two
     * columns, and never disagrees with the content.
     */
    if (codeLang) out.push(`${MARGIN}${c.faint(codeLang.toLowerCase())}`);
    for (const line of codeLines) {
      out.push(`${MARGIN}${c.faint(glyph.bar)} ${c.text(line)}`);
    }
    out.push("");
    codeLines = [];
    codeLang = "";
  };

  for (const raw of lines) {
    if (raw.trim().startsWith("```")) {
      if (inCode) {
        inCode = false;
        flushCode();
      } else {
        inCode = true;
        codeLang = raw.trim().replace(/^```/, "").trim();
      }
      continue;
    }

    if (inCode) {
      codeLines.push(raw);
      continue;
    }

    // Horizontal rule
    if (/^\s*([-*_])\1{2,}\s*$/.test(raw)) {
      out.push(`${MARGIN}${c.faint(glyph.rule.repeat(Math.max(0, w - 2)))}`);
      continue;
    }

    // Headings: weight and space, no badges. A heading in a terminal is
    // recognised by the blank line above it as much as by its colour.
    const heading = raw.match(/^(#{1,4})\s+(.*)$/);
    if (heading) {
      const level = heading[1]!.length;
      const text = heading[2]!;
      out.push("");
      out.push(
        level === 1
          ? `${MARGIN}${c.brand.bold(text.toUpperCase())}`
          : level === 2
            ? `${MARGIN}${c.text.bold(text)}`
            : `${MARGIN}${c.accent(text)}`,
      );
      out.push("");
      continue;
    }

    // Blockquote
    if (raw.startsWith("> ")) {
      for (const line of wrap(inline(raw.slice(2)), w - 4, "  ")) {
        out.push(`${MARGIN}${c.brand(glyph.bar)} ${c.muted(line)}`);
      }
      continue;
    }

    // Numbered list — the marker is aligned and the wrapped text hangs under
    // the text, not under the number, which is what makes a list scannable.
    const numbered = raw.match(/^(\s*)(\d+)\.\s+(.*)$/);
    if (numbered) {
      const pad = numbered[1] ?? "";
      const marker = `${numbered[2]}.`;
      const body = inline(numbered[3] ?? "");
      const lead = `${MARGIN}${pad}${c.brand(marker)} `;
      const hanging = " ".repeat(marker.length + 1);
      const wrapped = wrap(body, w - visibleLength(lead), hanging);
      out.push(`${lead}${wrapped[0] ?? ""}`);
      for (const rest of wrapped.slice(1)) out.push(`${MARGIN}${pad}${rest}`);
      continue;
    }

    // Bullet list
    const bullet = raw.match(/^(\s*)[-*+]\s+(.*)$/);
    if (bullet) {
      const pad = bullet[1] ?? "";
      const body = inline(bullet[2] ?? "");
      const lead = `${MARGIN}${pad}${c.brand(glyph.dot)} `;
      const wrapped = wrap(body, w - visibleLength(lead), "  ");
      out.push(`${lead}${wrapped[0] ?? ""}`);
      for (const rest of wrapped.slice(1)) out.push(`${MARGIN}${pad}  ${rest}`);
      continue;
    }

    if (!raw.trim()) {
      out.push("");
      continue;
    }

    for (const line of wrap(inline(raw), w - 2)) out.push(`${MARGIN}${line}`);
  }

  if (inCode && codeLines.length > 0) flushCode();

  // Collapse runs of blank lines. Markdown from a model is inconsistently
  // spaced, and the rhythm should come from this renderer rather than from
  // however many newlines happened to be generated.
  return out
    .filter((line, i) => !(line === "" && out[i - 1] === ""))
    .join("\n")
    // Trim the edges. Leading and trailing blank lines are an artefact of how
    // the model happened to space its markdown; the gap between the answer and
    // whatever follows it is the caller's decision, not the content's.
    .replace(/^\n+/, "")
    .replace(/\n+$/, "");
}

/** Stands in for a code span while the other inline rules run: a character no model writes. */
const CODE_MARK = String.fromCharCode(0);
const CODE_SLOT = new RegExp(`${CODE_MARK}(\\d+)${CODE_MARK}`, "g");

function inline(text: string): string {
  /*
   * Code spans first, and out of reach of every other rule.
   *
   * They were styled last, so the bold rule had already been through them:
   * `mcp__github__create_issue` in backticks came out as "mcpgithubcreate_issue"
   * with "github" in bold — the one place a name is quoted so that it will be
   * read exactly.
   */
  const codes: string[] = [];
  let res = text.replace(/`([^`]+)`/g, (_m, t: string) =>
    // A code span that is only an address is a link, however it was quoted.
    BARE_URL.test(t.trim()) ? `${CODE_MARK}${codes.push(link(t.trim(), t.trim())) - 1}${CODE_MARK}` : `${CODE_MARK}${codes.push(c.accent(t)) - 1}${CODE_MARK}`,
  );

  // Images: named, not badged. There is nothing to show in a terminal, so the
  // useful thing is the alt text and the location.
  res = res.replace(/!\[([^\]]*)\]\(([^)]+)\)/g, (_m, alt: string, url: string) =>
    `${c.muted(`[image: ${alt || "untitled"}]`)} ${c.faint(url)}`,
  );

  // Links: the label carries the meaning, the URL is available but recessive.
  res = res.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_m, label: string, url: string) =>
    `${CODE_MARK}${codes.push(`${link(label, url)} ${c.faint(url)}`) - 1}${CODE_MARK}`,
  );
  // An address on its own: coloured, and clickable where the terminal can.
  res = res.replace(/https?:\/\/[^\s<>`"'\x00]*[^\s<>`"'.,;:!?)\]\x00]/g, (url) => `${CODE_MARK}${codes.push(link(url, url)) - 1}${CODE_MARK}`);

  res = res.replace(/\*\*(.+?)\*\*/g, (_m, t: string) => c.text.bold(t));
  // Underscores make bold only at word edges, as CommonMark has it: inside a
  // word (`snake__case`, `mcp__server__tool`) they are just underscores.
  res = res.replace(/(^|[^\p{L}\p{N}_])__(?!\s)(.+?)(?<!\s)__(?![\p{L}\p{N}_])/gu, (_m, pre: string, t: string) => `${pre}${c.text.bold(t)}`);
  res = res.replace(/(^|[^*])\*([^*\n]+)\*/g, (_m, pre: string, t: string) => `${pre}${c.text.italic(t)}`);

  /*
   * Inline code gets colour, not a background.
   *
   * The previous renderer painted it with `bgHex("#242220")`, which assumes a
   * dark terminal — on a light theme it is a dark smear, and on any theme the
   * padding spaces inside the highlight make the code look like it contains
   * leading and trailing whitespace when copied.
   */
  res = res.replace(CODE_SLOT, (_m, i: string) => codes[Number(i)]!);

  return res;
}

const BARE_URL = /^https?:\/\/[^\s<>`"']+$/;

/*
 * A link, as terminals that support it show one: OSC 8 makes the text itself
 * clickable (Windows Terminal, iTerm2, VS Code, GNOME Terminal and most
 * others); elsewhere it is plain coloured text, which most terminals still
 * open on ctrl+click when it is an address.
 */
const HYPERLINKS = Boolean(process.stdout.isTTY) && !process.env["NO_COLOR"] && process.env["TERM"] !== "dumb";

function link(label: string, url: string): string {
  const shown = c.brand.underline(label);
  return HYPERLINKS && /^https?:\/\//i.test(url) ? `\x1b]8;;${url}\x1b\\${shown}\x1b]8;;\x1b\\` : shown;
}
