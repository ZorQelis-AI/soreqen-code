/**
 * Files a person attaches to a message.
 *
 * ## Where they go
 *
 * Into the workspace, under `.soreqen/attachments/`, before the message is
 * sent. The agent works on files: an attachment that existed only inside the
 * conversation could not be opened by any of its tools, copied into a project,
 * or referenced from code. The message then says where each one is.
 *
 * ## How a message carries them
 *
 * As a block at the end of the message text. A message travels several ways —
 * sent to an idle session, queued into a running turn, stored, loaded back
 * after a reload — and a second field would have to be threaded through every
 * one of them. The block rides along with the text instead, and a surface
 * reads it back out with `splitAttachments` to show the files as chips.
 */

import { z } from "zod";

export const AttachmentSchema = z.object({
  /** Relative to the workspace root. */
  path: z.string().min(1).max(500),
  name: z.string().min(1).max(200),
  mimeType: z.string().max(200),
  sizeBytes: z.number().int().nonnegative(),
});
export type Attachment = z.infer<typeof AttachmentSchema>;

export const ATTACHMENT_DIR = ".soreqen/attachments";

/**
 * Where the agent keeps files it made for its own use in a session — notes,
 * screenshots — under `.soreqen/`, which checkpoints and search ignore.
 */
export function scratchpadDirFor(sessionId: string): string {
  return `.soreqen/scratch/${sessionId.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 80) || "session"}`;
}
/**
 * Largest file a message can carry.
 *
 * It was 10 MB, and a 17 MB archive of company documents was refused (14 Nov
 * 2026). An attachment is a file put into the workspace, not something sent to
 * a model whole: the agent opens it with its tools (a PDF's text, an archive's
 * contents), so its size is a question of upload, not of context. The upload
 * is base64 inside JSON, a third larger again, so this stays well short of
 * what a request body should be.
 */
export const MAX_ATTACHMENT_BYTES = 50 * 1024 * 1024;
export const MAX_ATTACHMENTS = 10;

const OPEN = "<attachments>";
const CLOSE = "</attachments>";

/** Raster images a browser can show directly. SVG is deliberately not one:
 *  it is a document that can carry script, and is shown as text instead. */
export function isImageType(mimeType: string): boolean {
  return /^image\/(png|jpe?g|gif|webp|avif|bmp|x-icon|vnd\.microsoft\.icon)$/i.test(mimeType.trim());
}

/** The image type for a path, from its extension, or null. */
export function imageTypeForPath(path: string): string | null {
  const ext = path.split(".").pop()?.toLowerCase() ?? "";
  const types: Record<string, string> = {
    png: "image/png",
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    gif: "image/gif",
    webp: "image/webp",
    avif: "image/avif",
    bmp: "image/bmp",
    ico: "image/x-icon",
  };
  return types[ext] ?? null;
}

/**
 * A file name that is safe as one path segment on every platform.
 *
 * Only the last segment of what was given is kept, so a name cannot climb out
 * of the attachments directory, and anything outside a conservative set of
 * characters becomes a hyphen.
 */
export function safeFileName(name: string): string {
  const base = name.replace(/\\/g, "/").split("/").pop() ?? "";
  const cleaned = base
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^[.-]+/, "")
    .slice(-120);
  return cleaned || "file";
}

/** The message as the agent receives it: the text, then where the files are. */
export function withAttachments(text: string, attachments: readonly Attachment[]): string {
  const body = text.trim();
  if (attachments.length === 0) return body;
  const one = attachments.length === 1;
  const lines = attachments.map(
    (a) => `- ${a.path} (${a.mimeType.replace(/[(),]/g, "") || "application/octet-stream"}, ${a.sizeBytes} bytes)`,
  );
  /*
   * A picture is shown with the message it came with, and only there: a later
   * message carries its path. Said here, so a model asked about it afterwards
   * opens it again instead of answering that it cannot see images.
   */
  const pictures = attachments.some((a) => isImageType(a.mimeType) || imageTypeForPath(a.path) !== null)
    ? " A model that reads images is shown the pictures with this message; to look at one again later, open its path with view_image."
    : "";
  const block = [
    OPEN,
    `The user attached ${one ? "this file" : "these files"}. ${one ? "It is" : "They are"} saved in the workspace:${pictures}`,
    ...lines,
    CLOSE,
  ].join("\n");
  return body ? `${body}\n\n${block}` : block;
}

/** The text a person wrote, and the files attached to it. */
export function splitAttachments(content: string): { text: string; attachments: Attachment[] } {
  const trimmed = content.trimEnd();
  const at = trimmed.lastIndexOf(OPEN);
  if (at === -1 || !trimmed.endsWith(CLOSE)) return { text: content, attachments: [] };

  const attachments: Attachment[] = [];
  for (const line of trimmed.slice(at + OPEN.length, trimmed.length - CLOSE.length).split("\n")) {
    const match = /^- (.+) \(([^(),]*), (\d+) bytes\)$/.exec(line.trim());
    if (!match) continue;
    const path = match[1]!;
    attachments.push({
      path,
      name: path.replace(/\\/g, "/").split("/").pop() ?? path,
      mimeType: match[2]!,
      sizeBytes: Number(match[3]),
    });
  }
  if (attachments.length === 0) return { text: content, attachments: [] };
  return { text: trimmed.slice(0, at).trimEnd(), attachments };
}
