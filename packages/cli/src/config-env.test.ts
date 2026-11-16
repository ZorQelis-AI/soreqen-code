import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { envFileCandidates, fromProjectEnv, loadEnvFiles } from "./config.js";

/*
 * Which `.env` wins (audit, 13 Nov 2026).
 *
 * A bare `dotenv.config()` at import read the project's `.env` whole before
 * the filtering loader ran, and the project's file was read first: a cloned
 * repository could point `OPENAI_BASE_URL` at its own server and receive the
 * person's key, or put its own `OPENAI_API_KEY` in front of theirs. Only temp
 * files are read here; nothing of the person's is touched.
 */
describe("loading .env files", () => {
  let dir: string;
  const VARS = ["OPENAI_API_KEY", "OPENAI_BASE_URL", "SOREQEN_MODELS", "SOREQEN_URL"];

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "sq-env-"));
    for (const v of VARS) {
      vi.stubEnv(v, "");
      delete process.env[v];
    }
    fromProjectEnv.clear();
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    for (const v of VARS) delete process.env[v];
    rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
  });

  it("reads the project's file last", () => {
    const files = envFileCandidates("/some/project");
    expect(files[0]).toMatch(/[\\/]\.soreqen[\\/]\.env$/);
    expect(files[files.length - 1]).toBe(join("/some/project", ".env"));
  });

  it("never lets a project's key replace the person's own", () => {
    const personal = join(dir, "personal.env");
    const project = join(dir, "project.env");
    writeFileSync(personal, "OPENAI_API_KEY=mine\n");
    writeFileSync(project, "OPENAI_API_KEY=theirs\nSOREQEN_MODELS=a,b\n");
    loadEnvFiles(dir, [personal, project]);
    expect(process.env["OPENAI_API_KEY"]).toBe("mine");
    expect(fromProjectEnv.has("OPENAI_API_KEY")).toBe(false);
    // A project may still fill in what the person has not set.
    expect(process.env["SOREQEN_MODELS"]).toBe("a,b");
    expect(fromProjectEnv.has("SOREQEN_MODELS")).toBe(true);
  });

  it("never reads an endpoint address from a project's file", () => {
    const project = join(dir, "project.env");
    writeFileSync(project, "OPENAI_BASE_URL=https://someone-elses-proxy.example\nSOREQEN_URL=https://evil.example\n");
    loadEnvFiles(dir, [project]);
    expect(process.env["OPENAI_BASE_URL"]).toBeUndefined();
    expect(process.env["SOREQEN_URL"]).toBeUndefined();
  });

  it("uses a project's key only when the person has none, and records where it came from", () => {
    const project = join(dir, "project.env");
    writeFileSync(project, "OPENAI_API_KEY=theirs\n");
    loadEnvFiles(dir, [join(dir, "missing.env"), project]);
    expect(process.env["OPENAI_API_KEY"]).toBe("theirs");
    expect(fromProjectEnv.has("OPENAI_API_KEY")).toBe(true);
  });

  it("loads nothing at import", async () => {
    const src = await import("node:fs/promises").then((fs) => fs.readFile(new URL("./config.ts", import.meta.url), "utf8"));
    expect(src).not.toMatch(/^dotenv\.config\(\s*\)/m);
  });
});
