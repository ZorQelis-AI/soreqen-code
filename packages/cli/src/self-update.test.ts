import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { installer, isNewer, latestVersion, updateNotice, type PackageInfo } from "./self-update.js";

let server: Server;
let published: string | null = "1.4.0";
let asked = 0;
let home: string;

beforeAll(async () => {
  server = createServer((req, res) => {
    asked++;
    if (req.url === "/soreqen-code/latest" && published) {
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ version: published }));
    } else {
      res.writeHead(404).end();
    }
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  process.env["SOREQEN_UPDATE_REGISTRY"] = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});

afterAll(() => {
  server.close();
  delete process.env["SOREQEN_UPDATE_REGISTRY"];
  delete process.env["SOREQEN_HOME"];
});

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "sqc-update-"));
  process.env["SOREQEN_HOME"] = home;
  delete process.env["SOREQEN_NO_UPDATE_CHECK"];
  delete process.env["CI"];
  asked = 0;
});

const pkg = (over: Partial<PackageInfo> = {}): PackageInfo => ({
  name: "soreqen-code",
  version: "1.3.0",
  private: false,
  dir: "/usr/lib/node_modules/soreqen-code",
  ...over,
});

describe("versions", () => {
  it("orders them the way people read them", () => {
    expect(isNewer("1.10.0", "1.9.9")).toBe(true);
    expect(isNewer("1.3.0", "1.3.0")).toBe(false);
    expect(isNewer("1.2.9", "1.3.0")).toBe(false);
    expect(isNewer("1.3.0", "1.3.0-beta.2")).toBe(true);
    expect(isNewer("1.3.0-beta.2", "1.3.0")).toBe(false);
    expect(isNewer("v2.0.0", "1.9.0")).toBe(true);
  });
});

describe("the registry", () => {
  it("reads the published version, and says nothing when it cannot", async () => {
    expect(await latestVersion("soreqen-code")).toBe("1.4.0");
    expect(await latestVersion("not-published")).toBe("unpublished");
  });
});

describe("the notice at startup", () => {
  it("comes from the last check, never from waiting on the network", async () => {
    // First start: nothing known yet, so nothing said — and a check starts.
    expect(updateNotice(pkg())).toBeNull();
    await new Promise((r) => setTimeout(r, 300));
    expect(asked).toBe(1);
    // Next start: the saved answer, and no new check within the day.
    expect(updateNotice(pkg())).toMatch(/1\.4\.0 is available \(you have 1\.3\.0\)/);
    expect(asked).toBe(1);
  });

  it("checks again once the saved answer is a day old", async () => {
    writeFileSync(join(home, "update-check.json"), JSON.stringify({ checkedAt: Date.now() - 25 * 3_600_000, latest: "1.3.0" }));
    expect(updateNotice(pkg())).toBeNull();
    await new Promise((r) => setTimeout(r, 300));
    expect(asked).toBe(1);
  });

  it("says nothing when up to date, switched off, or not a published package", () => {
    writeFileSync(join(home, "update-check.json"), JSON.stringify({ checkedAt: Date.now(), latest: "1.4.0" }));
    expect(updateNotice(pkg({ version: "1.4.0" }))).toBeNull();
    expect(updateNotice(pkg({ private: true }))).toBeNull();
    process.env["SOREQEN_NO_UPDATE_CHECK"] = "1";
    expect(updateNotice(pkg())).toBeNull();
    rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });
});

describe("updating", () => {
  it("uses the tool that installed it", () => {
    expect(installer(pkg())).toEqual({ command: "npm", args: ["install", "-g", "soreqen-code@latest"] });
    expect(installer(pkg({ dir: "C:\\Users\\a\\AppData\\Local\\pnpm\\global\\5\\node_modules\\soreqen-code" }))).toMatchObject({ command: "pnpm" });
    expect(installer(pkg({ dir: "/home/a/.bun/install/global/node_modules/soreqen-code" }))).toMatchObject({ command: "bun" });
  });

  it("sends a source checkout to git instead", () => {
    // This test file's own package: run from the monorepo, with its src/.
    expect(installer(pkg({ dir: join(__dirname, "..") }))).toEqual({ source: true });
  });
});
