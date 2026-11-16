/**
 * Did this edit break the file?
 *
 * ## The round trip this removes
 *
 * The commonest way an agent damages a file is not a wrong idea, it is a
 * mis-placed edit: an `old_str` that matched somewhere unintended, or a
 * replacement whose braces do not balance the ones it replaced. The result is
 * a file that no longer parses.
 *
 * Nothing noticed until verification, which runs once, at the very end of the
 * turn, after the model has done everything else. By then the model has built
 * ten more steps on top of a broken file, and the diagnostic it finally sees
 * points at a line it last thought about twenty tool calls ago. That is
 * expensive twice: the wasted steps, and the much harder debugging.
 *
 * Telling it in the same tool result costs a few microseconds and lets it fix
 * the thing it is still holding in its head.
 *
 * ## Why differential, and why not a parser
 *
 * A real parser would be better and is not free: it means a language toolchain
 * per language, in-process, on every edit.
 *
 * What is free is counting structure. And counting is only useful *as a
 * difference*: plenty of real files are momentarily unbalanced — a partial
 * refactor, a generated fragment, a template — and a check that complains
 * about the state it *found* would cry wolf, which is how a check gets
 * ignored. So this compares before with after and reports only what the edit
 * itself changed. A file that was already broken and is still broken is not
 * this edit's problem; a file that was fine and now is not, is.
 */

/** Where a file's structure stands. */
export interface Balance {
  /** Net unclosed `{`, `(`, `[`. Negative means more closers than openers. */
  curly: number;
  round: number;
  square: number;
  /** A string or template literal left open at end of file. */
  unterminatedString: boolean;
  /**
   * Lines that ended while still inside a `'` or `"` string.
   *
   * Counted per line rather than only at end of file, because the damage is
   * usually in the middle: a replacement that drops a closing quote leaves
   * `return "oops;` on one line and the rest of the file parses on regardless.
   * Only a template literal legitimately spans lines, so a plain quote still
   * open at a newline is a broken line wherever it sits.
   */
  brokenStringLines: number;
  /** A `/* *\/` block comment left open. */
  unterminatedComment: boolean;
}

export interface IntegrityReport {
  /** False when the edit introduced a structural problem that was not there
   *  before. A file that was already unbalanced stays `ok`. */
  ok: boolean;
  /** One line per problem, phrased for the model to act on. */
  problems: string[];
}

const BRACE_LANGUAGES = /\.(ts|tsx|mts|cts|js|jsx|mjs|cjs|go|rs|java|kt|cs|swift|c|h|cpp|hpp|php|scala|dart)$/i;
const PYTHON = /\.py$/i;

/**
 * Count structure, skipping everything that only looks like structure.
 *
 * A brace inside a string or a comment is not a brace. Getting that wrong is
 * what makes naive counters useless on real code, so the scanner is a small
 * state machine rather than a regex.
 */
export function balanceOf(content: string): Balance {
  let curly = 0;
  let round = 0;
  let square = 0;
  let brokenStringLines = 0;

  type Mode = "code" | "line-comment" | "block-comment" | "single" | "double" | "template";
  let mode: Mode = "code";
  /*
   * Template literals nest: `${ `${x}` }` is legal, and each `${` returns to
   * code mode until its matching `}`. A stack of the brace depths at which
   * each template interpolation began is what tells a closing `}` whether it
   * ends an interpolation or an ordinary block.
   */
  const templateStack: number[] = [];
  let interpolationDepth = 0;

  for (let i = 0; i < content.length; i++) {
    const ch = content[i]!;
    const next = content[i + 1];

    switch (mode) {
      case "line-comment":
        if (ch === "\n") mode = "code";
        continue;

      case "block-comment":
        if (ch === "*" && next === "/") {
          mode = "code";
          i++;
        }
        continue;

      case "single":
      case "double": {
        if (ch === "\\") {
          i++;
          continue;
        }
        /*
         * A newline inside a plain quote is a broken line, not a long string.
         *
         * Recovering to code mode is what stops one missing quote swallowing
         * the rest of the file — but the recovery is also the signal, so it is
         * counted on the way past. Only a template literal legitimately spans
         * lines, so a `'` or `"` still open at a newline is damage wherever it
         * sits, not only at end of file.
         */
        if (ch === "\n") {
          brokenStringLines++;
          mode = "code";
          continue;
        }
        if ((mode === "single" && ch === "'") || (mode === "double" && ch === '"')) mode = "code";
        continue;
      }

      case "template": {
        if (ch === "\\") {
          i++;
          continue;
        }
        if (ch === "`") {
          mode = "code";
          continue;
        }
        if (ch === "$" && next === "{") {
          templateStack.push(interpolationDepth);
          interpolationDepth = 0;
          mode = "code";
          i++;
        }
        continue;
      }

      case "code": {
        if (ch === "/" && next === "/") {
          mode = "line-comment";
          i++;
          continue;
        }
        if (ch === "/" && next === "*") {
          mode = "block-comment";
          i++;
          continue;
        }
        if (ch === "'") {
          mode = "single";
          continue;
        }
        if (ch === '"') {
          mode = "double";
          continue;
        }
        if (ch === "`") {
          mode = "template";
          continue;
        }

        if (ch === "{") {
          curly++;
          if (templateStack.length > 0) interpolationDepth++;
        } else if (ch === "}") {
          if (templateStack.length > 0 && interpolationDepth === 0) {
            // Closes an interpolation, not a block.
            interpolationDepth = templateStack.pop()!;
            mode = "template";
            continue;
          }
          curly--;
          if (templateStack.length > 0) interpolationDepth--;
        } else if (ch === "(") round++;
        else if (ch === ")") round--;
        else if (ch === "[") square++;
        else if (ch === "]") square--;
        continue;
      }
    }
  }

  return {
    curly,
    round,
    square,
    brokenStringLines,
    unterminatedString: mode === "single" || mode === "double" || mode === "template",
    unterminatedComment: mode === "block-comment",
  };
}

/** Python has no braces, but it does have brackets and triple-quoted strings. */
function pythonBalance(content: string): Balance {
  let round = 0;
  let square = 0;
  let curly = 0;
  let inTriple: '"""' | "'''" | null = null;
  let inLine = false;
  let inSingle: "'" | '"' | null = null;

  for (let i = 0; i < content.length; i++) {
    const ch = content[i]!;
    const three = content.slice(i, i + 3);

    if (inTriple) {
      if (three === inTriple) {
        inTriple = null;
        i += 2;
      }
      continue;
    }
    if (inLine) {
      if (ch === "\n") inLine = false;
      continue;
    }
    if (inSingle) {
      if (ch === "\\") i++;
      else if (ch === inSingle || ch === "\n") inSingle = null;
      continue;
    }

    if (three === '"""' || three === "'''") {
      inTriple = three as '"""' | "'''";
      i += 2;
      continue;
    }
    if (ch === "#") {
      inLine = true;
      continue;
    }
    if (ch === "'" || ch === '"') {
      inSingle = ch;
      continue;
    }
    if (ch === "(") round++;
    else if (ch === ")") round--;
    else if (ch === "[") square++;
    else if (ch === "]") square--;
    else if (ch === "{") curly++;
    else if (ch === "}") curly--;
  }

  return {
    curly,
    round,
    square,
    /*
     * Not counted for Python.
     *
     * An unclosed `'` or `"` on one Python line is caught by the bracket
     * counts often enough, and Python's implicit line joining inside brackets
     * makes a per-line rule noisier here than it is worth. Triple quotes,
     * which are the real hazard in a docstring-heavy file, are counted above.
     */
    brokenStringLines: 0,
    unterminatedString: inTriple !== null,
    unterminatedComment: false,
  };
}

function balanceFor(path: string, content: string): Balance | null {
  if (PYTHON.test(path)) return pythonBalance(content);
  if (BRACE_LANGUAGES.test(path)) return balanceOf(content);
  // Markdown, JSON, YAML, plain text: no structure this check understands, and
  // guessing would produce noise. Silence is the honest answer.
  return null;
}

const SYMBOLS: Record<"curly" | "round" | "square", [string, string]> = {
  curly: ["{", "}"],
  round: ["(", ")"],
  square: ["[", "]"],
};

/**
 * Compare a file before and after an edit.
 *
 * Reports only what the edit changed for the worse. `ok: true` for an
 * unsupported file type, for an edit that fixed things, and for a file that
 * was already unbalanced and is no more unbalanced now.
 */
export function checkEditIntegrity(
  path: string,
  before: string,
  after: string,
): IntegrityReport {
  const b = balanceFor(path, before);
  const a = balanceFor(path, after);
  if (!b || !a) return { ok: true, problems: [] };

  const problems: string[] = [];

  for (const kind of ["curly", "round", "square"] as const) {
    const wasOff = b[kind];
    const isOff = a[kind];
    // Only when the edit moved it *away* from balanced.
    if (isOff === wasOff || Math.abs(isOff) <= Math.abs(wasOff)) continue;

    const [open, close] = SYMBOLS[kind];
    const delta = isOff - wasOff;
    problems.push(
      delta > 0
        ? `This edit left ${delta} more '${open}' than '${close}' than before it. The file no longer balances — check the replacement against what it replaced.`
        : `This edit left ${-delta} more '${close}' than '${open}' than before it. The file no longer balances — check the replacement against what it replaced.`,
    );
  }

  if (a.unterminatedString && !b.unterminatedString) {
    problems.push(
      "This edit left a string or template literal unterminated. A quote or backtick in the replacement is unmatched.",
    );
  }
  if (a.brokenStringLines > b.brokenStringLines) {
    const extra = a.brokenStringLines - b.brokenStringLines;
    problems.push(
      `This edit left ${extra} line${extra === 1 ? "" : "s"} with an unclosed quote — a string opens and the line ends before it closes.`,
    );
  }
  if (a.unterminatedComment && !b.unterminatedComment) {
    problems.push("This edit left a block comment unclosed — there is a '/*' with no '*/'.");
  }

  return { ok: problems.length === 0, problems };
}
