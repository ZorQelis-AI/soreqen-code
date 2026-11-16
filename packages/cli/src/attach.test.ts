import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { splitAttachments } from "@sqcode/shared";
import { attachToPrompt, findAttachments } from "./attach.js";

describe("attaching files from the terminal", () => {
  let ws: string;
  let outside: string;
  const written = new Map<string, Uint8Array>();
  const runner = {
    async writeBinaryFile(_id: string, path: string, data: Uint8Array) {
      written.set(path, data);
      return { bytesWritten: data.byteLength, path };
    },
  };

  beforeEach(() => {
    ws = mkdtempSync(join(tmpdir(), "sq-att-ws-"));
    outside = mkdtempSync(join(tmpdir(), "sq-att-out-"));
    mkdirSync(join(ws, "docs"));
    writeFileSync(join(ws, "docs", "spec.md"), "# spec\n");
    writeFileSync(join(outside, "Screen Shot.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    writeFileSync(join(outside, "notes.txt"), "hello");
    written.clear();
  });
  afterEach(() => {
    rmSync(ws, { recursive: true, force: true, maxRetries: 3 });
    rmSync(outside, { recursive: true, force: true, maxRetries: 3 });
  });

  it("takes @mentions of any file, relative to the workspace", () => {
    const r = findAttachments("read @docs/spec.md and fix it", ws);
    expect(r.files.map((f) => f.file)).toEqual([join(ws, "docs", "spec.md")]);
    expect(r.text).toBe("read and fix it");
  });

  it("takes a dropped image path, quoted as Windows Terminal pastes it", () => {
    const png = join(outside, "Screen Shot.png");
    const r = findAttachments(`what is wrong here "${png}"`, ws);
    expect(r.files.map((f) => f.file)).toEqual([png]);
    expect(r.text).toBe("what is wrong here");
  });

  it("leaves a bare path to a non-image alone: that is a reference, not an upload", () => {
    const txt = join(outside, "notes.txt");
    const r = findAttachments(`compare with "${txt}"`, ws);
    expect(r.files).toEqual([]);
  });

  it("never reads an email address or a missing file as a mention", () => {
    const r = findAttachments("mail me@example.com about @does/not/exist.png", ws);
    expect(r.files).toEqual([]);
    expect(r.text).toBe("mail me@example.com about @does/not/exist.png");
  });

  it("copies into .soreqen/attachments and sends the app's attachments block", async () => {
    const png = join(outside, "Screen Shot.png");
    const out = await attachToPrompt(`look "${png}"`, { workspace: ws, workspaceId: "w", runner });
    expect(out.attached).toHaveLength(1);
    const a = out.attached[0]!;
    expect(a.path).toMatch(/^\.soreqen\/attachments\/[^/]+\/Screen-Shot\.png$/);
    expect(a.mimeType).toBe("image/png");
    expect(written.get(a.path)?.byteLength).toBe(4);
    // The agent loop reads the same block the desktop app writes.
    const back = splitAttachments(out.message);
    expect(back.text).toBe("look");
    expect(back.attachments.map((x) => x.path)).toEqual([a.path]);
  });

  it("returns the prompt untouched when nothing is attached", async () => {
    const out = await attachToPrompt("just a question", { workspace: ws, workspaceId: "w", runner });
    expect(out.message).toBe("just a question");
    expect(written.size).toBe(0);
  });

  it("reports an empty file instead of dropping it silently", async () => {
    writeFileSync(join(ws, "empty.png"), "");
    const out = await attachToPrompt("see @empty.png", { workspace: ws, workspaceId: "w", runner });
    expect(out.attached).toEqual([]);
    expect(out.skipped[0]).toMatch(/empty/);
  });
});
