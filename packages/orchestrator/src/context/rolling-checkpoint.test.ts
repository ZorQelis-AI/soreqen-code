/**
 * Rolling checkpoints, and the audit of 25 Sep 2026.
 *
 * The property that matters most is the strict delta: every message is read
 * into task state exactly once. Each test that exercises it records the
 * transcripts the extractor was actually sent and checks what was — and was
 * not — in them.
 */

import { describe, expect, it } from "vitest";
import type { LLMChatOptions, LLMMessage, LLMProvider, LLMResponseChunk } from "../types.js";
import { isFailure } from "../context-hygiene.js";
import { estimateHistoryTokens } from "../context-manager.js";
import { budgetFor } from "./budget.js";
import { keepSent } from "./engine.js";
import {
  CHECKPOINT_MARK,
  checkpointHistory,
  extractAhead,
  markAt,
  readDue,
  segmentsOf,
  unreadFrom,
} from "./state-checkpoint.js";
import { TaskStateStore, emptyTaskState, evictionOrder, renderTaskState, type StateEntry } from "./task-state.js";
import { gateHistory } from "./tool-gateway.js";
import { WorkspaceKnowledge, UNPINNED_TTL_MS, isCurrent } from "./workspace-knowledge.js";

/** A provider that answers with a decision naming the first "msg-N" it was shown, and records every transcript. */
function recorder(): { provider: LLMProvider; seen: string[] } {
  const seen: string[] = [];
  const provider: LLMProvider = {
    name: "recorder",
    async *chatStream(options: LLMChatOptions): AsyncIterable<LLMResponseChunk> {
      const text = String(options.messages[0]?.content ?? "");
      const transcript = text.slice(text.indexOf("<transcript>"));
      seen.push(transcript);
      const first = /msg-(\d+)/.exec(transcript)?.[1] ?? "none";
      yield { type: "token", text: JSON.stringify({ decisions: [{ text: `read from msg-${first} (${seen.length})` }] }) };
      yield { type: "stop", reason: "end_turn" };
    },
  };
  return { provider, seen };
}

/** A history of `n` exchanges, each about `chars` long, every one labelled msg-i. */
function conversation(n: number, chars = 2_000, start = 0): LLMMessage[] {
  const out: LLMMessage[] = [];
  for (let i = start; i < start + n; i++) {
    out.push({ role: "assistant", content: `msg-${i}`, toolCalls: [{ id: `c${i}`, name: "run_command", input: { command: `echo ${i}` } }] });
    out.push({ role: "tool", toolCallId: `c${i}`, content: `msg-${i} ${"x".repeat(chars)}` });
  }
  return out;
}

const labelsIn = (transcript: string): number[] => [...transcript.matchAll(/msg-(\d+)/g)].map((m) => Number(m[1]));

describe("rolling checkpoints: strict delta", () => {
  it("reads only what accumulated since the last read — never an earlier message again", async () => {
    const store = new TaskStateStore(emptyTaskState("s"));
    const { provider, seen } = recorder();
    const history: LLMMessage[] = [{ role: "user", content: "the task" }, ...conversation(10)];

    const first = await extractAhead({ history, store, provider, minTokens: 1_000 });
    expect(first?.ok).toBe(true);
    expect(labelsIn(seen.join("\n"))).toContain(0);

    history.push(...conversation(10, 2_000, 10));
    seen.length = 0;
    await extractAhead({ history, store, provider, minTokens: 1_000 });
    const second = labelsIn(seen.join("\n"));
    expect(Math.min(...second)).toBe(10);
    expect(second.every((n) => n >= 10)).toBe(true);
  });

  it("waits until enough has accumulated", async () => {
    const store = new TaskStateStore(emptyTaskState("s"));
    const { provider, seen } = recorder();
    const history = conversation(2);
    expect(await extractAhead({ history, store, provider, minTokens: 50_000 })).toBeNull();
    expect(seen).toHaveLength(0);
  });

  it("cuts without a request when everything it drops was already read", async () => {
    const store = new TaskStateStore(emptyTaskState("s"));
    const { provider, seen } = recorder();
    const history: LLMMessage[] = [{ role: "user", content: "the task" }, ...conversation(30)];
    await extractAhead({ history, store, provider, minTokens: 1_000 });
    seen.length = 0;

    const cut = await checkpointHistory({ history, store, provider, keepRecentTokens: 3_000 });
    expect(cut).not.toBeNull();
    expect(seen).toHaveLength(0);
    expect(String(cut!.history[0]!.content)).toContain(CHECKPOINT_MARK);
    expect(store.state.checkpoints.map((c) => c.kind)).toEqual(["extract", "cut"]);
  });

  it("reads only the unread part up to the cut, and not the tail it keeps", async () => {
    const store = new TaskStateStore(emptyTaskState("s"));
    const { provider, seen } = recorder();
    const history: LLMMessage[] = [{ role: "user", content: "the task" }, ...conversation(10)];
    await extractAhead({ history, store, provider, minTokens: 1_000 });
    history.push(...conversation(20, 2_000, 10));
    seen.length = 0;

    const cut = await checkpointHistory({ history, store, provider, keepRecentTokens: 3_000 });
    expect(cut).not.toBeNull();
    const read = labelsIn(seen.join("\n"));
    const kept = labelsIn(cut!.history.map((m) => String(m.content)).join("\n"));
    expect(Math.min(...read)).toBe(10);
    // Nothing in the kept tail was read: it will be, once, later.
    for (const n of kept) expect(read).not.toContain(n);
  });

  it("finds its place again after a cut, so the kept tail is read once and only once", async () => {
    const store = new TaskStateStore(emptyTaskState("s"));
    const { provider, seen } = recorder();
    let history: LLMMessage[] = [{ role: "user", content: "the task" }, ...conversation(30)];
    // Everything read, including what the cut will keep.
    await extractAhead({ history, store, provider, minTokens: 1_000 });
    const cut = await checkpointHistory({ history, store, provider, keepRecentTokens: 3_000 });
    history = cut!.history;
    expect(unreadFrom(history, store.state.extractedThrough)).toBe(history.length);

    history.push(...conversation(10, 2_000, 30));
    seen.length = 0;
    await extractAhead({ history, store, provider, minTokens: 1_000 });
    expect(Math.min(...labelsIn(seen.join("\n")))).toBe(30);
  });

  it("finds the mark by message id when messages have one", () => {
    const history: LLMMessage[] = conversation(4).map((m, i) => ({ ...m, id: `m${i}` }));
    expect(unreadFrom(history, { id: "m3", fingerprint: "nope", step: 0 })).toBe(4);
    // No mark yet: everything after the last checkpoint marker is unread.
    const marked: LLMMessage[] = [{ role: "user", content: `${CHECKPOINT_MARK} earlier` }, ...history];
    expect(unreadFrom(marked, undefined)).toBe(1);
  });

  it("splits a long stretch into several reads, between exchanges, and clips none of it", async () => {
    const store = new TaskStateStore(emptyTaskState("s"));
    const { provider, seen } = recorder();
    const history = conversation(40, 1_000);
    const segments = segmentsOf(history, 0, history.length, 10_000);
    expect(segments.length).toBeGreaterThan(3);
    // Contiguous, complete, and never between a call and its result.
    expect(segments[0]![0]).toBe(0);
    expect(segments[segments.length - 1]![1]).toBe(history.length);
    for (let i = 1; i < segments.length; i++) expect(segments[i]![0]).toBe(segments[i - 1]![1]);
    for (const [a] of segments) expect(history[a]!.role).toBe("assistant");

    await extractAhead({ history, store, provider, minTokens: 1_000, segmentChars: 10_000 });
    expect(seen.length).toBe(segments.length);
    expect(seen.join("\n")).not.toContain("characters omitted");
    expect(new Set(labelsIn(seen.join("\n"))).size).toBe(40);
  });

  it("checkpoints at 80k, 160k, 240k … and, after compacting to under 64k, at 80k again", () => {
    // One exchange of about 2k tokens at a time; `sizes` is the history itself here.
    const history: LLMMessage[] = [{ role: "user", content: "the task" }];
    let mark: ReturnType<typeof markAt> | undefined;
    let exchange = 0;
    const readsAt: number[] = [];
    const grow = (until: number): void => {
      while (estimateHistoryTokens(history) < until) {
        history.push(...conversation(1, 7_000, exchange++));
        if (readDue({ history, sizes: history, mark, every: 80_000 })) {
          readsAt.push(Math.round(estimateHistoryTokens(history) / 1_000));
          mark = markAt(history, history.length - 1, 0);
        }
      }
    };

    grow(250_000);
    expect(readsAt).toEqual([80, 160, 240].map((k) => expect.closeTo(k, -1)));

    // The cut: back to a marker and the newest ~60k, everything in it already read.
    let keep = history.length;
    while (estimateHistoryTokens(history.slice(keep - 1)) < 60_000) keep--;
    history.splice(0, keep, { role: "user", content: `${CHECKPOINT_MARK} earlier` });
    mark = markAt(history, history.length - 1, 0);
    expect(estimateHistoryTokens(history)).toBeLessThan(64_000);

    readsAt.length = 0;
    grow(170_000);
    // The cycle repeats from the start: 80k, then 160k.
    expect(readsAt).toEqual([80, 160].map((k) => expect.closeTo(k, -1)));
  });

  it("reads just short of the cut too, so the cut itself needs no request", () => {
    const history: LLMMessage[] = [{ role: "user", content: "the task" }, ...conversation(60, 7_000)];
    const total = estimateHistoryTokens(history);
    const mark = markAt(history, 20, 0);
    // Not at a new 80k mark, but past 85% of a cut point just above it.
    expect(readDue({ history, sizes: history, mark: markAt(history, history.length - 1, 0), every: 80_000, nearCutAt: total * 0.9 })).toBe(false);
    expect(readDue({ history, sizes: history, mark, every: 1_000_000, nearCutAt: total * 0.9 })).toBe(true);
    expect(readDue({ history, sizes: history, mark, every: 1_000_000, nearCutAt: total * 1.1 })).toBe(false);
  });

  it("reads at its tier's pace (180k on a 1M window, cut at 480k), and at least twice between cuts on a small one", () => {
    const big = budgetFor({ window: 1_000_000, systemTokens: 5_000, toolTokens: 5_000, overrides: {} });
    expect(big.extractEvery).toBe(180_000);
    const small = budgetFor({ window: 128_000, systemTokens: 5_000, toolTokens: 5_000, overrides: {} });
    expect(small.extractEvery).toBeLessThanOrEqual(Math.floor(small.checkpointAt / 2));
  });
});

describe("task state audit", () => {
  const entry = (id: string, status: StateEntry["status"], updatedStep: number): StateEntry => ({
    id,
    kind: "fact",
    text: id,
    status,
    source: { type: "tool", ref: "x" },
    createdStep: updatedStep,
    updatedStep,
  });

  it("SEC-1: drops finished work first and confirmed facts last", () => {
    const order = evictionOrder([
      entry("confirmed-old", "confirmed", 1),
      entry("active-old", "active", 1),
      entry("done-new", "done", 9),
      entry("stale", "stale", 5),
      entry("refuted", "refuted", 5),
    ]).map((e) => e.id);
    expect(order).toEqual(["done-new", "stale", "refuted", "active-old", "confirmed-old"]);
  });

  it("keeps the person's own requirements past everything the agent inferred", () => {
    const store = new TaskStateStore(emptyTaskState("s"));
    const theirs = store.add({ kind: "constraint", text: "do not touch the public API", source: { type: "user", ref: "request" } });
    for (let i = 0; i < 80; i++) store.add({ kind: "constraint", text: `inferred rule ${i}`, source: { type: "tool", ref: "t" } });
    const constraints = store.state.entries.filter((e) => e.kind === "constraint");
    expect(constraints.length).toBeLessThanOrEqual(60);
    expect(constraints.some((e) => e.id === theirs.id)).toBe(true);
  });

  it("SEC-1: a full kind keeps its confirmed facts", () => {
    const store = new TaskStateStore(emptyTaskState("s"));
    const confirmed = store.add({ kind: "fact", text: "confirmed first", source: { type: "tool", ref: "t" }, status: "confirmed" });
    for (let i = 0; i < 45; i++) store.add({ kind: "fact", text: `fact ${i}`, source: { type: "tool", ref: "t" } });
    const facts = store.state.entries.filter((e) => e.kind === "fact");
    expect(facts).toHaveLength(40);
    expect(facts.some((e) => e.id === confirmed.id)).toBe(true);
  });

  it("SEC-2: constraints are capped, and cannot take the whole budget", () => {
    const store = new TaskStateStore(emptyTaskState("s"));
    for (let i = 0; i < 90; i++) {
      store.add({ kind: "constraint", text: `You must always keep rule number ${i} in mind when editing`, source: { type: "user", ref: "request" } });
    }
    store.add({ kind: "next_action", text: "run the tests", source: { type: "model", ref: "agent" } });
    expect(store.state.entries.filter((e) => e.kind === "constraint")).toHaveLength(60);
    const { text } = renderTaskState(store.state, 800);
    expect(text).toContain("run the tests");
    expect(text).toContain("rule number 89");
  });

  it("SEC-3: every kind is seen before any one kind fills the budget", () => {
    const store = new TaskStateStore(emptyTaskState("s"));
    for (let i = 0; i < 40; i++) store.add({ kind: "fact", text: `a long established fact about module ${i} and its behaviour`, source: { type: "tool", ref: "t" } });
    store.add({ kind: "next_action", text: "ship the fix", source: { type: "model", ref: "agent" } });
    store.add({ kind: "unknown", text: "which port does staging use", source: { type: "model", ref: "agent" } });
    const { text, omitted } = renderTaskState(store.state, 600);
    expect(text).toContain("ship the fix");
    expect(text).toContain("which port does staging use");
    expect(omitted).toBeGreaterThan(0);
    expect(text).toMatch(/Older entries not shown[^\n]*facts/);
  });
});

describe("history audit", () => {
  it("SEC-5: a JSON file read is still marked stale after the file changes", () => {
    const history: LLMMessage[] = [
      { role: "assistant", content: "", toolCalls: [{ id: "r", name: "read_file", input: { path: "data.json" } }] },
      { role: "tool", toolCallId: "r", content: '[{"id": 1}]' },
      { role: "assistant", content: "", toolCalls: [{ id: "w", name: "write_file", input: { path: "data.json", content: "[]" } }] },
      { role: "tool", toolCallId: "w", content: '{"written":true}' },
    ];
    const { messages, stats } = gateHistory(history, "s");
    expect(stats.staleReads).toBe(1);
    expect(String(messages[1]!.content)).toMatch(/^\[STALE: data\.json/);
  });

  it("SEC-10: warned failures and refused calls replace nothing", () => {
    expect(isFailure("WARNING: slow\n\nFAILED: timed out")).toBe(true);
    expect(isFailure("Action denied by policy: Violates hard denylist.")).toBe(true);
    expect(isFailure("Action was explicitly rejected by user confirmation.")).toBe(true);
    expect(isFailure("'run_command' needs confirmation, and this session has no way to ask for one.")).toBe(true);
    expect(isFailure('{ "success": false }')).toBe(true);
    expect(isFailure('{"exitCode":1,"stdout":"FAILED: 3 tests"}')).toBe(false);
  });

  it("SEC-6: keeps what was sent while it is the same history, and starts over when it is rewritten", () => {
    const raw: LLMMessage[] = [{ role: "user", content: "a" }, { role: "tool", toolCallId: "t", content: "old" }];
    const sent = { raw, view: raw };
    const same = keepSent(sent, [...raw, { role: "user", content: "b" }], [{ role: "user", content: "a" }, { role: "tool", toolCallId: "t", content: "[Superseded]" }, { role: "user", content: "b" }]);
    expect(same.kept).toBe(2);
    expect(same.view[1]!.content).toBe("old");
    const rewritten = keepSent(sent, [{ role: "user", content: "other" }, raw[1]!], [{ role: "user", content: "other" }, raw[1]!]);
    expect(rewritten.kept).toBe(0);
  });
});

describe("workspace knowledge audit", () => {
  it("SEC-8: a fact that cites no file lapses unless it is found again", () => {
    const now = Date.now();
    const unpinned = { text: "db on 5433", source: "run_command", files: {}, sessionId: "a", at: now - UNPINNED_TTL_MS - 1 };
    const fresh = { ...unpinned, at: now };
    const pinned = { text: "api in src/server", source: "src/server/index.ts", files: { "src/server/index.ts": "h1" }, sessionId: "a", at: 0 };
    expect(isCurrent(unpinned, () => undefined, now)).toBe(false);
    expect(isCurrent(fresh, () => undefined, now)).toBe(true);
    expect(isCurrent(pinned, () => "h1", now)).toBe(true);
    expect(isCurrent(pinned, () => "h2", now)).toBe(false);

    const k = WorkspaceKnowledge.empty();
    k.entries.push(unpinned, pinned);
    expect(k.current("b", () => "h1", [], now).map((e) => e.text)).toEqual(["api in src/server"]);
  });
});

/*
 * 28 Sep 2026: a real session read messages 1-252 twice (298,870 tokens, 119
 * duplicate entries), and sessions read their first 80k at 176k-204k. Causes:
 * marks on messages with no stored id, whose fingerprint the next turn's
 * reloaded history did not match; and failed reads that left no trace and were
 * retried on every step.
 */
describe("rolling checkpoints: marks that survive the next turn (28 Sep 2026)", () => {
  it("marks the last stored message, so a reload that changes the unstored one re-reads only it", async () => {
    const store = new TaskStateStore(emptyTaskState("s"));
    const { provider, seen } = recorder();
    // Stored messages have ids; the turn's opening message, in memory, does not — and carries its picture inline.
    const history: LLMMessage[] = conversation(10).map((m, i) => ({ ...m, id: `m${i}` }));
    history.push({ role: "user", content: [{ type: "text", text: "msg-99 next request" }, { type: "image", image_data: "AAAA", media_type: "image/png" }] });
    await extractAhead({ history, store, provider, minTokens: 1_000 });
    expect(store.state.extractedThrough?.id).toBe("m19");

    // The next turn: the same conversation loaded back from storage, the opening message as its stored text.
    const reloaded: LLMMessage[] = [...history.slice(0, -1), { role: "user", content: "msg-99 next request [image]", id: "m20" }, ...conversation(3, 2_000, 100)];
    seen.length = 0;
    await extractAhead({ history: reloaded, store, provider, minTokens: 1 });
    const read = labelsIn(seen.join("\n"));
    expect(read).toContain(99); // the one message after the mark
    expect(read.some((n) => n < 10)).toBe(false); // and nothing before it again
  });

  it("keeps a failed read in the record, and gives up on a request that goes silent", async () => {
    const store = new TaskStateStore(emptyTaskState("s"));
    const silent: LLMProvider = {
      name: "silent",
      async *chatStream(options: LLMChatOptions): AsyncIterable<LLMResponseChunk> {
        await new Promise<void>((resolve) => options.signal?.addEventListener("abort", () => resolve(), { once: true }));
        yield* [];
      },
    };
    const history = conversation(5);
    const result = await extractAhead({ history, store, provider: silent, minTokens: 1, idleMs: 50 });
    expect(result?.ok).toBe(false);
    const failed = store.state.checkpoints.find((c) => c.kind === "extract_failed");
    expect(failed?.reason).toMatch(/no reply for/);
    expect(store.state.extractedThrough).toBeUndefined();
  });
});
