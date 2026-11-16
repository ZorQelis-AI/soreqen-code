/**
 * One owner of stdin, and where each line goes.
 *
 * ## The bug this exists to fix
 *
 * The REPL held a `readline` interface on `process.stdin` for the life of the
 * session. `promptConfirmation` then opened a **second** one on the same
 * stdin for every approval, and closed it afterwards.
 *
 * Two readline interfaces on one stream both receive every line. So typing
 * `y` at an approval prompt did two things at once: it resolved the
 * confirmation, *and* the REPL's own handler took `"y"` as a new user prompt
 * and queued an entire agent turn to answer it. With several approvals in a
 * turn the interfaces accumulated, and a single keypress registered two or
 * three times — which is exactly how it was reported.
 *
 * `rl.pause()` on the outer interface is not a fix. Pausing stops the *flow*
 * but the second interface resumes the same underlying stream the moment it
 * attaches, and on a pipe the input has already been buffered and re-emitted
 * before any of it takes effect.
 *
 * So there is exactly one reader, here, and it decides where a line goes.
 * Nothing else may attach to stdin.
 *
 * ## Why this is a module and not four lines in the REPL
 *
 * The rule it encodes — *when an approval is open, a typed line answers it
 * rather than starting a turn* — is a consent decision. It deserves a name, a
 * home and a test that does not need a terminal, a model or a sandbox.
 */

/** A question waiting for an answer. */
interface PendingAsk {
  resolve(answer: string): void;
  /** When the question was actually put on screen. Used to tell an answer
   *  from something typed before there was anything to answer. */
  askedAt: number;
}

export interface InputRouter {
  /** Every line from the single readline interface goes here. */
  accept(line: string): void;
  /**
   * Put a question and wait for the next line that counts as its answer.
   *
   * Only one may be open at a time — approvals are sequential by design, so a
   * second concurrent ask is a bug in the caller rather than a case to handle.
   */
  ask(prompt: string): Promise<string>;
  /** True while an approval is on screen. */
  readonly awaitingAnswer: boolean;
  /** Abandon the open question, answering it with the empty string — which
   *  every caller reads as "not approved". For Ctrl-C and for teardown. */
  cancelAsk(): void;
}

export interface RouterOptions {
  /** Where an ordinary line goes: the serial queue that runs turns. */
  onPrompt(line: string): void;
  /** Write the question to the terminal. Separated so the routing rule can be
   *  tested without stdout. */
  write(text: string): void;
  /**
   * How long after a question appears a line is still treated as type-ahead
   * rather than as an answer. See `isAnswer` for what this is for.
   */
  typeAheadGraceMs?: number;
  /** Told when a line was discarded, so the user is not left wondering where
   *  their keystroke went. Silence is what makes input bugs unfalsifiable. */
  onDiscarded?(line: string, reason: string): void;
}

/**
 * Whether a line that arrived while a question was open should be taken as
 * the answer to it.
 *
 * ## The decision, and why it is not obvious
 *
 * A line can reach an open approval prompt two ways, and they mean opposite
 * things:
 *
 *   - The person **read the prompt and typed a reply.** That is an answer,
 *     and taking it is the entire point.
 *
 *   - The line was **already in the buffer** — typed ahead while the agent was
 *     working, before the approval existed. Terminals deliver that the instant
 *     a reader attaches, so it is indistinguishable from an answer except by
 *     timing. Taking it means a queued "yes" — or a stray Return, or the next
 *     thing they meant to ask — silently authorises a command nobody saw.
 *
 * `askedAt` is the only evidence available: how long after the question
 * appeared the line arrived. A line arriving within a few milliseconds cannot
 * have been read and typed by a human.
 *
 * ## The rule
 *
 * It is deliberately **asymmetric**, because the two mistakes are not equally
 * expensive. Discarding a real "no" costs one re-typed keystroke. Accepting a
 * buffered "yes" runs a command the person never saw. So:
 *
 *   - Anything that is **not an approval** — a refusal, a bare Return, a line
 *     that is neither — is taken immediately, whatever the timing. None of
 *     them authorises anything: `promptConfirmation` reads every one of them
 *     as "no", and a prompt-default of no is only useful if it is prompt.
 *
 *   - An **approval** must arrive after the grace period. That is the only
 *     case where being wrong grants a permission, so it is the only case that
 *     pays for the check.
 *
 * Erring toward re-asking is the safe direction, and the caller re-asks.
 */
export function isAnswer(elapsedMs: number, line: string, graceMs: number): boolean {
  const approves = /^y(es)?$/i.test(line.trim());
  if (!approves) return true;
  return elapsedMs >= graceMs;
}

export function createInputRouter(options: RouterOptions): InputRouter {
  const graceMs = options.typeAheadGraceMs ?? 120;
  let pending: PendingAsk | null = null;

  return {
    get awaitingAnswer() {
      return pending !== null;
    },

    accept(line: string): void {
      if (pending) {
        const elapsed = Date.now() - pending.askedAt;
        if (isAnswer(elapsed, line, graceMs)) {
          const { resolve } = pending;
          // Cleared *before* resolving, so a caller that immediately asks
          // again does not see a stale question still open.
          pending = null;
          resolve(line);
          return;
        }
        options.onDiscarded?.(
          line,
          "arrived too soon after the prompt to be a reply to it; approvals are never auto-answered by type-ahead",
        );
        return;
      }
      options.onPrompt(line);
    },

    ask(prompt: string): Promise<string> {
      if (pending) {
        throw new Error(
          "An approval is already open. Confirmations are sequential; a second concurrent ask is a bug.",
        );
      }
      options.write(prompt);
      return new Promise<string>((resolve) => {
        pending = { resolve, askedAt: Date.now() };
      });
    },

    cancelAsk(): void {
      if (!pending) return;
      const { resolve } = pending;
      pending = null;
      resolve("");
    },
  };
}
