/**
 * Overload moves a request to another route — only before its answer starts,
 * only for load, and always announced.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { BENCH_MS, FailoverProvider, isOverload, resetFailoverBench } from "./model-failover.js";
import type { LLMChatOptions, LLMProvider, LLMResponseChunk } from "./types.js";

const busy = Object.assign(new Error("429 Too Many Requests"), { status: 429 });
const bad = Object.assign(new Error("400 invalid_request"), { status: 400 });

/** A provider scripted per call: an error to throw, or chunks to stream. */
function scripted(label: string, script: Array<Error | "ok" | "fail-mid">, seen: string[]): LLMProvider {
  let call = 0;
  return {
    name: label,
    async *chatStream(options: LLMChatOptions): AsyncIterable<LLMResponseChunk> {
      const step = script[call++] ?? "ok";
      seen.push(`${label}:${options.model}`);
      if (step instanceof Error) throw step;
      yield { type: "token", text: `from ${label}` };
      if (step === "fail-mid") throw busy;
      yield { type: "stop", reason: "end_turn" };
    },
  };
}

async function collect(p: LLMProvider): Promise<LLMResponseChunk[]> {
  const out: LLMResponseChunk[] = [];
  for await (const c of p.chatStream({ messages: [], model: "mimo-v2.6-flash" } as LLMChatOptions)) out.push(c);
  return out;
}

describe("FailoverProvider", () => {
  beforeEach(() => resetFailoverBench());

  it("moves an overloaded request to the next route and says so", async () => {
    const seen: string[] = [];
    const p = new FailoverProvider(
      { provider: scripted("go", [busy], seen), model: "mimo-v2.6-flash", label: "MiMo (Go)" },
      [{ provider: scripted("zen", ["ok"], seen), model: "mimo-v2.6-flash-free", label: "MiMo (Zen)" }],
    );
    const out = await collect(p);
    expect(out[0]).toMatchObject({ type: "model_fallback", from: "MiMo (Go)", to: "MiMo (Zen)" });
    expect(out[1]).toEqual({ type: "token", text: "from zen" });
    // The fallback is sent its own model name, not the primary's.
    expect(seen).toEqual(["go:mimo-v2.6-flash", "zen:mimo-v2.6-flash-free"]);
  });

  it("benches the overloaded route across instances, and announces the switch only once", async () => {
    const seen: string[] = [];
    const routes = () =>
      [
        { provider: scripted("go", [busy, "ok"], seen), model: "a", label: "Go" },
        [{ provider: scripted("zen", ["ok", "ok"], seen), model: "b", label: "Zen" }],
      ] as const;
    let t = 1_000;
    const [primary, fallbacks] = routes();
    const p = new FailoverProvider(primary, [...fallbacks], () => t);
    await collect(p);
    const second = await collect(p);
    // Still benched: straight to the fallback, and no second announcement.
    expect(second.some((c) => c.type === "model_fallback")).toBe(false);
    expect(seen.slice(-1)).toEqual(["zen:b"]);

    // After the bench, the primary is tried first again — and that is announced.
    t += BENCH_MS + 1;
    const third = await collect(p);
    expect(third[0]).toMatchObject({ type: "model_fallback", from: "Zen", to: "Go", reason: "available again" });
  });

  it("never switches mid-answer, and never on a request that is simply wrong", async () => {
    const seen: string[] = [];
    const mid = new FailoverProvider(
      { provider: scripted("go", ["fail-mid"], seen), model: "a", label: "Go" },
      [{ provider: scripted("zen", ["ok"], seen), model: "b", label: "Zen" }],
    );
    await expect(collect(mid)).rejects.toThrow("429");
    expect(seen).toEqual(["go:mimo-v2.6-flash"]);

    const wrong = new FailoverProvider(
      { provider: scripted("go2", [bad], seen), model: "a", label: "Go2" },
      [{ provider: scripted("zen2", ["ok"], seen), model: "b", label: "Zen2" }],
    );
    await expect(collect(wrong)).rejects.toThrow("400");
  });

  it("recognises overload by status or by message", () => {
    expect(isOverload({ status: 503 })).toBe(true);
    expect(isOverload(new Error("The model is overloaded, try later"))).toBe(true);
    expect(isOverload(bad)).toBe(false);
  });
});
