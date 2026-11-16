/**
 * A command whose end was never reported is not "running" for ever.
 *
 * On Windows a pseudo-terminal does not always say that its command ended,
 * and such commands sat in the Tasks list as running for hours, with a Stop
 * that reached nothing (28 Sep 2026). The manager now asks the system whether
 * each running command's process still exists.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import os from "node:os";
import { ProcessManager, processAlive } from "./process-manager.js";
import type { ProcessEvent } from "./types.js";

describe("the liveness sweep", () => {
  afterEach(() => vi.useRealTimers());

  it("knows this process is alive and a made-up one is not", () => {
    expect(processAlive(process.pid)).toBe(true);
    expect(processAlive(2 ** 30)).toBe(false);
  });

  it("finishes a running command the system no longer has, and says so", async () => {
    const manager = new ProcessManager();
    const events: ProcessEvent[] = [];
    manager.onEvent((e) => events.push(e));
    const started = manager.start("ws", os.tmpdir(), os.tmpdir(), {
      command: `node -e "setTimeout(() => {}, 60000)"`,
      background: true,
    });

    // Past the grace a new command gets, the system reports it gone.
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.now() + 25_000);
    manager.sweep(() => false);

    expect(manager.get("ws", started.id)?.status).toBe("exited");
    expect(events.some((e) => e.type === "exited" && e.process.id === started.id)).toBe(true);

    vi.useRealTimers();
    // Really still running (the sweep was told otherwise): end it by hand.
    try {
      if (started.pid) process.kill(started.pid);
    } catch {
      // Already gone.
    }
  });

  it("leaves a command alone while its process exists", async () => {
    const manager = new ProcessManager();
    const started = manager.start("ws", os.tmpdir(), os.tmpdir(), {
      command: `node -e "setTimeout(() => {}, 60000)"`,
      background: true,
    });
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.now() + 25_000);
    manager.sweep(() => true);
    expect(manager.get("ws", started.id)?.status).toBe("running");
    vi.useRealTimers();
    await manager.stop(started.id, "user");
  });
});
