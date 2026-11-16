import { describe, it, expect, beforeEach } from "vitest";
import type { PermissionTier, ToolName } from "@sqcode/shared";
import {
  evaluateToolPermission,
  logAuditEvent,
  confirmationManager,
  recentAuditEntries,
  setConfirmationStore,
  type LLMToolCall,
} from "./index.js";

/** A confirmation store kept in a Map: what the gateway's database does, without one. */
const confirmationRequests = new Map<string, Record<string, unknown>>();
setConfirmationStore({
  async record(entry) {
    confirmationRequests.set(entry.id, { ...entry, status: "pending" });
  },
  async resolve(entry) {
    const row = confirmationRequests.get(entry.id);
    if (row) confirmationRequests.set(entry.id, { ...row, status: entry.approved ? "approved" : "denied", reason: entry.reason });
  },
});

describe("Phase 8 — Permission Matrix & Audit Logging", () => {
  beforeEach(() => {
    confirmationRequests.clear();
  });

  const tools: Array<{ name: ToolName; input: Record<string, unknown> }> = [
    { name: "read_file", input: { path: "src/index.ts" } },
    { name: "edit_file", input: { path: "src/index.ts", old_str: "a", new_str: "b" } },
    { name: "write_file", input: { path: "src/new.ts", content: "export const x = 1;" } },
    { name: "list_directory", input: { path: "." } },
    { name: "grep_search", input: { query: "export" } },
    { name: "run_command", input: { command: "npm test" } },
    { name: "run_tests", input: { framework: "vitest" } },
    { name: "git_operation", input: { operation: "status" } },
    { name: "install_package", input: { package_name: "lodash" } },
    { name: "web_search", input: { query: "Fastify WebSockets" } },
    {
      name: "update_todo_list",
      input: { items: [{ id: "1", title: "Task", status: "completed" }] },
    },
  ];

  const tiers: PermissionTier[] = [
    "read_only",
    "propose_only",
    "guarded_autonomy",
    "full_autonomy",
  ];

  describe("Complete Permission Matrix (4 Tiers × 11 Tools)", () => {
    for (const tier of tiers) {
      describe(`Tier: ${tier}`, () => {
        for (const tool of tools) {
          it(`evaluates ${tool.name} under ${tier}`, () => {
            const toolCall: LLMToolCall = {
              id: `call_${tool.name}_${tier}`,
              name: tool.name,
              input: tool.input,
            };

            const res = evaluateToolPermission(toolCall, tier);

            if (tier === "read_only") {
              const observing = [
                "read_file",
                "list_directory",
                "grep_search",
                "run_tests",
                "web_search",
                "update_todo_list",
              ];
              if (observing.includes(tool.name)) {
                expect(res.allowed).toBe(true);
                expect(res.requiresConfirmation).toBe(false);
              } else {
                /*
                 * Denied outright, not confirmed.
                 *
                 * The previous expectation here was `allowed: true,
                 * requiresConfirmation: true` — it pinned an implementation
                 * that contradicted both `docs/ARCHITECTURE.md` ("Always
                 * denied: all file modifications, all shell commands") and the
                 * system prompt the agent is given ("read_only: ... No writes
                 * of any kind"). A tier is a statement about what cannot
                 * happen; if a confirmation unlocks it, the guarantee is only
                 * as strong as whatever answers the prompt — and an automated
                 * approver removes it entirely.
                 *
                 * It also made read_only byte-for-byte identical to
                 * propose_only, so one of the two tiers meant nothing.
                 */
                expect(res.allowed).toBe(false);
                expect(res.requiresConfirmation).toBe(false);
              }
            } else if ((expect(res.allowed).toBe(true), tier === "propose_only")) {
              const safePropose = [
                "read_file",
                "list_directory",
                "grep_search",
                "run_tests",
                "web_search",
                "update_todo_list",
              ];
              if (safePropose.includes(tool.name)) {
                expect(res.requiresConfirmation).toBe(false);
              } else {
                expect(res.requiresConfirmation).toBe(true);
              }
            } else if (tier === "guarded_autonomy") {
              if (tool.name === "install_package") {
                expect(res.requiresConfirmation).toBe(true);
              } else {
                expect(res.requiresConfirmation).toBe(false);
              }
            } else if (tier === "full_autonomy") {
              expect(res.requiresConfirmation).toBe(false);
            }
          });
        }
      });
    }
  });

  describe("Guarded Specific Operations", () => {
    it("requires confirmation for git push in guarded_autonomy", () => {
      const res = evaluateToolPermission(
        { id: "1", name: "git_operation", input: { operation: "push" } },
        "guarded_autonomy",
      );
      expect(res.allowed).toBe(true);
      expect(res.requiresConfirmation).toBe(true);
      expect(res.reason).toContain("push");
    });

    it("requires confirmation for git force_push even in full_autonomy", () => {
      const res = evaluateToolPermission(
        { id: "2", name: "git_operation", input: { operation: "force_push" } },
        "full_autonomy",
      );
      expect(res.allowed).toBe(true);
      expect(res.requiresConfirmation).toBe(true);
      expect(res.reason).toContain("force-push");
    });

    it("requires confirmation for destructive shell commands in guarded_autonomy", () => {
      const res = evaluateToolPermission(
        { id: "3", name: "run_command", input: { command: "rm -rf build" } },
        "guarded_autonomy",
      );
      expect(res.allowed).toBe(true);
      expect(res.requiresConfirmation).toBe(true);
    });
  });

  describe("Global Hard Denylist Interception", () => {
    it("strictly blocks commands targeting docker.sock", () => {
      const res = evaluateToolPermission(
        {
          id: "4",
          name: "run_command",
          input: {
            command:
              "curl -XPOST --unix-socket /var/run/docker.sock http://localhost/containers/create",
          },
        },
        "full_autonomy",
      );
      expect(res.allowed).toBe(false);
      expect(res.reason).toContain("Hard denylist violation");
    });

    it("strictly blocks commands targeting /proc/sys", () => {
      const res = evaluateToolPermission(
        {
          id: "5",
          name: "run_command",
          input: { command: "echo 1 > /proc/sys/net/ipv4/ip_forward" },
        },
        "full_autonomy",
      );
      expect(res.allowed).toBe(false);
      expect(res.reason).toContain("Hard denylist violation");
    });

    it("strictly blocks rm -rf /", () => {
      const res = evaluateToolPermission(
        { id: "6", name: "run_command", input: { command: "rm -rf / --no-preserve-root" } },
        "full_autonomy",
      );
      expect(res.allowed).toBe(false);
    });
  });

  describe("5-Step Confirmation Workflow & Audit Trail", () => {
    it("creates pending confirmation in DB, resolves decision, and logs to audit trail with user identity", async () => {
      const wsId = "ws_audit_test_123";
      const sessId = "sess_audit_test_123";

      // 1. Create confirmation request
      const { confirmationId, awaitApproval } = await confirmationManager.createRequest({
        workspaceId: wsId,
        sessionId: sessId,
        action: "git_operation",
        description: "Push changes to origin/main",
        payload: { operation: "push", branch: "main" },
      });

      expect(confirmationId).toBeDefined();

      // Check DB row created with 'pending'
      const confRow = confirmationRequests.get(confirmationId);
      expect(confRow).toBeDefined();
      expect(confRow?.["status"]).toBe("pending");

      // 2. Resolve confirmation (User approves)
      const approvalPromise = awaitApproval();
      const resolved = await confirmationManager.resolveRequest({
        confirmationId,
        workspaceId: wsId,
        sessionId: sessId,
        approved: true,
        decidedBy: "user_developer_alice",
        reason: "Changes reviewed and verified",
      });

      expect(resolved).toBe(true);
      const isApproved = await approvalPromise;
      expect(isApproved).toBe(true);

      // Check DB row updated with 'approved'
      const updatedRow = confirmationRequests.get(confirmationId);
      expect(updatedRow?.["status"]).toBe("approved");
      expect(updatedRow?.["reason"]).toContain("Changes reviewed and verified");

      // 3. Verify audit log entry was written
      const auditEntries = recentAuditEntries(wsId) as unknown as Record<string, unknown>[];
      expect(auditEntries.length).toBeGreaterThan(0);
      const decAudit = auditEntries.find((a) => a["action"] === "confirmation_decided");
      expect(decAudit).toBeDefined();
      const detail = decAudit?.["detail"] as Record<string, unknown> | undefined;
      expect(detail?.["decidedBy"]).toBe("user_developer_alice");
      expect(detail?.["approved"]).toBe(true);
    });

    it("verifies immutable audit logging before state-mutating actions", async () => {
      const wsId = "ws_audit_test_456";

      await logAuditEvent({
        workspaceId: wsId,
        sessionId: "sess_456",
        action: "tool_execute_write_file",
        actorType: "agent",
        detail: {
          path: "src/config.ts",
          bytesWritten: 128,
        },
      });

      const auditEntries = recentAuditEntries(wsId) as unknown as Record<string, unknown>[];
      expect(auditEntries.length).toBe(1);
      expect(auditEntries[0]?.["action"]).toBe("tool_execute_write_file");
      expect(auditEntries[0]?.["actorType"]).toBe("agent");
    });
  });
});
