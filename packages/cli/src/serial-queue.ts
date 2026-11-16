/**
 * One at a time, in order.
 *
 * ## The bug this exists to prevent
 *
 * `readline`'s "line" event is fire-and-forget: it does not await an async
 * handler. So every line typed while a turn is running starts *another* turn
 * concurrently, and both read and write the same conversation history — last
 * writer wins, silently discarding the other's turn.
 *
 * `rl.pause()` inside the handler does not fix it. When stdin is a pipe the
 * entire input arrives in one chunk and readline emits every line event
 * synchronously, before any `await` has had a chance to yield. A piped session
 * therefore ran all its prompts at once, and a trailing `/exit` called
 * `process.exit` before any had finished — printing the banner and nothing
 * else. That is how the problem was found; interactively it was quieter and
 * worse, because typing ahead corrupted history instead of queueing.
 *
 * Extracted from the REPL so the ordering rule is testable without a terminal,
 * a model, or a sandbox — none of which have anything to do with it.
 */

export interface SerialQueue<T> {
  /** Accept an item. Returns immediately; work happens in order, in the
   *  background. */
  push(item: T): void;
  /** Resolves when everything queued so far — including anything pushed while
   *  draining — has been handled. */
  drain(): Promise<void>;
  /** Items waiting, not counting the one in flight. */
  readonly pending: number;
}

/**
 * A queue that runs `handler` over pushed items strictly one at a time.
 *
 * A handler that throws does not stop the queue: in a REPL one bad command
 * must not wedge every command after it. The error is passed to `onError` and
 * the queue carries on.
 */
export function createSerialQueue<T>(
  handler: (item: T) => Promise<void>,
  onError?: (error: unknown, item: T) => void,
): SerialQueue<T> {
  const items: T[] = [];
  let running: Promise<void> | null = null;

  const run = (): Promise<void> => {
    // A second caller joins the in-flight drain rather than starting a
    // competing loop — two loops would defeat the entire point.
    if (running) return running;
    running = (async () => {
      try {
        while (items.length > 0) {
          const item = items.shift()!;
          try {
            await handler(item);
          } catch (err) {
            onError?.(err, item);
          }
        }
      } finally {
        running = null;
      }
    })();
    return running;
  };

  return {
    push(item: T) {
      items.push(item);
      void run();
    },
    drain() {
      return run();
    },
    get pending() {
      return items.length;
    },
  };
}
