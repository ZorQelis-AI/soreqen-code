import { describe, expect, it } from "vitest";
import { RepetitionWatch, sameness } from "./repetition.js";

const read = (path: string) => ({ id: path, name: "read_file", input: { path } });
const edit = (path: string) => ({ id: `e${path}`, name: "edit_file", input: { path } });

// The paragraph from the stored Ironveil session, restated with small changes each step.
const said = [
  "Phase 2's gate is green, but the units.ts read exposed a real gap: buildSoldier only varies blade size — no bow, staff, spear, or siege-engine models, and no tower or building rendering.",
  "Phase 2's gate is green (34/34), but my visual audit found two gaps: unit kinds only differ by blade size (no bow/staff/spear/siege engines), and no building or tower models exist at all.",
  "Phase 2's code gate is green, but my visual audit found two hard gaps: unit kinds are all the same soldier with a bigger blade (no bow, staff, spear, or siege engines), and buildings have no rendering at all.",
];

describe("noticing a model going in circles", () => {
  it("scores a restatement high and a new idea low", () => {
    expect(sameness(said[0]!, said[1]!)).toBeGreaterThan(0.3);
    expect(sameness(said[1]!, said[2]!)).toBeGreaterThan(0.45);
    expect(sameness(said[0]!, "Wrote the tower mesh builder and wired building_built events to spawn it.")).toBeLessThan(0.3);
  });

  it("tells the model after it restates and re-reads, naming the files", () => {
    const watch = new RepetitionWatch();
    expect(watch.observe(said[0]!, [read("src/units.ts")])).toBeNull();
    expect(watch.observe(said[1]!, [read("src/units.ts"), read("src/castles.ts")])).toBeNull();
    const told = watch.observe(said[2]!, [read("src/castles.ts")]);
    expect(told).toMatch(/going in circles/);
    expect(told).toContain("`src/units.ts`");
    expect(told).toContain("`src/castles.ts`");
  });

  it("does not count a step that changed something", () => {
    const watch = new RepetitionWatch();
    watch.observe(said[0]!, [read("a.ts")]);
    expect(watch.observe(said[1]!, [edit("a.ts")])).toBeNull();
    expect(watch.observe(said[2]!, [read("a.ts")])).toBeNull();
  });
});

describe("noticing a model checking the same thing again (14 Oct 2026)", () => {
  // The stored TTS session: a training run left in the background, "verified" eight times in four minutes.
  const steps = [
    "Training is running. Let me verify its health and check the val/checkpoint cadence matches your spec.",
    "Training is running. Let me verify the cadence matches your spec exactly and confirm health.",
    "Training is running with your exact cadence. Let me do a final health check before reporting.",
    "Training is running with your exact cadence. Let me do a final verification before reporting.",
    "Training is running with your exact cadence. Let me do a final verification before reporting.",
  ];
  const command = (n: number) => ({ id: `c${n}`, name: "run_command", input: { command: `Get-Content runs/lyra_v3/train.log -Tail ${n}` } });

  it("tells it by the fourth check, and says the job will report its own end", () => {
    const watch = new RepetitionWatch();
    const told = steps.map((text, i) => watch.observe(text, [command(i)]));
    const first = told.findIndex((t) => t !== null);
    expect(first).toBeGreaterThan(0);
    expect(first).toBeLessThanOrEqual(3);
    expect(told[first]).toMatch(/checking the same thing/);
    expect(told[first]).toMatch(/SoreQen tells you when it finishes, crashes or is stopped/);
  });

  it("asks it to finish once told and still checking", () => {
    const watch = new RepetitionWatch();
    const told = [...steps, ...steps.slice(3), ...steps.slice(3)].map((text, i) => watch.observe(text, [command(i)])).filter(Boolean);
    expect(told.length).toBeGreaterThanOrEqual(2);
    expect(told[1]).toMatch(/Finish your turn now/);
  });

  it("leaves alone commands that say something new each time, and ones beside an edit", () => {
    const watch = new RepetitionWatch();
    const varied = [
      "Installed the dependencies; now building the frontend bundle to check the imports resolve.",
      "The build passes. Running the unit tests for the parser module next to confirm the fix.",
      "Two parser tests fail on empty input. Reading the tokenizer to see where the empty case goes.",
      "Started the dev server in the background to look at the page in the browser.",
    ];
    expect(varied.map((text, i) => watch.observe(text, [command(i)])).every((t) => t === null)).toBe(true);
    const editing = new RepetitionWatch();
    const same = steps[3]!;
    expect([0, 1, 2, 3].map((i) => editing.observe(same, [command(i), edit("train.py")])).every((t) => t === null)).toBe(true);
  });
});

describe("noticing a model polling a job's status", () => {
  it("says the job reports its own end (the 18:49 preprocessing polls, 13 Oct 2026)", () => {
    const watch = new RepetitionWatch();
    const status = (n: number) => ({ id: `s${n}`, name: "process_status", input: { process_id: "p_1d6748d6e5e5", tail_lines: 14 } });
    const said = [
      "The full preprocessing run is in progress (Ethan and Johnson done). Let me monitor it closely.",
      "The full preprocessing run is in progress (Ethan and Johnson done). Let me monitor it closely.",
      "The full preprocessing run is in progress (Ethan and Johnson done). Let me monitor it closely.",
    ];
    const told = said.map((text, i) => watch.observe(text, [status(i)])).filter(Boolean);
    expect(told[0]).toMatch(/SoreQen tells you when it finishes/);
  });
});
