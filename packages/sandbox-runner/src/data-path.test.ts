/**
 * `.soreqen/` kept outside the person's project.
 *
 * SoreQen's checkpoints, task state, saved outputs and scratchpad all live
 * under `.soreqen/`, and in a person's own folder that meant SoreQen made a
 * directory in their project (reported 27 Sep 2026). With a `dataPath` the
 * runner resolves `.soreqen/…` there instead, so none of the code above it
 * had to learn a second path — and what the person writes themselves
 * (`.soreqen/skills`, `mcp.json`, `rules.md`) stays where they put it.
 */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { LocalSandboxRunner, projectDataPath } from "./local-runner.js";

let root: string;
let project: string;
let data: string;
let runner: LocalSandboxRunner;

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), "sq-datapath-"));
  project = join(root, "my-app");
  data = join(root, "home", "projects", "my-app-1234");
  mkdirSync(project, { recursive: true });
  runner = new LocalSandboxRunner(join(root, "workspaces"));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

const open = () => runner.createWorkspace("ws", { storagePath: project, dataPath: data });

describe("a workspace that keeps .soreqen outside the project", () => {
  it("writes and reads SoreQen's own files in the data folder, not the project", async () => {
    await open();
    await runner.writeFile("ws", ".soreqen/state/s1.json", "{}");
    expect(existsSync(join(data, "state", "s1.json"))).toBe(true);
    expect(existsSync(join(project, ".soreqen"))).toBe(false);
    expect((await runner.readFile("ws", ".soreqen/state/s1.json")).content).toBe("{}");
    expect(runner.dataPathOf("ws")).toBe(data);
  });

  it("leaves the files the person writes in the project", async () => {
    await open();
    await runner.writeFile("ws", ".soreqen/skills/house/SKILL.md", "Tabs.");
    await runner.writeFile("ws", ".soreqen/mcp.json", "{}");
    expect(readFileSync(join(project, ".soreqen", "skills", "house", "SKILL.md"), "utf8")).toBe("Tabs.");
    expect(existsSync(join(project, ".soreqen", "mcp.json"))).toBe(true);
    expect(existsSync(join(data, "skills"))).toBe(false);
  });

  it("takes an absolute path inside the data folder, which is how the agent is shown its scratchpad", async () => {
    await open();
    await runner.writeFile("ws", join(data, "scratch", "s1", "try.py"), "print(1)");
    expect(existsSync(join(data, "scratch", "s1", "try.py"))).toBe(true);
    expect((await runner.readFile("ws", ".soreqen/scratch/s1/try.py")).content).toBe("print(1)");
  });

  it("confines each root to itself", async () => {
    await open();
    await expect(runner.writeFile("ws", ".soreqen/../../escape.txt", "x")).rejects.toThrow(/escape/i);
  });

  it("reads and writes a full path elsewhere on the computer, and says it is elsewhere", async () => {
    await open();
    const elsewhere = join(root, "home", "notes", "other.txt");
    mkdirSync(join(root, "home", "notes"), { recursive: true });
    writeFileSync(elsewhere, "from outside");
    expect((await runner.readFile("ws", elsewhere)).content).toBe("from outside");
    expect(runner.isOutsideWorkspace("ws", elsewhere)).toBe(true);
    expect(runner.isOutsideWorkspace("ws", join(project, "src", "a.ts"))).toBe(false);
    expect(runner.isOutsideWorkspace("ws", "src/a.ts")).toBe(false);
  });

  it("lists the data folder under the name it was asked for", async () => {
    await open();
    await runner.writeFile("ws", ".soreqen/artifacts/s1/out.txt", "big");
    const listed = await runner.listDirectory("ws", ".soreqen/artifacts", true);
    expect(listed.map((e) => e.path)).toEqual([".soreqen/artifacts/s1", ".soreqen/artifacts/s1/out.txt"]);
  });

  it("runs a command whose working directory is the scratchpad in the data folder", async () => {
    await open();
    await runner.writeFile("ws", ".soreqen/scratch/s1/README.md", "x");
    const res = await runner.execCommand("ws", { argv: ["node", "-e", "console.log(process.cwd())"], cwd: ".soreqen/scratch/s1" });
    // Compared as real paths: on macOS the temp folder under /var is /private/var, which is what the child reports.
    const real = (p: string) => realpathSync.native(p).toLowerCase();
    expect(real(res.stdout.trim())).toBe(real(join(data, "scratch", "s1")));
  });

  it("starts npx from an argument list, which on Windows is a .cmd launcher", async () => {
    await open();
    // run_tests runs `npx vitest run <filter>` this way; it failed with "spawn npx ENOENT" on Windows.
    const res = await runner.execCommand("ws", { argv: ["npx", "--version"] });
    expect(res.exitCode).toBe(0);
    expect(res.stdout.trim()).toMatch(/^\d+\.\d+\.\d+/);
  }, 30_000);

  it("moves what an older version left in the project, and keeps the person's own", async () => {
    mkdirSync(join(project, ".soreqen", "checkpoints.git"), { recursive: true });
    writeFileSync(join(project, ".soreqen", "checkpoints.git", "HEAD"), "ref: refs/heads/main\n");
    mkdirSync(join(project, ".soreqen", "skills", "house"), { recursive: true });
    writeFileSync(join(project, ".soreqen", "skills", "house", "SKILL.md"), "Tabs.");
    await open();
    expect(readFileSync(join(data, "checkpoints.git", "HEAD"), "utf8")).toMatch(/refs\/heads\/main/);
    expect(existsSync(join(project, ".soreqen", "checkpoints.git"))).toBe(false);
    expect(existsSync(join(project, ".soreqen", "skills", "house", "SKILL.md"))).toBe(true);
  });

  it("removes the project's .soreqen once nothing is left in it", async () => {
    mkdirSync(join(project, ".soreqen", "state"), { recursive: true });
    writeFileSync(join(project, ".soreqen", "state", "old.json"), "{}");
    await open();
    expect(existsSync(join(project, ".soreqen"))).toBe(false);
    expect(existsSync(join(data, "state", "old.json"))).toBe(true);
  });
});

describe("a workspace without a data folder", () => {
  it("keeps .soreqen inside itself, as a sandbox always has", async () => {
    await runner.createWorkspace("ws", { storagePath: project });
    await runner.writeFile("ws", ".soreqen/state/s1.json", "{}");
    expect(existsSync(join(project, ".soreqen", "state", "s1.json"))).toBe(true);
    expect(runner.dataPathOf("ws")).toBeNull();
  });
});

describe("full paths into the project", () => {
  it("reads and writes a full path inside the project as that file, not a copy nested under it", async () => {
    await runner.createWorkspace("ws", { storagePath: project });
    const file = join(project, "src", "a.ts");
    mkdirSync(join(project, "src"), { recursive: true });
    writeFileSync(file, "export const a = 1;\n");

    expect((await runner.readFile("ws", file)).content).toContain("export const a");
    await runner.writeFile("ws", join(project, "src", "b.ts"), "export const b = 2;\n");
    expect(readFileSync(join(project, "src", "b.ts"), "utf8")).toContain("export const b");
    // Before the fix, on Linux and macOS this landed at <project>/<project without its leading slash>/src/b.ts.
    expect(existsSync(join(project, project.replace(/^[A-Za-z]:/, "").replace(/^[\\/]+/, "")))).toBe(false);
  });

  it("takes the project's real path too (macOS shows /var as /private/var)", async () => {
    await runner.createWorkspace("ws", { storagePath: project });
    await runner.writeFile("ws", join(realpathSync.native(project), "real.txt"), "x");
    expect(readFileSync(join(project, "real.txt"), "utf8")).toBe("x");
    expect(runner.isOutsideWorkspace("ws", join(realpathSync.native(project), "real.txt"))).toBe(false);
  });

  it("still reads a path written from the project root, /src/app.ts, as the project's own src", async () => {
    await runner.createWorkspace("ws", { storagePath: project });
    mkdirSync(join(project, "src"), { recursive: true });
    await runner.writeFile("ws", "/src/app.ts", "export {};\n");
    expect(existsSync(join(project, "src", "app.ts"))).toBe(true);
  });
});

describe("where a project's data folder is", () => {
  it("is the same for the same folder, and different for two folders of the same name", () => {
    const a = projectDataPath(join(root, "one", "app"), join(root, "home"));
    expect(projectDataPath(join(root, "one", "app"), join(root, "home"))).toBe(a);
    expect(projectDataPath(join(root, "two", "app"), join(root, "home"))).not.toBe(a);
    expect(a).toMatch(/[\\/]projects[\\/]app-[0-9a-f]{8}$/);
  });
});

describe("a deleted session's data (28 Sep 2026)", () => {
  it("goes with it — its state, its sub-agents' state and its artifacts — and nothing else does", async () => {
    await open();
    await runner.writeFile("ws", ".soreqen/state/sess_a.json", "{}");
    await runner.writeFile("ws", ".soreqen/state/sess_a_sub_sub_1_x.json", "{}");
    await runner.writeFile("ws", ".soreqen/state/sess_ab.json", "{}"); // a longer id sharing the prefix
    await runner.writeFile("ws", ".soreqen/state/_workspace.json", "{}");
    await runner.writeFile("ws", ".soreqen/artifacts/sess_a/run_command-1.txt", "big");
    await runner.writeFile("ws", ".soreqen/artifacts/sess_ab/run_command-2.txt", "big");
    writeFileSync(join(project, "keep.txt"), "mine");

    await runner.removeSessionData("ws", "sess_a");

    expect(existsSync(join(data, "state", "sess_a.json"))).toBe(false);
    expect(existsSync(join(data, "state", "sess_a_sub_sub_1_x.json"))).toBe(false);
    expect(existsSync(join(data, "artifacts", "sess_a"))).toBe(false);
    expect(existsSync(join(data, "state", "sess_ab.json"))).toBe(true);
    expect(existsSync(join(data, "state", "_workspace.json"))).toBe(true);
    expect(existsSync(join(data, "artifacts", "sess_ab", "run_command-2.txt"))).toBe(true);
    expect(readFileSync(join(project, "keep.txt"), "utf8")).toBe("mine");
  });

  it("cannot be pointed outside the data folder by an odd id", async () => {
    await open();
    writeFileSync(join(project, "keep.txt"), "mine");
    await runner.removeSessionData("ws", "../../my-app");
    await runner.removeSessionData("ws", "..");
    expect(readFileSync(join(project, "keep.txt"), "utf8")).toBe("mine");
  });
});
