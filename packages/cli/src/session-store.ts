/**
 * Conversations that survive closing the terminal.
 *
 * ## Why
 *
 * A REPL that forgets everything when you quit is a REPL you cannot walk away
 * from. The common shape of real work — ask the agent something, go read the
 * code it pointed at, come back — was previously impossible: the context was
 * gone and the whole investigation had to be re-run, paying for it again.
 *
 * ## Where, and why not a database
 *
 * One JSON file per workspace under `~/.soreqen/sessions/`. The CLI runs on a
 * developer's laptop against their own repo; a database would be a service to
 * install, run and back up in exchange for storing a few kilobytes that only
 * one process ever reads. The hosted surface persists sessions properly in
 * Postgres — this is deliberately the other thing.
 *
 * Keyed by **workspace path**, not by session id, because the question being
 * answered on startup is "what was I doing *here*". A session id would be
 * correct and useless: nobody remembers one.
 *
 * ## What is not stored
 *
 * Nothing is encrypted, so this file is only as private as the home directory
 * — which is the same trust boundary as the repo it describes. It still holds
 * tool output, which can include file contents, so it is written `0600` and
 * capped: a transcript is a convenience, not an archive.
 */

import type { GoalState } from "@sqcode/shared";
import { mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import type { LLMMessage } from "@sqcode/orchestrator";

export interface StoredSession {
  version: 1;
  workspacePath: string;
  sessionId: string;
  model: string;
  /**
   * How the session was configured when it was last used here.
   *
   * These were not stored, and their absence was reported as a bug in exactly
   * the words that make it one: *"I set Bypass and Extra, closed the terminal,
   * opened it again, and it was back to Auto and Medium."*
   *
   * A conversation was restored and the settings governing it were not, so the
   * session resumed in a mode the user had deliberately left. That is worse
   * than not resuming at all — the transcript makes it look like nothing
   * changed, while the agent is now asking about writes it had been told to
   * make without asking.
   *
   * Optional because a file written by an older build has neither, and a
   * missing value must fall back to the default rather than break the resume.
   */
  mode?: string;
  effort?: string;
  /** The workspace ceiling, and whether it was ever explicitly chosen. A tier
   *  the user never set must not come back as one they did — that is what made
   *  `/mode bypass` silently mean `auto`. */
  tier?: string;
  tierExplicit?: boolean;
  /** How the agent writes its replies. See `output-style.ts`. */
  outputStyle?: string;
  /** When the conversation compacts itself; null or absent is the default. */
  autoCompact?: number | null;
  /** A `/goal` in progress, so it survives a closed terminal (it comes back paused). */
  goal?: GoalState | null;
  updatedAt: string;
  /** What the person actually typed, for the resume summary. Kept separate
   *  because the transcript is mostly tool traffic, and "3 messages" is not a
   *  useful thing to show someone returning after a day. */
  prompts: string[];
  history: LLMMessage[];
}

/** Kept small on purpose. A transcript long enough to matter has already been
 *  compacted by the loop before it reached the model; storing more here would
 *  only slow startup and store more of the user's files on disk. */
const MAX_HISTORY_MESSAGES = 200;
const MAX_PROMPTS = 40;

function storeDir(): string {
  return join(homedir(), ".soreqen", "sessions");
}

/**
 * A stable filename for a workspace.
 *
 * Hashed rather than slugified: paths contain characters that are illegal in
 * filenames on some platform or other, they can exceed the filename limit, and
 * two different projects can slugify to the same name. The path is stored
 * inside the file, so nothing is lost by the name being opaque.
 */
function fileFor(workspacePath: string): string {
  const key = createHash("sha256").update(workspacePath.replace(/\\/g, "/")).digest("hex");
  return join(storeDir(), `${key.slice(0, 16)}.json`);
}

export async function loadSession(workspacePath: string): Promise<StoredSession | null> {
  try {
    const raw = await readFile(fileFor(workspacePath), "utf8");
    const parsed = JSON.parse(raw) as StoredSession;
    // A file from a future or corrupted version is discarded rather than
    // half-read: resuming into a malformed conversation is worse than starting
    // fresh, and the user cannot debug a format they never see.
    if (parsed.version !== 1 || !Array.isArray(parsed.history)) return null;
    return parsed;
  } catch {
    return null;
  }
}

export async function saveSession(session: Omit<StoredSession, "version" | "updatedAt">): Promise<void> {
  const payload: StoredSession = {
    ...session,
    version: 1,
    updatedAt: new Date().toISOString(),
    prompts: session.prompts.slice(-MAX_PROMPTS),
    history: session.history.slice(-MAX_HISTORY_MESSAGES),
  };

  const path = fileFor(session.workspacePath);
  try {
    await mkdir(dirname(path), { recursive: true });
    // 0600: this can contain file contents from the workspace, so it should be
    // no more readable than the source it came from.
    await writeFile(path, JSON.stringify(payload), { encoding: "utf8", mode: 0o600 });
  } catch {
    // Losing a transcript must never take down a working session. The user
    // came here to write code, not to persist a log.
  }
}

export async function clearSession(workspacePath: string): Promise<void> {
  await rm(fileFor(workspacePath), { force: true }).catch(() => undefined);
}

/** "yesterday", "3 hours ago" — a returning user is orienting in time, and an
 *  ISO timestamp makes them do the arithmetic themselves. */
export function describeAge(iso: string): string {
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return "earlier";
  const mins = Math.max(0, Math.round((Date.now() - then) / 60_000));
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  return days === 1 ? "yesterday" : `${days}d ago`;
}
