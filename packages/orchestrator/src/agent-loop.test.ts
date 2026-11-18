/**
 * The loop's promises about long, autonomous turns.
 *
 * Each case is one way a turn used to stop before the work was done — a step
 * cap, a dropped connection, a file too large for one response — or one way a
 * reload used to lose what the turn did.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { LocalSandboxRunner } from "@sqcode/sandbox-runner";
import type { StreamEvent } from "@sqcode/shared";
import {
  runAgentTurn,
  addresses,
  previewPartialInput,
  isContextOverflow,
  isTransientModelError,
  withIdleTimeout,
  MODEL_RETRY_SCHEDULE_MS,
  MAX_MODEL_ATTEMPTS,
  modelRetryDelayMs,
} from "./agent-loop.js";
import { MockLLMProvider } from "./llm-provider.js";
import { ProviderError } from "./openai-provider.js";
import type { LLMChatOptions, LLMMessage, LLMProvider, LLMResponseChunk, MessageMeta } from "./types.js";

type Script = (options: LLMChatOptions, call: number) => AsyncIterable<LLMResponseChunk>;

function scripted(script: Script): LLMProvider & { calls: LLMChatOptions[] } {
  const calls: LLMChatOptions[] = [];
  return {
    name: "scripted",
    calls,
    chatStream(options) {
      calls.push(options);
      return script(options, calls.length - 1);
    },
  };
}

describe("runAgentTurn", () => {
  const wsId = `loop_ws_${Date.now()}`;
  let runner: LocalSandboxRunner;
  let dir: string;

  beforeEach(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "sqcode_loop_"));
    runner = new LocalSandboxRunner(dir);
    await runner.createWorkspace(wsId, { storagePath: dir });
  });

  afterEach(async () => {
    await runner.destroyWorkspace(wsId);
    try {
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    } catch {
      // ignore
    }
  });

  it("keeps working past the step count that used to end every long turn", async () => {
    const steps = 40;
    const provider = new MockLLMProvider([
      ...Array.from({ length: steps }, (_, i) => ({
        text: `Looking at depth ${i}.`,
        toolCalls: [{ id: `ls_${i}`, name: "list_directory", input: { path: ".", max_depth: i + 1 } }],
        stopReason: "tool_use" as const,
      })),
      { text: "All done.", stopReason: "end_turn" as const },
    ]);

    const result = await runAgentTurn({
      workspaceId: wsId,
      sessionId: "s_long",
      mode: "bypass",
      effort: "high",
      userMessage: "Explore everything.",
      sandboxRunner: runner,
      llmProvider: provider,
    });

    expect(result.stopReason).toBe("completed");
    expect(result.toolCallsExecuted).toBe(steps);
    expect(result.finalResponse).toBe("All done.");
  }, 60_000);

  it("answers an unreadable call in words, warms up on repeats, and keeps going instead of stopping", async () => {
    // Ten identical unreadable writes (the 11 Oct GLM session), then the model takes another way.
    const provider = scripted(async function* (_options, call) {
      if (call < 9) {
        yield { type: "token", text: "Writing the oracle dump script now." };
        yield { type: "tool_call_start", id: `w${call}`, name: "write_file", index: 0 };
        yield { type: "tool_call_complete", id: `w${call}`, name: "write_file", input: {}, malformed: { raw: '{"path": "o.py", "content": "', error: "Unterminated string" } };
        yield { type: "stop", reason: "tool_use" };
        return;
      }
      if (call === 9) {
        yield { type: "tool_call_start", id: "ok", name: "write_file", index: 0 };
        yield { type: "tool_call_complete", id: "ok", name: "write_file", input: { path: "o.py", content: "print(1)\n" } };
        yield { type: "stop", reason: "tool_use" };
        return;
      }
      yield { type: "token", text: call === 10 ? "Wrote o.py." : "VERIFIED" };
      yield { type: "stop", reason: "end_turn" };
    });
    const events: StreamEvent[] = [];
    const result = await runAgentTurn({
      workspaceId: wsId,
      sessionId: "s_unreadable",
      mode: "bypass",
      effort: "high",
      userMessage: "Write the dump script.",
      sandboxRunner: runner,
      llmProvider: provider,
      onEvent: (e) => {
        events.push(e);
      },
    });

    expect(result.stopReason).toBe("completed");
    expect(fs.readFileSync(path.join(dir, "o.py"), "utf8")).toBe("print(1)\n");
    const first = events.find((e) => e.type === "tool_result" && e.callId === "w0") as { output: string } | undefined;
    expect(first?.output).toMatch(/^FAILED: Your write_file call's arguments could not be read as JSON/);
    expect(first?.output).not.toContain("invalid_type");
    // The second identical step onwards is sampled hotter than the tier's own temperature.
    const temps = provider.calls.map((c) => c.temperature ?? 0);
    expect(temps[2]!).toBeGreaterThan(temps[0]!);
    // And it was told, in words, at the third identical step.
    expect(provider.calls[3]!.messages.some((m) => typeof m.content === "string" && m.content.includes("exactly the same step 3 times"))).toBe(true);
  }, 60_000);

  it("ends a loop that never changes on the model's own report, not on an error", async () => {
    // 23 Oct 2026: "Stopped: the same step was taken 10 times in a row" must never end a turn.
    const provider = scripted(async function* (options, call) {
      const told = options.messages.some((m) => typeof m.content === "string" && m.content.includes("Do not call any tool now"));
      if (told) {
        yield { type: "token", text: "I was searching for the config and kept finding nothing. Where is it kept?" };
        yield { type: "stop", reason: "end_turn" };
        return;
      }
      yield { type: "token", text: "Searching again." };
      yield { type: "tool_call_start", id: `g${call}`, name: "list_directory", index: 0 };
      yield { type: "tool_call_complete", id: `g${call}`, name: "list_directory", input: { path: "." } };
      yield { type: "stop", reason: "tool_use" };
    });
    const events: StreamEvent[] = [];
    const result = await runAgentTurn({
      workspaceId: wsId,
      sessionId: "s_stuck",
      mode: "bypass",
      effort: "high",
      userMessage: "Find the config.",
      sandboxRunner: runner,
      llmProvider: provider,
      onEvent: (e) => {
        events.push(e);
      },
    });

    expect(result.stopReason).toBe("completed");
    expect(result.finalResponse).toBe("I was searching for the config and kept finding nothing. Where is it kept?");
    expect(events.some((e) => e.type === "error")).toBe(false);
    // Ten identical steps ran, and the eleventh was the report.
    expect(result.toolCallsExecuted).toBe(10);
  }, 60_000);

  it("does not run the calls of the step meant for the report", async () => {
    const provider = scripted(async function* (options, call) {
      yield { type: "tool_call_start", id: `g${call}`, name: "list_directory", index: 0 };
      yield { type: "tool_call_complete", id: `g${call}`, name: "list_directory", input: { path: "." } };
      yield { type: "stop", reason: "tool_use" };
    });
    const events: StreamEvent[] = [];
    const result = await runAgentTurn({
      workspaceId: wsId,
      sessionId: "s_stuck_still",
      mode: "bypass",
      effort: "high",
      userMessage: "Find the config.",
      sandboxRunner: runner,
      llmProvider: provider,
      onEvent: (e) => {
        events.push(e);
      },
    });

    expect(result.stopReason).toBe("completed");
    expect(result.finalResponse).toMatch(/^I kept taking the same step \(list_directory\)/);
    expect(events.some((e) => e.type === "error")).toBe(false);
    const last = events.filter((e) => e.type === "tool_result").at(-1) as { output: string } | undefined;
    expect(last?.output).toContain("Not run: this step was for telling the user where things stand");
  }, 60_000);

  it("stores every message it adds, with what a transcript needs to show it again", async () => {
    const provider = new MockLLMProvider([
      {
        text: "Creating the page.",
        toolCalls: [{ id: "w1", name: "write_file", input: { path: "index.html", content: "<h1>Hi</h1>\n" } }],
        stopReason: "tool_use",
      },
      /*
       * Two closing responses, one summary.
       *
       * A turn that changed a file is shown the record of what its tool calls
       * actually did, and checks the summary it wrote against it — see
       * `turn-ledger.ts`. The check says VERIFIED, so the summary is stored
       * once, as `final`. It used to be written, and stored, twice.
       */
      { text: "Created index.html.", stopReason: "end_turn" },
      { text: "VERIFIED", stopReason: "end_turn" },
    ]);

    const stored: { message: LLMMessage; meta: MessageMeta }[] = [];
    let n = 0;
    const result = await runAgentTurn({
      workspaceId: wsId,
      sessionId: "s_store",
      mode: "bypass",
      userMessage: "Make a page.",
      sandboxRunner: runner,
      llmProvider: provider,
      // About storage: a skill set aside before the write would take the scripted replies; see skills.test.ts.
      skills: { autoActivate: false },
      onMessage: (message, meta) => {
        stored.push({ message: { ...message }, meta });
        return `row_${n++}`;
      },
    });

    expect(result.persistFailures).toBe(0);
    const modelVisible = stored.filter((s) => !s.meta.displayOnly);
    expect(modelVisible.map((s) => s.message.role)).toEqual(["assistant", "tool", "assistant"]);

    const [call, output, final] = modelVisible;
    expect(final!.message.content).toBe("Created index.html.");
    expect(call!.message.content).toBe("Creating the page. ");
    expect(call!.message.toolCalls?.[0]?.name).toBe("write_file");
    expect(output!.meta).toMatchObject({ kind: "tool_result", toolName: "write_file", success: true });
    expect(output!.meta.diff?.unifiedDiff).toContain("+<h1>Hi</h1>");
    expect(final!.meta.kind).toBe("final");
    // Ids come back onto the messages, so a later summary can name them.
    expect(result.history.some((m) => m.id?.startsWith("row_"))).toBe(true);
  }, 30_000);

  it("announces a call while its arguments are still arriving, before it runs", async () => {
    const events: StreamEvent[] = [];
    const provider = scripted(async function* (_options, call) {
      if (call === 0) {
        yield { type: "tool_call_start", id: "w1", name: "write_file", index: 0 };
        yield { type: "tool_call_delta", id: "w1", index: 0, inputDelta: '{"path":"src/game.js",' };
        yield { type: "tool_call_delta", id: "w1", index: 0, inputDelta: '"content":"let score = 0;\\n"}' };
        yield { type: "tool_call_complete", id: "w1", name: "write_file", input: { path: "src/game.js", content: "let score = 0;\n" } };
        yield { type: "stop", reason: "tool_use" };
      } else {
        yield { type: "token", text: "Done." };
        yield { type: "stop", reason: "end_turn" };
      }
    });

    await runAgentTurn({
      workspaceId: wsId,
      sessionId: "s_pending",
      mode: "bypass",
      userMessage: "Write the game.",
      sandboxRunner: runner,
      llmProvider: provider,
      onEvent: (e) => {
        events.push(e);
      },
    });

    const pendingAt = events.findIndex((e) => e.type === "tool_call_pending" && e.preview?.["path"] === "src/game.js");
    const callAt = events.findIndex((e) => e.type === "tool_call");
    expect(pendingAt).toBeGreaterThan(-1);
    expect(pendingAt).toBeLessThan(callAt);
    expect(events.findIndex((e) => e.type === "step_start")).toBeLessThan(pendingAt);
  }, 30_000);

  it("retries a connection that drops mid-response, and keeps nothing from the failed attempt", async () => {
    const events: StreamEvent[] = [];
    const provider = scripted(async function* (_options, call) {
      if (call === 0) {
        yield { type: "token", text: "Half an ans" };
        throw new Error("terminated");
      }
      yield { type: "token", text: "The whole answer." };
      yield { type: "stop", reason: "end_turn" };
    });

    const result = await runAgentTurn({
      workspaceId: wsId,
      sessionId: "s_retry",
      mode: "plan",
      userMessage: "Explain.",
      sandboxRunner: runner,
      llmProvider: provider,
      onEvent: (e) => {
        events.push(e);
      },
    });

    expect(result.stopReason).toBe("completed");
    expect(result.finalResponse).toBe("The whole answer.");
    expect(events.some((e) => e.type === "model_retry")).toBe(true);
    expect(JSON.stringify(result.history)).not.toContain("Half an ans");
  }, 30_000);

  it("closes a response that goes silent and asks again, instead of waiting for ever", async () => {
    let closed = false;
    const provider = scripted((options, call) =>
      (async function* () {
        if (call === 0) {
          yield { type: "token", text: "Half a thou" } as LLMResponseChunk;
          // Silent until the loop gives up on it.
          await new Promise<void>((resolve) =>
            options.signal?.addEventListener(
              "abort",
              () => {
                closed = true;
                resolve();
              },
              { once: true },
            ),
          );
          return;
        }
        yield { type: "token", text: "Done." } as LLMResponseChunk;
        yield { type: "stop", reason: "end_turn" } as LLMResponseChunk;
      })(),
    );

    const events: StreamEvent[] = [];
    const result = await runAgentTurn({
      workspaceId: wsId,
      sessionId: "s_stall",
      mode: "bypass",
      effort: "low",
      userMessage: "Say done.",
      sandboxRunner: runner,
      llmProvider: provider,
      streamIdleMs: 60,
      onEvent: (event) => {
        events.push(event);
      },
    });

    expect(closed).toBe(true);
    expect(events.some((e) => e.type === "model_retry" && /sent nothing/.test(e.message))).toBe(true);
    expect(result.stopReason).toBe("completed");
    expect(result.finalResponse).toContain("Done.");
    expect(result.finalResponse).not.toContain("Half a thou");
  }, 30_000);

  it("reads a message sent while a response has only just begun, instead of after it", async () => {
    let inbox: { id: string; text: string }[] = [];
    const provider = scripted((options, call) =>
      (async function* () {
        if (call === 0) {
          yield { type: "token", text: "Let me plan" } as LLMResponseChunk;
          inbox = [{ id: "q1", text: "Use TypeScript instead." }];
          // A slow model, still going when the message arrives.
          await new Promise<void>((resolve) => options.signal?.addEventListener("abort", () => resolve(), { once: true }));
          return;
        }
        yield { type: "token", text: "Switched to TypeScript." } as LLMResponseChunk;
        yield { type: "stop", reason: "end_turn" } as LLMResponseChunk;
      })(),
    );

    const events: StreamEvent[] = [];
    const result = await runAgentTurn({
      workspaceId: wsId,
      sessionId: "s_interject",
      mode: "plan",
      userMessage: "Write a script.",
      sandboxRunner: runner,
      llmProvider: provider,
      controls: {
        takeMessages: () => inbox.splice(0),
        takeCompactRequest: () => false,
        autoCompact: () => null,
        pendingMessages: () => inbox.length,
      },
      onEvent: (e) => {
        events.push(e);
      },
    });

    expect(events.some((e) => e.type === "model_retry" && e.reason === "interjection")).toBe(true);
    expect(events.some((e) => e.type === "user_message" && e.text === "Use TypeScript instead.")).toBe(true);
    expect(result.stopReason).toBe("completed");
    expect(result.finalResponse).toBe("Switched to TypeScript.");
    expect(JSON.stringify(provider.calls[1]!.messages)).toContain("Use TypeScript instead.");
    expect(JSON.stringify(result.history)).not.toContain("Let me plan");
  }, 30_000);

  it("cuts a long reply short for a message sent now, keeping what it had said", async () => {
    let inbox: { id: string; text: string; urgent?: boolean }[] = [];
    // Varied, so it is a long reply and not a loop (see `degenerate.ts`).
    const long = `Here is the plan in full detail. ${Array.from({ length: 60 }, (_, i) => `Step ${i}: handle case ${i * 7} in module_${i}.`).join(" ")}`;
    const provider = scripted((options, call) =>
      (async function* () {
        if (call === 0) {
          yield { type: "token", text: long } as LLMResponseChunk;
          // Far past the point where an ordinary message waits for the step to end.
          inbox = [{ id: "q1", text: "Stop, use Rust.", urgent: true }];
          await new Promise<void>((resolve) => options.signal?.addEventListener("abort", () => resolve(), { once: true }));
          return;
        }
        yield { type: "token", text: "Switching to Rust." } as LLMResponseChunk;
        yield { type: "stop", reason: "end_turn" } as LLMResponseChunk;
      })(),
    );

    const result = await runAgentTurn({
      workspaceId: wsId,
      sessionId: "s_send_now",
      mode: "plan",
      userMessage: "Write a script.",
      sandboxRunner: runner,
      llmProvider: provider,
      controls: {
        takeMessages: () => inbox.splice(0),
        takeCompactRequest: () => false,
        autoCompact: () => null,
        pendingMessages: () => inbox.length,
        urgentMessages: () => inbox.filter((m) => m.urgent).length,
      },
    });

    expect(result.finalResponse).toBe("Switching to Rust.");
    const sent = JSON.stringify(provider.calls[1]!.messages);
    expect(sent).toContain("Here is the plan in full detail.");
    expect(sent).toContain("Cut short here");
    expect(sent).toContain("Stop, use Rust.");
  }, 30_000);

  it("drops a reply that has turned into one phrase over and over, and asks again", async () => {
    const provider = scripted((_options, call) =>
      (async function* () {
        if (call === 0) {
          for (let i = 0; i < 400; i++) yield { type: "token", text: "The dump settles it: 248068 is " } as LLMResponseChunk;
          yield { type: "stop", reason: "end_turn" } as LLMResponseChunk;
          return;
        }
        yield { type: "token", text: "It is the vocabulary size." } as LLMResponseChunk;
        yield { type: "stop", reason: "end_turn" } as LLMResponseChunk;
      })(),
    );
    const events: StreamEvent[] = [];
    const result = await runAgentTurn({
      workspaceId: wsId,
      sessionId: "s_degenerate",
      mode: "plan",
      userMessage: "What is 248068?",
      sandboxRunner: runner,
      llmProvider: provider,
      onEvent: (e) => void events.push(e),
    });
    expect(events.some((e) => e.type === "model_retry" && /repeating/.test(e.message))).toBe(true);
    expect(result.finalResponse).toBe("It is the vocabulary size.");
    expect(provider.calls[1]!.temperature ?? 0).toBeGreaterThan(provider.calls[0]!.temperature ?? 0);
  }, 30_000);

  it("tells the model at its next step that a background command ended", async () => {
    let notices: { processId: string; text: string }[] = [];
    const provider = scripted((_options, call) =>
      (async function* () {
        if (call === 0) {
          notices = [{ processId: "p_train", text: "[Background command ended] `python train.py` failed with exit code 1 after 2h 03m." }];
          yield { type: "tool_call_start", id: "t1", name: "list_directory" } as LLMResponseChunk;
          yield { type: "tool_call_complete", id: "t1", name: "list_directory", input: { path: "." } } as LLMResponseChunk;
          yield { type: "stop", reason: "tool_use" } as LLMResponseChunk;
          return;
        }
        yield { type: "token", text: "The training run crashed; looking at why." } as LLMResponseChunk;
        yield { type: "stop", reason: "end_turn" } as LLMResponseChunk;
      })(),
    );
    await runAgentTurn({
      workspaceId: wsId,
      sessionId: "s_notice",
      mode: "plan",
      userMessage: "Keep an eye on the training.",
      sandboxRunner: runner,
      llmProvider: provider,
      controls: {
        takeMessages: () => [],
        takeCompactRequest: () => false,
        autoCompact: () => null,
        takeNotices: () => notices.splice(0),
      },
    });
    expect(JSON.stringify(provider.calls[1]!.messages)).toContain("failed with exit code 1 after 2h 03m");
  }, 30_000);

  it("answers a message that arrives as the agent finishes in the same turn, not the next", async () => {
    let inbox: { id: string; text: string }[] = [];
    const provider = scripted(async function* (_options, call) {
      if (call === 0) {
        yield { type: "token", text: "Did the first thing." };
        inbox = [{ id: "q2", text: "And the second thing, please." }];
        yield { type: "stop", reason: "end_turn" };
        return;
      }
      yield { type: "token", text: "Did the first thing and the second." };
      yield { type: "stop", reason: "end_turn" };
    });

    const events: StreamEvent[] = [];
    const result = await runAgentTurn({
      workspaceId: wsId,
      sessionId: "s_late",
      mode: "plan",
      userMessage: "Do the first thing.",
      sandboxRunner: runner,
      llmProvider: provider,
      controls: {
        takeMessages: () => inbox.splice(0),
        takeCompactRequest: () => false,
        autoCompact: () => null,
        pendingMessages: () => inbox.length,
      },
      onEvent: (e) => {
        events.push(e);
      },
    });

    expect(provider.calls).toHaveLength(2);
    expect(events.some((e) => e.type === "user_message" && e.text === "And the second thing, please.")).toBe(true);
    expect(result.finalResponse).toBe("Did the first thing and the second.");
    // What was said before the message stays in the conversation.
    expect(JSON.stringify(result.history)).toContain("Did the first thing.");
  }, 30_000);

  it("tells whether a reply takes up a message at all", () => {
    expect(addresses("All six plan items are complete and the changes are live.", "Remove the Hinglish completely.")).toBe(false);
    expect(addresses("Did the first thing and the second.", "And the second thing, please.")).toBe(true);
    expect(addresses("Removed the Hinglish row from the comparison.", "Remove the Hinglish completely.")).toBe(true);
  });

  it("does not finish over a message its answer passed over", async () => {
    let inbox: { id: string; text: string }[] = [];
    const provider = scripted(async function* (_options, call) {
      if (call === 0) {
        yield { type: "token", text: "Did the first thing." };
        inbox = [{ id: "q2", text: "Remove the Hinglish completely." }];
        yield { type: "stop", reason: "end_turn" };
        return;
      }
      if (call === 1) {
        yield { type: "token", text: "All six plan items are complete." };
        yield { type: "stop", reason: "end_turn" };
        return;
      }
      yield { type: "token", text: "Removed the Hinglish from the page." };
      yield { type: "stop", reason: "end_turn" };
    });
    const result = await runAgentTurn({
      workspaceId: wsId,
      sessionId: "s_passed_over",
      mode: "plan",
      userMessage: "Do the first thing.",
      sandboxRunner: runner,
      llmProvider: provider,
      controls: {
        takeMessages: () => inbox.splice(0),
        takeCompactRequest: () => false,
        autoCompact: () => null,
        pendingMessages: () => inbox.length,
      },
    });
    expect(provider.calls).toHaveLength(3);
    expect(JSON.stringify(provider.calls[2]!.messages)).toContain("no step since has acted on it");
    expect(result.finalResponse).toBe("Removed the Hinglish from the page.");
  }, 30_000);

  it("passes a lively stream through untouched, however long the consumer takes", async () => {
    async function* numbers(): AsyncGenerator<number> {
      yield 1;
      yield 2;
      yield 3;
    }
    const seen: number[] = [];
    for await (const n of withIdleTimeout(numbers(), 20, () => undefined)) {
      seen.push(n);
      // Slower than the idle limit: handling a chunk is not the model being silent.
      await new Promise((resolve) => setTimeout(resolve, 40));
    }
    expect(seen).toEqual([1, 2, 3]);
  });

  it("tells the model to split a file that was cut off, instead of asking it to continue into the same wall", async () => {
    const provider = scripted(async function* (_options, call) {
      if (call === 0) {
        yield { type: "tool_call_start", id: "big", name: "write_file", index: 0 };
        yield { type: "tool_call_delta", id: "big", index: 0, inputDelta: '{"path":"huge.js","content":"aaaa' };
        yield { type: "stop", reason: "max_tokens" };
      } else {
        yield { type: "token", text: "Understood." };
        yield { type: "stop", reason: "end_turn" };
      }
    });

    await runAgentTurn({
      workspaceId: wsId,
      sessionId: "s_split",
      mode: "bypass",
      userMessage: "Write a huge file.",
      sandboxRunner: runner,
      llmProvider: provider,
    });

    const second = provider.calls[1]!;
    const sent = second.messages.filter((m) => !m.frame);
    const last = sent[sent.length - 1]!;
    expect(last.role).toBe("user");
    expect(String(last.content)).toMatch(/cut off/);
    expect(String(last.content)).toMatch(/edit_file/);
  }, 30_000);

  it("summarises a conversation that has outgrown the window, and keeps going", async () => {
    const events: StreamEvent[] = [];
    const kinds: string[] = [];
    const provider = scripted(async function* (options) {
      if (options.system.startsWith("You condense")) {
        yield { type: "token", text: "Goal: the long task. Progress: steps 0-29 read files." };
      } else {
        yield { type: "token", text: "Carrying on." };
      }
      yield { type: "stop", reason: "end_turn" };
    });

    const history: LLMMessage[] = [{ role: "user", content: "The long task." }];
    for (let i = 0; i < 30; i++) {
      history.push({ role: "assistant", content: "", toolCalls: [{ id: `r${i}`, name: "read_file", input: { path: `f${i}` } }] });
      history.push({ role: "tool", toolCallId: `r${i}`, content: "w".repeat(3_000) });
    }

    const result = await runAgentTurn({
      workspaceId: wsId,
      sessionId: "s_summary",
      mode: "plan",
      // An 8k window, so thirty reads are far over budget.
      model: "gpt-4",
      history,
      userMessage: "Continue.",
      sandboxRunner: runner,
      llmProvider: provider,
      onEvent: (e) => {
        events.push(e);
      },
      onMessage: (_m, meta) => {
        if (meta.kind) kinds.push(meta.kind);
      },
    });

    expect(result.stopReason).toBe("completed");
    expect(events.some((e) => e.type === "context_compacted" && e.method === "summary")).toBe(true);
    expect(kinds).toContain("compaction");
    expect(String(result.history[0]!.content)).toContain("[Context summary]");
  }, 30_000);
});

describe("reading a call that is still being written", () => {
  it("reads a path once its string has closed", () => {
    expect(previewPartialInput('{"path":"src/a')).toBeUndefined();
    expect(previewPartialInput('{"path":"src/a.ts","content":"x')).toEqual({ path: "src/a.ts" });
  });

  it("reports file_path as path, and decodes escapes", () => {
    expect(previewPartialInput('{"file_path":"dir\\\\x.ts"')).toEqual({ path: "dir\\x.ts" });
  });

  it("reads a command", () => {
    expect(previewPartialInput('{"command":"npm test","timeout_ms":')).toEqual({ command: "npm test" });
  });
});

describe("which failures are worth another attempt", () => {
  it("retries dropped streams and overloaded providers", () => {
    expect(isTransientModelError(new Error("terminated"))).toBe(true);
    expect(isTransientModelError(Object.assign(new Error("rate limited"), { status: 429 }))).toBe(true);
    expect(isTransientModelError(Object.assign(new Error("bad gateway"), { status: 502 }))).toBe(true);
  });

  it("does not retry a spent plan window: SoreQen's usage limit is not a busy provider (17 Nov 2026)", () => {
    // It retried "The model provider is rate limiting requests" for ever on a Free account's spent 5-hour window.
    expect(isTransientModelError(new ProviderError("Your 5-hour limit is used up.", 429, "usage_limit", "five_hour_exhausted"))).toBe(false);
    expect(isTransientModelError(new ProviderError("The model request failed: 429 slow down", 429, "rate_limit_error"))).toBe(true);
  });

  it("does not retry a request that is wrong", () => {
    expect(isTransientModelError(Object.assign(new Error("bad request"), { status: 400 }))).toBe(false);
    expect(isTransientModelError(Object.assign(new Error("no"), { status: 401 }))).toBe(false);
  });

  it("recognises a conversation too long for the model", () => {
    expect(
      isContextOverflow(Object.assign(new Error("This model's maximum context length is 64000 tokens"), { status: 400 })),
    ).toBe(true);
    expect(isContextOverflow(Object.assign(new Error("invalid tool schema"), { status: 400 }))).toBe(false);
  });
});

describe("model retry schedule", () => {
  it("matches the exact delay intervals up to 324s", () => {
    expect(MODEL_RETRY_SCHEDULE_MS).toEqual([
      2_000,
      4_000,
      8_000,
      16_000,
      32_000,
      64_000,
      96_000,
      144_000,
      216_000,
      324_000,
    ]);
  });

  it("calculates delays for each attempt correctly", () => {
    expect(modelRetryDelayMs(1)).toBe(2_000);
    expect(modelRetryDelayMs(2)).toBe(4_000);
    expect(modelRetryDelayMs(3)).toBe(8_000);
    expect(modelRetryDelayMs(4)).toBe(16_000);
    expect(modelRetryDelayMs(5)).toBe(32_000);
    expect(modelRetryDelayMs(6)).toBe(64_000);
    expect(modelRetryDelayMs(7)).toBe(96_000);
    expect(modelRetryDelayMs(8)).toBe(144_000);
    expect(modelRetryDelayMs(9)).toBe(216_000);
    expect(modelRetryDelayMs(10)).toBe(324_000);
    expect(modelRetryDelayMs(11)).toBeNull();
    expect(modelRetryDelayMs(0)).toBeNull();
  });

  it("defines MAX_MODEL_ATTEMPTS as 11", () => {
    expect(MAX_MODEL_ATTEMPTS).toBe(11);
  });

  it("exhausts a custom schedule and throws the final error", async () => {
    const wsId = `retry_ws_${Date.now()}`;
    const runner = new LocalSandboxRunner();
    await runner.createWorkspace(wsId);

    let attemptsSeen = 0;
    const provider = scripted(async function* () {
      attemptsSeen++;
      throw new Error("server dropped connection");
    });

    const events: StreamEvent[] = [];
    const result = await runAgentTurn({
      workspaceId: wsId,
      sessionId: "s_exhaust",
      mode: "plan",
      userMessage: "Test",
      sandboxRunner: runner,
      llmProvider: provider,
      retryScheduleMs: [5, 10], // 2 retries, 3 total attempts
      onEvent: (e) => events.push(e),
    });

    expect(result.status).toBe("blocked");
    expect(result.stopReason).toBe("failed");
    expect(result.finalResponse).toContain("server dropped connection");

    expect(attemptsSeen).toBe(3);
    const retryEvents = events.filter((e) => e.type === "model_retry");
    expect(retryEvents).toHaveLength(2);
    expect(retryEvents[0]?.delayMs).toBe(5);
    expect(retryEvents[1]?.delayMs).toBe(10);
  });
});


