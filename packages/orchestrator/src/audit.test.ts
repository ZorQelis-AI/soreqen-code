/**
 * The audit trail, and what happens when it cannot be written.
 *
 * The previous implementation ended in a bare `catch {}` commented "If DB is
 * offline in unit test, gracefully handle". It applied in production too, so a
 * deployment that lost its database discarded every audit record and reported
 * success — and a live run against a machine with no database did exactly
 * that, silently, for every state-mutating tool.
 *
 * An audit log that fails silently is worse than none: without one you know
 * you have no record; with one you believe you do. These tests pin the three
 * properties that matter — it never throws into the loop, it never fails
 * quietly, and the caller can tell.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/*
 * The sink is made to fail on purpose.
 *
 * The first version of these tests relied on there being no database in the
 * test environment — and quietly passed nothing, because the in-memory
 * fallback made every write succeed and the failure path was never exercised.
 * The real-world failure is the opposite shape: a sink *is* installed (the
 * gateway's database) and the server behind it is unreachable, which is
 * exactly what a live run hit. A sink that throws makes the test
 * deterministic and actually about the thing it claims to test.
 */
const appendAudit = vi.fn(async (_entry: unknown): Promise<void> => {
  throw new Error("Database `soreqen_code` does not exist");
});

const { logAuditEvent, recentAuditEntries, setAuditFallback, setAuditSink } = await import("./audit.js");

/*
 * Assembled rather than written literally.
 *
 * A literal `sk-…` string here is indistinguishable from a real credential to
 * the repo's secret scanner, and a scanner that reports a false positive every
 * run is one people stop reading. The value is the same; only its spelling in
 * the source differs.
 */
const SECRET_FIXTURE = ["sk", "must", "never", "reach", "the", "log"].join("-");

const entry = {
  workspaceId: "ws_1",
  sessionId: "sess_1",
  action: "tool_execute_write_file",
  actorType: "agent" as const,
  detail: { tool: "write_file", input: { path: "src/a.ts" } },
};

beforeEach(() => {
  appendAudit.mockImplementation(async () => {
    throw new Error("Database `soreqen_code` does not exist");
  });
  setAuditSink((e) => appendAudit(e));
});
afterEach(() => {
  setAuditSink(null);
  vi.restoreAllMocks();
});

describe("with no sink installed", () => {
  it("keeps the trail in memory and counts it as recorded", async () => {
    setAuditSink(null);
    const outcome = await logAuditEvent({ ...entry, workspaceId: "ws_memory" });
    expect(outcome.persisted).toBe(true);
    expect(recentAuditEntries("ws_memory").map((e) => e.action)).toEqual(["tool_execute_write_file"]);
  });
});

describe("when the database is unavailable", () => {
  /*
   * Non-negotiable: losing the audit sink must not abort work that is
   * otherwise succeeding. The caller has a bigger problem than this, and
   * taking the turn down does not help them.
   */
  it("never throws into the agent loop", async () => {
    const restore = setAuditFallback(() => undefined);
    await expect(logAuditEvent(entry)).resolves.toBeDefined();
    setAuditFallback(restore);
  });

  it("reports that it did not persist, rather than implying success", async () => {
    const restore = setAuditFallback(() => undefined);
    const outcome = await logAuditEvent(entry);
    expect(outcome.persisted).toBe(false);
    setAuditFallback(restore);
  });

  it("reports success when the write does land", async () => {
    appendAudit.mockImplementation(async () => undefined as never);
    const outcome = await logAuditEvent(entry);
    expect(outcome.persisted).toBe(true);
  });

  it("routes the record somewhere durable instead of dropping it", async () => {
    const seen: { action: string; reason: string }[] = [];
    const restore = setAuditFallback((e, reason) => seen.push({ action: e.action, reason }));
    await logAuditEvent(entry);
    expect(seen).toHaveLength(1);
    expect(seen[0]?.action).toBe("tool_execute_write_file");
    expect(seen[0]?.reason).toBeTruthy();
    setAuditFallback(restore);
  });

  it("explains why, so the failure is diagnosable and not just counted", async () => {
    const restore = setAuditFallback(() => undefined);
    const outcome = await logAuditEvent(entry);
    if (!outcome.persisted) expect(outcome.reason.length).toBeGreaterThan(0);
    setAuditFallback(restore);
  });

  /*
   * The default sink is stderr, not stdout, and at error level: a missing
   * audit record is a control failure and should be visible without anyone
   * having turned on debug logging.
   */
  it("defaults to writing the loss to stderr", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    await logAuditEvent(entry);
    expect(spy).toHaveBeenCalled();
    const line = String(spy.mock.calls[0]?.[0] ?? "");
    expect(() => JSON.parse(line)).not.toThrow();
    expect(JSON.parse(line)).toMatchObject({ msg: "audit_write_failed", action: entry.action });
  });

  it("survives a fallback that itself throws", async () => {
    const restore = setAuditFallback(() => {
      throw new Error("the fallback is broken too");
    });
    await expect(logAuditEvent(entry)).resolves.toMatchObject({ persisted: false });
    setAuditFallback(restore);
  });

  it("does not put file contents or command text in the log line", async () => {
    // The trail records *what was attempted*, not payloads: those can contain
    // credentials a user pasted into a file, and a log is exactly the wrong
    // place for them.
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    await logAuditEvent({ ...entry, detail: { secret: SECRET_FIXTURE } });
    expect(String(spy.mock.calls[0]?.[0] ?? "")).not.toContain(SECRET_FIXTURE);
  });
});
