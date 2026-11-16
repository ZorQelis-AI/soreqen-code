/**
 * Giving up well, and trying again sensibly.
 *
 * Two failures the loop had no answer for:
 *
 *   - **Nothing could stop a turn.** There was no `AbortSignal` anywhere. A
 *     browser tab closing, a CLI `Ctrl-C`, a user clicking "stop" — none of
 *     them reached the agent, which carried on for up to 25 iterations,
 *     calling a paid API and writing to the user's workspace. On the embedded
 *     surface, where the tokens are billed to us, that is a closed tab that
 *     keeps spending.
 *   - **One dropped stream killed the turn.** A transient 429 or a reset
 *     connection propagated straight out of `runAgentTurn`, discarding a
 *     conversation that may have been twenty steps in. The expensive part of
 *     an agent turn is the context it has built, and throwing that away over a
 *     network blip is the most wasteful thing the loop could do.
 */

/** Thrown when a turn is stopped by its caller. Distinct from a failure,
 *  because a cancelled turn is a correct outcome and must not be reported as
 *  a crash. */
export class TurnCancelledError extends Error {
  constructor(message = "The turn was cancelled.") {
    super(message);
    this.name = "TurnCancelledError";
  }
}

/** Throws if the signal is already aborted. Called at each point where the
 *  loop is about to spend money or touch the workspace. */
export function throwIfCancelled(signal?: AbortSignal): void {
  if (signal?.aborted) throw new TurnCancelledError();
}

/**
 * `work`, or a `TurnCancelledError` the moment `signal` aborts: whichever is first.
 *
 * For waiting on work that may not listen to the signal itself. A tool was
 * awaited to its end, so Stop took as long as the slowest tool in the step
 * took to notice: a page that would not load, a server that would not
 * answer (reported 29 Oct 2026: "when I click Stop it takes some time first").
 * The work is not cancelled by this; it was handed the same signal and stops
 * in its own time. The turn just no longer waits for it. A call left without
 * a result is given one that says it was interrupted (`history.ts`).
 */
export function untilCancelled<T>(work: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return work;
  if (signal.aborted) {
    work.catch(() => undefined);
    return Promise.reject(new TurnCancelledError());
  }
  return new Promise<T>((resolve, reject) => {
    const stop = (): void => {
      work.catch(() => undefined);
      reject(new TurnCancelledError());
    };
    signal.addEventListener("abort", stop, { once: true });
    work.then(
      (value) => {
        signal.removeEventListener("abort", stop);
        resolve(value);
      },
      (err: unknown) => {
        signal.removeEventListener("abort", stop);
        reject(err);
      },
    );
  });
}

export interface RetryOptions {
  /** Total attempts, including the first. */
  attempts?: number;
  /** Delay before the second attempt; doubles thereafter. */
  baseDelayMs?: number;
  /** Ceiling on any single delay. */
  maxDelayMs?: number;
  signal?: AbortSignal;
  /** Called before each wait, so a caller can surface "retrying…" rather than
   *  appearing to hang. */
  onRetry?: (attempt: number, delayMs: number, error: unknown) => void;
}

const DEFAULTS = { attempts: 3, baseDelayMs: 1_000, maxDelayMs: 8_000 } as const;

/**
 * Is this worth trying again?
 *
 * The distinction that matters is **transient versus settled**. A 429 or a
 * dropped socket will very likely succeed on the next attempt. A 401, a 403 or
 * a malformed-request 400 will fail identically every time, and retrying it
 * three times turns a clear error into a slow one — while, for an auth
 * failure, also looking like a brute-force attempt from the provider's side.
 *
 * Unknown errors are treated as transient. The asymmetry is deliberate:
 * retrying something permanent costs a few seconds, while refusing to retry
 * something temporary throws away the whole accumulated turn.
 */
export function isRetryable(error: unknown): boolean {
  if (error instanceof TurnCancelledError) return false;

  const status =
    (error as { status?: number })?.status ?? (error as { statusCode?: number })?.statusCode;

  if (typeof status === "number") {
    if (status === 408 || status === 409 || status === 429) return true;
    if (status >= 500) return true;
    // Every other 4xx is the request's own fault and will not improve.
    if (status >= 400) return false;
  }

  const name = (error as { name?: string })?.name ?? "";
  if (name === "AbortError") return false;

  const message = String((error as { message?: string })?.message ?? error).toLowerCase();
  return (
    message.includes("econnreset") ||
    message.includes("etimedout") ||
    message.includes("econnrefused") ||
    message.includes("socket hang up") ||
    message.includes("network") ||
    message.includes("timeout") ||
    message.includes("overloaded") ||
    message.includes("rate limit") ||
    // Anything unrecognised: assume transient. See above.
    !("status" in ((error as object) ?? {}))
  );
}

/** Sleep that wakes early — and throws — if the turn is cancelled. */
export function delay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new TurnCancelledError());
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        reject(new TurnCancelledError());
      },
      { once: true },
    );
  });
}

/**
 * Run `fn`, retrying transient failures with exponential backoff and jitter.
 *
 * Jitter matters more than it looks. Without it, every session that hit the
 * same rate limit retries at the same instant, re-creating the burst that
 * caused it — the clients synchronise themselves into a thundering herd. A
 * random fraction of the delay is enough to break that up.
 */
export async function withRetry<T>(fn: () => Promise<T>, options?: RetryOptions): Promise<T> {
  const attempts = options?.attempts ?? DEFAULTS.attempts;
  const baseDelayMs = options?.baseDelayMs ?? DEFAULTS.baseDelayMs;
  const maxDelayMs = options?.maxDelayMs ?? DEFAULTS.maxDelayMs;

  let lastError: unknown;

  for (let attempt = 1; attempt <= attempts; attempt++) {
    throwIfCancelled(options?.signal);
    try {
      return await fn();
    } catch (err) {
      lastError = err;
      if (err instanceof TurnCancelledError) throw err;
      if (attempt === attempts || !isRetryable(err)) throw err;

      const backoff = Math.min(baseDelayMs * 2 ** (attempt - 1), maxDelayMs);
      const wait = Math.round(backoff * (0.5 + Math.random() * 0.5));
      options?.onRetry?.(attempt, wait, err);
      await delay(wait, options?.signal);
    }
  }

  throw lastError;
}
