import { describe, expect, it } from "vitest";
import { creditsDetail, effectiveWindow, flexDetail, hostedDetail, markDefaultModel, usageFromGateway } from "./soreqen-credits.js";

describe("usageFromGateway", () => {
  it("reads the gateway's credits into the windows the apps draw, the month as plan credits used", () => {
    const u = usageFromGateway({
      plan: "pro",
      credits: { plan: { granted: 35_467, remaining: 30_000, period_end: "2026-12-01T00:00:00.000Z" }, purchased: { remaining: 0, next_expiry: null }, spendable_now: 800 },
      windows: {
        five_hour: { used: 308, limit: 1_108, used_percent: 28, resets_at: "2026-11-14T17:00:00.000Z", lifted: false },
        weekly: { used: 5_000, limit: 8_866, used_percent: 56, resets_at: "2026-11-18T00:00:00.000Z" },
        burst: { active: false, used: 0, limit: 7_447, ends_at: null, available_at: null },
      },
      flex: { balance_usd: 12.5 },
    });
    expect(u).toMatchObject({ plan: "pro", hosted: true, allowed: true });
    expect(u.windows!.five_hour).toEqual({ used_percent: 28, resets_at: "2026-11-14T17:00:00.000Z", used: 308, limit: 1_108 });
    expect(u.windows!.monthly).toMatchObject({ used: 5_467, limit: 35_467, used_percent: 15 });
    expect(u.credits).toMatchObject({ spendable_now: 800, flex_usd: 12.5, five_hour_lifted: false });
  });

  it("never throws on an answer in another shape: it leaves the windows out", () => {
    expect(() => usageFromGateway({ plan: "pro", windows: [] as never })).not.toThrow();
    const u = usageFromGateway({ plan: "free" });
    expect(u.windows).toBeNull();
    expect(u.allowed).toBe(false);
  });
});

describe("what the picker says", () => {
  it("credits a request, to one decimal below ten", () => {
    expect(creditsDetail(1)).toBe("≈ 1 credit a request");
    expect(creditsDetail(2.44)).toBe("≈ 2.4 credits a request");
    expect(creditsDetail(88.2)).toBe("≈ 88 credits a request");
    expect(creditsDetail(undefined)).toBeUndefined();
    expect(hostedDetail({ id: "soreqen-auto", name: "SoreQen Auto", auto: true })).toBe("Picks the model for each step");
  });

  it("a Flex model's provider price", () => {
    expect(flexDetail({ input: 4, output: 20 })).toBe("$4.00 in, $20.00 out per M");
    expect(flexDetail({ input: 0.05, output: 0.4 })).toBe("$0.050 in, $0.40 out per M");
  });

  it("compacts below a price cliff, and marks the gateway's default", () => {
    expect(effectiveWindow(2_000_000, 200_000)).toBe(200_000);
    expect(effectiveWindow(262_144, null)).toBe(262_144);
    expect(effectiveWindow(null, 200_000)).toBe(200_000);
    const models = markDefaultModel({ default_model: "b", data: [{ id: "a", name: "A" }, { id: "b", name: "B" }] });
    expect(models.map((m) => Boolean(m.default))).toEqual([false, true]);
  });
});

describe("a model an admin paused (catalogue: unavailable)", () => {
  it("says so under its name instead of a price", () => {
    expect(hostedDetail({ id: "glm-5.3", name: "GLM 5.3", credits_per_request: 9, available: false })).toBe("Not available currently");
    expect(hostedDetail({ id: "glm-5.3", name: "GLM 5.3", credits_per_request: 9 })).not.toBe("Not available currently");
  });

  it("is never where a new session starts, even when it is the gateway's default", () => {
    const list = markDefaultModel({ data: [{ id: "mimo-v2.6-flash", name: "MiMo", available: false }, { id: "glm-5.3", name: "GLM" }], default_model: "mimo-v2.6-flash" });
    expect(list.some((m) => m.default)).toBe(false);
  });
});
