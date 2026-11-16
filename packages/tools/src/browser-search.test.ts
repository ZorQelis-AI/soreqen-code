import { afterEach, describe, expect, it, vi } from "vitest";
import { BrowserSearch } from "./browser-search.js";

/**
 * A browser whose pages load, then never answer `evaluate` and never close:
 * a page whose scripts keep its tab busy. Deep research waited on four of
 * these for hours (reported 29 Oct 2026), because a read held its page slot
 * until the page answered and closed, and there are three slots.
 */
function stuckBrowser(answer: () => Promise<unknown>): BrowserSearch {
  const b = new BrowserSearch("unused-profile");
  const context = {
    newPage: async () => ({
      goto: async () => null,
      waitForLoadState: async () => undefined,
      evaluate: answer,
      close: () => new Promise(() => undefined),
    }),
    close: async () => undefined,
    on: () => undefined,
  };
  (b as unknown as { open: () => Promise<unknown> }).open = async () => context;
  return b;
}

const never = () => new Promise(() => undefined);

afterEach(() => {
  vi.useRealTimers();
});

describe("BrowserSearch.read", () => {
  it("gives up on pages that never answer, and their slots are free again afterwards", async () => {
    vi.useFakeTimers();
    let stuck = true;
    const b = stuckBrowser(() => (stuck ? never() : Promise.resolve({ title: "ok", text: "the page" })));

    // Four reads, three slots: the fourth waits behind three that never finish.
    const reads = [1, 2, 3, 4].map((i) => b.read(`https://example.com/${i}`));
    await vi.advanceTimersByTimeAsync(65_000);
    expect(await Promise.all(reads)).toEqual([null, null, null, null]);

    // No slot was stranded: a page that answers is read.
    stuck = false;
    const next = b.read("https://example.com/ok");
    await vi.advanceTimersByTimeAsync(1_000);
    expect(await next).toEqual({ title: "ok", text: "the page" });
  });

  it("stops at once when the turn is stopped", async () => {
    const b = stuckBrowser(never);
    const stop = new AbortController();
    const started = Date.now();
    const read = b.read("https://example.com/slow", stop.signal);
    setTimeout(() => stop.abort(), 20);
    expect(await read).toBeNull();
    expect(Date.now() - started).toBeLessThan(2_000);
  });
});
