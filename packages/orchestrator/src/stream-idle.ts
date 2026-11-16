/**
 * A model stream that has gone quiet, noticed.
 *
 * Its own module so everything that reads a model stream can use it: the agent
 * loop, and the research engine's own requests (research-agent.ts), which
 * waited on a silent stream for ever (reported 29 Oct 2026: deep research
 * "stuck for hours" after finding its sources).
 */

export class StreamStalledError extends Error {
  constructor(idleMs: number) {
    const seconds = Math.round(idleMs / 1000);
    super(
      `The model sent nothing for ${seconds >= 120 ? `${Math.round(seconds / 60)} minutes` : `${seconds} seconds`}.`,
    );
    this.name = "StreamStalledError";
  }
}

/** The stream was being waited on when the turn was stopped. */
export class StreamStoppedError extends Error {
  constructor() {
    super("Stopped while waiting for the model.");
    this.name = "StreamStoppedError";
  }
}

/**
 * The chunks of `stream`, or a `StreamStalledError` once none has arrived for
 * `idleMs`.
 *
 * A provider's request timeout stops counting when the response headers
 * arrive. After that, a connection that goes quiet — a proxy that dropped it
 * without closing it, an upstream that hung mid-generation — waits for ever,
 * and so did the turn: no error, no retry, a spinner until someone gave up.
 * `abort` closes the stalled request so the retry does not leave it open.
 *
 * The timer runs only while waiting on the stream. Time the caller spends
 * handling a chunk is not the model being silent.
 */
export async function* withIdleTimeout<T>(
  stream: AsyncIterable<T>,
  idleMs: number,
  abort: () => void,
  /**
   * Stop waiting the moment this aborts. Aborting the request should end the
   * stream, and usually does; a stream that keeps the loop waiting anyway is
   * a Stop that takes effect when it pleases (29 Oct 2026).
   */
  stop?: AbortSignal,
): AsyncGenerator<T> {
  const iterator = stream[Symbol.asyncIterator]();
  let finished = false;
  try {
    for (;;) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      let onStop: (() => void) | undefined;
      const stalled = new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new StreamStalledError(idleMs)), idleMs);
        if (stop) {
          onStop = () => reject(new StreamStoppedError());
          if (stop.aborted) onStop();
          else stop.addEventListener("abort", onStop, { once: true });
        }
      });
      let next: IteratorResult<T>;
      try {
        next = await Promise.race([iterator.next(), stalled]);
      } catch (err) {
        if (err instanceof StreamStalledError || err instanceof StreamStoppedError) abort();
        throw err;
      } finally {
        clearTimeout(timer);
        if (onStop) stop?.removeEventListener("abort", onStop);
      }
      if (next.done) {
        finished = true;
        return;
      }
      yield next.value;
    }
  } finally {
    // Not awaited: a stalled source cannot be waited on to finish.
    if (!finished) void Promise.resolve(iterator.return?.()).catch(() => undefined);
  }
}
