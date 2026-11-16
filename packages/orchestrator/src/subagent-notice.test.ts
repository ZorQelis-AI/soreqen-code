/**
 * A sub-agent that finishes tells the lead agent (15 Oct 2026): its report
 * arrives at the next step, and a `wait` ends for it, with no
 * subagent_status call in between.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { LocalSandboxRunner } from "@sqcode/sandbox-runner";
import { runAgentTurn } from "./agent-loop.js";
import { NARRATED_AT, NarrationWatch } from "./narration.js";
import type { LLMChatOptions, LLMProvider, LLMResponseChunk } from "./types.js";

const text = (o: LLMChatOptions): string => JSON.stringify(o.messages);

/** Delegates, then waits; the sub-agent answers after a moment. */
class Delegating implements LLMProvider {
  name = "delegating";
  requests: LLMChatOptions[] = [];
  async *chatStream(options: LLMChatOptions): AsyncIterable<LLMResponseChunk> {
    if (text(options).includes("[SUB-AGENT ROLE")) {
      // Long enough that the lead is in its wait first, even on a loaded machine.
      await new Promise((r) => setTimeout(r, 2_500));
      yield { type: "token", text: "Result: the cache key ignores the tenant (src/cache.ts:12)." };
      yield { type: "stop", reason: "end_turn" };
      return;
    }
    this.requests.push(options);
    const step = this.requests.length;
    if (step === 1) {
      yield { type: "tool_call_start", id: "spawn", name: "spawn_subagent" };
      yield { type: "tool_call_complete", id: "spawn", name: "spawn_subagent", input: {
          role: "explorer",
          task_prompt:
            "Find why the cache serves one tenant's data to another. Read src/cache.ts and its callers, and report the line where the key is built and what it leaves out.",
          done_when: "The line that builds the cache key is named, with what it omits.",
        },
      };
      yield { type: "stop", reason: "tool_use" };
    } else if (step === 2) {
      yield { type: "tool_call_start", id: "w", name: "wait" };
      yield { type: "tool_call_complete", id: "w", name: "wait", input: { seconds: 30 } };
      yield { type: "stop", reason: "tool_use" };
    } else {
      yield { type: "token", text: "The cache key ignores the tenant; that is the leak." };
      yield { type: "stop", reason: "end_turn" };
    }
  }
}

describe("a sub-agent finishing", () => {
  let dir: string;
  let runner: LocalSandboxRunner;
  const ws = `subnote_${Date.now()}`;
  beforeEach(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "sqcode_subnote_"));
    runner = new LocalSandboxRunner(dir);
    await runner.createWorkspace(ws, { storagePath: dir });
  });
  afterEach(async () => {
    await runner.destroyWorkspace(ws);
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });

  it("ends the lead agent's wait and hands it the report, unasked", async () => {
    const provider = new Delegating();
    const result = await runAgentTurn({
      workspaceId: ws,
      sessionId: "s_subnote",
      mode: "bypass",
      effort: "max",
      userMessage: "Find out why tenants see each other's cached data.",
      sandboxRunner: runner,
      llmProvider: provider,
    });

    expect(result.stopReason).toBe("completed");
    // The 30-second wait ended when the sub-agent did: its result says why (a clock is no proof on a loaded machine).
    const after = text(provider.requests[2]!);
    expect(after).toContain('\\"reason\\":\\"news\\"');
    expect(after).toContain("[Sub-agent finished]");
    expect(after).toContain("the cache key ignores the tenant (src/cache.ts:12)");
    // Never had to ask.
    const calls = provider.requests.flatMap((r) => r.messages.flatMap((m) => m.toolCalls ?? []).map((c) => c.name));
    expect(calls).not.toContain("subagent_status");
  }, 60_000);
});

describe("a line before every call", () => {
  it("is pointed out once, after a run of narrated steps; a quiet step ends the run", () => {
    const watch = new NarrationWatch();
    for (let i = 1; i < NARRATED_AT; i++) expect(watch.observe(`Now doing step ${i}.`, 1)).toBeNull();
    expect(watch.observe("Re-running the tests to confirm the fix.", 1)).toMatch(/repeat the rows/);
    for (let i = 0; i < NARRATED_AT * 2; i++) expect(watch.observe("Still narrating.", 1)).toBeNull();

    const quiet = new NarrationWatch();
    for (let i = 0; i < NARRATED_AT * 3; i++) {
      expect(quiet.observe(i % 3 === 2 ? "" : "A line.", 1)).toBeNull();
    }
    // The final answer, with no calls, never counts.
    expect(quiet.observe("Here is what I found.", 0)).toBeNull();
  });
});
