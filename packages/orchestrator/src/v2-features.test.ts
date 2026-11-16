/**
 * V2 Production Features Unit Tests
 * Tests MemoryManager and SelfHealer.
 */

import { describe, it, expect } from "vitest";
import { LocalSandboxRunner } from "@sqcode/sandbox-runner";
import { MemoryManager } from "./memory-manager.js";
import { SelfHealer } from "./self-healer.js";

describe("SoreQen V2 Production Features", () => {
  it("loads project rulebook from .soreqenrules correctly", async () => {
    const runner = new LocalSandboxRunner();
    const workspaceId = `test_rules_${Date.now()}`;
    await runner.createWorkspace(workspaceId);

    await runner.writeFile(
      workspaceId,
      ".soreqenrules",
      "# Project Rules\n1. Always write unit tests\n2. Never commit console logs\n",
    );

    const rules = await MemoryManager.loadProjectRules(workspaceId, runner);
    expect(rules).not.toBeNull();
    expect(rules?.source).toBe(".soreqenrules");
    expect(rules?.rules.length).toBeGreaterThan(0);
    expect(rules?.conventions).toContain("Always write unit tests");
  });

  it("records and retrieves episodic memory across sessions", async () => {
    const runner = new LocalSandboxRunner();
    const workspaceId = `test_mem_${Date.now()}`;
    await runner.createWorkspace(workspaceId);

    await MemoryManager.recordEpisodicMemory(workspaceId, runner, {
      sessionId: "session_1",
      timestamp: new Date().toISOString(),
      userGoal: "Fix auth token expiration",
      summary: "Patched jwt.verify expiry check",
      filesModified: ["src/auth.ts"],
      keyDecisions: ["Extended token duration to 24h"],
    });

    const memories = await MemoryManager.loadEpisodicMemory(workspaceId, runner);
    expect(memories.length).toBeGreaterThanOrEqual(1);
    const target = memories.find((m) => m.sessionId === "session_1");
    expect(target?.userGoal).toBe("Fix auth token expiration");
    expect(target?.filesModified).toContain("src/auth.ts");
  });

  it("SelfHealer checks static code integrity gracefully", async () => {
    const runner = new LocalSandboxRunner();
    const workspaceId = `test_heal_${Date.now()}`;
    await runner.createWorkspace(workspaceId);

    const result = await SelfHealer.verifyCodeIntegrity(workspaceId, runner, ["README.md"]);
    expect(result.passed).toBe(true);
  });
});
