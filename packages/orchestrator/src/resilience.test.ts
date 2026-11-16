/**
 * Stopping, and trying again.
 *
 * Both of these are easy to write in a way that looks right and is not. Retry
 * that cannot tell transient from settled turns a clear 401 into a slow 401.
 * Cancellation that only sets a flag leaves the expensive work running. So the
 * tests here are mostly about the boundaries, not the happy path.
 */

import { describe, expect, it, vi } from "vitest";
import { TurnCancelledError, delay, isRetryable, throwIfCancelled, withRetry } from "./resilience.js";

const err = (props: Record<string, unknown>): Error => Object.assign(new Error("boom"), props);

describe("classifying failures", () => {
  it("retries the ones that pass on their own", () => {
    for (const status of [408, 409, 429, 500, 502, 503, 504]) {
      expect(isRetryable(err({ status })), `status ${status}`).toBe(true);
    }
  });

  /*
   * The important half. A 401 fails identically every time; retrying it three
   * times makes a clear error slow, and to the provider it looks like someone
   * probing credentials.
   */
  it("does not retry the ones that will never succeed", () => {
    for (const status of [400, 401, 403, 404, 422]) {
      expect(isRetryable(err({ status })), `status ${status}`).toBe(false);
    }
  });

  it("recognises network failures by message", () => {
    for (const m of ["ECONNRESET", "socket hang up", "ETIMEDOUT", "network error", "rate limit"]) {
      expect(isRetryable(new Error(m)), m).toBe(true);
    }
  });

  it("never retries a cancellation", () => {
    expect(isRetryable(new TurnCancelledError())).toBe(false);
  });

  it("never retries a deliberate abort", () => {
    expect(isRetryable(err({ name: "AbortError" }))).toBe(false);
  });

  /*
   * Asymmetric on purpose: retrying something permanent costs seconds, while
   * refusing to retry something temporary throws away the whole accumulated
   * turn — which is the expensive thing an agent owns.
   */
  it("treats an unrecognised failure as worth retrying", () => {
    expect(isRetryable(new Error("something nobody has seen before"))).toBe(true);
  });
});

describe("withRetry", () => {
  it("returns the first success without waiting", async () => {
    const fn = vi.fn(async () => "ok");
    expect(await withRetry(fn)).toBe("ok");
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("retries a transient failure and then succeeds", async () => {
    let calls = 0;
    const fn = vi.fn(async () => {
      calls++;
      if (calls < 3) throw err({ status: 503 });
      return "recovered";
    });
    expect(await withRetry(fn, { baseDelayMs: 1 })).toBe("recovered");
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it("gives up after the configured number of attempts", async () => {
    const fn = vi.fn(async () => {
      throw err({ status: 500 });
    });
    await expect(withRetry(fn, { attempts: 2, baseDelayMs: 1 })).rejects.toThrow();
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it("fails immediately on a permanent error", async () => {
    const fn = vi.fn(async () => {
      throw err({ status: 401 });
    });
    await expect(withRetry(fn, { baseDelayMs: 1 })).rejects.toThrow();
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("reports each retry, so a caller can say 'retrying' rather than hang", async () => {
    const onRetry = vi.fn();
    let calls = 0;
    await withRetry(
      async () => {
        calls++;
        if (calls < 2) throw err({ status: 429 });
        return "ok";
      },
      { baseDelayMs: 1, onRetry },
    );
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  /*
   * Without jitter, every client that hit the same rate limit retries at the
   * same instant and recreates the burst that caused it.
   */
  it("does not use an identical delay every time", async () => {
    const delays: number[] = [];
    for (let i = 0; i < 6; i++) {
      let calls = 0;
      await withRetry(
        async () => {
          calls++;
          if (calls < 2) throw err({ status: 429 });
          return "ok";
        },
        { baseDelayMs: 100, onRetry: (_a, d) => delays.push(d) },
      );
    }
    expect(new Set(delays).size).toBeGreaterThan(1);
  });

  it("stops immediately when cancelled mid-backoff", async () => {
    const controller = new AbortController();
    const fn = vi.fn(async () => {
      controller.abort();
      throw err({ status: 503 });
    });
    await expect(
      withRetry(fn, { baseDelayMs: 5_000, signal: controller.signal }),
    ).rejects.toBeInstanceOf(TurnCancelledError);
    // One attempt, then the backoff wakes early rather than sleeping 5s.
    expect(fn).toHaveBeenCalledTimes(1);
  });
});

describe("cancellation", () => {
  it("does nothing when there is no signal", () => {
    expect(() => throwIfCancelled(undefined)).not.toThrow();
  });

  it("does nothing while the signal is live", () => {
    expect(() => throwIfCancelled(new AbortController().signal)).not.toThrow();
  });

  it("throws once aborted", () => {
    const c = new AbortController();
    c.abort();
    expect(() => throwIfCancelled(c.signal)).toThrow(TurnCancelledError);
  });

  it("wakes a sleeping delay rather than waiting it out", async () => {
    const c = new AbortController();
    const started = Date.now();
    const p = delay(10_000, c.signal);
    c.abort();
    await expect(p).rejects.toBeInstanceOf(TurnCancelledError);
    expect(Date.now() - started).toBeLessThan(1_000);
  });

  it("rejects straight away if already aborted", async () => {
    const c = new AbortController();
    c.abort();
    await expect(delay(10_000, c.signal)).rejects.toBeInstanceOf(TurnCancelledError);
  });
});
