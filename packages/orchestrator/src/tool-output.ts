/**
 * Tool output, shaped before it is cut.
 *
 * ## The bug this was written to fix
 *
 * A mail connector's `messages_text` returned an email as the HTTP response it
 * came in: a status, a dozen response headers, then the message twice, once
 * as text and once as HTML, both padded with the invisible characters mail
 * tools use to pad a preview line (U+034F, U+200B, U+2007, U+00AD, hundreds of
 * each). Two short replies from one sender came to 34,000 and 54,000
 * characters that way. The 24,000-character cut kept the head and the tail
 * and replaced the middle, where the reply was, with "characters omitted"
 * (reported 23 Oct 2026: "every one came back truncated"). The full copy was
 * saved, but as one line of JSON, so reading it a range of lines at a time
 * returned the same giant line.
 *
 * ## What it does now
 *
 *   distilled   JSON as indented `key: value` lines; an HTTP envelope's
 *               headers dropped; an HTML copy dropped when a text copy sits
 *               beside it, otherwise turned into text; invisible padding out;
 *               base64 blobs named by size; every line at most 2,000
 *               characters, so a ranged read always moves forward
 *   paged       a document still over its limit is shown from the top, with
 *               the exact `read_file` call that continues it; the whole
 *               distilled text is saved where that call points
 *   clipped     a log (a command, a browser step) keeps its head and tail as
 *               before, but the copy saved for it is the distilled text
 *
 * An output under its limit is left exactly as it was, except an app's (an
 * MCP connector's), which is always distilled: its envelope is noise at any
 * size, and the model reads every token of it on every step.
 */

import type { ToolResult } from "@sqcode/tools";
import { artifactPathFor } from "./context/tool-gateway.js";
import { MAX_RESULT_CHARS, clipResult, documentLimit, formatToolResult, readFileLimit } from "./tool-result.js";

/** Longest line in a distilled output; see the module comment. */
const LINE_MAX = 2_000;
/** Past this, an output is only clipped: distilling 40 MB of log is not worth the time. */
const DISTILL_MAX = 4_000_000;
/** A string this long is shown as a block under its key, not on the key's line. */
const INLINE_MAX = 160;

/** Characters that take no space: mail preview padding, soft hyphens, joiners. */
const INVISIBLE = /[\u034f\u200b-\u200f\u2028\u2029\u2060-\u2064\ufeff\u00ad\u180e]/g;
/** Spaces that are not U+0020. */
const ODD_SPACE = /[\u00a0\u2000-\u200a\u202f\u205f\u3000]/g;

/** What a tool's result becomes for the model. */
export interface ShapedOutput {
  /** What the model is given (and the transcript keeps). */
  content: string;
  /** The whole output, distilled, when `content` is only part of it. */
  full?: string;
  /** Where `full` is saved, when `content` names the place (a paged document). */
  artifact?: string;
}

/**
 * Shape one tool result for the model; see the module comment.
 */
export function shapeToolOutput(
  tool: string,
  result: ToolResult,
  options: {
    sessionId: string;
    /** The model's window, which sets how much of a file one read returns; see `readFileLimit`. */
    windowTokens?: number;
    /** The call's own input: where a ranged read started. */
    input?: Record<string, unknown>;
  },
): ShapedOutput {
  result = withoutEchoes(tool, result, options.input);
  if (tool === "read_file" && result.success) {
    const paged = shapeRead(result, readFileLimit(options.windowTokens), options.input);
    if (paged) return paged;
  }
  if ((tool === "write_file" || tool === "edit_file") && result.success) {
    const compact = compactChange(tool, result, options.input);
    if (compact) return { content: formatToolResult(compact, { clip: false }) };
  }
  if (tool === "update_todo_list" && result.success) {
    const progress = planProgress(result.data);
    if (progress) return { content: formatToolResult({ ...result, data: progress }, { clip: false }) };
  }
  if (tool === "list_directory" && result.success) {
    const listing = listingText(result.data);
    if (listing !== null) return { content: clipResult(listing, MAX_RESULT_CHARS) };
  }
  if (tool === "glob" && result.success) {
    const found = globText(result.data);
    if (found !== null) return { content: clipResult(found, MAX_RESULT_CHARS) };
  }
  const docLimit = documentLimit(tool);
  const limit = docLimit ?? MAX_RESULT_CHARS;
  const plain = formatToolResult(result, { clip: false, ...(docLimit ? { limit: docLimit } : {}) });
  const app = tool.startsWith("mcp__");

  if (plain.length <= limit && !app) return { content: plain };
  if (tool === "browser_batch") {
    const fitted = fitBrowserBatch(result, limit);
    if (fitted) return { content: fitted, full: distillOutput(plain) };
  }
  if (plain.length > DISTILL_MAX) return { content: clipResult(plain, limit), full: plain };

  const shaped = distillOutput(plain);
  if (shaped.length <= limit) return { content: shaped };

  if (docLimit !== undefined) {
    const artifact = artifactPathFor(options.sessionId, tool, shaped);
    return { content: firstPage(shaped, limit, artifact), full: shaped, artifact };
  }
  return { content: clipResult(shaped, limit), full: shaped };
}

/**
 * A browser batch over its limit, still as its steps.
 *
 * Its size is nearly always one step's console logs or the page text at the
 * end, and distilling the whole result to an outline turned the steps into
 * prose: the transcript could no longer find the screenshot a step saved, and
 * showed the outline where the picture should be (1 Nov 2026). So only the
 * long values shrink, logs to their latest lines and page text to its top,
 * each saying how much it left out, until the steps fit. Null when even that
 * does not fit, and the general path takes it.
 */
export function fitBrowserBatch(result: ToolResult, limit: number): string | null {
  const data = result.data as Record<string, unknown> | null | undefined;
  if (!data || typeof data !== "object" || !Array.isArray(data["steps"])) return null;
  for (let room = 6_000; room >= 250; room = Math.floor(room / 2)) {
    const steps = (data["steps"] as unknown[]).map((step) =>
      step && typeof step === "object"
        ? Object.fromEntries(Object.entries(step as Record<string, unknown>).map(([k, v]) => [k, shrink(v, room, k === "logs" || k === "page_events" ? "tail" : "head")]))
        : step,
    );
    const page = data["page_now"] === undefined ? {} : { page_now: shrink(data["page_now"], room * 2, "head") };
    const text = formatToolResult({ ...result, data: { ...data, steps, ...page } }, { clip: false });
    if (text.length <= limit) return text;
  }
  return null;
}

/** A value cut to about `room` characters: a string or a list of lines, from the end that matters. */
function shrink(value: unknown, room: number, keep: "head" | "tail"): unknown {
  if (typeof value === "string") {
    if (value.length <= room) return value;
    const left = value.length - room;
    return keep === "tail"
      ? `[… ${left.toLocaleString()} earlier characters left out]\n${value.slice(-room)}`
      : `${value.slice(0, room)}\n[… ${left.toLocaleString()} more characters left out]`;
  }
  if (Array.isArray(value)) {
    if (JSON.stringify(value).length <= room) return value;
    const items = [...value];
    const kept: unknown[] = [];
    let used = 0;
    while (items.length > 0) {
      const next = keep === "tail" ? items[items.length - 1] : items[0];
      const size = JSON.stringify(next).length;
      if (kept.length > 0 && used + size > room) break;
      used += size;
      if (keep === "tail") kept.unshift(shrink(items.pop(), room, keep));
      else kept.push(shrink(items.shift(), room, keep));
    }
    if (items.length === 0) return kept;
    const note = `[… ${items.length.toLocaleString()} ${keep === "tail" ? "earlier" : "more"} entr${items.length === 1 ? "y" : "ies"} left out]`;
    return keep === "tail" ? [note, ...kept] : [...kept, note];
  }
  return value;
}

/**
 * A file read, whole or as its next page; never an outline, never head and tail.
 *
 * The file's own lines, in the shape read_file returns (`path`, `content`, and
 * `startLine` when it does not start at 1), so the transcript shows it as code.
 * Past `limit` it stops at a whole line and says which line comes next: the
 * agent reads on from there and every line is seen once. Null for a result
 * that is not a read's (left to the general path).
 */
export function shapeRead(result: ToolResult, limit: number, input?: Record<string, unknown>): ShapedOutput | null {
  const data = result.data as { path?: unknown; content?: unknown; totalLines?: unknown; repeat?: unknown } | null | undefined;
  if (!data || typeof data !== "object" || typeof data.content !== "string") return null;
  const whole = formatToolResult(result, { clip: false });
  if (whole.length <= limit) return { content: whole };

  const lines = data.content.split("\n");
  const asked = typeof input?.["start_line"] === "number" ? Math.max(1, Math.floor(input["start_line"] as number)) : 1;
  const total = typeof data.totalLines === "number" ? data.totalLines : asked + lines.length - 1;
  // Room for the envelope and the note. A line costs what it will as JSON: its escaped text and the
  // escaped break after it, which is exactly the length of the line stringified (two quotes, or `\n`).
  const budget = Math.max(1_000, limit - 900);
  let used = 0;
  let shown = 0;
  while (shown < lines.length) {
    const size = JSON.stringify(lines[shown]).length;
    if (shown > 0 && used + size > budget) break;
    used += size;
    shown++;
  }
  // One line longer than the whole page (a minified bundle) is still one line: it is cut, and said to be.
  const cutLine = shown === 1 && used > budget;
  const pageFor = (count: number) => {
    const end = asked + count - 1;
    const next = end + 1;
    const content = lines.slice(0, count).join("\n");
    return JSON.stringify({
      path: data.path,
      content: cutLine ? content.slice(0, budget) : content,
      startLine: asked,
      endLine: end,
      totalLines: total,
      note: cutLine
        ? `Line ${asked} alone is longer than one read returns (${lines[0]!.length.toLocaleString()} characters); it was cut at ${budget.toLocaleString()}. ` +
          "Search inside it with grep_search, or read it in pieces with run_command."
        : `Lines ${asked}-${end} of ${total.toLocaleString()}: the file is longer than one read returns, and nothing above line ${next} was left out. ` +
          `Read on with read_file start_line ${next} until line ${total.toLocaleString()}.`,
      // See `RepeatNotes`.
      ...(typeof data.repeat === "string" ? { repeat: data.repeat } : {}),
    });
  };
  let page = pageFor(shown);
  // Measured, not trusted: a path or a note longer than allowed for gives back its lines.
  while (page.length > limit && shown > 1) page = pageFor(--shown);
  // No saved copy: the file itself is the whole output, and the note says where to read on.
  return { content: page };
}

/**
 * A document's first page: whole lines up to the limit, then where the rest is.
 *
 * Head, not head and tail: a document is read from the top, and its middle is
 * as likely to matter as its end. The note gives the exact next call, because
 * "the full output is saved" without a line to start from sent the agent back
 * to line 1.
 */
export function firstPage(text: string, limit: number, artifact: string): string {
  const lines = text.split("\n");
  const budget = Math.max(1_000, limit - 500);
  let used = 0;
  let shown = 0;
  while (shown < lines.length && used + lines[shown]!.length + 1 <= budget) {
    used += lines[shown]!.length + 1;
    shown++;
  }
  shown = Math.max(1, shown);
  const page = lines.slice(0, shown).join("\n");
  return (
    `${page}\n\n[Showing lines 1-${shown} of ${lines.length.toLocaleString()} ` +
    `(${page.length.toLocaleString()} of ${text.length.toLocaleString()} characters). The whole output is saved at ` +
    `${artifact}: read_file it with start_line ${shown + 1} to continue. Use read_file, not a shell command: ` +
    `it may be kept outside the project.]`
  );
}

/**
 * Any tool output, as clean lines.
 *
 * Keeps the `WARNING:` and `FAILED:` lines `formatToolResult` puts at the top,
 * and distils what follows: JSON (including JSON that arrived as a string, as
 * an MCP server's text content usually does) becomes an outline, HTML becomes
 * text, and everything loses its invisible padding.
 */
export function distillOutput(text: string): string {
  const head = /^(?:(?:WARNING|FAILED): [^\n]*\n+)*/.exec(text)?.[0] ?? "";
  const body = text.slice(head.length);
  const trimmed = body.trim();
  let out: string;
  const parsed = trimmed.startsWith("{") || trimmed.startsWith("[") ? parseJson(trimmed) : undefined;
  if (parsed !== undefined && parsed !== null && typeof parsed === "object") {
    const lines: string[] = [];
    outline(parsed, "", lines);
    out = lines.join("\n");
  } else {
    out = looksLikeRawMail(body) ? rawMailText(body) : looksLikeHtml(body) ? htmlToText(body) : cleanText(body);
  }
  return `${head}${wrapLines(squeezeBlankLines(out))}`.trimEnd();
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

/** Keys that hold an HTML copy of a message, and keys that hold its text copy. */
const HTML_KEY = /^(?:html|body_?html|html_?body|html_?content|content_?html)$/i;
const TEXT_KEY = /^(?:text|plain|plain_?text|body_?text|text_?body|text_?content|content_?text|content|body|snippet|markdown)$/i;

/**
 * A JSON value as indented lines.
 *
 * `key: value` for short values, `key:` and the text below it for long ones,
 * `[n]` for each item of a list of objects. Empty values are left out.
 */
function outline(value: unknown, indent: string, out: string[], key?: string): void {
  const label = key === undefined ? "" : `${indent}${key}:`;
  const deeper = key === undefined ? indent : `${indent}  `;

  if (value === null || value === undefined || value === "") return;
  if (typeof value === "string") {
    const nested = value.trim().startsWith("{") || value.trim().startsWith("[") ? parseJson(value.trim()) : undefined;
    if (nested !== undefined && nested !== null && typeof nested === "object") {
      if (label) out.push(label);
      outline(nested, deeper, out);
      return;
    }
    const text = stringValue(value);
    if (!text) return;
    if (text.length <= INLINE_MAX && !text.includes("\n")) {
      out.push(label ? `${label} ${text}` : `${indent}${text}`);
      return;
    }
    if (label) out.push(label);
    for (const line of text.split("\n")) out.push(line ? `${deeper}${line}` : "");
    return;
  }
  if (typeof value !== "object") {
    out.push(label ? `${label} ${String(value)}` : `${indent}${String(value)}`);
    return;
  }

  if (Array.isArray(value)) {
    const items = value.filter((v) => v !== null && v !== undefined && v !== "");
    if (items.length === 0) return;
    if (items.every((v) => typeof v !== "object")) {
      const joined = items.map((v) => stringValue(String(v))).join(", ");
      if (joined.length <= INLINE_MAX) {
        out.push(label ? `${label} ${joined}` : `${indent}${joined}`);
        return;
      }
      if (label) out.push(label);
      for (const v of items) out.push(`${deeper}- ${stringValue(String(v)).replace(/\n/g, `\n${deeper}  `)}`);
      return;
    }
    if (label) out.push(label);
    items.forEach((item, i) => {
      out.push(`${deeper}[${i + 1}]`);
      outline(item, `${deeper}  `, out);
    });
    return;
  }

  const entries = Object.entries(value as Record<string, unknown>);
  // An HTTP response wrapped as data: the status is worth a line, the headers are not.
  const envelope =
    entries.some(([k, v]) => k === "status" && typeof v === "number") &&
    entries.some(([k, v]) => k === "headers" && v !== null && typeof v === "object") &&
    entries.some(([k]) => k === "body" || k === "data");
  const textCopy = entries.some(([k, v]) => TEXT_KEY.test(k) && typeof v === "string" && stringValue(v).length >= 40);
  if (label) out.push(label);
  for (const [k, v] of entries) {
    if (envelope && k === "headers") continue;
    if (HTML_KEY.test(k) && typeof v === "string" && textCopy) {
      out.push(`${deeper}${k}: [HTML copy left out: the text copy has the same message]`);
      continue;
    }
    outline(v, deeper, out, k);
  }
}

/** A string value, readable: HTML as text, base64 named by size, padding out. */
function stringValue(value: string): string {
  if (isBase64(value)) {
    return `[binary data, ${Math.round((value.replace(/\s+/g, "").length * 3) / 4 / 1024).toLocaleString()} KB]`;
  }
  const withoutData = value.replace(
    /data:([\w.+-]+\/[\w.+-]+);base64,[A-Za-z0-9+/=]{200,}/g,
    (match, type: string) => `[${type} data, ${Math.round((match.length * 3) / 4 / 1024).toLocaleString()} KB]`,
  );
  if (looksLikeRawMail(withoutData)) return rawMailText(withoutData);
  return looksLikeHtml(withoutData) ? htmlToText(withoutData) : cleanText(withoutData);
}

/** Whether a string is a raw RFC 822 message (a mail tool's "source"). */
export function looksLikeRawMail(text: string): boolean {
  const head = text.slice(0, 6_000);
  return (head.match(/^(?:Return-Path|Received|DKIM-Signature|ARC-Seal|MIME-Version|Message-ID|Delivered-To):/gim) ?? []).length >= 3;
}

/** Header fields a reader of the message needs; the rest is transport. */
const MAIL_HEADERS_KEPT = /^(?:from|to|cc|bcc|reply-to|subject|date|content-type|content-transfer-encoding|content-disposition)$/i;

/**
 * A raw message as its reader would see it.
 *
 * In one 39,000-character source (20 Oct 2026), 26,000 were base64 parts and
 * most of the rest was Received, ARC and DKIM headers. This keeps the
 * headers a person reads (From, To, Subject, Date) and each part's type,
 * decodes quoted-printable, names base64 blocks by size, and leaves out an
 * HTML part when a plain-text part says the same.
 */
export function rawMailText(raw: string): string {
  let text = raw.replace(/\r\n?/g, "\n");
  if (/content-transfer-encoding:\s*quoted-printable/i.test(text)) text = decodeQuotedPrintable(text);

  // Transport headers out, with their continuation lines.
  const kept: string[] = [];
  let dropped = 0;
  let dropping = false;
  let inHeaders = true;
  for (const line of text.split("\n")) {
    if (line === "") inHeaders = false;
    if (/^--[\w'()+_,./:=?-]{6,}(?:--)?$/.test(line)) inHeaders = true;
    const field = inHeaders ? /^([A-Za-z][\w-]*):/.exec(line) : null;
    if (field) {
      dropping = !MAIL_HEADERS_KEPT.test(field[1]!);
      if (dropping) dropped++;
    } else if (!(inHeaders && dropping && /^[ \t]/.test(line))) {
      dropping = false;
    }
    if (!dropping) kept.push(line);
  }

  // Each part: text decoded, an HTML copy of a plain-text part left out,
  // anything else (an attachment, an image) named by type and size.
  const parts = kept.join("\n").split(/^(?=--[\w'()+_,./:=?-]{6,}(?:--)?$)/m);
  const hasPlain = parts.some((p) => /content-type:\s*text\/plain/i.test(p));
  const shown = parts.map((part) => {
    const split = part.indexOf("\n\n");
    if (split === -1) return part;
    const head = part.slice(0, split);
    let body = part.slice(split + 2);
    const type = /content-type:\s*([\w.+-]+\/[\w.+-]+)/i.exec(head)?.[1]?.toLowerCase() ?? "";
    const base64 = /content-transfer-encoding:\s*base64/i.test(head);
    if (base64 && type.startsWith("text/")) {
      body = Buffer.from(body.replace(/\s+/g, ""), "base64").toString("utf8");
    } else if (base64) {
      const name = /(?:file)?name\*?="?([^";\n]+)"?/i.exec(head)?.[1];
      const kb = Math.max(1, Math.round((body.replace(/\s+/g, "").length * 3) / 4 / 1024));
      return `${head}\n\n[${type || "binary"} ${name ? `'${name}', ` : ""}${kb.toLocaleString()} KB, not shown]\n`;
    }
    if (type === "text/html") {
      body = hasPlain ? "[HTML part left out: the plain-text part has the same message]" : htmlToText(body);
    }
    return `${head}\n\n${body.trimEnd()}\n`;
  });
  const note = dropped > 0 ? `[${dropped} transport header${dropped === 1 ? "" : "s"} left out: Received, ARC, DKIM and the like]\n` : "";
  return note + cleanText(shown.join("\n"));
}

/** Quoted-printable decoded: soft line breaks joined, `=XX` bytes read as UTF-8. */
function decodeQuotedPrintable(text: string): string {
  return text.replace(/=\n/g, "").replace(/(?:=[0-9A-F]{2})+/g, (run) => {
    const bytes = Uint8Array.from(run.slice(1).split("=").map((h) => parseInt(h, 16)));
    return new TextDecoder("utf-8", { fatal: false }).decode(bytes);
  });
}

/**
 * Whether a string is base64: one unbroken run, or lines of one length
 * (MIME wraps at 76). Not merely "letters and digits once the newlines are
 * gone": a log of `step 1 ok` lines without spaces passes that test.
 */
function isBase64(value: string): boolean {
  if (value.length < 1_000 || / /.test(value)) return false;
  const lines = value.trim().split(/\r?\n/);
  if (!lines.every((l) => /^[A-Za-z0-9+/_-]*={0,2}$/.test(l))) return false;
  if (lines.length === 1) return true;
  const width = lines[0]!.length;
  return width >= 60 && lines.slice(0, -1).every((l) => l.length === width);
}

/** Whether a string is an HTML document or fragment rather than text that mentions a tag. */
export function looksLikeHtml(text: string): boolean {
  if (/^\s*(?:<!doctype html|<html[\s>]|<head[\s>]|<body[\s>])/i.test(text)) return true;
  const tags = text.match(/<\/?[a-z][a-z0-9]*(?:\s[^<>]*)?>/gi);
  if (!tags || tags.length < 12) return false;
  return tags.join("").length > text.length * 0.25;
}

/** HTML as the text a person would see. */
export function htmlToText(html: string): string {
  const text = html
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<(head|style|script|title|noscript|template|svg)\b[\s\S]*?<\/\1\s*>/gi, "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<li\b[^>]*>/gi, "\n- ")
    .replace(/<\/(?:p|div|tr|h[1-6]|table|blockquote|section|article|header|footer|ul|ol|pre)\s*>/gi, "\n")
    .replace(/<(?:td|th)\b[^>]*>/gi, " ")
    .replace(/<a\b[^>]*?href\s*=\s*["']([^"']+)["'][^>]*>([\s\S]*?)<\/a\s*>/gi, (_m, href: string, inner: string) => {
      const label = inner.replace(/<[^>]+>/g, "").trim();
      const url = decodeEntities(href.trim());
      if (!/^https?:/i.test(url) || url.length > 300 || label === url || !label) return label || "";
      return `${label} (${url})`;
    })
    .replace(/<[^>]+>/g, "");
  return squeezeBlankLines(cleanText(decodeEntities(text))).trim();
}

const NAMED_ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  zwnj: "",
  zwj: "",
  shy: "",
  ndash: "-",
  mdash: "-",
  hellip: "...",
  rsquo: "'",
  lsquo: "'",
  rdquo: '"',
  ldquo: '"',
  copy: "(c)",
  reg: "(R)",
  trade: "(TM)",
  bull: "-",
  middot: "-",
};

function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (match, name: string) => {
    if (name.startsWith("#")) {
      const code = name[1] === "x" || name[1] === "X" ? parseInt(name.slice(2), 16) : parseInt(name.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code < 0x110000 ? String.fromCodePoint(code) : match;
    }
    return NAMED_ENTITIES[name.toLowerCase()] ?? match;
  });
}

/**
 * Text without its padding.
 *
 * Invisible characters out, odd spaces made plain, runs of eight or more
 * spaces inside a line made one (indentation at the start of a line is kept:
 * it is code's structure), and lines of nothing but whitespace emptied.
 */
export function cleanText(text: string): string {
  return text
    .replace(/\r\n?/g, "\n")
    .replace(INVISIBLE, "")
    .replace(ODD_SPACE, " ")
    .replace(/&(?:nbsp|zwnj|zwj|shy|#847|#173|#8203|#8199|#x200b|#xfeff);/gi, (m) => (/nbsp|8199/i.test(m) ? " " : ""))
    .split("\n")
    .map((line) => line.replace(/(\S)[ \t]{8,}/g, "$1 ").trimEnd())
    .map((line) => (line.trim() ? line : ""))
    .join("\n");
}

/** At most one blank line in a row. */
function squeezeBlankLines(text: string): string {
  return text.replace(/\n{3,}/g, "\n\n");
}

/** Every line at most `LINE_MAX` characters, broken at a space where there is one. */
function wrapLines(text: string): string {
  if (!text.split("\n").some((l) => l.length > LINE_MAX)) return text;
  return text
    .split("\n")
    .flatMap((line) => {
      const parts: string[] = [];
      let rest = line;
      while (rest.length > LINE_MAX) {
        const space = rest.lastIndexOf(" ", LINE_MAX);
        const at = space > LINE_MAX / 2 ? space : LINE_MAX;
        parts.push(rest.slice(0, at));
        rest = rest.slice(at).replace(/^ /, "");
      }
      parts.push(rest);
      return parts;
    })
    .join("\n");
}

/*
 * ---------------------------------------------------------------------------
 * Results the model already knows most of, said in a line.
 *
 * Measured on the session of 5 Nov 2026 (a typeface built in 29 minutes):
 * 41 write_file results came to 235,000 characters and 140 edit_file
 * results to 211,000, because each carried a unified diff of the change —
 * that is, every line the model had just written, sent back to it, in the
 * history for the rest of the turn. One edit's result was 20,234 characters.
 * The diff is for the person, and reaches them by its own event; the model
 * is told where the change landed and how big it was. An edit placed by a
 * looser rung of the match ladder still carries its diff, because then the
 * text replaced is not exactly what the model asked for, and it must see it.
 *
 * A directory listing was JSON with each entry's full path, size in bytes
 * and an ISO timestamp: 3,832 characters for 24 entries. It is the listing
 * `ls` would print, now.
 * ---------------------------------------------------------------------------
 */

/**
 * A command's result without the command.
 *
 * Every run_command result repeated the call's own `command` and
 * `description`, which the model had just written: a 300-character
 * PowerShell line came back word for word above its two lines of output.
 * Dropped only when they are exactly what was asked, so a result about some
 * other process still names it.
 */
function withoutEchoes(tool: string, result: ToolResult, input?: Record<string, unknown>): ToolResult {
  if (tool !== "run_command" || !input) return result;
  const data = result.data;
  if (!data || typeof data !== "object" || Array.isArray(data)) return result;
  const d = data as Record<string, unknown>;
  const same = (key: string): boolean => typeof d[key] === "string" && typeof input[key] === "string" && (d[key] as string).trim() === (input[key] as string).trim();
  if (!same("command") && !same("description")) return result;
  const rest = { ...d };
  if (same("command")) delete rest["command"];
  if (same("description")) delete rest["description"];
  return { ...result, data: rest };
}

/**
 * A plan update, as how far along it is.
 *
 * The result repeated every item the model had just sent, an eleven-item
 * plan's worth of titles each time it moved one. The person's plan bar takes
 * the items from its own event; the model is told the count and what is in
 * progress.
 */
function planProgress(data: unknown): Record<string, unknown> | null {
  if (!data || typeof data !== "object" || Array.isArray(data)) return null;
  const d = data as Record<string, unknown>;
  const items = d["items"];
  if (!Array.isArray(items)) return null;
  const status = (i: unknown): string => String((i as { status?: unknown })?.status ?? "");
  const title = (i: unknown): string => String((i as { title?: unknown; content?: unknown })?.title ?? (i as { content?: unknown })?.content ?? "");
  const current = items.find((i) => status(i) === "in_progress");
  return {
    completed: items.filter((i) => status(i) === "completed").length,
    total: items.length,
    ...(current ? { in_progress: title(current) } : {}),
    ...(items.some((i) => status(i) === "failed") ? { failed: items.filter((i) => status(i) === "failed").length } : {}),
  };
}

/** A fuzzy edit's diff, as much as the model is shown of it. */
const FUZZY_DIFF_MAX = 4_000;

/** What a successful write or edit tells the model; null leaves the result as it was. */
export function compactChange(tool: string, result: ToolResult, input?: Record<string, unknown>): ToolResult | null {
  const data = result.data;
  if (!data || typeof data !== "object" || Array.isArray(data)) return null;
  const d = data as Record<string, unknown>;
  const diff = typeof d["diff"] === "string" ? (d["diff"] as string) : typeof result.diff === "string" ? result.diff : "";
  const stats = diffStats(diff);
  const out: Record<string, unknown> = { path: d["path"] };
  if (tool === "write_file") {
    const created = d["created"] === true;
    const content = typeof input?.["content"] === "string" ? (input["content"] as string) : null;
    out["created"] = created;
    out["lines"] = content === null ? stats.newLines : content === "" ? 0 : content.replace(/\n$/, "").split("\n").length;
    if (typeof d["bytesWritten"] === "number") out["bytes"] = d["bytesWritten"];
    // Over an existing file: how much of it changed, which the model did not write down.
    if (!created && diff) {
      out["added"] = stats.added;
      out["removed"] = stats.removed;
    }
  } else {
    if (d["alreadyApplied"] === true) out["alreadyApplied"] = true;
    if (stats.range) out["lines"] = stats.range;
    if (diff) {
      out["added"] = stats.added;
      out["removed"] = stats.removed;
    }
    const strategy = d["matchStrategy"];
    if (typeof strategy === "string" && strategy !== "exact") {
      out["matchStrategy"] = strategy;
      out["diff"] = diff.length > FUZZY_DIFF_MAX ? `${diff.slice(0, FUZZY_DIFF_MAX)}\n[… ${(diff.length - FUZZY_DIFF_MAX).toLocaleString("en-US")} more characters of the diff]` : diff;
    }
  }
  for (const key of ["note", "warnings", "repeat"]) if (d[key] !== undefined) out[key] = d[key];
  return { ...result, data: out };
}

/** Lines added and removed, where the changed lines now sit, and how long the new file is. */
function diffStats(diff: string): { added: number; removed: number; range: string | null; newLines: number } {
  let added = 0;
  let removed = 0;
  let low = Infinity;
  let high = -Infinity;
  let at = 0;
  let newLines = 0;
  let inHunk = false;
  for (const line of diff.split("\n")) {
    const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/.exec(line);
    if (hunk) {
      at = Number(hunk[1]);
      const count = hunk[2] === undefined ? 1 : Number(hunk[2]);
      newLines = Math.max(newLines, at + count - 1);
      inHunk = true;
      continue;
    }
    if (!inHunk) continue;
    if (line.startsWith("+")) {
      added++;
      low = Math.min(low, at);
      high = Math.max(high, at);
      at++;
    } else if (line.startsWith("-")) {
      removed++;
      // A removal sits where the next line now is.
      low = Math.min(low, Math.max(at, 1));
      high = Math.max(high, Math.max(at, 1));
    } else if (line.startsWith(" ")) {
      at++;
    }
  }
  const range = low === Infinity ? null : low === high ? String(low) : `${low}-${high}`;
  return { added, removed, range, newLines };
}

/** A size as people read it. */
function humanSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** A path with forward slashes and no trailing slash or leading "./". */
function plainPath(p: string): string {
  return p.replace(/\\/g, "/").replace(/^\.\//, "").replace(/\/+$/, "");
}

/** A listing as `ls` would print it: one entry a line, relative to the folder; null when the data is not a listing. */
export function listingText(data: unknown): string | null {
  if (!data || typeof data !== "object") return null;
  const d = data as Record<string, unknown>;
  const entries = d["entries"];
  if (!Array.isArray(entries)) return null;
  const asked = typeof d["path"] === "string" && d["path"].trim() ? (d["path"] as string).trim() : ".";
  const base = plainPath(asked);
  const prefix = base === "" || base === "." ? "" : `${base}/`;
  const rows = entries.filter((e): e is Record<string, unknown> => Boolean(e) && typeof e === "object");
  const paths = rows.map((e) => plainPath(String(e["path"] ?? e["name"] ?? "")));
  // Relative to the folder when every entry is in it (case-blind, for Windows drive letters); else as given.
  const strip = prefix !== "" && paths.every((p) => p.toLowerCase().startsWith(prefix.toLowerCase()));
  const lines = rows.map((e, i) => {
    const name = strip ? paths[i]!.slice(prefix.length) : paths[i]!;
    if (e["type"] === "directory") return `${name}/`;
    if (e["type"] === "symlink") return `${name} (link)`;
    return typeof e["sizeBytes"] === "number" ? `${name}  ${humanSize(e["sizeBytes"] as number)}` : name;
  });
  const n = rows.length;
  const where = base === "" || base === "." ? "the project folder" : asked;
  const head =
    n === 0
      ? `${where} is empty.`
      : `${n} ${n === 1 ? "entry" : "entries"} in ${where} (${strip ? "paths relative to it; " : ""}folders end in /):`;
  return [head, ...lines].join("\n");
}

/** Files a glob matched, one a line; null when the data is not a glob's. */
export function globText(data: unknown): string | null {
  if (!data || typeof data !== "object") return null;
  const d = data as Record<string, unknown>;
  const files = d["files"];
  if (!Array.isArray(files)) return null;
  const pattern = String(d["pattern"] ?? "");
  const note = typeof d["note"] === "string" ? (d["note"] as string) : "";
  if (files.length === 0) return note || `No file matches ${pattern}.`;
  const n = files.length;
  return [`${n}${d["truncated"] ? "+" : ""} ${n === 1 ? "file matches" : "files match"} ${pattern}, newest first:`, ...files.map(String), ...(note ? ["", note] : [])].join("\n");
}
