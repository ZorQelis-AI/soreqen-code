import type { SandboxRunner } from "@sqcode/sandbox-runner";

export interface ProjectRulebook {
  rules: string[];
  conventions: string;
  source: string;
}

export interface EpisodicMemoryEntry {
  sessionId: string;
  timestamp: string;
  userGoal: string;
  summary: string;
  filesModified: string[];
  keyDecisions: string[];
}

export class MemoryManager {
  /**
   * Discovers and compiles project-level rulebooks (.soreqenrules, SOREQEN.md, .cursorrules)
   */
  static async loadProjectRules(
    workspaceId: string,
    sandboxRunner: SandboxRunner,
  ): Promise<ProjectRulebook | null> {
    const candidateFiles = [".soreqenrules", "SOREQEN.md", ".soreqen/rules.md", ".cursorrules"];

    for (const file of candidateFiles) {
      try {
        const res = await sandboxRunner.readFile(workspaceId, file, 1, 100);
        if (res.content.trim()) {
          const rules = res.content
            .split(/\r?\n/)
            .map((line) => line.trim())
            .filter((line) => line.startsWith("-") || line.startsWith("*") || /^\d+\./.test(line));

          return {
            source: file,
            rules,
            conventions: res.content.trim(),
          };
        }
      } catch {
        // File doesn't exist, continue searching
      }
    }

    return null;
  }

  /**
   * Loads episodic session memory from .soreqen/memory.json
   */
  static async loadEpisodicMemory(
    workspaceId: string,
    sandboxRunner: SandboxRunner,
  ): Promise<EpisodicMemoryEntry[]> {
    try {
      const res = await sandboxRunner.readFile(workspaceId, ".soreqen/memory.json");
      const parsed = JSON.parse(res.content);
      if (Array.isArray(parsed)) {
        return parsed.slice(-5); // Return recent 5 memories
      }
    } catch {
      // Memory store doesn't exist yet
    }
    return [];
  }

  /**
   * Appends an episodic session summary to the workspace memory
   */
  static async recordEpisodicMemory(
    workspaceId: string,
    sandboxRunner: SandboxRunner,
    entry: EpisodicMemoryEntry,
  ): Promise<void> {
    try {
      let existing: EpisodicMemoryEntry[] = [];
      try {
        const res = await sandboxRunner.readFile(workspaceId, ".soreqen/memory.json");
        existing = JSON.parse(res.content);
      } catch {
        existing = [];
      }

      existing.push(entry);
      // Keep max 25 historical session entries
      if (existing.length > 25) {
        existing = existing.slice(existing.length - 25);
      }

      await sandboxRunner.writeFile(
        workspaceId,
        ".soreqen/memory.json",
        JSON.stringify(existing, null, 2),
        true,
      );
    } catch {
      // Non-blocking fallback
    }
  }
}
