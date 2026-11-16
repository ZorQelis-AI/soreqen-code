import { describe, it, expect } from "vitest";
import {
  SOREQEN_VERSION,
  PRODUCT_NAME,
  SOREQEN_TOKENS,
  SOREQEN_TOOL_DEFINITIONS,
  ToolNameEnum,
  ReadFileInputSchema,
  EditFileInputSchema,
  WriteFileInputSchema,
  ListDirectoryInputSchema,
  GrepSearchInputSchema,
  RunCommandInputSchema,
  RunTestsInputSchema,
  GitOperationInputSchema,
  InstallPackageInputSchema,
  WebSearchInputSchema,
  UpdateTodoListInputSchema,
  StreamEventSchema,
  InboundMessageSchema,
  WorkspaceSchema,
  SessionSchema,
  MessageSchema,
  AuditLogSchema,
  ConfirmationRequestSchema,
  PermissionTierSchema,
} from "./index.js";

describe("@sqcode/shared", () => {
  describe("Metadata & Tokens", () => {
    it("exports product identity", () => {
      expect(PRODUCT_NAME).toBe("SoreQen Code");
      expect(SOREQEN_VERSION).toBe("0.1.0");
    });

    it("exports SoreQen design tokens matching brand guidelines", () => {
      expect(SOREQEN_TOKENS.brand.void).toBe("#09090B");
      expect(SOREQEN_TOKENS.brand.quantumLime).toBe("#D6FF4B");
      expect(SOREQEN_TOKENS.brand.quantumDeep).toBe("#8EAD25");
      expect(SOREQEN_TOKENS.ui.onAccent).toBe("#09090B");
      expect(SOREQEN_TOKENS.ui.surface).toBe("#111114");
      expect(SOREQEN_TOKENS.type.families.ui).toBe("Anek Latin");
      expect(SOREQEN_TOKENS.type.families.mono).toBe("JetBrains Mono");
      expect(SOREQEN_TOKENS.motion.ui).toBe(160);
    });
  });

  describe("Tool Schemas & Anthropic Definitions", () => {
    it("defines all 35 required tools in SOREQEN_TOOL_DEFINITIONS", () => {
      expect(SOREQEN_TOOL_DEFINITIONS.length).toBe(35);
      const names = SOREQEN_TOOL_DEFINITIONS.map((t) => t.name);
      expect(names).toEqual([
        "read_file",
        "edit_file",
        "write_file",
        "list_directory",
        "grep_search",
        "glob",
        "run_command",
        "process_status",
        "stop_process",
        "update_task_state",
        "use_skill",
        "code_graph",
        "retrieve_context",
        "send_process_input",
        "wait",
        "schedule_wakeup",
        "run_tests",
        "git_operation",
        "install_package",
        "web_search",
        "update_todo_list",
        "browser_open",
        "browser_screenshot",
        "browser_snapshot",
        "browser_interact",
        "browser_batch",
        "browser_console_logs",
        "fetch_url_content",
        "research",
        "find_symbol_definition",
        "find_symbol_references",
        "spawn_subagent",
        "subagent_status",
        "view_image",
        "ask_user",
      ]);
    });

    it("keeps every definition's name inside the tool-name enum", () => {
      /*
       * The two lists drifted apart once already: a definition the model was
       * offered but the dispatcher could not name is a tool that fails only
       * when a model finally reaches for it.
       */
      for (const definition of SOREQEN_TOOL_DEFINITIONS) {
        expect(() => ToolNameEnum.parse(definition.name)).not.toThrow();
      }
    });

    it("validates read_file inputs", () => {
      const valid = ReadFileInputSchema.parse({
        path: "src/index.ts",
        start_line: 1,
        end_line: 50,
      });
      expect(valid.path).toBe("src/index.ts");
      expect(() => ReadFileInputSchema.parse({})).toThrow();
    });

    it("validates edit_file inputs with required uniqueness params", () => {
      const valid = EditFileInputSchema.parse({
        path: "src/app.ts",
        old_str: "const x = 1;",
        new_str: "const x = 2;",
      });
      expect(valid.old_str).toBe("const x = 1;");
      expect(() => EditFileInputSchema.parse({ path: "src/app.ts" })).toThrow();
    });

    it("validates write_file inputs", () => {
      const valid = WriteFileInputSchema.parse({
        path: "src/new.ts",
        content: "export const a = 10;",
      });
      expect(valid.overwrite).toBe(true);
    });

    it("validates list_directory inputs with defaults", () => {
      const valid = ListDirectoryInputSchema.parse({});
      expect(valid.path).toBe(".");
      expect(valid.recursive).toBe(false);
      expect(valid.max_depth).toBe(3);
    });

    it("validates grep_search inputs", () => {
      const valid = GrepSearchInputSchema.parse({
        query: "function handler",
        is_regex: false,
        includes: ["*.ts", "*.tsx"],
      });
      expect(valid.query).toBe("function handler");
      expect(valid.includes).toHaveLength(2);
    });

    it("validates run_command inputs with default timeout", () => {
      const valid = RunCommandInputSchema.parse({
        command: "pnpm test",
      });
      expect(valid.timeout_ms).toBe(600000);
      expect(RunCommandInputSchema.parse({ command: "x", timeout_ms: 7_200_000 }).timeout_ms).toBe(600000);
    });

    it("validates run_tests inputs", () => {
      const valid = RunTestsInputSchema.parse({
        test_filter: "auth",
        framework: "vitest",
      });
      expect(valid.framework).toBe("vitest");
    });

    it("validates git_operation inputs", () => {
      const valid = GitOperationInputSchema.parse({
        operation: "status",
      });
      expect(valid.operation).toBe("status");

      const pushOp = GitOperationInputSchema.parse({
        operation: "push",
        confirmed: true,
      });
      expect(pushOp.confirmed).toBe(true);
    });

    it("validates install_package inputs", () => {
      const valid = InstallPackageInputSchema.parse({
        package_name: "lodash@^4.17.21",
        is_dev: true,
      });
      expect(valid.is_dev).toBe(true);
      expect(valid.package_manager).toBe("auto");
    });

    it("validates web_search inputs", () => {
      const valid = WebSearchInputSchema.parse({
        query: "Fastify websocket documentation",
      });
      expect(valid.max_results).toBe(5);
    });

    it("validates update_todo_list inputs", () => {
      const valid = UpdateTodoListInputSchema.parse({
        items: [
          { id: "1", title: "Read codebase", status: "completed" },
          { id: "2", title: "Apply fix", status: "in_progress" },
          { id: "3", title: "Run tests", status: "pending" },
        ],
      });
      expect(valid.items).toHaveLength(3);
    });
  });

  describe("Event Protocol & Inbound Messages", () => {
    it("validates streaming event payloads", () => {
      const tokenEvent = StreamEventSchema.parse({
        type: "token",
        sessionId: "sess_1",
        delta: "Hello",
      });
      expect(tokenEvent.type).toBe("token");

      const diffEvent = StreamEventSchema.parse({
        type: "diff",
        sessionId: "sess_1",
        path: "src/index.ts",
        unifiedDiff: "--- a\n+++ b",
      });
      expect(diffEvent.type).toBe("diff");

      const confirmEvent = StreamEventSchema.parse({
        type: "confirmation_required",
        sessionId: "sess_1",
        confirmationId: "conf_1",
        action: "git_operation",
        description: "Force push to main",
      });
      expect(confirmEvent.type).toBe("confirmation_required");
    });

    it("validates inbound user messages", () => {
      const sendMsg = InboundMessageSchema.parse({
        action: "send_message",
        sessionId: "sess_1",
        content: "Fix the bug",
      });
      expect(sendMsg.action).toBe("send_message");

      const confirmMsg = InboundMessageSchema.parse({
        action: "confirm",
        sessionId: "sess_1",
        confirmationId: "conf_1",
        approved: true,
      });
      expect(confirmMsg.action).toBe("confirm");
    });
  });

  describe("Data Models", () => {
    it("validates PermissionTier enum", () => {
      expect(PermissionTierSchema.parse("read_only")).toBe("read_only");
      expect(PermissionTierSchema.parse("propose_only")).toBe("propose_only");
      expect(PermissionTierSchema.parse("guarded_autonomy")).toBe("guarded_autonomy");
      expect(PermissionTierSchema.parse("full_autonomy")).toBe("full_autonomy");
      expect(() => PermissionTierSchema.parse("invalid_tier")).toThrow();
    });

    it("validates Workspace schema", () => {
      const ws = WorkspaceSchema.parse({
        id: "ws_123",
        ownerId: "usr_123",
        sourceType: "git",
        repoUrl: "https://github.com/test/repo.git",
        permissionTier: "guarded_autonomy",
        status: "ready",
        createdAt: new Date(),
      });
      expect(ws.id).toBe("ws_123");
    });

    it("validates Session, Message, AuditLog, and ConfirmationRequest schemas", () => {
      const sess = SessionSchema.parse({
        id: "sess_123",
        workspaceId: "ws_123",
        status: "active",
        createdAt: new Date(),
      });
      expect(sess.id).toBe("sess_123");

      const msg = MessageSchema.parse({
        id: "msg_123",
        sessionId: "sess_123",
        role: "assistant",
        content: "I have edited the file.",
        createdAt: new Date(),
      });
      expect(msg.role).toBe("assistant");

      const audit = AuditLogSchema.parse({
        id: "audit_123",
        workspaceId: "ws_123",
        action: "edit_file",
        actorType: "agent",
        detail: { path: "src/app.ts" },
        createdAt: new Date(),
      });
      expect(audit.action).toBe("edit_file");

      const conf = ConfirmationRequestSchema.parse({
        id: "conf_123",
        sessionId: "sess_123",
        toolCallId: "call_123",
        toolName: "git_operation",
        input: { operation: "push" },
        status: "pending",
        createdAt: new Date(),
      });
      expect(conf.toolName).toBe("git_operation");
    });
  });
});
