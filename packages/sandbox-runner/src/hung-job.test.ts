import { describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { hungJob, isJob, outputFilesOf, ProcessManager } from "./process-manager.js";
import { psSeconds } from "./os-processes.js";

const at = (command: string, startedAt = 0, lastOutputAt?: number, activeAt?: number) => ({
  info: { background: true, command, startedAt },
  ...(lastOutputAt !== undefined ? { lastOutputAt } : {}),
  ...(activeAt !== undefined ? { activeAt } : {}),
});
const min = 60_000;

describe("a background job that may have stopped making progress", () => {
  it("is looked at after fifteen silent minutes, or ninety in all", () => {
    expect(hungJob(at("pnpm vitest run", 0, 2 * min), 18 * min)).toMatch(/no output for 16 minutes/);
    expect(hungJob(at("npx tsc --noEmit", 0, 5 * min), 10 * min)).toBeNull();
    expect(hungJob(at("pnpm install", 0, 91 * min - 1), 91 * min)).toMatch(/still running after 91 minutes/);
  });

  it("is not looked at again for fifteen minutes once it was seen working", () => {
    expect(hungJob(at("pnpm vitest run", 0, 2 * min, 20 * min), 30 * min)).toBeNull();
    expect(hungJob(at("pnpm install", 0, 119 * min, 110 * min), 120 * min)).toBeNull();
    expect(hungJob(at("pnpm install", 0, 119 * min, 100 * min), 116 * min)).toMatch(/still running/);
  });

  it("leaves servers, watchers and anything that is not plainly a job alone", () => {
    expect(hungJob(at("pnpm dev"), 300 * min)).toBeNull();
    expect(hungJob(at("vitest --watch"), 300 * min)).toBeNull();
    expect(hungJob(at("python -m http.server 8000"), 300 * min)).toBeNull();
    expect(hungJob(at("node scripts/long-job.mjs"), 300 * min)).toBeNull();
    expect(hungJob({ info: { background: false, command: "pnpm test", startedAt: 0 } }, 300 * min)).toBeNull();
  });

  it("judges a command by what it runs, not by a cmdlet, a path or a quoted word in it (14 Oct 2026)", () => {
    // The Lyra training launch that was stopped twice: `Test-Path` read as `test`.
    const lyra =
      'cd "D:\\Language_Models\\ZorQelis-Lyra"; if (Test-Path "runs\\lyra_v3\\train.log") { Move-Item "runs\\lyra_v3\\train.log" "runs\\lyra_v3\\x.log" -Force }; ' +
      '$env:PYTHONIOENCODING="utf-8"; python zqlyra/training/train.py --data data/processed --output runs/lyra_v3 --max-steps 360000';
    expect(isJob(lyra)).toBe(false);
    expect(isJob("python D:/builds/tests/run_all.py")).toBe(false);
    expect(isJob('echo "build it"; python train.py')).toBe(false);
    expect(isJob("pnpm build")).toBe(true);
    expect(isJob("pytest -x tests")).toBe(true);
  });
});

describe("where a command's output goes", () => {
  it("finds the files a command writes its output to", () => {
    expect(outputFilesOf('python train.py *> "C:\\scratch\\run 1.log"')).toEqual(["C:\\scratch\\run 1.log"]);
    expect(outputFilesOf("node build.js > out/build.log 2>&1")).toEqual(["out/build.log"]);
    expect(outputFilesOf("make 2>> err.txt")).toEqual(["err.txt"]);
    expect(outputFilesOf("python run.py | tee -a runs/log.txt")).toEqual(["runs/log.txt"]);
    expect(outputFilesOf("python run.py | Out-File -FilePath out.txt")).toEqual(["out.txt"]);
    expect(outputFilesOf("python run.py > $null; cargo build 2>/dev/null")).toEqual([]);
  });

  it("reads ps's CPU time", () => {
    expect(psSeconds("00:01:05")).toBe(65);
    expect(psSeconds("1-02:00:00")).toBe(86_400 + 7_200);
    expect(psSeconds("3:04.50")).toBeCloseTo(184.5);
  });
});

describe("stopping a quiet job only when it has stopped working", () => {
  const command = `node -e "setInterval(() => {}, 1000)" # build`;

  async function settle(): Promise<void> {
    await new Promise((r) => setTimeout(r, 50));
  }

  it("leaves a silent job that is using the CPU running, and stops one that is not", async () => {
    let cpu = 10;
    const manager = new ProcessManager({ cpuSeconds: async () => cpu });
    const job = manager.start("ws", os.tmpdir(), os.tmpdir(), { command, background: true });
    const t0 = job.startedAt;
    try {
      // Silent for 16 minutes: first look, nothing stopped.
      manager.sweep(() => true, t0 + 16 * min);
      await settle();
      expect(manager.get("ws", job.id)?.status).toBe("running");

      // Five minutes on it has used the CPU: working, left alone.
      cpu = 40;
      manager.sweep(() => true, t0 + 21 * min);
      await settle();
      expect(manager.get("ws", job.id)?.status).toBe("running");

      // Not looked at again until fifteen more minutes pass.
      manager.sweep(() => true, t0 + 30 * min);
      await settle();
      expect(manager.get("ws", job.id)?.status).toBe("running");

      // Then: no CPU since the last look, sixteen minutes ago. Hung, stopped, with the reason.
      manager.sweep(() => true, t0 + 37 * min);
      // A stop is a kill and its exit, which a loaded machine takes its time over.
      for (let waited = 0; manager.get("ws", job.id)?.status === "running" && waited < 5_000; waited += 50) await settle();
      expect(manager.get("ws", job.id)?.status).toBe("timed_out");
      expect(manager.output("ws", job.id)).toMatch(/stopped this background job: no output for 37 minutes, and in the last 16 minutes its processes used no CPU/);
    } finally {
      await manager.stop(job.id, "user");
    }
  }, 20_000);

  it("leaves a job alone while the file its output goes to keeps growing", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sq-hung-"));
    const log = path.join(dir, "train.log");
    fs.writeFileSync(log, "step 1\n");
    const manager = new ProcessManager({ cpuSeconds: async () => 0 });
    const job = manager.start("ws", dir, dir, { command: `${command} > train.log`, background: true });
    try {
      for (const minutes of [16, 22, 40, 60, 200]) {
        // The log was written to a minute before each look.
        const now = job.startedAt + minutes * min;
        fs.utimesSync(log, new Date(now - min), new Date(now - min));
        manager.sweep(() => true, now);
        await settle();
      }
      expect(manager.get("ws", job.id)?.status).toBe("running");
    } finally {
      await manager.stop(job.id, "user");
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  }, 20_000);

  it("stops nothing when the CPU cannot be read", async () => {
    const manager = new ProcessManager({ cpuSeconds: async () => null });
    const job = manager.start("ws", os.tmpdir(), os.tmpdir(), { command, background: true });
    try {
      for (const minutes of [16, 22, 28, 200]) {
        manager.sweep(() => true, job.startedAt + minutes * min);
        await settle();
      }
      expect(manager.get("ws", job.id)?.status).toBe("running");
    } finally {
      await manager.stop(job.id, "user");
    }
  }, 20_000);
});
