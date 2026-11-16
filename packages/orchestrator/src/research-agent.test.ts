import { describe, expect, it } from "vitest";
import type { Evidence, GatherOptions } from "@sqcode/tools";
import { deepResearch } from "./research-agent.js";
import type { LLMProvider } from "./types.js";

/** A model that answers each step from a script, by what its system prompt asks for. */
function scripted(answers: { plan?: string; gaps?: string[]; report?: string; verify?: string }): LLMProvider & { prompts: string[] } {
  const prompts: string[] = [];
  let gap = 0;
  return {
    name: "scripted",
    prompts,
    chatStream: async function* (options: { system?: string; messages: { content: unknown }[] }) {
      prompts.push(String(options.messages[0]?.content));
      const system = options.system ?? "";
      const text = system.startsWith("You plan")
        ? answers.plan ?? ""
        : system.startsWith("You review")
          ? answers.gaps?.[gap++] ?? '{"covered": true}'
          : system.startsWith("You check")
            ? answers.verify ?? "OK"
            : answers.report ?? "";
      yield { type: "token", text } as never;
    },
  } as unknown as LLMProvider & { prompts: string[] };
}

function fakeGather(log: GatherOptions[]) {
  return async (o: GatherOptions): Promise<Evidence> => {
    log.push(o);
    const first = o.firstNumber ?? 1;
    const round = log.length;
    return {
      question: o.question,
      queries: o.queries ?? [],
      providers: ["test"],
      unread: [],
      failedQueries: [],
      sources: [0, 1].map((i) => ({
        n: first + i,
        title: `Round ${round} source ${i}`,
        url: `https://r${round}.example.com/${i}`,
        site: `r${round}.example.com`,
        passages: [`Round ${round} finding ${i}: specific numbers and versions.`],
        via: "fetch" as const,
      })),
    };
  };
}

describe("deepResearch", () => {
  it("plans, follows up on the gaps it finds, skips what it read, and reports with citations", async () => {
    const log: GatherOptions[] = [];
    const provider = scripted({
      plan: '{"sub_questions": ["What is it?", "How fast?"], "queries": ["q one", "q two", "q three"]}',
      gaps: ['{"covered": false, "gaps": ["speed"], "queries": ["benchmark of it"]}', '{"covered": true}'],
      report: "Direct answer [1][3]. ".repeat(20) + "\n\nSources\n[1] Round 1 source 0 https://r1.example.com/0",
    });
    const out = await deepResearch({ question: "What is X and how fast is it?", provider, gather: fakeGather(log), today: "2026-10-04" });

    expect(out.success).toBe(true);
    expect(log).toHaveLength(2);
    expect(log[0]!.queries).toEqual(expect.arrayContaining(["q one", "q two", "q three"]));
    expect(log[1]!.queries).toEqual(["benchmark of it"]);
    // Round two continues the numbering and leaves round one's pages alone.
    expect(log[1]!.firstNumber).toBe(3);
    expect([...(log[1]!.exclude as Set<string>)]).toContain("https://r1.example.com/0");
    // Text, not JSON: what the agent reads is the report itself.
    const text = out.data as string;
    expect(typeof text).toBe("string");
    expect(text).toContain("[1][3]");
    expect(text).toMatch(/^Deep research: 2 rounds/);
    // The report was written from every round's passages.
    expect(provider.prompts.at(-1)).toContain("Round 2 finding 1");
  });

  it("still answers when the model cannot plan or report: the evidence itself", async () => {
    const log: GatherOptions[] = [];
    const out = await deepResearch({ question: "Anything at all here?", provider: scripted({ plan: "no json", report: "" }), gather: fakeGather(log) });
    expect(out.success).toBe(true);
    expect(out.data as string).toContain("[1] Round 1 source 0");
    expect(log[0]!.queries!.length).toBeGreaterThan(0);
  });

  it("at max, checks every claim against its source and hands over the corrected report", async () => {
    const report = "## Answer\nIt runs at 40 ms [2]. ".repeat(12);
    const corrected = "## Answer\nIt runs at 45 ms [1]. ".repeat(12);
    const provider = scripted({ plan: '{"queries": ["q"]}', report, verify: corrected });
    const out = await deepResearch({ question: "How fast is it?", provider, gather: fakeGather([]), intensity: "max" });
    expect(out.data as string).toContain("45 ms [1]");
    expect(out.data as string).toMatch(/every claim checked/);
  });

  it("does not wait for ever on a model that goes silent: the report step is given up and the evidence handed over (29 Oct 2026)", async () => {
    let closed = false;
    const provider = {
      name: "silent-report",
      chatStream: async function* (options: { system?: string; signal?: AbortSignal }) {
        if (!(options.system ?? "").startsWith("You are a senior research analyst")) {
          yield { type: "token", text: (options.system ?? "").startsWith("You plan") ? '{"queries": ["q"]}' : '{"covered": true}' } as never;
          return;
        }
        // The report: one word, then silence, as a connection a proxy dropped without closing.
        yield { type: "token", text: "## Answer" } as never;
        await new Promise<void>((resolve) => options.signal?.addEventListener("abort", () => resolve(), { once: true }));
        closed = true;
      },
    } as unknown as LLMProvider;
    const started = Date.now();
    const out = await deepResearch({ question: "What is X?", provider, gather: fakeGather([]), idleMs: 60 });
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(out.success).toBe(true);
    expect(out.data as string).toContain("[1] Round 1 source 0");
    // The stalled request was closed, not left open.
    expect(closed).toBe(true);
  });

  it("stops starting rounds when its time is up, and writes the report from what it has", async () => {
    const log: GatherOptions[] = [];
    const provider = scripted({
      plan: '{"queries": ["q"]}',
      gaps: ['{"covered": false, "queries": ["more"]}', '{"covered": false, "queries": ["even more"]}'],
      report: "## Answer\nFrom round one [1]. ".repeat(12),
    });
    // Already out of time once the first round is in (a fake round takes no measurable time at all).
    const out = await deepResearch({ question: "What is X?", provider, gather: fakeGather(log), budgetMs: -1 });
    expect(log).toHaveLength(1);
    expect(out.data as string).toContain("From round one [1]");
  });

  it("keeps the report when the check finds nothing wrong", async () => {
    const report = "## Answer\nIt runs at 40 ms [2]. ".repeat(12);
    const out = await deepResearch({ question: "How fast is it?", provider: scripted({ plan: '{"queries": ["q"]}', report, verify: "OK" }), gather: fakeGather([]), intensity: "max" });
    expect(out.data as string).toContain("40 ms [2]");
  });
});
