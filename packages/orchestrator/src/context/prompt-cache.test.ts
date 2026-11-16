/**
 * Keeping the provider's prompt cache.
 *
 * Measured on GPT 6 Luna, 24 Sep 2026: a step that only appended to the
 * conversation was ~95% cached; a step that rewrote any earlier tool result —
 * a superseded run stubbed, a read marked stale — fell back to the system
 * prompt alone and paid for the whole conversation again.
 */

import { describe, expect, it } from "vitest";
import type { LLMMessage } from "../types.js";
import { keepSent } from "./engine.js";

const call = (id: string, name: string, input: Record<string, unknown>): LLMMessage => ({
  role: "assistant",
  content: "",
  toolCalls: [{ id, name, input }],
});
const result = (id: string, content: string): LLMMessage => ({ role: "tool", toolCallId: id, content });

describe("what was sent stays as it was sent", () => {
  const raw: LLMMessage[] = [
    { role: "user", content: "Add mul to math.js" },
    call("c1", "read_file", { path: "math.js" }),
    result("c1", "export const add = …"),
  ];
  const sentView = raw.map((m) => ({ ...m }));

  it("keeps the sent messages byte-for-byte, and tidies only what is new", () => {
    const next = [...raw, call("c2", "edit_file", { path: "math.js" }), result("c2", "ok")];
    // Tidying now marks the first read stale — a rewrite of a message the provider already cached.
    const tidied = next.map((m, i) => (i === 2 ? { ...m, content: "[STALE: math.js was changed after this read — …]\n…" } : m));
    const kept = keepSent({ raw, view: sentView }, next, tidied);
    expect(kept.kept).toBe(3);
    expect(kept.view[2]!.content).toBe("export const add = …");
    expect(kept.view.slice(3)).toEqual(tidied.slice(3));
    // And the warning is not lost: it is reported, for the working set to carry.
    expect(kept.staleUnmarked).toEqual(["math.js"]);
  });

  it("starts again when the history was rewritten underneath — a checkpoint, a rewind", () => {
    const rewritten = [{ role: "user" as const, content: "[Checkpoint summary]" }, ...raw.slice(1)];
    const kept = keepSent({ raw, view: sentView }, rewritten, rewritten);
    expect(kept.kept).toBe(0);
    expect(kept.view).toBe(rewritten);
    // Nothing sent yet: nothing to keep.
    expect(keepSent(null, raw, raw).kept).toBe(0);
  });
});
