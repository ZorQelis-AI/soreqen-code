/**
 * Memory between sessions (29 Sep 2026): what the person asked SoreQen to
 * learn once, and not be told again in every new session.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { LocalSandboxRunner } from "@sqcode/sandbox-runner";
import { runAgentTurn } from "./agent-loop.js";
import type { LLMChatOptions, LLMProvider, LLMResponseChunk } from "./types.js";
import { MemoryStore, absorbIntoGlobal, memorySlug, otherProjectMemories, runMemoryTool, addsNothing } from "./memory.js";
import { extractMemories, worthExtracting, noteExtracted } from "./memory-extract.js";

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "sqcode_memory_"));
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));

// Fake secrets, built here so the source never holds one (the open-source export scans for them).
const FAKE_OPENAI_KEY = ["sk", "proj", "abcdefghijklmnopqrstuvwx"].join("-");
const FAKE_GITHUB_TOKEN = `ghp_${"abcdefghijklmnopqrstuvwxyz0123456789"}`;

const storeIn = (root: string) => new MemoryStore({ user: path.join(root, "user"), project: path.join(root, "project") });

describe("the memory store", () => {
  it("saves one file per memory with an index, and a save by the same name replaces it", () => {
    const store = storeIn(dir);
    store.save({ scope: "user", name: "Prefers pnpm", description: "Package manager", kind: "feedback", content: "Use pnpm, never npm. Why: the monorepo's lockfile is pnpm's." });
    const again = store.save({ scope: "user", name: "prefers-pnpm", description: "Package manager", kind: "feedback", content: "Use pnpm 10." });
    expect(again.replaced).toBe(true);
    expect(store.list("user")).toHaveLength(1);
    expect(store.read("user", "prefers-pnpm")?.content).toBe("Use pnpm 10.");
    const index = fs.readFileSync(path.join(dir, "user", "MEMORY.md"), "utf8");
    expect(index).toContain("[prefers-pnpm](prefers-pnpm.md): Package manager");
    expect(store.forget("user", "prefers-pnpm")).toBe(true);
    expect(store.list("user")).toHaveLength(0);
  });

  it("names memories safely: no path can leave the folder", () => {
    expect(memorySlug("../../etc/passwd")).toBe("etc-passwd");
    const store = storeIn(dir);
    store.save({ scope: "project", name: "../../outside", description: "", content: "x" });
    expect(fs.existsSync(path.join(dir, "project", "outside.md"))).toBe(true);
    expect(fs.readdirSync(dir).sort()).toEqual(["project"]);
  });

  it("never saves a secret", () => {
    const store = storeIn(dir);
    const refused = runMemoryTool(store, "remember", { scope: "user", name: "key", content: `The OpenAI key is ${FAKE_OPENAI_KEY}` });
    expect(refused.success).toBe(false);
    expect(store.list("user")).toHaveLength(0);
  });

  it("takes a short note, not a log (15 Oct 2026)", () => {
    const store = storeIn(dir);
    const log = `Sigma training: ${Array.from({ length: 100 }, (_, i) => `step ${i * 1000} loss ${(1 / (i + 1)).toFixed(3)}`).join(", ")}`;
    const refused = runMemoryTool(store, "remember", { scope: "global", name: "sigma", content: log });
    expect(refused.success).toBe(false);
    // How much to cut, in numbers: "shorter" alone took five tries (18 Oct 2026).
    expect(refused.error).toMatch(new RegExp(`Too long: ${log.length.toLocaleString("en-US")} characters.*Cut about ${(log.length - 1_200).toLocaleString("en-US")} characters.*Drop progress, results`));
    expect(store.list("user")).toHaveLength(0);
  });

  it("saves a note a little over the target, and says to keep the next one shorter (18 Oct 2026)", () => {
    const store = storeIn(dir);
    const note = `Outreach campaign rules: ${"send from official@zorqelisai.com, one email per provider, log replies in the tracker. ".repeat(14)}`.slice(0, 1_250);
    const saved = runMemoryTool(store, "remember", { scope: "global", name: "outreach", content: note });
    expect(saved.success).toBe(true);
    expect((saved.data as { note?: string }).note).toBe(
      `Saved, at ${note.trim().length.toLocaleString("en-US")} characters: over the 1,200 a memory should be. Keep the next one shorter.`,
    );
    expect(note.trim().length).toBeGreaterThan(1_200);
    expect(store.read("user", "outreach")?.content).toBe(note.trim());
  });

  it("sends a new memory on a remembered subject to that memory, to be rewritten as one (15 Oct 2026)", () => {
    const store = storeIn(dir);
    expect(
      runMemoryTool(store, "remember", {
        scope: "global",
        name: "checkout-api-requirements",
        description: "What the checkout API needs before launch",
        content: "The checkout API needs rate limiting on /pay.",
      }).success,
    ).toBe(true);
    const second = runMemoryTool(store, "remember", {
      scope: "global",
      name: "checkout-api-idempotency",
      description: "The checkout API needs idempotency keys",
      content: "The checkout API needs idempotency keys on /pay.",
    });
    expect(second.success).toBe(false);
    expect(second.error).toContain("'checkout-api-requirements'");
    expect(second.error).toContain("rate limiting on /pay");
    // Rewritten under its name, it is one memory saying both.
    const merged = runMemoryTool(store, "remember", {
      scope: "global",
      name: "checkout-api-requirements",
      content: "The checkout API needs rate limiting and idempotency keys on /pay.",
    });
    expect(merged.success).toBe(true);
    expect(store.list("user").map((m) => m.name)).toEqual(["checkout-api-requirements"]);
    // A different subject that shares a word or two is saved beside it.
    expect(runMemoryTool(store, "remember", { scope: "global", name: "home-nas", description: "The NAS at home", content: "NAS at 192.168.1.20." }).success).toBe(true);
    // And one the model says is distinct, when it is.
    expect(
      runMemoryTool(store, "remember", { scope: "global", name: "checkout-api-owner", description: "Who owns the checkout API", content: "Priya owns the checkout API.", distinct: true }).success,
    ).toBe(true);
  });

  it("indexes a memory without a description by its first sentence, not its first 200 characters", () => {
    const store = storeIn(dir);
    store.save({ scope: "user", name: "blog-vps", description: "", content: "The blog runs on a Hetzner VPS. ssh deploy@198.51.100.4 with ~/.ssh/blog, app in /srv/blog." });
    expect(store.read("user", "blog-vps")?.description).toBe("The blog runs on a Hetzner VPS.");
  });

  it("shows memories in full while they fit, and lists the rest to recall", () => {
    const store = storeIn(dir);
    for (let i = 0; i < 30; i++) store.save({ scope: "project", name: `fact-${i}`, description: `Fact number ${i}`, content: `Detail ${i}: ${"x".repeat(400)}` });
    const snapshot = store.snapshot("check fact number 3 and fact number 4", 2000);
    expect(snapshot).toContain("### This project");
    expect(snapshot).toContain("Listed only (read with recall):");
    expect(snapshot.length).toBeLessThan(2000 + 30 * 60);
  });

  /*
   * 6 Nov 2026: "hi" opened with the whole of a font build's notes and a
   * model-readiness review, 5,400 tokens, because everything that fitted
   * went in. Now a memory comes whole when the request is about it, or when
   * it is about the person or how they want to work, which every request is.
   */
  it("keeps unrelated project notes to their index line, and the person's preferences whole", () => {
    const store = storeIn(dir);
    store.save({
      scope: "user",
      name: "no-em-dashes",
      description: "Never use em dashes",
      kind: "feedback",
      content: `Ved never wants em dashes in anything written for him. ${"Applies to documents, code comments and commit messages alike. ".repeat(10)}`,
    });
    store.save({ scope: "user", name: "font-build", description: "How the SoreQen Code Mono font is built", kind: "project", content: "Edit sources/build, run python build.py, then pytest. 46 checks." });
    store.save({ scope: "user", name: "ved-machine", description: "Ved's PC", kind: "user", content: "Windows 11, RTX 5090, works from Desktop\\ZorQelis_AI." });
    const hello = store.snapshot("hi");
    // Who the person is: always whole. A preference: its line, which states the rule.
    expect(hello).toContain("RTX 5090");
    expect(hello).toContain("- no-em-dashes: Never use em dashes");
    expect(hello).toContain("- font-build: How the SoreQen Code Mono font is built");
    expect(hello).not.toContain("python build.py");
    // Whole once the request touches them.
    expect(store.snapshot("write the README, no dashes")).toContain("Ved never wants em dashes");
    expect(store.snapshot("rebuild the font and run the font tests")).toContain("python build.py");
  });
});

describe("memory across projects and chats (2 Oct 2026)", () => {
  /*
   * The case that motivated it: a project where SoreQen set up a VPS, then a
   * brand-new chat (or /clear) somewhere else asked to "connect to that VPS".
   */
  const setUp = () => {
    const projects = path.join(dir, "projects");
    const shop = path.join(projects, "shop-1a2b3c4d", "memory");
    const shopStore = new MemoryStore({ user: path.join(dir, "global"), project: shop, projectFolder: "C:\\work\\shop" });
    shopStore.save({
      scope: "project",
      name: "shop-vps",
      description: "The VPS the shop is deployed to",
      kind: "reference",
      content: "Deployed on a Hetzner VPS at 203.0.113.7, ssh as deploy with ~/.ssh/shop_ed25519; app in /opt/shop, restart with docker compose up -d.",
    });
    return { projects, shop };
  };

  it("lets a chat with no project folder see and recall another project's memories", () => {
    const { projects } = setUp();
    const fresh = new MemoryStore({ user: path.join(dir, "global"), others: otherProjectMemories(projects) });
    const snapshot = fresh.snapshot("connect to that VPS and check the logs");
    expect(snapshot).toContain("### Other projects");
    // Relevant to the request, so shown in full: the address is right there.
    expect(snapshot).toContain("[shop] **shop-vps**");
    expect(snapshot).toContain("203.0.113.7");
    // Not relevant: listed, not shown.
    expect(fresh.snapshot("rename the button")).toContain("- [shop] shop-vps: The VPS the shop is deployed to");
    expect(fresh.snapshot("rename the button")).not.toContain("203.0.113.7");
    const recalled = runMemoryTool(fresh, "recall", { name: "shop-vps", project: "shop" });
    expect(recalled.success).toBe(true);
    expect(JSON.stringify(recalled.data)).toContain("/opt/shop");
  });

  it("saves to global when no project folder is open, and says so if asked for project", () => {
    const fresh = new MemoryStore({ user: path.join(dir, "global") });
    expect(runMemoryTool(fresh, "remember", { scope: "global", name: "home-nas", content: "NAS at 192.168.1.20, user ved." }).success).toBe(true);
    expect(fresh.list("user").map((m) => m.name)).toEqual(["home-nas"]);
    const refused = runMemoryTool(fresh, "remember", { scope: "project", name: "x", content: "y" });
    expect(refused.success).toBe(false);
    expect(refused.error).toContain("scope 'global'");
  });

  it("does not list a project among the others when it is the one open", () => {
    const { projects, shop } = setUp();
    expect(otherProjectMemories(projects, shop)).toEqual([]);
    expect(otherProjectMemories(projects)[0]).toMatchObject({ label: "shop", folder: "C:\\work\\shop" });
  });

  it("moves a throwaway chat's memories into global without overwriting any", () => {
    const global = path.join(dir, "global");
    new MemoryStore({ user: global }).save({ scope: "user", name: "same-name", description: "", content: "global one" });
    const scratch = path.join(dir, "scratch-memory");
    const s = new MemoryStore({ project: scratch });
    s.save({ scope: "project", name: "same-name", description: "", content: "scratch one" });
    s.save({ scope: "project", name: "other", description: "", content: "kept" });
    expect(absorbIntoGlobal(scratch, global)).toBe(2);
    const store = new MemoryStore({ user: global });
    expect(store.read("user", "same-name")?.content).toBe("global one");
    expect(store.read("user", "same-name-2")?.content).toBe("scratch one");
    expect(store.read("user", "other")?.content).toBe("kept");
    expect(fs.readFileSync(path.join(global, "MEMORY.md"), "utf8")).toContain("[other](other.md)");
  });

  it("refuses a password but keeps a note of where one is kept", () => {
    const store = storeIn(dir);
    expect(runMemoryTool(store, "remember", { scope: "global", name: "db", content: "password: Hunter2!x" }).success).toBe(false);
    expect(runMemoryTool(store, "remember", { scope: "global", name: "db", content: "The root password is stored in 1Password under 'VPS'." }).success).toBe(true);
  });
});

describe("the check after a turn", () => {
  class Extracting implements LLMProvider {
    name = "extracting";
    prompt = "";
    constructor(private readonly answer: string) {}
    async *chatStream(options: LLMChatOptions): AsyncIterable<LLMResponseChunk> {
      this.prompt = String(options.messages[0]?.content ?? "");
      yield { type: "token", text: this.answer };
      yield { type: "stop", reason: "end_turn" };
    }
  }

  it("looks only at turns that worked on infrastructure or stated a preference", () => {
    expect(worthExtracting({ request: "what does this regex do?", toolCalls: 1, commands: 0, filesChanged: 0 })).toBe(false);
    expect(worthExtracting({ request: "set up the VPS", toolCalls: 9, commands: 2, filesChanged: 0, commandLines: ["ssh root@203.0.113.7 uptime", "ls"] })).toBe(true);
    expect(worthExtracting({ request: "From now on, always use pnpm", toolCalls: 0, commands: 0, filesChanged: 0 })).toBe(true);
    // A short turn of ordinary work is not looked at (15 Oct 2026: every turn was summarised into memory).
    expect(worthExtracting({ request: "rename this variable", toolCalls: 3, commands: 1, filesChanged: 1, commandLines: ["pnpm test"] })).toBe(false);
    // A long one is: it may have found a cause (16 Oct 2026: crucial findings went unsaved). The extractor decides what, if anything.
    const training = ["python -u diag_terms.py", "nvidia-smi", "Get-Content runs/train.log -Tail 20"];
    expect(worthExtracting({ request: "Why did the prior collapse?", toolCalls: 24, commands: 3, filesChanged: 4, commandLines: training })).toBe(true);
    // 13 Nov 2026: a long session crossed the old bar of 8 calls on every turn, and saved on every turn.
    expect(worthExtracting({ request: "Why did the prior collapse?", toolCalls: 14, commands: 3, filesChanged: 4, commandLines: training })).toBe(false);
    // After a look that saved, long turns wait; a stated preference does not.
    const storeKey = "test-store";
    noteExtracted(storeKey, 1_000_000);
    expect(worthExtracting({ request: "keep going", toolCalls: 30, commands: 3, filesChanged: 4, storeKey, now: 1_000_000 + 10 * 60_000 })).toBe(false);
    expect(worthExtracting({ request: "keep going", toolCalls: 30, commands: 3, filesChanged: 4, storeKey, now: 1_000_000 + 50 * 60_000 })).toBe(true);
    expect(worthExtracting({ request: "always use pnpm", toolCalls: 30, commands: 3, filesChanged: 4, storeKey, now: 1_000_000 + 60_000 })).toBe(true);
  });

  it("does not save a rewrite that adds nothing", () => {
    const store = new MemoryStore({ user: path.join(dir, "rewrite") });
    const first = "Blog on VPS 198.51.100.4; ssh root with ~/.ssh/blog; Caddy serves /srv/blog; restart with systemctl restart caddy.";
    expect(runMemoryTool(store, "remember", { scope: "global", name: "blog-vps", description: "Where the blog runs", content: first }).success).toBe(true);
    const reworded = "Caddy serves /srv/blog on VPS 198.51.100.4. SSH as root with ~/.ssh/blog; restart with systemctl restart caddy.";
    expect(runMemoryTool(store, "remember", { scope: "global", name: "blog-vps", description: "Where the blog runs", content: reworded }).data).toMatchObject({ unchanged: true });
    expect(addsNothing(first, `${first} Backups go to s3://blog-backups nightly via restic, keyed in ~/.config/restic.`)).toBe(false);
  });

  it("saves what the turn established, and never a secret", async () => {
    const store = new MemoryStore({ user: path.join(dir, "global") });
    const provider = new Extracting(
      "Here you go:\n```json\n" +
        JSON.stringify({
          memories: [
            { scope: "project", name: "blog-vps", description: "Where the blog runs", kind: "reference", content: "Blog on VPS 198.51.100.4, ssh root with ~/.ssh/blog; Caddy serves /srv/blog." },
            { scope: "global", name: "token", content: `The deploy token is ${FAKE_GITHUB_TOKEN}` },
          ],
        }) +
        "\n```",
    );
    const saved = await extractMemories({
      provider,
      store,
      request: "Deploy the blog to my new VPS",
      record: "Commands run:\n  - ssh root@198.51.100.4 [ok]",
      reply: "Deployed.",
    });
    // No project is open, so the project memory became global; the token was refused.
    expect(saved).toEqual(["blog-vps"]);
    expect(store.read("user", "blog-vps")?.content).toContain("198.51.100.4");
    expect(provider.prompt).toContain("No project folder is open");
  });

  it("saves nothing when the answer is not JSON", async () => {
    const store = new MemoryStore({ user: path.join(dir, "global") });
    expect(await extractMemories({ provider: new Extracting("nothing to save"), store, request: "x", record: "", reply: "" })).toEqual([]);
  });
});

/** A model that reads its memory, then saves a new one. */
class Remembering implements LLMProvider {
  name = "remembering";
  sawSystem = "";
  toolNames: string[] = [];
  async *chatStream(options: LLMChatOptions): AsyncIterable<LLMResponseChunk> {
    if (!this.sawSystem) {
      this.sawSystem = options.system;
      this.toolNames = (options.tools ?? []).map((t) => t.name);
    }
    const saved = options.messages.some((m) => m.role === "tool");
    if (!saved) {
      yield { type: "tool_call_start", id: "m1", name: "remember" };
      yield {
        type: "tool_call_complete",
        id: "m1",
        name: "remember",
        input: { scope: "project", name: "deploy-by-tag", description: "How this project deploys", kind: "project", content: "Deploys from main by pushing a v* tag." },
      };
      yield { type: "stop", reason: "tool_use" };
      return;
    }
    yield { type: "token", text: "Noted for next time." };
    yield { type: "stop", reason: "end_turn" };
  }
}

describe("memory in a turn", () => {
  it("starts the turn knowing what was remembered, and saves what it learns", async () => {
    const ws = `mem_ws_${Date.now()}`;
    const root = path.join(dir, "ws");
    fs.mkdirSync(root);
    const runner = new LocalSandboxRunner(root);
    await runner.createWorkspace(ws, { storagePath: root });
    const store = storeIn(path.join(dir, "mem"));
    store.save({ scope: "user", name: "no-em-dashes", description: "Writing style", kind: "feedback", content: "Never use em-dashes in copy." });

    const provider = new Remembering();
    const result = await runAgentTurn({
      workspaceId: ws,
      sessionId: "s_mem",
      mode: "bypass",
      userMessage: "We deploy by tagging main. Remember that.",
      sandboxRunner: runner,
      llmProvider: provider,
      memory: store,
    });

    expect(result.stopReason).toBe("completed");
    expect(provider.sawSystem).toContain("## MEMORY (kept between sessions)");
    expect(provider.sawSystem).toContain("Never use em-dashes in copy.");
    expect(provider.toolNames).toEqual(expect.arrayContaining(["remember", "forget", "recall"]));
    expect(store.read("project", "deploy-by-tag")?.content).toBe("Deploys from main by pushing a v* tag.");
    // Never inside the person's folder.
    expect(fs.readdirSync(root).some((f) => /memory/i.test(f))).toBe(false);
    await runner.destroyWorkspace(ws);
  }, 60_000);

  it("offers no memory tools when there is no memory", async () => {
    const ws = `mem_ws_none_${Date.now()}`;
    const root = path.join(dir, "ws2");
    fs.mkdirSync(root);
    const runner = new LocalSandboxRunner(root);
    await runner.createWorkspace(ws, { storagePath: root });
    const provider = new Remembering();
    await runAgentTurn({ workspaceId: ws, sessionId: "s_nomem", mode: "bypass", userMessage: "hi", sandboxRunner: runner, llmProvider: provider });
    expect(provider.toolNames).not.toContain("remember");
    expect(provider.sawSystem).not.toContain("## MEMORY");
    await runner.destroyWorkspace(ws);
  }, 60_000);
});
