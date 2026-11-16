import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { LocalSandboxRunner } from "@sqcode/sandbox-runner";
import { runAgentTurn } from "./agent-loop.js";
import { LOAD_TOOLS, loadToolsDefinition, loadedIn, resolveToolNames, shouldDefer } from "./deferred-tools.js";
import type { ExternalToolDefinition, ExternalTools } from "./external-tools.js";
import { MockLLMProvider } from "./llm-provider.js";
import type { LLMChatOptions } from "./types.js";

/** A connector the size of a real one: 40 tools with full schemas, about 20,000 tokens. */
function bigServer(server: string, count = 40): ExternalToolDefinition[] {
  return Array.from({ length: count }, (_, i) => ({
    name: `mcp__${server}__tool_${i}`,
    description: `Does thing ${i} in ${server}. ${"It has a long description with every option explained in detail. ".repeat(6)}`,
    input_schema: {
      type: "object" as const,
      properties: Object.fromEntries(
        Array.from({ length: 8 }, (_, p) => [`option_${p}`, { type: "string", description: `Option ${p}, explained at length so the schema is realistic.` }]),
      ),
      required: ["option_0"],
    },
  }));
}

describe("deciding and listing", () => {
  it("defers a large set and leaves a small one alone", () => {
    expect(shouldDefer(bigServer("canva"))).toBe(true);
    expect(shouldDefer(bigServer("tiny", 2).map((d) => ({ ...d, description: "Short.", input_schema: { type: "object" as const, properties: {}, required: [] } })))).toBe(false);
  });

  it("lists every tool by server in a load_tools definition far smaller than the schemas", () => {
    const defs = [...bigServer("canva"), ...bigServer("mail", 12)];
    const load = loadToolsDefinition(defs);
    expect(load.name).toBe(LOAD_TOOLS);
    expect(load.description).toContain("canva (call as mcp__canva__<tool>)");
    expect(load.description).toContain("tool_39: Does thing 39 in canva.");
    expect(load.description).toContain("mail (call as mcp__mail__<tool>)");
    expect(JSON.stringify(load).length).toBeLessThan(JSON.stringify(defs).length / 8);
  });

  it("resolves full names, short names and whole servers", () => {
    const defs = [...bigServer("canva", 3), ...bigServer("mail", 2)];
    expect(resolveToolNames(["mcp__canva__tool_1", "tool_0", "nope"], defs)).toEqual({
      found: ["mcp__canva__tool_1", "mcp__canva__tool_0", "mcp__mail__tool_0"],
      unknown: ["nope"],
    });
    expect(resolveToolNames(["mail"], defs).found).toEqual(["mcp__mail__tool_0", "mcp__mail__tool_1"]);
  });

  it("counts a tool as loaded once the conversation has called or loaded it", () => {
    const loaded = loadedIn([
      { role: "assistant", content: "", toolCalls: [{ id: "1", name: LOAD_TOOLS, input: { names: ["mcp__a__x"] } }] },
      { role: "assistant", content: "", toolCalls: [{ id: "2", name: "mcp__b__y", input: {} }, { id: "3", name: "read_file", input: {} }] },
    ]);
    expect([...loaded].sort()).toEqual(["mcp__a__x", "mcp__b__y"]);
  });
});

describe("a turn with a large connector", () => {
  it("sends load_tools instead of the schemas, then the tools it loads, and runs them (29 Oct 2026)", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sqcode_defer_"));
    const runner = new LocalSandboxRunner(dir);
    await runner.createWorkspace("defer_ws", { storagePath: dir });
    const defs = bigServer("canva");
    const called: string[] = [];
    const tools: ExternalTools = {
      definitions: () => defs,
      describe: (name) => (defs.some((d) => d.name === name) ? { server: "canva", tool: name, readOnly: true, declaredReadOnly: true, autoApproved: true } : undefined),
      call: async (name) => {
        called.push(name);
        return { success: true, data: `ran ${name}` };
      },
      promptSection: (o) => `## MCP SERVERS\n- canva (40 tools)${o?.deferred ? "" : "\nCANVA-INSTRUCTIONS"}`,
      instructions: (server) => (server === "canva" ? "CANVA-INSTRUCTIONS" : undefined),
    };
    const provider = new MockLLMProvider([
      { text: "", toolCalls: [{ id: "l1", name: LOAD_TOOLS, input: { names: ["tool_7"] } }], stopReason: "tool_use" as const },
      { text: "", toolCalls: [{ id: "c1", name: "mcp__canva__tool_7", input: { option_0: "x" } }], stopReason: "tool_use" as const },
      { text: "Done.", stopReason: "end_turn" as const },
    ]);
    const seen: LLMChatOptions[] = [];
    const inner = provider.chatStream.bind(provider);
    provider.chatStream = (o: LLMChatOptions) => {
      seen.push(o);
      return inner(o);
    };
    const result = await runAgentTurn({
      workspaceId: "defer_ws",
      sessionId: "s_defer",
      mode: "auto",
      userMessage: "make a design",
      sandboxRunner: runner,
      llmProvider: provider,
      externalTools: tools,
    });

    const names = (o: LLMChatOptions) => (o.tools ?? []).map((t) => t.name);
    // First request: the index, no connector schema, and no server instructions in the system prompt.
    expect(names(seen[0]!)).toContain(LOAD_TOOLS);
    expect(names(seen[0]!).filter((n) => n.startsWith("mcp__"))).toEqual([]);
    expect(seen[0]!.system).not.toContain("CANVA-INSTRUCTIONS");
    // What the connector costs each request now: the index, an eighth of its schemas or less.
    const connectorShare = (seen[0]!.tools ?? []).filter((t) => t.name === LOAD_TOOLS || t.name.startsWith("mcp__"));
    expect(JSON.stringify(connectorShare).length).toBeLessThan(JSON.stringify(defs).length / 8);
    // The load answered with the server's own instructions, and the next request carries the tool it loaded.
    const loadResult = result.history.find((m) => m.role === "tool" && m.toolCallId === "l1");
    expect(String(loadResult?.content)).toContain("CANVA-INSTRUCTIONS");
    expect(names(seen[1]!).filter((n) => n.startsWith("mcp__"))).toEqual(["mcp__canva__tool_7"]);
    expect(called).toEqual(["mcp__canva__tool_7"]);
    expect(result.stopReason).toBe("completed");
  }, 30_000);
});
