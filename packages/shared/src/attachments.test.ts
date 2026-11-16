import { describe, expect, it } from "vitest";
import { imageTypeForPath, isImageType, safeFileName, splitAttachments, withAttachments } from "./attachments.js";

const shot = { path: ".soreqen/attachments/20260915T101500-a1b2/screen.png", name: "screen.png", mimeType: "image/png", sizeBytes: 182_400 };
const spec = { path: ".soreqen/attachments/20260915T101500-a1b2/spec.pdf", name: "spec.pdf", mimeType: "application/pdf", sizeBytes: 9_120 };

describe("attachments in a message", () => {
  it("round-trips the text and every file", () => {
    const content = withAttachments("Match this design", [shot, spec]);
    expect(content).toContain("saved in the workspace");
    expect(splitAttachments(content)).toEqual({ text: "Match this design", attachments: [shot, spec] });
  });

  it("leaves a message without attachments exactly as it was", () => {
    expect(withAttachments("  hello  ", [])).toBe("hello");
    expect(splitAttachments("Just text <attachments> mentioned in passing")).toEqual({
      text: "Just text <attachments> mentioned in passing",
      attachments: [],
    });
  });

  it("carries files sent with no text", () => {
    expect(splitAttachments(withAttachments("", [shot]))).toEqual({ text: "", attachments: [shot] });
  });
});

describe("safe names", () => {
  it("keeps only the last segment and a conservative alphabet", () => {
    expect(safeFileName("../../etc/passwd")).toBe("passwd");
    expect(safeFileName("C:\\Users\\me\\My Design (final).png")).toBe("My-Design-final-.png");
    expect(safeFileName("...")).toBe("file");
  });

  it("recognises raster images, and not SVG", () => {
    expect(isImageType("image/png")).toBe(true);
    expect(isImageType("image/svg+xml")).toBe(false);
    expect(imageTypeForPath("a/b/photo.JPG")).toBe("image/jpeg");
    expect(imageTypeForPath("icon.svg")).toBeNull();
  });
});
