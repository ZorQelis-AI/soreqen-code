/**
 * LLM Provider Interface & Implementations
 */

import { AnthropicMessagesProvider } from "./anthropic-provider.js";
import type { LLMProvider, LLMChatOptions, LLMResponseChunk } from "./types.js";

/**
 * Claude on Anthropic's Messages API. The name the CLI has always imported;
 * the provider itself, with thinking, signatures and prompt caching, is in
 * `anthropic-provider.ts`.
 */
export class AnthropicProvider extends AnthropicMessagesProvider {
  constructor(options?: { apiKey?: string; defaultModel?: string; baseURL?: string }) {
    super(options ?? {});
  }
}

/**
 * Mock / Scripted LLM Provider for Testing and Deterministic Orchestration
 */
export class MockLLMProvider implements LLMProvider {
  public name = "mock";
  private responses: Array<{
    text?: string;
    toolCalls?: Array<{ id: string; name: string; input: Record<string, unknown> }>;
    stopReason?: "end_turn" | "tool_use";
  }>;
  private callIndex = 0;

  constructor(
    responses?: Array<{
      text?: string;
      toolCalls?: Array<{ id: string; name: string; input: Record<string, unknown> }>;
      stopReason?: "end_turn" | "tool_use";
    }>,
  ) {
    this.responses = responses ?? [
      {
        text: "I will inspect the codebase and solve the issue.",
        stopReason: "end_turn",
      },
    ];
  }

  setResponses(
    responses: Array<{
      text?: string;
      toolCalls?: Array<{ id: string; name: string; input: Record<string, unknown> }>;
      stopReason?: "end_turn" | "tool_use";
    }>,
  ): void {
    this.responses = responses;
    this.callIndex = 0;
  }

  async *chatStream(_options: LLMChatOptions): AsyncIterable<LLMResponseChunk> {
    const resp = this.responses[this.callIndex] ?? {
      text: "Done.",
      stopReason: "end_turn" as const,
    };
    this.callIndex++;

    if (resp.text) {
      // Stream in chunks
      const words = resp.text.split(" ");
      for (const word of words) {
        yield { type: "token", text: `${word} ` };
      }
    }

    if (resp.toolCalls && resp.toolCalls.length > 0) {
      for (const tc of resp.toolCalls) {
        yield { type: "tool_call_start", id: tc.id, name: tc.name };
        yield { type: "tool_call_delta", id: tc.id, inputDelta: JSON.stringify(tc.input) };
        yield { type: "tool_call_complete", id: tc.id, name: tc.name, input: tc.input };
      }
      yield { type: "stop", reason: "tool_use" };
    } else {
      yield { type: "stop", reason: resp.stopReason ?? "end_turn" };
    }
  }
}
