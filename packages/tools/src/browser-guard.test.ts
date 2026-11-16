/**
 * The browser is not a way to read the filesystem.
 *
 * `browser_open` used to resolve a relative path against the *server's*
 * working directory and turn it into a `file://` URL, with no path guard in
 * the module at all. Paired with `evaluate_js`, that is a general read
 * primitive over the whole host: two silently-allowed calls returned the
 * gateway's `.env`, and on the hosted surface, other tenants' workspaces.
 *
 * These cases pin the boundary, including the two ways a boundary drawn on
 * strings gets crossed: `..` and a symlink.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resolveBrowserTarget } from "./browser-tools.js";

describe("resolveBrowserTarget", () => {
  let root: string;
  let outside: string;

  beforeEach(() => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), "sqcode_browser_"));
    root = path.join(base, "workspace");
    outside = path.join(base, "secrets");
    fs.mkdirSync(root, { recursive: true });
    fs.mkdirSync(outside, { recursive: true });
    fs.writeFileSync(path.join(root, "index.html"), "<h1>hi</h1>");
    fs.writeFileSync(path.join(outside, ".env"), "API_KEY=super-secret");
  });

  afterEach(() => {
    try {
      fs.rmSync(path.dirname(root), { recursive: true, force: true });
    } catch {
      // ignore
    }
  });

  it("passes http and https through untouched", async () => {
    expect(await resolveBrowserTarget("https://example.com/x", root)).toBe("https://example.com/x");
    expect(await resolveBrowserTarget("http://example.com", root)).toBe("http://example.com");
  });

  it("expands the localhost shorthand", async () => {
    expect(await resolveBrowserTarget("localhost:3000", root)).toBe("http://localhost:3000");
    expect(await resolveBrowserTarget("127.0.0.1:8080", root)).toBe("http://127.0.0.1:8080");
  });

  it("opens a file inside the workspace, resolved against the workspace", async () => {
    const url = await resolveBrowserTarget("index.html", root);
    expect(url.startsWith("file://")).toBe(true);
    // The native realpath, as the guard resolves it: a Windows CI temp folder is a short name (RUNNER~1) only it expands.
    expect(fileURLToPath(url)).toBe(fs.realpathSync.native(path.join(root, "index.html")));
  });

  it("keeps a query and a fragment on a local file instead of escaping them into its name", async () => {
    const url = await resolveBrowserTarget("index.html?probe=1#top", root);
    expect(url.endsWith("/index.html?probe=1#top")).toBe(true);
    const again = await resolveBrowserTarget(`${url}`, root);
    expect(again.endsWith("/index.html?probe=1#top")).toBe(true);
    await expect(resolveBrowserTarget("../secrets/.env?x=1", root)).rejects.toThrow();
  });

  it("refuses a relative path that climbs out", async () => {
    await expect(resolveBrowserTarget("../secrets/.env", root)).rejects.toThrow(
      /resolves outside the workspace/,
    );
  });

  it("refuses an absolute file:// URL outside the workspace", async () => {
    const url = `file:///${path.join(outside, ".env").replace(/\\/g, "/")}`;
    await expect(resolveBrowserTarget(url, root)).rejects.toThrow(/resolves outside the workspace/);
  });

  it("refuses a symlink inside the workspace that points outside it", async () => {
    const link = path.join(root, "escape");
    try {
      fs.symlinkSync(outside, link, "junction");
    } catch {
      return; // Windows without the privilege: the other cases still hold.
    }
    await expect(resolveBrowserTarget("escape/.env", root)).rejects.toThrow(
      /resolves outside the workspace/,
    );
  });

  it("refuses any local path when there is no workspace to measure against", async () => {
    /*
     * Null is the safe answer, not "anywhere". A runner that cannot say where
     * the workspace is must not be read as permission to open the host.
     */
    await expect(resolveBrowserTarget("index.html", null)).rejects.toThrow(/no workspace/);
  });
});
