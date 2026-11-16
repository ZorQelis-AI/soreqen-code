/**
 * SoreQen Code Core Data Model Types and Schemas
 */

import { z } from "zod";

// Permission Tiers
export const PermissionTierSchema = z.enum([
  "read_only",
  "propose_only",
  "guarded_autonomy",
  "full_autonomy",
]);
export type PermissionTier = z.infer<typeof PermissionTierSchema>;

// Workspace Source Type
export const WorkspaceSourceTypeSchema = z.enum(["git", "blank"]);
export type WorkspaceSourceType = z.infer<typeof WorkspaceSourceTypeSchema>;

// Workspace Status
export const WorkspaceStatusSchema = z.enum(["provisioning", "ready", "destroyed", "error"]);
export type WorkspaceStatus = z.infer<typeof WorkspaceStatusSchema>;

// Session Status
export const SessionStatusSchema = z.enum(["active", "blocked", "completed", "failed"]);
export type SessionStatus = z.infer<typeof SessionStatusSchema>;

// Message Role
export const MessageRoleSchema = z.enum(["user", "assistant", "tool", "system"]);
export type MessageRole = z.infer<typeof MessageRoleSchema>;

// Actor Type for Audit Logs
export const ActorTypeSchema = z.enum(["agent", "user", "system"]);
export type ActorType = z.infer<typeof ActorTypeSchema>;

// Confirmation Status
export const ConfirmationStatusSchema = z.enum(["pending", "approved", "denied", "expired"]);
export type ConfirmationStatus = z.infer<typeof ConfirmationStatusSchema>;

// Todo Item Schema
export const TodoItemStatusSchema = z.enum(["pending", "in_progress", "completed", "failed"]);
export type TodoItemStatus = z.infer<typeof TodoItemStatusSchema>;

export const TodoItemSchema = z.object({
  id: z.string(),
  title: z.string(),
  status: TodoItemStatusSchema,
});
export type TodoItem = z.infer<typeof TodoItemSchema>;

// Workspace Interface & Schema
export const WorkspaceSchema = z.object({
  id: z.string(),
  ownerId: z.string(),
  sourceType: WorkspaceSourceTypeSchema,
  repoUrl: z.string().nullable().optional(),
  branch: z.string().nullable().optional(),
  permissionTier: PermissionTierSchema,
  status: WorkspaceStatusSchema,
  config: z.record(z.unknown()).nullable().optional(),
  createdAt: z.date().or(z.string()),
  updatedAt: z.date().or(z.string()).optional(),
});
export type Workspace = z.infer<typeof WorkspaceSchema>;

// Session Interface & Schema
export const SessionSchema = z.object({
  id: z.string(),
  workspaceId: z.string(),
  title: z.string().nullable().optional(),
  status: SessionStatusSchema,
  activeTodo: z.array(TodoItemSchema).nullable().optional(),
  createdAt: z.date().or(z.string()),
  updatedAt: z.date().or(z.string()).optional(),
});
export type Session = z.infer<typeof SessionSchema>;

// Message Interface & Schema
export const MessageSchema = z.object({
  id: z.string(),
  sessionId: z.string(),
  role: MessageRoleSchema,
  content: z.string(),
  toolCalls: z.array(z.record(z.unknown())).nullable().optional(),
  toolCallId: z.string().nullable().optional(),
  createdAt: z.date().or(z.string()),
});
export type Message = z.infer<typeof MessageSchema>;

// Audit Log Interface & Schema
export const AuditLogSchema = z.object({
  id: z.string(),
  workspaceId: z.string(),
  sessionId: z.string().nullable().optional(),
  action: z.string(),
  actorType: ActorTypeSchema,
  detail: z.record(z.unknown()),
  createdAt: z.date().or(z.string()),
});
export type AuditLog = z.infer<typeof AuditLogSchema>;

// Confirmation Request Schema
export const ConfirmationRequestSchema = z.object({
  id: z.string(),
  sessionId: z.string(),
  toolCallId: z.string(),
  toolName: z.string(),
  input: z.record(z.unknown()),
  status: ConfirmationStatusSchema,
  reason: z.string().nullable().optional(),
  createdAt: z.date().or(z.string()),
  resolvedAt: z.date().or(z.string()).nullable().optional(),
});
export type ConfirmationRequest = z.infer<typeof ConfirmationRequestSchema>;
