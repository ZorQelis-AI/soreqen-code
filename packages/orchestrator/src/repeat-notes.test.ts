import { describe, expect, it } from "vitest";
import { RepeatNotes } from "./repeat-notes.js";
import { shapeToolOutput } from "./tool-output.js";

const read = (content: string) => ({ success: true, data: { path: "src/sim/factory.js", content, totalLines: 481 } });
const ran = (output: string, id: string) => ({ success: true, data: { process_id: id, status: "exited", exit_code: 0, ran_for: "0s", output } });

describe("a read or command repeated with the same result (30 Oct 2026)", () => {
  it("says so the second time a range is read unchanged, and not the first", () => {
    const notes = new RepeatNotes();
    const input = { path: "src/sim/factory.js", start_line: 130, end_line: 240 };
    expect(notes.note("read_file", input, read("a\nb"))).toBeNull();
    expect(notes.note("read_file", input, read("a\nb"))).toMatch(/already read these same lines/);
  });

  it("says nothing when the lines changed in between, or another range was read", () => {
    const notes = new RepeatNotes();
    notes.note("read_file", { path: "a.js", start_line: 1, end_line: 10 }, read("one"));
    expect(notes.note("read_file", { path: "a.js", start_line: 1, end_line: 10 }, read("two"))).toBeNull();
    expect(notes.note("read_file", { path: "a.js", start_line: 11, end_line: 20 }, read("two"))).toBeNull();
  });

  it("knows a command by its text and what it printed, not its process id or time", () => {
    const notes = new RepeatNotes();
    const input = { command: "Get-ChildItem public/assets/ui" };
    expect(notes.note("run_command", input, ran("buttonSquare_blue.png", "p_1"))).toBeNull();
    expect(notes.note("run_command", input, ran("buttonSquare_blue.png", "p_2"))).toMatch(/already ran this command/);
    expect(notes.note("run_command", input, ran("other.png", "p_3"))).toBeNull();
  });

  it("ignores failures and commands still running", () => {
    const notes = new RepeatNotes();
    const input = { command: "npm run dev" };
    const running = { success: true, data: { process_id: "p", status: "running", output: "ready" } };
    notes.note("run_command", input, running);
    expect(notes.note("run_command", input, running)).toBeNull();
    notes.note("read_file", { path: "x" }, { success: false });
    expect(notes.note("read_file", { path: "x" }, { success: false })).toBeNull();
  });

  it("keeps the note in a read's result, whole or paged, so the transcript still shows it as code", () => {
    const whole = shapeToolOutput("read_file", { success: true, data: { path: "a.js", content: "x", totalLines: 1, repeat: "again" } }, { sessionId: "s" });
    expect(JSON.parse(whole.content).repeat).toBe("again");
    const long = Array.from({ length: 8_000 }, (_, i) => `line ${i} ${"x".repeat(40)}`).join("\n");
    const paged = shapeToolOutput(
      "read_file",
      { success: true, data: { path: "a.js", content: long, totalLines: 8_000, repeat: "again" } },
      { sessionId: "s", windowTokens: 100_000 },
    );
    const page = JSON.parse(paged.content);
    expect(page.endLine).toBeLessThan(8_000);
    expect(page.repeat).toBe("again");
  });
});
