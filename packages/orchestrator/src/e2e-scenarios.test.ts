import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { LocalSandboxRunner } from "@sqcode/sandbox-runner";
import { SoreQenOrchestrator, MockLLMProvider } from "./index.js";

describe("Phase 9 — End-to-End Multi-Turn Benchmark Scenarios", () => {
  const wsId = `e2e_ws_${Date.now()}`;
  let sandboxRunner: LocalSandboxRunner;
  let tempDir: string;

  beforeEach(async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "sqcode_orch_e2e_"));
    sandboxRunner = new LocalSandboxRunner(tempDir);
    await sandboxRunner.createWorkspace(wsId, { storagePath: tempDir });
  });

  afterEach(async () => {
    await sandboxRunner.destroyWorkspace(wsId);
    try {
      fs.rmSync(tempDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    } catch {
      // ignore
    }
  });

  it("Scenario 1: Fixes a bug in a multi-file TypeScript codebase", async () => {
    // 1. Setup multi-file project fixture
    await sandboxRunner.writeFile(
      wsId,
      "src/jwt.ts",
      `export function verifyToken(token: string, secret: string): boolean {\n  // BUG: inverted secret validation\n  return secret.length === 0;\n}\n`,
    );

    await sandboxRunner.writeFile(
      wsId,
      "src/auth.ts",
      `import { verifyToken } from "./jwt.js";\nexport function authenticate(token: string, secret: string) {\n  return verifyToken(token, secret);\n}\n`,
    );

    // 2. Setup mock senior engineer agent
    const mockLLM = new MockLLMProvider([
      // Turn 1: Search codebase for token verification
      {
        text: "I will search the codebase for verifyToken.",
        toolCalls: [
          {
            id: "sc1_grep",
            name: "grep_search",
            input: { query: "verifyToken" },
          },
        ],
        stopReason: "tool_use",
      },
      // Turn 2: Read jwt.ts
      {
        text: "I will read src/jwt.ts to inspect the verification logic.",
        toolCalls: [
          {
            id: "sc1_read",
            name: "read_file",
            input: { path: "src/jwt.ts" },
          },
        ],
        stopReason: "tool_use",
      },
      // Turn 3: Edit jwt.ts
      {
        text: "Fixing inverted validation in src/jwt.ts.",
        toolCalls: [
          {
            id: "sc1_edit",
            name: "edit_file",
            input: {
              path: "src/jwt.ts",
              old_str: "  // BUG: inverted secret validation\n  return secret.length === 0;",
              new_str: "  return token.length > 0 && secret.length > 0;",
            },
          },
        ],
        stopReason: "tool_use",
      },
      // Turn 4: Final response
      {
        text: "Token verification in src/jwt.ts has been corrected and verified.",
        stopReason: "end_turn",
      },
    ]);

    const orchestrator = new SoreQenOrchestrator({
      sandboxRunner,
      llmProvider: mockLLM,
    });

    const result = await orchestrator.runTurn({
      workspaceId: wsId,
      sessionId: "sess_sc1",
      userMessage: "Authentication is failing for valid tokens. Fix verifyToken in jwt.ts.",
    });

    expect(result.status).toBe("completed");
    expect(result.toolCallsExecuted).toBe(3);

    const updatedJwt = await sandboxRunner.readFile(wsId, "src/jwt.ts");
    expect(updatedJwt.content).toContain("token.length > 0 && secret.length > 0;");
  });

  it("Scenario 2: Adds a new feature with tests to a Python project", async () => {
    // 1. Setup Python project fixture
    await sandboxRunner.writeFile(wsId, "calc.py", `def add(a, b):\n    return a + b\n`);

    await sandboxRunner.writeFile(
      wsId,
      "test_calc.py",
      `from calc import add\n\ndef test_add():\n    assert add(2, 3) == 5\n`,
    );

    // 2. Setup mock agent adding divide feature
    const mockLLM = new MockLLMProvider([
      // Turn 1: Read existing calc.py
      {
        text: "Reading calc.py before adding new function.",
        toolCalls: [
          {
            id: "sc2_read",
            name: "read_file",
            input: { path: "calc.py" },
          },
        ],
        stopReason: "tool_use",
      },
      // Turn 2: Write divide function to calc.py
      {
        text: "Adding divide function to calc.py.",
        toolCalls: [
          {
            id: "sc2_edit_calc",
            name: "write_file",
            input: {
              path: "calc.py",
              content:
                "def add(a, b):\n    return a + b\n\ndef divide(a, b):\n    if b == 0:\n        raise ValueError('Cannot divide by zero')\n    return a / b\n",
              overwrite: true,
            },
          },
        ],
        stopReason: "tool_use",
      },
      // Turn 3: Add unit test to test_calc.py
      {
        text: "Adding test_divide to test_calc.py.",
        toolCalls: [
          {
            id: "sc2_edit_test",
            name: "write_file",
            input: {
              path: "test_calc.py",
              content:
                "from calc import add, divide\nimport pytest\n\ndef test_add():\n    assert add(2, 3) == 5\n\ndef test_divide():\n    assert divide(10, 2) == 5.0\n    with pytest.raises(ValueError):\n        divide(5, 0)\n",
              overwrite: true,
            },
          },
        ],
        stopReason: "tool_use",
      },
      // Turn 4: Final response
      {
        text: "Implemented divide function with zero-division error handling and added unit tests.",
        stopReason: "end_turn",
      },
    ]);

    const orchestrator = new SoreQenOrchestrator({
      sandboxRunner,
      llmProvider: mockLLM,
    });

    const result = await orchestrator.runTurn({
      workspaceId: wsId,
      sessionId: "sess_sc2",
      userMessage:
        "Add a divide function with zero-division protection to calc.py and add unit tests.",
    });

    expect(result.status).toBe("completed");
    expect(result.toolCallsExecuted).toBe(3);

    const calcPy = await sandboxRunner.readFile(wsId, "calc.py");
    expect(calcPy.content).toContain("def divide(a, b):");
    expect(calcPy.content).toContain("Cannot divide by zero");

    const testPy = await sandboxRunner.readFile(wsId, "test_calc.py");
    expect(testPy.content).toContain("def test_divide():");
  });

  it("Scenario 3: Refuses a destructive action under guarded_autonomy until confirmed", async () => {
    const mockLLM = new MockLLMProvider([
      // Turn 1: Agent attempts git push
      {
        text: "I will push the latest release branch to remote repository.",
        toolCalls: [
          {
            id: "sc3_push",
            name: "git_operation",
            input: { operation: "push" },
          },
        ],
        stopReason: "tool_use",
      },
      // Turn 2: Final response
      {
        text: "Branch successfully pushed after approval.",
        stopReason: "end_turn",
      },
    ]);

    let confirmationTriggered = false;
    const orchestrator = new SoreQenOrchestrator({
      sandboxRunner,
      llmProvider: mockLLM,
    });

    const result = await orchestrator.runTurn({
      workspaceId: wsId,
      sessionId: "sess_sc3",
      permissionTier: "guarded_autonomy",
      userMessage: "Push the branch to origin.",
      onAwaitConfirmation: async (conf) => {
        confirmationTriggered = true;
        expect(conf.action).toBe("git_operation");
        return true; // User approves
      },
    });

    expect(confirmationTriggered).toBe(true);
    expect(result.status).toBe("completed");
  });

  it("Scenario 4: Recovers gracefully from execution timeouts without crashing", async () => {
    const isWindows = process.platform === "win32";
    const infiniteSleepCmd = isWindows ? "Start-Sleep -Seconds 10" : "sleep 10";

    const timeoutRes = await sandboxRunner.execCommand(wsId, {
      command: infiniteSleepCmd,
      timeoutMs: 400,
    });

    expect(timeoutRes.timedOut).toBe(true);
    expect(timeoutRes.exitCode).toBe(124);
    expect(timeoutRes.stderr).toContain("timed out");

    // Workspace is still fully operational after timeout
    await sandboxRunner.writeFile(wsId, "recovery.txt", "Operational after timeout recovery.");
    const readRes = await sandboxRunner.readFile(wsId, "recovery.txt");
    expect(readRes.content).toContain("Operational after timeout recovery.");
  });
});
