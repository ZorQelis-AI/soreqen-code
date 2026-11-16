/**
 * The record of what the agent did.
 *
 * ## The bug this was written to fix
 *
 * The previous implementation ended in a bare `catch {}` with the comment
 * "If DB is offline in unit test, gracefully handle". That comment describes
 * the intent honestly and the code does something much broader: **every audit
 * write, in every environment, failed silently**. A live run against a machine
 * with no database discarded the entire trail while reporting success.
 *
 * An audit log that fails silently is worse than not having one. Without it
 * you know you have no record. With it you believe you do, and the belief is
 * what makes it dangerous — it is consulted precisely when something has gone
 * wrong and nobody can afford it to be incomplete.
 *
 * ## What it does now
 *
 * Still never throws into the agent loop — an unrecordable action must not
 * abort a turn that is otherwise working, and a caller who lost the database
 * has a bigger problem than this. But failure is now **loud, counted, and
 * reported back**, so the turn can tell its caller "this ran, and the trail is
 * incomplete" instead of quietly implying both are fine.
 */

/*
 * No database here. Where the trail is written is the host's decision: the
 * gateway installs a sink that writes to Postgres, the CLI one that appends to
 * a file in the workspace. This package — the part of SoreQen Code that runs
 * everywhere, and the part that is open source — only defines the seam.
 */

export interface AuditEntryOptions {
  workspaceId: string;
  sessionId?: string;
  action: string;
  actorType: "agent" | "user" | "system";
  detail: Record<string, unknown>;
}

export type AuditOutcome =
  | { persisted: true }
  | { persisted: false; reason: string };

/**
 * Where a failed audit write goes instead.
 *
 * Defaults to stderr as one JSON line, which is the lowest-common-denominator
 * durable sink: it survives in container logs, journald and CI output without
 * any configuration. A deployment that cares can replace it — with a file, a
 * queue, or a second database — and the loop is unaffected.
 */
export type AuditFallback = (entry: AuditEntryOptions, reason: string) => void;

let fallback: AuditFallback = (entry, reason) => {
  // Deliberately `console.error`, not `warn`: a missing audit record is a
  // control failure, and it should be visible at default log levels.
  console.error(
    JSON.stringify({
      level: "error",
      msg: "audit_write_failed",
      reason,
      workspaceId: entry.workspaceId,
      sessionId: entry.sessionId,
      action: entry.action,
      actorType: entry.actorType,
      at: new Date().toISOString(),
    }),
  );
};

/** Replace the fallback sink. Returns the previous one, so a test can restore
 *  it and a caller can chain. */
export function setAuditFallback(next: AuditFallback): AuditFallback {
  const previous = fallback;
  fallback = next;
  return previous;
}

/**
 * Where the trail is written.
 *
 * A hosted deployment writes audit records to Postgres, which is correct: the
 * trail is evidence, it belongs somewhere durable and central, and somebody
 * other than the actor has to be able to read it. The gateway installs that
 * sink at start-up.
 *
 * The CLI is a different situation entirely. It runs on one person's machine,
 * against their own files, usually with no database at all, so it installs a
 * sink that appends to a file in the workspace. Records written to either
 * count as persisted, because they *are*.
 *
 * With no sink installed — a library caller, a test — records are kept in a
 * bounded in-memory trail (`recentAuditEntries`), which is what the old
 * no-database fallback amounted to as well.
 */
export type AuditSink = (entry: AuditEntryOptions) => void | Promise<void>;

/** How many records the in-memory trail keeps. */
const MEMORY_TRAIL = 1_000;
const memoryTrail: (AuditEntryOptions & { at: number })[] = [];

const memorySink: AuditSink = (entry) => {
  memoryTrail.push({ ...entry, at: Date.now() });
  if (memoryTrail.length > MEMORY_TRAIL) memoryTrail.splice(0, memoryTrail.length - MEMORY_TRAIL);
};

let primarySink: AuditSink | null = null;

/** Install a sink. Pass `null` to go back to the in-memory trail. Returns the previous sink. */
export function setAuditSink(next: AuditSink | null): AuditSink | null {
  const previous = primarySink;
  primarySink = next;
  return previous;
}

/** The in-memory trail, newest last — what was recorded while no sink was installed. */
export function recentAuditEntries(workspaceId?: string): (AuditEntryOptions & { at: number })[] {
  return memoryTrail.filter((e) => !workspaceId || e.workspaceId === workspaceId);
}

/**
 * Record one action.
 *
 * Never throws. Returns whether it was persisted, so a caller can count
 * failures rather than assume success.
 */
export async function logAuditEvent(options: AuditEntryOptions): Promise<AuditOutcome> {
  try {
    await (primarySink ?? memorySink)(options);
    return { persisted: true };
  } catch (err: unknown) {
    const reason = err instanceof Error ? err.message : String(err);
    try {
      fallback(options, reason);
    } catch {
      // A fallback that itself throws must not take the turn down with it.
      // At this point there is nowhere left to report to.
    }
    return { persisted: false, reason };
  }
}
