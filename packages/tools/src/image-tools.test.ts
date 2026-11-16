import { describe, it, expect } from "vitest";
import type { SandboxRunner } from "@sqcode/sandbox-runner";
import { MAX_IMAGE_BYTES, imageDimensions, sniffImageType, toolViewImage } from "./image-tools.js";
import type { ToolExecutionContext } from "./types.js";

/** A real 1×1 PNG, header and all — the sniffer reads bytes, not extensions. */
const PNG_1x1 = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

function runnerWith(files: Record<string, Uint8Array>): SandboxRunner {
  return {
    readBinaryFile: async (_ws: string, path: string) => {
      const found = files[path];
      if (!found) throw new Error(`ENOENT: ${path}`);
      return found;
    },
  } as unknown as SandboxRunner;
}

const ctx = (runner: SandboxRunner): ToolExecutionContext =>
  ({ workspaceId: "ws_1", sandboxRunner: runner }) as ToolExecutionContext;

describe("sniffImageType", () => {
  it("reads the format from the bytes", () => {
    expect(sniffImageType(PNG_1x1)).toBe("image/png");
    expect(sniffImageType(Buffer.from([0xff, 0xd8, 0xff, 0, 0, 0, 0, 0, 0, 0, 0, 0]))).toBe("image/jpeg");
    expect(sniffImageType(Buffer.from("RIFF____WEBPVP8 ", "latin1"))).toBe("image/webp");
  });

  it("is not fooled by an extension", () => {
    // Plain text that happens to be called something.png.
    expect(sniffImageType(Buffer.from("this is not a picture at all", "utf8"))).toBeNull();
  });
});

describe("imageDimensions", () => {
  it("reads a PNG's size from its header", () => {
    expect(imageDimensions(PNG_1x1, "image/png")).toEqual({ width: 1, height: 1 });
  });

  it("returns null rather than guessing when it cannot tell", () => {
    expect(imageDimensions(Buffer.from([1, 2, 3]), "image/png")).toBeNull();
  });
});

describe("view_image", () => {
  it("hands the picture back on the image channel, never in the text result", async () => {
    const result = await toolViewImage({ path: "shot.png" }, ctx(runnerWith({ "shot.png": PNG_1x1 })));

    expect(result.success).toBe(true);
    expect(result.image?.mediaType).toBe("image/png");
    expect(result.image?.base64).toBe(PNG_1x1.toString("base64"));
    expect(result.image?.source).toBe("shot.png");

    /*
     * The load-bearing assertion. Base64 inside `data` is what produced a wall
     * of characters in the transcript, clipped mid-string by the result limit,
     * and the agent concluding it could not see images.
     */
    expect(JSON.stringify(result.data)).not.toContain(PNG_1x1.toString("base64").slice(0, 24));
    expect(result.data).toMatchObject({ path: "shot.png", width: 1, height: 1 });
  });

  it("refuses a file that is not an image, and says what to do instead", async () => {
    const notes = Buffer.from("just some notes\n".repeat(4), "utf8");
    const result = await toolViewImage({ path: "notes.txt" }, ctx(runnerWith({ "notes.txt": notes })));

    expect(result.success).toBe(false);
    expect(result.image).toBeUndefined();
    expect(result.error).toContain("read_file");
  });

  it("names the file and the limit when it is too big", async () => {
    const huge = Buffer.concat([PNG_1x1, Buffer.alloc(MAX_IMAGE_BYTES)]);
    const result = await toolViewImage({ path: "huge.png" }, ctx(runnerWith({ "huge.png": huge })));

    expect(result.success).toBe(false);
    expect(result.error).toContain("huge.png");
    expect(result.error).toContain("Resize or crop it first");
  });

  it("reports a missing file as a failure rather than an empty picture", async () => {
    const result = await toolViewImage({ path: "gone.png" }, ctx(runnerWith({})));
    expect(result.success).toBe(false);
    expect(result.error).toContain("gone.png");
  });

  it("says so when the sandbox cannot read bytes at all", async () => {
    const result = await toolViewImage(
      { path: "a.png" },
      ctx({} as unknown as SandboxRunner),
    );
    expect(result.success).toBe(false);
    expect(result.error).toContain("cannot read binary files");
  });
});
