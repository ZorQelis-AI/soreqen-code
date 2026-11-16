/**
 * Carrying on with another model when the chosen one is overloaded.
 *
 * ## What happened before
 *
 * A 429 or 503 was retried against the same endpoint — ten attempts, backing
 * off to a minute between them. On a free tier during a busy hour that is a
 * turn standing still for several minutes, retrying something that is not
 * going to answer, while an equivalent model on the other plan is idle.
 *
 * ## What this does, and what it will not do
 *
 * When a request is refused for load *before any of its answer has arrived*,
 * the same request goes to the next route, and the overloaded one is benched
 * for a while so the steps after it do not queue behind it again. The switch
 * is announced — it becomes a line in the transcript — because the person
 * chose a model, and a different one answering must never be a secret.
 *
 * It never switches mid-answer: once a response has started streaming, an
 * error in it is the loop's to retry, because splicing two models' halves of
 * one response together would produce something neither of them said. And it
 * only ever switches on overload, never on a refusal or a bad request — those
 * would fail the same way anywhere.
 *
 * Which routes it may switch to is decided by whoever builds it (the gateway):
 * by default only the *same* model on another plan, so a person who picked a
 * model keeps that model.
 */

import type { LLMChatOptions, LLMProvider, LLMResponseChunk } from "./types.js";

export interface FailoverRoute {
  provider: LLMProvider;
  /** The model the provider is sent. */
  model: string;
  /** What a person calls it. */
  label: string;
}

/** How long an overloaded route is skipped before it is tried again. */
export const BENCH_MS = 90_000;

/** Refusals that mean "busy", not "wrong". */
export function isOverload(err: unknown): boolean {
  const status = (err as { status?: number })?.status;
  if (status === 429 || status === 503 || status === 529) return true;
  const message = String((err as { message?: string })?.message ?? err);
  return /\b(429|503|529)\b|rate.?limit|overloaded|too many requests|capacity/i.test(message);
}

/**
 * Routes benched for overload, until when. Shared by every instance: the
 * gateway builds a provider per turn, and a bench that reset each turn would
 * send the first step of every turn back into the same wall.
 */
const benchedUntil = new Map<string, number>();

/** For tests. */
export function resetFailoverBench(): void {
  benchedUntil.clear();
}

export class FailoverProvider implements LLMProvider {
  readonly name = "failover";
  private readonly benched = benchedUntil;
  /** The route that answered last, so only a change of route is announced. */
  private lastServed: string;

  constructor(
    private readonly primary: FailoverRoute,
    private readonly fallbacks: FailoverRoute[],
    private readonly now: () => number = Date.now,
  ) {
    this.lastServed = primary.label;
  }

  async *chatStream(options: LLMChatOptions): AsyncIterable<LLMResponseChunk> {
    const all = [this.primary, ...this.fallbacks];
    const t = this.now();
    // Benched routes go last rather than disappearing: if everything is
    // benched, trying the least-recently-failed beats failing outright.
    const order = [
      ...all.filter((r) => (this.benched.get(r.label) ?? 0) <= t),
      ...all.filter((r) => (this.benched.get(r.label) ?? 0) > t),
    ];

    let lastError: unknown;
    for (const [i, route] of order.entries()) {
      let started = false;
      try {
        const model = route === this.primary ? (options.model ?? route.model) : route.model;
        for await (const chunk of route.provider.chatStream({ ...options, model })) {
          if (!started && route.label !== this.lastServed) {
            yield {
              type: "model_fallback",
              from: this.lastServed,
              to: route.label,
              reason: lastError
                ? lastError instanceof Error
                  ? lastError.message
                  : String(lastError)
                : route === this.primary
                  ? "available again"
                  : "overloaded",
            };
          }
          if (!started) this.lastServed = route.label;
          started = true;
          yield chunk;
        }
        return;
      } catch (err) {
        if (started || options.signal?.aborted || !isOverload(err) || i === order.length - 1) throw err;
        this.benched.set(route.label, this.now() + BENCH_MS);
        lastError = err;
      }
    }
    throw lastError;
  }
}
