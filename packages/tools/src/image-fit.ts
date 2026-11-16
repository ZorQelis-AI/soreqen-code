/**
 * Making a picture fit what a model can be shown.
 *
 * ## The failure this replaces
 *
 * A person attached a long screenshot and the turn died (14 Nov 2026):
 *
 *     400 invalid_request_error: messages.0.content.1.image.source.base64.data:
 *     At least one of the image dimensions exceed max allowed size: 8000 pixels
 *
 * Every limit on images here was a limit on bytes. A phone's scrolling
 * capture is 1290 by 12000 pixels and under two megabytes, so it passed every
 * check and failed at the provider, with an error that names neither the file
 * nor what to do about it. `view_image` on a large file and a full-page
 * browser screenshot of a long page had the same hole.
 *
 * ## What "fit" means
 *
 * Not "under 8000 pixels". A provider scales whatever it accepts down to about
 * 1568 pixels on its long edge before the model reads it, so a 1290 by 12000
 * capture scaled to pass the check arrives 169 pixels wide: accepted, and
 * unreadable. A long strip is therefore cut into parts along its length, each
 * with a shape a model can read at a useful scale, a little overlapped so a
 * line split by one cut is whole in the next part.
 *
 * So there are three outcomes:
 *
 *   as it is     within every limit, and not a strip: the bytes are untouched
 *   fitted       scaled, or cut into parts, and written again as JPEG
 *   not shown    over a limit in a format that cannot be decoded here, or too
 *                large to decode: no picture, and a sentence saying why
 *
 * The third matters as much as the second. A picture silently left out is one
 * a model will describe anyway.
 *
 * ## Why pure JavaScript
 *
 * The desktop runtime is one bundled file started by the app on three
 * operating systems; a native image library would need a binary for each.
 * `pngjs` and `jpeg-js` decode the two formats a screenshot is ever in. They
 * are slow next to native code (a second or two for a very large capture),
 * and only run for a picture that could not have been sent at all.
 */

import jpeg from "jpeg-js";
import pngjs from "pngjs";
import { imageDimensions } from "./image-tools.js";

/** A provider's ceiling for either side of an image, in pixels. */
export const MAX_IMAGE_EDGE = 8000;
/**
 * Bytes of one image as sent. A provider's ceiling is 5 MB for the image; this
 * leaves room for the difference between how each one counts it.
 */
export const MAX_SEND_BYTES = 3_500_000;
/** The long edge a fitted picture is scaled to: a little over what a model keeps. */
const TARGET_EDGE = 2000;
/** A picture this many times longer than it is wide (or the reverse) is a strip. */
const STRIP_RATIO = 2.5;
/** A strip shorter than this is read well enough whole. */
const STRIP_MIN_EDGE = 2400;
/** The shape of one part of a strip: this many times longer than it is wide. */
const PART_RATIO = 1.6;
/** Parts one strip is cut into, at most. Each is an image the model reads. */
export const MAX_PARTS = 4;
/** Pixels decoded at most: four bytes each, held in memory at once. */
const MAX_DECODE_PIXELS = 64_000_000;
const JPEG_QUALITY = 88;

export interface FittedImage {
  bytes: Uint8Array;
  mediaType: string;
  width: number;
  height: number;
  /** "part 2 of 4", for a strip that was cut. */
  label?: string;
}

export interface FitResult {
  /** What to send, in order. Empty when the picture cannot be shown. */
  images: FittedImage[];
  /** False when `images` is the one picture, exactly as it was given. */
  changed: boolean;
  /** What was done, or why nothing can be shown: a sentence for the model. */
  note?: string;
}

export interface Region {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * The parts a picture is cut into: one, unless it is a strip.
 *
 * A strip is cut along its long side into parts of a readable shape, each
 * overlapping the one before by a few lines, the last ending exactly at the
 * end of the picture.
 */
export function planParts(width: number, height: number, maxParts = MAX_PARTS): Region[] {
  const tall = height >= width;
  const long = tall ? height : width;
  const short = tall ? width : height;
  const strip = short > 0 && long / short >= STRIP_RATIO && long > STRIP_MIN_EDGE;
  const count = strip ? Math.min(Math.max(1, maxParts), Math.max(2, Math.ceil(long / (short * PART_RATIO)))) : 1;
  if (count === 1) return [{ x: 0, y: 0, width, height }];

  const overlap = Math.round(Math.min(short * 0.05, 120));
  const length = Math.ceil((long + overlap * (count - 1)) / count);
  const parts: Region[] = [];
  for (let i = 0; i < count; i++) {
    const start = i === count - 1 ? long - length : i * (length - overlap);
    parts.push(tall ? { x: 0, y: start, width, height: length } : { x: start, y: 0, width: length, height });
  }
  return parts;
}

/** The size a region is sent at: its own, or scaled so its long edge is the target. */
export function targetSize(region: Region): { width: number; height: number } {
  const scale = Math.min(1, TARGET_EDGE / Math.max(region.width, region.height));
  return { width: Math.max(1, Math.round(region.width * scale)), height: Math.max(1, Math.round(region.height * scale)) };
}

/**
 * A region of an RGBA picture, at a new size, on white.
 *
 * Each pixel of the result is the average of the pixels it covers, which is
 * what keeps small text readable when a screenshot is scaled down: taking the
 * nearest pixel instead drops whole strokes of a letter.
 */
export function resample(source: Uint8Array, sourceWidth: number, region: Region, width: number, height: number): Uint8Array {
  const out = new Uint8Array(width * height * 4);
  const stepX = region.width / width;
  const stepY = region.height / height;
  const endX = region.x + region.width;
  const endY = region.y + region.height;
  for (let dy = 0; dy < height; dy++) {
    const y0 = Math.min(endY - 1, region.y + Math.floor(dy * stepY));
    const y1 = Math.min(endY, Math.max(y0 + 1, region.y + Math.floor((dy + 1) * stepY)));
    for (let dx = 0; dx < width; dx++) {
      const x0 = Math.min(endX - 1, region.x + Math.floor(dx * stepX));
      const x1 = Math.min(endX, Math.max(x0 + 1, region.x + Math.floor((dx + 1) * stepX)));
      let r = 0;
      let g = 0;
      let b = 0;
      for (let y = y0; y < y1; y++) {
        let i = (y * sourceWidth + x0) * 4;
        for (let x = x0; x < x1; x++, i += 4) {
          const alpha = source[i + 3]!;
          if (alpha === 255) {
            r += source[i]!;
            g += source[i + 1]!;
            b += source[i + 2]!;
          } else {
            // A see-through pixel, as it looks on a white page.
            const rest = 255 - alpha;
            r += (source[i]! * alpha + 255 * rest) / 255;
            g += (source[i + 1]! * alpha + 255 * rest) / 255;
            b += (source[i + 2]! * alpha + 255 * rest) / 255;
          }
        }
      }
      const n = (y1 - y0) * (x1 - x0);
      const o = (dy * width + dx) * 4;
      out[o] = Math.round(r / n);
      out[o + 1] = Math.round(g / n);
      out[o + 2] = Math.round(b / n);
      out[o + 3] = 255;
    }
  }
  return out;
}

/** The picture as RGBA, for the two formats decoded here. */
function decode(bytes: Uint8Array, mediaType: string): { width: number; height: number; data: Uint8Array } | null {
  if (mediaType === "image/png") {
    const png = pngjs.PNG.sync.read(Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength));
    return { width: png.width, height: png.height, data: png.data };
  }
  if (mediaType === "image/jpeg") {
    const picture = jpeg.decode(bytes, {
      useTArray: true,
      formatAsRGBA: true,
      tolerantDecoding: true,
      maxResolutionInMP: MAX_DECODE_PIXELS / 1_000_000,
      maxMemoryUsageInMB: 1024,
    });
    return { width: picture.width, height: picture.height, data: picture.data };
  }
  return null;
}

const NAMES: Record<string, string> = {
  "image/webp": "WebP",
  "image/avif": "AVIF",
  "image/gif": "GIF",
  "image/bmp": "BMP",
};

/**
 * One picture, as it can be sent to a model.
 *
 * `name` is how the notes refer to it: a path, or "the screenshot".
 */
export function fitImageForModel(
  bytes: Uint8Array,
  mediaType: string,
  options: { name?: string; maxParts?: number } = {},
): FitResult {
  const name = options.name ?? "The image";
  const asIs: FitResult = { images: [{ bytes, mediaType, width: 0, height: 0 }], changed: false };
  const size = imageDimensions(bytes, mediaType);
  if (size) {
    asIs.images[0]!.width = size.width;
    asIs.images[0]!.height = size.height;
  }

  const tooHeavy = bytes.byteLength > MAX_SEND_BYTES;
  const tooLong = size ? Math.max(size.width, size.height) > MAX_IMAGE_EDGE : false;
  // The caller's room can only lower the cap: every part is an image the model is charged for.
  const parts = size ? planParts(size.width, size.height, Math.min(MAX_PARTS, options.maxParts ?? MAX_PARTS)) : [];
  // Nothing to do: the usual case, and the bytes go out exactly as they came.
  if (!tooHeavy && !tooLong && parts.length <= 1) return asIs;

  const mustChange = tooHeavy || tooLong;
  const dimensions = size ? `${size.width}×${size.height} px` : `${(bytes.byteLength / 1_048_576).toFixed(1)} MB`;
  const cannot = (why: string): FitResult =>
    mustChange
      ? {
          images: [],
          changed: true,
          note:
            `${name} is ${dimensions}${tooHeavy && size ? `, ${(bytes.byteLength / 1_048_576).toFixed(1)} MB` : ""}: ` +
            `more than a model can be shown (${MAX_IMAGE_EDGE} px a side, about ${Math.round(MAX_SEND_BYTES / 1_000_000)} MB), and ${why}. ` +
            "It was not shown to you. Say so if what it shows matters, and ask for a smaller PNG or JPEG, or crop it with a command.",
        }
      : asIs;

  if (mediaType !== "image/png" && mediaType !== "image/jpeg") {
    return cannot(`${NAMES[mediaType] ?? "this format"} cannot be resized here`);
  }
  if (!size || size.width * size.height > MAX_DECODE_PIXELS) {
    return cannot("it is too large to resize here");
  }

  let picture: ReturnType<typeof decode>;
  try {
    picture = decode(bytes, mediaType);
  } catch {
    picture = null;
  }
  if (!picture || picture.width !== size.width || picture.height !== size.height) {
    return cannot("the file could not be decoded");
  }

  const images: FittedImage[] = [];
  for (const [i, region] of parts.entries()) {
    const target = targetSize(region);
    const pixels = resample(picture.data, picture.width, region, target.width, target.height);
    const encoded = jpeg.encode({ data: pixels, width: target.width, height: target.height }, JPEG_QUALITY).data;
    images.push({
      bytes: new Uint8Array(encoded.buffer, encoded.byteOffset, encoded.byteLength),
      mediaType: "image/jpeg",
      width: target.width,
      height: target.height,
      ...(parts.length > 1 ? { label: `part ${i + 1} of ${parts.length}` } : {}),
    });
  }

  const first = images[0]!;
  const tall = size.height >= size.width;
  const note =
    parts.length > 1
      ? `${name} is ${dimensions}, too ${tall ? "tall" : "wide"} to read as one picture: it is shown as ${parts.length} parts, ` +
        `${tall ? "top to bottom" : "left to right"}, each ${first.width}×${first.height} px with a small overlap.`
      : `${name} is ${dimensions}; it is shown scaled to ${first.width}×${first.height} px.`;
  return { images, changed: true, note };
}
