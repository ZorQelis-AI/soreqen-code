import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { LocalSandboxRunner } from "@sqcode/sandbox-runner";
import type { StreamEvent } from "@sqcode/shared";
import {
  SoreQenOrchestrator,
  MockLLMProvider,
  buildSystemPrompt,
  compactHistory,
  estimateHistoryTokens,
  evaluateToolPermission,
  type LLMMessage,
} from "./index.js";

describe("@sqcode/orchestrator", () => {
  const testWorkspaceId = `orch_test_ws_${Date.now()}`;
  let sandboxRunner: LocalSandboxRunner;
  let tempDir: string;

  beforeEach(async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "sqcode_orch_idx_"));
    sandboxRunner = new LocalSandboxRunner(tempDir);
    await sandboxRunner.createWorkspace(testWorkspaceId, { storagePath: tempDir });
  });

  afterEach(async () => {
    await sandboxRunner.destroyWorkspace(testWorkspaceId);
    try {
      fs.rmSync(tempDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    } catch {
      // ignore
    }
  });

  describe("System Prompt Compiler", () => {
    it("dynamically replaces all runtime placeholders", async () => {
      await sandboxRunner.writeFile(testWorkspaceId, "src/index.ts", "console.log('hello');");
      await sandboxRunner.writeFile(
        testWorkspaceId,
        "README.md",
        "# Test Project\nGuidelines: Write clean code.",
      );

      const prompt = await buildSystemPrompt(
        {
          workspaceId: testWorkspaceId,
          sessionId: "sess_1",
          permissionTier: "guarded_autonomy",
          relevantOpenFiles: ["src/index.ts"],
        },
        sandboxRunner,
      );

      // Was "## REPO FILE TREE" — a listing of the first thirty entries at
      // depth 1. Replaced by a symbol map; see `repo-map.ts`.
      expect(prompt).toContain("## REPOSITORY MAP");
      expect(prompt).toContain("src/index.ts");
      expect(prompt).toContain("## RELEVANT OPEN FILES");
      expect(prompt).toContain("src/index.ts");
      expect(prompt).toContain("## RECENT GIT LOG");
      expect(prompt).toContain("## PROJECT CONVENTIONS");
      expect(prompt).toContain("## USER PERMISSION TIER");
      expect(prompt).toContain("guarded_autonomy");
      expect(prompt).toContain("## SANDBOX CAPABILITIES");
      expect(prompt).toContain("Sandbox Environment");
    });
  });

  describe("Context Manager & Compaction", () => {
    it("compacts older tool results while preserving initial prompt and recent messages", () => {
      const messages: LLMMessage[] = [
        { role: "user", content: "Initial Goal: Fix payment gateway bug." },
      ];

      for (let i = 0; i < 30; i++) {
        messages.push({
          role: "tool",
          toolCallId: `call_${i}`,
          content: "A very long tool output string with tons of logs... ".repeat(50),
        });
      }

      messages.push({
        role: "assistant",
        content: "Recent assistant thought and planning.",
      });

      const compacted = compactHistory(messages, { maxTokens: 5_000, preserveRecentCount: 2 });

      // The goal and the latest thought survive; the bulk in between does not.
      expect(compacted[0]?.content).toBe("Initial Goal: Fix payment gateway bug.");
      expect(compacted[compacted.length - 1]?.content).toBe(
        "Recent assistant thought and planning.",
      );
      expect(estimateHistoryTokens(compacted)).toBeLessThanOrEqual(5_000);
      expect(JSON.stringify(compacted)).toContain("dropped to fit the context window");
    });
  });

  describe("Permission Guardrails", () => {
    it("evaluates permission tiers correctly", () => {
      /*
       * read_only denies a write; it does not offer to confirm one.
       *
       * This expectation used to be `requiresConfirmation: true`, pinning an
       * implementation that contradicted both `docs/ARCHITECTURE.md` and the
       * system prompt the agent itself receives ("No writes of any kind").
       * See `guardrails-review.test.ts` for the full account.
       */
      const roWrite = evaluateToolPermission(
        { id: "1", name: "write_file", input: { path: "a.txt" } },
        "read_only",
      );
      expect(roWrite.allowed).toBe(false);
      expect(roWrite.requiresConfirmation).toBe(false);

      const roRead = evaluateToolPermission(
        { id: "2", name: "read_file", input: { path: "a.txt" } },
        "read_only",
      );
      expect(roRead.requiresConfirmation).toBe(false);

      // guarded_autonomy git push
      const gaPush = evaluateToolPermission(
        { id: "3", name: "git_operation", input: { operation: "push" } },
        "guarded_autonomy",
      );
      expect(gaPush.requiresConfirmation).toBe(true);

      // guarded_autonomy normal edit
      const gaEdit = evaluateToolPermission(
        { id: "4", name: "edit_file", input: { path: "src/calc.ts" } },
        "guarded_autonomy",
      );
      expect(gaEdit.requiresConfirmation).toBe(false);
    });
  });

  describe("End-to-End Broken Test Fixture Integration Test", () => {
    it("reads broken code fixture, diagnoses bug, applies fix, verifies test and completes task", async () => {
      // 1. Setup broken repository fixture
      const brokenMathCode = `export function multiply(a: number, b: number): number {\n  return a + b; // BUG: added instead of multiplied\n}\n`;
      await sandboxRunner.writeFile(testWorkspaceId, "src/math.ts", brokenMathCode);

      // 2. Setup Mock LLM Script representing Senior Engineering Agent
      const mockLLM = new MockLLMProvider([
        // Turn 1: Agent reads math.ts to inspect bug
        {
          text: "I will first read src/math.ts to check the multiply implementation.",
          toolCalls: [
            {
              id: "call_read_1",
              name: "read_file",
              input: { path: "src/math.ts" },
            },
          ],
          stopReason: "tool_use",
        },
        // Turn 2: Agent edits math.ts to fix the bug
        {
          text: "I found the bug: 'return a + b' instead of 'return a * b'. I will apply the fix.",
          toolCalls: [
            {
              id: "call_edit_2",
              name: "edit_file",
              input: {
                path: "src/math.ts",
                old_str: "  return a + b; // BUG: added instead of multiplied",
                new_str: "  return a * b;",
              },
            },
          ],
          stopReason: "tool_use",
        },
        // Turn 3: Agent executes command to verify
        {
          text: "Now I will verify the fix by reading back the corrected file.",
          toolCalls: [
            {
              id: "call_read_3",
              name: "read_file",
              input: { path: "src/math.ts" },
            },
          ],
          stopReason: "tool_use",
        },
        // Turn 4: the agent believes it is done.
        {
          text: "The multiply function in src/math.ts has been fixed and verified. All operations return correct products.",
          stopReason: "end_turn",
        },
        /*
         * Turn 5: the summary checked against the turn record.
         *
         * A turn that changed a file is handed the record of what its tool
         * calls actually did, and checks the summary it just wrote against it,
         * so there is one more model response than there are steps of work. It
         * used to write the summary again — two summaries in every such turn.
         * See `turn-ledger.ts`.
         */
        {
          text: "VERIFIED",
          stopReason: "end_turn",
        },
      ]);

      const events: StreamEvent[] = [];
      const orchestrator = new SoreQenOrchestrator({
        sandboxRunner,
        llmProvider: mockLLM,
      });

      // 3. Execute Turn
      const result = await orchestrator.runTurn({
        workspaceId: testWorkspaceId,
        sessionId: "sess_fixture_test",
        permissionTier: "guarded_autonomy",
        userMessage: "The multiply function is failing. Please fix it.",
        onEvent: (ev) => {
          events.push(ev);
        },
      });

      // 4. Validate Agent Execution
      expect(result.status).toBe("completed");
      expect(result.toolCallsExecuted).toBe(3);
      expect(result.finalResponse).toContain("fixed and verified");

      // 5. Verify file on disk is actually fixed
      const fixedContent = await sandboxRunner.readFile(testWorkspaceId, "src/math.ts");
      expect(fixedContent.content).toContain("return a * b;");
      expect(fixedContent.content).not.toContain("return a + b;");

      // 6. Verify Event Stream
      const tokenEvents = events.filter((e) => e.type === "token");
      const toolCallEvents = events.filter((e) => e.type === "tool_call");
      const toolResultEvents = events.filter((e) => e.type === "tool_result");
      const diffEvents = events.filter((e) => e.type === "diff");
      const completeEvents = events.filter((e) => e.type === "complete");

      expect(tokenEvents.length).toBeGreaterThan(0);

      /*
       * Four, not three: the model made three calls, and the loop adds a
       * `verify_changes` pass of its own once files have been modified and the
       * model believes it is finished. That verification is new in Phase 2 —
       * previously `SelfHealer` existed and was never invoked, so a turn went
       * straight from "done" to reported success without checking anything.
       *
       * Counted as a matched pair, because it is emitted as one: a
       * `tool_result` with no `tool_call` is an orphan to every consumer that
       * pairs them by callId.
       */
      expect(toolCallEvents.length).toBe(4);
      expect(toolResultEvents.length).toBe(4);
      expect(toolCallEvents.at(-1)).toMatchObject({ tool: "verify_changes" });
      expect(toolResultEvents.at(-1)).toMatchObject({ tool: "verify_changes", success: true });

      expect(diffEvents.length).toBe(1);
      expect(completeEvents.length).toBe(1);

      // The summary is streamed once, and the check behind it not at all.
      const streamed = tokenEvents.map((e) => (e as { delta: string }).delta).join("");
      expect(streamed.split("has been fixed and verified").length - 1).toBe(1);
      expect(streamed).not.toContain("VERIFIED");
      expect(result.finalResponse.trim()).toBe(
        "The multiply function in src/math.ts has been fixed and verified. All operations return correct products.",
      );
    });

    it("adds a correction under the summary, once, when the check finds one", async () => {
      await sandboxRunner.writeFile(testWorkspaceId, "src/math.ts", "export const two = 1;\n");
      const mockLLM = new MockLLMProvider([
        {
          text: "Fixing it.",
          toolCalls: [{ id: "c1", name: "edit_file", input: { path: "src/math.ts", old_str: "= 1", new_str: "= 2" } }],
          stopReason: "tool_use",
        },
        { text: "Fixed src/math.ts and ran the tests.", stopReason: "end_turn" },
        { text: "Correction: no tests were run.", stopReason: "end_turn" },
      ]);
      const events: StreamEvent[] = [];
      const result = await new SoreQenOrchestrator({ sandboxRunner, llmProvider: mockLLM }).runTurn({
        workspaceId: testWorkspaceId,
        sessionId: "sess_correction",
        permissionTier: "guarded_autonomy",
        userMessage: "Make two equal 2.",
        onEvent: (ev) => {
          events.push(ev);
        },
      });
      const streamed = events.filter((e) => e.type === "token").map((e) => (e as { delta: string }).delta).join("");
      expect(streamed.split("Fixed src/math.ts").length - 1).toBe(1);
      expect(streamed).toContain("Correction: no tests were run.");
      expect(result.finalResponse).toBe("Fixed src/math.ts and ran the tests.\n\nCorrection: no tests were run.");
    });
  });
});
