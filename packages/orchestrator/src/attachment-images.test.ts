import { crc32, deflateSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { withAttachments } from "@sqcode/shared";
import type { SandboxRunner } from "@sqcode/sandbox-runner";
import { attachedImages, MAX_INLINE_PARTS } from "./attachment-images.js";

/** A grey PNG of the given size, written by hand: this package has no image library. */
function png(width: number, height: number): Uint8Array {
  const chunk = (type: string, data: Buffer): Buffer => {
    const head = Buffer.alloc(4);
    head.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, "latin1"), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body));
    return Buffer.concat([head, body, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr.set([8, 0, 0, 0, 0], 8); // 8-bit greyscale
  const row = Buffer.alloc(width + 1, 0x80);
  row[0] = 0; // no filter
  const raw = Buffer.concat(Array.from({ length: height }, () => row));
  return new Uint8Array(
    Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      chunk("IHDR", ihdr),
      chunk("IDAT", deflateSync(raw)),
      chunk("IEND", Buffer.alloc(0)),
    ]),
  );
}

function runnerWith(files: Record<string, Uint8Array>): SandboxRunner {
  return {
    readBinaryFile: async (_ws: string, path: string) => {
      const bytes = files[path];
      if (!bytes) throw new Error(`no ${path}`);
      return bytes;
    },
  } as unknown as SandboxRunner;
}

const message = (paths: string[]): string =>
  withAttachments(
    "What does this show?",
    paths.map((path) => ({ path, name: path, mimeType: "image/png", sizeBytes: 1 })),
  );

describe("attachedImages", () => {
  it("sends a long screenshot as parts a provider accepts, with a note saying so (14 Nov 2026)", async () => {
    const runner = runnerWith({ "long.png": png(400, 9000) });
    const blocks = await attachedImages([message(["long.png"])], { runner, workspaceId: "w", model: "claude-opus-5-5" });
    const images = blocks.filter((b) => b.type === "image");
    const texts = blocks.filter((b) => b.type === "text").map((b) => (b as { text: string }).text);

    expect(images.length).toBeGreaterThan(1);
    for (const image of images) expect((image as { media_type?: string }).media_type).toBe("image/jpeg");
    expect(texts[0]).toContain("long.png is 400×9000 px");
    expect(texts).toContain(`long.png, part 1 of ${images.length}`);
  });

  it("sends an ordinary picture untouched", async () => {
    const bytes = png(300, 200);
    const runner = runnerWith({ "a.png": bytes });
    const blocks = await attachedImages([message(["a.png"])], { runner, workspaceId: "w", model: "claude-opus-5-5" });
    expect(blocks).toEqual([{ type: "image", image_data: Buffer.from(bytes).toString("base64"), media_type: "image/png" }]);
  });

  it("never sends more parts than one message carries", async () => {
    const runner = runnerWith({ "a.png": png(400, 9000), "b.png": png(400, 9000), "c.png": png(400, 9000) });
    const blocks = await attachedImages([message(["a.png", "b.png", "c.png"])], { runner, workspaceId: "w", model: "claude-opus-5-5" });
    expect(blocks.filter((b) => b.type === "image").length).toBeLessThanOrEqual(MAX_INLINE_PARTS);
  });

  it("sends nothing to a model that cannot see", async () => {
    const runner = runnerWith({ "a.png": png(300, 200) });
    expect(await attachedImages([message(["a.png"])], { runner, workspaceId: "w", model: "blind-model" })).toEqual([]);
  });
});
