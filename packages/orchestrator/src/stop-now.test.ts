/**
 * Stop takes effect when it is pressed (reported 29 Oct 2026: "when I click
 * Stop it takes some time first").
 *
 * A tool was awaited to its end, so a turn stopped only when the slowest tool
 * in the step noticed the signal. These use tools that never notice it at all.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { LocalSandboxRunner } from "@sqcode/sandbox-runner";
import { runAgentTurn } from "./agent-loop.js";
import { MockLLMProvider } from "./llm-provider.js";
import type { ExternalTools } from "./external-tools.js";
import { untilCancelled, TurnCancelledError } from "./resilience.js";
import { withIdleTimeout } from "./stream-idle.js";

describe("untilCancelled", () => {
  it("rejects the moment the signal aborts, though the work never ends", async () => {
    const stop = new AbortController();
    const waiting = untilCancelled(new Promise(() => undefined), stop.signal);
    setTimeout(() => stop.abort(), 10);
    await expect(waiting).rejects.toBeInstanceOf(TurnCancelledError);
  });

  it("passes the work's own result and error through", async () => {
    const stop = new AbortController();
    await expect(untilCancelled(Promise.resolve(7), stop.signal)).resolves.toBe(7);
    await expect(untilCancelled(Promise.reject(new Error("tool failed")), stop.signal)).rejects.toThrow("tool failed");
  });
});

describe("withIdleTimeout with a stop signal", () => {
  it("stops waiting on a stream that does not end when its request is aborted", async () => {
    async function* deaf() {
      yield 1;
      await new Promise(() => undefined);
    }
    const stop = new AbortController();
    let aborted = false;
    const seen: number[] = [];
    setTimeout(() => stop.abort(), 20);
    await expect(
      (async () => {
        for await (const n of withIdleTimeout(deaf(), 60_000, () => (aborted = true), stop.signal)) seen.push(n);
      })(),
    ).rejects.toThrow("Stopped while waiting");
    expect(seen).toEqual([1]);
    expect(aborted).toBe(true);
  });
});

describe("a turn stopped during a tool that ignores the signal", () => {
  it("ends at once, cancelled", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sqcode_stop_"));
    const runner = new LocalSandboxRunner(dir);
    await runner.createWorkspace("stop_ws", { storagePath: dir });
    let started = false;
    const tools: ExternalTools = {
      definitions: () => [{ name: "mcp__slow__wait", description: "Waits", input_schema: { type: "object", properties: {}, required: [] } }],
      describe: (name) => (name === "mcp__slow__wait" ? { server: "slow", tool: "wait", readOnly: true, declaredReadOnly: true, autoApproved: true } : undefined),
      // Never returns, and never looks at the signal it is given.
      call: () => {
        started = true;
        return new Promise(() => undefined);
      },
    };
    const provider = new MockLLMProvider([
      { text: "", toolCalls: [{ id: "w1", name: "mcp__slow__wait", input: {} }], stopReason: "tool_use" as const },
      { text: "Done.", stopReason: "end_turn" as const },
    ]);
    const stop = new AbortController();
    const turn = runAgentTurn({
      workspaceId: "stop_ws",
      sessionId: "s_stop_now",
      mode: "auto",
      userMessage: "wait for it",
      sandboxRunner: runner,
      llmProvider: provider,
      externalTools: tools,
      signal: stop.signal,
    });
    while (!started) await new Promise((r) => setTimeout(r, 10));
    const pressed = Date.now();
    stop.abort();
    const result = await turn;
    expect(result.stopReason).toBe("cancelled");
    expect(Date.now() - pressed).toBeLessThan(1_500);
  }, 20_000);
});
