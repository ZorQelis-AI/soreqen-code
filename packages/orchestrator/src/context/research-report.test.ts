import { describe, expect, it } from "vitest";
import { gateHistory } from "./tool-gateway.js";
import { formatToolResult } from "../tool-result.js";
import { DOCUMENT_LIMITS } from "../tool-result.js";
import type { LLMMessage } from "../types.js";
import { compactHistory } from "../context-manager.js";

/*
 * A Max research report is the deliverable the agent answers from. Before 5 Oct
 * 2026 a 40,000-character report reached it cut twice: to 24,000 characters
 * with the middle "omitted", then to a 3,200-character digest of key lines.
 */
describe("a research report reaches the agent whole", () => {
  const report = Array.from({ length: 700 }, (_, i) => `Finding ${i}: a specific claim with a number ${i * 3} [${(i % 30) + 1}].`).join("\n");

  it("is not clipped when formatted", () => {
    const text = formatToolResult({ success: true, data: report }, { limit: DOCUMENT_LIMITS["research"] });
    expect(text).not.toContain("characters omitted");
    expect(text).toContain("Finding 699");
  });

  it("is not digested by the context gateway", () => {
    const messages: LLMMessage[] = [
      { role: "user", content: "Research it." },
      { role: "assistant", content: "", toolCalls: [{ id: "r1", name: "research", input: { question: "q", depth: "max" } }] },
      { role: "tool", toolCallId: "r1", content: report },
    ];
    const { messages: view } = gateHistory(messages, "s1");
    expect(view[2]!.content).toBe(report);
  });

  it("is not capped by the context manager's per-result limit", () => {
    const messages: LLMMessage[] = [
      { role: "user", content: "Research it." },
      { role: "assistant", content: "", toolCalls: [{ id: "r1", name: "research", input: { question: "q" } }] },
      { role: "tool", toolCallId: "r1", content: report },
    ];
    expect(compactHistory(messages, { maxTokens: 500_000 })[2]!.content).toBe(report);
  });

  it("still digests an ordinary large output", () => {
    const messages: LLMMessage[] = [
      { role: "user", content: "Run it." },
      { role: "assistant", content: "", toolCalls: [{ id: "c1", name: "run_command", input: { command: "x" } }] },
      { role: "tool", toolCallId: "c1", content: report },
    ];
    const { messages: view } = gateHistory(messages, "s1");
    expect(String(view[2]!.content).length).toBeLessThan(report.length);
  });
});
