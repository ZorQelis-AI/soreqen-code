/**
 * The code graph (29 Sep 2026): one call for what used to be several reads
 * and searches — who uses a symbol, what it uses, what a change reaches.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { LocalSandboxRunner } from "@sqcode/sandbox-runner";
import { RepoIndex } from "./repo-index.js";
import { fileText, graphOf, impactText, overviewText, searchText, symbolText } from "./code-graph.js";

const FILES: Record<string, string> = {
  "src/store.ts": `export interface Session { id: string }\n\nexport function saveSession(s: Session): void {\n  writeRow(s.id);\n}\n\nfunction writeRow(id: string): void {\n  console.log(id);\n}\n`,
  "src/index.ts": `export { saveSession } from "./store";\n`,
  "src/api.ts": `import {\n  saveSession,\n} from "./index";\n\nexport function handleLogin(user: string) {\n  // saveSession is called below, not here\n  saveSession({ id: user });\n}\n`,
  "src/server.ts": `import { handleLogin } from "./api";\n\nexport function start() {\n  handleLogin("ved");\n}\n`,
  "src/store.test.ts": `import { saveSession } from "./store";\n\nsaveSession({ id: "t" });\n`,
};

let dir: string;
let index: RepoIndex;
const ws = `graph_ws_${Date.now()}`;

beforeAll(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "sqcode_graph_"));
  for (const [f, text] of Object.entries(FILES)) {
    fs.mkdirSync(path.dirname(path.join(dir, f)), { recursive: true });
    fs.writeFileSync(path.join(dir, f), text);
  }
  const runner = new LocalSandboxRunner(dir);
  await runner.createWorkspace(ws, { storagePath: dir });
  index = new RepoIndex(runner, ws);
  await index.refresh(true);
});
afterAll(() => fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));

describe("the code graph", () => {
  it("knows who uses a symbol, through a barrel, and not from its import line or a comment", () => {
    const text = symbolText(index, graphOf(index), "saveSession")!;
    expect(text).toContain("function at src/store.ts:3");
    expect(text).toContain("src/api.ts:7 in handleLogin");
    expect(text).not.toContain("src/api.ts:2");
    expect(text).not.toContain("src/api.ts:6");
    expect(text).toMatch(/Uses \(\d\):[\s\S]*writeRow/);
    expect(text).toContain("src/store.test.ts");
  });

  it("follows a change outward to everything it reaches, with the tests to run", () => {
    const text = impactText(index, graphOf(index), { name: "writeRow" }, 3)!;
    expect(text).toContain("saveSession");
    expect(text).toContain("handleLogin");
    expect(text).toContain("start");
    expect(text).toMatch(/Tests to run[\s\S]*src\/store\.test\.ts/);
  });

  it("describes a file without reading it: declarations with line ranges, imports, importers, tests", () => {
    const text = fileText(index, graphOf(index), "src/store.ts")!;
    expect(text).toMatch(/3-\d+: export function saveSession/);
    expect(text).toContain("Imported by");
    expect(text).toContain("src/store.test.ts");
    expect(overviewText(index, graphOf(index))).toContain("Most depended on");
    expect(searchText(graphOf(index), "sess")).toContain("saveSession");
  });

  it("follows the code as it changes", async () => {
    const before = graphOf(index);
    fs.writeFileSync(path.join(dir, "src/server.ts"), `import { handleLogin } from "./api";\n\nexport function start() {\n  handleLogin("ved");\n}\n\nexport function restart() {\n  start();\n}\n`);
    index.markDirty("src/server.ts");
    await index.refresh(false);
    const after = graphOf(index);
    expect(after).not.toBe(before);
    expect(symbolText(index, after, "start")).toContain("src/server.ts:8 in restart");
  });
});

describe("the graph, riding along with reads and searches", () => {
  it("adds one line to the first read of a source file and to a search for a declared name", async () => {
    const { ContextEngine } = await import("./engine.js");
    const runner = new LocalSandboxRunner(dir);
    const wsId = `${ws}_notes`;
    await runner.createWorkspace(wsId, { storagePath: dir });
    const engine = await ContextEngine.open({ runner, workspaceId: wsId, sessionId: "s1" });
    await engine.index!.refresh(true);

    const read = { id: "r1", name: "read_file", input: { path: "src/store.ts" } };
    const note = await engine.graphNote(read, true);
    expect(note).toMatch(/^\[Code graph\] src\/store\.ts: used by .*src\/api\.ts/);
    expect(note).toContain("tests src/store.test.ts");
    // Once per file per turn.
    expect(await engine.graphNote(read, true)).toBeNull();

    const grep = await engine.graphNote({ id: "g1", name: "grep_search", input: { pattern: "handleLogin" } }, true);
    expect(grep).toMatch(/handleLogin is declared at src\/api\.ts:5 \(function, used from 1 file\)/);
    // Not for text that is not a declared name, nor for a failed call.
    expect(await engine.graphNote({ id: "g2", name: "grep_search", input: { pattern: "TODO: fix" } }, true)).toBeNull();
    expect(await engine.graphNote({ id: "r2", name: "read_file", input: { path: "src/api.ts" } }, false)).toBeNull();

    // An edit says what depends on the file and which tests cover it, once.
    const edit = { id: "e1", name: "edit_file", input: { path: "src/store.ts", old_string: "a", new_string: "b" } };
    const impact = await engine.graphNote(edit, true);
    expect(impact).toMatch(/^\[Code graph\] src\/store\.ts is used by .*src\/api\.ts.*covered by src\/store\.test\.ts/);
    expect(await engine.graphNote(edit, true)).toBeNull();
  });
});
