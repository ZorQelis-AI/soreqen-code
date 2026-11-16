import { describe, expect, it } from "vitest";
import { modelDisplayName } from "./model-names.js";

describe("modelDisplayName", () => {
  it("names the OpenCode Go models the way their makers write them (31 Oct 2026)", () => {
    expect(modelDisplayName("mimo-v2.6-flash")).toBe("MiMo V2.6 Flash");
    expect(modelDisplayName("glm-5.3-flash")).toBe("GLM 5.3 Flash");
    expect(modelDisplayName("deepseek-v4.1-flash")).toBe("DeepSeek V4.1 Flash");
    expect(modelDisplayName("beam-free")).toBe("Beam Free");
  });

  it("drops the provider prefix and any tag", () => {
    expect(modelDisplayName("opencode/glm-5.3-flash")).toBe("GLM 5.3 Flash");
    expect(modelDisplayName("qwen/qwen3-coder:free")).toBe("Qwen3 Coder");
  });

  it("upper-cases sizes and versions, and keeps GPT's hyphen", () => {
    expect(modelDisplayName("qwen3-coder-30b-a3b-instruct")).toBe("Qwen3 Coder 30B A3B Instruct");
    expect(modelDisplayName("kimi-k2-thinking")).toBe("Kimi K2 Thinking");
    expect(modelDisplayName("gpt-4o-mini")).toBe("GPT-4o Mini");
    expect(modelDisplayName("gpt-6-luna")).toBe("GPT-6 Luna");
    expect(modelDisplayName("deepseek-r1")).toBe("DeepSeek R1");
  });

  it("gives an unfamiliar id a readable form rather than none", () => {
    expect(modelDisplayName("my_custom_model")).toBe("My Custom Model");
    expect(modelDisplayName("")).toBe("");
  });

  // 13 Nov 2026: the picker read "Claude Haiku 5 5".
  it("reads a version written with hyphens as one version, and never a date", () => {
    expect(modelDisplayName("claude-haiku-5-5")).toBe("Claude Haiku 5.5");
    expect(modelDisplayName("opencode/claude-opus-4-8")).toBe("Claude Opus 4.8");
    expect(modelDisplayName("claude-sonnet-5")).toBe("Claude Sonnet 5");
    expect(modelDisplayName("claude-3-5-sonnet-20241022")).toBe("Claude 3.5 Sonnet 20241022");
    expect(modelDisplayName("llama-3-70b")).toBe("Llama 3 70B");
  });
});
