/**
 * SoreQen Code Tool Schema Definitions & Anthropic Tool Use Specifications
 * Production-Grade V2 Extended Suite (18 Tools including Autonomous Browser & AST Intelligence)
 */

import { z } from "zod";
import { TodoItemSchema } from "./models.js";

// 1. read_file
export const ReadFileInputSchema = z.object({
  path: z.string().describe("Relative path to the file inside the workspace"),
  start_line: z.number().int().positive().optional().describe("1-indexed starting line to read"),
  end_line: z
    .number()
    .int()
    .positive()
    .optional()
    .describe("1-indexed ending line to read (inclusive)"),
});
export type ReadFileInput = z.infer<typeof ReadFileInputSchema>;

// 2. edit_file
export const EditFileInputSchema = z.object({
  path: z.string().describe("Relative path to the file to edit"),
  old_str: z.string().describe("Exact substring in the file to replace. Must appear exactly once."),
  new_str: z.string().describe("Replacement string to insert in place of old_str"),
});
export type EditFileInput = z.infer<typeof EditFileInputSchema>;

// 3. write_file
export const WriteFileInputSchema = z.object({
  path: z.string().describe("Relative path to the file to create or overwrite"),
  content: z.string().describe("Complete contents to write to the file"),
  overwrite: z
    .boolean()
    .optional()
    .default(true)
    .describe("Whether to overwrite if file already exists"),
});
export type WriteFileInput = z.infer<typeof WriteFileInputSchema>;

// 4. list_directory
export const ListDirectoryInputSchema = z.object({
  path: z.string().optional().default(".").describe("Directory path relative to workspace root"),
  recursive: z
    .boolean()
    .optional()
    .default(false)
    .describe("Whether to list subdirectories recursively"),
  max_depth: z
    .number()
    .int()
    .positive()
    .optional()
    .default(3)
    .describe("Maximum depth when listing recursively"),
});
export type ListDirectoryInput = z.infer<typeof ListDirectoryInputSchema>;

// 5. grep_search
/*
 * `pattern` is taken for `query`: models trained on other agents' Grep send it
 * by that name, and a required `query` refused the call outright.
 */
export const GrepSearchInputSchema = z.preprocess(
  (value) =>
    value && typeof value === "object" && !("query" in value) && typeof (value as { pattern?: unknown }).pattern === "string"
      ? { ...(value as Record<string, unknown>), query: (value as { pattern: string }).pattern }
      : value,
  z.object({
    query: z.string().describe("Search string or pattern to look for"),
    path: z.string().optional().default(".").describe("Directory or file to search within"),
    /*
     * Unset means "as written": a query with `|`, `\b`, `.*` and the like is
     * searched as a pattern and as literal text, and a line matching either is a
     * match. A model writes `Hello Amazon|Hello AWS|Bedrock team` meaning any of
     * the three, and with a literal-only default that found nothing in a file
     * holding all three (18 Oct 2026). true or false is taken at its word.
     */
    is_regex: z
      .boolean()
      .optional()
      .describe("Whether query should be treated as a regex"),
    case_sensitive: z
      .boolean()
      .optional()
      .default(false)
      .describe("Whether search is case-sensitive"),
    /*
     * A single glob is accepted as well as a list.
     *
     * Models send `"includes": "*.html"` about as often as `["*.html"]`, and a
     * strict array rejected the call with a raw validation dump the agent then
     * had to read, apologise for and retry — a wasted step, and a "Failed" row in
     * the transcript for what was a perfectly clear request.
     */
    includes: z
      .preprocess(
        (value) =>
          typeof value === "string"
            ? value
                .split(",")
                .map((s) => s.trim())
                .filter(Boolean)
            : value,
        z.array(z.string()),
      )
      .optional()
      .describe("File glob patterns to include (e.g. ['*.ts'])"),
    /** `files`: only which files match, with counts. */
    output_mode: z
      .preprocess(
        (value) => (value === "files_with_matches" || value === "count" ? "files" : value),
        z.enum(["content", "files"]),
      )
      .optional()
      .describe("content (default): matching lines grouped by file; files: only the files, with match counts"),
  }),
);
export type GrepSearchInput = z.infer<typeof GrepSearchInputSchema>;

// 6. run_command
/** A foreground command's timeout when none is given, and the most it may ask for. */
export const DEFAULT_COMMAND_TIMEOUT_MS = 10 * 60_000;
export const MAX_COMMAND_TIMEOUT_MS = 10 * 60_000;

export const RunCommandInputSchema = z.object({
  command: z.string().describe("Shell command string to execute in the isolated workspace"),
  description: z
    .string()
    .max(160)
    .optional()
    .describe("What the command does in 3-10 words, shown to the user, e.g. 'Install dependencies'"),
  timeout_ms: z
    .number()
    .int()
    .positive()
    .optional()
    // Clamped rather than refused: a model asking for an hour gets the ceiling,
    // not an error it has to recover from.
    .transform((v) => Math.min(v ?? DEFAULT_COMMAND_TIMEOUT_MS, MAX_COMMAND_TIMEOUT_MS))
    .describe("Foreground timeout in milliseconds; at most 10 minutes"),
  run_in_background: z
    .boolean()
    .optional()
    .describe("Start it and return straight away; it runs until stopped or it exits"),
  /** The earlier name for `run_in_background`, still accepted. */
  is_background: z.boolean().optional(),
  cwd: z.string().optional().describe("Working directory relative to workspace root"),
  interactive: z
    .boolean()
    .optional()
    .describe("Run in a terminal so its prompts can be answered with send_process_input; always in the background"),
});
export type RunCommandInput = z.input<typeof RunCommandInputSchema>;

export const SendProcessInputInputSchema = z.object({
  process_id: z.string().describe("An interactive process started with run_command"),
  text: z.string().max(4_000).describe("What to type"),
  press_enter: z.boolean().optional().describe("Press Enter after the text (default true)"),
  wait_ms: z
    .number()
    .int()
    .min(0)
    .max(15_000)
    .optional()
    .describe("How long to wait for the program to react before returning its output (default 1500)"),
});
export type SendProcessInputInput = z.infer<typeof SendProcessInputInputSchema>;

// Processes: status, stop, wait
export const ProcessStatusInputSchema = z.object({
  process_id: z.string().optional().describe("A process id from run_command; omit to list every process"),
  tail_lines: z.number().int().positive().max(2000).optional().describe("Lines of latest output to return"),
});
export type ProcessStatusInput = z.infer<typeof ProcessStatusInputSchema>;

export const StopProcessInputSchema = z.object({
  process_id: z.string().describe("The process to stop"),
});
export type StopProcessInput = z.infer<typeof StopProcessInputSchema>;

/** The longest a single wait may last. */
export const MAX_WAIT_SECONDS = 60 * 60;

export const WaitInputSchema = z.object({
  seconds: z
    .number()
    .positive()
    .optional()
    .transform((v) => (v === undefined ? undefined : Math.min(v, MAX_WAIT_SECONDS)))
    .describe("How long to wait at most, up to 3600"),
  process_id: z.string().optional().describe("Wait for this process to exit"),
  until_output: z
    .string()
    .max(200)
    .optional()
    .describe("With process_id: stop waiting as soon as its output contains this text"),
});
export type WaitInput = z.input<typeof WaitInputSchema>;

/** `schedule_wakeup`: the session sleeps, and the runtime starts it again then. */
export const ScheduleWakeupInputSchema = z.object({
  in_minutes: z.number().min(1).max(1440).optional(),
  every_minutes: z.number().min(5).max(1440).optional(),
  times: z.number().int().min(1).max(500).optional(),
  note: z.string().max(4000).optional(),
  cancel: z.boolean().optional(),
  status: z.boolean().optional(),
  process_id: z.string().max(200).optional(),
});
export type ScheduleWakeupInput = z.infer<typeof ScheduleWakeupInputSchema>;

/** How a session's last schedule of checks ended, so the agent can be told and can ask. */
export interface WakeupStop {
  /** When it ended, ms since the epoch. */
  at: number;
  /** Who ended it: the person (from the app or the phone), or the agent itself. */
  by: "user" | "agent";
  /** The note the checks were for. */
  note: string;
}

/** A session's scheduled wake-up, as the runtime keeps it. */
export interface WakeupState {
  /** When the next check starts, ms since the epoch. */
  at: number;
  /** Minutes between checks, for a monitor; absent for a single wake-up. */
  every?: number;
  /** Checks still to run, counting the next. */
  remaining: number;
  note: string;
  /** Checks already run. */
  done: number;
  /** Background commands the checks watch: once all have ended, the checks stop by themselves. */
  watching?: string[];
}

// 7. run_tests
export const RunTestsInputSchema = z.object({
  test_filter: z
    .string()
    .optional()
    .describe("Optional pattern or test name filter to run specific tests"),
  framework: z
    .enum(["auto", "vitest", "jest", "pytest", "cargo", "npm"])
    .optional()
    .default("auto")
    .describe("Test framework runner to use"),
});
export type RunTestsInput = z.infer<typeof RunTestsInputSchema>;

// 8. git_operation
export const GitOperationInputSchema = z.object({
  operation: z
    .enum(["status", "diff", "log", "branch", "checkout", "commit", "push", "force_push"])
    .describe("Git operation to perform"),
  args: z
    .record(z.unknown())
    .optional()
    .describe("Arguments specific to the operation (e.g. commit message, branch name)"),
  confirmed: z
    .boolean()
    .optional()
    .describe("Explicit confirmation flag. Mandatory for push and force_push."),
});
export type GitOperationInput = z.infer<typeof GitOperationInputSchema>;

// 9. install_package
export const InstallPackageInputSchema = z.object({
  package_name: z
    .string()
    .describe("Name of the package to install, with optional version specifier"),
  package_manager: z
    .enum(["auto", "pnpm", "npm", "yarn", "pip"])
    .optional()
    .default("auto")
    .describe("Package manager to use"),
  is_dev: z
    .boolean()
    .optional()
    .default(false)
    .describe("Whether to install as a development dependency"),
});
export type InstallPackageInput = z.infer<typeof InstallPackageInputSchema>;

// 10. web_search
export const WebSearchInputSchema = z.object({
  query: z
    .string()
    .describe("Web search query to find documentation, error fixes, or library guides"),
  max_results: z
    .number()
    .int()
    .positive()
    .optional()
    .default(5)
    .describe("Maximum number of search results to return"),
});
export type WebSearchInput = z.infer<typeof WebSearchInputSchema>;

// 11. update_todo_list
export const UpdateTodoListInputSchema = z.object({
  items: z
    .array(TodoItemSchema)
    .describe("Complete updated checklist of tasks with their current statuses"),
});
export type UpdateTodoListInput = z.infer<typeof UpdateTodoListInputSchema>;

// 12. browser_open (V2 Autonomous Browser)
export const BrowserOpenInputSchema = z.object({
  url: z
    .string()
    .describe(
      "The URL or local HTML file path to open in the automated browser (e.g. http://localhost:3000 or index.html)",
    ),
  headless: z.boolean().optional().default(true).describe("Whether to run browser headlessly"),
  timeout_ms: z
    .number()
    .int()
    .positive()
    .optional()
    .default(30000)
    .describe("Navigation timeout in milliseconds"),
});
export type BrowserOpenInput = z.infer<typeof BrowserOpenInputSchema>;

// 13. browser_screenshot (V2 Visual Inspection)
export const BrowserScreenshotInputSchema = z.object({
  full_page: z
    .boolean()
    .optional()
    .default(false)
    .describe("Whether to take a full-page scroll screenshot"),
});
export type BrowserScreenshotInput = z.infer<typeof BrowserScreenshotInputSchema>;

// 14. browser_interact (V2 Web Interaction)
export const BROWSER_ACTIONS = [
  "click",
  "double_click",
  "type",
  "clear",
  "press_key",
  "select_option",
  "check",
  "uncheck",
  "hover",
  "scroll",
  "wait_for",
  "go_back",
  "go_forward",
  "reload",
  "upload",
  "resize",
] as const;

export const BrowserInteractInputSchema = z.object({
  action: z.enum(BROWSER_ACTIONS).describe("What to do"),
  ref: z.number().int().positive().optional().describe("Element number from the last browser_snapshot"),
  text: z.string().optional().describe("The element's visible name, when there is no ref"),
  selector: z.string().optional().describe("A CSS selector, when you genuinely know one"),
  value: z.string().optional().describe("Text to type, or the option to select"),
  key: z.string().optional().describe("Key to press: Enter, Tab, ArrowDown, Escape"),
  submit: z.boolean().optional().describe("After typing, press Enter"),
  direction: z.enum(["down", "up", "top", "bottom", "element"]).optional(),
  amount: z.number().int().optional().describe("Scroll distance in pixels"),
  until: z.enum(["text", "selector", "navigation", "idle"]).optional(),
  timeout_ms: z.number().int().positive().max(120_000).optional(),
  files: z
    .array(z.string())
    .max(10)
    .optional()
    .describe("For upload: workspace paths of the files to put in the file input"),
  width: z.number().int().min(200).max(4000).optional().describe("For resize: viewport width in pixels"),
  height: z.number().int().min(200).max(4000).optional().describe("For resize: viewport height in pixels"),
  device: z.enum(["mobile", "tablet", "desktop"]).optional().describe("For resize: a preset instead of width/height"),
});
export type BrowserInteractInput = z.infer<typeof BrowserInteractInputSchema>;

/**
 * 14a. browser_batch — several browser steps in one call.
 *
 * "Resize to mobile, open the contact page, take a screenshot" was three
 * round trips, each with a sentence of narration and a full re-read of the
 * conversation, for steps whose order the agent knew before the first one
 * ran. A batch runs them in order, stops at the first that fails, and comes
 * back once.
 */
export const BROWSER_BATCH_ACTIONS = ["open", "snapshot", "screenshot", "console_logs", ...BROWSER_ACTIONS] as const;
export const MAX_BROWSER_BATCH_STEPS = 12;

export const BrowserBatchInputSchema = z.object({
  steps: z
    .array(
      BrowserInteractInputSchema.omit({ action: true }).extend({
        action: z.enum(BROWSER_BATCH_ACTIONS),
        url: z.string().optional().describe("For open"),
        full_page: z.boolean().optional().describe("For screenshot"),
      }),
    )
    .min(1)
    .max(MAX_BROWSER_BATCH_STEPS),
});
export type BrowserBatchInput = z.infer<typeof BrowserBatchInputSchema>;
export type BrowserBatchStep = BrowserBatchInput["steps"][number];

/**
 * 14b. browser_snapshot — what is on the page, with a number for each thing
 * you can interact with.
 */
export const BrowserSnapshotInputSchema = z.object({
  include_text: z
    .boolean()
    .optional()
    .describe("Include the page's visible text as well as its elements (default true)"),
});
export type BrowserSnapshotInput = z.infer<typeof BrowserSnapshotInputSchema>;

// 15. browser_console_logs (V2 Frontend Diagnostics)
export const BrowserConsoleLogsInputSchema = z.object({
  clear_after_read: z
    .boolean()
    .optional()
    .default(false)
    .describe("Whether to clear logs after retrieving"),
});
export type BrowserConsoleLogsInput = z.infer<typeof BrowserConsoleLogsInputSchema>;

// 16. fetch_url_content (V2 Web Documentation Scraper)
export const FetchUrlContentInputSchema = z.object({
  url: z.string().url().describe("Web page or documentation URL to fetch and convert to Markdown"),
  max_length: z
    .number()
    .int()
    .positive()
    .optional()
    .default(10000)
    .describe("Maximum character length of content"),
});
export type FetchUrlContentInput = z.infer<typeof FetchUrlContentInputSchema>;

// research: several searches, the pages read, the passages that answer, numbered for citation
export const RESEARCH_DEPTHS = ["quick", "standard", "deep", "max"] as const;
export const ResearchInputSchema = z.object({
  question: z.string().min(3).describe("The question to research, in full"),
  queries: z.array(z.string()).max(8).optional().describe("2-6 search queries that come at it from different angles"),
  depth: z.enum(RESEARCH_DEPTHS).optional().default("standard"),
  max_sources: z.number().int().positive().max(16).optional(),
});
export type ResearchInput = z.infer<typeof ResearchInputSchema>;

// 17. find_symbol_definition (V2 AST Code Intelligence)
export const FindSymbolDefinitionInputSchema = z.object({
  symbol_name: z.string().describe("Name of the function, class, type, or interface to locate"),
  file_path: z.string().optional().describe("Optional file path hint to narrow down search"),
});
export type FindSymbolDefinitionInput = z.infer<typeof FindSymbolDefinitionInputSchema>;

// 18. find_symbol_references (V2 AST Usages Graph)
export const FindSymbolReferencesInputSchema = z.object({
  symbol_name: z
    .string()
    .describe("Name of the symbol whose references and call-sites should be found"),
  path: z.string().optional().default(".").describe("Directory or file to search across"),
});
export type FindSymbolReferencesInput = z.infer<typeof FindSymbolReferencesInputSchema>;

// 19. spawn_subagent (V2 Multi-Agent Delegation Swarm)
/**
 * The specialists a turn may delegate to.
 *
 * Kept as a plain string list rather than a `z.enum` of the eleven roles,
 * because `subagent-pool.ts` owns the canonical names and accepts near-misses
 * (`testing` for `tester`). Two enums for one vocabulary is one enum that
 * silently goes stale.
 */
export const SUBAGENT_ROLE_IDS = [
  "researcher",
  "explorer",
  "architect",
  "implementer",
  "debugger",
  "tester",
  "browser_auditor",
  "documenter",
  "code_reviewer",
  "performance_analyst",
  "security_auditor",
] as const;

export const SpawnSubAgentInputSchema = z.object({
  role: z.string().describe("Specialized role of the sub-agent"),
  task_prompt: z.string().describe("Specific sub-task instructions for the delegated agent"),
  context_files: z
    .array(z.string())
    .optional()
    .describe("Optional paths of relevant files to focus on"),
  done_when: z.string().optional().describe("The acceptance criteria: how the sub-agent knows it is finished"),
  known: z.string().optional().describe("What you have already established, so it is not re-derived"),
  out_of_scope: z.string().optional().describe("What the sub-agent must leave alone"),
  wait: z
    .boolean()
    .optional()
    .describe("Block until the sub-agent finishes. Default false: it runs beside your own work."),
});
export type SpawnSubAgentInput = z.infer<typeof SpawnSubAgentInputSchema>;

// 20. view_image — look at a picture, rather than decoding it as text
export const ViewImageInputSchema = z.object({
  path: z.string().describe("Workspace-relative path to an image file"),
});
export type ViewImageInput = z.infer<typeof ViewImageInputSchema>;

// 21. ask_user — the one sanctioned way to stop and ask a question
const OneQuestionSchema = z.object({
  question: z.string().min(1).max(2000).describe("The specific question to put to the user"),
  why: z.string().max(1000).optional().describe("Why the answer is needed before continuing"),
  options: z
    .array(z.string().min(1).max(200))
    .max(6)
    .optional()
    .describe("2-4 likely answers, phrased as the answers themselves; pass them whenever the answer is a choice"),
  recommended: z
    .union([z.string(), z.number()])
    .optional()
    .describe("The option you recommend, copied exactly from options"),
  recommended_because: z.string().max(400).optional().describe("Why you recommend it, in one clause"),
});
/** Questions asked together are put to the person one after another, and answered in one result. */
export const MAX_BATCHED_QUESTIONS = 4;
export const AskUserInputSchema = OneQuestionSchema.partial({ question: true }).extend({
  questions: z
    .array(OneQuestionSchema)
    .max(MAX_BATCHED_QUESTIONS)
    .optional()
    .describe("Several questions at once, shown to the user one after another; each answer comes back in one result"),
});
export type AskUserInput = z.infer<typeof AskUserInputSchema>;

// 22. subagent_status — what the delegated agents are doing right now
export const SubagentStatusInputSchema = z.object({
  agent_id: z
    .string()
    .optional()
    .describe("One sub-agent to report on. Omit for all of them."),
  wait_for_all: z
    .boolean()
    .optional()
    .describe("Block until every running sub-agent has finished, then report."),
});
export type SubagentStatusInput = z.infer<typeof SubagentStatusInputSchema>;

/**
 * Union of all tool input schemas
 */
export const ToolNameEnum = z.enum([
  "read_file",
  "edit_file",
  "write_file",
  "list_directory",
  "grep_search",
  "glob",
  "run_command",
  "run_tests",
  "git_operation",
  "install_package",
  "web_search",
  "update_todo_list",
  "browser_open",
  "browser_screenshot",
  "browser_interact",
  "browser_batch",
  "browser_snapshot",
  "browser_console_logs",
  "fetch_url_content",
  "research",
  "find_symbol_definition",
  "find_symbol_references",
  "spawn_subagent",
  "subagent_status",
  "view_image",
  "ask_user",
  "process_status",
  "stop_process",
  "send_process_input",
  "wait",
  "schedule_wakeup",
  "update_task_state",
  "retrieve_context",
  "code_graph",
  "use_skill",
  "remember",
  "edit_memory",
  "forget",
  "recall",
]);
export type ToolName = z.infer<typeof ToolNameEnum>;

/**
 * Anthropic-Compatible Tool Definition Structure
 */
export interface ToolDefinition {
  name: ToolName;
  description: string;
  input_schema: {
    type: "object";
    properties: Record<string, unknown>;
    required: string[];
  };
}

/**
 * Single Source of Truth: Anthropic Tool Definitions for all 18 SoreQen Code Tools
 */
export const SOREQEN_TOOL_DEFINITIONS: ToolDefinition[] = [
  {
    name: "read_file",
    description:
      "Read the contents of a file with optional line-range slicing. Always read a file before modifying it.",
    input_schema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Path to the file: relative to the project, or a full path anywhere on this computer" },
        start_line: { type: "integer", description: "1-indexed starting line number" },
        end_line: { type: "integer", description: "1-indexed ending line number (inclusive)" },
      },
      required: ["path"],
    },
  },
  {
    name: "edit_file",
    description:
      "Make an exact string replacement in a file. 'old_str' must be unique within the file. Fails loudly if 'old_str' is not found or occurs multiple times.",
    input_schema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Path to the file to edit: relative to the project, or a full path anywhere on this computer" },
        old_str: {
          type: "string",
          description: "Exact unique character sequence in the target file to replace",
        },
        new_str: { type: "string", description: "Replacement character sequence to insert" },
      },
      required: ["path", "old_str", "new_str"],
    },
  },
  {
    name: "write_file",
    description:
      "Create a new file, or replace an existing one in full. This is destructive: the previous contents are gone, including anything you did not read. For any file that already exists, prefer edit_file — it fails loudly on a bad match, where this silently succeeds at writing the wrong thing.",
    input_schema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Path to the file: relative to the project, or a full path anywhere on this computer" },
        content: { type: "string", description: "Complete file contents" },
        overwrite: {
          type: "boolean",
          description: "Whether to overwrite existing files (defaults to true)",
        },
      },
      required: ["path", "content"],
    },
  },
  {
    name: "list_directory",
    description:
      "List files and subdirectories within a directory, with recursive depth and gitignore filtering.",
    input_schema: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "Directory: relative to the project root (defaults to '.'), or a full path anywhere on this computer",
        },
        recursive: { type: "boolean", description: "Whether to list recursively" },
        max_depth: { type: "integer", description: "Maximum directory depth" },
      },
      required: [],
    },
  },
  {
    name: "grep_search",
    description:
      "Text search (ripgrep): matching lines grouped by file, with line numbers. Several things at once: 'a|b|c' finds lines with any of them. Many files: output_mode 'files'. A symbol's definition, uses or impact: code_graph.",
    input_schema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Text or regex. 'a|b' matches either; with is_regex unset, a pattern is also searched as literal text" },
        path: {
          type: "string",
          description: "Directory or file to search in: relative to the project root, or a full path anywhere on this computer (another project, D:\\work\\app)",
        },
        is_regex: { type: "boolean", description: "true: only as a regex; false: only as literal text. Leave unset normally" },
        case_sensitive: { type: "boolean", description: "Match case-sensitively" },
        includes: {
          type: "array",
          items: { type: "string" },
          description: "File glob filters (e.g. ['*.ts'] or ['src/**/*.tsx'])",
        },
        output_mode: {
          type: "string",
          enum: ["content", "files"],
          description: "content (default): the matching lines; files: only which files match, with counts",
        },
      },
      required: ["query"],
    },
  },
  {
    name: "glob",
    description:
      "Find files by name or path pattern, newest first — '**/*.ts', 'src/**/*.test.tsx', '*.{js,jsx}', 'README*'. A pattern without '/' matches file names at any depth. Respects .gitignore; skips node_modules, dist and other build output. Use it to find files; use grep_search to find text inside them.",
    input_schema: {
      type: "object",
      properties: {
        pattern: { type: "string", description: "Glob pattern, e.g. '**/*.ts' or 'src/components/*.tsx'" },
        path: {
          type: "string",
          description: "Directory to search in (default: the workspace root): relative, or a full path anywhere on this computer; the pattern is read from that directory",
        },
      },
      required: ["pattern"],
    },
  },
  {
    name: "run_command",
    description:
      "Run a shell command in the workspace. In the foreground it returns the command's output and exit code when it finishes, and is stopped after timeout_ms (default and maximum 10 minutes). With run_in_background: true it starts and returns a process_id straight away, and keeps running — dev servers, watchers, long builds — until you stop it with stop_process or it exits; read its output with process_status and wait for it with wait. The user can stop any command. Always give a short description. Prefer a purpose-built tool where one exists — grep_search over `grep`, read_file over `cat`, run_tests over a raw test command.",
    input_schema: {
      type: "object",
      properties: {
        command: { type: "string", description: "Shell command string to execute" },
        description: {
          type: "string",
          description: "What the command does in 3-10 words, shown to the user, e.g. 'Start the dev server'",
        },
        timeout_ms: {
          type: "integer",
          description: "Foreground timeout in milliseconds; default and maximum 600000 (10 minutes)",
        },
        run_in_background: {
          type: "boolean",
          description:
            "Start the command and return immediately with a process_id. Use for servers, watchers and anything that may take longer than 10 minutes.",
        },
        cwd: { type: "string", description: "Working directory relative to workspace root" },
        interactive: {
          type: "boolean",
          description:
            "Run it in a terminal, in the background, so questions it asks (a project name, 'Proceed? (y/N)') can be answered with send_process_input. Only for commands that must prompt; prefer non-interactive flags (--yes, --default, answers as arguments) when they exist.",
        },
      },
      required: ["command"],
    },
  },
  {
    name: "process_status",
    description:
      "See how a command started with run_command is doing: whether it is still running, its exit code, and its latest output. Without process_id, lists every process in this workspace.",
    input_schema: {
      type: "object",
      properties: {
        process_id: { type: "string", description: "The process id run_command returned; omit to list all" },
        tail_lines: { type: "integer", description: "Lines of latest output to return (default 80)" },
      },
      required: [],
    },
  },
  {
    name: "stop_process",
    description:
      "Stop a running process started with run_command, together with everything it started. Stop background servers you no longer need before you finish.",
    input_schema: {
      type: "object",
      properties: {
        process_id: { type: "string", description: "The process to stop" },
      },
      required: ["process_id"],
    },
  },
  {
    name: "update_task_state",
    description:
      "Record what you decided, found, suspect or plan in this session's task state — the working memory that survives when the conversation is compacted, and is shown back to you every step. It ends with the session: a preference or fact the user wants kept for future sessions goes to `remember` instead, when that tool is available. Use it for anything you would be sorry to rediscover: a decision and its reason, a fact with its evidence, a hypothesis before you test it, a failed approach and its error, the next steps. Kinds: constraint, decision, fact (needs `source`, e.g. 'src/auth.ts:40-58' or the command that showed it — without one it is kept as an observation), observation, hypothesis, failure, unknown, next_action. Update an entry by id (e12) when a hypothesis is confirmed or refuted, or an action is done; `all:next_action` (or any kind) updates every active entry of that kind at once. Failures, files changed and the user's constraints are recorded automatically. The state needs no tidying before you finish: stale entries do no harm.",
    input_schema: {
      type: "object",
      properties: {
        add: {
          type: "array",
          items: {
            type: "object",
            properties: {
              kind: {
                type: "string",
                enum: ["constraint", "decision", "fact", "observation", "hypothesis", "failure", "unknown", "next_action"],
              },
              text: { type: "string", description: "One claim, specific: names, paths, errors" },
              source: { type: "string", description: "Evidence: 'path:start-end', a command, or an artifact path" },
            },
            required: ["kind", "text"],
          },
        },
        update: {
          type: "array",
          items: {
            type: "object",
            properties: {
              id: { type: "string", description: "The entry id, e.g. e12 — or all:<kind> (e.g. all:next_action) for every active entry of that kind" },
              status: { type: "string", enum: ["confirmed", "refuted", "resolved", "done", "active"] },
              note: { type: "string", description: "Why — the evidence that confirmed or refuted it" },
            },
            required: ["id", "status"],
          },
        },
      },
      required: [],
    },
  },
  {
    name: "use_skill",
    description:
      "Load one of SoreQen's conditional skills — a focused checklist for a kind of work (frontend design, accessibility, data and schema changes, API contracts, performance, observability, tests, releases, dependencies, docs, product intent, async state) — before starting that part of the task. The SOREQEN SKILLS section of your instructions lists every skill and when to use it. Always-on skills are already in your instructions and need no loading. A skill with more files (references, examples, scripts) lists them when loaded; pass `file` to read one.",
    input_schema: {
      type: "object",
      properties: {
        name: { type: "string", description: "The skill's name as listed, e.g. frontend-design" },
        file: { type: "string", description: "Optional: one of the files the loaded skill listed, e.g. references/api.md" },
        copy_to: {
          type: "string",
          description:
            "Optional, with file: write that file into the project at this path, exactly as the skill has it, instead of reading it back to you (e.g. an engine or a starter to build on: file assets/starter.html, copy_to index.html). Use it whenever a skill says to copy one of its files; never retype a long file. It is a write, allowed and asked like write_file.",
        },
        overwrite: { type: "boolean", description: "With copy_to: replace a file already at that path." },
      },
      required: ["name"],
    },
  },
  {
    name: "code_graph",
    description:
      "The codebase as a graph, answered in one call instead of several reads and searches. action 'overview': the codebase's shape (directories, languages, the most depended-on files, entry points). 'file' + path: a file's declarations with line ranges, exports, imports, what imports it, and its tests — understand a file before (or instead of) reading all of it. 'symbol' + name (path optional): where it is declared, what uses it (file:line and the enclosing function), what it uses, its tests. 'impact' + name or path: everything a change reaches, transitively, and the tests to run. 'search' + query: declarations by name. Kept current as files change. Relationships are found by name through imports, so treat them as strong leads and read the code before relying on a subtle one.",
    input_schema: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["overview", "file", "symbol", "impact", "search"] },
        name: { type: "string", description: "A declared name: function, class, type, constant" },
        path: { type: "string", description: "A workspace-relative file path" },
        query: { type: "string", description: "For search: part of a name" },
        depth: { type: "integer", description: "For impact: how many steps out (default 3, max 5)" },
      },
      required: ["action"],
    },
  },
  {
    name: "retrieve_context",
    description:
      "Search the repository by meaning and structure, not only by exact text: ranks code by the words of your query, similar wording, the symbols it names, import relationships, recent changes and related tests, and says why each result was chosen. Returns locations and signatures; detail: 'code' also returns the code of the top results. Use it to find where something is handled before reading files; use grep_search for an exact string.",
    input_schema: {
      type: "object",
      properties: {
        query: { type: "string", description: "What you are looking for, in words or identifiers" },
        detail: { type: "string", enum: ["outline", "code"], description: "outline (default) or code for the top results" },
        limit: { type: "integer", description: "Results to return (default 8, max 20)" },
      },
      required: ["query"],
    },
  },
  {
    name: "send_process_input",
    description:
      "Type into an interactive process (one started with run_command interactive: true) — an answer to the question it is asking — and get back what it printed next. Read the prompt first with process_status; for a menu, type the choice's number or the text it asks for. Arrow keys: \u001b[A up, \u001b[B down.",
    input_schema: {
      type: "object",
      properties: {
        process_id: { type: "string", description: "The interactive process" },
        text: { type: "string", description: "What to type" },
        press_enter: { type: "boolean", description: "Press Enter after the text (default true)" },
        wait_ms: {
          type: "integer",
          description: "How long to wait for it to react before returning its output (default 1500, max 15000)",
        },
      },
      required: ["process_id", "text"],
    },
  },
  {
    name: "wait",
    description:
      "Pause without using tokens, then carry on. With process_id: wait until that process exits, or until its output contains until_output (for example 'ready on'), for at most `seconds` (default 600, or 180 with until_output). Without process_id: wait `seconds` (default 60), for instance before checking on something again. Every wait ends early if the user sends a message, and at most lasts 3600 seconds.",
    input_schema: {
      type: "object",
      properties: {
        seconds: { type: "number", description: "The longest to wait, up to 3600" },
        process_id: { type: "string", description: "Wait for this process" },
        until_output: {
          type: "string",
          description: "With process_id: return as soon as the output contains this text",
        },
      },
      required: [],
    },
  },
  {
    name: "schedule_wakeup",
    description:
      "End this turn and be started again later, by yourself, to check on something long-running: a model training, a deploy, a long build, a job on a server. " +
      "in_minutes: when to wake (1 to 1440). every_minutes: keep waking at that interval, as a monitor, until you cancel it or `times` checks have run. " +
      "note: what to check when you wake and how (the command, the log file, the URL, what counts as done or as a problem); you are given it back word for word. " +
      "cancel: true stops every scheduled wake-up of this session: call it as soon as what you were watching is finished, failed or no longer needed. " +
      "status: true changes nothing and says what is scheduled now (the person can stop your checks themselves; you are told when they do, and status says so too). " +
      "process_id: the background command being watched; the checks then stop by themselves once it has ended (with none given, the session's running background commands are watched). " +
      "After scheduling, end your turn with one short line saying when you will check next; you use no tokens while asleep. " +
      "The person can message at any time and that runs at once. For something that finishes within the hour, run it in the background and use wait with process_id instead.",
    input_schema: {
      type: "object",
      properties: {
        in_minutes: { type: "number", description: "Minutes from now to wake, 1 to 1440 (default: every_minutes, else 30)" },
        every_minutes: { type: "number", description: "Wake again at this interval after each check, 5 to 1440" },
        times: { type: "integer", description: "With every_minutes: the most checks to run (default 48)" },
        note: { type: "string", description: "What to check when you wake, and how" },
        cancel: { type: "boolean", description: "Stop every scheduled wake-up of this session" },
        status: { type: "boolean", description: "Only report what is scheduled now, and how the last schedule ended" },
        process_id: { type: "string", description: "The background command being watched: the checks stop by themselves when it ends" },
      },
      required: [],
    },
  },
  {
    name: "run_tests",
    description: "Run automated test suites with structured pass/fail analysis.",
    input_schema: {
      type: "object",
      properties: {
        test_filter: { type: "string", description: "Optional test file or test name pattern" },
        framework: {
          type: "string",
          enum: ["auto", "vitest", "jest", "pytest", "cargo", "npm"],
          description: "Test runner framework",
        },
      },
      required: [],
    },
  },
  {
    name: "git_operation",
    description:
      "Execute git operations (status, diff, log, branch, checkout, commit, push). Push and force_push strictly require confirmed=true.",
    input_schema: {
      type: "object",
      properties: {
        operation: {
          type: "string",
          enum: ["status", "diff", "log", "branch", "checkout", "commit", "push", "force_push"],
          description: "Git action",
        },
        args: { type: "object", description: "Operation parameters (e.g. message, branch)" },
        confirmed: {
          type: "boolean",
          description: "Explicit confirmation flag for push/force_push",
        },
      },
      required: ["operation"],
    },
  },
  {
    name: "install_package",
    description:
      "Install an external library or dependency with package manager detection and registry allowlist verification.",
    input_schema: {
      type: "object",
      properties: {
        package_name: { type: "string", description: "Package name to install" },
        package_manager: {
          type: "string",
          enum: ["auto", "pnpm", "npm", "yarn", "pip"],
          description: "Package manager to use",
        },
        is_dev: { type: "boolean", description: "Install as dev dependency" },
      },
      required: ["package_name"],
    },
  },
  {
    name: "web_search",
    description:
      "Search the web for API documentation, error troubleshooting, and technical references.",
    input_schema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Search query" },
        max_results: { type: "integer", description: "Max results to return" },
      },
      required: ["query"],
    },
  },
  {
    name: "update_todo_list",
    description: "Update the agent's task checklist to communicate progress live to the user.",
    input_schema: {
      type: "object",
      properties: {
        items: {
          type: "array",
          items: {
            type: "object",
            properties: {
              id: { type: "string" },
              title: { type: "string" },
              status: { type: "string", enum: ["pending", "in_progress", "completed", "failed"] },
            },
            required: ["id", "title", "status"],
          },
          description: "List of todo items with their updated status",
        },
      },
      required: ["items"],
    },
  },
  {
    name: "browser_open",
    description:
      "Navigate to a URL (such as a local dev server http://localhost:3000) in an automated Chromium browser and capture state.",
    input_schema: {
      type: "object",
      properties: {
        url: { type: "string", description: "Target URL to open and verify" },
        headless: {
          type: "boolean",
          description: "Whether to run browser headlessly (default: true)",
        },
        timeout_ms: { type: "integer", description: "Navigation timeout in milliseconds" },
      },
      required: ["url"],
    },
  },
  {
    name: "browser_screenshot",
    description:
      "Capture a visual screenshot and HTML DOM snapshot of the currently opened browser page for UI verification.",
    input_schema: {
      type: "object",
      properties: {
        full_page: { type: "boolean", description: "Whether to capture entire scrollable page" },
      },
      required: [],
    },
  },
  {
    name: "browser_snapshot",
    description:
      "Read the current page: its URL and title, every interactive element numbered, and its visible text. Take one BEFORE interacting and again after anything that changes the page. The numbers it returns are what you pass as `ref` to browser_interact — that is how you click a thing you have seen rather than a selector you guessed. Refs are valid until the next snapshot.",
    input_schema: {
      type: "object",
      properties: {
        include_text: {
          type: "boolean",
          description: "Include the page's visible text as well (default true)",
        },
      },
      required: [],
    },
  },
  {
    name: "browser_interact",
    description:
      "Drive the page: click, double_click, type, clear, press_key, select_option, check, uncheck, hover, scroll, wait_for, go_back, go_forward, reload, upload (put workspace `files` into a file input), resize (viewport `width`/`height` or `device`: mobile/tablet/desktop, to check a layout). Alerts and confirms are accepted automatically and reported; a link that opens a new tab switches to it. Say WHICH element with `ref` (a number from browser_snapshot — always prefer this), or `text` (its visible name), or `selector`. Every action waits for the page to settle and returns a fresh snapshot, so you see what changed without a second call. After a click that starts a navigation or opens something, use wait_for before asserting anything.",
    input_schema: {
      type: "object",
      properties: {
        action: {
          type: "string",
          enum: [...BROWSER_ACTIONS],
          description: "What to do",
        },
        ref: {
          type: "integer",
          description: "Element number from the last browser_snapshot. The reliable way to point at something.",
        },
        text: {
          type: "string",
          description: "The element's visible name, when you have no ref. Also the text to wait_for.",
        },
        selector: { type: "string", description: "A CSS selector, when you genuinely know one" },
        value: { type: "string", description: "Text to type, or the option to select" },
        key: { type: "string", description: "Key to press: Enter, Tab, ArrowDown, Escape" },
        submit: { type: "boolean", description: "After typing, press Enter" },
        direction: {
          type: "string",
          enum: ["down", "up", "top", "bottom", "element"],
          description: "For scroll. 'element' scrolls the referenced element into view.",
        },
        amount: { type: "integer", description: "Scroll distance in pixels (default: one viewport)" },
        until: {
          type: "string",
          enum: ["text", "selector", "navigation", "idle"],
          description: "For wait_for: what to wait for",
        },
        timeout_ms: { type: "integer", description: "How long to wait (default 15000)" },
        files: {
          type: "array",
          items: { type: "string" },
          description: "For upload: workspace paths of the files to attach",
        },
        width: { type: "integer", description: "For resize: viewport width in pixels" },
        height: { type: "integer", description: "For resize: viewport height in pixels" },
        device: {
          type: "string",
          enum: ["mobile", "tablet", "desktop"],
          description: "For resize: a preset viewport instead of width/height",
        },
      },
      required: ["action"],
    },
  },
  {
    name: "browser_batch",
    description:
      `Several browser steps in ONE call, run in order; use it whenever you already know the next steps (e.g. resize to mobile, open a page, screenshot, resize to desktop, screenshot). Each step is {action, ...that action's fields}: open (url), snapshot, screenshot (full_page), console_logs, or any browser_interact action with its usual fields (ref, text, selector, value, key, device, width, height, until, ...). Stops at the first failing step. Every screenshot is shown to you, labelled by step. Up to ${MAX_BROWSER_BATCH_STEPS} steps.`,
    input_schema: {
      type: "object",
      properties: {
        steps: {
          type: "array",
          maxItems: MAX_BROWSER_BATCH_STEPS,
          items: {
            type: "object",
            properties: { action: { type: "string", enum: [...BROWSER_BATCH_ACTIONS] } },
            required: ["action"],
          },
        },
      },
      required: ["steps"],
    },
  },
  {
    name: "browser_console_logs",
    description:
      "Retrieve browser console logs, JavaScript runtime errors, and network failures to diagnose frontend issues.",
    input_schema: {
      type: "object",
      properties: {
        clear_after_read: {
          type: "boolean",
          description: "Whether to clear logs after retrieving",
        },
      },
      required: [],
    },
  },
  {
    name: "fetch_url_content",
    description:
      "Fetch content from any documentation or web URL and convert HTML to clean Markdown for fast reading.",
    input_schema: {
      type: "object",
      properties: {
        url: { type: "string", description: "URL to fetch" },
        max_length: { type: "integer", description: "Max character length" },
      },
      required: ["url"],
    },
  },
  {
    name: "research",
    description:
      "Research a question on the web like an analyst: runs several searches, reads the best pages (in a real browser when needed), and returns the passages that answer it as numbered sources to cite [n]. " +
      "Use it for anything factual, current or comparative beyond a single lookup: library and API behaviour, versions, pricing, a bug's known causes, how others solved something, market or technical comparisons. " +
      "depth: quick (5 sources), standard (8), deep (several rounds that follow up on gaps, then a cited report; for open questions where thoroughness matters), max (the engine at full stretch: up to 5 rounds and 40 sources, a long cited report; for research the person will rely on).",
    input_schema: {
      type: "object",
      properties: {
        question: { type: "string", description: "The question, in full" },
        queries: { type: "array", items: { type: "string" }, description: "2-6 search queries from different angles (synonyms, the official name, the error text, 'X vs Y')" },
        depth: { type: "string", enum: ["quick", "standard", "deep", "max"], description: "Default standard" },
        max_sources: { type: "integer", description: "Sources to read and keep (default by depth)" },
      },
      required: ["question"],
    },
  },
  {
    name: "find_symbol_definition",
    description:
      "Locate the precise definition (function, class, type, interface, constant) in the codebase using AST/pattern matching.",
    input_schema: {
      type: "object",
      properties: {
        symbol_name: { type: "string", description: "Name of symbol to locate" },
        file_path: { type: "string", description: "Optional file path hint" },
      },
      required: ["symbol_name"],
    },
  },
  {
    name: "find_symbol_references",
    description:
      "Find every use of a symbol across the codebase, classified by what it is: " +
      "call, definition, import, type position, or bare mention. Occurrences inside " +
      "comments and string literals are counted separately and excluded from the " +
      "results, so the list is only real code. Returns byKind totals — use them to " +
      "size a rename before reading individual sites.",
    input_schema: {
      type: "object",
      properties: {
        symbol_name: { type: "string", description: "Symbol name to find references for" },
        path: { type: "string", description: "Root path to search within (default: '.')" },
      },
      required: ["symbol_name"],
    },
  },
  {
    name: "spawn_subagent",
    description:
      "Delegate one scoped sub-task to a specialist sub-agent. It starts immediately and runs BESIDE your own work — the call returns an id at once, not an answer, so carry straight on with anything that does not depend on the result. When it finishes, SoreQen hands you its report at your next step: you do not need to check on it. Pass wait: true only when you have nothing independent left to do. A sub-agent costs a full nested turn, so delegate work that needs a genuinely separate investigation — a wide search, an independent review, a verification pass — and never work you could do in two tool calls yourself. Delegation is capped at one level: a sub-agent cannot delegate again.",
    input_schema: {
      type: "object",
      properties: {
        role: {
          type: "string",
          enum: [...SUBAGENT_ROLE_IDS],
          description:
            "researcher (web/docs), explorer (map code), architect (design), implementer (make a change), debugger (root-cause a failure), tester (write/run tests), browser_auditor (drive and inspect a UI), documenter, code_reviewer (find what is wrong with a diff), performance_analyst, security_auditor",
        },
        task_prompt: {
          type: "string",
          description:
            "The task, written for a competent stranger: the goal, why it matters, the specific questions to answer or the exact change to make, and the names, paths, commands and error messages involved. The sub-agent never sees your conversation. The person's requirements, decisions, failed approaches and changed files are added for you from task memory.",
        },
        done_when: {
          type: "string",
          description:
            "The acceptance criteria, concretely: e.g. 'pnpm test passes for packages/api', 'every caller of getUser listed with file:line', 'the bug reproduced, root-caused and fixed'.",
        },
        known: {
          type: "string",
          description:
            "What you have already established that it would otherwise waste steps re-deriving: files already read and what they showed, hypotheses ruled out, the likely location.",
        },
        out_of_scope: {
          type: "string",
          description: "What it must not touch or spend time on: files, packages, or questions you are handling yourself.",
        },
        context_files: {
          type: "array",
          items: { type: "string" },
          description: "The files it should start from",
        },
        wait: {
          type: "boolean",
          description:
            "Block until it finishes. Default false — prefer false and keep working.",
        },
      },
      required: ["role", "task_prompt"],
    },
  },
  {
    name: "subagent_status",
    description:
      "Report on sub-agents you delegated to: what each is working on, whether it is still running, and the result of any that have finished. Rarely needed: a sub-agent's report is handed to you by itself when it finishes. Use it to see what one is doing now, or set wait_for_all when you have run out of independent work and genuinely need every result before continuing.",
    input_schema: {
      type: "object",
      properties: {
        agent_id: { type: "string", description: "One sub-agent to report on; omit for all" },
        wait_for_all: {
          type: "boolean",
          description: "Block until every running sub-agent has finished, then report",
        },
      },
      required: [],
    },
  },
  {
    name: "view_image",
    description:
      "Look at an image file in the workspace — a screenshot, a mockup, a diagram, a photo of an error. The picture is shown to you directly; do not use read_file on an image, which returns binary noise. Use this on any image a user attaches and on every screenshot you take before drawing a conclusion about what is on screen.",
    input_schema: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "Workspace-relative path to a PNG, JPEG, GIF, WebP, AVIF or BMP file",
        },
      },
      required: ["path"],
    },
  },
  {
    name: "ask_user",
    description:
      "Put a specific question to the user and wait for their answer. This is the only way to ask something mid-task: ordinary prose in your response does not pause the turn, so a question asked that way is never answered. Use it when you genuinely need a decision, a credential, access, or a choice between interpretations that would produce materially different work — and not for anything you could settle by reading the codebase, the configuration, or the documentation. Do all the work that does not depend on the answer first. Your progress, plan and context are preserved while you wait. Usually one question (question, options, recommended). When you genuinely have several, pass them together as questions instead: the user answers them one after another and every answer comes back in one result.",
    input_schema: {
      type: "object",
      properties: {
        question: {
          type: "string",
          description: "The question, specific and answerable in a sentence",
        },
        why: {
          type: "string",
          description: "Why you cannot settle this yourself — one clause",
        },
        options: {
          type: "array",
          items: { type: "string" },
          description:
            "2-4 short, distinct answers the user is most likely to give, each phrased as the answer itself. Shown as a numbered list they can pick from with one key; they can still type their own. Pass them whenever the answer is a choice — nearly always.",
        },
        recommended: {
          type: "string",
          description:
            "The option you would choose, copied exactly from options. Reason it out first: weigh each option against what you found in the work so far and the user's goal, then commit to one. Shown to the user marked Recommended. Pass it whenever you pass options.",
        },
        recommended_because: {
          type: "string",
          description: "Why that option, in one clause grounded in what you found (shown under it)",
        },
        questions: {
          type: "array",
          maxItems: MAX_BATCHED_QUESTIONS,
          description:
            "Instead of question: 2-4 questions you genuinely need answered now, each shaped like a single question (question, why, options, recommended, recommended_because). The user answers them one after another; you get every answer in one result.",
          items: {
            type: "object",
            properties: {
              question: { type: "string" },
              why: { type: "string" },
              options: { type: "array", items: { type: "string" } },
              recommended: { type: "string" },
              recommended_because: { type: "string" },
            },
            required: ["question"],
          },
        },
      },
      required: [],
    },
  },
];

/**
 * Which tools may run at the same time as their neighbours.
 *
 * ## Why this exists
 *
 * The agent loop executed every tool call in a plain `for` loop, one after the
 * other. A turn that reads five files therefore paid five sequential round
 * trips into the sandbox for work that has no ordering requirement at all.
 * That is the single largest avoidable latency in a turn, and on the hosted
 * surface it is also billed wall-clock time.
 *
 * ## The rule
 *
 * A tool is parallel-safe only if running it cannot change what another tool
 * in the same batch observes. That means **reads of state nobody in the batch
 * is writing**. Everything that mutates the workspace, the browser, the
 * process table or the agent's own bookkeeping stays sequential — not because
 * concurrency would be slow, but because the model asked for those *in an
 * order*, and honouring that order is the whole contract.
 *
 * The conservative direction is deliberate. A wrongly-parallel write is a
 * corrupted file or a lost edit, found later and hard to attribute; a wrongly
 * sequential read costs a few hundred milliseconds. Those are not comparable,
 * so the list only grows on evidence.
 *
 * `browser_screenshot` and `browser_console_logs` read a live browser, which
 * another call in the batch could be driving — so they are only safe because
 * `browser_open` and `browser_interact`, the two that drive it, are not.
 */
export const PARALLEL_SAFE_TOOLS: ReadonlySet<string> = new Set([
  "read_file",
  "code_graph",
  "list_directory",
  "grep_search",
  "glob",
  "find_symbol_definition",
  "find_symbol_references",
  "fetch_url_content",
  "web_search",
  "research",
  "browser_screenshot",
  "browser_console_logs",
  "browser_snapshot",
  "process_status",
  "view_image",
]);

/** True when `name` may run concurrently with other parallel-safe calls. */
export function isParallelSafe(name: string): boolean {
  return PARALLEL_SAFE_TOOLS.has(name);
}
