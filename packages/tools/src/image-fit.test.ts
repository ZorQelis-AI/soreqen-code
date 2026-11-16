import jpeg from "jpeg-js";
import pngjs from "pngjs";
import { describe, expect, it } from "vitest";
import { MAX_IMAGE_EDGE, MAX_PARTS, fitImageForModel, planParts, resample } from "./image-fit.js";
import { binaryKind } from "./implementations.js";
import { imageDimensions } from "./image-tools.js";

/** A PNG of the given size: horizontal bands, so a cut in the wrong place shows. */
function png(width: number, height: number): Uint8Array {
  const image = new pngjs.PNG({ width, height });
  for (let y = 0; y < height; y++) {
    const shade = Math.floor(y / 100) % 2 === 0 ? 30 : 220;
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      image.data[i] = shade;
      image.data[i + 1] = shade;
      image.data[i + 2] = shade;
      image.data[i + 3] = 255;
    }
  }
  return new Uint8Array(pngjs.PNG.sync.write(image));
}

describe("planParts", () => {
  it("leaves an ordinary picture whole", () => {
    expect(planParts(1920, 1080)).toEqual([{ x: 0, y: 0, width: 1920, height: 1080 }]);
    expect(planParts(1290, 2796)).toHaveLength(1); // a phone screen
  });

  it("cuts a phone's scrolling capture into overlapping parts that cover it", () => {
    const parts = planParts(1290, 12000);
    expect(parts).toHaveLength(MAX_PARTS);
    expect(parts[0]!.y).toBe(0);
    expect(parts.at(-1)!.y + parts.at(-1)!.height).toBe(12000);
    for (let i = 1; i < parts.length; i++) {
      // Each part starts before the previous one ends: no line is lost at a cut.
      expect(parts[i]!.y).toBeLessThan(parts[i - 1]!.y + parts[i - 1]!.height);
      expect(parts[i]!.y).toBeGreaterThan(parts[i - 1]!.y);
    }
  });

  it("cuts a wide strip along its width", () => {
    const parts = planParts(12000, 900);
    expect(parts.length).toBeGreaterThan(1);
    expect(parts.every((p) => p.y === 0 && p.height === 900)).toBe(true);
  });
});

describe("resample", () => {
  it("averages what it covers and puts see-through pixels on white", () => {
    const source = new Uint8Array([0, 0, 0, 255, 255, 255, 255, 255, 0, 0, 0, 0, 0, 0, 0, 0]);
    const out = resample(source, 4, { x: 0, y: 0, width: 4, height: 1 }, 2, 1);
    expect(Array.from(out.slice(0, 4))).toEqual([128, 128, 128, 255]);
    expect(Array.from(out.slice(4, 8))).toEqual([255, 255, 255, 255]);
  });
});

describe("fitImageForModel", () => {
  it("sends a small picture exactly as it was", () => {
    const bytes = png(800, 600);
    const fit = fitImageForModel(bytes, "image/png");
    expect(fit.changed).toBe(false);
    expect(fit.images[0]!.bytes).toBe(bytes);
    expect(fit.note).toBeUndefined();
  });

  it("cuts a picture taller than a provider allows into parts it accepts", () => {
    const fit = fitImageForModel(png(600, 9000), "image/png", { name: "shot.png" });
    expect(fit.changed).toBe(true);
    expect(fit.images.length).toBeGreaterThan(1);
    for (const part of fit.images) {
      expect(part.mediaType).toBe("image/jpeg");
      expect(Math.max(part.width, part.height)).toBeLessThanOrEqual(MAX_IMAGE_EDGE);
      // What was written is a real JPEG of the size it claims.
      expect(imageDimensions(part.bytes, "image/jpeg")).toEqual({ width: part.width, height: part.height });
      expect(jpeg.decode(part.bytes).width).toBe(part.width);
    }
    expect(fit.images.map((p) => p.label)).toEqual(fit.images.map((_, i) => `part ${i + 1} of ${fit.images.length}`));
    expect(fit.note).toContain("shot.png is 600×9000 px");
    expect(fit.note).toContain("top to bottom");
  });

  it("keeps to the parts it is given room for, and never above its own cap", () => {
    expect(fitImageForModel(png(600, 9000), "image/png", { maxParts: 2 }).images).toHaveLength(2);
    expect(fitImageForModel(png(400, 12000), "image/png", { maxParts: 8 }).images).toHaveLength(MAX_PARTS);
  });

  it("says why it cannot show a picture it cannot resize", () => {
    // A WebP header claiming 1290 by 12000 (extended format, sizes stored minus one).
    const webp = new Uint8Array(40);
    webp.set([0x52, 0x49, 0x46, 0x46], 0);
    webp.set([0x57, 0x45, 0x42, 0x50, 0x56, 0x50, 0x38, 0x58], 8);
    const w = 1290 - 1;
    const h = 12000 - 1;
    webp.set([w & 255, (w >> 8) & 255, (w >> 16) & 255, h & 255, (h >> 8) & 255, (h >> 16) & 255], 24);
    expect(imageDimensions(webp, "image/webp")).toEqual({ width: 1290, height: 12000 });

    const fit = fitImageForModel(webp, "image/webp", { name: "long.webp" });
    expect(fit.images).toEqual([]);
    expect(fit.note).toContain("long.webp is 1290×12000 px");
    expect(fit.note).toContain("WebP cannot be resized here");
  });
});

describe("binaryKind", () => {
  it("is null for text", () => {
    expect(binaryKind("export const a = 1;\n", "a.ts")).toBeNull();
  });

  it("says how to open a PDF, an archive and an Office file", () => {
    expect(binaryKind("%PDF-1.7\n%âã", "docs/report.pdf")).toContain("pypdf");
    expect(binaryKind("PK\u0003\u0004\u0014\u0000", "docs.zip")).toContain('tar -xf "docs.zip"');
    expect(binaryKind("PK\u0003\u0004\u0014\u0000", "plan.docx")).toContain("Office document");
    expect(binaryKind("\u0000\u0001\u0002", "blob.bin")).toContain("binary file");
  });
});
