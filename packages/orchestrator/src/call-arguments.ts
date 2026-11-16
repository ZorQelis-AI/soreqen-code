/**
 * A tool call's arguments, read as generously as is safe, and the reason in
 * words when they cannot be.
 *
 * ## Why this exists (11 Oct 2026)
 *
 * A session on GLM-5.3-flash stopped after forty write_file calls in a row
 * that all arrived with no arguments at all, each answered with the tool's raw
 * schema error ("path: Required", "content: Required"). The model read that as
 * its own slip, wrote the same call again, and at temperature 0 the same
 * context gave the same call every time. Two things were behind it:
 *
 *   - The provider handed over `{}` whenever the argument text was not valid
 *     JSON, so the model never learnt what was wrong with what it sent.
 *   - The file it was writing contained the model's own control tags
 *     (`<think>`, `</think>`, `<|im_start|>`). Reproduced against OpenCode:
 *     asked to write a script holding those tags literally, GLM's response
 *     ends where the tag would be, with no text and no call, because the
 *     model server takes the tag in the model's output for its own marker.
 *
 * So arguments that are nearly JSON (a raw newline inside a string, a lone
 * backslash, the payload sent twice) are repaired; what cannot be read is
 * reported with what arrived; and an empty or invalid call is answered in
 * words that say what happened and how to get past it.
 */

/** The model's own control tags, which a model server may cut out of its output. */
export const CONTROL_TAGS = /<\/?think>|<\|[a-z_]+\|>|<\/?tool_call>|<\/?arg_(?:key|value)>/;

export type ParsedArguments = { input: Record<string, unknown>; repaired: boolean } | { error: string; raw: string };

function asObject(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

/**
 * Raw control characters inside strings escaped, and backslashes that start
 * no JSON escape doubled. Outside strings nothing is touched.
 */
function repairStrings(text: string): string {
  let out = "";
  let inString = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (!inString) {
      if (ch === '"') inString = true;
      out += ch;
      continue;
    }
    if (ch === "\\") {
      const next = text[i + 1];
      if (next !== undefined && /["\\/bfnrtu]/.test(next)) {
        // A \u needs four hex digits to be an escape.
        if (next === "u" && !/^[0-9a-fA-F]{4}$/.test(text.slice(i + 2, i + 6))) {
          out += "\\\\";
          continue;
        }
        out += ch + next;
        i++;
      } else {
        out += "\\\\";
      }
      continue;
    }
    if (ch === '"') {
      inString = false;
      out += ch;
      continue;
    }
    if (ch === "\n") out += "\\n";
    else if (ch === "\r") out += "\\r";
    else if (ch === "\t") out += "\\t";
    else if (ch < " ") out += `\\u${ch.charCodeAt(0).toString(16).padStart(4, "0")}`;
    else out += ch;
  }
  return out;
}

/** The first complete top-level object in `text`, for a payload a server sent twice. */
function firstObject(text: string): string | null {
  const start = text.indexOf("{");
  if (start < 0) return null;
  let depth = 0;
  let inString = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i]!;
    if (inString) {
      if (ch === "\\") i++;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === "{") depth++;
    else if (ch === "}" && --depth === 0) return text.slice(start, i + 1);
  }
  return null;
}

export function parseToolArguments(raw: string): ParsedArguments {
  const text = raw.trim();
  if (!text) return { input: {}, repaired: false };
  try {
    const value = asObject(JSON.parse(text));
    if (value) return { input: value, repaired: false };
  } catch {
    // Repaired below.
  }
  let lastError = "";
  const unfenced = text.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  const candidates = [unfenced, firstObject(unfenced)].filter((c): c is string => Boolean(c));
  for (const candidate of candidates) {
    for (const attempt of [candidate, repairStrings(candidate), repairStrings(candidate).replace(/,\s*([}\]])/g, "$1")]) {
      try {
        const value = asObject(JSON.parse(attempt));
        if (value) return { input: value, repaired: true };
      } catch (err) {
        lastError = err instanceof Error ? err.message : String(err);
      }
    }
  }
  return { error: lastError || "not a JSON object", raw: text };
}

/** What a model needs to hear when its call's arguments could not be read, or never arrived. */
export function unreadableCallMessage(tool: string, detail: { raw?: string; error?: string; empty?: boolean }): string {
  const what = detail.empty
    ? `Your ${tool} call arrived with no arguments at all: nothing was sent for any field, so nothing ran.`
    : `Your ${tool} call's arguments could not be read as JSON (${detail.error}), so nothing ran. ` +
      `What arrived began: ${JSON.stringify((detail.raw ?? "").slice(0, 160))}`;
  return (
    `FAILED: ${what}\n\n` +
    // The tags are spelled escaped here: this message is read by the same model, through the same server.
    "This is not a typo to retry. It happens when the call is cut short on its way out of the model, and the usual " +
    "cause is text the model server treats as its own markers: reasoning tags (\\u003cthink\\u003e, " +
    "\\u003c/think\\u003e), chat-template tokens (\\u003c|im_start|\\u003e, \\u003c|im_end|\\u003e) or tool-call " +
    "tags. Never write one of them literally, in your thinking or in a call. Inside a tool call's JSON, write each " +
    "'<' that begins one as \\u003c, which arrives as '<'; in code, build them from parts ('<' + '/think>'). A very " +
    "long file can also be cut: write it in parts (write_file the first part, then edit_file to append the rest)."
  );
}

/**
 * A schema error in words. Zod's own message is a JSON array of issues, which
 * reads as data, not as something to fix.
 */
export function describeInputError(tool: string, input: Record<string, unknown>, err: unknown): string | null {
  const issues = (err as { issues?: { path?: (string | number)[]; message?: string; expected?: string; received?: string }[] })?.issues;
  if (!Array.isArray(issues) || issues.length === 0) return null;
  if (Object.keys(input).length === 0) return unreadableCallMessage(tool, { empty: true });
  const lines = issues.map((i) => {
    const field = (i.path ?? []).join(".") || "(the input)";
    if (i.received === "undefined") return `- ${field}: missing (required)`;
    if (i.expected && i.received) return `- ${field}: expected ${i.expected}, got ${i.received}`;
    return `- ${field}: ${i.message ?? "invalid"}`;
  });
  return `FAILED: ${tool} was called with invalid arguments, so nothing ran:\n${lines.join("\n")}\nSend the call again with every required field filled in.`;
}
