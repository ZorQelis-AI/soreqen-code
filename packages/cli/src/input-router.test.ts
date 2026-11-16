/**
 * The routing rule, tested without a terminal.
 *
 * Every case here corresponds to something that was actually reported: a `y`
 * that registered two or three times, and an approval that could be answered
 * by whatever happened to be sitting in the terminal buffer.
 */

import { describe, expect, it, vi } from "vitest";
import { createInputRouter, isAnswer } from "./input-router.js";

describe("isAnswer", () => {
  it("takes an approval only after the grace period", () => {
    // Faster than a human could read the prompt: this is buffered type-ahead.
    expect(isAnswer(5, "y", 120)).toBe(false);
    expect(isAnswer(119, "yes", 120)).toBe(false);
    // Slow enough to have been read and typed.
    expect(isAnswer(120, "y", 120)).toBe(true);
    expect(isAnswer(3_000, "yes", 120)).toBe(true);
  });

  it("takes a refusal immediately, however fast it arrived", () => {
    /*
     * The asymmetry is the point. Discarding a real "no" costs a keystroke;
     * accepting a buffered "yes" runs a command nobody saw. Only one of those
     * is worth a delay.
     */
    expect(isAnswer(0, "n", 120)).toBe(true);
    expect(isAnswer(0, "", 120)).toBe(true);
    expect(isAnswer(0, "no", 120)).toBe(true);
    expect(isAnswer(0, "what is this", 120)).toBe(true);
  });

  it("is not fooled by whitespace or case around an approval", () => {
    expect(isAnswer(0, "  Y  ", 120)).toBe(false);
    expect(isAnswer(0, "YES", 120)).toBe(false);
  });
});

describe("createInputRouter", () => {
  const base = { onPrompt: () => {}, write: () => {} };

  it("sends an ordinary line to the prompt handler", () => {
    const onPrompt = vi.fn();
    const router = createInputRouter({ ...base, onPrompt });

    router.accept("fix the login bug");

    expect(onPrompt).toHaveBeenCalledWith("fix the login bug");
  });

  it("does not also queue the answer as a new prompt", async () => {
    /*
     * The reported bug, exactly.
     *
     * With two readline interfaces on one stdin, typing `y` at an approval
     * both approved the action *and* started an agent turn to answer the
     * question "y". One reader, one destination.
     */
    const onPrompt = vi.fn();
    const router = createInputRouter({ ...base, onPrompt, typeAheadGraceMs: 0 });

    const answer = router.ask("Allow? ");
    router.accept("y");

    await expect(answer).resolves.toBe("y");
    expect(onPrompt).not.toHaveBeenCalled();
  });

  it("refuses to auto-approve from the terminal buffer", async () => {
    const onDiscarded = vi.fn();
    const router = createInputRouter({ ...base, onDiscarded, typeAheadGraceMs: 10_000 });

    const answer = router.ask("Allow? ");
    router.accept("y"); // arrives instantly — cannot have been read

    expect(onDiscarded).toHaveBeenCalledOnce();
    // Still open, waiting for a real answer.
    expect(router.awaitingAnswer).toBe(true);

    router.cancelAsk();
    await expect(answer).resolves.toBe("");
  });

  it("routes lines back to prompts once the question is answered", async () => {
    const onPrompt = vi.fn();
    const router = createInputRouter({ ...base, onPrompt, typeAheadGraceMs: 0 });

    const answer = router.ask("Allow? ");
    router.accept("y");
    await answer;

    router.accept("now do the next thing");
    expect(onPrompt).toHaveBeenCalledWith("now do the next thing");
  });

  it("answers a cancelled question with a refusal rather than hanging", async () => {
    // Ctrl-C at an approval. Without this the promise never settles and the
    // turn waits for ever on a question nobody can reach.
    const router = createInputRouter(base);
    const answer = router.ask("Allow? ");

    router.cancelAsk();

    await expect(answer).resolves.toBe("");
    expect(router.awaitingAnswer).toBe(false);
  });

  it("treats a second concurrent question as a bug in the caller", () => {
    const router = createInputRouter(base);
    void router.ask("Allow? ");
    expect(() => router.ask("Allow this other thing? ")).toThrow(/already open/i);
  });
});
