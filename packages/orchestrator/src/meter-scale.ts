/**
 * The context meter, in the provider's tokens.
 *
 * Everything that decides what to keep and when to checkpoint counts tokens
 * by estimate, 3.5 characters to the token, which errs high on purpose (see
 * `token-estimate.ts` in shared). A person reading the meter wants the
 * provider's number instead: a fresh session showed 28,700 when DeepSeek
 * counted about 23,000 for the same request (6 Nov 2026).
 *
 * Each response's usage says how many tokens the request really was; set
 * beside the estimate of that request, it gives the ratio for that model's
 * tokenizer. The meter is shown at that ratio. It is remembered per model for
 * as long as the process runs, so a new session's first reading is already
 * close, and moves smoothly as more requests are seen.
 */

/** Requests smaller than this say little about a tokenizer: a few framing tokens swamp them. */
const MIN_ESTIMATE = 2_000;
/** A ratio outside this is a usage report that does not mean what it seems to; it is ignored. */
const LOWEST = 0.5;
const HIGHEST = 1.6;
/** How much one new request moves the remembered ratio. */
const WEIGHT = 0.5;

export class MeterScale {
  private readonly ratios = new Map<string, number>();

  /** A request estimated at `estimate` tokens was counted as `reported` by the provider. */
  observe(model: string, estimate: number, reported: number): void {
    if (estimate < MIN_ESTIMATE || !(reported > 0)) return;
    const ratio = reported / estimate;
    if (ratio < LOWEST || ratio > HIGHEST) return;
    const before = this.ratios.get(model);
    this.ratios.set(model, before === undefined ? ratio : before * (1 - WEIGHT) + ratio * WEIGHT);
  }

  /** What to multiply an estimate by to show it in this model's tokens; 1 until a request has been seen. */
  factor(model: string): number {
    return this.ratios.get(model) ?? 1;
  }
}

/** One per process: every session on a model calibrates it for the others. */
export const meterScale = new MeterScale();
