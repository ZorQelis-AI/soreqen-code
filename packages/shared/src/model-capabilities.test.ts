import { describe, it, expect, beforeEach } from "vitest";
import {
  clearRegisteredCapabilities,
  compactionTargetFor,
  modelSupportsVision,
  registerModelCapabilities,
  registeredCapabilities,
} from "./model-capabilities.js";

describe("model capabilities", () => {
  beforeEach(() => clearRegisteredCapabilities());

  it("prefers what a provider said over the family table", () => {
    // The table says every claude- model reads images.
    expect(modelSupportsVision("claude-opus-5")).toBe(true);
    registerModelCapabilities("claude-opus-5", { vision: false });
    expect(modelSupportsVision("claude-opus-5")).toBe(false);
  });

  it("merges registrations rather than replacing them", () => {
    registerModelCapabilities("mimo-v2.6-flash", { contextWindow: 1_048_576 });
    registerModelCapabilities("mimo-v2.6-flash", { vision: true });
    expect(registeredCapabilities("mimo-v2.6-flash")).toEqual({
      contextWindow: 1_048_576,
      vision: true,
    });
  });

  it("matches the longest family prefix, so a specific model can differ from its family", () => {
    /*
     * The case that matters: `deepseek-` as a family says nothing useful, and
     * the two DeepSeek models this ships with disagree with each other.
     */
    expect(modelSupportsVision("deepseek-v4.1-flash")).toBe(true);
    expect(modelSupportsVision("deepseek-flash")).toBe(false);
  });

  it("knows the OpenCode models that read images when the directory is not there", () => {
    // 23 Oct 2026: GLM 5.3 Flash was refused an image after a failed load.
    expect(modelSupportsVision("glm-5.3-flash")).toBe(true);
    expect(modelSupportsVision("glm-5.3")).toBe(false);
    expect(modelSupportsVision("kimi-k2.6")).toBe(true);
    expect(modelSupportsVision("kimi-k2-thinking")).toBe(false);
    expect(modelSupportsVision("qwen3.8-max")).toBe(true);
    expect(modelSupportsVision("qwen3-coder")).toBe(false);
    expect(modelSupportsVision("mimo-v2.5-pro")).toBe(false);
    expect(modelSupportsVision("mimo-v2.5-free")).toBe(true);
    expect(modelSupportsVision("nemotron-3.5-super-vl-free")).toBe(true);
    expect(modelSupportsVision("nemotron-3-ultra-free")).toBe(false);
  });

  it("assumes a model it has never heard of cannot see", () => {
    /*
     * The asymmetry is deliberate. Refusing to send an image to a model that
     * could have read it wastes one call and says so; sending one to a model
     * that cannot fails the whole request with an error naming neither.
     */
    expect(modelSupportsVision("some-new-model-2027")).toBe(false);
    expect(modelSupportsVision(undefined)).toBe(false);
  });

  it("aims a compaction at a size, not a share of the window", () => {
    expect(compactionTargetFor(1_000_000)).toBe(32_000);
    expect(compactionTargetFor(500_000)).toBe(32_000);
    expect(compactionTargetFor(128_000)).toBe(32_000);
  });
});
