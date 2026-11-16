/**
 * Which of a question's options the agent recommends (asked for 13 Oct 2026:
 * "reason about it and mark one of the options as recommended").
 */

import { describe, expect, it } from "vitest";
import { recommendedOption } from "./dispatcher.js";

const options = ["Wipe the project and start over", "Keep the database, rebuild the UI", "Leave it as it is"];

describe("the recommended option of a question", () => {
  it("is found by its text, near enough, or by its number as shown", () => {
    expect(recommendedOption(options, "Keep the database, rebuild the UI").recommended).toBe(1);
    expect(recommendedOption(options, "keep the database, rebuild the ui.").recommended).toBe(1);
    expect(recommendedOption(options, "Wipe the project").recommended).toBe(0);
    expect(recommendedOption(options, 3).recommended).toBe(2);
    expect(recommendedOption(options, "3").recommended).toBe(2);
  });

  it("is taken from a '(Recommended)' mark in the option itself, which the person does not see", () => {
    const marked = recommendedOption(["Use Postgres (Recommended)", "Use SQLite"], undefined);
    expect(marked).toEqual({ options: ["Use Postgres", "Use SQLite"], recommended: 0 });
  });

  it("is none when nothing names an option", () => {
    expect(recommendedOption(options, "Something else entirely").recommended).toBeUndefined();
    expect(recommendedOption(options, 9).recommended).toBeUndefined();
    expect(recommendedOption(undefined, "x")).toEqual({ options: undefined });
  });
});

describe("several questions asked together (15 Oct 2026)", () => {
  it("puts them one after another, numbered, and returns every answer in one result", async () => {
    const { executeTool } = await import("./dispatcher.js");
    const asked: { question: string; index?: number; total?: number; recommended?: number }[] = [];
    const answers = ["Postgres", "Yes, keep it"];
    const result = (await executeTool(
      "ask_user",
      {
        questions: [
          { question: "Which database?", options: ["Postgres", "SQLite"], recommended: "Postgres" },
          { question: "Keep the old API working?", options: ["Yes, keep it", "No"] },
        ],
      },
      {
        workspaceId: "w",
        sandboxRunner: {} as never,
        onAskUser: async (q) => {
          asked.push(q);
          return answers[asked.length - 1]!;
        },
      },
    )) as { success: boolean; data: { answers: { question: string; answer: string }[] } };
    expect(asked.map((q) => [q.question, q.index, q.total])).toEqual([
      ["Which database?", 0, 2],
      ["Keep the old API working?", 1, 2],
    ]);
    expect(asked[0]!.recommended).toBe(0);
    expect(result.success).toBe(true);
    expect(result.data.answers).toEqual([
      { question: "Which database?", answer: "Postgres" },
      { question: "Keep the old API working?", answer: "Yes, keep it" },
    ]);
  });

  // 13 Nov 2026: once the second question was showing, the first could not be changed.
  it("goes back to the question before, with its answer offered again, and keeps the rest", async () => {
    const { executeTool } = await import("./dispatcher.js");
    const { ASK_USER_BACK } = await import("@sqcode/shared");
    const asked: { question: string; index?: number; previous?: string }[] = [];
    const replies = ["Postgres", ASK_USER_BACK, "SQLite", "Yes, keep it"];
    const result = (await executeTool(
      "ask_user",
      {
        questions: [
          { question: "Which database?", options: ["Postgres", "SQLite"] },
          { question: "Keep the old API working?", options: ["Yes, keep it", "No"] },
        ],
      },
      { workspaceId: "w", sandboxRunner: {} as never, onAskUser: async (q) => (asked.push(q), replies[asked.length - 1]!) },
    )) as { success: boolean; data: { answers: { question: string; answer: string }[] } };
    expect(asked.map((q) => [q.index, q.previous])).toEqual([
      [0, undefined],
      [1, undefined],
      [0, "Postgres"],
      [1, undefined],
    ]);
    expect(result.data.answers).toEqual([
      { question: "Which database?", answer: "SQLite" },
      { question: "Keep the old API working?", answer: "Yes, keep it" },
    ]);
  });

  it("asks one question as before, unnumbered, with its answer where it always was", async () => {
    const { executeTool } = await import("./dispatcher.js");
    let seen: { index?: number; total?: number } | null = null;
    const result = (await executeTool(
      "ask_user",
      { question: "Ship it?" },
      { workspaceId: "w", sandboxRunner: {} as never, onAskUser: async (q) => ((seen = q), "Yes") },
    )) as { success: boolean; data: { answer: string } };
    expect(seen).not.toHaveProperty("total");
    expect(result.data.answer).toBe("Yes");
  });
});
