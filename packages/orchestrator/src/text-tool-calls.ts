/**
 * Tool calls a model wrote as text.
 *
 * ## The failure
 *
 * Some models, served through an OpenAI-compatible endpoint, occasionally
 * write a tool call into their *answer* instead of the structured
 * `tool_calls` field — in the markup they were trained on:
 *
 *     <tool_call><function=edit_file><parameter=path>src/ui.ts</parameter>…</function></tool_call>
 *
 * or, from the Hermes family, a JSON object between the same tags. The
 * endpoint's own parser was meant to lift it out and did not. What reached the
 * loop was prose: the call never ran, the model believed it had, and the whole
 * raw block — often a few kilobytes of code — was rendered in the chat as a
 * wall of paragraphs.
 *
 * ## What this does
 *
 * Reads the text as it streams and lifts those blocks back out. A block that
 * names a real tool becomes a real call and runs; one that cannot be read is
 * reported as malformed, so the loop can tell the model what happened rather
 * than letting it carry on as though the edit were made. Either way the markup
 * never reaches the transcript.
 *
 * ## What it leaves alone
 *
 * The same markup *discussed* rather than *used*: inside a fenced code block,
 * or quoted inline in backticks, it is text — an agent explaining the format
 * to someone must not have its explanation executed.
 */

export interface TextToolCall {
  name: string;
  input: Record<string, unknown>;
}

export type ExtractedChunk =
  | { type: "text"; text: string }
  | { type: "call"; call: TextToolCall }
  | { type: "malformed"; raw: string };

/** Enough of a tool's schema to type its parameters. */
export interface ToolShape {
  name: string;
  input_schema?: { properties?: Record<string, { type?: string | string[] }> } | Record<string, unknown>;
}

const OPENERS = ["<tool_call>", "<function="] as const;
const LONGEST_OPENER = Math.max(...OPENERS.map((o) => o.length));

/**
 * The most a single call may buffer before it is given up as malformed.
 *
 * A model that opens a block and never closes it would otherwise swallow the
 * rest of its answer silently. 256 KB is well past any real edit.
 */
const MAX_BLOCK_CHARS = 256_000;

export class TextToolCallExtractor {
  private readonly tools: Map<string, ToolShape>;
  /** Text received and not yet released: it may be the start of an opener. */
  private pending = "";
  /** The block being read, when inside one. */
  private block: string | null = null;
  /** Whether the text released so far ends inside a fenced code block. */
  private inFence = false;
  /** The last character released, to tell `<tool_call>` quoted in backticks. */
  private lastReleased = "";

  constructor(tools: readonly ToolShape[]) {
    this.tools = new Map(tools.map((t) => [t.name, t]));
  }

  /** Feed a piece of streamed text; returns what can be released now. */
  push(text: string): ExtractedChunk[] {
    if (this.tools.size === 0) return text ? [{ type: "text", text }] : [];
    const out: ExtractedChunk[] = [];
    this.pending += text;
    this.drain(out, false);
    return out;
  }

  /** The stream has ended: release everything. */
  end(): ExtractedChunk[] {
    const out: ExtractedChunk[] = [];
    this.drain(out, true);
    if (this.block !== null) {
      /*
       * Never closed. A block that got as far as `</function>` and only
       * forgot the outer tag is complete; anything shorter was cut off, and a
       * call with half its arguments must not run.
       */
      out.push(
        this.block.includes("</function>")
          ? this.finishBlock(this.block)
          : { type: "malformed", raw: this.block.slice(0, 2_000) },
      );
      this.block = null;
    }
    return out;
  }

  private drain(out: ExtractedChunk[], final: boolean): void {
    for (;;) {
      if (this.block !== null) {
        this.block += this.pending;
        this.pending = "";
        const closeAt = closingIndex(this.block);
        if (closeAt === -1) {
          if (this.block.length > MAX_BLOCK_CHARS) {
            out.push({ type: "malformed", raw: this.block.slice(0, 2_000) });
            this.block = null;
          }
          return;
        }
        const raw = this.block.slice(0, closeAt);
        this.pending = this.block.slice(closeAt);
        this.block = null;
        out.push(this.finishBlock(raw));
        continue;
      }

      /*
       * Fences are tracked here, one at a time, rather than counted in each
       * released piece: a piece can hold a fence that opens *and* the opener
       * after it closes, and counting would get the order wrong.
       */
      const fence = this.pending.indexOf("```");
      if (this.inFence) {
        if (fence === -1) {
          this.holdBack(out, final, trailingBackticks(this.pending));
          return;
        }
        this.release(out, this.pending.slice(0, fence + 3));
        this.pending = this.pending.slice(fence + 3);
        this.inFence = false;
        continue;
      }

      const at = this.openerIndex(this.pending);
      if (fence !== -1 && (at === -1 || fence < at)) {
        this.release(out, this.pending.slice(0, fence + 3));
        this.pending = this.pending.slice(fence + 3);
        this.inFence = true;
        continue;
      }
      if (at === -1) {
        this.holdBack(out, final, Math.max(heldTail(this.pending), trailingBackticks(this.pending)));
        return;
      }

      this.release(out, this.pending.slice(0, at));
      this.block = "";
      this.pending = this.pending.slice(at);
    }
  }

  /** Release all but a tail that could still grow into something that matters. */
  private holdBack(out: ExtractedChunk[], final: boolean, hold: number): void {
    const keep = final ? 0 : hold;
    this.release(out, this.pending.slice(0, this.pending.length - keep));
    this.pending = this.pending.slice(this.pending.length - keep);
  }

  /** Where a real opener starts — one not quoted in backticks — or -1. */
  private openerIndex(text: string): number {
    let best = -1;
    for (const opener of OPENERS) {
      let from = 0;
      for (;;) {
        const i = text.indexOf(opener, from);
        if (i === -1) break;
        const before = i > 0 ? text[i - 1] : this.lastReleased;
        if (before !== "`") {
          if (best === -1 || i < best) best = i;
          break;
        }
        from = i + opener.length;
      }
    }
    return best;
  }

  private release(out: ExtractedChunk[], text: string): void {
    if (!text) return;
    this.lastReleased = text[text.length - 1] ?? "";
    const last = out[out.length - 1];
    if (last?.type === "text") last.text += text;
    else out.push({ type: "text", text });
  }

  private finishBlock(raw: string): ExtractedChunk {
    const call = parseTextToolCall(raw, this.tools);
    return call ? { type: "call", call } : { type: "malformed", raw: raw.slice(0, 2_000) };
  }
}

/** Where the block that `text` starts with ends (exclusive), or -1. */
function closingIndex(text: string): number {
  const close = text.startsWith("<tool_call>") ? "</tool_call>" : "</function>";
  const i = text.indexOf(close);
  return i === -1 ? -1 : i + close.length;
}

/** How much of the end of `text` could be the start of an opener. */
function heldTail(text: string): number {
  const window = text.slice(-(LONGEST_OPENER - 1));
  for (let n = window.length; n > 0; n--) {
    const tail = window.slice(-n);
    if (OPENERS.some((o) => o.startsWith(tail))) return n;
  }
  return 0;
}

/** Trailing backticks, which could be the first of a fence split across chunks. */
function trailingBackticks(text: string): number {
  const m = /`{1,2}$/.exec(text);
  return m ? m[0].length : 0;
}

/**
 * Read one block — the Qwen XML form or the Hermes JSON form.
 *
 * Returns null unless it names a tool that exists: a block naming anything
 * else is either a hallucinated tool or prose that happens to look like one,
 * and neither should run.
 */
export function parseTextToolCall(raw: string, tools: Map<string, ToolShape>): TextToolCall | null {
  const inner = raw
    .replace(/^\s*<tool_call>\s*/, "")
    .replace(/\s*<\/tool_call>\s*$/, "");

  const fn = /<function=([\w.-]+)>([\s\S]*?)(?:<\/function>|$)/.exec(inner);
  if (fn) {
    const name = fn[1]!;
    const tool = tools.get(name);
    if (!tool) return null;
    const input: Record<string, unknown> = {};
    const param = /<parameter=([\w.-]+)>([\s\S]*?)<\/parameter>/g;
    for (let m = param.exec(fn[2]!); m; m = param.exec(fn[2]!)) {
      input[m[1]!] = coerce(stripOneNewline(m[2]!), typeOf(tool, m[1]!));
    }
    return { name, input };
  }

  try {
    const parsed = JSON.parse(inner.trim()) as { name?: unknown; arguments?: unknown; parameters?: unknown };
    if (typeof parsed?.name !== "string" || !tools.has(parsed.name)) return null;
    let args: unknown = parsed.arguments ?? parsed.parameters ?? {};
    if (typeof args === "string") args = JSON.parse(args) as unknown;
    if (!args || typeof args !== "object" || Array.isArray(args)) return null;
    return { name: parsed.name, input: args as Record<string, unknown> };
  } catch {
    return null;
  }
}

/** The format puts each value on its own lines; the newline is framing, not content. */
function stripOneNewline(value: string): string {
  return value.replace(/^\r?\n/, "").replace(/\r?\n$/, "");
}

function typeOf(tool: ToolShape, param: string): string | undefined {
  const props = (tool.input_schema as { properties?: Record<string, { type?: string | string[] }> } | undefined)
    ?.properties;
  const t = props?.[param]?.type;
  return Array.isArray(t) ? t[0] : t;
}

/**
 * A parameter's value in the type its schema asks for.
 *
 * Everything in the markup is text, so `<parameter=line>42</parameter>` is
 * the string "42". A string parameter keeps it as written — code that happens
 * to parse as JSON must stay code — and anything else is read as JSON when it
 * can be.
 */
function coerce(value: string, type: string | undefined): unknown {
  if (type === "string") return value;
  const trimmed = value.trim();
  try {
    return JSON.parse(trimmed) as unknown;
  } catch {
    return value;
  }
}
