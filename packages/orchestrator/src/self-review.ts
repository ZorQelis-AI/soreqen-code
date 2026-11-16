/**
 * The agent reading its own diff before it says it is done.
 *
 * ## What verification does not cover
 *
 * `self-healer.ts` proves the code compiles. `test-selector.ts` proves the
 * tests that cover it still pass. Neither answers the question a reviewer asks
 * first: **is this the change that was requested, and only that change?**
 *
 * A turn can typecheck, pass its tests, and still have left a `console.log` in,
 * renamed a variable in an unrelated file, deleted a comment it did not
 * understand, weakened an assertion to make something green, or solved a
 * different problem from the one described. Those are the review comments a
 * human writes, every time, and none of them is detectable by a compiler.
 *
 * ## Why one extra call is cheap here
 *
 * It runs once, at the end of a turn that has already cost fifteen or twenty
 * model calls, and it reads a diff rather than a codebase. Against the cost of
 * shipping a change that a reviewer sends back, or worse, does not, it is close
 * to free.
 *
 * ## Why it is a separate call and not an instruction
 *
 * "Check your work before finishing" in the system prompt is advice the model
 * gives itself while holding the entire transcript of its own reasoning — the
 * conditions under which it is least able to see the change from outside. A
 * fresh call, given the original request and the final diff and nothing else,
 * is the closest thing available to a second opinion. It cannot rationalise
 * from intermediate steps it never saw.
 *
 * ## Two rules that stop it being noise
 *
 * **It reports concerns, it does not rewrite.** The verdict goes back into the
 * loop as evidence and the agent decides. A reviewer that edits the code it is
 * reviewing is not a reviewer.
 *
 * **It runs once per turn.** A review of the fix produced in response to a
 * review is a second opinion on a second opinion, and the pattern where an
 * agent keeps finding one more thing is how a turn stops terminating.
 */

import type { SandboxRunner } from "@sqcode/sandbox-runner";
import { commandPath } from "./checkpoint.js";
import type { LLMProvider } from "./types.js";
import { withRetry } from "./resilience.js";

/** Diff lines sent for review. A very large diff is summarised by truncation
 *  rather than skipped: reviewing the first part of a change is worth more
 *  than reviewing none of it, and the note says what was cut. */
const MAX_DIFF_LINES = 600;

/** The review is a small, bounded call. If it has not answered in this long,
 *  finishing the turn matters more than the opinion. */
const REVIEW_TIMEOUT_MS = 60_000;

export interface ReviewVerdict {
  /** True when the reviewer found nothing worth raising. */
  clean: boolean;
  /** Specific, actionable objections. Empty when clean. */
  concerns: string[];
  /** False when the review could not run at all — no diff, no provider, an
   *  error. Distinguished from `clean` so a turn never reports "reviewed" for
   *  a review that did not happen. */
  ran: boolean;
  note?: string;
}

const REVIEW_SYSTEM = `You are reviewing a code change produced by an autonomous agent.

You are given the request the agent was working on, and the complete diff of what
it changed. You have not seen its reasoning, and that is deliberate — judge the
diff, not the intent behind it.

Report only things a careful reviewer would actually raise in a pull request:

- The change does not do what was asked, or only does part of it.
- It does something that was NOT asked: an unrelated file touched, a rename or
  refactor nobody requested, a formatting sweep mixed into a fix.
- Debug output, commented-out code, or a temporary hack left behind.
- A test weakened, skipped, or deleted to make something pass.
- An obvious bug the compiler would not catch: an inverted condition, an
  off-by-one, a swapped argument, an unhandled error path that was handled
  before, a secret or credential written into source.

Do NOT report: style preferences, naming you would have chosen differently,
missing tests for code that already has them elsewhere, speculative refactors,
or anything you would preface with "consider".

Answer in exactly this format and nothing else:

VERDICT: OK
or
VERDICT: CONCERNS
- <one concern per line, each naming the file and what is wrong with it>

If the diff does what the request asked and nothing else, say VERDICT: OK. Most
correct changes get VERDICT: OK — saying so is the useful answer, not a missed
opportunity to find something.`;

/** Trim a diff to a reviewable size, keeping whole files where possible. */
function trimDiff(diff: string): { text: string; truncated: boolean } {
  const lines = diff.split("\n");
  if (lines.length <= MAX_DIFF_LINES) return { text: diff, truncated: false };
  return { text: lines.slice(0, MAX_DIFF_LINES).join("\n"), truncated: true };
}

/**
 * Parse the verdict.
 *
 * Tolerant of a model that adds a preamble or wraps the answer in a code
 * fence, because a review that is thrown away on a formatting deviation is a
 * review that silently stops working the day the model is changed. The one
 * thing it will not do is guess: a response with no recognisable verdict is
 * reported as "did not run" rather than as clean.
 */
export function parseVerdict(raw: string): ReviewVerdict {
  const text = raw.replace(/```[a-z]*\n?/gi, "").trim();
  const hasOk = /VERDICT:\s*OK\b/i.test(text);
  const hasConcerns = /VERDICT:\s*CONCERNS?\b/i.test(text);

  if (!hasOk && !hasConcerns) {
    return {
      clean: false,
      concerns: [],
      ran: false,
      note: "the reviewer's answer could not be parsed",
    };
  }

  if (hasOk && !hasConcerns) {
    return { clean: true, concerns: [], ran: true };
  }

  const after = text.slice(text.search(/VERDICT:\s*CONCERNS?/i));
  const concerns = after
    .split("\n")
    .slice(1)
    .map((l) => l.replace(/^\s*[-*•]\s*/, "").trim())
    .filter((l) => l.length > 3);

  if (concerns.length === 0) {
    // Said CONCERNS and listed none. Treat as clean rather than blocking the
    // turn on a malformed answer — the alternative is a turn that cannot end.
    return { clean: true, concerns: [], ran: true, note: "reviewer listed no specific concerns" };
  }

  return { clean: false, concerns, ran: true };
}

export interface SelfReviewOptions {
  runner: SandboxRunner;
  workspaceId: string;
  llmProvider: LLMProvider;
  model?: string;
  /** What the user asked for, verbatim. */
  request: string;
  /** The turn's own diff. When a checkpoint was taken this is the diff against
   *  it, which is exactly this turn's work; otherwise the workspace diff,
   *  which may include changes the agent did not make. */
  diff: string;
  signal?: AbortSignal;
}

/**
 * Review a completed turn's diff.
 *
 * Never throws. A review that fails is reported as not-run and the turn
 * finishes, because a quality check that can break a working turn is a net
 * negative however good its opinions are.
 */
export async function reviewOwnDiff(options: SelfReviewOptions): Promise<ReviewVerdict> {
  const diff = options.diff.trim();
  if (!diff) {
    return { clean: true, concerns: [], ran: false, note: "no changes to review" };
  }

  const { text, truncated } = trimDiff(diff);

  const userContent =
    `REQUEST:\n${options.request.slice(0, 4_000)}\n\n` +
    `DIFF:\n${text}\n` +
    (truncated
      ? `\n[Diff truncated at ${MAX_DIFF_LINES} lines. Review what is shown.]\n`
      : "");

  try {
    const timeout = AbortSignal.timeout(REVIEW_TIMEOUT_MS);
    const signal = options.signal
      ? AbortSignal.any([options.signal, timeout])
      : timeout;

    const answer = await withRetry(
      async () => {
        let out = "";
        const stream = options.llmProvider.chatStream({
          step: "review",
          system: REVIEW_SYSTEM,
          messages: [{ role: "user", content: userContent }],
          // No tools. The reviewer reads the diff it was given and nothing
          // else; a reviewer that can go looking becomes a second agent.
          model: options.model,
          temperature: 0,
          signal,
        });
        for await (const chunk of stream) {
          if (chunk.type === "token") out += chunk.text;
        }
        return out;
      },
      { attempts: 2 },
    );

    return parseVerdict(answer);
  } catch (err: unknown) {
    return {
      clean: false,
      concerns: [],
      ran: false,
      note: `the review could not be completed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

/** What goes back to the agent when the reviewer raises something. */
export function reviewFeedback(verdict: ReviewVerdict): string {
  return [
    "A review of your own diff raised the following, before this turn is finished:",
    "",
    ...verdict.concerns.map((c) => `  - ${c}`),
    "",
    "Address each one, or explain in your summary why it is not a problem. Do not",
    "silently ignore any of them. If you disagree with a point, say so and why —",
    "the review is evidence, not an instruction.",
  ].join("\n");
}

/**
 * The diff of this turn alone.
 *
 * Taken against the turn's checkpoint when there is one, which is the only way
 * to get *this turn's* changes rather than everything uncommitted in the
 * workspace. Reviewing a diff that includes the user's own in-progress work
 * produces objections about code the agent never touched, which is the fastest
 * way to make a reviewer worth ignoring.
 */
export async function diffSinceCheckpoint(
  runner: SandboxRunner,
  workspaceId: string,
  checkpointId: string | null,
): Promise<string> {
  try {
    if (checkpointId) {
      const res = await runner.execCommand(workspaceId, {
        command:
          `git --git-dir="${commandPath(runner, workspaceId, ".soreqen/checkpoints.git")}" --work-tree=. ` +
          `-c core.hooksPath=/dev/null diff ${checkpointId}`,
        timeoutMs: 30_000,
      });
      if (res.exitCode === 0) return res.stdout ?? "";
    }
    return await runner.getDiff(workspaceId);
  } catch {
    return "";
  }
}
