/**
 * Where a model's context window comes from: the catalogue, then the
 * provider's own listing, then the built-in table.
 */

import { afterEach, describe, expect, it } from "vitest";
import { DEFAULT_CONTEXT_WINDOW, clearRegisteredContextWindows, contextWindowFor } from "@sqcode/shared";
import { discoverContextWindows, parseModelCatalogue, windowFromListing } from "./model-catalogue.js";

const env = (models: string): Record<string, string> => ({ SOREQEN_MODELS: models, KEY_A: "secret-a" });

function listing(body: unknown, status = 200): typeof fetch {
  return (async () =>
    new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })) as typeof fetch;
}

describe("model catalogue context windows", () => {
  afterEach(() => clearRegisteredContextWindows());

  it("takes a window stated in the catalogue, under both names", () => {
    const [model] = parseModelCatalogue(env("big|https://api.example.com/v1|KEY_A|big-upstream|Big|1m"));
    expect(model!.contextWindow).toBe(1_000_000);
    expect(contextWindowFor("big")).toBe(1_000_000);
    expect(contextWindowFor("big-upstream")).toBe(1_000_000);
  });

  it("ignores a window it cannot read, rather than guessing", () => {
    const [model] = parseModelCatalogue(env("odd|https://api.example.com/v1|KEY_A|odd|Odd|huge"));
    expect(model!.contextWindow).toBeUndefined();
    expect(contextWindowFor("odd")).toBe(DEFAULT_CONTEXT_WINDOW);
  });

  it("learns a window from the provider's model listing", async () => {
    const catalogue = parseModelCatalogue(env("new|https://api.example.com/v1|KEY_A|vendor/new-model|New"));
    let asked = "";
    let auth = "";
    const learned = await discoverContextWindows(catalogue, {
      fetch: (async (url: string, init?: RequestInit) => {
        asked = url;
        auth = new Headers(init?.headers).get("authorization") ?? "";
        return listing({ data: [{ id: "other", context_length: 8_000 }, { id: "vendor/new-model", context_length: 262_144 }] })();
      }) as typeof fetch,
    });
    expect(asked).toBe("https://api.example.com/v1/models");
    expect(auth).toBe("Bearer secret-a");
    expect(learned).toEqual({ new: 262_144 });
    expect(contextWindowFor("new")).toBe(262_144);
  });

  it("keeps the catalogue's window over the provider's", async () => {
    const catalogue = parseModelCatalogue(env("fixed|https://api.example.com/v1|KEY_A|fixed|Fixed|500k"));
    const learned = await discoverContextWindows(catalogue, { fetch: listing({ data: [{ id: "fixed", context_length: 8_000 }] }) });
    expect(learned).toEqual({});
    expect(contextWindowFor("fixed")).toBe(500_000);
  });

  it("falls back quietly when the provider is unreachable or says nothing", async () => {
    const catalogue = parseModelCatalogue(env("mimo-v2.5|https://api.example.com/v1|KEY_A|mimo-v2.5|MiMo"));
    await expect(
      discoverContextWindows(catalogue, {
        fetch: (async () => {
          throw new Error("offline");
        }) as typeof fetch,
      }),
    ).resolves.toEqual({});
    await expect(discoverContextWindows(catalogue, { fetch: listing({ error: "no" }, 401) })).resolves.toEqual({});
    await expect(discoverContextWindows(catalogue, { fetch: listing({ data: [{ id: "mimo-v2.5" }] }) })).resolves.toEqual({});
    expect(contextWindowFor("mimo-v2.5")).toBe(1_000_000);
  });

  it("reads the field names providers use", () => {
    expect(windowFromListing({ context_window: 1_000_000 })).toBe(1_000_000);
    expect(windowFromListing({ max_model_len: 32_768 })).toBe(32_768);
    expect(windowFromListing({ top_provider: { context_length: 200_000 } })).toBe(200_000);
    expect(windowFromListing({ id: "x" })).toBeNull();
    expect(windowFromListing(undefined)).toBeNull();
  });
});
