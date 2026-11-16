/**
 * Unified diffs.
 *
 * ## What was wrong with the previous one
 *
 * It walked both files with two cursors and, whenever the lines differed,
 * emitted the old one and the new one and advanced both. That is correct only
 * while the two files stay in lock-step. The moment a line is **inserted** or
 * **deleted**, the cursors are permanently offset and every remaining line
 * compares unequal — so a one-line insertion at the top of a file rendered as
 * a complete rewrite: every line removed, every line re-added, in an
 * interleaved `-`/`+` stack.
 *
 * Observed live: adding a single JSDoc comment above a three-line function
 * produced a ten-line diff in which nothing was recognisably unchanged. That
 * is the worst possible failure for this particular output, because the diff
 * is what a person reads to decide whether to approve a change. A diff that
 * says everything changed is a diff nobody reads, and an unread diff is an
 * approval given blind.
 *
 * It also emitted no `@@` hunk headers, so every consumer that derives line
 * numbers from them — the widget's diff viewer, most notably — had nothing to
 * derive from, and the whole file was one undifferentiated block.
 *
 * ## How it works now
 *
 * Three steps, in increasing cost, and most edits never reach the third:
 *
 *   1. **Trim the common prefix and suffix.** A typical edit changes a handful
 *      of lines in the middle of a file, so this alone reduces the problem to
 *      a few lines and costs one linear scan.
 *   2. **Longest common subsequence** on what remains, which is the standard
 *      way to align two sequences and the thing that lets the walk *re-sync*
 *      after an insertion instead of giving up.
 *   3. **Give up gracefully** if the differing region is enormous — see
 *      `MAX_LCS_CELLS`. A whole-file replacement is an honest description of a
 *      whole-file rewrite, and is far better than spending a second of CPU to
 *      say the same thing more precisely.
 *
 * Output is real unified format: `@@ -old,count +new,count @@` hunks with
 * three lines of context, which is what every diff tool, review UI and human
 * expects.
 */

/** Context lines around each change. Three is the universal default and what
 *  every reader's eye is calibrated to. */
const CONTEXT = 3;

/**
 * Ceiling on the LCS table.
 *
 * The dynamic program is O(n·m) in time and memory. After prefix/suffix
 * trimming the differing region is usually tiny, but a genuine whole-file
 * rewrite of a large file would allocate hundreds of millions of cells and
 * stall the turn. Four million is roughly a 2000×2000 region — far past any
 * real edit — and beyond it the fallback says the same thing in one hunk.
 */
const MAX_LCS_CELLS = 4_000_000;

type Op = { kind: "same" | "add" | "remove"; line: string };

/** Line-level LCS backtrace. Standard DP; the table is only allocated for the
 *  trimmed middle, which is what keeps it affordable. */
function diffLines(a: string[], b: string[]): Op[] {
  const n = a.length;
  const m = b.length;

  if (n === 0) return b.map((line) => ({ kind: "add" as const, line }));
  if (m === 0) return a.map((line) => ({ kind: "remove" as const, line }));

  if (n * m > MAX_LCS_CELLS) {
    return [
      ...a.map((line) => ({ kind: "remove" as const, line })),
      ...b.map((line) => ({ kind: "add" as const, line })),
    ];
  }

  // table[i][j] = LCS length of a[i:] and b[j:]
  const table: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      table[i]![j] = a[i] === b[j] ? table[i + 1]![j + 1]! + 1 : Math.max(table[i + 1]![j]!, table[i]![j + 1]!);
    }
  }

  const ops: Op[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      ops.push({ kind: "same", line: a[i]! });
      i++;
      j++;
    } else if (table[i + 1]![j]! >= table[i]![j + 1]!) {
      ops.push({ kind: "remove", line: a[i]! });
      i++;
    } else {
      ops.push({ kind: "add", line: b[j]! });
      j++;
    }
  }
  while (i < n) ops.push({ kind: "remove", line: a[i++]! });
  while (j < m) ops.push({ kind: "add", line: b[j++]! });

  return ops;
}

interface Hunk {
  oldStart: number;
  oldCount: number;
  newStart: number;
  newCount: number;
  lines: string[];
}

/** Group the operation list into hunks with context, dropping the long runs
 *  of unchanged lines between them. */
function toHunks(ops: Op[]): Hunk[] {
  const changed = ops
    .map((op, index) => (op.kind === "same" ? -1 : index))
    .filter((index) => index >= 0);
  if (changed.length === 0) return [];

  // Merge changes that are within 2*CONTEXT of each other, so two edits three
  // lines apart share one hunk rather than producing overlapping context.
  const ranges: { from: number; to: number }[] = [];
  for (const index of changed) {
    const last = ranges[ranges.length - 1];
    if (last && index - last.to <= CONTEXT * 2) last.to = index;
    else ranges.push({ from: index, to: index });
  }

  const hunks: Hunk[] = [];
  for (const range of ranges) {
    const from = Math.max(0, range.from - CONTEXT);
    const to = Math.min(ops.length - 1, range.to + CONTEXT);

    // Line numbers are 1-based and count only the lines each side actually has.
    let oldLine = 1;
    let newLine = 1;
    for (let k = 0; k < from; k++) {
      const op = ops[k]!;
      if (op.kind !== "add") oldLine++;
      if (op.kind !== "remove") newLine++;
    }

    const lines: string[] = [];
    let oldCount = 0;
    let newCount = 0;
    for (let k = from; k <= to; k++) {
      const op = ops[k]!;
      if (op.kind === "same") {
        lines.push(` ${op.line}`);
        oldCount++;
        newCount++;
      } else if (op.kind === "remove") {
        lines.push(`-${op.line}`);
        oldCount++;
      } else {
        lines.push(`+${op.line}`);
        newCount++;
      }
    }

    /*
     * A side with no lines is numbered from the line *before* the change.
     *
     * That is the unified-diff convention — a new file is `@@ -0,0 +1,N @@` —
     * and the one every diff reader, including the widget's, parses. Starting
     * an empty side at 1 claimed the change was inserted after a line that did
     * not exist.
     */
    hunks.push({
      oldStart: oldCount === 0 ? oldLine - 1 : oldLine,
      oldCount,
      newStart: newCount === 0 ? newLine - 1 : newLine,
      newCount,
      lines,
    });
  }

  return hunks;
}

export function createUnifiedDiff(
  filePath: string,
  oldContent: string,
  newContent: string,
): string {
  if (oldContent === newContent) return "";

  /*
   * An empty file has no lines, not one empty line.
   *
   * `"".split(/\r?\n/)` is `[""]`, so creating a file used to render as
   * "removed a blank line, added the content": a `-` row with nothing on it at
   * the top of every new file's diff, and a header claiming the file had one
   * line before it existed. The same applies to the final newline almost every
   * file ends with, which split into a phantom empty last line and showed up as
   * a trailing `+` blank on every new file.
   */
  const toLines = (content: string): string[] =>
    content === "" ? [] : content.replace(/\r?\n$/, "").split(/\r?\n/);
  const oldLines = toLines(oldContent);
  const newLines = toLines(newContent);

  /*
   * Trim the parts that are identical at both ends before doing any real work.
   *
   * A normal edit touches a few lines in a file of hundreds, so this reduces
   * an expensive alignment to a cheap one, and it also guarantees the hunk
   * headers land where a reader expects rather than at line 1.
   */
  let prefix = 0;
  while (
    prefix < oldLines.length &&
    prefix < newLines.length &&
    oldLines[prefix] === newLines[prefix]
  ) {
    prefix++;
  }

  let suffix = 0;
  while (
    suffix < oldLines.length - prefix &&
    suffix < newLines.length - prefix &&
    oldLines[oldLines.length - 1 - suffix] === newLines[newLines.length - 1 - suffix]
  ) {
    suffix++;
  }

  const ops: Op[] = [
    ...oldLines.slice(0, prefix).map((line) => ({ kind: "same" as const, line })),
    ...diffLines(
      oldLines.slice(prefix, oldLines.length - suffix),
      newLines.slice(prefix, newLines.length - suffix),
    ),
    ...oldLines.slice(oldLines.length - suffix).map((line) => ({ kind: "same" as const, line })),
  ];

  const hunks = toHunks(ops);
  if (hunks.length === 0) return "";

  const out: string[] = [`--- a/${filePath}`, `+++ b/${filePath}`];
  for (const hunk of hunks) {
    out.push(
      `@@ -${hunk.oldStart},${hunk.oldCount} +${hunk.newStart},${hunk.newCount} @@`,
      ...hunk.lines,
    );
  }
  return out.join("\n");
}
