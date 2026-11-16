import { afterEach, describe, expect, it } from "vitest";
import {
  clearReasoningLadders,
  ladderBelow,
  ladderFromRefusal,
  levelOn,
  reasoningLadderFor,
  registerReasoningLadder,
  tierMapping,
} from "./reasoning-ladder.js";

afterEach(() => clearReasoningLadders());

describe("spreading the six tiers over a model's levels", () => {
  it("pairs the tiers on a three-level model", () => {
    expect(tierMapping(["low", "medium", "high"])).toEqual({
      low: "low",
      medium: "low",
      high: "medium",
      extra: "medium",
      max: "high",
      apex: "high",
    });
  });

  it("matches them one to one on a five-level model, Max and Apex sharing the top", () => {
    expect(tierMapping(["low", "medium", "high", "xhigh", "max"])).toEqual({
      low: "low",
      medium: "medium",
      high: "high",
      extra: "xhigh",
      max: "max",
      apex: "max",
    });
  });

  it("never asks for less as the tier rises, whatever the ladder's length", () => {
    const all = ["low", "medium", "high", "xhigh", "max"];
    for (let n = 1; n <= all.length; n++) {
      const ladder = all.slice(0, n);
      const rungs = Object.values(tierMapping(ladder)).map((l) => ladder.indexOf(l));
      for (let i = 1; i < rungs.length; i++) expect(rungs[i]!).toBeGreaterThanOrEqual(rungs[i - 1]!);
      expect(rungs[0]).toBe(0);
      expect(rungs[rungs.length - 1]).toBe(n - 1);
    }
  });

  it("never sends off, none or minimal", () => {
    expect(levelOn("low", [])).toBe("low");
    expect(reasoningLadderFor("gpt-6-luna", "responses")).not.toContain("minimal");
  });
});

describe("knowing a model's ladder", () => {
  it("uses the family's published levels, then the API's usual three", () => {
    expect(reasoningLadderFor("gpt-6-luna", "responses")).toEqual(["low", "medium", "high", "xhigh", "max"]);
    expect(reasoningLadderFor("openai/gpt-5.1-codex", "chat")).toEqual(["low", "medium", "high"]);
    expect(reasoningLadderFor("deepseek-chat", "chat")).toEqual(["low", "medium", "high"]);
  });

  it("learns the ladder from the values a refusal lists", () => {
    const message =
      "Unsupported value: 'reasoning.effort' does not support 'max' with this model. Supported values are: 'none', 'minimal', 'low', 'medium', 'high', and 'xhigh'.";
    const learned = ladderFromRefusal(message);
    expect(learned).toEqual(["low", "medium", "high", "xhigh"]);
    registerReasoningLadder("gpt-x", learned!);
    expect(reasoningLadderFor("gpt-x", "responses")).toEqual(["low", "medium", "high", "xhigh"]);
    expect(ladderFromRefusal("Rate limit reached")).toBeNull();
  });

  it("steps below a refused level when the refusal does not say more", () => {
    expect(ladderBelow(["low", "medium", "high", "xhigh", "max"], "max")).toEqual(["low", "medium", "high", "xhigh"]);
    expect(ladderBelow(["low"], "low")).toEqual(["low"]);
  });
});
