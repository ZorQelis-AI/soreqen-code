import { describe, it, expect } from "vitest";
import type { SubagentInfo } from "@sqcode/shared";
import {
  SubagentPool,
  buildBrief,
  briefSessionFrom,
  resolveRole,
  subagentConcurrencyFor,
  DEFAULT_SUBAGENT_CONCURRENCY,
} from "./subagent-pool.js";
import { emptyTaskState } from "./context/task-state.js";

const settled = (): { promise: Promise<void>; resolve: () => void } => {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
};

describe("SubagentPool", () => {
  it("returns an id immediately, before the sub-agent has done anything", async () => {
    const gate = settled();
    const pool = new SubagentPool();

    const started = pool.spawn({
      role: "explorer",
      task: "map the auth module",
      run: async () => {
        await gate.promise;
        return { finalResponse: "done", filesModified: [] };
      },
    });

    expect(started.ok).toBe(true);
    if (!started.ok) return;
    expect(started.agent.status).toBe("running");
    expect(pool.anyRunning()).toBe(true);
    // Nothing has finished, so there is nothing to report to the parent yet.
    expect(pool.collect()).toEqual([]);

    gate.resolve();
    await pool.waitForAll();
    expect(pool.anyRunning()).toBe(false);
  });

  it("delivers each result exactly once", async () => {
    const pool = new SubagentPool();
    pool.spawn({
      role: "tester",
      task: "run the suite",
      run: async () => ({ finalResponse: "17 passed", filesModified: [] }),
    });
    await pool.waitForAll();

    const first = pool.collect();
    expect(first).toHaveLength(1);
    expect(first[0]?.result).toBe("17 passed");
    /*
     * The second read is empty on purpose: a parent that receives the same
     * specialist's answer twice believes two of them agreed with each other.
     */
    expect(pool.collect()).toEqual([]);
    // It stays in the roster for the panel, though.
    expect(pool.list()).toHaveLength(1);
  });

  it("records a thrown sub-agent as a failure instead of rejecting", async () => {
    const pool = new SubagentPool();
    pool.spawn({
      role: "debugger",
      task: "find it",
      run: async () => {
        throw new Error("provider went away");
      },
    });

    // Must not reject: an unattached rejection here takes the process down.
    await expect(pool.waitForAll()).resolves.toBeUndefined();
    const [agent] = pool.collect();
    expect(agent?.status).toBe("failed");
    expect(agent?.error).toContain("provider went away");
  });

  it("refuses to start past its capacity, and says so", async () => {
    const gate = settled();
    const pool = new SubagentPool(undefined, 2);
    const hold = async (): Promise<{ finalResponse: string; filesModified: string[] }> => {
      await gate.promise;
      return { finalResponse: "", filesModified: [] };
    };

    expect(pool.spawn({ role: "a", task: "t", run: hold }).ok).toBe(true);
    expect(pool.spawn({ role: "b", task: "t", run: hold }).ok).toBe(true);
    const third = pool.spawn({ role: "c", task: "t", run: hold });
    expect(third.ok).toBe(false);
    if (!third.ok) expect(third.reason).toContain("2 sub-agents are already running");

    gate.resolve();
    await pool.waitForAll();
    // Capacity is freed once they finish.
    expect(pool.spawn({ role: "d", task: "t", run: hold }).ok).toBe(true);
    gate.resolve();
    await pool.waitForAll();
  });

  it("publishes every state change so a panel can follow along", async () => {
    const seen: SubagentInfo[] = [];
    const pool = new SubagentPool((agent) => seen.push(agent));

    pool.spawn({
      role: "researcher",
      task: "look it up",
      run: async (report) => {
        report.activity("web_search");
        report.step();
        return { finalResponse: "found it", filesModified: [] };
      },
    });
    await pool.waitForAll();

    expect(seen[0]?.status).toBe("running");
    expect(seen.some((a) => a.activity === "web_search")).toBe(true);
    expect(seen.at(-1)?.status).toBe("completed");
    // A finished agent is not still "doing" something.
    expect(seen.at(-1)?.activity).toBeUndefined();
  });

  it("gives Apex more room to delegate than Max", () => {
    expect(subagentConcurrencyFor("max")).toBe(3);
    expect(subagentConcurrencyFor("apex")).toBe(6);
    expect(subagentConcurrencyFor("high")).toBe(DEFAULT_SUBAGENT_CONCURRENCY);
    expect(subagentConcurrencyFor(undefined)).toBe(DEFAULT_SUBAGENT_CONCURRENCY);
  });
});

describe("roles", () => {
  it("accepts the names a model actually writes", () => {
    expect(resolveRole("tester")).toBe("tester");
    expect(resolveRole("testing")).toBe("tester");
    expect(resolveRole("code_architect")).toBe("architect");
    expect(resolveRole("Code Review")).toBe("code_reviewer");
    expect(resolveRole("security analysis")).toBe("security_auditor");
  });

  it("falls back to the specialist that only reads", () => {
    // An unknown role must not become one that writes to the workspace.
    expect(resolveRole("wat")).toBe("explorer");
    expect(resolveRole("")).toBe("explorer");
  });

  it("writes a brief that stands on its own", () => {
    const brief = buildBrief("code_reviewer", "Review the diff in src/auth.ts", ["src/auth.ts"]);
    expect(brief).toContain("[SUB-AGENT ROLE: code_reviewer]");
    // The role's standing instruction, the scope warning, and the files.
    expect(brief).toContain("find what is wrong with them");
    expect(brief).toContain("work it will do twice");
    expect(brief).toContain("- src/auth.ts");
    // A reviewer reads: it is told not to write, and to report findings.
    expect(brief).toContain("Do not create, edit or delete any file");
    expect(brief).toContain("**Findings**");
    // Empty sections are left out, not printed as headings with nothing under them.
    expect(brief).not.toContain("## Done when");
    expect(brief).not.toContain("## Decisions already made");
  });

  it("hands the person's requirements and the session's history down with the task", () => {
    const state = emptyTaskState("s");
    state.goal = "Add rate limiting to the API";
    state.requests = [{ text: "Add rate limiting to the API", step: 0 }];
    state.entries = [
      { id: "e1", kind: "constraint", text: "Do not change the public API", status: "active", source: { type: "user", ref: "request" }, createdStep: 0, updatedStep: 0 },
      { id: "e2", kind: "failure", text: "express-rate-limit: incompatible with Fastify", status: "active", source: { type: "tool", ref: "x" }, createdStep: 1, updatedStep: 1 },
      { id: "e3", kind: "failure", text: "an old failure, since fixed", status: "resolved", source: { type: "tool", ref: "x" }, createdStep: 1, updatedStep: 1 },
    ];
    state.files = { "src/server.ts": { path: "src/server.ts", lastAction: "edit", step: 2 } };
    const brief = buildBrief("implementer", "Add a token bucket to src/server.ts", [], {
      doneWhen: "pnpm test passes",
      known: "The server is Fastify 5",
      session: briefSessionFrom(state),
    });
    expect(brief).toContain("## Done when\npnpm test passes");
    expect(brief).toContain("## Already known");
    expect(brief).toContain("Session goal: Add rate limiting to the API");
    expect(brief).toContain("- Do not change the public API");
    expect(brief).toContain("- express-rate-limit: incompatible with Fastify");
    expect(brief).not.toContain("since fixed");
    expect(brief).toContain("- src/server.ts");
    // An implementer changes files, and reports them.
    expect(brief).toContain("**Changes**");
    expect(brief).not.toContain("Do not create, edit or delete any file");
  });
});
