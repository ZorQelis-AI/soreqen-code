import { describe, expect, it } from "vitest";
import { fillPrompt, parsePromptCommand, progressDetail } from "./extensions.js";
import type { McpHub } from "@sqcode/mcp";

describe("/prompt", () => {
  it("reads server/name and key=value arguments, quoted or not", () => {
    expect(parsePromptCommand(' github/review_pr pr=42 focus="error handling" note=\'a b\' ')).toEqual({
      server: "github",
      name: "review_pr",
      args: { pr: "42", focus: "error handling", note: "a b" },
    });
    expect(parsePromptCommand("docs:summarize")).toEqual({ server: "docs", name: "summarize", args: {} });
    expect(parsePromptCommand("")).toBeNull();
    expect(parsePromptCommand("no-slash")).toBeNull();
  });

  it("says what is missing before asking the server, and sends what it fills in", async () => {
    const hub = {
      listPrompts: async () => [{ server: "gh", name: "review", arguments: [{ name: "pr", required: true }, { name: "focus" }] }],
      getPrompt: async (_s: string, _n: string, args: Record<string, string>) => ({ text: `Review PR ${args["pr"]}` }),
    } as unknown as McpHub;
    expect(await fillPrompt(hub, "gh/review")).toEqual({ error: "gh/review needs pr=…" });
    expect(await fillPrompt(hub, "gh/nope")).toMatchObject({ error: expect.stringContaining("No prompt gh/nope") });
    expect(await fillPrompt(null, "gh/review pr=1")).toEqual({ error: "No MCP servers are connected." });
    expect(await fillPrompt(hub, "gh/review pr=7")).toEqual({ text: "Review PR 7" });
  });
});

describe("MCP progress on the spinner", () => {
  it("shows a count, a percentage or a message, whichever the server gave", () => {
    expect(progressDetail({ progress: 3, total: 10, message: "fetching   issues" })).toBe("3/10 · fetching issues");
    expect(progressDetail({ progress: 40, total: 100 })).toBe("40%");
    expect(progressDetail({ progress: 7 })).toBe("7");
    expect(progressDetail({})).toBeUndefined();
  });
});
