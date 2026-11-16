import { describe, expect, it, vi } from "vitest";
import { createSerialQueue } from "./serial-queue.js";

/** A handler that takes a controllable amount of time, and records overlap. */
function trackingHandler(delayMs = 5) {
  const order: string[] = [];
  let active = 0;
  let maxActive = 0;
  const handler = async (item: string) => {
    active++;
    maxActive = Math.max(maxActive, active);
    await new Promise((r) => setTimeout(r, delayMs));
    order.push(item);
    active--;
  };
  return { handler, order, get maxActive() { return maxActive; } };
}

describe("serial queue", () => {
  /*
   * The whole point. Three lines arriving in the same tick — which is exactly
   * what a pipe delivers — must run one after another, not all at once.
   */
  it("never runs two items concurrently", async () => {
    const t = trackingHandler();
    const q = createSerialQueue(t.handler);
    q.push("a");
    q.push("b");
    q.push("c");
    await q.drain();
    expect(t.maxActive).toBe(1);
  });

  it("preserves the order they arrived in", async () => {
    const t = trackingHandler();
    const q = createSerialQueue(t.handler);
    for (const s of ["one", "two", "three"]) q.push(s);
    await q.drain();
    expect(t.order).toEqual(["one", "two", "three"]);
  });

  /*
   * `close` fires the moment stdin ends, which for a pipe is before any queued
   * work has run. Exiting there truncated the session, so `drain()` has to
   * resolve only when the queue is genuinely empty.
   */
  it("drain waits for everything queued", async () => {
    const t = trackingHandler(10);
    const q = createSerialQueue(t.handler);
    q.push("a");
    q.push("b");
    await q.drain();
    expect(t.order).toHaveLength(2);
    expect(q.pending).toBe(0);
  });

  it("drain resolves immediately when there is nothing to do", async () => {
    const q = createSerialQueue(async () => undefined);
    await expect(q.drain()).resolves.toBeUndefined();
  });

  it("two callers join the same drain rather than racing", async () => {
    const t = trackingHandler(10);
    const q = createSerialQueue(t.handler);
    q.push("a");
    q.push("b");
    await Promise.all([q.drain(), q.drain()]);
    expect(t.order).toEqual(["a", "b"]);
    expect(t.maxActive).toBe(1);
  });

  it("picks up items pushed while it is already draining", async () => {
    const seen: string[] = [];
    const q = createSerialQueue(async (item: string) => {
      seen.push(item);
      if (item === "a") q.push("late");
    });
    q.push("a");
    await q.drain();
    expect(seen).toEqual(["a", "late"]);
  });

  /*
   * In a REPL one bad command must not wedge every command after it.
   */
  it("keeps going after a handler throws", async () => {
    const seen: string[] = [];
    const onError = vi.fn();
    const q = createSerialQueue(async (item: string) => {
      if (item === "bad") throw new Error("nope");
      seen.push(item);
    }, onError);
    q.push("good");
    q.push("bad");
    q.push("also good");
    await q.drain();
    expect(seen).toEqual(["good", "also good"]);
    expect(onError).toHaveBeenCalledTimes(1);
  });

  it("reports how many are waiting", async () => {
    const q = createSerialQueue(async () => {
      await new Promise((r) => setTimeout(r, 10));
    });
    q.push("a");
    q.push("b");
    q.push("c");
    // One in flight, two still queued.
    expect(q.pending).toBe(2);
    await q.drain();
    expect(q.pending).toBe(0);
  });
});
