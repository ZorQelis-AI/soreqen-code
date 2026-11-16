import { defineConfig } from "vitest/config";

/**
 * A timeout for what these tests do: they start real servers, processes and
 * browsers. Vitest's five seconds held alone and failed with every package
 * testing at once (16 Oct 2026), the same contention `orchestrator`'s config
 * describes. Thirty seconds is where a test is hung, not queued.
 */
export default defineConfig({
  test: {
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
