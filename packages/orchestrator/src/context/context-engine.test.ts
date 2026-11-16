/**
 * The context engine's promises, one component at a time.
 *
 * Retrieval finds code by more than one signal and will not hand back what is
 * already in context; the budget is configurable and self-consistent; state
 * deduplicates, goes stale when its source changes, and never lets a guess
 * become a fact; the tool gateway turns large output into a digest that points
 * at the whole of it. The end-to-end promise — a long task surviving several
 * checkpoints — is in `context-continuity.test.ts`.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { LocalSandboxRunner } from "@sqcode/sandbox-runner";
import type { LLMChatOptions, LLMMessage, LLMProvider, LLMResponseChunk } from "../types.js";
import { checkpointTierFor, effectiveCompactTokens } from "@sqcode/shared";
import { CHECKPOINT_KEEP_MIN, CHECKPOINT_RESTORE_MIN, CHECKPOINT_TARGET_TOTAL, budgetFor, parseBudgetOverrides } from "./budget.js";
import { callsOf, compileWorkingSet, detectPhase, requestInView } from "./compiler.js";
import { ContextEngine, withFrame } from "./engine.js";
import { RepoIndex, resetIndexes } from "./repo-index.js";
import { retrieve, type RetrievalQuery } from "./retrieval.js";
import { CHECKPOINT_MARK, checkpointHistory, mergeExtraction, parseExtraction } from "./state-checkpoint.js";
import { TaskStateStore, emptyTaskState, extractConstraints, renderTaskState } from "./task-state.js";
import { ARTIFACT_THRESHOLD, READ_THRESHOLD, artifactPathFor, gateHistory, normalizeOutput } from "./tool-gateway.js";

const FILES: Record<string, string> = {
  "src/auth/session.ts": [
    'import { cacheKeyFor } from "./cache";',
    "",
    "export interface Session { userId: string; tenantId: string; token: string }",
    "",
    "export function refreshToken(session: Session): Session {",
    "  const key = cacheKeyFor(session.userId);",
    "  const token = `${key}:${Date.now()}`;",
    "  return { ...session, token };",
    "}",
    "",
  ].join("\n"),
  "src/auth/cache.ts": [
    "const store = new Map<string, string>();",
    "",
    "export function cacheKeyFor(userId: string): string {",
    "  return `session:${userId}`;",
    "}",
    "",
    "export function remember(key: string, value: string): void {",
    "  store.set(key, value);",
    "}",
    "",
  ].join("\n"),
  "src/auth/session.test.ts": [
    'import { refreshToken } from "./session";',
    'it("refreshes", () => { refreshToken({ userId: "u", tenantId: "t", token: "" }); });',
    "",
  ].join("\n"),
  "src/billing/invoice.ts": [
    "export function totalOf(lines: { amount: number }[]): number {",
    "  return lines.reduce((sum, l) => sum + l.amount, 0);",
    "}",
    "",
    "export function formatInvoice(total: number): string {",
    "  return `Total: ${total.toFixed(2)}`;",
    "}",
    "",
  ].join("\n"),
  "README.md": "# Demo\n\nA demo project for the context engine tests.\n",
};

function query(overrides: Partial<RetrievalQuery> = {}): RetrievalQuery {
  return {
    text: "",
    phase: "discovery",
    focusFiles: [],
    modifiedFiles: [],
    taskFiles: [],
    currentStep: 1,
    inContext: new Map(),
    ...overrides,
  };
}

function scripted(reply: (options: LLMChatOptions) => string): LLMProvider {
  return {
    name: "scripted",
    async *chatStream(options): AsyncIterable<LLMResponseChunk> {
      yield { type: "token", text: reply(options) };
      yield { type: "stop", reason: "end_turn" };
    },
  };
}

const wsId = `ctx_ws_${Date.now()}`;
let runner: LocalSandboxRunner;
let dir: string;

beforeEach(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "sqcode_ctx_"));
  for (const [p, content] of Object.entries(FILES)) {
    fs.mkdirSync(path.dirname(path.join(dir, p)), { recursive: true });
    fs.writeFileSync(path.join(dir, p), content);
  }
  runner = new LocalSandboxRunner(dir);
  await runner.createWorkspace(wsId, { storagePath: dir });
});

afterEach(async () => {
  resetIndexes();
  await runner.destroyWorkspace(wsId);
  fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

describe("repository index and retrieval", () => {
  it("indexes symbols, imports and tests", async () => {
    const index = new RepoIndex(runner, wsId);
    await index.refresh(true);
    expect(index.symbolDefs.get("refreshtoken")?.[0]?.path ?? index.symbolDefs.get("refreshToken")?.[0]?.path).toBe(
      "src/auth/session.ts",
    );
    expect(index.neighbours("src/auth/cache.ts").importedBy).toContain("src/auth/session.ts");
    expect(index.testsFor("src/auth/session.ts")).toContain("src/auth/session.test.ts");
  });

  it("ranks the definition of a named symbol first, and says why", async () => {
    const index = new RepoIndex(runner, wsId);
    await index.refresh(true);
    const result = retrieve(index, query({ text: "Why does refreshToken produce the same token for two tenants?" }));
    expect(result.items[0]?.chunk.path).toBe("src/auth/session.ts");
    expect(result.items[0]?.reasons.join(" ")).toMatch(/defines `refreshToken`/);
  });

  it("follows imports out of the file being worked on", async () => {
    const index = new RepoIndex(runner, wsId);
    await index.refresh(true);
    const result = retrieve(index, query({ text: "token", focusFiles: ["src/auth/session.ts"] }));
    const cache = result.items.find((i) => i.chunk.path === "src/auth/cache.ts");
    expect(cache).toBeDefined();
    expect(cache!.reasons.join(" ")).toMatch(/one import away/);
    // Unrelated code does not ride along.
    expect(result.items.some((i) => i.chunk.path === "src/billing/invoice.ts")).toBe(false);
  });

  it("weights an error's paths and symbols when debugging", async () => {
    const index = new RepoIndex(runner, wsId);
    await index.refresh(true);
    const result = retrieve(
      index,
      query({
        text: "fix the failing test",
        phase: "debugging",
        errorText: "TypeError: cacheKeyFor returned undefined\n    at cacheKeyFor (src/auth/cache.ts:4:10)",
      }),
    );
    expect(result.items[0]?.chunk.path).toBe("src/auth/cache.ts");
  });

  it("does not hand back what the conversation already shows", async () => {
    const index = new RepoIndex(runner, wsId);
    await index.refresh(true);
    const fresh = retrieve(index, query({ text: "refreshToken cacheKeyFor" }));
    expect(fresh.items.some((i) => i.chunk.path === "src/auth/session.ts")).toBe(true);

    const seen = retrieve(
      index,
      query({ text: "refreshToken cacheKeyFor", inContext: new Map([["src/auth/session.ts", "read"]]) }),
    );
    expect(seen.items.some((i) => i.chunk.path === "src/auth/session.ts")).toBe(false);
    expect(seen.duplicates).toBeGreaterThan(0);
    expect(seen.duplicateTokens).toBeGreaterThan(0);
  });

  it("brings in the tests of a changed file when testing", async () => {
    const index = new RepoIndex(runner, wsId);
    await index.refresh(true);
    const result = retrieve(
      index,
      query({ text: "run the tests", phase: "testing", modifiedFiles: [{ path: "src/auth/session.ts", step: 1 }] }),
    );
    const test = result.items.find((i) => i.chunk.path === "src/auth/session.test.ts");
    expect(test?.reasons.join(" ")).toMatch(/tests src\/auth\/session.ts/);
  });

  it("re-reads a file marked dirty, so retrieval never serves an old revision", async () => {
    const index = new RepoIndex(runner, wsId);
    await index.refresh(true);
    const before = index.files.get("src/auth/cache.ts")!.hash;
    fs.writeFileSync(
      path.join(dir, "src/auth/cache.ts"),
      "export function cacheKeyFor(userId: string, tenantId: string): string {\n  return `session:${tenantId}:${userId}`;\n}\n",
    );
    index.markDirty("src/auth/cache.ts");
    const changed = await index.refresh(false);
    expect(changed).toContain("src/auth/cache.ts");
    expect(index.files.get("src/auth/cache.ts")!.hash).not.toBe(before);
    const result = retrieve(index, query({ text: "cacheKeyFor tenantId" }));
    expect(result.items[0]?.chunk.text).toContain("tenantId");
  });
});

describe("the context budget", () => {
  it("is self-consistent for every window size", () => {
    for (const window of [8_192, 32_000, 128_000, 1_000_000]) {
      const b = budgetFor({ window, systemTokens: 3_000, toolTokens: 4_000, overrides: {} });
      expect(b.checkpointAt).toBeLessThanOrEqual(b.historyMax);
      expect(b.historyMax).toBeLessThanOrEqual(b.hardHistoryLimit);
      expect(b.checkpointKeep).toBeLessThanOrEqual(b.checkpointAt / 2);
      expect(b.stateMax).toBeLessThan(b.workingSet);
      // Reserved space and the history ceiling never exceed the window.
      expect(b.reserveOutput + b.system + b.tools + b.workingSet + b.hardHistoryLimit).toBeLessThanOrEqual(
        Math.max(window, b.reserveOutput + b.system + b.tools + b.workingSet + 4_000),
      );
    }
  });

  it("checkpoints at the window's tier when nobody has set a threshold", () => {
    // Without a default a 1M-token session re-sent 359k tokens of history every step and never checkpointed;
    // with one fixed 160k point it re-read its files after every cut while most of its window sat unused.
    const unset = budgetFor({ window: 1_000_000, systemTokens: 3_000, toolTokens: 4_000, overrides: {} });
    // Half again as late as it was (19 Oct 2026): about 540k of request on a 1M model.
    expect(unset.checkpointAt).toBe(480_000);
    // What a cut leaves is about 32k of the whole request (29 Oct 2026): prompt, tools, state and conversation.
    expect(3_000 + 4_000 + unset.stateMax + unset.checkpointKeep + unset.restoreTokens).toBe(CHECKPOINT_TARGET_TOTAL);
    // And the meter shows that point, not "100%": system + tools + working set + the history point.
    expect(effectiveCompactTokens(null, 1_000_000, 7_000 + unset.workingSet)).toBe(7_000 + unset.workingSet + 480_000);
    expect(effectiveCompactTokens(80, 1_000_000, 20_000)).toBe(800_000);
    // A 128k model checkpoints at 80k of conversation, well inside its window.
    expect(effectiveCompactTokens(null, 128_000, 10_000)).toBe(90_000);
  });

  it("sizes what a checkpoint keeps by what every request already carries (29 Oct 2026: 100k after a cut)", () => {
    // The person's setup before deferred tools: 19k of prompt, 43k of tools. Nothing fits under 32k, so the floors hold.
    const heavy = budgetFor({ window: 1_000_000, systemTokens: 19_100, toolTokens: 43_300, overrides: {} });
    expect(heavy.checkpointKeep).toBe(CHECKPOINT_KEEP_MIN);
    expect(heavy.restoreTokens).toBe(CHECKPOINT_RESTORE_MIN);
    // A light one keeps more, but never more than the tier did.
    const light = budgetFor({ window: 1_000_000, systemTokens: 1_000, toolTokens: 1_000, overrides: {} });
    expect(light.checkpointKeep).toBeGreaterThan(heavy.checkpointKeep);
    expect(light.checkpointKeep).toBeLessThanOrEqual(24_000);
    expect(1_000 + 1_000 + light.stateMax + light.checkpointKeep + light.restoreTokens).toBe(CHECKPOINT_TARGET_TOTAL);
    // An override still wins.
    expect(budgetFor({ window: 1_000_000, systemTokens: 3_000, toolTokens: 4_000, overrides: { "*": { checkpointKeep: 30_000 } } }).checkpointKeep).toBe(30_000);
  });

  it("scales every default with the window: five tiers", () => {
    expect([128_000, 200_000, 400_000, 1_000_000, 2_000_000].map((w) => checkpointTierFor(w).checkpointAt)).toEqual([80_000, 120_000, 240_000, 480_000, 960_000]);
    expect([200_000, 400_000, 1_000_000, 2_000_000].map((w) => checkpointTierFor(w).keep)).toEqual([16_000, 24_000, 24_000, 24_000]);
    expect([200_000, 2_000_000].map((w) => checkpointTierFor(w).restoreTokens)).toEqual([6_000, 8_000]);
  });

  it("checkpoints where the person's threshold says, when they set one", () => {
    // Reported 24 Sep 2026: a 1M-token model set to compact at 100% was compacted at ~21%.
    const at100 = budgetFor({ window: 1_000_000, systemTokens: 3_000, toolTokens: 4_000, autoCompactTokens: 1_000_000, overrides: {} });
    expect(at100.checkpointAt).toBeGreaterThan(800_000);
    const at50 = budgetFor({ window: 1_000_000, systemTokens: 3_000, toolTokens: 4_000, autoCompactTokens: 500_000, overrides: {} });
    expect(at50.checkpointAt).toBeLessThanOrEqual(500_000);
    expect(at50.checkpointAt).toBeGreaterThan(450_000);
    // A smaller ceiling is still a configuration choice.
    const capped = budgetFor({ window: 1_000_000, systemTokens: 3_000, toolTokens: 4_000, autoCompactTokens: 1_000_000, overrides: { "*": { historyMax: 160_000 } } });
    expect(capped.checkpointAt).toBe(160_000);
  });

  it("is configurable per model, with a wildcard", () => {
    const overrides = parseBudgetOverrides('{"*":{"historyMax":20000},"small-model":{"historyMax":9000,"workingSet":2500}}');
    const any = budgetFor({ model: "other", window: 128_000, systemTokens: 1_000, toolTokens: 1_000, overrides });
    const small = budgetFor({ model: "small-model", window: 128_000, systemTokens: 1_000, toolTokens: 1_000, overrides });
    expect(any.historyMax).toBe(20_000);
    expect(small.historyMax).toBe(9_000);
    expect(small.workingSet).toBe(2_500);
    expect(parseBudgetOverrides("not json")).toEqual({});
  });

  it("honours the person's own compaction threshold", () => {
    const b = budgetFor({ window: 128_000, systemTokens: 2_000, toolTokens: 2_000, autoCompactTokens: 30_000, overrides: {} });
    expect(b.checkpointAt).toBeLessThanOrEqual(30_000 - 4_000);
  });
});

describe("task state", () => {
  it("reads constraints out of a request, and not questions", () => {
    const found = extractConstraints(
      "Fix the login bug. Do not change the public API of session.ts. Can you also check the README? Never add dependencies.",
    );
    expect(found).toContain("Do not change the public API of session.ts.");
    expect(found).toContain("Never add dependencies.");
    expect(found.some((s) => s.includes("README"))).toBe(false);
  });

  it("deduplicates the same claim, and never changes its kind", () => {
    const store = new TaskStateStore(emptyTaskState("s"));
    const a = store.add({ kind: "hypothesis", text: "The cache key ignores the tenant", source: { type: "model", ref: "x" } });
    const b = store.add({ kind: "hypothesis", text: "the cache key  ignores the tenant.", source: { type: "model", ref: "x" } });
    expect(b.id).toBe(a.id);
    // The same words as a fact are a different entry; the hypothesis stays one.
    const c = store.add({ kind: "fact", text: "The cache key ignores the tenant", source: { type: "file", ref: "src/auth/cache.ts" } });
    expect(c.id).not.toBe(a.id);
    expect(store.state.entries.find((e) => e.id === a.id)?.kind).toBe("hypothesis");
  });

  it("marks what was derived from a file stale when the file changes — but not constraints or decisions", () => {
    const store = new TaskStateStore(emptyTaskState("s"));
    const fact = store.add({ kind: "fact", text: "cacheKeyFor takes one argument", source: { type: "file", ref: "src/auth/cache.ts", lines: [3, 5] } });
    const decision = store.add({ kind: "decision", text: "Fix it in cache.ts", source: { type: "file", ref: "src/auth/cache.ts" } });
    const other = store.add({ kind: "fact", text: "totalOf sums amounts", source: { type: "file", ref: "src/billing/invoice.ts" } });

    const invalidated = store.recordFile("./src/auth/cache.ts", "edit", "abc123");
    expect(invalidated).toEqual([fact.id]);
    expect(store.state.entries.find((e) => e.id === fact.id)?.status).toBe("stale");
    expect(store.state.entries.find((e) => e.id === decision.id)?.status).toBe("active");
    expect(store.state.entries.find((e) => e.id === other.id)?.status).toBe("active");
    expect(renderTaskState(store.state, 4_000).text).toMatch(/cacheKeyFor takes one argument.*\[STALE/);
  });

  // The four below were found by a live run with a real model, not by design.

  it("keeps a changed file listed as changed after the agent reads it back", () => {
    const store = new TaskStateStore(emptyTaskState("s"));
    store.recordFile("src/token-estimate.ts", "edit", "aaaa1111");
    store.recordFile("src/token-estimate.ts", "read", "bbbb2222");
    expect(store.modifiedFiles().map((f) => [f.path, f.lastAction, f.hash])).toEqual([["src/token-estimate.ts", "edit", "bbbb2222"]]);
  });

  it("invalidates a checkpointed fact whose evidence names the file, but not one naming a sibling", () => {
    const store = new TaskStateStore(emptyTaskState("s"));
    const named = store.add({
      kind: "fact",
      text: "registerContextWindow rejects tokens below 1_024",
      source: { type: "transcript", ref: "messages 1-12 (checkpoint 2) · read_file src/token-estimate.ts lines 95-171" },
    });
    const sibling = store.add({
      kind: "fact",
      text: "the test file asserts the fallback is small",
      source: { type: "transcript", ref: "messages 1-12 (checkpoint 2) · read_file src/token-estimate.test.ts" },
    });
    const plan = store.add({ kind: "next_action", text: "run the tests", source: { type: "file", ref: "src/token-estimate.ts" } });
    expect(store.recordFile("src/token-estimate.ts", "edit")).toEqual([named.id]);
    expect(store.state.entries.find((e) => e.id === sibling.id)?.status).toBe("active");
    // An intention about a file is not a claim about its contents.
    expect(store.state.entries.find((e) => e.id === plan.id)?.status).toBe("active");
  });

  it("recognises verification commands by how they are invoked, not by the word 'test'", async () => {
    const { VERIFY_COMMAND } = await import("./compiler.js");
    for (const yes of ["npm test", "npx vitest run src/a.test.ts", "pnpm run typecheck", "tsc --noEmit", "go test ./...", "python -m pytest -q", "cd pkg && npx tsc -p ."]) {
      expect(VERIFY_COMMAND.test(yes), yes).toBe(true);
    }
    for (const no of ["Test-Path node_modules; Test-Path node_modules/vitest", "Get-ChildItem -Filter tsconfig*.json", "Copy-Item src/a.test.ts tmp/", "cat test.log"]) {
      expect(VERIFY_COMMAND.test(no), no).toBe(false);
    }
  });

  it("takes the plan from todo items as the loop writes them (title, not text)", () => {
    const store = new TaskStateStore(emptyTaskState("s"));
    store.setPlan([{ title: "Read the fallback", status: "completed" }, { title: "Add the override", status: "in_progress" }]);
    expect(store.state.plan).toEqual([
      { text: "Read the fallback", status: "completed" },
      { text: "Add the override", status: "in_progress" },
    ]);
  });

  it("never cuts constraints to fit the budget", () => {
    const store = new TaskStateStore(emptyTaskState("s"));
    store.addRequest("Refactor the billing module. Do not touch the public exports.");
    for (let i = 0; i < 30; i++) {
      store.add({ kind: "observation", text: `observation number ${i} `.repeat(8), source: { type: "tool", ref: "t" } });
    }
    const view = renderTaskState(store.state, 150);
    expect(view.text).toContain("Do not touch the public exports.");
    expect(view.omitted).toBeGreaterThan(0);
  });

  it("survives a save and a load", async () => {
    const store = await TaskStateStore.load(runner, wsId, "s_persist");
    store.addRequest("Keep the old API working.");
    store.add({ kind: "decision", text: "Use a wrapper", source: { type: "model", ref: "turn" } });
    expect(await store.save()).toBe(true);
    const again = await TaskStateStore.load(runner, wsId, "s_persist");
    expect(again.state.entries.map((e) => e.text)).toEqual(expect.arrayContaining(["Keep the old API working.", "Use a wrapper"]));
    // New ids continue after the loaded ones.
    expect(again.add({ kind: "fact", text: "new", source: { type: "file", ref: "a.ts" } }).id).not.toBe(
      store.state.entries[0]!.id,
    );
  });
});

describe("update_task_state", () => {
  it("records a fact without evidence as an observation, and says so", async () => {
    const engine = await ContextEngine.open({ runner, workspaceId: wsId, sessionId: "s_tool", withoutIndex: true });
    const result = engine.updateTaskState({
      add: [
        { kind: "fact", text: "The bug is in the cache" },
        { kind: "fact", text: "cacheKeyFor omits tenantId", source: "src/auth/cache.ts:3-5" },
        { kind: "hypothesis", text: "Tokens collide across tenants" },
      ],
    });
    expect(result.success).toBe(true);
    const kinds = Object.fromEntries(engine.store.state.entries.map((e) => [e.text, e.kind]));
    expect(kinds["The bug is in the cache"]).toBe("observation");
    expect(kinds["cacheKeyFor omits tenantId"]).toBe("fact");
    expect(kinds["Tokens collide across tenants"]).toBe("hypothesis");
    expect(JSON.stringify(result.data)).toMatch(/needs a source/);

    const fact = engine.store.state.entries.find((e) => e.text === "cacheKeyFor omits tenantId")!;
    expect(fact.source.ref).toBe("src/auth/cache.ts");
    expect(fact.source.lines).toEqual([3, 5]);

    const hyp = engine.store.state.entries.find((e) => e.kind === "hypothesis")!;
    engine.updateTaskState({ update: [{ id: hyp.id, status: "confirmed", note: "reproduced with two tenants" }] });
    expect(engine.store.state.entries.find((e) => e.id === hyp.id)?.kind).toBe("hypothesis");
    expect(engine.store.state.entries.find((e) => e.id === hyp.id)?.status).toBe("confirmed");
  });

  it("closes a whole kind in one call (all:next_action), and leaves the other kinds alone", async () => {
    const engine = await ContextEngine.open({ runner, workspaceId: wsId, sessionId: "s_bulk", withoutIndex: true });
    engine.updateTaskState({
      add: [
        { kind: "next_action", text: "wire the menu" },
        { kind: "next_action", text: "add the boss wave" },
        { kind: "decision", text: "Use Phaser 3" },
      ],
    });
    const result = engine.updateTaskState({ update: [{ id: "all:next_action", status: "done" }] });
    expect(result.success).toBe(true);
    const byText = Object.fromEntries(engine.store.state.entries.map((e) => [e.text, e.status]));
    expect(byText["wire the menu"]).toBe("done");
    expect(byText["add the boss wave"]).toBe("done");
    expect(byText["Use Phaser 3"]).toBe("active");
    expect(engine.updateTaskState({ update: [{ id: "all:nonsense", status: "done" }] }).success).toBe(false);
  });

  it("answers retrieve_context with locations, revisions and reasons", async () => {
    const engine = await ContextEngine.open({ runner, workspaceId: wsId, sessionId: "s_retrieve" });
    const result = await engine.retrieveContext({ query: "where is the session cache key built", detail: "code" });
    expect(result.success).toBe(true);
    const data = result.data as { results: { location: string; revision: string; why: string[]; code?: string }[] };
    const cache = data.results.find((r) => r.location.startsWith("src/auth/cache.ts"));
    expect(cache).toBeDefined();
    expect(cache!.revision).toMatch(/^[0-9a-f]{7}$/);
    expect(data.results.some((r) => r.code?.includes("cacheKeyFor"))).toBe(true);
  });
});

describe("session lifecycle", () => {
  it("seeds an older session's goal and constraints from its first request only", async () => {
    const engine = await ContextEngine.open({ runner, workspaceId: wsId, sessionId: "s_seed", withoutIndex: true });
    engine.seedFrom([
      { role: "user", content: "[Context summary] earlier work" },
      { role: "user", content: "Port the parser. Never break the CLI flags." },
      { role: "assistant", content: "ok" },
      { role: "user", content: "Before you finish: do not claim a check that is not listed." },
    ]);
    expect(engine.store.state.goal).toBe("Port the parser. Never break the CLI flags.");
    const constraints = engine.store.state.entries.filter((e) => e.kind === "constraint").map((e) => e.text);
    expect(constraints).toEqual(["Never break the CLI flags."]);
    // A session that already has state is left alone.
    engine.seedFrom([{ role: "user", content: "Something else entirely. Always use tabs." }]);
    expect(engine.store.state.requests).toHaveLength(1);
  });

  it("forgets a session's memory when its conversation is rewound", async () => {
    const engine = await ContextEngine.open({ runner, workspaceId: wsId, sessionId: "s_rewind", withoutIndex: true });
    engine.observeUserMessage("Use Postgres. Do not use SQLite.");
    await engine.persist();
    await ContextEngine.reset(runner, wsId, "s_rewind");
    const again = await ContextEngine.open({ runner, workspaceId: wsId, sessionId: "s_rewind", withoutIndex: true });
    expect(again.store.state.entries).toHaveLength(0);
    expect(again.store.state.goal).toBe("");
  });
});

describe("the tool output gateway", () => {
  it("normalises terminal noise and repeated lines", () => {
    const text = "\u001b[32mok\u001b[0m\r\n" + "progress 50%\n".repeat(20) + "done";
    const out = normalizeOutput(text);
    expect(out).not.toContain("\u001b");
    expect(out).not.toContain("\r");
    expect(out).toMatch(/×\d+/);
    expect(out.split("\n").length).toBeLessThan(10);
  });

  it("shows a large output as a digest that keeps the errors and points at the artifact", () => {
    const lines = Array.from({ length: 800 }, (_, i) => `  line ${i}: compiled module ${i}`);
    lines.splice(400, 0, "src/auth/cache.ts(4,10): error TS2345: Argument of type 'number' is not assignable");
    const big = lines.join("\n");
    const history: LLMMessage[] = [
      { role: "user", content: "build it" },
      { role: "assistant", content: "", toolCalls: [{ id: "c1", name: "run_command", input: { command: "tsc" } }] },
      { role: "tool", toolCallId: "c1", content: big },
      { role: "assistant", content: "", toolCalls: [{ id: "c2", name: "run_command", input: { command: "ls" } }] },
      { role: "tool", toolCallId: "c2", content: "a.ts\nb.ts" },
    ];
    const gated = gateHistory(history, "s_gate");
    const digest = String(gated.messages[2]!.content);
    expect(big.length).toBeGreaterThan(ARTIFACT_THRESHOLD);
    expect(digest.length).toBeLessThan(big.length / 3);
    expect(digest).toContain("error TS2345");
    expect(digest).toContain(artifactPathFor("s_gate", "run_command", big));
    // Small output, and the original history, untouched.
    expect(gated.messages[4]).toBe(history[4]);
    expect(history[2]!.content).toBe(big);
    expect(gated.stats.gated).toBe(1);
  });

  it("leaves a fresh 900-line read whole: 16,000 characters cut it to key lines before it was seen (29 Oct 2026)", () => {
    const big = Array.from({ length: 900 }, (_, i) => `export const value${i} = ${i}; // line ${i}`).join("\n");
    const history: LLMMessage[] = [
      { role: "user", content: "look" },
      { role: "assistant", content: "", toolCalls: [{ id: "a", name: "read_file", input: { path: "src/big.ts" } }] },
      { role: "tool", toolCallId: "a", content: big },
    ];
    const gated = gateHistory(history, "s_read");
    expect(big.length).toBeGreaterThan(16_000);
    expect(gated.messages[2]).toBe(history[2]);
    expect(gated.stats.gated).toBe(0);
  });

  it("points a read bigger than any page back at the file, and leaves a ranged read alone", () => {
    // Only a read from before paging (a stored session) can be this big now.
    const big = Array.from({ length: 6_000 }, (_, i) => `export const value${i} = ${i}; // line ${i}`).join("\n");
    expect(big.length).toBeGreaterThan(READ_THRESHOLD);
    const history: LLMMessage[] = [
      { role: "user", content: "look" },
      { role: "assistant", content: "", toolCalls: [{ id: "a", name: "read_file", input: { path: "src/big.ts" } }] },
      { role: "tool", toolCallId: "a", content: big },
      { role: "assistant", content: "", toolCalls: [{ id: "b", name: "read_file", input: { path: "src/big.ts", start_line: 1, end_line: 6_000 } }] },
      { role: "tool", toolCallId: "b", content: big },
    ];
    const gated = gateHistory(history, "s_read");
    const whole = String(gated.messages[2]!.content);
    expect(whole.length).toBeLessThan(big.length / 3);
    expect(whole).toContain("read_file src/big.ts with start_line/end_line");
    expect(whole).not.toContain(".soreqen/artifacts/");
    // The agent asked for exactly this range: it gets it.
    expect(gated.messages[4]).toBe(history[4]);
    expect(gated.stats.artifacts).toHaveLength(0);
  });

  it("marks a read that a later write overtook as stale", () => {
    const history: LLMMessage[] = [
      { role: "user", content: "edit" },
      { role: "assistant", content: "", toolCalls: [{ id: "r", name: "read_file", input: { path: "a.ts" } }] },
      { role: "tool", toolCallId: "r", content: "old contents" },
      { role: "assistant", content: "", toolCalls: [{ id: "w", name: "edit_file", input: { path: "./a.ts" } }] },
      { role: "tool", toolCallId: "w", content: "edited" },
    ];
    const gated = gateHistory(history, "s");
    expect(String(gated.messages[2]!.content)).toMatch(/^\[STALE: a.ts was changed after this read/);
    expect(gated.stats.staleReads).toBe(1);
  });

  it("saves the whole output as an artifact the digest can point at", async () => {
    const engine = await ContextEngine.open({ runner, workspaceId: wsId, sessionId: "s_art", withoutIndex: true });
    const clipped = "x".repeat(7_000);
    const full = `${clipped}\nTHE PART THE CLIP REMOVED`;
    await engine.observeToolResult({
      call: { id: "c", name: "run_command", input: { command: "big" } },
      success: true,
      content: clipped,
      full,
    });
    const artifact = artifactPathFor("s_art", "run_command", clipped);
    expect(fs.readFileSync(path.join(dir, artifact), "utf8")).toContain("THE PART THE CLIP REMOVED");
  });
});

describe("the engine's view of a step", () => {
  it("records failures, resolves them when the same call later passes, and tracks files", async () => {
    const engine = await ContextEngine.open({ runner, workspaceId: wsId, sessionId: "s_obs", withoutIndex: true });
    const call = { id: "t1", name: "run_command", input: { command: "npm test" } };
    await engine.observeToolResult({ call, success: false, content: "FAILED: exit 1\n\nError: expected 2 to be 3" });
    const failure = engine.store.state.entries.find((e) => e.kind === "failure")!;
    expect(failure.text).toMatch(/expected 2 to be 3/);
    await engine.observeToolResult({ call: { ...call, id: "t2" }, success: true, content: "12 passed" });
    expect(engine.store.state.entries.find((e) => e.id === failure.id)?.status).toBe("resolved");

    await engine.observeToolResult({
      call: { id: "w", name: "write_file", input: { path: "src/new.ts", content: "export const a = 1;\n" } },
      success: true,
      content: "ok",
    });
    expect(engine.store.modifiedFiles().map((f) => f.path)).toContain("src/new.ts");
  });

  it("detects the phase from what was just done", () => {
    const h = (name: string, input: Record<string, unknown>, content: string): LLMMessage[] => [
      { role: "assistant", content: "", toolCalls: [{ id: name + content.length, name, input }] },
      { role: "tool", toolCallId: name + content.length, content },
    ];
    expect(detectPhase(callsOf([...h("read_file", { path: "a" }, "x")]))).toBe("discovery");
    expect(detectPhase(callsOf([...h("edit_file", { path: "a" }, "ok")]))).toBe("implementation");
    expect(detectPhase(callsOf([...h("run_command", { command: "npx vitest run" }, "ok")]))).toBe("testing");
    expect(detectPhase(callsOf([...h("run_command", { command: "node x" }, "FAILED: boom")]))).toBe("debugging");
    expect(detectPhase([], "review")).toBe("review");
  });

  it("compiles a working set within its budget, state first", async () => {
    const index = new RepoIndex(runner, wsId);
    await index.refresh(true);
    const store = new TaskStateStore(emptyTaskState("s"));
    store.addRequest("Fix refreshToken so tokens differ per tenant. Do not change the Session interface.");
    const ws = compileWorkingSet({ state: store.state, index, history: [], phase: "discovery", budgetTokens: 1_500, stateBudgetTokens: 600 });
    expect(ws.tokens).toBeLessThanOrEqual(1_500);
    expect(ws.text.indexOf("## TASK STATE")).toBeLessThan(ws.text.indexOf("## RELEVANT CODE"));
    expect(ws.text).toContain("Do not change the Session interface.");
    expect(ws.retrieved[0]?.path).toBe("src/auth/session.ts");
    expect(ws.retrieved[0]?.reasons.length).toBeGreaterThan(0);
  });

  it("adds the frame to the request without touching the stored history", () => {
    const history: LLMMessage[] = [
      { role: "user", content: "go" },
      { role: "assistant", content: "", toolCalls: [{ id: "a", name: "list_directory", input: {} }] },
      { role: "tool", toolCallId: "a", content: "x" },
    ];
    const sent = withFrame(history, "## TASK STATE\n…");
    expect(sent.length).toBe(4);
    expect(sent[3]!.role).toBe("user");
    expect(history.length).toBe(3);
  });
});

describe("checkpointing into state", () => {
  it("parses the JSON however it is wrapped", () => {
    expect(parseExtraction('Here you go:\n```json\n{"decisions":[{"text":"a"}]}\n```')).toEqual({ decisions: [{ text: "a" }] });
    expect(parseExtraction("no json at all")).toBeNull();
  });

  it("keeps every complete item of a reply cut off mid-array", () => {
    const cutOff = '{"decisions":[{"text":"Use a wrapper"},{"text":"Keep the {braces} and \\"quotes\\""}],"facts":[{"text":"port 4000","source":"a.ts:1"},{"text":"half a fa';
    expect(parseExtraction(cutOff)).toEqual({
      decisions: [{ text: "Use a wrapper" }, { text: 'Keep the {braces} and "quotes"' }],
      facts: [{ text: "port 4000", source: "a.ts:1" }],
    });
    expect(parseExtraction('{"decisions":[{"text":"a"},],}')).toEqual({ decisions: [{ text: "a" }] });
  });

  it("retries a stretch it could not read as two halves, and says why when it still cannot", async () => {
    const store = new TaskStateStore(emptyTaskState("s"));
    const history: LLMMessage[] = [{ role: "user", content: "task" }];
    for (let i = 0; i < 20; i++) {
      history.push({ role: "assistant", content: "", toolCalls: [{ id: `r${i}`, name: "read_file", input: { path: `f${i}` } }] });
      history.push({ role: "tool", toolCallId: `r${i}`, content: "y".repeat(1_200) });
    }
    let calls = 0;
    const second = await checkpointHistory({
      history,
      store,
      provider: scripted(() => (++calls === 1 ? "I will now extract." : '{"decisions":[{"text":"second time lucky"}]}')),
      keepRecentTokens: 1_000,
    });
    // Prose instead of JSON: asked once more, strictly, for the same stretch — not split into pieces.
    expect(calls).toBe(2);
    expect(second).not.toBeNull();
    expect(store.state.entries.map((e) => e.text)).toContain("second time lucky");

    // A reply that ran out before its JSON closed was too much at once: each half is read on its own.
    let halves = 0;
    const split = await checkpointHistory({
      history,
      store: new TaskStateStore(emptyTaskState("s3")),
      provider: scripted(() => (++halves === 1 ? `{"facts":[{"text":"${"z".repeat(7_000)}` : '{"decisions":[{"text":"half"}]}')),
      keepRecentTokens: 1_000,
    });
    expect(halves).toBe(3);
    expect(split).not.toBeNull();

    // A provider that is down is not asked fifteen more times: once, and the next read tries again.
    let outage = 0;
    const down = await checkpointHistory({
      history,
      store: new TaskStateStore(emptyTaskState("s4")),
      provider: {
        name: "down",
        async *chatStream() {
          outage++;
          throw new Error("503 Service Unavailable");
        },
      },
      keepRecentTokens: 1_000,
    });
    expect(down).toBeNull();
    expect(outage).toBe(1);

    let why = "";
    const none = await checkpointHistory({
      history,
      store: new TaskStateStore(emptyTaskState("s2")),
      provider: scripted(() => "no"),
      keepRecentTokens: 1_000,
      onFailure: (reason) => {
        why = reason;
      },
    });
    expect(none).toBeNull();
    expect(why).toMatch(/not JSON/);
  });

  it("never merges a hypothesis, or an unevidenced fact, as a fact", () => {
    const store = new TaskStateStore(emptyTaskState("s"));
    mergeExtraction(
      store,
      {
        facts: [{ text: "The port is 4000", source: "server.ts:12" }, { text: "The cache is the culprit" }],
        hypotheses: [
          { text: "Retry storms cause the timeout", status: "open" },
          { text: "The key omits the tenant", status: "confirmed" },
        ],
        decisions: [{ text: "Keep the retry logic" }],
      },
      "messages 1-20",
    );
    const byText = Object.fromEntries(store.state.entries.map((e) => [e.text, e]));
    expect(byText["The port is 4000"]?.kind).toBe("fact");
    expect(byText["The cache is the culprit"]?.kind).toBe("hypothesis");
    expect(byText["Retry storms cause the timeout"]?.kind).toBe("hypothesis");
    expect(byText["The key omits the tenant"]?.kind).toBe("hypothesis");
    expect(byText["The key omits the tenant"]?.status).toBe("confirmed");
    expect(byText["Keep the retry logic"]?.kind).toBe("decision");
  });

  it("replaces the older messages with a marker and keeps the recent ones verbatim", async () => {
    const store = new TaskStateStore(emptyTaskState("s"));
    const history: LLMMessage[] = [{ role: "user", content: "the task", id: "m0" }];
    for (let i = 0; i < 20; i++) {
      history.push({ role: "assistant", content: "", toolCalls: [{ id: `r${i}`, name: "read_file", input: { path: `f${i}` } }], id: `a${i}` });
      history.push({ role: "tool", toolCallId: `r${i}`, content: `file ${i} `.repeat(300), id: `t${i}` });
    }
    let sawTranscript = "";
    const provider = scripted((o) => {
      sawTranscript = String(o.messages[0]!.content);
      return '{"decisions":[{"text":"Read every file in order"}],"next_actions":[{"text":"Read f20"}]}';
    });
    const result = await checkpointHistory({ history, store, provider, keepRecentTokens: 2_000 });
    expect(result).not.toBeNull();
    expect(String(result!.history[0]!.content).startsWith(CHECKPOINT_MARK)).toBe(true);
    expect(result!.history.at(-1)).toBe(history.at(-1));
    expect(result!.tokensAfter).toBeLessThan(result!.tokensBefore);
    expect(result!.coversThroughId).toBeDefined();
    expect(sawTranscript).toContain("<current_state>");
    expect(store.state.entries.map((e) => e.text)).toContain("Read every file in order");
    expect(store.state.checkpoints).toHaveLength(1);
  });

  it("returns null, and removes nothing, when the extraction is not JSON", async () => {
    const store = new TaskStateStore(emptyTaskState("s"));
    const history: LLMMessage[] = [{ role: "user", content: "task" }];
    for (let i = 0; i < 20; i++) {
      history.push({ role: "assistant", content: "", toolCalls: [{ id: `r${i}`, name: "read_file", input: { path: `f${i}` } }] });
      history.push({ role: "tool", toolCallId: `r${i}`, content: "y".repeat(1_200) });
    }
    const result = await checkpointHistory({ history, store, provider: scripted(() => "Sorry, I can't."), keepRecentTokens: 1_000 });
    expect(result).toBeNull();
    expect(store.state.checkpoints).toHaveLength(0);
  });
});

describe("the person's own words through a checkpoint (15 Oct 2026)", () => {
  /*
   * A long spec was read for extraction as its first and last 3,000
   * characters, and the message was then dropped: its middle was lost.
   */
  const spec = `Build the billing page. ${Array.from({ length: 120 }, (_, i) => `Requirement ${i}: rule number ${i} applies.`).join(" ")} The very last rule: never round totals.`;

  const historyWith = (request: string): LLMMessage[] => {
    const history: LLMMessage[] = [{ role: "user", content: request }];
    for (let i = 0; i < 40; i++) {
      history.push({ role: "assistant", content: "", toolCalls: [{ id: `r${i}`, name: "read_file", input: { path: `f${i}` } }] });
      history.push({ role: "tool", toolCallId: `r${i}`, content: "y".repeat(1_200) });
    }
    return history;
  };

  it("reads the whole request when extracting, and keeps it word for word in the marker", async () => {
    let read = "";
    const result = await checkpointHistory({
      history: historyWith(spec),
      store: new TaskStateStore(emptyTaskState("s_words")),
      provider: scripted((o) => {
        read += String(o.messages[0]?.content ?? "");
        return "{}";
      }),
      keepRecentTokens: 9_000,
    });
    expect(result).not.toBeNull();
    // The middle of the request reached the extraction.
    expect(read).toContain("Requirement 60: rule number 60 applies.");
    const marker = String(result!.history[0]!.content);
    expect(marker.startsWith(CHECKPOINT_MARK)).toBe(true);
    expect(marker).toContain("Requirement 60: rule number 60 applies.");
    expect(marker).toContain("The very last rule: never round totals.");
  });

  it("names the file a long request is saved in, on the request line every step shows", () => {
    const store = new TaskStateStore(emptyTaskState("s_long"));
    store.addRequest(spec);
    store.attachRequestFile(".soreqen/artifacts/s_long/request-1.md", spec.length);
    const shown = renderTaskState(store.state, 4_000).text;
    expect(shown).toContain(".soreqen/artifacts/s_long/request-1.md");
    expect(shown).toContain(`${spec.length.toLocaleString("en-US")} characters`);
  });

  /*
   * 6 Nov 2026: named every step while the message was still in view, the
   * file read as an instruction, and DeepSeek read the 21,700-character spec
   * back from it a few steps into the turn the spec arrived in.
   */
  it("does not point at the saved copy while the request itself is still in the conversation", () => {
    const store = new TaskStateStore(emptyTaskState("s_long"));
    store.addRequest(spec);
    store.attachRequestFile(".soreqen/artifacts/s_long/request-1.md", spec.length);
    const inView: LLMMessage[] = [{ role: "user", content: spec }];
    expect(requestInView(store.state, inView)).toBe(true);
    const shown = renderTaskState(store.state, 4_000, { requestInView: true }).text;
    expect(shown).not.toContain("request-1.md");
    expect(shown).toContain("the user's message above");
    // Checkpointed away: the copy is the request now.
    const gone: LLMMessage[] = [{ role: "user", content: "[checkpoint] earlier work" }];
    expect(requestInView(store.state, gone)).toBe(false);
    expect(renderTaskState(store.state, 4_000, { requestInView: false }).text).toContain("request-1.md");
  });
});
