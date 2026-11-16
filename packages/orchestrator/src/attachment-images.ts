/**
 * An image you attached is *in* the message, not a file the agent must open.
 *
 * ## Why this exists alongside `view_image`
 *
 * They answer different questions, and the difference is a property of the
 * wire format rather than a design preference.
 *
 * A tool result is a string. `role: "tool"` has no content-block form in the
 * OpenAI chat format, so a tool that takes a screenshot *cannot* hand the
 * picture back through its own result — which is exactly how base64 came to be
 * serialised into text and clipped into garbage. `view_image` therefore works
 * as a *request*: the tool returns metadata, and the loop answers it with a
 * real image block in a following user message. That is the only shape
 * available for a picture the agent discovers mid-turn.
 *
 * An attachment is different: it exists before the message is sent. There is
 * no reason for the agent to spend a round trip asking to see something the
 * person has already handed it, so it simply arrives as part of the message —
 * a text block and one image block per picture. This is the direct path, and
 * it is the one that should carry most images.
 *
 * ## What it refuses to do
 *
 * Every image in a message is re-sent on every request for the rest of the
 * session, because it lives in the history. So the limits here are not about
 * one request; they are about what the conversation costs from now on. Beyond
 * them the file is still listed by path, and `view_image` can open it on
 * demand — deliberately, one at a time.
 */

import {
  imageTypeForPath,
  isImageType,
  modelSupportsVision,
  splitAttachments,
  type Attachment,
} from "@sqcode/shared";
import type { SandboxRunner } from "@sqcode/sandbox-runner";
import { fitImageForModel, sniffImageType } from "@sqcode/tools";
import type { LLMContentBlock } from "./types.js";

/** Pictures sent inline with one message. */
export const MAX_INLINE_IMAGES = 4;
/** Total bytes of them as sent (after fitting), before base64. */
export const MAX_INLINE_IMAGE_BYTES = 8 * 1024 * 1024;
/** Image blocks one message carries: a long screenshot is several parts. */
export const MAX_INLINE_PARTS = 8;

/**
 * The image attachments of a message, in order, up to the count.
 *
 * Not by size: a large picture is fitted before it is sent, so the byte
 * budget applies to what goes, in `attachedImages`. It used to apply here, to
 * the file, and a large screenshot was skipped without a word.
 */
export function inlineImageCandidates(attachments: readonly Attachment[]): Attachment[] {
  const chosen: Attachment[] = [];
  for (const attachment of attachments) {
    if (chosen.length >= MAX_INLINE_IMAGES) break;
    const type = attachment.mimeType && isImageType(attachment.mimeType)
      ? attachment.mimeType
      : imageTypeForPath(attachment.path);
    if (!type || !isImageType(type)) continue;
    chosen.push({ ...attachment, mimeType: type });
  }
  return chosen;
}

/**
 * The user's message, with any attached pictures in it.
 *
 * Returns the original string unchanged when there is nothing to add — no
 * images, a model that cannot read them, or a runner that cannot read bytes —
 * so every caller can use this unconditionally.
 *
 * The text block keeps the attachment listing rather than stripping it: the
 * paths are how the agent edits, moves or re-reads those files, and a picture
 * it can see but not name is less useful than one it can do both with.
 */
export async function withInlineImages(
  message: string,
  options: { runner: SandboxRunner; workspaceId: string; model?: string },
): Promise<string | LLMContentBlock[]> {
  const images = await attachedImages([message], options);
  if (images.length === 0) return message;
  return [{ type: "text", text: message }, ...images];
}

/**
 * The pictures attached to one or more messages, as image blocks, within the
 * limits for one message — or none, for a model that cannot read them.
 *
 * Several because messages sent while a turn runs are delivered together, and
 * each carries its own attachments block. Those were delivered as text alone
 * until 31 Oct 2026, so a screenshot sent to a working session reached the
 * model as a path, and the model said it could not see images.
 */
export async function attachedImages(
  messages: readonly string[],
  options: { runner: SandboxRunner; workspaceId: string; model?: string },
): Promise<LLMContentBlock[]> {
  if (!modelSupportsVision(options.model)) return [];
  if (typeof options.runner.readBinaryFile !== "function") return [];

  const candidates = inlineImageCandidates(messages.flatMap((message) => splitAttachments(message).attachments));
  if (candidates.length === 0) return [];

  const images: LLMContentBlock[] = [];
  let parts = 0;
  let sent = 0;
  for (const attachment of candidates) {
    try {
      const bytes = await options.runner.readBinaryFile(options.workspaceId, attachment.path);
      /*
       * Fitted first. A long screenshot (a phone's scrolling capture is
       * 1290 by 12000 pixels) failed the whole turn at the provider: "At
       * least one of the image dimensions exceed max allowed size: 8000
       * pixels" (14 Nov 2026). The file's own bytes say what it is; a
       * renamed WebP is not sent as a PNG.
       */
      const type = sniffImageType(bytes) ?? attachment.mimeType;
      const room = MAX_INLINE_PARTS - parts;
      if (room <= 0) break;
      const fit = fitImageForModel(bytes, type, { name: attachment.path, maxParts: room });
      const size = fit.images.reduce((n, image) => n + image.bytes.byteLength, 0);
      if (fit.images.length > 0 && sent + size > MAX_INLINE_IMAGE_BYTES) {
        images.push({ type: "text", text: `${attachment.path} was not shown with this message: the pictures before it fill what one message carries. Open it with view_image.` });
        continue;
      }
      if (fit.note) images.push({ type: "text", text: fit.note });
      for (const image of fit.images) {
        if (image.label) images.push({ type: "text", text: `${attachment.path}, ${image.label}` });
        images.push({
          type: "image",
          image_data: Buffer.from(image.bytes).toString("base64"),
          media_type: image.mediaType,
        });
      }
      parts += fit.images.length;
      sent += size;
    } catch {
      /*
       * A file that cannot be read is skipped, not fatal.
       *
       * The message still says where it is, and `view_image` will report the
       * real error if the agent goes looking — which is a better place for it
       * than the start of a turn nobody has begun.
       */
    }
  }

  return images;
}
