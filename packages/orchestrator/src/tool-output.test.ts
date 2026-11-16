import { describe, expect, it } from "vitest";
import { cleanText, distillOutput, htmlToText, shapeToolOutput } from "./tool-output.js";
import { formatToolResult } from "./tool-result.js";

/** The preview padding mail tools put after a preheader: invisible, and hundreds long. */
const PAD = [0x034f, 0x200b, 0x20, 0x2007, 0x00ad].map((c) => String.fromCharCode(c)).join("");
const ANY_PAD = new RegExp(`[${String.fromCharCode(0x034f, 0x200b, 0x2007, 0x00ad)}]`);

/** An email as the mail connector returned it on 20 Oct 2026, in shape (the words are made up). */
function mailResult(): string {
  const reply =
    "Hi Ved,\r\n\r\nThanks for reaching out. Our serverless prices update by the hour, so we cannot fix them ahead.\r\n" +
    "Commercial use is allowed under our terms. No rate limits on serverless; 429s only at capacity.\r\n\r\nBest,\r\nNima\r\n" +
    "________________________________\r\nFrom: Website contact <noreply@example.com>\r\nSubject: New Submission\r\n\r\n" +
    `You've just received a new submission.\r\n${PAD.repeat(900)}\r\n` +
    "Name: Ved\r\nMessage: Which models do you serve, and at what price?\r\n\r\nTHE-LAST-LINE-OF-THE-THREAD";
  const html =
    "<!DOCTYPE html><html><head><style>.x{font-size:14px!important}</style></head><body>" +
    `<div>${reply.replace(/\r\n/g, "<br>")}</div>` +
    `<table>${"<tr><td style=\"padding:0\">&nbsp;</td></tr>".repeat(400)}</table></body></html>`;
  return JSON.stringify(
    {
      status: 200,
      headers: { "Cache-Control": "no-cache, private", "X-Ratelimit-Limit": "300", "X-Trace-Id": "09b26507b7d2adf911a1" },
      body: { data: { text: reply, html } },
    },
    null,
    2,
  );
}

describe("shapeToolOutput", () => {
  it("gives a connector's long email whole instead of cutting out its middle", () => {
    // 23 Oct 2026: two replies came back as 24,000 characters with the reply
    // itself in the "characters omitted" gap.
    const raw = mailResult();
    expect(raw.length).toBeGreaterThan(24_000);

    const shaped = shapeToolOutput("mcp__mail__messages_text", { success: true, data: raw }, { sessionId: "s1" });
    expect(shaped.content).not.toMatch(/characters omitted|Showing lines/);
    expect(shaped.content).toContain("Thanks for reaching out.");
    expect(shaped.content).toContain("THE-LAST-LINE-OF-THE-THREAD");
    expect(shaped.content).toContain("status: 200");
    expect(shaped.content).not.toContain("X-Ratelimit");
    expect(shaped.content).toContain("HTML copy left out");
    expect(shaped.content).not.toMatch(ANY_PAD);
    expect(shaped.content.length).toBeLessThan(2_000);
  });

  it("pages a document that is still too long, and saves the rest as lines a ranged read can walk", () => {
    const chapter = (n: number) => `Chapter ${n}\n${"A sentence that matters to the reader. ".repeat(40)}`;
    const doc = Array.from({ length: 30 }, (_, i) => chapter(i + 1)).join("\n\n");
    const shaped = shapeToolOutput("mcp__docs__get_page", { success: true, data: { title: "Guide", text: doc } }, { sessionId: "s1" });

    expect(shaped.artifact).toMatch(/^\.soreqen\/artifacts\/s1\/mcp__docs__get_page-.+\.txt$/);
    const next = Number(/start_line (\d+)/.exec(shaped.content)?.[1]);
    const lines = shaped.full!.split("\n");
    // The page ends exactly where the pointer says to go on.
    const shown = shaped.content.slice(0, shaped.content.lastIndexOf("\n\n[Showing")).split("\n");
    expect(shown.length).toBe(next - 1);
    expect(lines[next - 2]).toBe(shown[shown.length - 1]);
    expect(shaped.full).toContain("Chapter 30");
    expect(Math.max(...lines.map((l) => l.length))).toBeLessThanOrEqual(2_000);
    expect(shaped.content.length).toBeLessThanOrEqual(24_000);
  });

  it("keeps a log's head and tail, but saves the whole of it readable", () => {
    const stdout = Array.from({ length: 4_000 }, (_, i) => `step ${i} ok`).join("\n");
    const shaped = shapeToolOutput("run_command", { success: true, data: { command: "npm test", exitCode: 0, stdout } }, { sessionId: "s1" });
    expect(shaped.content).toContain("characters omitted");
    expect(shaped.content).toContain("step 3999 ok");
    expect(shaped.artifact).toBeUndefined();
    // Not one line of JSON: the digest's start_line/end_line lead somewhere.
    expect(shaped.full!.split("\n").length).toBeGreaterThan(4_000);
    expect(shaped.full).toContain("exitCode: 0");
  });

  it("leaves a result under its limit exactly as it was", () => {
    const result = { success: true, data: { path: "a.ts", content: "x" } };
    expect(shapeToolOutput("read_file", result, { sessionId: "s1" }).content).toBe(formatToolResult(result));
  });

  it("keeps a failure's reason at the top", () => {
    const data = { stderr: "x".repeat(30_000) };
    const shaped = shapeToolOutput("run_command", { success: false, error: "exit 1", data }, { sessionId: "s1" });
    expect(shaped.content.startsWith("FAILED: exit 1")).toBe(true);
  });
});

describe("shapeToolOutput: read_file", () => {
  /** A Java-like file of `n` lines, each about 60 characters, with quotes and tabs to escape. */
  const javaFile = (n: number) =>
    Array.from({ length: n }, (_, i) => `\tprivate final String field${i} = "value \\"${i}\\""; // line ${i + 1}`).join("\n");
  const read = (content: string, totalLines = content.split("\n").length) => ({
    success: true,
    data: { path: "Match.java", content, totalLines },
  });
  const pageOf = (shaped: { content: string }) =>
    JSON.parse(shaped.content) as { content: string; startLine?: number; endLine?: number; totalLines: number; note?: string };

  it("returns a 523-line file whole, as the code it is, not an outline (reported 29 Oct 2026)", () => {
    const file = javaFile(523);
    expect(JSON.stringify(read(file).data).length).toBeGreaterThan(24_000);
    const shaped = shapeToolOutput("read_file", read(file), { sessionId: "s1", windowTokens: 1_000_000 });
    expect(shaped.content).toBe(formatToolResult(read(file), { clip: false }));
    expect(pageOf(shaped).content).toBe(file);
    expect(shaped.full).toBeUndefined();
  });

  it("pages a file bigger than one read in whole lines, each page naming the next, until every line is read", () => {
    const file = javaFile(9_000);
    const lines = file.split("\n");
    const seen: string[] = [];
    let start = 1;
    for (let pages = 0; start <= lines.length && pages < 20; pages++) {
      const slice = lines.slice(start - 1).join("\n");
      const input = start === 1 ? {} : { start_line: start };
      const shaped = shapeToolOutput("read_file", read(slice, lines.length), { sessionId: "s1", windowTokens: 1_000_000, input });
      expect(shaped.content.length).toBeLessThanOrEqual(200_000);
      const page = pageOf(shaped);
      seen.push(...page.content.split("\n"));
      if (page.endLine === undefined) break;
      expect(page.startLine).toBe(start);
      expect(page.note).toContain(`start_line ${page.endLine + 1}`);
      start = page.endLine + 1;
    }
    // Every line once, in order: no head-and-tail, nothing skipped, nothing twice.
    expect(seen).toEqual(lines);
  });

  it("returns less of a file at once to a model with a small window", () => {
    const file = javaFile(2_000);
    const small = pageOf(shapeToolOutput("read_file", read(file), { sessionId: "s1", windowTokens: 32_000 }));
    const large = pageOf(shapeToolOutput("read_file", read(file), { sessionId: "s1", windowTokens: 1_000_000 }));
    expect(small.endLine).toBeLessThan(500);
    expect(large.content).toBe(file);
  });
});

describe("distillOutput", () => {
  it("names a base64 blob by size instead of spelling it out", () => {
    const out = distillOutput(JSON.stringify({ name: "logo.png", bytes: "QUJD".repeat(2_000) }));
    expect(out).toContain("name: logo.png");
    expect(out).toMatch(/bytes: \[binary data, \d+ KB\]/);
  });

  it("outlines lists of objects", () => {
    const out = distillOutput(JSON.stringify({ messages: [{ uid: 127, subject: "Re: pricing" }, { uid: 128, subject: "Re: terms" }] }));
    expect(out).toBe(["messages:", "  [1]", "    uid: 127", "    subject: Re: pricing", "  [2]", "    uid: 128", "    subject: Re: terms"].join("\n"));
  });
});

describe("rawMailText", () => {
  it("reads a raw message as its reader would: headers that matter, decoded text, attachments named", () => {
    const b64 = (s: string) => Buffer.from(s, "utf8").toString("base64").replace(/(.{76})/g, "$1\r\n");
    const raw = [
      "Return-Path: <nima@example.com>",
      "Received: from mail.example.com (mail.example.com [10.0.0.1])",
      "\tby mx.example.net with ESMTPS id 4j7c",
      "DKIM-Signature: v=1; a=rsa-sha256; d=example.com;",
      "\tb=ULoQc9t/L53wlNozwJEcLN8+6TIP4jgJXz9SFqjDmRbtGH+VYYvRZZxGr4aQoluZMxc",
      "MIME-Version: 1.0",
      "Message-ID: <abc@example.com>",
      "From: Nima <nima@example.com>",
      "Subject: Pricing",
      'Content-Type: multipart/mixed; boundary="_b0undary_"',
      "",
      "--_b0undary_",
      'Content-Type: text/plain; charset="utf-8"',
      "Content-Transfer-Encoding: base64",
      "",
      b64(`Hi Ved,\n\nOur prices update hourly.${" More detail.".repeat(20)}\n\nBest, Nima`),
      "--_b0undary_",
      'Content-Type: text/html; charset="utf-8"',
      "Content-Transfer-Encoding: base64",
      "",
      b64("<html><body><p>Hi Ved,</p><p>Our prices update hourly.</p></body></html>"),
      "--_b0undary_",
      'Content-Type: application/pdf; name="rates.pdf"',
      "Content-Transfer-Encoding: base64",
      "",
      b64("%PDF".repeat(3_000)),
      "--_b0undary_--",
    ].join("\r\n");
    const out = distillOutput(JSON.stringify({ status: 200, headers: { a: "b" }, body: raw }));
    expect(out).toContain("From: Nima <nima@example.com>");
    expect(out).toContain("Our prices update hourly.");
    expect(out).toContain("Best, Nima");
    expect(out).toContain("HTML part left out");
    expect(out).toMatch(/application\/pdf 'rates\.pdf', \d+ KB, not shown/);
    expect(out).not.toMatch(/DKIM-Signature|ESMTPS|ULoQc9t/);
    // Return-Path, Received, DKIM-Signature, MIME-Version, Message-ID.
    expect(out).toMatch(/\[5 transport headers left out/);
  });
});

describe("htmlToText", () => {
  it("keeps what a person would see: text, line breaks, link targets", () => {
    const text = htmlToText(
      '<html><head><style>p{color:red}</style></head><body><p>Hello &amp; welcome</p><p>See <a href="https://example.com/pricing">our prices</a>.</p></body></html>',
    );
    expect(text).toBe("Hello & welcome\nSee our prices (https://example.com/pricing).");
  });
});

describe("cleanText", () => {
  it("drops the padding but keeps a code line's indentation", () => {
    expect(cleanText(`    const x = 1;\n${PAD.repeat(50)}\nend`)).toBe("    const x = 1;\n\nend");
  });
});

describe("a long browser batch", () => {
  it("keeps its steps and screenshot paths as JSON, cutting only the long logs and page text", () => {
    const logs = Array.from({ length: 3000 }, (_, i) => ({ type: "log", text: `frame ${i} rendered`, timestamp: "t" }));
    const result = {
      success: true,
      data: {
        steps: [
          { step: 1, action: "open", ok: true, url: "http://localhost:5174/", title: "Copper Creek Foundry", status: 200 },
          { step: 2, action: "screenshot", ok: true, url: "http://localhost:5174/", saved: ".soreqen/shots/step2.png" },
          { step: 3, action: "console_logs", ok: true, logs },
        ],
        page_now: "x".repeat(60_000),
      },
    };
    const shaped = shapeToolOutput("browser_batch", result, { sessionId: "s1" });
    expect(shaped.content.length).toBeLessThanOrEqual(24_000);
    const parsed = JSON.parse(shaped.content) as { steps: Array<Record<string, unknown>>; page_now: string };
    expect(parsed.steps[1]!["saved"]).toBe(".soreqen/shots/step2.png");
    const kept = parsed.steps[2]!["logs"] as unknown[];
    expect(String(kept[0])).toMatch(/earlier entries left out/);
    expect(JSON.stringify(kept[kept.length - 1])).toContain("frame 2999");
    expect(parsed.page_now).toMatch(/more characters left out\]$/);
    expect(shaped.full).toBeTruthy();
  });
});

/*
 * 6 Nov 2026: in one 29-minute session, 41 write results came to 235,000
 * characters and 140 edit results to 211,000, each the diff of what the model
 * had just written. The person still gets the diff, by its own event.
 */
describe("what a write or an edit tells the model", () => {
  const body = Array.from({ length: 359 }, (_, i) => `line ${i + 1}`).join("\n") + "\n";
  const newFileDiff = `--- a/src/sym.py\n+++ b/src/sym.py\n@@ -0,0 +1,359 @@\n${body.replace(/\n$/, "").split("\n").map((l) => `+${l}`).join("\n")}`;

  it("says where a new file is and how long it is, without its text", () => {
    const shaped = shapeToolOutput(
      "write_file",
      { success: true, data: { path: "src/sym.py", bytesWritten: body.length, created: true, diff: newFileDiff }, diff: newFileDiff },
      { sessionId: "s", input: { path: "src/sym.py", content: body } },
    );
    expect(JSON.parse(shaped.content)).toEqual({ path: "src/sym.py", created: true, lines: 359, bytes: body.length });
    expect(shaped.content).not.toContain("line 200");
  });

  it("gives an exact edit's place and size, and a fuzzy edit's diff", () => {
    const diff = "--- a/a.ts\n+++ b/a.ts\n@@ -368,5 +368,7 @@\n ctx\n ctx\n-old\n+new one\n+new two\n+new three\n ctx\n";
    const exact = shapeToolOutput("edit_file", { success: true, data: { path: "a.ts", diff, matchStrategy: "exact" }, diff }, { sessionId: "s" });
    expect(JSON.parse(exact.content)).toEqual({ path: "a.ts", lines: "370-372", added: 3, removed: 1 });
    const fuzzy = shapeToolOutput(
      "edit_file",
      { success: true, data: { path: "a.ts", diff, matchStrategy: "whitespace", note: "Matched ignoring whitespace differences." }, diff },
      { sessionId: "s" },
    );
    const parsed = JSON.parse(fuzzy.content);
    expect(parsed.matchStrategy).toBe("whitespace");
    expect(parsed.diff).toContain("+new two");
    expect(parsed.note).toMatch(/whitespace/);
    // The gateway's patched-read check keys on this text: an inexact edit must still say so.
    expect(fuzzy.content).toMatch(/"matchStrategy":"(?!exact")/);
  });

  it("keeps warnings in front, where the model reads them first", () => {
    const diff = "--- a/a.ts\n+++ b/a.ts\n@@ -1,1 +1,1 @@\n-x\n+y {\n";
    const shaped = shapeToolOutput(
      "edit_file",
      { success: true, data: { path: "a.ts", diff, matchStrategy: "exact", warnings: ["Unbalanced braces after the edit"] }, diff },
      { sessionId: "s" },
    );
    expect(shaped.content.startsWith("WARNING: Unbalanced braces after the edit")).toBe(true);
  });
});

describe("a command's result without the command it echoed", () => {
  it("drops the call's own command and description, and keeps the rest", () => {
    const input = { command: "cd SoreQen-Code-Mono; python -m pytest tests -q", description: "Rerun the validation suite" };
    const data = { process_id: "p_1", ...input, status: "exited", background: false, exit_code: 0, ran_for: "2s", output: "46 passed in 0.21s\n" };
    const shaped = JSON.parse(shapeToolOutput("run_command", { success: true, data }, { sessionId: "s", input }).content);
    expect(shaped).toEqual({ process_id: "p_1", status: "exited", background: false, exit_code: 0, ran_for: "2s", output: "46 passed in 0.21s\n" });
    // A failure says why first, and still carries its output.
    const failed = shapeToolOutput("run_command", { success: false, error: "exited with code 1", data: { ...data, exit_code: 1 } }, { sessionId: "s", input });
    expect(failed.content.startsWith("FAILED: exited with code 1")).toBe(true);
    expect(failed.content).not.toContain("python -m pytest");
  });
});

describe("a plan update, as how far along it is", () => {
  it("says the count and what is in progress, not every title back", () => {
    const items = [
      { id: "1", title: "Look at the folder", status: "completed" },
      { id: "2", title: "Write the module", status: "in_progress" },
      { id: "3", title: "Run it", status: "pending" },
    ];
    const shaped = shapeToolOutput("update_todo_list", { success: true, data: { items, completed: 1, total: 3 } }, { sessionId: "s", input: { items } });
    expect(JSON.parse(shaped.content)).toEqual({ completed: 1, total: 3, in_progress: "Write the module" });
  });
});

describe("a directory listing and a glob, as text", () => {
  it("lists like ls: relative to the folder, folders marked, sizes readable", () => {
    const entries = [
      { path: "C:/work/app/.env", name: ".env", type: "file", sizeBytes: 2756, modifiedAt: "2026-10-05T09:30:49.277Z" },
      { path: "C:/work/app/src", name: "src", type: "directory", sizeBytes: 0, modifiedAt: "2026-10-05T09:30:49.277Z" },
      { path: "C:/work/app/big.bin", name: "big.bin", type: "file", sizeBytes: 5 * 1024 * 1024, modifiedAt: "2026-10-05T09:30:49.277Z" },
    ];
    const shaped = shapeToolOutput("list_directory", { success: true, data: { path: "C:\\work\\app", entries, count: 3 } }, { sessionId: "s" });
    expect(shaped.content).toBe(
      "3 entries in C:\\work\\app (paths relative to it; folders end in /):\n.env  2.7 KB\nsrc/\nbig.bin  5.0 MB",
    );
  });

  it("keeps workspace paths whole for a listing of the project folder", () => {
    const entries = [{ path: "package.json", name: "package.json", type: "file", sizeBytes: 300, modifiedAt: "x" }];
    expect(shapeToolOutput("list_directory", { success: true, data: { path: ".", entries, count: 1 } }, { sessionId: "s" }).content).toBe(
      "1 entry in the project folder (folders end in /):\npackage.json  300 B",
    );
  });

  it("lists a glob's files one a line, with its note", () => {
    const shaped = shapeToolOutput(
      "glob",
      { success: true, data: { pattern: "**/*.ts", files: ["src/a.ts", "src/b.ts"], count: 2, truncated: true, note: "More files may match; narrow the pattern or the path." } },
      { sessionId: "s" },
    );
    expect(shaped.content).toBe("2+ files match **/*.ts, newest first:\nsrc/a.ts\nsrc/b.ts\n\nMore files may match; narrow the pattern or the path.");
  });
});
