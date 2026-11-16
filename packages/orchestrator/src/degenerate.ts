/**
 * A response that has started repeating itself, caught while it streams.
 *
 * Seen 13 Oct 2026 on GLM-5.3-flash at Apex: one reply wrote "The dump
 * settles it: 248068 is" (with its markdown drifting a little each time)
 * hundreds of times, until the output cap, as the person watched. Nothing was
 * wrong with any token on its own; the response as a whole was a loop.
 *
 * Measured, not guessed: the share of distinct short slices in the recent
 * text. Prose and code score close to 1, since almost every 24-character
 * slice of them occurs once. A loop with a period of p characters has at most
 * about p distinct slices however long it runs, so the share falls towards
 * zero. A loop of a few variants (the drifting markdown) is a few times p,
 * still far below anything written on purpose.
 */

/** How much recent text is judged. */
const WINDOW = 2_400;
/** Slice length. Long enough that ordinary repeated words do not count as repetition. */
const SHINGLE = 24;
/** Below this share of distinct slices, the text is a loop. */
const DISTINCT_FLOOR = 0.12;

export function isDegenerate(text: string): boolean {
  if (text.length < WINDOW) return false;
  const tail = text.slice(-WINDOW);
  const seen = new Set<string>();
  const total = tail.length - SHINGLE + 1;
  for (let i = 0; i < total; i++) seen.add(tail.slice(i, i + SHINGLE));
  return seen.size / total < DISTINCT_FLOOR;
}

/**
 * Checks a growing stream at most once per `every` new characters, so a long
 * response costs a handful of checks, not one per token.
 */
export class DegenerationWatch {
  private checkedAt = 0;
  constructor(private readonly every = 600) {}

  /** True once `text` (the whole stream so far) has become a loop. */
  check(text: string): boolean {
    if (text.length - this.checkedAt < this.every) return false;
    this.checkedAt = text.length;
    return isDegenerate(text);
  }
}

export class DegenerateOutputError extends Error {
  constructor(where: "reply" | "thinking") {
    super(`The model's ${where} started repeating the same words over and over.`);
    this.name = "DegenerateOutputError";
  }
}
