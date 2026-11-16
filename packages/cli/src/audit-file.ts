/**
 * Where the CLI keeps its audit trail.
 *
 * ## Why not the database
 *
 * The orchestrator writes audit records to Postgres, which is right for the
 * hosted product: the trail is evidence, it has to be durable and central, and
 * someone other than the actor must be able to read it.
 *
 * None of that describes a CLI. It runs on one person's machine against their
 * own files, and there is usually no database — but if `DATABASE_URL` happens
 * to be set to something unreachable (a stale `.env`, a stopped container),
 * every tool call emits a Prisma stack trace on stderr and every turn ends
 * with a red *"the trail for this turn is incomplete"*. A session that worked
 * perfectly looks broken, and by the third turn the user has learned to ignore
 * a warning whose entire purpose is that it will not be ignored.
 *
 * So the CLI writes JSONL to a file instead. It is durable, it is private, it
 * is greppable, and — the part that matters — a record written to it genuinely
 * *is* persisted, so the warning stays meaningful and only fires when
 * something has actually gone wrong.
 *
 * ## Shape
 *
 * One JSON object per line, appended. No rotation beyond a size cap, no index,
 * no schema migration. `jq` reads it; so does `grep`. A trail nobody can open
 * without tooling is a trail nobody opens.
 */

import { appendFile, mkdir, stat, rename } from "node:fs/promises";
import { homedir } from "node:os";
import { createHash } from "node:crypto";
import { dirname, join } from "node:path";

/** Past this, the file is rotated once. Roughly a few hundred thousand tool
 *  calls — far more than a workspace accumulates, and small enough that the
 *  file stays openable in an editor. */
const MAX_BYTES = 8 * 1024 * 1024;

export interface AuditRecord {
  workspaceId: string;
  sessionId?: string;
  action: string;
  actorType: string;
  detail: Record<string, unknown>;
}

/** One file per workspace, named by a hash of its path so two projects with
 *  the same basename do not share a trail. */
export function auditPathFor(workspacePath: string): string {
  const digest = createHash("sha256").update(workspacePath).digest("hex").slice(0, 16);
  return join(homedir(), ".soreqen", "audit", `${digest}.jsonl`);
}

/**
 * Append one record.
 *
 * Throws on failure, deliberately: `logAuditEvent` catches it and falls back
 * to stderr, and a sink that swallows its own errors would recreate exactly
 * the silent-failure bug the audit rewrite existed to remove.
 */
export async function appendAuditRecord(
  workspacePath: string,
  record: AuditRecord,
): Promise<void> {
  const path = auditPathFor(workspacePath);
  await mkdir(dirname(path), { recursive: true });

  try {
    const info = await stat(path);
    if (info.size > MAX_BYTES) {
      // One generation kept. Two files of bounded size beat one unbounded file
      // and a deletion policy nobody wrote.
      await rename(path, `${path}.1`);
    }
  } catch {
    // No file yet, which is the normal first-run case.
  }

  const line =
    JSON.stringify({
      at: new Date().toISOString(),
      workspace: workspacePath,
      ...record,
    }) + "\n";

  await appendFile(path, line, { encoding: "utf-8", mode: 0o600 });
}
