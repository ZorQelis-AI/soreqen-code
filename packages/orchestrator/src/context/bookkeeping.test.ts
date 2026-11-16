/**
 * The loop of 29 Sep 2026: with the plan done, the state still listed "Next
 * actions" two at a time, and the agent closed them two by two for eighteen
 * steps — a minute of thought each — before it would write its answer.
 */

import { describe, expect, it } from "vitest";
import { TaskStateStore, emptyTaskState, renderTaskState } from "./task-state.js";

function withLeftovers(planStatus: string): TaskStateStore {
  const store = new TaskStateStore(emptyTaskState("s"));
  store.addRequest("Build the tower defense game");
  store.setPlan([{ title: "Build it", status: planStatus }, { title: "Test it", status: planStatus }], false);
  for (let i = 0; i < 12; i++) store.add({ kind: "next_action", text: `old step ${i}`, source: { type: "transcript", ref: "x", step: 1 } });
  return store;
}

describe("next actions once the plan is done", () => {
  it("are counted, not listed with ids to close", () => {
    const text = renderTaskState(withLeftovers("completed").state, 600).text;
    expect(text).not.toMatch(/Next actions:/);
    expect(text).toMatch(/The plan is complete\. 12 next actions recorded earlier are not listed/);
  });

  it("are listed as before while the plan still has work", () => {
    const text = renderTaskState(withLeftovers("in_progress").state, 600).text;
    expect(text).toMatch(/Next actions:/);
  });
});
