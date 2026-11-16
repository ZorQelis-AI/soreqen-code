/**
 * Master Tool Dispatcher.
 *
 * One arm per tool name, and the one place a tool name becomes a function
 * call. Every arm reports what actually happened: an arm that returns
 * `{ success: true }` unconditionally is a tool that cannot fail, which is
 * how a model comes to reason onward from a page it never read.
 */

import { ASK_USER_BACK } from "@sqcode/shared";
import type {
  ToolName,
  ReadFileInput,
  EditFileInput,
  WriteFileInput,
  ListDirectoryInput,
  GrepSearchInput,
  RunCommandInput,
  RunTestsInput,
  GitOperationInput,
  InstallPackageInput,
  WebSearchInput,
  UpdateTodoListInput,
  BrowserOpenInput,
  BrowserScreenshotInput,
  BrowserInteractInput,
  BrowserConsoleLogsInput,
  FetchUrlContentInput,
  FindSymbolDefinitionInput,
  FindSymbolReferencesInput,
} from "@sqcode/shared";
import type { ToolExecutionContext, ToolResult } from "./types.js";
import { ToolExecutionError } from "./types.js";
import {
  toolReadFile,
  toolEditFile,
  toolWriteFile,
  toolListDirectory,
  toolGrepSearch,
  toolGlob,
  toolRunCommand,
  toolRunTests,
  toolGitOperation,
  toolInstallPackage,
  toolWebSearch,
  toolUpdateTodoList,
} from "./implementations.js";
import {
  toolBrowserOpen,
  toolBrowserScreenshot,
  storeScreenshot,
  capturePagePreview,
  isLocalPage,
  toolBrowserInteract,
  toolBrowserSnapshot,
  toolBrowserConsoleLogs,
  takeBrowserNotes,
} from "./browser-tools.js";
import { toolFindSymbolDefinition, toolFindSymbolReferences } from "./symbol-tools.js";
import { toolProcessStatus, toolSendProcessInput, toolStopProcess, toolWait } from "./process-tools.js";
import type { ProcessStatusInput, SendProcessInputInput, StopProcessInput, WaitInput } from "@sqcode/shared";
import { BROWSER_BATCH_ACTIONS, MAX_BATCHED_QUESTIONS, MAX_BROWSER_BATCH_STEPS } from "@sqcode/shared";
import { toolFetchUrlContent } from "./web-content-tools.js";
import { runResearch } from "./research.js";
import { MAX_IMAGE_BYTES, toolViewImage, type ViewImageInput } from "./image-tools.js";

/**
 * Where this workspace's files live on disk, or null when the runner cannot
 * say. Null means "no local file may be opened", which is the safe answer.
 */
async function workspaceRootOf(ctx: ToolExecutionContext): Promise<string | null> {
  try {
    const inspected = await ctx.sandboxRunner.inspectWorkspace(ctx.workspaceId);
    return inspected?.workspacePath ?? null;
  } catch {
    return null;
  }
}

/**
 * A browser result with what happened on the page since the last one — a
 * dialog answered, a tab opened, a request that failed — so the agent learns
 * of it in the result it is already reading.
 */
function withBrowserNotes<T extends object>(data: T, ctx: ToolExecutionContext): T & { page_events?: string[] } {
  const notes = takeBrowserNotes(ctx.sessionId);
  return notes.length > 0 ? { ...data, page_events: notes } : data;
}

/**
 * One change to a file at a time.
 *
 * Specialists run side by side in the same folder, and an edit is a read, a
 * replacement and a write: two of them on one file at once could each read
 * the old text and the second write would undo the first, with both agents
 * told they had succeeded (audit, 1 Oct 2026). Changes to the same path now
 * queue behind each other; the second then finds the first's text, matches
 * or not, and says so.
 */
const fileQueues = new Map<string, Promise<unknown>>();

function oneAtATime<T>(ctx: ToolExecutionContext, path: unknown, work: () => Promise<T>): Promise<T> {
  const key = `${ctx.workspaceId}:${String(path ?? "").replace(/\\/g, "/").replace(/^\.\//, "").toLowerCase()}`;
  const before = fileQueues.get(key) ?? Promise.resolve();
  const mine = before.then(work, work);
  const settled = mine.then(
    () => undefined,
    () => undefined,
  );
  fileQueues.set(key, settled);
  void settled.then(() => {
    if (fileQueues.get(key) === settled) fileQueues.delete(key);
  });
  return mine;
}

export async function executeTool(
  toolName: ToolName | string,
  input: unknown,
  ctx: ToolExecutionContext,
): Promise<ToolResult> {
  switch (toolName) {
    case "read_file":
      return toolReadFile(input as ReadFileInput, ctx);
    case "edit_file":
      return oneAtATime(ctx, (input as EditFileInput)?.path, () => toolEditFile(input as EditFileInput, ctx));
    case "write_file":
      return oneAtATime(ctx, (input as WriteFileInput)?.path, () => toolWriteFile(input as WriteFileInput, ctx));
    case "list_directory":
      return toolListDirectory((input ?? {}) as ListDirectoryInput, ctx);
    case "grep_search":
      return toolGrepSearch(input as GrepSearchInput, ctx);
    case "glob":
      return toolGlob((input ?? {}) as { pattern?: unknown; path?: unknown }, ctx);
    case "run_command":
      return toolRunCommand(input as RunCommandInput, ctx);
    case "process_status":
      return toolProcessStatus((input ?? {}) as ProcessStatusInput, ctx);
    case "stop_process":
      return toolStopProcess(input as StopProcessInput, ctx);
    case "send_process_input":
      return toolSendProcessInput(input as SendProcessInputInput, ctx);
    case "wait":
      return toolWait((input ?? {}) as WaitInput, ctx);
    case "run_tests":
      return toolRunTests((input ?? {}) as RunTestsInput, ctx);
    case "git_operation":
      return toolGitOperation(input as GitOperationInput, ctx);
    case "install_package":
      return toolInstallPackage(input as InstallPackageInput, ctx);
    case "web_search":
      return toolWebSearch(input as WebSearchInput, ctx);
    case "update_todo_list":
      return toolUpdateTodoList(input as UpdateTodoListInput, ctx);

    /*
     * V2 tools.
     *
     * Every arm here used to be written `{ success: true, data: await tool(…) }`
     * — the result payload was never consulted, so these seven tools could not
     * report failure at all. A `fetch_url_content` that came back
     * `status: 500, content: "Failed to fetch URL content: fetch failed"` was
     * handed to the model as a success, and the model reasoned onward from a
     * page it had never read.
     *
     * That is the same defect `formatToolResult` was written to fix, one layer
     * up: it was fixed in the formatter and reintroduced in the caller. So the
     * success flag now comes from what happened.
     */
    case "browser_open": {
      /*
       * The workspace root, so a local file cannot be opened from outside it.
       *
       * Passed here rather than looked up inside the tool because this is the
       * layer that has the runner. See `resolveBrowserTarget`.
       */
      const opened = await toolBrowserOpen(ctx.sessionId, input as BrowserOpenInput, await workspaceRootOf(ctx));
      // A page on this computer gets a picture for its preview card; see `capturePagePreview`.
      const previewPath = opened.success && isLocalPage(opened.url) ? await capturePagePreview(ctx.sessionId, ctx) : null;
      // Its own verdict, not a blanket success: a navigation that failed said
      // so in `message` while the flag said it worked.
      return {
        success: opened.success,
        data: withBrowserNotes(previewPath ? { ...opened, previewPath } : opened, ctx),
        ...(opened.success ? {} : { error: opened.message }),
      };
    }
    case "browser_screenshot": {
      const shot = await toolBrowserScreenshot(ctx.sessionId, (input ?? {}) as BrowserScreenshotInput);
      const stored = await storeScreenshot(shot, ctx);
      /*
       * The picture itself, to a model that can see.
       *
       * It used to be written to a file and named, and the model had to call
       * view_image on that file to look at it — a second round trip for the
       * one thing a screenshot is for. The loop sends this to vision models
       * and drops it for the others.
       */
      const bytes = Math.floor((shot.screenshotBase64.length * 3) / 4);
      const path = typeof stored["screenshotPath"] === "string" ? (stored["screenshotPath"] as string) : "the screenshot";
      return {
        success: shot.success,
        data: withBrowserNotes(stored, ctx),
        ...(shot.success ? {} : { error: shot.error ?? "The screenshot could not be taken." }),
        ...(shot.success && shot.screenshotBase64 && bytes <= MAX_IMAGE_BYTES
          ? { image: { base64: shot.screenshotBase64, mediaType: "image/png", source: path } }
          : {}),
      };
    }
    case "browser_snapshot": {
      const snapshot = await toolBrowserSnapshot(
        ctx.sessionId,
        (input ?? {}) as { include_text?: boolean },
      );
      return {
        success: snapshot.success,
        data: withBrowserNotes(snapshot, ctx),
        ...(snapshot.error ? { error: snapshot.error } : {}),
      };
    }
    case "browser_interact": {
      /*
       * `{action: "screenshot"}` and the like: a batch step's spelling used on
       * the single tool. What was meant is plain, so it is done rather than
       * refused (seen 2 Oct 2026, the first turn after browser_batch existed).
       */
      const asked = String((input as { action?: unknown } | null)?.action ?? "");
      if (asked === "open" || asked === "snapshot" || asked === "screenshot" || asked === "console_logs") {
        const { action: _ignored, ...rest } = (input ?? {}) as Record<string, unknown>;
        return executeTool(batchTool(asked), rest, ctx);
      }
      const driven = await toolBrowserInteract(ctx.sessionId, input as BrowserInteractInput, await workspaceRootOf(ctx));
      return {
        success: driven.success,
        data: withBrowserNotes(driven, ctx),
        ...(driven.error ? { error: driven.error } : {}),
      };
    }
    case "browser_console_logs":
      return {
        success: true,
        data: await toolBrowserConsoleLogs(ctx.sessionId, (input ?? {}) as BrowserConsoleLogsInput),
      };
    case "browser_batch":
      return runBrowserBatch(input, ctx);
    case "fetch_url_content": {
      const result = await toolFetchUrlContent(input as FetchUrlContentInput, ctx.signal);
      return {
        success: result.ok,
        data: result,
        ...(result.ok ? {} : { error: result.error }),
      };
    }
    case "schedule_wakeup": {
      if (ctx.onScheduleWakeup) return ctx.onScheduleWakeup((input ?? {}) as Record<string, unknown>);
      return {
        success: false,
        error: "This session cannot be started again later from here. To wait for something within the hour, use wait (with process_id for a process).",
      };
    }
    case "research": {
      if (ctx.onResearch) return ctx.onResearch((input ?? {}) as Record<string, unknown>, ctx.callId);
      return runResearch((input ?? {}) as Record<string, unknown>, ctx.signal);
    }
    case "find_symbol_definition": {
      const graphed = await symbolFromGraph(ctx, input);
      if (graphed) return graphed;
      const result = await toolFindSymbolDefinition(
        input as FindSymbolDefinitionInput,
        ctx.workspaceId,
        ctx.sandboxRunner,
        ctx.lookupSymbol,
      );
      /*
       * "No definition found" is a fact, not a failure — but the model has to
       * be told which. Reporting an empty result as an unqualified success is
       * how an agent concludes a symbol does not exist when the search simply
       * did not reach it.
       */
      // `found` and `source` are set by the tool itself now — it knows which
      // mechanism answered, and the dispatcher does not.
      return { success: true, data: result };
    }
    case "find_symbol_references": {
      const graphed = await symbolFromGraph(ctx, input);
      if (graphed) return graphed;
      const result = await toolFindSymbolReferences(
        input as FindSymbolReferencesInput,
        ctx.workspaceId,
        ctx.sandboxRunner,
      );
      const found = Array.isArray(result.references) && result.references.length > 0;
      return {
        success: true,
        data: { ...result, found },
      };
    }

    case "view_image":
      return toolViewImage(input as ViewImageInput, ctx);

    case "ask_user": {
      type Ask = { question?: unknown; why?: unknown; options?: unknown; recommended?: unknown; recommended_because?: unknown };
      const raw = (input ?? {}) as Ask & { questions?: unknown };
      /*
       * Several questions at once (asked for 15 Oct 2026): put to the person
       * one after another, and every answer returned in one result, so the
       * agent pauses once for all of them. A `question` passed beside
       * `questions` is asked first.
       */
      const batch = [raw, ...(Array.isArray(raw.questions) ? (raw.questions as unknown[]) : [])]
        .filter((q): q is Ask => !!q && typeof q === "object" && typeof (q as Ask).question === "string" && !!String((q as Ask).question).trim())
        .slice(0, MAX_BATCHED_QUESTIONS);
      if (batch.length === 0) {
        return { success: false, error: "ask_user needs a 'question' (or several, as 'questions')." };
      }
      if (!ctx.onAskUser) {
        /*
         * No way to ask is not the same as a refusal.
         *
         * A surface without a person attached — an eval run, a scheduled job —
         * must not leave the agent waiting for an answer that cannot come.
         * Told plainly, the agent can state its assumption and carry on, which
         * is the correct behaviour for an unattended run.
         */
        return {
          success: false,
          data: { asked: false },
          error:
            "There is nobody to ask in this session. Decide it yourself using the best available " +
            "evidence, state the assumption you made in your summary, and carry on.",
        };
      }
      const answers: { question: string; answer: string }[] = [];
      try {
        /*
         * One question at a time, and back to the one before when the person
         * asks: it is put again with their earlier answer, and the answers
         * after it are kept to offer again in turn.
         */
        for (let index = 0; index < batch.length; ) {
          const ask = batch[index]!;
          const question = String(ask.question).trim();
          const listed = Array.isArray(ask.options)
            ? ask.options.map((o) => String(o)).filter(Boolean).slice(0, 6)
            : undefined;
          const { options, recommended } = recommendedOption(listed, ask.recommended);
          const because = typeof ask.recommended_because === "string" ? ask.recommended_because.trim() : "";
          const answer = await ctx.onAskUser({
            question,
            ...(ask.why ? { why: String(ask.why) } : {}),
            ...(options && options.length > 0 ? { options } : {}),
            ...(recommended !== undefined ? { recommended } : {}),
            ...(recommended !== undefined && because ? { recommendedBecause: because } : {}),
            ...(batch.length > 1 ? { index, total: batch.length } : {}),
            ...(answers[index] ? { previous: answers[index]!.answer } : {}),
          });
          if (answer === ASK_USER_BACK) {
            index = Math.max(0, index - 1);
            continue;
          }
          answers[index] = { question, answer };
          index++;
        }
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        return {
          success: false,
          data: answers.length > 0 ? { asked: true, answers } : { asked: false },
          error: `The question was not answered: ${msg}`,
        };
      }
      return answers.length === 1
        ? { success: true, data: { asked: true, question: answers[0]!.question, answer: answers[0]!.answer } }
        : { success: true, data: { asked: true, answers } };
    }

    case "remember":
    case "edit_memory":
    case "forget":
    case "recall":
      if (!ctx.onMemory) return { success: false, error: "Memory is not available in this session." };
      return ctx.onMemory(toolName, (input ?? {}) as Record<string, unknown>);

    case "update_task_state":
      if (!ctx.onTaskState) {
        return { success: false, error: "Task memory is not available in this session." };
      }
      return ctx.onTaskState((input ?? {}) as Record<string, unknown>);

    case "use_skill": {
      if (!ctx.onUseSkill) {
        return { success: false, error: "Skills are not available in this session." };
      }
      const args = (input ?? {}) as { name?: unknown; file?: unknown; copy_to?: unknown; overwrite?: unknown };
      const name = String(args.name ?? "").trim();
      if (!name) return { success: false, error: "use_skill needs a 'name'." };
      const file = typeof args.file === "string" && args.file.trim() ? args.file.trim() : undefined;
      const to = typeof args.copy_to === "string" && args.copy_to.trim() ? args.copy_to.trim() : undefined;
      if (to && !file) return { success: false, error: "copy_to needs the skill's 'file' to copy." };
      return ctx.onUseSkill(name, file, to ? { to, overwrite: args.overwrite === true } : undefined);
    }

    case "code_graph":
      if (!ctx.onCodeGraph) return { success: false, error: "The code graph is not available in this session; use grep_search and read_file." };
      return ctx.onCodeGraph((input ?? {}) as Record<string, unknown>);

    case "retrieve_context":
      if (!ctx.onRetrieveContext) {
        return { success: false, error: "Retrieval is not available in this session; use grep_search." };
      }
      return ctx.onRetrieveContext((input ?? {}) as Record<string, unknown>);

    case "subagent_status": {
      if (!ctx.onSubagentStatus) {
        return {
          success: false,
          data: { agents: [] },
          error: "Delegation is not available in this session, so there are no sub-agents to report on.",
        };
      }
      const statusInput = (input ?? {}) as { agent_id?: string; wait_for_all?: boolean };
      return ctx.onSubagentStatus(statusInput);
    }

    case "spawn_subagent": {
      const subInput = (input ?? {}) as {
        role?: string;
        task_prompt?: string;
        context_files?: unknown;
        done_when?: unknown;
        known?: unknown;
        out_of_scope?: unknown;
        wait?: boolean;
      };

      /*
       * A brief short enough to fit in a sentence is not a brief.
       *
       * A sub-agent sees only its brief — none of the parent's conversation,
       * files or reasoning — so "fix the tests" delegates the work of
       * rediscovering the entire context, which costs more than doing it
       * inline. The floor is a crude proxy for that and it holds up: every
       * delegation worth making has a goal, a definition of done and a scope.
       */
      const task = String(subInput.task_prompt ?? "");
      if (task.trim().length < 100) {
        return {
          success: false,
          data: { delegated: false },
          error:
            "A sub-agent sees only this brief, so it must stand alone: state the goal, what 'done' " +
            "looks like, and what to leave to you (at least 100 characters). For anything you could " +
            "do in a few tool calls, do it yourself.",
        };
      }

      if (!ctx.onSpawnSubagent) {
        return {
          success: false,
          data: { delegated: false },
          error:
            "Delegation is not available in this session. Do this part of the work yourself.",
        };
      }

      const contextFiles = Array.isArray(subInput.context_files)
        ? subInput.context_files.map((f) => String(f)).filter(Boolean)
        : undefined;

      try {
        return await ctx.onSpawnSubagent({
          role: String(subInput.role ?? "explorer"),
          taskPrompt: task,
          workspaceId: ctx.workspaceId,
          ...(contextFiles && contextFiles.length > 0 ? { contextFiles } : {}),
          ...(typeof subInput.done_when === "string" && subInput.done_when.trim() ? { doneWhen: subInput.done_when } : {}),
          ...(typeof subInput.known === "string" && subInput.known.trim() ? { known: subInput.known } : {}),
          ...(typeof subInput.out_of_scope === "string" && subInput.out_of_scope.trim() ? { outOfScope: subInput.out_of_scope } : {}),
          wait: subInput.wait === true,
        });
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        return { success: false, data: { delegated: false }, error: `Sub-agent failed: ${msg}` };
      }
    }

    default: {
      // Not one of ours: an MCP server's, if the host connected one by that name.
      const external = ctx.onExternalTool?.(toolName, (input ?? {}) as Record<string, unknown>, ctx.callId);
      if (external) return external;
      throw new ToolExecutionError(toolName, `Unknown tool: '${toolName}'.`);
    }
  }
}

/** The single-step tool each batch action is. */
function batchTool(action: string): string {
  if (action === "open") return "browser_open";
  if (action === "snapshot") return "browser_snapshot";
  if (action === "screenshot") return "browser_screenshot";
  if (action === "console_logs") return "browser_console_logs";
  return "browser_interact";
}

/**
 * Several browser steps, one result.
 *
 * Each step runs through the same arm a single call would, so every guard
 * those arms have (local files confined to the workspace, no cloud metadata
 * hosts, uploads only from the workspace) holds inside a batch too.
 *
 * Only the last page snapshot is kept: the earlier ones describe pages the
 * batch has already moved past, and twelve of them would be most of a
 * context window spent on history. Every screenshot is kept, labelled with
 * its step, because comparing them is usually why they were batched.
 */
async function runBrowserBatch(input: unknown, ctx: ToolExecutionContext): Promise<ToolResult> {
  const raw = (input ?? {}) as { steps?: unknown };
  const steps = Array.isArray(raw.steps) ? (raw.steps as Record<string, unknown>[]) : [];
  if (steps.length === 0) return { success: false, error: "browser_batch needs `steps`: a list of {action, ...}." };
  if (steps.length > MAX_BROWSER_BATCH_STEPS) {
    return { success: false, error: `A batch takes at most ${MAX_BROWSER_BATCH_STEPS} steps; split it in two.` };
  }

  const done: Record<string, unknown>[] = [];
  const images: NonNullable<ToolResult["images"]> = [];
  let lastPage: unknown;
  let failed: { step: number; action: string; error: string } | null = null;

  for (let i = 0; i < steps.length; i++) {
    if (ctx.signal?.aborted) {
      failed = { step: i + 1, action: String(steps[i]!["action"] ?? ""), error: "Stopped." };
      break;
    }
    const { action, ...rest } = steps[i]!;
    const name = String(action ?? "");
    if (!(BROWSER_BATCH_ACTIONS as readonly string[]).includes(name)) {
      failed = { step: i + 1, action: name, error: `Unknown action '${name}'. Use one of: ${BROWSER_BATCH_ACTIONS.join(", ")}.` };
      break;
    }
    const tool = batchTool(name);
    const result = await executeTool(tool, tool === "browser_interact" ? { ...rest, action: name } : rest, ctx);
    const data = (result.data ?? {}) as Record<string, unknown>;
    const record: Record<string, unknown> = { step: i + 1, action: name, ok: result.success };

    if (tool === "browser_interact") {
      if (data["result"]) record["result"] = data["result"];
      if (data["snapshot"]) lastPage = data["snapshot"];
    } else if (tool === "browser_snapshot") {
      if (data["page"]) lastPage = data["page"];
    } else if (tool === "browser_open") {
      record["url"] = data["url"];
      record["title"] = data["title"];
      record["status"] = data["status"];
    } else if (tool === "browser_screenshot") {
      record["url"] = data["url"];
      if (data["screenshotPath"]) record["saved"] = data["screenshotPath"];
      if (result.image) images.push({ ...result.image, source: `step ${i + 1} screenshot of ${String(data["url"] ?? "the page")}` });
    } else {
      record["logs"] = data["logs"];
    }
    if (Array.isArray(data["page_events"])) record["page_events"] = data["page_events"];
    done.push(record);

    if (!result.success) {
      failed = { step: i + 1, action: name, error: result.error ?? "It failed." };
      break;
    }
  }

  const skipped = failed ? steps.length - failed.step : 0;
  return {
    success: failed === null,
    data: {
      steps: done,
      ...(skipped > 0 ? { skipped: `${skipped} later step${skipped === 1 ? "" : "s"} did not run.` } : {}),
      ...(lastPage ? { page_now: lastPage } : {}),
    },
    ...(failed ? { error: `Step ${failed.step} (${failed.action}) failed: ${failed.error}` } : {}),
    ...(images.length > 0 ? { images } : {}),
  };
}

/** The old symbol tools, answered by the code graph where it has the name. */
async function symbolFromGraph(ctx: ToolExecutionContext, input: unknown): Promise<ToolResult | null> {
  const name = String((input as { symbol_name?: unknown } | null)?.symbol_name ?? "").trim();
  if (!ctx.onCodeGraph || !name) return null;
  const result = await ctx.onCodeGraph({ action: "symbol", name }).catch(() => null);
  return result?.success ? result : null;
}

/** "(Recommended)" written into an option itself, as some models do instead of naming it. */
const MARKED = /\s*[([]\s*recommended\s*[)\]]\s*$/i;

/**
 * Which of a question's options the agent recommends, by position.
 *
 * Named by its text, copied (nearly) exactly; by its number in the list as
 * shown, counting from 1; or marked "(Recommended)" in the option itself,
 * which is taken off the text the person sees. Anything that names no option
 * recommends none.
 */
export function recommendedOption(
  options: string[] | undefined,
  named: unknown,
): { options: string[] | undefined; recommended?: number } {
  if (!options || options.length === 0) return { options };
  let marked: number | undefined;
  const clean = options.map((o, i) => {
    if (!MARKED.test(o)) return o;
    marked ??= i;
    return o.replace(MARKED, "");
  });
  const simple = (s: string): string => s.replace(MARKED, "").trim().toLowerCase().replace(/[.!\s]+$/, "");
  let found: number | undefined;
  if (typeof named === "number" && Number.isInteger(named) && named >= 1 && named <= clean.length) found = named - 1;
  else if (typeof named === "string" && named.trim()) {
    const want = simple(named);
    const numbered = /^\d+$/.test(want) ? Number(want) : NaN;
    found = clean.findIndex((o) => simple(o) === want);
    if (found === -1) found = clean.findIndex((o) => simple(o).startsWith(want) || want.startsWith(simple(o)));
    if (found === -1 && numbered >= 1 && numbered <= clean.length) found = numbered - 1;
    if (found === -1) found = undefined;
  }
  const recommended = found ?? marked;
  return recommended === undefined ? { options: clean } : { options: clean, recommended };
}
