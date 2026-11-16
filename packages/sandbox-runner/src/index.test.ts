import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  LocalSandboxRunner,
  PathTraversalError,
  guardPath,
  validateCommandSafety,
  SandboxSecurityError,
  getSandboxRunner,
} from "./index.js";

describe("@sqcode/sandbox-runner", () => {
  const testWorkspaceId = `test_ws_${Date.now()}`;
  let runner: LocalSandboxRunner;

  beforeEach(() => {
    runner = new LocalSandboxRunner();
  });

  afterEach(async () => {
    await runner.destroyWorkspace(testWorkspaceId);
  });

  describe("Integration Lifecycle", () => {
    it("provisions a sandbox, writes a file, reads it back, runs command, and tears down", async () => {
      // 1. Provision workspace
      const inspection = await runner.createWorkspace(testWorkspaceId);
      expect(inspection.workspaceId).toBe(testWorkspaceId);
      expect(inspection.status).toBe("active");

      // 2. Write file
      const writeRes = await runner.writeFile(
        testWorkspaceId,
        "src/calculator.ts",
        "export function add(a: number, b: number): number {\n  return a + b;\n}\n",
      );
      expect(writeRes.bytesWritten).toBeGreaterThan(0);
      expect(writeRes.path).toBe("src/calculator.ts");

      // 3. Read file
      const readRes = await runner.readFile(testWorkspaceId, "src/calculator.ts");
      expect(readRes.content).toContain("export function add");
      expect(readRes.totalLines).toBeGreaterThanOrEqual(3);

      // 4. Line slice read
      const sliced = await runner.readFile(testWorkspaceId, "src/calculator.ts", 2, 2);
      expect(sliced.content).toBe("  return a + b;");

      // 5. List directory
      const entries = await runner.listDirectory(testWorkspaceId, "src");
      expect(entries.length).toBeGreaterThanOrEqual(1);
      expect(entries[0]?.name).toBe("calculator.ts");

      // 6. Execute shell command reading file
      const isWindows = process.platform === "win32";
      const cmd = isWindows ? "Get-Content src/calculator.ts" : "cat src/calculator.ts";
      const execRes = await runner.execCommand(testWorkspaceId, {
        command: cmd,
      });
      expect(execRes.exitCode).toBe(0);
      expect(execRes.stdout).toContain("export function add");
      expect(execRes.timedOut).toBe(false);

      // 7. Get diff
      const diff = await runner.getDiff(testWorkspaceId);
      expect(typeof diff).toBe("string");

      // 8. Teardown
      await runner.destroyWorkspace(testWorkspaceId);
      const afterDestroy = await runner.inspectWorkspace(testWorkspaceId);
      expect(afterDestroy).toBeNull();
    });
  });

  describe("Security & Boundary Enforcement", () => {
    it("fails when an operation attempts to escape the workspace root with relative path traversal", async () => {
      await runner.createWorkspace(testWorkspaceId);

      await expect(runner.readFile(testWorkspaceId, "../../package.json")).rejects.toThrow(
        PathTraversalError,
      );

      await expect(
        runner.writeFile(testWorkspaceId, "../../../evil.sh", "echo evil"),
      ).rejects.toThrow(PathTraversalError);
    });

    it("guardPath throws PathTraversalError on illegal directory traversal", () => {
      const root = process.platform === "win32" ? "C:\\sandbox\\ws1" : "/sandbox/ws1";

      expect(() => guardPath(root, "../outside.txt")).toThrow(PathTraversalError);
      expect(() => guardPath(root, "sub/../../outside.txt")).toThrow(PathTraversalError);
    });

    it("validateCommandSafety flags dangerous container/host manipulation commands", () => {
      expect(() => validateCommandSafety("cat /var/run/docker.sock")).toThrow(SandboxSecurityError);
      expect(() => validateCommandSafety("dd if=/dev/zero of=/dev/sda")).toThrow(
        SandboxSecurityError,
      );
    });
  });

  describe("Execution Limits & Timeouts", () => {
    it("terminates long-running commands that exceed the timeout limit", async () => {
      await runner.createWorkspace(testWorkspaceId);

      const isWindows = process.platform === "win32";
      const infiniteCmd = isWindows ? "Start-Sleep -Seconds 5" : "sleep 5";

      const res = await runner.execCommand(testWorkspaceId, {
        command: infiniteCmd,
        timeoutMs: 300,
      });

      expect(res.timedOut).toBe(true);
      expect(res.exitCode).toBe(124);
    });

    it("prevents overwriting files when overwrite is explicitly false", async () => {
      await runner.createWorkspace(testWorkspaceId);
      await runner.writeFile(testWorkspaceId, "locked.txt", "initial content");

      await expect(
        runner.writeFile(testWorkspaceId, "locked.txt", "new content", false),
      ).rejects.toThrow(/already exists and overwrite is false/);
    });

    it("launches background daemon processes without blocking", async () => {
      await runner.createWorkspace(testWorkspaceId);
      const isWindows = process.platform === "win32";
      const daemonCmd = isWindows ? "Start-Sleep -Seconds 10 &" : "sleep 10 &";

      const res = await runner.execCommand(testWorkspaceId, {
        command: daemonCmd,
        isBackground: true,
      });

      expect(res.exitCode).toBe(0);
      expect(res.timedOut).toBe(false);
      expect(res.pid).toBeDefined();
    });
  });

  describe("Factory & Singleton Access", () => {
    it("returns active SandboxRunner via getSandboxRunner", () => {
      const instance = getSandboxRunner();
      expect(instance).toBeDefined();
      expect(typeof instance.createWorkspace).toBe("function");
    });
  });
});
