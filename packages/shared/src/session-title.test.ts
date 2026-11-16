import { describe, expect, it } from "vitest";
import { displayTitle, sessionTitle } from "./session-title.js";

describe("session titles (6 Nov 2026)", () => {
  it("names a brief by its heading, without the markdown or the label", () => {
    expect(sessionTitle("# PROJECT: SoreQen Code — Custom Professional Typeface Design & Development\n\n## 1. YOUR ROLE\n\nAct as…")).toBe(
      "SoreQen Code — Custom Professional Typeface Design…",
    );
  });

  it("drops an opening word that says nothing, and cuts at a word", () => {
    expect(sessionTitle("Listen After just few days, I am gonna Launch the SoreQen Code app to everyone in India")).toBe(
      "After just few days, I am gonna Launch the SoreQen Code…",
    );
    expect(sessionTitle("hey, fix the login bug")).toBe("Fix the login bug");
    // A lead-in only when it reads as one: these are the subject.
    expect(sessionTitle("Listen to podcasts app: build it")).toBe("Listen to podcasts app: build it");
    expect(sessionTitle("look at the logs")).toBe("Look at the logs");
    expect(sessionTitle("Listen, the build is broken")).toBe("The build is broken");
    expect(sessionTitle("**Build** a `todo` app with [React](https://react.dev)")).toBe("Build a todo app with React");
  });

  it("skips code and rules, and falls back when nothing is left", () => {
    expect(sessionTitle("```\nnpm ERR! code 1\n```\nWhy does this fail?")).toBe("Why does this fail?");
    expect(sessionTitle("---\n\n- [ ] Ship the pricing page")).toBe("Ship the pricing page");
    expect(sessionTitle("   ")).toBe("New session");
  });

  it("shows stored titles the new way, keeping a cut title's mark", () => {
    expect(displayTitle("# PROJECT: SoreQen Code — Custom Professional Type…")).toBe("SoreQen Code — Custom Professional Type…");
    expect(displayTitle("Listen i want to Create a Tiny TTS Model.")).toBe("I want to Create a Tiny TTS Model.");
    expect(displayTitle("ZorQelis AI Company Email MCP Connection.")).toBe("ZorQelis AI Company Email MCP Connection.");
    expect(displayTitle(null)).toBeNull();
  });
});
