/**
 * Letting the agent actually look at a picture.
 *
 * ## The failure this replaces
 *
 * There was no way for the model to see an image. A screenshot it took was
 * saved to the scratchpad and described by its path; a file a person attached
 * was copied into the workspace and mentioned by its path. If the model wanted
 * to know what was *in* either one, its only option was `read_file`, which
 * decoded a PNG as UTF-8 and returned a few thousand replacement characters.
 * The model, quite reasonably, concluded it could not see images — and said
 * so, which is how a capability the transport had supported all along came to
 * look like a missing feature.
 *
 * ## What this does
 *
 * Reads the file as bytes, checks it really is a raster image by its magic
 * number rather than by its extension, and hands it back on `ToolResult.image`
 * — the channel the loop turns into a genuine image content block. Nothing
 * base64 ever reaches the text result.
 *
 * ## The limits, and why they are where they are
 *
 * An image costs tokens roughly in proportion to its pixels, and providers
 * reject requests above their own ceiling with an error that names neither the
 * file nor the size. A refusal here is a sentence the model can act on — "the
 * file is 14 MB, resize it first" — where a provider's 400 is a dead end.
 */

import { isImageType, imageTypeForPath } from "@sqcode/shared";
import type { ToolExecutionContext, ToolResult } from "./types.js";

/**
 * Largest image file read for a model.
 *
 * Not what is sent: the loop fits every picture to the provider's limits
 * before it goes (`fitImageForModel`, image-fit.ts), scaling it or cutting a
 * long one into parts. This only bounds what is read and decoded to do that.
 * It was 5 MB, and the limit that actually failed was never bytes but pixels:
 * a 1290 by 12000 phone capture is 2 MB (14 Nov 2026).
 */
export const MAX_IMAGE_BYTES = 30 * 1024 * 1024;

/**
 * The file's real type, from its first bytes.
 *
 * An extension is a claim the file makes about itself; a magic number is
 * evidence. They disagree often enough in a working directory — a `.png` that
 * a download renamed, a `.jpg` that is actually WebP — that trusting the name
 * would send providers files they reject.
 */
export function sniffImageType(bytes: Uint8Array): string | null {
  const b = bytes;
  if (b.length < 12) return null;

  const at = (i: number, ...expect: number[]): boolean =>
    expect.every((value, offset) => b[i + offset] === value);

  if (at(0, 0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)) return "image/png";
  if (at(0, 0xff, 0xd8, 0xff)) return "image/jpeg";
  if (at(0, 0x47, 0x49, 0x46, 0x38)) return "image/gif";
  if (at(0, 0x42, 0x4d)) return "image/bmp";
  // RIFF....WEBP
  if (at(0, 0x52, 0x49, 0x46, 0x46) && at(8, 0x57, 0x45, 0x42, 0x50)) return "image/webp";
  // ....ftyp{avif,avis}
  if (at(4, 0x66, 0x74, 0x79, 0x70)) {
    const brand = String.fromCharCode(b[8]!, b[9]!, b[10]!, b[11]!);
    if (brand === "avif" || brand === "avis") return "image/avif";
  }
  return null;
}

/** Pixel dimensions, where they are cheap to read. Best effort: a caption
 *  saying "1920×1080" helps the model decide whether it is looking at a full
 *  screen or a crop, and no decision depends on having it. */
export function imageDimensions(bytes: Uint8Array, mediaType: string): { width: number; height: number } | null {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  try {
    if (mediaType === "image/png" && bytes.length >= 24) {
      return { width: view.getUint32(16), height: view.getUint32(20) };
    }
    if (mediaType === "image/gif" && bytes.length >= 10) {
      return { width: view.getUint16(6, true), height: view.getUint16(8, true) };
    }
    if (mediaType === "image/webp" && bytes.length >= 30) {
      const chunk = String.fromCharCode(bytes[12]!, bytes[13]!, bytes[14]!, bytes[15]!);
      // Extended: the canvas size, 24 bits each, stored minus one.
      if (chunk === "VP8X") {
        return {
          width: 1 + (bytes[24]! | (bytes[25]! << 8) | (bytes[26]! << 16)),
          height: 1 + (bytes[27]! | (bytes[28]! << 8) | (bytes[29]! << 16)),
        };
      }
      // Lossy: 14 bits each, after the frame's start code.
      if (chunk === "VP8 ") return { width: view.getUint16(26, true) & 0x3fff, height: view.getUint16(28, true) & 0x3fff };
      // Lossless: 14 bits each, packed after the signature byte, stored minus one.
      if (chunk === "VP8L") {
        const bits = view.getUint32(21, true);
        return { width: 1 + (bits & 0x3fff), height: 1 + ((bits >> 14) & 0x3fff) };
      }
    }
    if (mediaType === "image/jpeg") {
      // Walk the segment chain to the first start-of-frame marker.
      let i = 2;
      while (i + 9 < bytes.length) {
        if (bytes[i] !== 0xff) {
          i++;
          continue;
        }
        const marker = bytes[i + 1]!;
        // SOF0..SOF15, excluding the four that are not frame headers.
        if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
          return { height: view.getUint16(i + 5), width: view.getUint16(i + 7) };
        }
        i += 2 + view.getUint16(i + 2);
      }
    }
  } catch {
    // A truncated or unusual file: the caption simply omits the size.
  }
  return null;
}

export interface ViewImageInput {
  path: string;
}

export interface ViewImageData {
  path: string;
  mediaType: string;
  sizeBytes: number;
  width?: number;
  height?: number;
}

/**
 * Read an image from the workspace so the model can look at it.
 *
 * Failures are sentences, not silence: a missing file, a file that is not an
 * image, and a file that is too large each come back saying which of the three
 * happened and what to do instead.
 */
export async function toolViewImage(
  input: ViewImageInput,
  ctx: ToolExecutionContext,
): Promise<ToolResult<ViewImageData>> {
  const path = String(input?.path ?? "").trim();
  if (!path) {
    return { success: false, error: "view_image needs a 'path' to an image file in the workspace." };
  }

  const runner = ctx.sandboxRunner;
  if (typeof runner.readBinaryFile !== "function") {
    return {
      success: false,
      error: "This sandbox cannot read binary files, so images cannot be viewed here.",
    };
  }

  let bytes: Uint8Array;
  try {
    bytes = await runner.readBinaryFile(ctx.workspaceId, path);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { success: false, error: `Could not read '${path}': ${message}` };
  }

  const sniffed = sniffImageType(bytes);
  /*
   * The extension is a fallback, not the answer.
   *
   * Sniffing fails on a format this function does not know rather than on a
   * file that is not an image, so a recognised extension is still worth
   * trying — the provider will reject it if we are wrong, and the message
   * will say so.
   */
  const claimed = imageTypeForPath(path);
  const mediaType = sniffed ?? (claimed && isImageType(claimed) ? claimed : null);

  if (!mediaType) {
    return {
      success: false,
      data: { path, mediaType: "application/octet-stream", sizeBytes: bytes.byteLength },
      error:
        `'${path}' is not an image this tool recognises (PNG, JPEG, GIF, WebP, AVIF or BMP). ` +
        "If it is a text file, read it with read_file instead.",
    };
  }

  if (bytes.byteLength > MAX_IMAGE_BYTES) {
    const mb = (bytes.byteLength / (1024 * 1024)).toFixed(1);
    return {
      success: false,
      data: { path, mediaType, sizeBytes: bytes.byteLength },
      error:
        `'${path}' is ${mb} MB, above the ${MAX_IMAGE_BYTES / (1024 * 1024)} MB limit for a single image. ` +
        "Resize or crop it first: a screenshot scaled to 1600px wide is usually enough to read.",
    };
  }

  const size = imageDimensions(bytes, mediaType);
  return {
    success: true,
    data: {
      path,
      mediaType,
      sizeBytes: bytes.byteLength,
      ...(size ? { width: size.width, height: size.height } : {}),
    },
    image: {
      base64: Buffer.from(bytes).toString("base64"),
      mediaType,
      source: path,
    },
  };
}
