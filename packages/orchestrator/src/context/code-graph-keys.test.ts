import { describe, expect, it } from "vitest";
import { keyPath } from "./code-graph.js";

describe("a node key's file", () => {
  it("keeps a Windows drive letter (notes said 'used by C')", () => {
    expect(keyPath("C:/Users/me/deck/make_deck.py:12#build")).toBe("C:/Users/me/deck/make_deck.py");
  });

  it("drops the line and the name from a relative path", () => {
    expect(keyPath("src/app.ts:40#render")).toBe("src/app.ts");
    expect(keyPath("src/app.ts#module")).toBe("src/app.ts");
  });
});
