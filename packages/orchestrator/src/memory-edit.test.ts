/**
 * Editing memories in place, links between them, and the tidy pass
 * (13 Nov 2026: "it can edit that … like the Claude's Memory Function").
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MEMORY_TIDY_PROMPT, MEMORY_TOOL_DEFINITIONS, MemoryStore, linksIn, memoryPromptSection, runMemoryTool } from "./memory.js";
import { worthExtracting } from "./memory-extract.js";

let dir: string;
let store: MemoryStore;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "sqcode_memedit_"));
  store = new MemoryStore({ user: path.join(dir, "user"), project: path.join(dir, "project") });
  store.save({
    scope: "user",
    name: "blog-vps",
    description: "The blog's VPS: host, user, key",
    kind: "reference",
    content: "Host 203.0.113.7, user deploy, key ~/.ssh/blog_ed25519. Serves [[blog-site]].",
  });
  store.save({ scope: "user", name: "blog-site", description: "The blog: Astro, deployed with rsync", kind: "project", content: "Astro site; deploy with `pnpm deploy`." });
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));

describe("edit_memory", () => {
  it("replaces one exact piece of a memory and keeps the rest", () => {
    const r = runMemoryTool(store, "edit_memory", { scope: "global", name: "blog-vps", old_text: "203.0.113.7", new_text: "203.0.113.9" });
    expect(r.success).toBe(true);
    const m = store.read("user", "blog-vps")!;
    expect(m.content).toBe("Host 203.0.113.9, user deploy, key ~/.ssh/blog_ed25519. Serves [[blog-site]].");
    expect(m.kind).toBe("reference");
    expect(m.description).toBe("The blog's VPS: host, user, key");
  });

  it("changes only the description when that is all it is given", () => {
    expect(runMemoryTool(store, "edit_memory", { scope: "global", name: "blog-vps", description: "Blog VPS (Hetzner)" }).success).toBe(true);
    expect(store.read("user", "blog-vps")!.description).toBe("Blog VPS (Hetzner)");
    expect(fs.readFileSync(path.join(dir, "user", "MEMORY.md"), "utf8")).toContain("Blog VPS (Hetzner)");
  });

  it("refuses text that is not there, and shows what is", () => {
    const r = runMemoryTool(store, "edit_memory", { scope: "global", name: "blog-vps", old_text: "10.0.0.1", new_text: "x" });
    expect(r.success).toBe(false);
    expect(r.error).toMatch(/not in 'blog-vps'/);
    expect(r.error).toContain("203.0.113.7");
  });

  it("refuses text that appears twice, rather than guessing which", () => {
    store.save({ scope: "user", name: "ports", description: "ports", kind: "project", content: "api 3000, web 3000" });
    const r = runMemoryTool(store, "edit_memory", { scope: "global", name: "ports", old_text: "3000", new_text: "3005" });
    expect(r.success).toBe(false);
    expect(r.error).toMatch(/more than once/);
  });

  it("never writes a secret in through an edit", () => {
    const key = ["sk", "proj", "abcdefghijklmnopqrstuvwx"].join("-");
    const r = runMemoryTool(store, "edit_memory", { scope: "global", name: "blog-vps", old_text: "user deploy", new_text: `user deploy, key ${key}` });
    expect(r.success).toBe(false);
    expect(store.read("user", "blog-vps")!.content).not.toContain(key);
  });

  it("will not empty a memory: that is forget", () => {
    const r = runMemoryTool(store, "edit_memory", { scope: "global", name: "blog-site", old_text: "Astro site; deploy with `pnpm deploy`.", new_text: "" });
    expect(r.success).toBe(false);
    expect(r.error).toMatch(/forget/);
  });

  it("is offered to the model beside remember, forget and recall", () => {
    expect(MEMORY_TOOL_DEFINITIONS.map((t) => t.name)).toEqual(["remember", "edit_memory", "forget", "recall"]);
  });
});

describe("links between memories", () => {
  it("reads [[name]] links, once each", () => {
    expect(linksIn("See [[Blog Site]] and [[blog-site]], and [[nexryzen-vps]].")).toEqual(["blog-site", "nexryzen-vps"]);
  });

  it("recall brings each linked memory's line, and says when one is missing", () => {
    runMemoryTool(store, "edit_memory", { scope: "global", name: "blog-vps", old_text: "Serves [[blog-site]].", new_text: "Serves [[blog-site]] and [[old-shop]]." });
    const r = runMemoryTool(store, "recall", { name: "blog-vps" });
    expect(r.success).toBe(true);
    const links = (r.data as { links: Array<{ name: string; description?: string; missing?: boolean }> }).links;
    expect(links).toEqual([
      { name: "blog-site", scope: "global", description: "The blog: Astro, deployed with rsync" },
      { name: "old-shop", missing: true },
    ]);
  });
});

describe("what the prompt teaches", () => {
  const section = memoryPromptSection("", ["user", "project"]);
  it("saves confirmed approaches, not only corrections", () => {
    expect(section).toMatch(/confirms an approach/);
  });
  it("edits one fact in place and fixes a wrong memory at once", () => {
    expect(section).toContain("edit_memory");
    expect(section).toMatch(/fix it with `edit_memory` or `forget` it at once/);
  });
  it("links related memories", () => {
    expect(section).toContain("[[their-name]]");
  });
  it("has a tidy pass that touches memory only", () => {
    expect(MEMORY_TIDY_PROMPT).toMatch(/change no project file/);
    expect(MEMORY_TIDY_PROMPT).toMatch(/Merge/);
  });
});

describe("the extractor's look", () => {
  it("looks after a confirmed approach as it does after a correction", () => {
    expect(worthExtracting({ request: "yes, that's exactly what I wanted, keep doing it this way", toolCalls: 1, commands: 0, filesChanged: 0 })).toBe(true);
    expect(worthExtracting({ request: "what does this function do?", toolCalls: 1, commands: 0, filesChanged: 0 })).toBe(false);
  });
});
