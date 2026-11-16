/**
 * A long task, through several checkpoints, without forgetting.
 *
 * The acceptance test for the context engine. A turn is run with a history
 * budget small enough that it must checkpoint again and again, and after
 * every checkpoint the request the model actually receives is inspected: the
 * user's constraint, the decision taken early on, the open hypothesis (still
 * marked unverified), the failed approach, the file changed and the code that
 * matters must all still be in front of it — and a claim whose source file
 * changed must say that it is stale. Then a second turn is started, from a new
 * engine, to show the memory lives on disk rather than in the process.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { LocalSandboxRunner } from "@sqcode/sandbox-runner";
import type { StreamEvent } from "@sqcode/shared";
import { runAgentTurn } from "../agent-loop.js";
import type { LLMChatOptions, LLMMessage, LLMProvider, LLMResponseChunk } from "../types.js";
import { resetIndexes } from "./repo-index.js";
import { CHECKPOINT_MARK } from "./state-checkpoint.js";
import { statePathFor } from "./task-state.js";

const EXTRACTOR = "You maintain the durable memory";

const REQUEST =
  "Fix the token refresh bug in refreshToken: tokens collide across tenants. " +
  "Do not change the Session interface in session.ts.";
const CONSTRAINT = "Do not change the Session interface in session.ts.";
const DECISION = "Fix the collision inside cacheKeyFor in cache.ts, not in session.ts, so the Session API stays unchanged";
const HYPOTHESIS = "cacheKeyFor ignores tenantId, so two tenants share one token";
const FACT = "cacheKeyFor builds the key from userId only";
const NOTES = 30;

type Call = { id: string; name: string; input: Record<string, unknown> };

/** The scripted agent: record memory, hit a failure, read a long way, then fix. */
function plan(): Call[] {
  const calls: Call[] = [
    {
      id: "mem",
      name: "update_task_state",
      input: {
        add: [
          { kind: "decision", text: DECISION },
          { kind: "hypothesis", text: HYPOTHESIS },
          { kind: "fact", text: FACT, source: "src/auth/cache.ts:3-5" },
          { kind: "next_action", text: "Change cacheKeyFor to include tenantId" },
        ],
      },
    },
    { id: "miss", name: "read_file", input: { path: "src/auth/token-store.ts" } },
  ];
  for (let i = 0; i < NOTES; i++) calls.push({ id: `n${i}`, name: "read_file", input: { path: `notes/n${i}.md` } });
  calls.push({
    id: "fix",
    name: "write_file",
    input: {
      path: "src/auth/cache.ts",
      content:
        "export function cacheKeyFor(userId: string, tenantId = \"default\"): string {\n" +
        "  return `session:${tenantId}:${userId}`;\n}\n",
    },
  });
  for (let i = 0; i < 6; i++) calls.push({ id: `m${i}`, name: "read_file", input: { path: `notes/n${i}.md`, start_line: 1, end_line: 40 } });
  return calls;
}

function agent(): LLMProvider & { requests: LLMChatOptions[]; extractions: number } {
  const script = plan();
  let step = 0;
  const requests: LLMChatOptions[] = [];
  const self = {
    name: "scripted",
    requests,
    extractions: 0,
    async *chatStream(options: LLMChatOptions): AsyncIterable<LLMResponseChunk> {
      if (options.system.startsWith(EXTRACTOR)) {
        self.extractions++;
        const n = self.extractions;
        yield {
          type: "token",
          text: JSON.stringify({
            decisions: [{ text: `Checkpoint ${n}: keep reading the notes in order` }],
            // No source: must come back as a hypothesis, never a fact.
            facts: [{ text: `The notes up to checkpoint ${n} say nothing about tenants` }],
            next_actions: [{ text: "Change cacheKeyFor to include tenantId" }],
          }),
        };
        yield { type: "stop", reason: "end_turn" };
        return;
      }
      requests.push(options);
      const call = script[step++];
      if (!call) {
        yield { type: "token", text: "Fixed: cacheKeyFor now includes the tenant." };
        yield { type: "stop", reason: "end_turn" };
        return;
      }
      yield { type: "tool_call_start", id: call.id, name: call.name };
      yield { type: "tool_call_complete", id: call.id, name: call.name, input: call.input };
      yield { type: "stop", reason: "tool_use" };
    },
  };
  return self;
}

/** The working set in a request: the last message carrying the task state. */
function frameOf(request: LLMChatOptions): string {
  const hit = [...request.messages].reverse().find((m) => typeof m.content === "string" && m.content.includes("## TASK STATE"));
  if (!hit) return "";
  return String(hit.content);
}

function section(frame: string, title: string): string {
  const start = frame.indexOf(title);
  if (start === -1) return "";
  const end = frame.indexOf("\n\n", start);
  const next = frame.slice(start).search(/\n[A-Z][A-Za-z ]+(\(|:)/);
  return frame.slice(start, Math.min(end === -1 ? frame.length : end, next === -1 ? frame.length : start + next));
}

describe("continuity through repeated checkpoints", () => {
  const wsId = `cont_ws_${Date.now()}`;
  let runner: LocalSandboxRunner;
  let dir: string;
  const savedEnv = process.env["SOREQEN_CONTEXT_BUDGETS"];

  beforeEach(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "sqcode_cont_"));
    fs.mkdirSync(path.join(dir, "src/auth"), { recursive: true });
    fs.mkdirSync(path.join(dir, "notes"), { recursive: true });
    fs.writeFileSync(
      path.join(dir, "src/auth/session.ts"),
      'import { cacheKeyFor } from "./cache";\n\nexport interface Session { userId: string; tenantId: string; token: string }\n\n' +
        "export function refreshToken(session: Session): Session {\n  const key = cacheKeyFor(session.userId);\n" +
        "  return { ...session, token: `${key}:${Date.now()}` };\n}\n",
    );
    fs.writeFileSync(
      path.join(dir, "src/auth/cache.ts"),
      "export function cacheKeyFor(userId: string): string {\n  return `session:${userId}`;\n}\n",
    );
    for (let i = 0; i < NOTES; i++) {
      const body = Array.from({ length: 60 }, (_, l) => `Note ${i} line ${l}: meeting minutes about quarterly planning and roadmap item ${i * 100 + l}.`);
      fs.writeFileSync(path.join(dir, `notes/n${i}.md`), `# Notes ${i}\n\n${body.join("\n")}\n`);
    }
    runner = new LocalSandboxRunner(dir);
    await runner.createWorkspace(wsId, { storagePath: dir });
    // A history ceiling of 6k tokens: thirty reads of ~1.3k tokens each must checkpoint several times.
    process.env["SOREQEN_CONTEXT_BUDGETS"] = JSON.stringify({ "*": { historyMax: 6_000, checkpointKeep: 2_000 } });
  });

  afterEach(async () => {
    if (savedEnv === undefined) delete process.env["SOREQEN_CONTEXT_BUDGETS"];
    else process.env["SOREQEN_CONTEXT_BUDGETS"] = savedEnv;
    resetIndexes();
    await runner.destroyWorkspace(wsId);
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });

  it("keeps constraints, decisions, hypotheses, failures, changed files and relevant code", async () => {
    const provider = agent();
    const events: StreamEvent[] = [];
    const result = await runAgentTurn({
      workspaceId: wsId,
      sessionId: "s_continuity",
      mode: "bypass",
      userMessage: REQUEST,
      sandboxRunner: runner,
      llmProvider: provider,
      /*
       * No model, so the 32k default window: history gets what is left after the
       * system prompt, the tool schemas and the output reserve, and every tool
       * added takes from it. The reserve is capped at 15% of the window (4,915
       * here), so only a value under that changes anything: research (4 Oct
       * 2026) left room for under three reads per checkpoint, and 4,500 puts
       * back what it took. 4,300 since 9 Oct 2026, for the edit-batching lines;
       * 4,000 since 13 Oct, for skill-creator and the guidance on loading skills
       * and recommending an answer. 3,200 since 15 Oct, for batched questions,
       * the memory note rules and searching outside the project.
       * 3,000 since 31 Oct, for the working-set rule against re-planning each step.
       */
      maxOutputTokens: 3_000,
      onEvent: (e) => {
        events.push(e);
      },
    });

    expect(result.stopReason).toBe("completed");

    // It really did compact, more than once, by checkpoint rather than summary.
    const checkpoints = events.filter((e) => e.type === "context_compacted" && e.method === "checkpoint");
    expect(checkpoints.length).toBeGreaterThanOrEqual(2);
    // Hysteresis: each checkpoint frees enough room for several steps — no thrash.
    expect(checkpoints.length).toBeLessThanOrEqual(Math.ceil(provider.requests.length / 3));
    for (const c of checkpoints as { tokensBefore: number; tokensAfter: number }[]) {
      // Not quite half since 1 Oct 2026: the first read of each source file carries a
      // one-line code-graph note, which this 6k-token budget feels and a real one does not.
      expect(c.tokensAfter).toBeLessThan(c.tokensBefore * 0.55);
    }
    expect(events.some((e) => e.type === "context_compacted" && e.method === "summary")).toBe(false);
    expect(provider.extractions).toBe(checkpoints.length);

    // Every request made after a checkpoint, and the last one of all.
    const after = provider.requests.filter((r) => String(r.messages[0]?.content ?? "").startsWith(CHECKPOINT_MARK));
    expect(after.length).toBeGreaterThanOrEqual(2);
    for (const request of after) {
      const frame = frameOf(request);
      expect(frame).toContain(CONSTRAINT);
      expect(frame).toContain(DECISION);
      expect(section(frame, "Hypotheses (UNVERIFIED")).toContain(HYPOTHESIS);
      expect(section(frame, "Failures")).toContain("src/auth/token-store.ts");
      // The first request's opening messages are gone from the conversation itself...
      expect(request.messages.some((m) => m.content === REQUEST)).toBe(false);
      // ...and the history the model sees stays near its ceiling instead of growing.
      const historyChars = request.messages.reduce((n, m) => n + (typeof m.content === "string" ? m.content.length : 0), 0);
      expect(historyChars).toBeLessThan(6_000 * 4 + 20_000);
    }

    const last = frameOf(provider.requests.at(-1)!);
    // Decisions from the first checkpoint survive every later one.
    expect(last).toContain("Checkpoint 1: keep reading the notes in order");
    // An unevidenced "fact" from a checkpoint is shown as a hypothesis.
    expect(section(last, "Hypotheses (UNVERIFIED")).toContain("say nothing about tenants");
    expect(section(last, "Facts (with evidence)")).not.toContain("say nothing about tenants");
    // The fact whose source file was rewritten is flagged, not silently served.
    expect(last).toMatch(new RegExp(`${FACT}.*\\[STALE`));
    // The file changed, with its revision, and the relevant code at its new revision.
    expect(last).toMatch(/Files changed this session: src\/auth\/cache\.ts@[0-9a-f]{7}/);
    // The code section is last in the frame, and its code blocks contain blank lines.
    expect(last.slice(last.indexOf("## RELEVANT CODE"))).toContain("src/auth/cache.ts");
    expect(last).toContain("tenantId");

    // Observability: a debug record went out before every model request.
    const debug = events.filter((e) => e.type === "context_debug");
    expect(debug.length).toBe(provider.requests.length);
    const lastDebug = (debug.at(-1) as { debug: { checkpoints: unknown[]; retrieved: unknown[]; tokens: { total: number } } }).debug;
    // The debug view keeps the most recent ten.
    expect(lastDebug.checkpoints.length).toBe(Math.min(10, checkpoints.length));
    expect(lastDebug.retrieved.length).toBeGreaterThan(0);
    expect(lastDebug.tokens.total).toBeGreaterThan(0);

    // The state is on disk.
    const saved = JSON.parse(fs.readFileSync(path.join(dir, statePathFor("s_continuity")), "utf8")) as {
      entries: { text: string; kind: string }[];
    };
    expect(saved.entries.some((e) => e.kind === "constraint" && e.text === CONSTRAINT)).toBe(true);

    // A second turn, from a fresh engine, starts with the same memory.
    resetIndexes();
    const next = agent();
    await runAgentTurn({
      workspaceId: wsId,
      sessionId: "s_continuity",
      mode: "bypass",
      history: result.history as LLMMessage[],
      userMessage: "Now add a test for two tenants.",
      sandboxRunner: runner,
      llmProvider: {
        name: "done",
        chatStream: async function* (options: LLMChatOptions) {
          next.requests.push(options);
          yield { type: "token", text: "Done." };
          yield { type: "stop", reason: "end_turn" };
        },
      },
    });
    const first = frameOf(next.requests[0]!);
    expect(first).toContain(CONSTRAINT);
    expect(first).toContain(DECISION);
    expect(first).toContain("Current request: Now add a test for two tenants.");
  }, 120_000);
});
