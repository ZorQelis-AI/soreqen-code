import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { loadCliConfig, MissingApiKeyError } from "./config.js";
import { OWN_KEY_PROVIDERS } from "@sqcode/shared";

/**
 * Every variable the loader looks at, keys and models alike, cleared so a
 * developer's own shell or ~/.soreqen/.env cannot decide whether these tests
 * pass. Only the keys were cleared once, and the default-model test passed
 * on one machine because its .env named the model (16 Oct 2026).
 */
const KEY_VARS = [...new Set(OWN_KEY_PROVIDERS.flatMap((p) => [...p.keyVars, ...p.modelVars]))];
const OPENCODE = OWN_KEY_PROVIDERS.find((p) => p.id === "opencode")!;

describe("@sqcode/cli configuration", () => {
  beforeEach(() => {
    for (const v of KEY_VARS) vi.stubEnv(v, "");
  });
  afterEach(() => vi.unstubAllEnvs());

  /*
   * The important one.
   *
   * `loadCliConfig()` used to end in `|| "sk-…"` — a real key compiled into
   * the package — and the old version of this test asserted only that
   * `apiKey` was *defined*, which that default satisfied perfectly. The test
   * passed precisely because the bug was present.
   *
   * So the assertion is inverted: with nothing configured it must refuse.
   */
  it("refuses to start with no key rather than falling back to a shared one", () => {
    expect(() => loadCliConfig()).toThrow(MissingApiKeyError);
  });

  it("names the variables to set, so the error is actionable", () => {
    expect(() => loadCliConfig()).toThrow(/OPENCODE_API_KEY/);
  });

  it("ships no key of its own", async () => {
    // Reads the compiled source rather than trusting behaviour: a default
    // could be reintroduced anywhere in the resolution chain.
    const src = await import("node:fs/promises").then((fs) =>
      fs.readFile(new URL("./config.ts", import.meta.url), "utf8"),
    );
    const literals = src.match(/["'`]sk-[A-Za-z0-9_-]{20,}["'`]/g) ?? [];
    expect(literals).toEqual([]);
  });

  describe("picking a key and a provider", () => {
    /*
     * These two used to be decided independently, so setting an OpenCode key
     * *and* an Anthropic key gave you the Anthropic provider driving the
     * OpenCode key — an auth error naming the wrong service.
     */
    it("takes OpenCode first, and says so", () => {
      vi.stubEnv("OPENCODE_API_KEY", "sk-opencode-test");
      const c = loadCliConfig();
      expect(c.apiKey).toBe("sk-opencode-test");
      expect(c.provider).toBe("opencode");
    });

    it("uses Anthropic when that is the only key present", () => {
      vi.stubEnv("ANTHROPIC_API_KEY", "sk-ant-test");
      const c = loadCliConfig();
      expect(c.apiKey).toBe("sk-ant-test");
      expect(c.provider).toBe("anthropic");
    });

    it("never pairs one provider's key with another's provider", () => {
      vi.stubEnv("OPENCODE_API_KEY", "sk-opencode-test");
      vi.stubEnv("ANTHROPIC_API_KEY", "sk-ant-test");
      const c = loadCliConfig();
      expect(c.apiKey).toBe("sk-opencode-test");
      expect(c.provider).toBe("opencode");
    });
  });

  it("applies command line overrides correctly", () => {
    const config = loadCliConfig({
      model: "mimo-v2.5",
      permissionTier: "full_autonomy",
      apiKey: "sk-custom-override",
    });

    expect(config.model).toBe("mimo-v2.5");
    expect(config.permissionTier).toBe("full_autonomy");
    expect(config.apiKey).toBe("sk-custom-override");
  });

  it("defaults to OpenCode's default model and guarded autonomy", () => {
    vi.stubEnv("OPENCODE_API_KEY", "sk-opencode-test");
    const config = loadCliConfig();
    expect(config.model).toBe(OPENCODE.defaultModel);
    expect(config.permissionTier).toBe("guarded_autonomy");
  });
});
