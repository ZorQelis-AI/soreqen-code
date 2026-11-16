/**
 * What a mention of a name actually *is*.
 *
 * ## The problem with a text search
 *
 * `find_symbol_references` matched `\bname\b` and returned every line it hit.
 * Asked for `guardPath` in this repository it returned 23 results, of which
 * roughly five were call sites. The rest were two import statements, several
 * prose mentions inside block comments, and a test name inside a string
 * literal.
 *
 * That is not a small annoyance. The model pays for all 23 in context, has to
 * read each one to work out which are real, and — if it is doing a rename —
 * has to decide about each. Worse, a comment that mentions a function reads
 * exactly like a call once it is a line in a list, so the failure mode is a
 * model that "updates all references" and edits prose.
 *
 * ## What this does instead
 *
 * Scans the file with the same lexical rules a compiler would use to decide
 * what is code — so a name inside a string or a comment is *known* to be
 * inside one — and then classifies each real occurrence by what surrounds it:
 * a call, a declaration, an import, a type position, or a bare mention.
 *
 * The comment and string hits are still counted and reported, because "there
 * are also six mentions in comments" is useful and "here are six lines of
 * prose" is not.
 *
 * ## Why the scanner is duplicated from `edit-integrity.ts`
 *
 * Both need to know which parts of a file are code, and they need different
 * things from the walk: that one counts brackets as it goes and never
 * materialises positions, this one needs the positions and does not care about
 * balance. Sharing would mean one of them allocating a structure it has no use
 * for on every call. The lexical rules are the same and are stated in both.
 */

/** Which lexical region a character sits in. */
type Region = "code" | "comment" | "string";

export type ReferenceKind =
  /** `foo(…)` — the thing is being invoked. */
  | "call"
  /** `function foo`, `const foo =`, `class foo` — this is where it comes from. */
  | "definition"
  /** `import { foo }`, `from "./foo"` — a binding, not a use. */
  | "import"
  /** `: Foo`, `<Foo>`, `extends Foo` — a type position. */
  | "type"
  /** Real code, none of the above: passed as a value, re-exported, compared. */
  | "mention"
  /** Inside a `//` or `/* *\/` comment. Prose. */
  | "comment"
  /** Inside a string or template literal. */
  | "string";

export interface Reference {
  line: number;
  column: number;
  kind: ReferenceKind;
  text: string;
}

/** Kinds that are actual uses of the symbol in code. */
export const CODE_KINDS: ReferenceKind[] = ["call", "definition", "import", "type", "mention"];

/**
 * Mark which byte offsets are code.
 *
 * Same state machine as `balanceOf` in `edit-integrity.ts`: line comments,
 * block comments, single- and double-quoted strings with escapes, and template
 * literals with nested `${}` interpolations that return to code.
 */
function regionsOf(content: string, path: string): Uint8Array {
  const mask = new Uint8Array(content.length); // 0 code, 1 comment, 2 string
  const python = /\.py$/i.test(path);

  type Mode = "code" | "line-comment" | "block-comment" | "single" | "double" | "template" | "triple";
  let mode: Mode = "code";
  let tripleDelimiter = "";
  const templateStack: number[] = [];
  let interpolationDepth = 0;

  const mark = (i: number, region: Region): void => {
    mask[i] = region === "code" ? 0 : region === "comment" ? 1 : 2;
  };

  for (let i = 0; i < content.length; i++) {
    const ch = content[i]!;
    const next = content[i + 1];
    const three = content.slice(i, i + 3);

    switch (mode) {
      case "line-comment":
        mark(i, "comment");
        if (ch === "\n") mode = "code";
        continue;

      case "block-comment":
        mark(i, "comment");
        if (ch === "*" && next === "/") {
          mark(i + 1, "comment");
          i++;
          mode = "code";
        }
        continue;

      case "triple":
        mark(i, "string");
        if (three === tripleDelimiter) {
          mark(i + 1, "string");
          mark(i + 2, "string");
          i += 2;
          mode = "code";
        }
        continue;

      case "single":
      case "double":
        mark(i, "string");
        if (ch === "\\") {
          if (i + 1 < content.length) mark(i + 1, "string");
          i++;
          continue;
        }
        if (ch === "\n") {
          mode = "code";
          continue;
        }
        if ((mode === "single" && ch === "'") || (mode === "double" && ch === '"')) mode = "code";
        continue;

      case "template":
        mark(i, "string");
        if (ch === "\\") {
          if (i + 1 < content.length) mark(i + 1, "string");
          i++;
          continue;
        }
        if (ch === "`") {
          mode = "code";
          continue;
        }
        if (ch === "$" && next === "{") {
          mark(i + 1, "string");
          templateStack.push(interpolationDepth);
          interpolationDepth = 0;
          mode = "code";
          i++;
        }
        continue;

      case "code": {
        if (python) {
          if (three === '"""' || three === "'''") {
            tripleDelimiter = three;
            mode = "triple";
            mark(i, "string");
            mark(i + 1, "string");
            mark(i + 2, "string");
            i += 2;
            continue;
          }
          if (ch === "#") {
            mode = "line-comment";
            mark(i, "comment");
            continue;
          }
        } else {
          if (ch === "/" && next === "/") {
            mode = "line-comment";
            mark(i, "comment");
            mark(i + 1, "comment");
            i++;
            continue;
          }
          if (ch === "/" && next === "*") {
            mode = "block-comment";
            mark(i, "comment");
            mark(i + 1, "comment");
            i++;
            continue;
          }
          if (ch === "`") {
            mode = "template";
            mark(i, "string");
            continue;
          }
        }

        if (ch === "'") {
          mode = "single";
          mark(i, "string");
          continue;
        }
        if (ch === '"') {
          mode = "double";
          mark(i, "string");
          continue;
        }

        if (templateStack.length > 0) {
          if (ch === "{") interpolationDepth++;
          else if (ch === "}") {
            if (interpolationDepth === 0) {
              interpolationDepth = templateStack.pop()!;
              mode = "template";
              mark(i, "string");
              continue;
            }
            interpolationDepth--;
          }
        }

        mark(i, "code");
        continue;
      }
    }
  }

  return mask;
}

const IDENTIFIER_CHAR = /[A-Za-z0-9_$]/;

const DECLARES =
  /\b(function|class|interface|type|const|let|var|def|struct|enum|fn|func)\s*$/;
const TYPE_POSITION = /(:|<|,|extends\s|implements\s|as\s)\s*$/;

/**
 * Every occurrence of `name` in one file, classified.
 *
 * Whole-word only: `guardPathFor` is not an occurrence of `guardPath`, and a
 * text search that returned it would be adding to the noise this exists to
 * remove.
 */
export function findReferences(path: string, content: string, name: string): Reference[] {
  if (!name) return [];
  const mask = regionsOf(content, path);
  const out: Reference[] = [];

  // Line offsets, so a byte index becomes a line and column without rescanning.
  const lineStarts: number[] = [0];
  for (let i = 0; i < content.length; i++) {
    if (content[i] === "\n") lineStarts.push(i + 1);
  }
  const locate = (index: number): { line: number; column: number } => {
    let lo = 0;
    let hi = lineStarts.length - 1;
    while (lo < hi) {
      const mid = Math.ceil((lo + hi) / 2);
      if (lineStarts[mid]! <= index) lo = mid;
      else hi = mid - 1;
    }
    return { line: lo + 1, column: index - lineStarts[lo]! + 1 };
  };

  let from = 0;
  for (;;) {
    const at = content.indexOf(name, from);
    if (at === -1) break;
    from = at + name.length;

    // Whole word.
    const before = at > 0 ? content[at - 1]! : "";
    const after = at + name.length < content.length ? content[at + name.length]! : "";
    if (IDENTIFIER_CHAR.test(before) || IDENTIFIER_CHAR.test(after)) continue;

    const region = mask[at];
    const { line, column } = locate(at);
    const lineStart = lineStarts[line - 1]!;
    const lineEnd = content.indexOf("\n", lineStart);
    const lineText = content.slice(lineStart, lineEnd === -1 ? content.length : lineEnd).trim();

    if (region === 1) {
      out.push({ line, column, kind: "comment", text: lineText.slice(0, 200) });
      continue;
    }
    if (region === 2) {
      out.push({ line, column, kind: "string", text: lineText.slice(0, 200) });
      continue;
    }

    out.push({
      line,
      column,
      kind: classify(content, at, name, lineText),
      text: lineText.slice(0, 200),
    });
  }

  return out;
}

function classify(content: string, at: number, name: string, lineText: string): ReferenceKind {
  const preceding = content.slice(Math.max(0, at - 60), at);
  const following = content.slice(at + name.length, at + name.length + 30);

  /*
   * Imports first, because an import line also contains a `from "…"` string and
   * can look like several other things. It is decided from the whole line
   * rather than the immediate neighbours.
   */
  if (/^\s*(import|export)\b/.test(lineText) && /\bfrom\b|^\s*import\s/.test(lineText)) {
    return "import";
  }
  if (/\brequire\s*\(\s*$/.test(preceding)) return "import";

  if (DECLARES.test(preceding)) return "definition";

  // `foo(` — allowing whitespace and a generic argument list between.
  if (/^\s*(<[^<>()]*>)?\s*\(/.test(following)) return "call";

  if (TYPE_POSITION.test(preceding)) return "type";

  return "mention";
}
