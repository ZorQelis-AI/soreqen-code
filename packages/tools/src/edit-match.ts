/**
 * Finding the text the model meant.
 *
 * ## The problem, stated fairly
 *
 * `edit_file` takes an exact substring and fails if it is absent or appears
 * twice. That is the right contract: a fuzzy edit that silently patches the
 * wrong function is far worse than an edit that refuses. It is also, by a wide
 * margin, the most common way a coding agent wastes a turn — the model
 * reproduces the target from memory with one space wrong, gets a hard failure,
 * re-reads the file, and tries again, having spent two round trips to learn
 * about whitespace.
 *
 * The failure is almost never a misunderstanding of *which* code to change.
 * It is a transcription error in the anchor. So the fix is not to loosen the
 * contract; it is to try harder to find the anchor, and to say which method
 * worked.
 *
 * ## The ladder
 *
 * Each rung is strictly more permissive than the one above, and every rung
 * keeps the uniqueness requirement — an ambiguous match is a failure at every
 * level, because ambiguity is the thing that makes a wrong edit possible.
 *
 *   1. **exact** — the original contract. Nothing changes for edits that
 *      already worked.
 *   2. **whitespace** — the same lines, differing only in leading indentation
 *      or in runs of spaces inside a line. Catches tabs-versus-spaces and
 *      re-indentation.
 *   3. **indentation-shifted** — the same block, matched with every line
 *      trimmed, then re-indented to sit correctly where it actually lives.
 *      This is the rung that earns its keep: a model quoting a method body
 *      from a class it read at a different nesting level is the single
 *      commonest miss.
 *   4. **anchored** — first and last lines of the target are found, the span
 *      between them is checked for a high enough line-level similarity, and
 *      the whole span is replaced. The most permissive, and the only one that
 *      can be wrong in an interesting way, so its similarity floor is high
 *      and it refuses short anchors outright.
 *
 * ## Why the report matters as much as the match
 *
 * Every result carries the strategy that produced it, and everything below
 * `exact` is surfaced to the model and the user in the tool result. A fuzzy
 * match that nobody is told about is a silent behaviour change in someone's
 * source file, which is precisely the thing the strict contract existed to
 * prevent. Being lenient is fine. Being lenient and quiet is not.
 */

export type MatchStrategy = "exact" | "whitespace" | "indentation" | "anchored";

export interface EditMatch {
  /** How it was found. Anything but `exact` is reported to the user. */
  strategy: MatchStrategy;
  /** Character offset of the matched span. */
  start: number;
  /** Character offset one past the matched span. */
  end: number;
  /** The text actually present in the file, which is what gets replaced —
   *  never the string the model supplied. */
  matched: string;
  /**
   * Replacement, adjusted for where the match really sits.
   *
   * When a block is found at a different indentation than the model quoted,
   * inserting the replacement verbatim produces correctly-located, wrongly-
   * indented code — which compiles in most languages and is broken in Python.
   * The shift is applied here so the caller never has to think about it.
   */
  adjustedReplacement: string;
  /** How confident the rung is, for the human-facing note. 1 for exact. */
  confidence: number;
}

export interface EditMatchFailure {
  reason: "not_found" | "ambiguous";
  /** How many places matched, when that is the problem. */
  occurrences?: number;
  /** The rung that got furthest, so the message can be specific about how
   *  close the attempt came. */
  bestStrategy?: MatchStrategy;
  /** Lines from the file that look most like the target, to save the model a
   *  full re-read. Empty when nothing was close. */
  nearest?: { line: number; text: string }[];
  /** For a multi-line target: the best candidate and the lines after it, as
   *  many as the target spans, so it can be re-quoted without a re-read. */
  region?: { line: number; text: string }[];
}

export type EditMatchResult =
  | { ok: true; match: EditMatch }
  | { ok: false; failure: EditMatchFailure };

/** Runs of whitespace collapsed, ends trimmed. The comparison key for rung 2. */
function normaliseWhitespace(s: string): string {
  return s
    .split("\n")
    .map((l) => l.replace(/\s+/g, " ").trim())
    .join("\n")
    .trim();
}

/** Leading whitespace of a line, or "" for a blank one. */
function indentOf(line: string): string {
  return /^[ \t]*/.exec(line)?.[0] ?? "";
}

/**
 * Re-indent a replacement to match where the match actually landed.
 *
 * The delta is taken from the first non-blank line of each side, and applied
 * to every line uniformly — so relative indentation inside the block is
 * preserved, which is the only thing that could plausibly be got wrong here.
 */
function reindent(replacement: string, quotedIndent: string, actualIndent: string): string {
  if (quotedIndent === actualIndent) return replacement;

  /*
   * Every line, including the first.
   *
   * The first version skipped index 0, on the reasoning that the first line is
   * inserted at the match's own position and already carries its indentation.
   * That is false: a line-window match starts at the *start of the line*, so
   * the leading whitespace is inside the replaced span and has to be put back.
   * The result was a block whose opening line sat at column 0 and whose body
   * was correct — valid JavaScript, a syntax error in Python, and wrong
   * everywhere.
   */
  /*
   * Strip the quoted block's own base indent, then prepend the real one.
   *
   * Getting this backwards flattens the block. An earlier version replaced
   * each line's leading whitespace with `actualIndent`, so a replacement
   * quoted at column 0 came out with every line at the same depth — the
   * `if` and its body indistinguishable. Only the *base* indent is
   * substituted; everything relative to it is the author's structure and must
   * survive untouched.
   */
  return replacement
    .split("\n")
    .map((line) => {
      if (line.trim() === "") return line;
      const withoutBase = line.startsWith(quotedIndent)
        ? line.slice(quotedIndent.length)
        : line.replace(/^[ \t]*/, "");
      return actualIndent + withoutBase;
    })
    .join("\n");
}

/** Every offset at which `needle` occurs in `haystack`. */
function allIndexes(haystack: string, needle: string): number[] {
  if (needle.length === 0) return [];
  const found: number[] = [];
  let from = 0;
  for (;;) {
    const at = haystack.indexOf(needle, from);
    if (at === -1) break;
    found.push(at);
    from = at + 1;
  }
  return found;
}

/** Character offset at the start of each line. */
function lineOffsets(content: string): number[] {
  const offsets = [0];
  for (let i = 0; i < content.length; i++) {
    if (content[i] === "\n") offsets.push(i + 1);
  }
  return offsets;
}

/** Ratio of identical trimmed lines, positionally. Cheap, and adequate: the
 *  spans being compared are already anchored at both ends. */
function lineSimilarity(a: string[], b: string[]): number {
  if (a.length === 0 && b.length === 0) return 1;
  const len = Math.max(a.length, b.length);
  let same = 0;
  for (let i = 0; i < len; i++) {
    if ((a[i] ?? "").trim() === (b[i] ?? "").trim()) same++;
  }
  return same / len;
}

/**
 * Anchored matching needs enough of a fingerprint to be safe.
 *
 * Two lines of `}` and `)` will anchor almost anywhere, and a wrong anchored
 * match rewrites a whole span. Three lines and a real first line is the floor.
 */
const MIN_ANCHOR_LINES = 3;
const MIN_ANCHOR_LINE_LENGTH = 4;

/** How much of the interior must line up before an anchored span is accepted. */
const ANCHOR_SIMILARITY_FLOOR = 0.7;

export function findEditTarget(
  content: string,
  oldStr: string,
  newStr: string,
): EditMatchResult {
  if (oldStr.length === 0) {
    return { ok: false, failure: { reason: "not_found" } };
  }

  // ---- 1. exact ------------------------------------------------------------

  const exact = allIndexes(content, oldStr);
  if (exact.length === 1) {
    return {
      ok: true,
      match: {
        strategy: "exact",
        start: exact[0]!,
        end: exact[0]! + oldStr.length,
        matched: oldStr,
        adjustedReplacement: newStr,
        confidence: 1,
      },
    };
  }
  if (exact.length > 1) {
    /*
     * Ambiguity is not something to be clever about.
     *
     * A model that supplied a string appearing three times has under-specified
     * the edit, and no amount of fuzzier matching fixes that — the fuzzier
     * rungs would find the same three places, or more. Reporting the count and
     * the line numbers is strictly more useful than guessing.
     */
    return {
      ok: false,
      failure: {
        reason: "ambiguous",
        occurrences: exact.length,
        bestStrategy: "exact",
        nearest: exact.slice(0, 5).map((offset) => ({
          line: content.slice(0, offset).split("\n").length,
          text: (content.slice(offset).split("\n")[0] ?? "").trim().slice(0, 100),
        })),
      },
    };
  }

  const contentLines = content.split("\n");
  const oldLines = oldStr.split("\n");
  const offsets = lineOffsets(content);

  // ---- 2 & 3. whitespace and indentation ----------------------------------

  /*
   * Both rungs are the same scan.
   *
   * A window of the file's lines is compared to the target's lines under two
   * relaxations at once: trimmed equality (rung 3) and collapsed internal
   * whitespace (rung 2). Which rung to report is decided afterwards, by
   * checking whether indentation was the only thing that differed — that
   * distinction is what the user sees, so it is worth getting right, but it
   * does not warrant walking the file twice.
   */
  const targetTrimmed = oldLines.map((l) => l.trim());
  const targetCollapsed = oldLines.map((l) => l.replace(/\s+/g, " ").trim());

  const windowMatches: number[] = [];
  for (let i = 0; i + oldLines.length <= contentLines.length; i++) {
    let trimmedOk = true;
    let collapsedOk = true;
    for (let j = 0; j < oldLines.length; j++) {
      const line = contentLines[i + j]!;
      if (line.trim() !== targetTrimmed[j]) trimmedOk = false;
      if (line.replace(/\s+/g, " ").trim() !== targetCollapsed[j]) collapsedOk = false;
      if (!trimmedOk && !collapsedOk) break;
    }
    if (trimmedOk || collapsedOk) windowMatches.push(i);
  }

  if (windowMatches.length === 1) {
    const startLine = windowMatches[0]!;
    const endLine = startLine + oldLines.length - 1;
    const start = offsets[startLine]!;
    const end =
      offsets[endLine]! + contentLines[endLine]!.length;

    const matched = content.slice(start, end);

    const firstQuoted = oldLines.find((l) => l.trim() !== "") ?? "";
    const firstActual = contentLines.slice(startLine, endLine + 1).find((l) => l.trim() !== "") ?? "";
    const quotedIndent = indentOf(firstQuoted);
    const actualIndent = indentOf(firstActual);

    // Only indentation differed if collapsing internal whitespace changes
    // nothing on either side.
    const onlyIndentation =
      normaliseWhitespace(matched) === normaliseWhitespace(oldStr) &&
      matched.replace(/^[ \t]+/gm, "") === oldStr.replace(/^[ \t]+/gm, "");

    return {
      ok: true,
      match: {
        strategy: onlyIndentation && quotedIndent !== actualIndent ? "indentation" : "whitespace",
        start,
        end,
        matched,
        adjustedReplacement: reindent(newStr, quotedIndent, actualIndent),
        confidence: 0.9,
      },
    };
  }

  if (windowMatches.length > 1) {
    return {
      ok: false,
      failure: {
        reason: "ambiguous",
        occurrences: windowMatches.length,
        bestStrategy: "whitespace",
        nearest: windowMatches.slice(0, 5).map((i) => ({
          line: i + 1,
          text: (contentLines[i] ?? "").trim().slice(0, 100),
        })),
      },
    };
  }

  // ---- 4. anchored ---------------------------------------------------------

  const meaningful = oldLines.filter((l) => l.trim().length > 0);
  if (meaningful.length >= MIN_ANCHOR_LINES) {
    const firstAnchor = meaningful[0]!.trim();
    const lastAnchor = meaningful[meaningful.length - 1]!.trim();

    /*
     * Only the opening anchor has to be distinctive.
     *
     * The first version required both to be substantial, which silently
     * disabled this entire rung for every brace language: a block's closing
     * line is `}` or `)` or `end`, and a one-character anchor never cleared the
     * bar. The rung existed and could not fire.
     *
     * The opening line is the locator and must be a real fingerprint. The
     * closing one only has to terminate the span, and it is already protected
     * twice over — the search window is bounded relative to the quoted length,
     * and the interior must clear the similarity floor before the span is
     * accepted at all.
     */
    if (firstAnchor.length >= MIN_ANCHOR_LINE_LENGTH && lastAnchor.length > 0) {
      const starts: number[] = [];
      for (let i = 0; i < contentLines.length; i++) {
        if (contentLines[i]!.trim() === firstAnchor) starts.push(i);
      }

      const spans: { startLine: number; endLine: number; similarity: number }[] = [];
      for (const s of starts) {
        // The closing anchor is looked for within a window proportional to the
        // target's own length: a block that was quoted as twelve lines is not
        // two hundred lines long in the file, and searching to end-of-file
        // invites a match on the next unrelated closing brace.
        const limit = Math.min(contentLines.length - 1, s + oldLines.length * 3 + 10);
        for (let e = s + 1; e <= limit; e++) {
          if (contentLines[e]!.trim() !== lastAnchor) continue;
          const similarity = lineSimilarity(
            contentLines.slice(s, e + 1),
            oldLines,
          );
          if (similarity >= ANCHOR_SIMILARITY_FLOOR) {
            spans.push({ startLine: s, endLine: e, similarity });
          }
          break; // nearest closing anchor only
        }
      }

      if (spans.length === 1) {
        const { startLine, endLine, similarity } = spans[0]!;
        const start = offsets[startLine]!;
        const end = offsets[endLine]! + contentLines[endLine]!.length;
        const quotedIndent = indentOf(meaningful[0]!);
        const actualIndent = indentOf(contentLines[startLine]!);

        return {
          ok: true,
          match: {
            strategy: "anchored",
            start,
            end,
            matched: content.slice(start, end),
            adjustedReplacement: reindent(newStr, quotedIndent, actualIndent),
            confidence: similarity,
          },
        };
      }

      if (spans.length > 1) {
        return {
          ok: false,
          failure: {
            reason: "ambiguous",
            occurrences: spans.length,
            bestStrategy: "anchored",
            nearest: spans.slice(0, 5).map((s) => ({
              line: s.startLine + 1,
              text: (contentLines[s.startLine] ?? "").trim().slice(0, 100),
            })),
          },
        };
      }
    }
  }

  // ---- nothing worked ------------------------------------------------------

  /*
   * Fail with directions, not just a refusal.
   *
   * The model's next move after a failed edit is to re-read the file, which is
   * a full round trip and a large tool result. Naming the lines that most
   * resemble the target usually removes the need: nine times in ten the anchor
   * is right there with a different indent or a renamed variable, and the
   * model can correct it without reading anything.
   */
  return { ok: false, failure: { reason: "not_found", ...nearestLines(contentLines, oldLines) } };
}

/** Longest a hint line is quoted, and the whole hint's budget. */
const HINT_LINE_MAX = 800;
const HINT_TOTAL_MAX = 2_400;

/** A file line as a hint quotes it: whole, unless it is very long. */
function hintText(line: string): string {
  const text = line.trimEnd();
  return text.length > HINT_LINE_MAX ? `${text.slice(0, HINT_LINE_MAX)} [... line continues]` : text;
}

/**
 * The file lines most similar to the target's first meaningful line, as a hint
 * after a failed match.
 *
 * Quoted whole (23 Oct 2026). Lines were clipped at 100 characters, and a
 * stale 209-character table row failed three times in a row: the hint pointed
 * at the right line but cut it off before the part that had changed, so the
 * model had nothing to copy and retried the same old_str. The best candidate
 * also brings the lines after it, as many as old_str spans, so a multi-line
 * target can be re-quoted from the message alone.
 */
function nearestLines(
  contentLines: string[],
  oldLines: string[],
): { nearest: { line: number; text: string }[]; region?: { line: number; text: string }[] } {
  const probe = oldLines.find((l) => l.trim().length > 3)?.trim();
  if (!probe) return { nearest: [] };

  // Distinctive fragments of the probe, longest first: an identifier is a far
  // better locator than a keyword.
  const tokens = [...new Set(probe.split(/[^A-Za-z0-9_$]+/).filter((t) => t.length >= 4))]
    .sort((a, b) => b.length - a.length)
    .slice(0, 6);
  if (tokens.length === 0) return { nearest: [] };

  const scored: { index: number; hits: number }[] = [];
  for (let i = 0; i < contentLines.length; i++) {
    const line = contentLines[i]!;
    const hits = tokens.filter((t) => line.includes(t)).length;
    if (hits > 0) scored.push({ index: i, hits });
  }
  const top = scored.sort((a, b) => b.hits - a.hits).slice(0, 3);
  const nearest = top.map(({ index }) => ({ line: index + 1, text: hintText(contentLines[index]!) }));
  const best = top[0];
  if (!best || oldLines.length < 2) return { nearest };

  const region: { line: number; text: string }[] = [];
  let spent = 0;
  for (let i = best.index; i < Math.min(contentLines.length, best.index + oldLines.length); i++) {
    const text = hintText(contentLines[i]!);
    if (region.length > 0 && spent + text.length > HINT_TOTAL_MAX) break;
    region.push({ line: i + 1, text });
    spent += text.length;
  }
  return { nearest, region };
}

/**
 * An edit the file already has, and the line its text starts on.
 *
 * Two shapes of the same thing: `new_str` is in the file and `old_str` is not
 * (a replacement made earlier), or `old_str` is in the file only inside the one
 * copy of `new_str` (an insertion made earlier — new_str is old_str with lines
 * added). A model that lost its place re-sends edits it already made (30 Oct
 * 2026: four edits to factory.js sent three times). The first shape failed as
 * "not found", which reads as a broken edit and invites a retry; the second
 * matched again and put in a second copy of a method.
 *
 * A replacement only counts when `new_str` is real evidence: two non-blank
 * lines or a long one, found once. A short line that happens to be in the file
 * says nothing about whether this edit was made.
 */
export function alreadyApplied(content: string, oldStr: string, newStr: string): { line: number } | null {
  if (!newStr.trim() || !oldStr || newStr === oldStr) return null;
  const copies = allIndexes(content, newStr);
  if (copies.length !== 1) return null;
  const start = copies[0]!;
  const olds = allIndexes(content, oldStr);
  if (!olds.every((at) => at >= start && at + oldStr.length <= start + newStr.length)) return null;
  if (olds.length === 0) {
    const lines = newStr.split("\n").filter((l) => l.trim()).length;
    if (lines < 2 && newStr.trim().length < 60) return null;
  }
  return { line: content.slice(0, start).split("\n").length };
}

/**
 * The note attached to a non-exact match.
 *
 * Written for the model *and* the user, because both need it for different
 * reasons: the model should learn that its anchor was imprecise, and the user
 * should know an edit was placed by similarity rather than by identity.
 */
export function describeMatch(match: EditMatch): string | null {
  switch (match.strategy) {
    case "exact":
      return null;
    case "whitespace":
      return "Matched ignoring whitespace differences — the target text differed from the file only in spacing.";
    case "indentation":
      return "Matched at a different indentation than quoted; the replacement was re-indented to fit.";
    case "anchored":
      return (
        `Matched by its first and last lines with ${Math.round(match.confidence * 100)}% ` +
        `line similarity in between. Check the diff: the span replaced was located by ` +
        `resemblance, not by an exact match.`
      );
  }
}

/** The message for a failed match, with whatever directions were found. */
export function describeFailure(path: string, failure: EditMatchFailure): string {
  if (failure.reason === "ambiguous") {
    const where = (failure.nearest ?? [])
      .map((n) => `  line ${n.line}: ${n.text}`)
      .join("\n");
    return (
      `old_str matches ${failure.occurrences} places in '${path}', so the edit is ambiguous. ` +
      `Include more surrounding lines to make it unique.\n` +
      (where ? `\nMatches at:\n${where}` : "")
    );
  }

  const quote = (lines: { line: number; text: string }[]) =>
    lines.map((n) => `  line ${n.line}: ${n.text}`).join("\n");
  const head =
    `old_str was not found in '${path}', even after allowing for whitespace, indentation, ` +
    `and first/last-line anchoring.\n`;
  const nearest = failure.nearest ?? [];
  if (nearest.length === 0) return head + `\nRead the file and quote the target exactly as it appears.`;

  // The best candidate, whole (with the lines after it for a multi-line
  // target), then the runners-up. The file has changed since old_str was
  // written when the best candidate is close but not equal: say so, because
  // retrying the same old_str is the failure this message exists to prevent.
  const best = failure.region && failure.region.length > 0 ? failure.region : nearest.slice(0, 1);
  const others = nearest.slice(1);
  return (
    head +
    `\nThe file's closest text, quoted whole as it is now:\n${quote(best)}\n` +
    (others.length > 0 ? `\nOther candidates:\n${quote(others)}\n` : "") +
    `\nIf that is the text you meant, it has changed since you last read it: copy old_str from the ` +
    `quote above character for character (without the "line N: " prefix). Do not retry the same old_str.`
  );
}
