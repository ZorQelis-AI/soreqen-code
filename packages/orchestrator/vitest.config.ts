import { defineConfig } from "vitest/config";

/**
 * A timeout that reflects what these tests actually do.
 *
 * Vitest's default is 5 seconds, which is generous for a unit test and tight
 * for `checkpoint.test.ts` — every case there drives a real `git` through
 * several subprocesses against a real temporary directory, and takes three to
 * five seconds on its own.
 *
 * Run alone the suite passed; run by `turbo run test`, with ten packages
 * testing at once and all of them contending for the same disk, three cases
 * crossed five seconds and failed. A suite that passes in isolation and fails
 * in CI is worse than one that fails honestly: the failure gets attributed to
 * whatever was being changed at the time, and eventually to nothing at all.
 *
 * Thirty seconds is not a licence for slow tests. It is the point past which a
 * git-driven test is genuinely hung rather than merely queued.
 */
export default defineConfig({
  test: {
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
