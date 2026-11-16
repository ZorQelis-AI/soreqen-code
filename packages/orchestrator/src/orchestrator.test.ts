import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SoreQenOrchestrator } from "./orchestrator.js";

/*
 * A fresh install has no model key in its environment. The orchestrator used
 * to build its default provider in the constructor, which threw "No LLM API
 * key configured" while the desktop runtime was still starting: it died
 * before it listened, and the app showed "127.0.0.1 refused to connect" on
 * every such computer (3 Oct 2026, a beta laptop and both macOS builds). This
 * machine has a key set globally, so nothing here ever saw it.
 */
const KEYS = ["OPENCODE_API_KEY", "MIMO_API_KEY", "OPENAI_API_KEY"];

describe("SoreQenOrchestrator without a model key", () => {
  const saved: Record<string, string | undefined> = {};
  beforeEach(() => {
    for (const k of KEYS) {
      saved[k] = process.env[k];
      delete process.env[k];
    }
  });
  afterEach(() => {
    for (const k of KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  it("starts: the missing key is not the server's problem", () => {
    expect(() => new SoreQenOrchestrator()).not.toThrow();
  });

  it("makes the missing key the error of the first model call, not of startup", async () => {
    const orchestrator = new SoreQenOrchestrator();
    // The provider it would use when a turn brings none of its own.
    const provider = (orchestrator as unknown as { llmProvider: { name: string; chatStream: (o: unknown) => AsyncIterable<unknown> } }).llmProvider;
    expect(provider.name).toBe("openai_compatible");
    const first = async () => {
      for await (const _ of provider.chatStream({ messages: [{ role: "user", content: "hi" }] })) break;
    };
    await expect(first()).rejects.toThrow(/No LLM API key/);
  });
});
