/**
 * Tool output leaves the context once it has stopped being true or useful.
 *
 * The session that prompted this used the browser eight times, each result a
 * full page snapshot, and every one of them stayed in the window for the rest
 * of the session.
 */

import { describe, expect, it } from "vitest";
import { EPOCH, FRESH_IMAGE, condense, readable, slotOf, tidyHistory } from "./context-hygiene.js";
import { estimateHistoryTokens } from "./context-manager.js";
import type { LLMMessage } from "./types.js";

let n = 0;
/** One step: an assistant call and its result. */
function step(name: string, input: Record<string, unknown>, result: string): LLMMessage[] {
  const id = `c${++n}`;
  return [
    { role: "assistant", content: "", toolCalls: [{ id, name, input }] },
    { role: "tool", toolCallId: id, content: result },
  ];
}

const snapshot = (url: string, title: string): string =>
  JSON.stringify({
    success: true,
    url,
    title,
    elements: 150,
    page:
      `Page: ${title}\nURL: ${url}\n\nInteractive elements (use the number as \`ref\`):\n` +
      Array.from({ length: 150 }, (_, i) => `  [${i + 1}] button    "Action number ${i + 1}"`).join("\n") +
      "\n\nPage text:\n" +
      "Lorem ipsum dolor sit amet. ".repeat(200),
  });

const goal: LLMMessage = { role: "user", content: "Test the checkout flow." };

describe("screenshots in the history", () => {
  const shot = (n: number): LLMMessage => ({
    role: "user",
    content: [
      { type: "text", text: `Image from shot${n}.png:` },
      { type: "image", image_data: `DATA${n}`, media_type: "image/png" },
    ],
  });

  it("keeps the latest few attached and turns older ones into a line saying they were seen", () => {
    const history: LLMMessage[] = [{ role: "user", content: "Check the game visually." }];
    for (let i = 0; i < 6; i++) history.push(shot(i), { role: "assistant", content: `Looked at ${i}.` });
    const { messages, stats } = tidyHistory(history);
    const images = messages.flatMap((m) => (Array.isArray(m.content) ? m.content : [])).filter((b) => b.type === "image");
    expect(images.map((b) => (b as { image_data: string }).image_data)).toEqual(["DATA3", "DATA4", "DATA5"]);
    // The older ones still say which picture they were, and how to see it again.
    expect(JSON.stringify(messages[1]!.content)).toContain("Image from shot0.png:");
    expect(JSON.stringify(messages[1]!.content)).toContain("no longer attached");
    expect(stats.aged).toBeGreaterThanOrEqual(3);
    // The stored history is untouched.
    expect(JSON.stringify(history[1]!.content)).toContain("DATA0");
  });

  it("never trims the pictures in the newest message, however many it has (14 Nov 2026)", () => {
    // A long screenshot sent as four parts: the top part used to be dropped before the model saw it.
    const parts: LLMMessage = {
      role: "user",
      content: [
        { type: "text", text: "What does this show?" },
        ...[1, 2, 3, 4].map((n) => ({ type: "image" as const, image_data: `PART${n}`, media_type: "image/jpeg" })),
      ],
    };
    const { messages } = tidyHistory([shot(0), { role: "assistant", content: "Seen." }, parts]);
    const images = messages.flatMap((m) => (Array.isArray(m.content) ? m.content : [])).filter((b) => b.type === "image");
    expect(images.map((b) => (b as { image_data: string }).image_data)).toEqual(["PART1", "PART2", "PART3", "PART4"]);
  });

  it("leaves a history with only a few pictures exactly as it was", () => {
    const history: LLMMessage[] = [{ role: "user", content: "go" }, shot(1), shot(2)];
    expect(tidyHistory(history).messages[1]).toBe(history[1]);
  });

  it("calls only the newest picture current; the older ones attached say they are earlier", () => {
    // 1 Oct 2026: three attached screenshots, and the model kept describing an older one as the page now.
    const fresh = (n: number): LLMMessage => ({
      role: "user",
      content: [
        { type: "text", text: `Image from shot${n}.png${FRESH_IMAGE}` },
        { type: "image", image_data: `DATA${n}`, media_type: "image/png" },
      ],
    });
    const history: LLMMessage[] = [{ role: "user", content: "go" }, fresh(1), { role: "assistant", content: "a" }, fresh(2)];
    const { messages } = tidyHistory(history);
    expect(JSON.stringify(messages[1]!.content)).toContain("EARLIER image");
    expect(JSON.stringify(messages[1]!.content)).not.toContain("just taken");
    expect(JSON.stringify(messages[3]!.content)).toContain("just taken: this is the page as it is now");
    // The stored history keeps what was sent.
    expect(JSON.stringify(history[1]!.content)).toContain("just taken");
  });
});

describe("tidyHistory", () => {
  it("keeps only the latest page snapshot, and says where the others went", () => {
    const history = [goal];
    for (let i = 0; i < 8; i++) {
      history.push(...step("browser_snapshot", {}, snapshot(`http://localhost:5173/step${i}`, `Step ${i}`)));
    }

    const before = estimateHistoryTokens(history);
    const { messages, stats } = tidyHistory(history);
    const after = estimateHistoryTokens(messages);

    expect(stats.superseded).toBe(7);
    const results = messages.filter((m) => m.role === "tool").map((m) => m.content as string);
    expect(results.slice(0, 7).every((r) => r.startsWith("[Superseded page state of http://localhost:5173/step"))).toBe(true);
    // The current page is still readable in full, bar the fresh-output cap.
    expect(results[7]).toContain("Step 7");
    expect(results[7]).toContain("[150]");
    // The reason this exists.
    expect(after).toBeLessThan(before / 5);
  });

  it("does not let a failed browser call replace the last good page", () => {
    const history = [
      goal,
      ...step("browser_snapshot", {}, snapshot("http://localhost:5173/", "Home")),
      ...step("browser_open", { url: "http://localhost:9/" }, '{"success":false,"message":"Failed to open browser page: net::ERR"}'),
    ];
    const results = tidyHistory(history).messages.filter((m) => m.role === "tool");
    expect(results[0]!.content).toContain("Interactive elements");
  });

  it("supersedes a command only by the same command run again", () => {
    const run = (cmd: string, exit: number) =>
      step("run_command", { command: cmd }, JSON.stringify({ command: cmd, exitCode: exit, stdout: "x".repeat(50) }));
    const history = [goal, ...run("npm test", 1), ...run("npm run build", 0), ...run("npm  test", 0)];

    const results = tidyHistory(history).messages.filter((m) => m.role === "tool").map((m) => m.content as string);
    expect(results[0]).toBe("[Superseded: `npm test` was run again later (this run exited 1). See the later result.]");
    expect(results[1]).toContain("npm run build"); // a different command is untouched
    expect(results[2]).toContain('"exitCode":0');
  });

  it("ages a long install log to its errors, keeping the head and tail", () => {
    const log = [
      "> npm install",
      ...Array.from({ length: 400 }, (_, i) => `added package-${i}@1.0.0`),
      "npm ERR! peer dep missing: react@^19",
      ...Array.from({ length: 400 }, (_, i) => `fetched tarball ${i}`),
      "found 0 vulnerabilities",
    ].join("\n");
    const history: LLMMessage[] = [
      goal,
      ...step("run_command", { command: "npm install" }, JSON.stringify({ command: "npm install", exitCode: 1, stdout: log })),
    ];
    // Enough later steps to carry it past the command freshness window.
    for (let i = 0; i < 12; i++) history.push(...step("edit_file", { path: `f${i}.ts` }, "ok"));

    const [result] = tidyHistory(history).messages.filter((m) => m.role === "tool");
    const text = result!.content as string;
    expect(text.length).toBeLessThan(1_700);
    expect(text).toContain("npm ERR! peer dep missing: react@^19");
    expect(text).toContain("found 0 vulnerabilities");
    expect(text).toContain("exit 1");
    expect(text).toContain("re-run it for the full output");
  });

  it("keeps a read for longer than a command, and an edit's result as long as a read", () => {
    const file = Array.from({ length: 600 }, (_, i) => `const line${i} = ${i};`).join("\n");
    const history: LLMMessage[] = [
      goal,
      ...step("read_file", { path: "src/a.ts" }, JSON.stringify({ path: "src/a.ts", content: file, totalLines: 600 })),
      ...step("edit_file", { path: "src/a.ts" }, "x".repeat(3_000)),
    ];
    for (let i = 0; i < 6; i++) history.push(...step("grep_search", { query: `q${i}` }, "hit"));
    // Eight steps after the read: a command would be condensed by now, a read is not.
    let results = tidyHistory(history).messages.filter((m) => m.role === "tool");
    expect(results[0]!.content).toContain("const line599");

    for (let i = 0; i < 8; i++) history.push(...step("grep_search", { query: `r${i}` }, "hit"));
    results = tidyHistory(history).messages.filter((m) => m.role === "tool");
    expect(results[0]!.content).toContain("read it again before editing from it");
    // An old edit's result is condensed like an old read (5 Oct 2026: past edits were a third of a long session's context).
    expect(String(results[1]!.content).length).toBeLessThan(800);
    expect(results[1]!.content).toContain("read the file for its current state");
  });

  it("moves the ageing boundary in epochs, so most steps change nothing old", () => {
    /*
     * The cache property. Between two consecutive requests, the old part of
     * the history must usually be byte-identical — otherwise every request
     * pays full price for its whole prefix.
     */
    const history: LLMMessage[] = [goal];
    let unchanged = 0;
    let previous: LLMMessage[] | null = null;
    for (let i = 0; i < 40; i++) {
      history.push(...step("run_command", { command: `echo ${i}` }, "line\n".repeat(600)));
      const tidied = tidyHistory(history).messages;
      if (previous && previous.every((m, j) => m.content === tidied[j]!.content)) unchanged++;
      previous = tidied;
    }
    // At most one boundary move per EPOCH steps.
    expect(unchanged).toBeGreaterThanOrEqual(Math.floor(39 * (1 - 1 / EPOCH)) - 1);
  });

  it("is pure and deterministic", () => {
    const history = [goal, ...step("browser_snapshot", {}, snapshot("http://a", "A")), ...step("browser_snapshot", {}, snapshot("http://b", "B"))];
    const copy = JSON.parse(JSON.stringify(history)) as LLMMessage[];
    expect(tidyHistory(history).messages).toEqual(tidyHistory(copy).messages);
    expect(history).toEqual(copy);
  });
});

describe("slotOf", () => {
  it("treats the same read of the same range as one slot, and different ranges as two", () => {
    const read = (path: string, start?: number) => slotOf({ id: "x", name: "read_file", input: { path, start_line: start } });
    expect(read("./src/a.ts")).toBe(read("src/a.ts"));
    expect(read("src/a.ts", 1)).not.toBe(read("src/a.ts", 200));
    expect(slotOf({ id: "x", name: "edit_file", input: { path: "a" } })).toBeNull();
  });
});

describe("readable / condense", () => {
  it("unpacks one-line JSON so line-based condensing can see inside it", () => {
    const text = readable(JSON.stringify({ command: "tsc", exitCode: 2, stdout: "a\nb\nerror TS2345: bad" }));
    expect(text).toContain("exitCode: 2");
    expect(text).toContain("--- stdout ---\na\nb\nerror TS2345: bad");
  });

  it("falls back to both ends for text with too few lines to choose from", () => {
    const out = condense("x".repeat(20_000), 1_000, "note");
    expect(out.length).toBeLessThan(1_100);
    expect(out).toContain("characters omitted");
  });
});
