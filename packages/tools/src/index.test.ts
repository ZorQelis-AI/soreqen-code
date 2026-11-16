import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { LocalSandboxRunner } from "@sqcode/sandbox-runner";
import {
  executeTool,
  toolReadFile,
  toolEditFile,
  toolWriteFile,
  toolListDirectory,
  toolGrepSearch,
  toolRunCommand,
  toolRunTests,
  toolGitOperation,
  toolInstallPackage,
  toolWebSearch,
  toolUpdateTodoList,
  ToolExecutionError,
  ToolPermissionError,
  createUnifiedDiff,
  type ToolExecutionContext,
} from "./index.js";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

describe("@sqcode/tools", () => {
  const workspaceId = `tools_test_ws_${Date.now()}`;
  let sandboxRunner: LocalSandboxRunner;
  let ctx: ToolExecutionContext;
  let tempDir: string;

  beforeEach(async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "sqcode_tools_test_"));
    sandboxRunner = new LocalSandboxRunner(tempDir);
    await sandboxRunner.createWorkspace(workspaceId, { storagePath: tempDir });
    await sandboxRunner.execCommand(workspaceId, { command: "git init" });
    ctx = {
      workspaceId,
      sandboxRunner,
    };
  });

  afterEach(async () => {
    await sandboxRunner.destroyWorkspace(workspaceId);
    try {
      fs.rmSync(tempDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    } catch {
      // ignore
    }
  });

  describe("toolEditFile (Uniqueness & Loud Failures)", () => {
    it("successfully edits file when old_str is unique and returns diff", async () => {
      await sandboxRunner.writeFile(
        workspaceId,
        "src/calc.ts",
        "export function add(a: number, b: number) {\n  return a - b;\n}\n",
      );

      const res = await toolEditFile(
        {
          path: "src/calc.ts",
          old_str: "  return a - b;",
          new_str: "  return a + b;",
        },
        ctx,
      );

      expect(res.success).toBe(true);
      expect(res.diff).toContain("+  return a + b;");
      expect(res.diff).toContain("-  return a - b;");

      const readBack = await sandboxRunner.readFile(workspaceId, "src/calc.ts");
      expect(readBack.content).toContain("return a + b;");
    });

    it("says an edit sent a second time is already made, and writes nothing (30 Oct 2026)", async () => {
      // The factory.js session: the same four edits sent three times; the replacements failed as "not found".
      const before =
        "    if (target.t === 'junction') {\n      const ok = this._beltAccepts(target, product, remainder);\n" +
        "      if (ok) target.items[target.items.length - 1].entry = fromDir;\n      return ok;\n    }\n";
      await sandboxRunner.writeFile(workspaceId, "src/sim/factory.js", before);
      const edit = {
        path: "src/sim/factory.js",
        old_str: "      if (ok) target.items[target.items.length - 1].entry = fromDir;",
        new_str:
          "      // entry is the SIDE of the junction the item came through\n" +
          "      if (ok) target.items[target.items.length - 1].entry = (fromDir + 2) % 4;",
      };
      expect((await toolEditFile(edit, ctx)).data?.alreadyApplied).toBeUndefined();
      const after = (await sandboxRunner.readFile(workspaceId, "src/sim/factory.js")).content;

      const again = await toolEditFile(edit, ctx);
      expect(again.success).toBe(true);
      expect(again.data?.alreadyApplied).toBe(true);
      expect(again.data?.note).toMatch(/already has this edit \(new_str is at line 3\)/);
      expect((await sandboxRunner.readFile(workspaceId, "src/sim/factory.js")).content).toBe(after);
    });

    it("does not insert a second copy when an insertion is sent again (30 Oct 2026)", async () => {
      // new_str is old_str with a method added above it, so old_str still matched and the method went in twice.
      await sandboxRunner.writeFile(workspaceId, "src/sim/factory.js", "class Factory {\n  _junctionExit(c, item) {\n    return 0;\n  }\n}\n");
      const edit = {
        path: "src/sim/factory.js",
        old_str: "  _junctionExit(c, item) {",
        new_str: "  junctionExitFor(c, item) { return this._junctionExit(c, item); }\n\n  _junctionExit(c, item) {",
      };
      await toolEditFile(edit, ctx);
      const again = await toolEditFile(edit, ctx);
      expect(again.data?.alreadyApplied).toBe(true);
      const content = (await sandboxRunner.readFile(workspaceId, "src/sim/factory.js")).content;
      expect(content.match(/junctionExitFor\(c, item\) \{/g)).toHaveLength(1);
    });

    it("still fails a missing old_str when new_str is only a short line found elsewhere", async () => {
      await sandboxRunner.writeFile(workspaceId, "src/app.ts", "const port = 3000;\nreturn x;\n");
      await expect(toolEditFile({ path: "src/app.ts", old_str: "return y;", new_str: "return x;" }, ctx)).rejects.toThrow(/not found/i);
    });

    it("fails loudly when old_str is NOT found in the file", async () => {
      await sandboxRunner.writeFile(workspaceId, "src/app.ts", "const port = 3000;\n");

      await expect(
        toolEditFile(
          {
            path: "src/app.ts",
            old_str: "const nonexistent = true;",
            new_str: "const replaced = false;",
          },
          ctx,
        ),
      ).rejects.toThrow(ToolExecutionError);

      await expect(
        toolEditFile(
          {
            path: "src/app.ts",
            old_str: "const nonexistent = true;",
            new_str: "const replaced = false;",
          },
          ctx,
        ),
        // Wording changed when the fallback ladder landed: the message now
        // also reports which looser strategies were tried and names the
        // nearest lines. The contract under test is that it still throws.
      ).rejects.toThrow(/not found/i);
    });

    it("fails loudly when old_str occurs multiple times (ambiguous replacement)", async () => {
      await sandboxRunner.writeFile(
        workspaceId,
        "src/duplicate.ts",
        "console.log('test');\nconsole.log('other');\nconsole.log('test');\n",
      );

      await expect(
        toolEditFile(
          {
            path: "src/duplicate.ts",
            old_str: "console.log('test');",
            new_str: "console.log('updated');",
          },
          ctx,
        ),
      ).rejects.toThrow(ToolExecutionError);

      await expect(
        toolEditFile(
          {
            path: "src/duplicate.ts",
            old_str: "console.log('test');",
            new_str: "console.log('updated');",
          },
          ctx,
        ),
      ).rejects.toThrow(/matches 2 places/);
    });
  });

  describe("toolGitOperation (Tool-Layer Confirmation Checks)", () => {
    it("denies unconfirmed git push with ToolPermissionError", async () => {
      await expect(
        toolGitOperation(
          {
            operation: "push",
            confirmed: false,
          },
          ctx,
        ),
      ).rejects.toThrow(ToolPermissionError);

      await expect(
        toolGitOperation(
          {
            operation: "push",
          },
          ctx,
        ),
      ).rejects.toThrow(/requires an explicit 'confirmed: true'/);
    });

    it("denies unconfirmed git force_push with ToolPermissionError", async () => {
      await expect(
        toolGitOperation(
          {
            operation: "force_push",
          },
          ctx,
        ),
      ).rejects.toThrow(ToolPermissionError);
    });

    it("allows non-destructive operations like status and diff without confirmed flag", async () => {
      const res = await toolGitOperation(
        {
          operation: "status",
        },
        ctx,
      );
      expect(res.success).toBe(true);
      expect(res.data?.operation).toBe("status");
    });
  });

  describe("toolReadFile & toolWriteFile", () => {
    it("writes and reads files with line-range slicing", async () => {
      await toolWriteFile(
        {
          path: "docs/readme.txt",
          content: "Line 1\nLine 2\nLine 3\nLine 4\nLine 5\n",
        },
        ctx,
      );

      const readRes = await toolReadFile(
        {
          path: "docs/readme.txt",
          start_line: 2,
          end_line: 4,
        },
        ctx,
      );

      expect(readRes.success).toBe(true);
      expect(readRes.data?.content).toBe("Line 2\nLine 3\nLine 4");
      expect(readRes.data?.totalLines).toBeGreaterThanOrEqual(5);
    });

    it("throws ToolExecutionError when reading non-existent file", async () => {
      await expect(toolReadFile({ path: "missing.ts" }, ctx)).rejects.toThrow(ToolExecutionError);
    });
  });

  describe("toolListDirectory & toolGrepSearch", () => {
    it("lists workspace directory contents", async () => {
      await toolWriteFile({ path: "a.ts", content: "export const a = 1;" }, ctx);
      await toolWriteFile({ path: "b.ts", content: "export const b = 2;" }, ctx);

      const res = await toolListDirectory({ path: "." }, ctx);
      expect(res.success).toBe(true);
      expect(res.data?.count).toBeGreaterThanOrEqual(2);
    });

    it("executes grep search", async () => {
      await toolWriteFile(
        { path: "src/target.ts", content: "function specialTargetIdentifier() {}" },
        ctx,
      );

      const res = await toolGrepSearch(
        {
          query: "specialTargetIdentifier",
        },
        ctx,
      );
      expect(res.success).toBe(true);
      expect(res.data).toMatch(/^1 match in 1 file\nsrc\/target\.ts\n {2}1: function specialTargetIdentifier\(\) \{\}$/);
    });
  });

  describe("toolRunCommand & toolRunTests", () => {
    it("runs command inside workspace", async () => {
      const isWindows = process.platform === "win32";
      const cmd = isWindows ? "Write-Output 'Hello Tool'" : "echo 'Hello Tool'";

      const res = await toolRunCommand(
        {
          command: cmd,
        },
        ctx,
      );

      expect(res.success).toBe(true);
      // Run as a tracked process, whose output interleaves stdout and stderr
      // the way a terminal shows them.
      expect(res.data?.output).toContain("Hello Tool");
      expect(res.data?.status).toBe("exited");
    });

    it("runs test runner abstraction", async () => {
      const mockRunner: SandboxRunner = {
        ...sandboxRunner,
        execCommand: async () => ({
          exitCode: 0,
          stdout: "✓ 5 tests passed",
          stderr: "",
          durationMs: 45,
          timedOut: false,
        }),
      };

      const res = await toolRunTests(
        {
          framework: "vitest",
          test_filter: "auth",
        },
        { ...ctx, sandboxRunner: mockRunner },
      );
      expect(res.success).toBe(true);
      expect(res.data?.framework).toBe("vitest");
      expect(res.data?.stdout).toContain("5 tests passed");
    });
  });

  describe("toolInstallPackage, toolWebSearch, toolUpdateTodoList", () => {
    it("handles install_package", async () => {
      const mockRunner: SandboxRunner = {
        ...sandboxRunner,
        execCommand: async () => ({
          exitCode: 0,
          stdout: "Packages: +1 lodash",
          stderr: "",
          durationMs: 30,
          timedOut: false,
        }),
      };

      const res = await toolInstallPackage(
        {
          package_name: "lodash",
          is_dev: true,
        },
        { ...ctx, sandboxRunner: mockRunner },
      );
      expect(res.success).toBe(true);
      expect(res.data?.packageName).toBe("lodash");
      expect(res.data?.stdout).toContain("lodash");
    });

    it("returns search results (or graceful error) for web_search", async () => {
      const res = await toolWebSearch(
        {
          query: "Fastify WebSockets",
          max_results: 3,
        },
        ctx,
      );
      // web_search requires real API keys (BRAVE_SEARCH_API_KEY or TAVILY_API_KEY).
      // In CI/test environments without keys, the tool returns success:false with an
      // informative error explaining how to configure keys — this is correct behaviour.
      if (res.success) {
        // Keys were present — validate the result shape
        expect(Array.isArray(res.data?.results)).toBe(true);
        expect(res.data!.results.length).toBeGreaterThan(0);
        expect(res.data!.results[0]).toHaveProperty("title");
        expect(res.data!.results[0]).toHaveProperty("url");
        expect(res.data!.results[0]).toHaveProperty("snippet");
      } else {
        // No keys configured — validate the error message is actionable
        expect(res.error).toBeDefined();
        expect(res.error).toContain("BRAVE_SEARCH_API_KEY");
        expect(res.data?.query).toBe("Fastify WebSockets");
      }
    });

    it("updates and summarizes todo checklist", async () => {
      const res = await toolUpdateTodoList(
        {
          items: [
            { id: "1", title: "Plan", status: "completed" },
            { id: "2", title: "Execute", status: "in_progress" },
            { id: "3", title: "Test", status: "pending" },
          ],
        },
        ctx,
      );
      expect(res.success).toBe(true);
      expect(res.data?.completed).toBe(1);
      expect(res.data?.total).toBe(3);
    });
  });

  describe("executeTool Dispatcher", () => {
    it("dispatches known tool names correctly", async () => {
      const res = await executeTool(
        "update_todo_list",
        {
          items: [{ id: "1", title: "Step 1", status: "completed" }],
        },
        ctx,
      );
      expect(res.success).toBe(true);
    });

    it("throws ToolExecutionError on unknown tool name", async () => {
      await expect(executeTool("non_existent_tool", {}, ctx)).rejects.toThrow(ToolExecutionError);
    });

    it("creates unified diffs correctly", () => {
      const diff = createUnifiedDiff("file.txt", "old line\n", "new line\n");
      expect(diff).toContain("--- a/file.txt");
      expect(diff).toContain("+++ b/file.txt");
      expect(diff).toContain("-old line");
      expect(diff).toContain("+new line");
    });

    it("dispatches V2 fetch_url_content tool gracefully", async () => {
      const res = await executeTool(
        "fetch_url_content",
        { url: "https://example.com", max_length: 500 },
        ctx,
      );
      expect(res.success).toBe(true);
      expect(res.data).toBeDefined();
    });

    it("dispatches V2 find_symbol_definition and references", async () => {
      await sandboxRunner.writeFile(
        workspaceId,
        "math.ts",
        "export function calculateTotal(a: number, b: number): number { return a + b; }\nconst res = calculateTotal(1, 2);",
      );

      const defRes = await executeTool(
        "find_symbol_definition",
        { symbol_name: "calculateTotal" },
        ctx,
      );
      expect(defRes.success).toBe(true);

      const refRes = await executeTool(
        "find_symbol_references",
        { symbol_name: "calculateTotal" },
        ctx,
      );
      expect(refRes.success).toBe(true);
    });
  });
});
