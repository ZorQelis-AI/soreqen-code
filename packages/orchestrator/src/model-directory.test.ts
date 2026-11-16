import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { clearRegisteredContextWindows, clearRegisteredCapabilities, contextWindowFor, modelSupportsVision } from "@sqcode/shared";
import { discoverContextWindows, parseModelCatalogue } from "./model-catalogue.js";
import {
  loadModelDirectory,
  lookupDirectoryModel,
  modelDirectoryIsFresh,
  parseModelDirectory,
  resetModelDirectory,
  setModelDirectoryCache,
  toDirectoryModel,
} from "./model-directory.js";

/** The shape models.dev actually publishes, trimmed to what is read. */
const DIRECTORY = {
  opencode: {
    id: "opencode",
    api: "https://opencode.ai/zen/v1",
    name: "OpenCode Zen",
    models: {
      "mimo-v2.6-flash-free": {
        name: "MiMo-V2.6-Flash Free",
        limit: { context: 200_000, output: 32_000 },
        modalities: { input: ["text", "image"], output: ["text"] },
        tool_call: true,
      },
      "nemotron-3-ultra-free": {
        name: "Nemotron 3 Ultra Free",
        limit: { context: 1_000_000, output: 128_000 },
        modalities: { input: ["text"], output: ["text"] },
        tool_call: true,
      },
    },
  },
  "opencode-go": {
    id: "opencode-go",
    api: "https://opencode.ai/zen/go/v1",
    name: "OpenCode Go",
    models: {
      "mimo-v2.6-flash": {
        name: "MiMo-V2.6-Flash",
        limit: { context: 1_048_576, output: 131_072 },
        modalities: { input: ["text", "image", "pdf"], output: ["text"] },
        tool_call: true,
      },
    },
  },
  // A provider with no `api` is ignored rather than crashing the parse.
  broken: { id: "broken", models: { x: {} } },
};

const env = (models: string) => ({ SOREQEN_MODELS: models, KEY: "k" });

const jsonFetch = (body: unknown): typeof fetch =>
  (async () => ({ ok: true, json: async () => body }) as unknown as Response) as unknown as typeof fetch;

describe("model directory", () => {
  beforeEach(() => {
    resetModelDirectory();
    clearRegisteredContextWindows();
    clearRegisteredCapabilities();
  });

  it("reads windows, output limits and modalities", () => {
    const model = toDirectoryModel("mimo-v2.6-flash", DIRECTORY["opencode-go"].models["mimo-v2.6-flash"]);
    expect(model).toEqual({
      id: "mimo-v2.6-flash",
      label: "MiMo-V2.6-Flash",
      contextWindow: 1_048_576,
      maxOutput: 131_072,
      vision: true,
      toolCall: true,
    });
  });

  it("leaves vision undefined when the entry does not say", () => {
    /*
     * Undefined and false are different answers. "This source does not know"
     * must fall through to the family table; "no" must not.
     */
    const model = toDirectoryModel("x", { name: "X", limit: { context: 1000 } });
    expect(model?.vision).toBeUndefined();
  });

  it("keys providers by their API base url, so two plans do not collide", () => {
    const directory = parseModelDirectory(DIRECTORY);
    expect(directory.size).toBe(2); // `broken` has no api and is skipped.

    const go = lookupDirectoryModel(directory, "https://opencode.ai/zen/go/v1", "mimo-v2.6-flash");
    expect(go?.contextWindow).toBe(1_048_576);

    const zen = lookupDirectoryModel(directory, "https://opencode.ai/zen/v1", "mimo-v2.6-flash-free");
    expect(zen?.contextWindow).toBe(200_000);
  });

  it("ignores a trailing slash and case in the base url", () => {
    const directory = parseModelDirectory(DIRECTORY);
    expect(lookupDirectoryModel(directory, "https://OpenCode.ai/zen/go/v1/", "mimo-v2.6-flash")).not.toBeNull();
  });

  it("finds a model on the same host when its provider's address moved, not at the first reseller listed (31 Oct 2026)", () => {
    const directory = new Map([
      ["https://api.scnet.cn/api/llm/v1", new Map([["deepseek-v4.1-flash", { id: "DeepSeek-V4.1-Flash", vision: false, contextWindow: 1_000_000 }]])],
      ["https://opencode.ai/inference/openai/v1", new Map([["deepseek-v4.1-flash", { id: "deepseek-v4.1-flash", vision: true, contextWindow: 999_000 }]])],
      ["https://opencode.ai/inference/go/openai/v1", new Map([["deepseek-v4.1-flash", { id: "deepseek-v4.1-flash", vision: true, contextWindow: 1_000_000 }]])],
    ]);
    const found = lookupDirectoryModel(directory, "https://opencode.ai/zen/go/v1", "deepseek-v4.1-flash");
    expect(found?.vision).toBe(true);
    // The Go listing, by the path it shares, over the same host's other plan.
    expect(found?.contextWindow).toBe(1_000_000);
  });

  it("goes with most providers, not the first, for a host it does not know", () => {
    const directory = new Map([
      ["https://a.example/v1", new Map([["m", { id: "m", vision: false }]])],
      ["https://b.example/v1", new Map([["m", { id: "m", vision: true }]])],
      ["https://c.example/v1", new Map([["m", { id: "m", vision: true }]])],
    ]);
    expect(lookupDirectoryModel(directory, "https://elsewhere.example/v1", "m")?.vision).toBe(true);
  });

  it("survives a response that is not the shape it expects", () => {
    expect(parseModelDirectory(null).size).toBe(0);
    expect(parseModelDirectory("nope").size).toBe(0);
    expect(parseModelDirectory({ p: { api: "x", models: null } }).size).toBe(0);
  });
});

describe("discoverContextWindows with a directory", () => {
  beforeEach(() => {
    resetModelDirectory();
    clearRegisteredContextWindows();
    clearRegisteredCapabilities();
  });

  it("learns the window and the vision support a provider listing does not carry", async () => {
    const catalogue = parseModelCatalogue(
      env("mimo|https://opencode.ai/zen/go/v1|KEY|mimo-v2.6-flash|MiMo"),
    );

    const learned = await discoverContextWindows(catalogue, { fetch: jsonFetch(DIRECTORY) });

    expect(learned["mimo"]).toBe(1_048_576);
    expect(contextWindowFor("mimo")).toBe(1_048_576);
    // The fact no `GET /models` here reports, and the image tools depend on.
    expect(modelSupportsVision("mimo")).toBe(true);
    expect(modelSupportsVision("mimo-v2.6-flash")).toBe(true);
  });

  it("does not let the directory override a window the deployment stated", async () => {
    const catalogue = parseModelCatalogue(
      env("mimo|https://opencode.ai/zen/go/v1|KEY|mimo-v2.6-flash|MiMo|256k"),
    );
    await discoverContextWindows(catalogue, { fetch: jsonFetch(DIRECTORY) });
    expect(contextWindowFor("mimo")).toBe(256_000);
  });

  it("never throws when the directory is unreachable", async () => {
    const catalogue = parseModelCatalogue(env("m|https://example.com/v1|KEY|m|M"));
    const dead = (async () => {
      throw new Error("offline");
    }) as unknown as typeof fetch;
    await expect(discoverContextWindows(catalogue, { fetch: dead })).resolves.toEqual({});
  });
});

describe("a directory load that fails", () => {
  const dead = (async () => {
    throw new Error("offline");
  }) as unknown as typeof fetch;
  let dir: string;

  beforeEach(() => {
    resetModelDirectory();
    clearRegisteredCapabilities();
    dir = mkdtempSync(join(tmpdir(), "sqc-models-"));
  });
  afterEach(() => {
    vi.useRealTimers();
    rmSync(dir, { recursive: true, force: true });
  });

  it("is not kept for the life of the process: the next call after the back-off asks again", async () => {
    // 23 Oct 2026: one failure at startup stood for the whole run, and GLM 5.3
    // Flash, which reads images, was refused one.
    vi.useFakeTimers({ now: 1_000_000 });
    expect((await loadModelDirectory({ fetch: dead })).size).toBe(0);
    expect(modelDirectoryIsFresh()).toBe(false);

    let asked = 0;
    const counting = (async (...args: Parameters<typeof fetch>) => {
      asked++;
      return jsonFetch(DIRECTORY)(...args);
    }) as typeof fetch;
    // Inside the back-off nothing is asked, so a dead network is not hammered.
    expect((await loadModelDirectory({ fetch: counting })).size).toBe(0);
    expect(asked).toBe(0);

    vi.setSystemTime(1_000_000 + 21_000);
    expect((await loadModelDirectory({ fetch: counting })).size).toBe(2);
    expect(asked).toBe(1);
    expect(modelDirectoryIsFresh()).toBe(true);
  });

  it("falls back to the last good copy on disk", async () => {
    const file = join(dir, "cache", "models-dev.json");
    setModelDirectoryCache(file);
    await loadModelDirectory({ fetch: jsonFetch(DIRECTORY) });
    expect(existsSync(file)).toBe(true);

    // A later start with no network still knows the model reads images.
    resetModelDirectory();
    setModelDirectoryCache(file);
    const catalogue = parseModelCatalogue(env("mimo|https://opencode.ai/zen/go/v1|KEY|mimo-v2.6-flash|MiMo"));
    await discoverContextWindows(catalogue, { fetch: dead });
    expect(modelSupportsVision("mimo-v2.6-flash")).toBe(true);
    expect(modelDirectoryIsFresh()).toBe(false);
  });
});
