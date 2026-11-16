/**
 * The two things a turn could not do before: look at a picture, and ask.
 *
 * Both were reported as missing capabilities — "I cannot see images in this
 * environment", and questions that were typed into a final message and
 * therefore asked of nobody. Neither was missing; both were unwired.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { LocalSandboxRunner } from "@sqcode/sandbox-runner";
import {
  clearRegisteredCapabilities,
  registerModelCapabilities,
  withAttachments,
  type StreamEvent,
} from "@sqcode/shared";
import { runAgentTurn } from "./agent-loop.js";
import { MockLLMProvider } from "./llm-provider.js";
import type { LLMContentBlock } from "./types.js";

const PNG_1x1 = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

describe("looking at an image", () => {
  const wsId = `vision_ws_${Date.now()}`;
  let runner: LocalSandboxRunner;
  let dir: string;

  beforeEach(async () => {
    clearRegisteredCapabilities();
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "sqcode_vision_"));
    runner = new LocalSandboxRunner(dir);
    await runner.createWorkspace(wsId, { storagePath: dir });
    fs.writeFileSync(path.join(dir, "shot.png"), PNG_1x1);
  });

  afterEach(async () => {
    clearRegisteredCapabilities();
    await runner.destroyWorkspace(wsId);
    try {
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    } catch {
      // ignore
    }
  });

  it("sends the picture to a vision model as an image block, not as text", async () => {
    registerModelCapabilities("seeing-model", { vision: true });
    const provider = new MockLLMProvider([
      {
        text: "Let me look at that.",
        toolCalls: [{ id: "v1", name: "view_image", input: { path: "shot.png" } }],
        stopReason: "tool_use",
      },
      { text: "It is a single white pixel.", stopReason: "end_turn" },
    ]);

    const result = await runAgentTurn({
      workspaceId: wsId,
      sessionId: "s_vision",
      mode: "bypass",
      model: "seeing-model",
      userMessage: "What is in shot.png?",
      sandboxRunner: runner,
      llmProvider: provider,
    });

    expect(result.stopReason).toBe("completed");

    const withBlocks = result.history.filter(
      (m) => m.role === "user" && Array.isArray(m.content),
    );
    expect(withBlocks).toHaveLength(1);

    const blocks = withBlocks[0]!.content as LLMContentBlock[];
    const image = blocks.find((b) => b.type === "image");
    expect(image).toBeDefined();
    expect(image).toMatchObject({ media_type: "image/png", image_data: PNG_1x1.toString("base64") });

    /*
     * And the tool result itself stays small. This is the regression that
     * made the feature look impossible: base64 in the text result was clipped
     * by the 24k character limit into broken JSON and a wall of characters.
     */
    const toolResult = result.history.filter((m) => m.role === "tool").pop();
    expect(String(toolResult?.content)).not.toContain(PNG_1x1.toString("base64").slice(0, 24));
    expect(String(toolResult?.content).length).toBeLessThan(500);
  }, 30_000);

  it("tells a text-only model it cannot see, instead of sending bytes it will reject", async () => {
    registerModelCapabilities("blind-model", { vision: false });
    const provider = new MockLLMProvider([
      {
        text: "Looking.",
        toolCalls: [{ id: "v1", name: "view_image", input: { path: "shot.png" } }],
        stopReason: "tool_use",
      },
      { text: "I cannot see it; tell me what it shows.", stopReason: "end_turn" },
    ]);

    const result = await runAgentTurn({
      workspaceId: wsId,
      sessionId: "s_blind",
      mode: "bypass",
      model: "blind-model",
      userMessage: "What is in shot.png?",
      sandboxRunner: runner,
      llmProvider: provider,
    });

    expect(result.history.some((m) => m.role === "user" && Array.isArray(m.content))).toBe(false);
    const toolResult = result.history.filter((m) => m.role === "tool").pop();
    expect(String(toolResult?.content)).toContain("cannot read images");
    // It says what to do about it, which is the part an agent can act on.
    expect(String(toolResult?.content)).toContain("vision-capable model");
  }, 30_000);

  it("shows a picture attached to a message sent while it works, and stores the message as text (31 Oct 2026)", async () => {
    registerModelCapabilities("seeing-model", { vision: true });
    const at = ".soreqen/attachments/20261030T211547-4e93/image.png";
    fs.mkdirSync(path.join(dir, path.dirname(at)), { recursive: true });
    fs.writeFileSync(path.join(dir, at), PNG_1x1);
    const inbox = [
      { id: "q1", text: withAttachments("Why does this overlap?", [{ path: at, name: "image.png", mimeType: "image/png", sizeBytes: PNG_1x1.length }]) },
    ];
    const provider = new MockLLMProvider([
      { text: "Looking around.", toolCalls: [{ id: "l1", name: "list_directory", input: { path: "." } }], stopReason: "tool_use" },
      { text: "The footer sits on the text.", stopReason: "end_turn" },
    ]);
    const stored: { content: unknown; kind?: string }[] = [];

    const result = await runAgentTurn({
      workspaceId: wsId,
      sessionId: "s_interject_image",
      mode: "bypass",
      model: "seeing-model",
      userMessage: "Build the page.",
      sandboxRunner: runner,
      llmProvider: provider,
      controls: {
        takeMessages: () => inbox.splice(0),
        takeCompactRequest: () => false,
        autoCompact: () => null,
        pendingMessages: () => inbox.length,
      },
      onMessage: (message, meta) => {
        stored.push({ content: message.content, kind: meta.kind });
        return undefined;
      },
    });

    const delivered = result.history.find((m) => m.role === "user" && JSON.stringify(m.content).includes("Why does this overlap?"));
    expect(Array.isArray(delivered?.content)).toBe(true);
    expect((delivered!.content as LLMContentBlock[]).some((b) => b.type === "image")).toBe(true);
    // The bytes stay in the workspace; the stored message is the text, as the first one is.
    const interjection = stored.find((s) => s.kind === "interjection");
    expect(typeof interjection?.content).toBe("string");
  }, 30_000);
});

describe("asking the user", () => {
  const wsId = `ask_ws_${Date.now()}`;
  let runner: LocalSandboxRunner;
  let dir: string;

  beforeEach(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "sqcode_ask_"));
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

  it("waits for the answer, announces the question, and carries on with it", async () => {
    const provider = new MockLLMProvider([
      {
        text: "One thing first.",
        toolCalls: [
          {
            id: "q1",
            name: "ask_user",
            input: {
              question: "Postgres or SQLite?",
              why: "Nothing in the repo says which database this targets.",
              options: ["Postgres", "SQLite"],
            },
          },
        ],
        stopReason: "tool_use",
      },
      { text: "Using Postgres, then.", stopReason: "end_turn" },
    ]);

    const events: StreamEvent[] = [];
    /*
     * The answer arrives the way a real one does: typed after the question
     * appears, and delivered through the ordinary mid-turn message queue.
     * Pushing it on the `question` event rather than on a timer is what makes
     * this test about the mechanism instead of about a race.
     */
    let answered = false;
    const inbox: { id: string; text: string }[] = [];

    const result = await runAgentTurn({
      workspaceId: wsId,
      sessionId: "s_ask",
      mode: "bypass",
      userMessage: "Set up the database layer.",
      sandboxRunner: runner,
      llmProvider: provider,
      onEvent: (event) => {
        events.push(event);
        if (event.type === "question") inbox.push({ id: "m1", text: "Postgres" });
      },
      controls: {
        takeMessages: () => {
          const taken = inbox.splice(0);
          if (taken.length > 0) answered = true;
          return taken;
        },
        takeCompactRequest: () => false,
        autoCompact: () => null,
      },
    });

    expect(answered).toBe(true);
    expect(result.stopReason).toBe("completed");

    const asked = events.find((e) => e.type === "question");
    expect(asked).toMatchObject({
      question: "Postgres or SQLite?",
      why: "Nothing in the repo says which database this targets.",
      options: ["Postgres", "SQLite"],
    });
    // And the prompt is cleared again once it has been answered.
    expect(events.some((e) => e.type === "question_answered")).toBe(true);

    const toolResult = result.history.filter((m) => m.role === "tool").pop();
    expect(String(toolResult?.content)).toContain("Postgres");
  }, 30_000);

  it("does not hang when there is nobody to ask", async () => {
    /*
     * An unattended run — an eval, a scheduled job — has no message queue. The
     * agent must be told so and carry on under a stated assumption, not wait
     * for an answer that cannot arrive.
     */
    const provider = new MockLLMProvider([
      {
        text: "Checking something.",
        toolCalls: [{ id: "q1", name: "ask_user", input: { question: "Which one?" } }],
        stopReason: "tool_use",
      },
      { text: "Assuming the first.", stopReason: "end_turn" },
    ]);

    const result = await runAgentTurn({
      workspaceId: wsId,
      sessionId: "s_ask_nobody",
      mode: "bypass",
      userMessage: "Do the thing.",
      sandboxRunner: runner,
      llmProvider: provider,
    });

    expect(result.stopReason).toBe("completed");
    const toolResult = result.history.filter((m) => m.role === "tool").pop();
    expect(String(toolResult?.content)).toContain("nobody to ask");
  }, 30_000);

  it("uses a message sent a moment too early as the answer, rather than waiting for a second one", async () => {
    /*
     * The race that hung the first build of this.
     *
     * One queue, two readers: the interjection channel drains it at the top of
     * every step, long before the model produces the call that asks. Somebody
     * typing just before the question therefore had their message delivered as
     * an ordinary interjection — and the question then waited for ever for a
     * second message nobody knew to send.
     */
    const provider = new MockLLMProvider([
      {
        text: "Let me check.",
        toolCalls: [{ id: "q1", name: "ask_user", input: { question: "Postgres or SQLite?" } }],
        stopReason: "tool_use",
      },
      { text: "Postgres it is.", stopReason: "end_turn" },
    ]);

    const inbox = [{ id: "m1", text: "use Postgres" }];

    const result = await runAgentTurn({
      workspaceId: wsId,
      sessionId: "s_ask_race",
      mode: "bypass",
      userMessage: "Set up the database layer.",
      sandboxRunner: runner,
      llmProvider: provider,
      controls: {
        takeMessages: () => inbox.splice(0),
        takeCompactRequest: () => false,
        autoCompact: () => null,
      },
    });

    expect(result.stopReason).toBe("completed");
    const toolResult = result.history.filter((m) => m.role === "tool").pop();
    expect(String(toolResult?.content)).toContain("already been told");
    expect(String(toolResult?.content)).toContain("use Postgres");
  }, 30_000);
});
