/**
 * The seven items from the 24 Sep 2026 audit of the context engine, each held
 * to what it promised.
 */

import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { LocalSandboxRunner } from "@sqcode/sandbox-runner";
import { RepoIndex, loadAliasConfig, parseJsonc, resolveImport, resetIndexes } from "./repo-index.js";
import { retrieve, type RetrievalQuery } from "./retrieval.js";
import { escapeControlsInStrings, parseExtraction } from "./state-checkpoint.js";
import { TaskStateStore, extractConstraints, statePathFor } from "./task-state.js";
import { VectorEmbedder, cosineSignal, promptsFor } from "./vector-embedder.js";
import { WorkspaceKnowledge, renderKnowledge } from "./workspace-knowledge.js";

const ws = `audit_ws_${Date.now()}`;
let dir: string;
let runner: LocalSandboxRunner;

function write(files: Record<string, string>): void {
  for (const [p, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, p)), { recursive: true });
    fs.writeFileSync(path.join(dir, p), content);
  }
}

beforeEach(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "sqc_audit_"));
  runner = new LocalSandboxRunner(dir);
  await runner.createWorkspace(ws, { storagePath: dir });
});

afterEach(async () => {
  resetIndexes();
  await runner.destroyWorkspace(ws);
  fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

const query = (overrides: Partial<RetrievalQuery>): RetrievalQuery => ({
  text: "",
  phase: "debugging",
  focusFiles: [],
  modifiedFiles: [],
  taskFiles: [],
  currentStep: 1,
  inContext: new Map(),
  ...overrides,
});

describe("P0 — path aliases", () => {
  it("reads tsconfig as it is written: comments, trailing commas, and a relative extends", async () => {
    const files: Record<string, string> = {
      "tsconfig.base.json": '{ "compilerOptions": { "baseUrl": ".", /* shared */ "paths": { "@/*": ["src/*"], } } }',
      "tsconfig.json": '// app config\n{ "extends": "./tsconfig.base.json", "compilerOptions": { "strict": true } }',
    };
    const config = await loadAliasConfig("tsconfig.json", async (p) => files[p] ?? null);
    expect(config).toMatchObject({ dir: "", base: "", hasBaseUrl: true, paths: [{ pattern: "@/*", targets: ["src/*"] }] });
    expect(parseJsonc('{"a": "// not a comment", "b": [1,],}')).toEqual({ a: "// not a comment", b: [1] });
  });

  it("resolves @/ imports, baseUrl imports, and uses the nearest config in a monorepo", () => {
    const files = new Set(["src/components/Button.tsx", "src/lib/index.ts", "packages/api/src/db.ts"]);
    const exists = (p: string): boolean => files.has(p);
    const aliases = [
      { dir: "", base: "", hasBaseUrl: true, paths: [{ pattern: "@/*", targets: ["src/*"] }] },
      { dir: "packages/api", base: "packages/api/src", hasBaseUrl: true, paths: [{ pattern: "~/*", targets: ["*"] }] },
    ];
    expect(resolveImport("src/app/page.tsx", "@/components/Button", exists, aliases)).toBe("src/components/Button.tsx");
    expect(resolveImport("src/app/page.tsx", "src/lib", exists, aliases)).toBe("src/lib/index.ts");
    expect(resolveImport("packages/api/src/server.ts", "~/db", exists, aliases)).toBe("packages/api/src/db.ts");
    // A package stays a package.
    expect(resolveImport("src/app/page.tsx", "react", exists, aliases)).toBeNull();
  });

  it("gives an aliased import a real dependency edge in the index", async () => {
    write({
      "tsconfig.json": '{ "compilerOptions": { "paths": { "@/*": ["./src/*"] } } }',
      "src/lib/auth.ts": "export function verifySession(token: string) { return token.length > 0; }\n",
      "src/app/page.tsx": 'import { verifySession } from "@/lib/auth";\nexport default function Page() { return verifySession("x"); }\n',
    });
    const index = new RepoIndex(runner, ws);
    await index.refresh(true);
    expect(index.neighbours("src/lib/auth.ts").importedBy).toContain("src/app/page.tsx");
  });
});

describe("P0 — raw newlines in an extraction", () => {
  it("escapes them inside strings only, and the extraction survives", () => {
    const reply = '{"failures":[{"text":"npm test failed:\n  Expected 2\n  Received 3"}],\n"decisions":[{"text":"keep\tgoing"}]}';
    expect(escapeControlsInStrings('{"a":"x\ny"}\n')).toBe('{"a":"x\\ny"}\n');
    expect(parseExtraction(reply)).toEqual({
      failures: [{ text: "npm test failed:\n  Expected 2\n  Received 3" }],
      decisions: [{ text: "keep\tgoing" }],
    });
  });
});

describe("P1 — state saved without waiting for the loop", () => {
  it("writes a change on its own shortly after, and a burst of changes once", async () => {
    const store = await TaskStateStore.load(runner, ws, "s_flush");
    store.addRequest("Keep the API stable.");
    store.add({ kind: "decision", text: "Wrap the old call", source: { type: "model", ref: "turn" } });
    const file = path.join(dir, statePathFor("s_flush"));
    expect(fs.existsSync(file)).toBe(false);
    await new Promise((r) => setTimeout(r, 2_500));
    const saved = JSON.parse(fs.readFileSync(file, "utf8")) as { entries: { text: string }[] };
    expect(saved.entries.map((e) => e.text)).toEqual(expect.arrayContaining(["Keep the API stable.", "Wrap the old call"]));
    expect(store.isDirty).toBe(false);
  }, 10_000);
});

describe("P1 — constraint vocabulary", () => {
  it("hears the ways people actually state requirements, including in Hinglish", () => {
    const found = extractConstraints(
      "Build the settings page. Keep it to no more than 200 lines. Stick to the existing theme. " +
        "Database mein kuch delete mat karna. Tests zaroor chalana. Can you also add dark mode?",
    );
    expect(found).toEqual(
      expect.arrayContaining([
        "Keep it to no more than 200 lines.",
        "Stick to the existing theme.",
        "Database mein kuch delete mat karna.",
        "Tests zaroor chalana.",
      ]),
    );
    expect(found.some((s) => s.includes("dark mode"))).toBe(false);
  });
});

describe("P2 — a failing test points at itself and at what it tests", () => {
  it("ranks the failing test and the code it imports, with the reason", async () => {
    write({
      "src/cart.ts": "export function totalOf(items: { price: number }[]) { return items.reduce((s, i) => s + i.price, 0); }\n",
      "src/cart.test.ts": 'import { totalOf } from "./cart";\nit("totals", () => { expect(totalOf([{ price: 2 }])).toBe(3); });\n',
      "src/unrelated.ts": "export function formatDate(d: Date) { return d.toISOString(); }\n",
    });
    const index = new RepoIndex(runner, ws);
    await index.refresh(true);
    const result = retrieve(
      index,
      query({
        text: "fix it",
        errorText: " FAIL  src/cart.test.ts > totals\nAssertionError: expected 2 to be 3\n    at src/cart.test.ts:2:45",
      }),
    );
    const byPath = new Map(result.items.map((i) => [i.chunk.path, i]));
    expect(byPath.get("src/cart.test.ts")?.reasons).toContain("in the failing test");
    expect(byPath.get("src/cart.ts")?.reasons.join(" ")).toMatch(/imported by the failing test src\/cart.test.ts/);
    expect(result.items[0]!.chunk.path).not.toBe("src/unrelated.ts");
  });
});

describe("P2 — workspace knowledge", () => {
  it("carries evidenced facts to other sessions, and drops them once their file changes", () => {
    const knowledge = WorkspaceKnowledge.empty();
    const hashes: Record<string, string> = { "src/db.ts": "aaaa" };
    const entries = [
      { id: "e1", kind: "fact" as const, text: "The database listens on 5433", status: "active" as const, source: { type: "file" as const, ref: "src/db.ts" }, createdStep: 1, updatedStep: 1 },
      { id: "e2", kind: "hypothesis" as const, text: "The pool is too small", status: "active" as const, source: { type: "model" as const, ref: "x" }, createdStep: 1, updatedStep: 1 },
      { id: "e3", kind: "decision" as const, text: "Use a wrapper", status: "active" as const, source: { type: "model" as const, ref: "x" }, createdStep: 1, updatedStep: 1 },
    ];
    knowledge.promote("s1", entries, ["src/db.ts"], (p) => hashes[p]);
    expect(knowledge.entries.map((k) => k.text)).toEqual(["The database listens on 5433"]);

    // The session that found it does not need it back; another session gets it.
    expect(knowledge.current("s1", (p) => hashes[p], [])).toHaveLength(0);
    const shown = knowledge.current("s2", (p) => hashes[p], []);
    expect(renderKnowledge(shown, 500)).toContain("The database listens on 5433");

    // The file changed: never shown as if it still held.
    hashes["src/db.ts"] = "bbbb";
    expect(knowledge.current("s2", (p) => hashes[p], [])).toHaveLength(0);
  });
});

describe("P3 — a real embedding model", () => {
  it("phrases queries and documents the way each model family was trained", () => {
    expect(promptsFor("embeddinggemma:300m").query("where is auth")).toBe("task: code retrieval | query: where is auth");
    expect(promptsFor("nomic-embed-text").doc("t", "code")).toBe("search_document: code");
    expect(promptsFor("some-model").query("q")).toBe("q");
  });

  it("scales similarity to the query's own range", () => {
    expect(cosineSignal(0.45, 0.2, 0.45)).toBe(1);
    expect(cosineSignal(0.2, 0.2, 0.45)).toBe(0);
    expect(cosineSignal(0.1, 0.2, 0.45)).toBe(0);
  });

  it("finds code by meaning through an OpenAI-compatible endpoint, and falls back when it is down", async () => {
    write({
      "src/session.ts": "export function verifySession(token: string) { return token.startsWith('sess_'); }\n",
      "src/math.ts": "export function add(a: number, b: number) { return a + b; }\n",
      "src/format.ts": "export function pad(s: string) { return s.padStart(4); }\n",
      "src/color.ts": "export function hex(n: number) { return n.toString(16); }\n",
      "src/sleep.ts": "export function wait(ms: number) { return new Promise((r) => setTimeout(r, ms)); }\n",
      "src/list.ts": "export function last<T>(xs: T[]) { return xs[xs.length - 1]; }\n",
    });
    // A stand-in model: "login"-ish text and session code point the same way; everything else elsewhere.
    const vectorFor = (text: string): number[] => (/login|logged|session/i.test(text) ? [1, 0.1, 0] : [0.05, 1, 0.3]);
    const server = http.createServer((req, res) => {
      let body = "";
      req.on("data", (d) => (body += d));
      req.on("end", () => {
        const input = (JSON.parse(body) as { input: string[] }).input;
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify({ data: input.map((t, index) => ({ index, embedding: vectorFor(t) })) }));
      });
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
    const port = (server.address() as { port: number }).port;
    try {
      const index = new RepoIndex(runner, ws);
      await index.refresh(true);
      const embedder = new VectorEmbedder({ url: `http://127.0.0.1:${port}/v1`, model: "test-embed" });
      const question = "where do we check that someone is logged in";
      await embedder.prepare(question, index);
      expect(embedder.coverage().embedded).toBe(embedder.coverage().total);
      const found = retrieve(index, query({ text: question, phase: "discovery" }), { embedder });
      expect(found.items[0]?.chunk.path).toBe("src/session.ts");
      expect(found.items[0]?.reasons.join(" ")).toMatch(/similar meaning/);
    } finally {
      server.close();
    }

    // Nothing listening: word roots, no error, no wait worth noticing.
    const index = new RepoIndex(runner, ws);
    await index.refresh(true);
    const down = new VectorEmbedder({ url: "http://127.0.0.1:1/v1", model: "test-embed" });
    const began = Date.now();
    await down.prepare("anything", index);
    expect(Date.now() - began).toBeLessThan(10_000);
    expect(() => retrieve(index, query({ text: "session", phase: "discovery" }), { embedder: down })).not.toThrow();
  }, 30_000);
});
