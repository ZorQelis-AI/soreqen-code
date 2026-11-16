/**
 * A plan left open by a stopped turn, carried into the next.
 *
 * Reported 24 Sep 2026: stop a turn with work left, say "continue", and the
 * to-do list was gone from the page — and the rule that a turn does not end
 * with items still open had silently stopped applying. And the opposite must
 * hold too: a finished plan never comes back.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { LocalSandboxRunner } from "@sqcode/sandbox-runner";
import type { StreamEvent, TodoItem } from "@sqcode/shared";
import { runAgentTurn } from "./agent-loop.js";
import { resetIndexes } from "./context/repo-index.js";
import type { LLMChatOptions, LLMProvider, LLMResponseChunk } from "./types.js";

function replies(...texts: string[]): LLMProvider & { calls: LLMChatOptions[] } {
  const calls: LLMChatOptions[] = [];
  return {
    name: "scripted",
    calls,
    async *chatStream(options): AsyncIterable<LLMResponseChunk> {
      calls.push(options);
      yield { type: "token", text: texts[Math.min(calls.length - 1, texts.length - 1)]! };
      yield { type: "stop", reason: "end_turn" };
    },
  };
}

const frameOf = (o: LLMChatOptions): string =>
  String([...o.messages].reverse().find((m) => typeof m.content === "string" && m.content.includes("## TASK STATE"))?.content ?? "");

describe("a plan carried over from a stopped turn", () => {
  const ws = `plan_ws_${Date.now()}`;
  let dir: string;
  let runner: LocalSandboxRunner;

  beforeEach(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "sqc_plan_"));
    runner = new LocalSandboxRunner(dir);
    await runner.createWorkspace(ws, { storagePath: dir });
  });

  afterEach(async () => {
    resetIndexes();
    await runner.destroyWorkspace(ws);
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });

  const open: TodoItem[] = [
    { id: "1", title: "Write the parser", status: "completed" },
    { id: "2", title: "Add the tests", status: "in_progress" },
    { id: "3", title: "Update the README", status: "pending" },
  ];

  it("is shown again at once, is in the working set, and still has to be finished", async () => {
    const events: StreamEvent[] = [];
    const provider = replies("All done.", "All done, really.");
    await runAgentTurn({
      workspaceId: ws,
      sessionId: "s_carry",
      mode: "bypass",
      userMessage: "continue",
      plan: open,
      sandboxRunner: runner,
      llmProvider: provider,
      onEvent: (e) => {
        events.push(e);
      },
    });

    // On the page before the model has said anything.
    const first = events.findIndex((e) => e.type === "todo_update");
    const firstStep = events.findIndex((e) => e.type === "step_start");
    expect(first).toBeGreaterThanOrEqual(0);
    expect(first).toBeLessThan(firstStep === -1 ? Infinity : firstStep);
    expect((events[first] as { items: TodoItem[] }).items.map((t) => t.status)).toEqual(["completed", "in_progress", "pending"]);

    // In front of the model, labelled as carried over.
    expect(frameOf(provider.calls[0]!)).toContain("Plan (still open from the turn the user stopped");
    expect(frameOf(provider.calls[0]!)).toContain("[pending] Update the README");

    // And held to: "All done." with items open is answered with the nudge.
    const second = provider.calls[1];
    expect(second).toBeDefined();
    expect(JSON.stringify(second!.messages)).toContain("unfinished item(s)");
  }, 30_000);

  it("is not carried when nothing on it is left to do", async () => {
    const events: StreamEvent[] = [];
    await runAgentTurn({
      workspaceId: ws,
      sessionId: "s_done",
      mode: "bypass",
      userMessage: "thanks",
      plan: open.map((t) => ({ ...t, status: "completed" as const })),
      sandboxRunner: runner,
      llmProvider: replies("You're welcome."),
      onEvent: (e) => {
        events.push(e);
      },
    });
    expect(events.some((e) => e.type === "todo_update")).toBe(false);
  }, 30_000);
});
