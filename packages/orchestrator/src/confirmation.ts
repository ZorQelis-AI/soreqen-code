/**
 * SoreQen Confirmation Workflow & Lifecycle Manager
 */

import { logAuditEvent } from "./audit.js";

/**
 * Where pending confirmations are recorded, when anywhere.
 *
 * The gateway records them in its database, so an approval can be matched to
 * the request across a reconnect; the CLI answers them in the terminal and
 * needs no record. Installed by the host, like the audit sink — this package
 * has no database of its own.
 */
export interface ConfirmationStore {
  record(entry: {
    workspaceId: string;
    id: string;
    sessionId: string;
    toolName: string;
    input: Record<string, unknown>;
  }): Promise<void>;
  resolve(entry: { workspaceId: string; id: string; approved: boolean; reason: string }): Promise<void>;
}

let store: ConfirmationStore | null = null;

/** Install the store. Pass `null` to keep confirmations in memory only. Returns the previous one. */
export function setConfirmationStore(next: ConfirmationStore | null): ConfirmationStore | null {
  const previous = store;
  store = next;
  return previous;
}

export interface PendingConfirmationRequest {
  confirmationId: string;
  sessionId: string;
  action: string;
  description: string;
  payload?: Record<string, unknown>;
}

export class ConfirmationManager {
  private resolvers = new Map<string, (approved: boolean) => void>();

  async createRequest(options: {
    sessionId: string;
    workspaceId: string;
    action: string;
    description: string;
    payload?: Record<string, unknown>;
  }): Promise<{ confirmationId: string; awaitApproval: () => Promise<boolean> }> {
    const confirmationId = `conf_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;

    // 1. Record the pending action, where the host keeps them.
    try {
      await store?.record({
        workspaceId: options.workspaceId,
        id: confirmationId,
        sessionId: options.sessionId,
        toolName: options.action,
        input: options.payload ?? {},
      });
    } catch {
      // The approval itself still works; only the record is missing.
    }

    // 2. Prepare awaitable promise
    const approvalPromise = new Promise<boolean>((resolve) => {
      this.resolvers.set(confirmationId, resolve);
    });

    return {
      confirmationId,
      awaitApproval: () => approvalPromise,
    };
  }

  async resolveRequest(options: {
    confirmationId: string;
    workspaceId: string;
    sessionId?: string;
    approved: boolean;
    decidedBy?: string;
    reason?: string;
  }): Promise<boolean> {
    const resolver = this.resolvers.get(options.confirmationId);

    // Update the record, where there is one.
    try {
      await store?.resolve({
        workspaceId: options.workspaceId,
        id: options.confirmationId,
        approved: options.approved,
        reason: options.reason ?? (options.approved ? "Approved by user" : "Denied by user"),
      });
    } catch {
      // The decision still stands; only the record is missing.
    }

    // 5. Log confirmation decision in audit log with user identifier
    await logAuditEvent({
      workspaceId: options.workspaceId,
      sessionId: options.sessionId,
      action: "confirmation_decided",
      actorType: "user",
      detail: {
        confirmationId: options.confirmationId,
        approved: options.approved,
        decidedBy: options.decidedBy ?? "user",
        reason: options.reason,
      },
    });

    if (resolver) {
      resolver(options.approved);
      this.resolvers.delete(options.confirmationId);
      return true;
    }

    return false;
  }
}

export const confirmationManager = new ConfirmationManager();
