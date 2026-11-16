/**
 * Files attached to a prompt typed in the terminal.
 *
 * The desktop app has a paperclip; a terminal has paths. Two ways in:
 *
 *   - `@path` — any file, relative to the workspace or absolute (`~` works).
 *     The explicit form: whatever it names is attached.
 *   - A dropped image — dragging a screenshot onto a terminal types its
 *     absolute path, quoted (Windows Terminal) or with spaces escaped
 *     (macOS). Only pictures are taken from a bare path: an absolute path to
 *     a source file in prose is far more often a reference than an upload.
 *
 * Each file is copied into the workspace's `.soreqen/attachments/` (which
 * the local runner keeps in SoreQen's data folder, not the project), and the
 * message then carries the same `<attachments>` block the app sends, so the
 * agent loop shows pictures to a model that reads them and lists the rest by
 * path. Until 13 Nov 2026 the CLI had no way to send an image at all.
 */

import { existsSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import {
  ATTACHMENT_DIR,
  MAX_ATTACHMENT_BYTES,
  MAX_ATTACHMENTS,
  imageTypeForPath,
  safeFileName,
  withAttachments,
  type Attachment,
} from "@sqcode/shared";

export interface AttachRunner {
  writeBinaryFile?(workspaceId: string, filePath: string, data: Uint8Array): Promise<unknown>;
}

/** What a found path is, before it is copied. */
interface Found {
  /** The text that named it, removed from the message. */
  token: string;
  file: string;
}

const MIME: Record<string, string> = {
  pdf: "application/pdf",
  txt: "text/plain",
  md: "text/markdown",
  json: "application/json",
  csv: "text/csv",
  svg: "image/svg+xml",
  html: "text/html",
  zip: "application/zip",
};

function mimeFor(file: string): string {
  const image = imageTypeForPath(file);
  if (image) return image;
  return MIME[file.split(".").pop()?.toLowerCase() ?? ""] ?? "application/octet-stream";
}

function expand(raw: string, workspace: string): string {
  const unescaped = raw.replace(/\\ /g, " ");
  if (unescaped === "~" || unescaped.startsWith("~/") || unescaped.startsWith("~\\")) {
    return resolve(homedir(), unescaped.slice(2));
  }
  return isAbsolute(unescaped) ? unescaped : resolve(workspace, unescaped);
}

function isFile(path: string): boolean {
  try {
    return existsSync(path) && statSync(path).isFile();
  } catch {
    return false;
  }
}

/*
 * `@` then a quoted path, or a run of non-space characters (a backslash-
 * escaped space included). Preceded by the start or whitespace, so an email
 * address is never read as a mention.
 */
const MENTION = /(^|\s)@(?:"([^"]+)"|'([^']+)'|((?:\\ |[^\s])+))/g;
/* A dropped path: quoted, or bare with escaped spaces. Absolute only. */
const DROPPED = /(^|\s)(?:"((?:[A-Za-z]:[\\/]|\/|~[\\/])[^"]+)"|'((?:[A-Za-z]:[\\/]|\/|~[\\/])[^']+)'|((?:[A-Za-z]:[\\/]|\/|~[\\/])(?:\\ |[^\s])+))/g;

/** The files a prompt names to attach, and the prompt without those names. */
export function findAttachments(text: string, workspace: string): { text: string; files: Found[] } {
  const files: Found[] = [];
  const seen = new Set<string>();
  const take = (token: string, raw: string, onlyImages: boolean): boolean => {
    const file = expand(raw.trim(), workspace);
    if (!isFile(file) || seen.has(file)) return false;
    if (onlyImages && !imageTypeForPath(file)) return false;
    seen.add(file);
    files.push({ token, file });
    return true;
  };
  let out = text.replace(MENTION, (m, lead: string, dq?: string, sq?: string, bare?: string) =>
    take(m, (dq ?? sq ?? bare)!, false) ? lead : m,
  );
  out = out.replace(DROPPED, (m, lead: string, dq?: string, sq?: string, bare?: string) =>
    take(m, (dq ?? sq ?? bare)!, true) ? lead : m,
  );
  return { text: out.replace(/[ \t]{2,}/g, " ").trim(), files };
}

/**
 * Copy what a prompt attaches into the workspace and return the message the
 * agent receives. Files over the size limit, or past the count limit, are
 * skipped and reported in `skipped`, never silently dropped.
 */
export async function attachToPrompt(
  prompt: string,
  options: { workspace: string; workspaceId: string; runner: AttachRunner },
): Promise<{ message: string; attached: Attachment[]; skipped: string[] }> {
  const { text, files } = findAttachments(prompt, options.workspace);
  if (files.length === 0 || typeof options.runner.writeBinaryFile !== "function") {
    return { message: prompt, attached: [], skipped: [] };
  }
  const attached: Attachment[] = [];
  const skipped: string[] = [];
  const folder = `${new Date().toISOString().replace(/[-:]/g, "").replace(/\..+$/, "")}-${randomUUID().slice(0, 4)}`;
  for (const { file } of files) {
    if (attached.length >= MAX_ATTACHMENTS) {
      skipped.push(`${file} (at most ${MAX_ATTACHMENTS} files per message)`);
      continue;
    }
    const size = statSync(file).size;
    if (size === 0 || size > MAX_ATTACHMENT_BYTES) {
      skipped.push(`${file} (${size === 0 ? "empty" : `over ${Math.round(MAX_ATTACHMENT_BYTES / 1024 / 1024)} MB`})`);
      continue;
    }
    const name = safeFileName(file);
    const path = `${ATTACHMENT_DIR}/${folder}/${name}`;
    try {
      await options.runner.writeBinaryFile(options.workspaceId, path, new Uint8Array(readFileSync(file)));
      attached.push({ path, name, mimeType: mimeFor(file).replace(/[(),]/g, ""), sizeBytes: size });
    } catch (err) {
      skipped.push(`${file} (${err instanceof Error ? err.message : String(err)})`);
    }
  }
  if (attached.length === 0) return { message: prompt, attached, skipped };
  return { message: withAttachments(text, attached), attached, skipped };
}
