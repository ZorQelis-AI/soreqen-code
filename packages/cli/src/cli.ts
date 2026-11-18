/**
 * SoreQen Terminal CLI Implementation
 * Production-Grade V2 Interactive Agent REPL with Rich Markdown Formatting & Case-Insensitive Subcommands
 */

import readline from "node:readline";
import { Command } from "commander";
import chalk from "chalk";
import { LocalSandboxRunner, projectDataPath } from "@sqcode/sandbox-runner";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import {
  SoreQenOrchestrator,
  OpenAICompatibleProvider,
  AnthropicProvider,
  MemoryManager,
  MemoryStore,
  MEMORY_TIDY_PROMPT,
  memorySlug,
  runMemoryTool,
  otherProjectMemories,
  listCheckpoints,
  buildRepoMap,
  restoreCheckpoint,
  setAuditSink,
  shortId,
  clampTier,
  estimateHistoryTokens,
  summarizeHistory,
  ContextEngine,
  providerForEndpoint,
  newGoal,
  goalKickoff,
  goalContinuation,
  afterGoalTurn,
  goalOf,
  goalStatusText,
  titleSourceOf,
  GOAL_TURN_PREFIX,
  type GoalTurnOutcome,
  readProviders,
  customEndpoints,
  type Checkpoint,
  type LLMProvider,
  type PrefixSeal,
} from "@sqcode/orchestrator";
import {
  AGENT_MODES,
  DEFAULT_EFFORT,
  DEFAULT_MODE,
  EFFORT,
  MODE_ORDER,
  PLATFORM_EFFORTS,
  OUTPUT_STYLE,
  OUTPUT_STYLES,
  effectiveCompactTokens,
  contextWindowFor,
  describeAutoCompact,
  formatTokenCount,
  listEfforts,
  modeForTier,
  modelList,
  parseAutoCompact,
  parseEffort,
  parseMode,
  parseOutputStyle,
  registerContextWindow,
  tierForMode,
  type AgentMode,
  type ContextUsage,
  type Effort,
  type GoalState,
  type OutputStyle,
  type PermissionTier,
  type StreamEvent,
  type TodoItem,
} from "@sqcode/shared";
import type { LLMMessage } from "@sqcode/orchestrator";
import { loadCliConfig, MissingApiKeyError, MissingModelError, OWN_KEY_PROVIDERS, type CliConfig } from "./config.js";
import {
  HOSTED_PREFIX,
  LoginError,
  SignedOutError,
  clearAccount,
  describeUsage,
  deviceLogin,
  fetchFlexModels,
  fetchHostedModels,
  startBurst,
  fetchUsage,
  hostedEntries,
  hostedBaseURL,
  loadAccount,
  logout,
  maskKey,
  soreqenUrl,
  writeUserEnv,
  type HostedModel,
  type Usage,
} from "./account.js";
import { ask, listProviderModels, loadUserConfig, runSetup, saveUserConfig, setupOwnKey, setupSignIn } from "./setup.js";
import {
  describeMcp,
  describePrompts,
  describeSkills,
  fillPrompt,
  openMcp,
  progressDetail,
  setSkillEnabled,
  skillOptions,
  soreqenHome,
} from "./extensions.js";
import { packageInfo, runUpdate, updateNotice } from "./self-update.js";
import { join, resolve as resolvePath } from "node:path";
import {
  activityLabel,
  createLiveLine,
  formatBytes,
  formatDuration,
  renderBanner,
  renderContext,
  renderContextEngine,
  renderToolStart,
  renderToolResult,
  renderDiff,
  renderTodoList,
  promptConfirmation,
  resetToolCallTracking,
} from "./ui.js";
import { formatTerminalMarkdown } from "./markdown-renderer.js";
import { BAR, COMMANDS, createPromptFrame, matchCommands, promptStatus, shortcutLines } from "./welcome.js";

/** An effort the CLI offers: the five platform tiers. Apex is not one of them. */
function cliEffort(raw: string): Effort | null {
  const parsed = parseEffort(raw);
  return parsed && (PLATFORM_EFFORTS as readonly string[]).includes(parsed) ? parsed : null;
}

/** `--print`'s exit code for how its one turn ended. */
export function printExitCode(stopReason: GoalTurnOutcome["stopReason"]): number {
  switch (stopReason) {
    case "completed":
      return 0;
    case "cancelled":
      return 130;
    case "max_iterations":
    case "token_budget_exhausted":
      return 2;
    default:
      return 1;
  }
}
import { userInfo } from "node:os";
import { createSerialQueue } from "./serial-queue.js";
import { createInputRouter, type InputRouter } from "./input-router.js";
import { c, effortStyle, glyph, modeStyle, rule, tierStyle } from "./theme.js";
import { clearSession, describeAge, loadSession, saveSession } from "./session-store.js";
import { appendAuditRecord, auditPathFor } from "./audit-file.js";
import { discoverContextWindows, findModel, parseModelCatalogue, setModelDirectoryCache } from "@sqcode/orchestrator";
import { fromProjectEnv, loadEnvFiles } from "./config.js";
import { attachToPrompt } from "./attach.js";

interface LaunchOptions {
  model?: string;
  apiKey?: string;
  baseUrl?: string;
  /** The mode to start in. `--tier` is still accepted and treated as the
   *  workspace ceiling, which is what it has always meant. */
  mode?: string;
  effort?: string;
  tier?: string;
  workspace?: string;
  print?: boolean;
}

async function startAgentSession(
  promptArgs: string[],
  opts: LaunchOptions,
): Promise<void> {
  // Normalize promptArgs if user typed `soreqen Code` or `soreqen code`
  let effectiveArgs = [...promptArgs];
  if (effectiveArgs.length > 0 && effectiveArgs[0]?.toLowerCase() === "code") {
    effectiveArgs = effectiveArgs.slice(1);
  }

  /*
   * A configuration problem is not a crash.
   *
   * `loadCliConfig` throws when no key is set — deliberately, since the
   * alternative was the hardcoded fallback that silently billed one account
   * for everybody. But an unhandled throw prints a Node stack trace, which
   * buries the one line that tells someone what to do. The error already
   * carries good guidance; this just gets out of its way.
   */
  // Keys and the model catalogue, from wherever they live — see `loadEnvFiles`.
  loadEnvFiles();

  /*
   * How this session reaches a model: a SoreQen account (plan credit), the
   * person's own key, or both. With neither, and someone at the terminal, it
   * asks — see `setup.ts`. Without a terminal (`--print`, a pipe) there is
   * nobody to ask, so it says what to configure and stops.
   */
  const interactive = !opts.print && Boolean(process.stdin.isTTY);
  const exitWith = (message: string): never => {
    console.error(chalk.red.bold("\n  SoreQen Code is not configured.\n"));
    console.error(message.split("\n").map((l) => `  ${l}`).join("\n"));
    console.error("");
    process.exit(1);
  };
  const tryConfig = (): CliConfig | null => {
    try {
      return loadCliConfig({
        apiKey: opts.apiKey,
        baseURL: opts.baseUrl,
        model: opts.model,
        permissionTier: opts.tier as PermissionTier,
        workspacePath: opts.workspace,
      });
    } catch (err: unknown) {
      if (err instanceof MissingApiKeyError) return null;
      if (err instanceof MissingModelError) return exitWith(err.message);
      throw err;
    }
  };

  let account = loadAccount();
  let setupModel: string | undefined;
  let ownConfig = tryConfig();
  // Providers added in the app's Settings count as configured: see the catalogue below.
  const handAdded = customEndpoints(readProviders(join(soreqenHome(), "providers.json")), process.env);
  if (!ownConfig && !account && handAdded.length === 0) {
    if (!interactive) exitWith(new MissingApiKeyError().message);
    const done = await runSetup();
    account = done.account ?? loadAccount();
    setupModel = done.model;
    ownConfig = tryConfig();
  }

  /*
   * The plan's hosted models, when signed in. Asked once at start: which
   * models the plan has, and whether its windows have room. A token revoked
   * on soreqen.com is forgotten here with a line saying so; being offline is
   * not the same thing, and keeps the token.
   */
  let hostedModels: HostedModel[] = [];
  let hostedUsage: Usage | null = null;
  if (account) {
    try {
      [hostedUsage, hostedModels] = await Promise.all([fetchUsage(account), fetchHostedModels(account)]);
    } catch (err) {
      if (err instanceof SignedOutError) {
        clearAccount();
        account = null;
        console.log(chalk.yellow(`\n  ${err.message}\n`));
      } else {
        console.log(chalk.yellow(`\n  Could not reach ${soreqenUrl()} for your plan's models; using your own keys for now.\n`));
      }
    }
  }
  const hostedReady = Boolean(account && hostedUsage?.hosted && hostedModels.length > 0);

  let config: CliConfig;
  if (ownConfig) {
    config = ownConfig;
  } else if (!hostedReady && handAdded[0]) {
    // Only a hand-added provider: its first model, through its own endpoint (see `turnModel`).
    const first = handAdded[0];
    config = {
      apiKey: first.apiKey,
      baseURL: first.baseURL,
      model: first.id,
      provider: "openai",
      permissionTier: (opts.tier as PermissionTier) || "guarded_autonomy",
      workspacePath: resolvePath(opts.workspace || process.cwd()),
    };
  } else if (hostedReady && account) {
    config = {
      apiKey: account.token,
      baseURL: hostedBaseURL(account),
      model: `${HOSTED_PREFIX}${(hostedModels.find((m) => m.default) ?? hostedModels[0])!.id}`,
      provider: "soreqen",
      permissionTier: (opts.tier as PermissionTier) || "guarded_autonomy",
      workspacePath: resolvePath(opts.workspace || process.cwd()),
    };
  } else {
    if (hostedUsage && !hostedUsage.hosted) {
      console.log(`\n  ${chalk.dim(`Signed in as ${account?.email ?? "you"} on ${hostedUsage.plan}: this account has no hosted models right now.`)}`);
    }
    if (!interactive) exitWith(new MissingApiKeyError().message);
    setupModel = await setupOwnKey();
    config = tryConfig() ?? exitWith(new MissingApiKeyError().message);
  }

  /*
   * A key the project's own `.env` supplied is used only when the person has
   * none of their own (see `envFileCandidates`), and said so: a repository
   * someone cloned could carry a key whose account logs every prompt.
   */
  const projectKey = OWN_KEY_PROVIDERS.find((p) => p.id === config.provider)?.keyVars.find((v) => fromProjectEnv.has(v) && process.env[v] === config.apiKey);
  if (projectKey) {
    console.log(chalk.yellow(`
  Using ${projectKey} from this folder's .env, not your own keys. Put yours in ~/.soreqen/.env to use it instead.
`));
  }

  // Initialize LLM Provider
  let llmProvider: LLMProvider;
  if (config.provider === "anthropic" && process.env.ANTHROPIC_API_KEY) {
    llmProvider = new AnthropicProvider({
      apiKey: config.apiKey,
      defaultModel: config.model,
    });
  } else {
    llmProvider = new OpenAICompatibleProvider({
      apiKey: config.apiKey,
      baseURL: config.baseURL,
      defaultModel: config.model,
    });
  }

  // Initialize Sandbox in target working directory
  const sandboxRunner = new LocalSandboxRunner(config.workspacePath);
  const workspaceId = "local_cwd";
  await sandboxRunner.createWorkspace(workspaceId, {
    storagePath: config.workspacePath,
    // SoreQen's own files go in ~/.soreqen/projects/, not in the project.
    dataPath: projectDataPath(config.workspacePath, soreqenHome()),
  });

  /*
   * What SoreQen remembers: global, this folder's, and other projects' to
   * read. The same memory as the desktop app's. Read fresh each time, so a
   * memory the app saved shows here on the next turn.
   */
  const cliMemory = (): MemoryStore => {
    const projectMemory = join(projectDataPath(config.workspacePath, soreqenHome()), "memory");
    return new MemoryStore({
      user: join(soreqenHome(), "memory"),
      project: projectMemory,
      projectFolder: config.workspacePath,
      others: otherProjectMemories(join(soreqenHome(), "projects"), projectMemory),
    });
  };

  /*
   * The audit trail goes to a local file, not to Postgres.
   *
   * See `audit-file.ts`. Without this, a stale `DATABASE_URL` turns every tool
   * call into a Prisma stack trace on stderr and every turn into a red
   * "the trail for this turn is incomplete" — a working session that looks
   * broken, and a warning the user is being trained to ignore.
   */
  setAuditSink((entry) =>
    appendAuditRecord(config.workspacePath, {
      workspaceId: entry.workspaceId,
      sessionId: entry.sessionId,
      action: entry.action,
      actorType: entry.actorType,
      detail: entry.detail,
    }),
  );

  const orchestrator = new SoreQenOrchestrator({
    sandboxRunner,
    llmProvider,
  });

  /*
   * MCP servers: the person's own and, once they agree, the project's.
   * Connected once for the session, and closed on every way out — on Windows
   * a child process outlives the one that started it, so a server left open
   * would still be running after SoreQen quit.
   */
  const mcpHub = await openMcp(config.workspacePath, interactive);
  const closeMcp = (): Promise<void> => mcpHub.close().catch(() => undefined);

  /** Kept across launches with the conversation it names: the task memory
   *  in `.soreqen/state/` is filed under it. */
  let sessionId = `cli_session_${Date.now()}`;
  let currentTier: PermissionTier = config.permissionTier;
  /*
   * The model to start on: the command line, then what setup just chose, then
   * the saved default, then the plan's first hosted model, then the own key's.
   * A session saved in this directory has its say after this, below.
   */
  const firstHosted = hostedReady ? `${HOSTED_PREFIX}${(hostedModels.find((m) => m.default) ?? hostedModels[0])!.id}` : undefined;
  let currentModel = opts.model ?? setupModel ?? loadUserConfig().model ?? firstHosted ?? config.model;

  /*
   * Models this machine is configured to reach, and a provider for each.
   *
   * `/model` used to change a string and nothing else, so switching to a
   * model served by a *different* endpoint sent that name to the current one
   * — `deepseek-flash` to OpenCode — and failed with the wrong provider's
   * "unknown model". A catalogue model now brings its own endpoint and key.
   * Providers are kept per model so a switch back reuses one, which keeps the
   * endpoint's prompt cache warm.
   */
  const catalogue = parseModelCatalogue(process.env);
  /*
   * The plan's hosted models first, under their own prefix (`soreqen/…`) so
   * they can never be confused with a same-named model on a key the person
   * brought. Then the own key's model, when the catalogue does not already
   * list it, so `/model` shows everything that can actually be reached.
   */
  if (account && hostedReady) {
    const hosted = hostedEntries(account, hostedModels, await fetchFlexModels(account).then((f) => f.models).catch(() => []));
    for (const h of hosted) if (h.contextWindow) registerContextWindow(h.id, h.contextWindow);
    catalogue.unshift(...hosted);
  }
  /*
   * Providers added by hand in the desktop app's Settings (Gemini, Groq,
   * Ollama…), from `~/.soreqen/providers.json` with their keys from
   * `~/.soreqen/.env`. Before 13 Nov 2026 only the app read that file.
   */
  for (const e of handAdded) {
    if (!findModel(catalogue, e.id)) catalogue.push(e);
  }
  /*
   * `--base-url` on the command line names the endpoint outright, so it wins
   * over a same-named model from the environment's catalogue. Before 18 Nov
   * 2026 it lost: with OPENCODE_MODEL listing mimo-v2.6-flash,
   * `--base-url http://localhost:… -m mimo-v2.6-flash` still went to OpenCode
   * with the environment's key.
   */
  if (ownConfig && opts.baseUrl && ownConfig.provider !== "anthropic") {
    for (let hit = findModel(catalogue, ownConfig.model); hit; hit = findModel(catalogue, ownConfig.model)) catalogue.splice(catalogue.indexOf(hit), 1);
  }
  if (ownConfig && ownConfig.provider !== "anthropic" && ownConfig.baseURL && !findModel(catalogue, ownConfig.model)) {
    catalogue.push({
      id: ownConfig.model,
      label: `${ownConfig.model} · your key`,
      upstreamModel: ownConfig.model,
      baseURL: ownConfig.baseURL,
      apiKey: ownConfig.apiKey,
    });
  }
  /**
   * Bring the catalogue in line with the account: hosted models out, then back
   * in if signed in with a plan that has them. Returns how many were added.
   * A session on a hosted model that is no longer reachable moves to the own
   * key's model, and says so.
   */
  const applyAccount = async (): Promise<number> => {
    for (let i = catalogue.length - 1; i >= 0; i--) if (catalogue[i]!.id.startsWith(HOSTED_PREFIX)) catalogue.splice(i, 1);
    let added = 0;
    if (account) {
      try {
        const [usage, models, flex] = await Promise.all([fetchUsage(account), fetchHostedModels(account), fetchFlexModels(account)]);
        if (usage.hosted) {
          const entries = hostedEntries(account, models, flex.models);
          catalogue.unshift(...entries);
          added = entries.length;
        }
      } catch {
        // Offline or refused: the own keys still work.
      }
    }
    for (const p of [...catalogueProviders.keys()]) if (p.startsWith(HOSTED_PREFIX)) catalogueProviders.delete(p);
    if (currentModel.startsWith(HOSTED_PREFIX) && !findModel(catalogue, currentModel)) {
      const fallback = catalogue.find((m) => m.id.startsWith(HOSTED_PREFIX))?.id ?? ownConfig?.model;
      if (fallback) {
        currentModel = fallback;
        console.log(`  ${c.muted(`Now using ${fallback}.`)}`);
      } else {
        console.log(`  ${c.danger(glyph.fail)} ${c.text("No model left to use: add your own key with `soreqen setup`, or /login again.")}`);
      }
    }
    return added;
  };

  // Learn each model's real context window from its provider, in the background.
  setModelDirectoryCache(join(soreqenHome(), "cache", "models-dev.json"));
  void discoverContextWindows(catalogue);
  const catalogueProviders = new Map<string, LLMProvider>();
  const turnModel = (): { model: string; llmProvider?: LLMProvider; contextWindow?: number } => {
    const endpoint = findModel(catalogue, currentModel);
    if (!endpoint) return { model: currentModel };
    let provider = catalogueProviders.get(endpoint.id);
    if (!provider) {
      provider = providerForEndpoint({
        apiKey: endpoint.apiKey,
        baseURL: endpoint.baseURL,
        defaultModel: endpoint.upstreamModel,
        sessionId,
        ...(endpoint.protocol ? { protocol: endpoint.protocol } : {}),
        ...(endpoint.headers ? { headers: endpoint.headers } : {}),
      });
      catalogueProviders.set(endpoint.id, provider);
    }
    // The window the catalogue states wins over the name table (a hosted model's, capped below its price step).
    return { model: endpoint.upstreamModel, llmProvider: provider, ...(endpoint.contextWindow ? { contextWindow: endpoint.contextWindow } : {}) };
  };

  /*
   * Whether a ceiling was actually asked for.
   *
   * This is the fix for a bug that made `/mode bypass` do nothing. A tier is
   * the *workspace's* ceiling — a fact about where the agent is running, which
   * a session may not raise. On a server that is real: the workspace was
   * provisioned read-only and no client gets to argue. On a laptop it is not.
   * The CLI runs on the user's own machine against their own files, and there
   * is no authority above them to set a ceiling in the first place.
   *
   * But `config.permissionTier` defaults to `guarded_autonomy`, and the CLI
   * sent it on every turn as though it were one. The orchestrator clamps mode
   * against tier — correctly — so bypass (whose tier is `full_autonomy`) was
   * clamped to `guarded_autonomy`, and a clamped mode is recomputed from the
   * clamped tier: `auto`. Selecting Bypass silently gave you Auto, while the
   * banner cheerfully said "Bypass".
   *
   * So the ceiling is now sent only when somebody actually named one, with
   * `--tier` or `/tier`. Absent that, the mode alone decides, which is what
   * choosing a mode is supposed to mean.
   */
  let tierExplicitlySet = opts.tier !== undefined;

  /*
   * Mode and effort, which is what a person actually chooses.
   *
   * `--tier` still works and still means what it always did: the ceiling this
   * session may not exceed. The mode sits under it and is clamped by the
   * orchestrator, so `--mode bypass --tier read_only` is a read-only session
   * rather than an argument about which flag wins.
   */
  let currentMode: AgentMode = opts.mode ? (parseMode(opts.mode) ?? DEFAULT_MODE) : DEFAULT_MODE;
  let currentEffort: Effort = opts.effort ? (cliEffort(opts.effort) ?? DEFAULT_EFFORT) : DEFAULT_EFFORT;

  /** The most recent turn's checkpoint, so `/rewind` with no argument means
   *  "undo the last thing you did". */
  let lastCheckpoint: Checkpoint | null = null;
  /** Whether this workspace can be snapshotted at all. Established by the
   *  first turn; assumed true until then, since assuming otherwise would put a
   *  warning on the banner of every session that has not started yet. */
  let checkpointsWork = true;
  /** Carried between turns so the conversation prefix stays cacheable. */
  let prefixSeal: PrefixSeal | null = null;

  /** How the agent writes its replies. */
  let currentStyle: OutputStyle = "default";
  /** When the conversation compacts itself: a percentage of the window, a
   *  token count, or null for the default. See `context-window.ts`. */
  let autoCompactSetting: number | null = null;
  /** The context window as of the last model request, for `/context`. */
  let lastContext: ContextUsage | null = null;
  /** The context engine's latest report, for `/context`. */
  let lastContextDebug: Record<string, unknown> | null = null;
  /** `/compact` typed during a turn: done at the agent's next step. */
  let compactRequested = false;
  /**
   * Lines typed while the agent works.
   *
   * Not refused and not queued behind the turn: the running turn reads them at
   * its next step, between tool calls, so a person can add to or redirect a
   * task twenty steps in without stopping it.
   */
  const inbox: { id: string; text: string }[] = [];
  let inboxSeq = 0;

  /*
   * The conversation, carried between turns.
   *
   * The REPL used to call `runTurn` with no history at all, so every prompt
   * started from nothing. "What does this file do?" followed by "now fix it"
   * left the agent with no referent for "it" — and because each turn also
   * re-read the workspace from scratch, the failure looked like forgetfulness
   * rather than a missing argument. For a REPL this is not a missing feature,
   * it is the feature.
   *
   * The full history is kept here; the loop compacts its own copy to fit the
   * model's window, so nothing is lost locally by remembering everything.
   */
  let conversation: LLMMessage[] = [];
  /** A plan a stopped turn left with work open; the next turn carries it on. */
  let openPlan: TodoItem[] | undefined;
  /** The current turn's plan, as last written. */
  let turnPlan: TodoItem[] = [];
  /** What the person typed this session and last, for the resume line. */
  let prompts: string[] = [];
  /** `/goal`: Smart Loop mode, the same policy as the app's (see `goal.ts` in the orchestrator). */
  let goal: GoalState | null = null;

  /*
   * Pick up where the last session left off, in this workspace.
   *
   * Restored silently into `conversation` but *announced*, because resuming
   * invisibly is worse than not resuming: the agent would answer with
   * knowledge the user cannot see it having, and a stale context is
   * indistinguishable from a hallucination. One line says what was restored
   * and how to discard it.
   */
  const previous = await loadSession(config.workspacePath);
  if (previous && previous.history.length > 0) {
    conversation = previous.history;
    prompts = previous.prompts ?? [];
    if (previous.sessionId) sessionId = previous.sessionId;
  }

  /*
   * Restore how the session was configured, unless this launch said otherwise.
   *
   * A flag on the command line is a decision made *now* and wins over one made
   * yesterday; anything not passed falls back to what this directory was left
   * in. That ordering is what makes `soreqen --mode plan` a one-off without
   * silently rewriting the directory's saved mode.
   *
   * Restored before the banner is drawn, so the header shows what the session
   * is actually in rather than the default it briefly held.
   */
  if (previous) {
    if (!opts.mode && previous.mode) {
      currentMode = parseMode(previous.mode) ?? currentMode;
    }
    if (!opts.effort && previous.effort) {
      // An Apex saved before the CLI dropped it comes back as Max, its nearest tier.
      currentEffort = cliEffort(previous.effort) ?? (parseEffort(previous.effort) === "apex" ? "max" : currentEffort);
    }
    // The model too. It was saved and never read back, so every restart
    // silently returned to the default model.
    if (!opts.model && !setupModel && previous.model) {
      currentModel = previous.model;
    }
    if (previous.outputStyle) {
      currentStyle = parseOutputStyle(previous.outputStyle) ?? currentStyle;
    }
    if (typeof previous.autoCompact === "number") {
      autoCompactSetting = previous.autoCompact;
    }
    if (!opts.tier && previous.tierExplicit && previous.tier) {
      currentTier = previous.tier as PermissionTier;
      tierExplicitlySet = true;
    }
    // A goal that was running when the terminal closed comes back paused, never running unasked.
    const saved = goalOf(previous.goal);
    if (saved && (saved.status === "active" || saved.status === "paused")) {
      goal = { ...saved, status: "paused", note: saved.status === "active" ? "The terminal closed mid-goal. /goal resume to carry on." : saved.note };
    }
  }


  /*
   * Write the session's configuration out now, not at the end of the next turn.
   *
   * Settings were only persisted alongside a completed turn, so the sequence
   * that actually gets typed — open a directory, set Bypass and Extra, read
   * something, quit — saved nothing at all. The next launch came back on the
   * defaults, and the reasonable conclusion was that the product does not
   * remember anything.
   *
   * The write is not awaited by the command that triggered it — nobody should
   * wait on a disk write to see their mode change — but the promise is kept,
   * because `/exit` calls `process.exit` and an un-awaited write is simply
   * cancelled by process death. That is exactly how the first version of this
   * fix failed: settings were saved, and quitting threw the save away.
   */
  let pendingSave: Promise<void> = Promise.resolve();

  /*
   * Chained, not replaced.
   *
   * Two settings changed in quick succession issued two concurrent writes to
   * the same file, and the one that finished last won — which is not
   * necessarily the one that started last. Typing `/mode bypass` then
   * `/effort extra` saved bypass and *medium*. Queueing behind the previous
   * write makes last-typed reliably last-written.
   */
  const persistConfig = (): void => {
    // Captured now, written when the queue reaches it, so a later change
    // cannot rewrite an earlier snapshot's values.
    const snapshot = {
      workspacePath: config.workspacePath,
      sessionId,
      model: currentModel,
      mode: currentMode,
      effort: currentEffort,
      tier: currentTier,
      tierExplicit: tierExplicitlySet,
      outputStyle: currentStyle,
      autoCompact: autoCompactSetting,
      prompts,
      history: conversation,
    };
    pendingSave = pendingSave.then(() => saveSession(snapshot));
  };

  /** Set while a turn is in flight, so Ctrl-C can stop the work instead of
   *  killing the process. */
  let inFlight: AbortController | null = null;
  /** Whether the agent is waiting on an answer: what is typed now is that answer, not a message for later. */
  let questionOpen = false;

  /*
   * The single reader, created with the REPL further down.
   *
   * Declared here because the turn's `onAwaitConfirmation` closes over it, and
   * that is defined before the REPL exists. Null in `--print` mode, where there
   * is no interactive session and therefore nothing that can answer.
   */
  let router: InputRouter | null = null;
  const truncateLine = (s: string): string => (s.length > 40 ? `${s.slice(0, 40)}…` : s);

  /** The REPL's reader, once it exists; the live line draws itself as its prompt. */
  let replInterface: readline.Interface | null = null;
  let replClosed = false;
  const promptText = `${c.brand.bold(BAR)} `;
  const live = createLiveLine({
    enabled: Boolean(process.stdout.isTTY) && !opts.print,
    getInterface: () => (replClosed ? null : replInterface),
    prompt: promptText,
  });

  /** Where lines typed after a turn ended go: the serial queue, created with the REPL. */
  let enqueueLine: ((line: string) => void) | null = null;

  /**
   * Lines typed during work that finished before reading them.
   *
   * They open the next turn — the person sent them to a working agent and
   * should not have to send them again — unless the work was stopped, in which
   * case running them anyway would ignore the stop.
   */
  const drainInbox = (stopped: boolean): void => {
    const leftovers = inbox.splice(0);
    if (leftovers.length === 0) return;
    if (stopped || !enqueueLine) {
      console.log(
        `  ${c.warn(glyph.warn)} ${c.muted(
          `${leftovers.length} message${leftovers.length === 1 ? "" : "s"} typed during the turn ${leftovers.length === 1 ? "was" : "were"} not sent:`,
        )}`,
      );
      for (const item of leftovers) console.log(`    ${c.faint(item.text)}`);
      console.log("");
      return;
    }
    enqueueLine(leftovers.map((item) => item.text).join("\n\n"));
  };

  // A command left running in the background says when it ends, since nothing
  // else on screen would.
  sandboxRunner.onProcessEvent?.((event) => {
    if (event.type !== "exited" || !event.process.background) return;
    const p = event.process;
    const how =
      p.stoppedBy === "user" || p.stoppedBy === "agent"
        ? `stopped by ${p.stoppedBy === "user" ? "you" : "SoreQen"}`
        : p.status === "exited"
          ? `exited ${p.exitCode ?? "?"}`
          : p.status.replace("_", " ");
    const line = `  ${c.faint(glyph.dot)} ${c.muted(`background command ${how}: ${truncateLine(p.description || p.command)}`)}`;
    if (inFlight) {
      live.pause();
      console.log(line);
      live.resume();
    } else {
      console.log(line);
    }
  });

  const executeTurn = async (typedPrompt: string): Promise<GoalTurnOutcome> => {
    let outcome: GoalTurnOutcome = { stopReason: "failed", finalResponse: "", modifiedFiles: 0, toolCalls: 0 };
    console.log("");
    // `@file` mentions and dropped images become attachments, as the app's paperclip does.
    const { message: userPrompt, attached, skipped } = await attachToPrompt(typedPrompt, {
      workspace: config.workspacePath,
      workspaceId,
      runner: sandboxRunner,
    });
    for (const a of attached) console.log(`  ${c.brand(glyph.ok)} ${c.muted(`attached ${a.name}`)}`);
    for (const why of skipped) console.log(`  ${c.warn(glyph.warn)} ${c.muted(`not attached: ${why}`)}`);
    if (attached.length > 0 || skipped.length > 0) console.log("");
    resetToolCallTracking();
    const startTime = Date.now();
    const controller = new AbortController();
    inFlight = controller;
    compactRequested = false;
    /** Tokens the model has written this turn, as of the last step, and
     *  characters streamed back since; the live line shows their sum. Output
     *  only: the context re-sent each step says nothing about the work. */
    let outputTokens = 0;
    let streamed = 0;
    const showTokens = (): void => {
      const total = outputTokens + Math.round(streamed / 4);
      live.setTokens(total > 0 ? total : null);
    };
    live.start();
    try {
      let currentSpeechBlock = "";
      /** The last block actually printed, so the completion path can tell
       *  "nothing was streamed" from "it was already shown". */
      let lastFlushed = "";
      // The CLI's efforts are the five platform tiers; Apex is not offered here.
      const turnEffort: Effort = currentEffort;

      turnPlan = openPlan ?? [];
      const turnResult = await orchestrator.runTurn({
        workspaceId,
        sessionId,
        userMessage: userPrompt,
        ...(openPlan ? { plan: openPlan } : {}),
        mode: currentMode,
        effort: turnEffort,
        // Only when a ceiling was actually named. See `tierExplicitlySet`.
        ...(tierExplicitlySet ? { permissionTier: currentTier } : {}),
        prefixSeal,
        history: conversation,
        outputStyle: currentStyle,
        // Read each turn, so a skill switched on or off applies to the next message.
        skills: await skillOptions(),
        externalTools: mcpHub,
        // What SoreQen remembers about the person and this folder: the same memory as the desktop app's.
        ...(process.env["SOREQEN_MEMORY"] === "0"
          ? {}
          : {
              memory: cliMemory(),
            }),
        ...turnModel(),
        signal: controller.signal,
        controls: {
          /*
           * No channel in `--print`: nothing reads stdin there, so a question
           * would wait for ever. Without one the agent is told there is nobody
           * to ask, and says what it assumed instead.
           */
          ...(opts.print ? {} : { takeMessages: () => inbox.splice(0), pendingMessages: () => inbox.length }),
          takeCompactRequest: () => {
            const requested = compactRequested;
            compactRequested = false;
            return requested;
          },
          autoCompact: () => autoCompactSetting,
        },
        onEvent: async (ev: StreamEvent) => {
          const flushSpeech = (): void => {
            if (currentSpeechBlock.trim()) {
              lastFlushed = currentSpeechBlock.trim();
              console.log(formatTerminalMarkdown(lastFlushed));
            }
            currentSpeechBlock = "";
          };

          switch (ev.type) {
            case "step_start":
              outputTokens = ev.outputTokens ?? outputTokens + Math.round(streamed / 4);
              streamed = 0;
              showTokens();
              live.set("Thinking");
              break;
            case "output_usage":
              outputTokens = ev.outputTokens;
              showTokens();
              break;
            case "thinking":
              streamed += ev.delta.length;
              showTokens();
              live.set("Thinking");
              break;
            case "token":
              currentSpeechBlock += ev.delta;
              streamed += ev.delta.length;
              showTokens();
              live.set("Responding");
              break;
            case "tool_call_pending":
              live.set(activityLabel(ev.tool, ev.preview ?? {}, true), ev.bytes ? formatBytes(ev.bytes) : undefined);
              break;
            case "tool_call":
              flushSpeech();
              renderToolStart(ev.tool, ev.input as Record<string, unknown>, ev.callId);
              live.set(activityLabel(ev.tool, ev.input as Record<string, unknown>));
              break;
            case "tool_progress":
              live.set(activityLabel(ev.tool, {}), progressDetail(ev));
              break;
            case "tool_result":
              flushSpeech();
              renderToolResult(ev.callId, ev.tool, ev.output, ev.success);
              live.set("Thinking");
              break;
            case "diff":
              renderDiff(ev.path, ev.unifiedDiff);
              break;
            case "todo_update":
              turnPlan = ev.items as TodoItem[];
              renderTodoList(turnPlan);
              break;
            /*
             * The agent is waiting on you.
             *
             * Nothing else has to change for this to work: the answer is the
             * next thing typed, which the REPL already puts in `inbox` and
             * `takeMessages` already delivers. This only makes the wait
             * legible — a spinner that says "Thinking" while nothing is
             * thinking is the whole problem.
             */
            case "question": {
              flushSpeech();
              questionOpen = true;
              live.set("Waiting for you");
              console.log(`
  ${c.brandDim(glyph.arrow)} ${ev.total ? c.faint(`(${(ev.index ?? 0) + 1} of ${ev.total}) `) : ""}${c.text(ev.question)}`);
              if (ev.why) console.log(`  ${c.faint(ev.why)}`);
              if (ev.options && ev.options.length > 0) {
                console.log(
                  `  ${c.muted(ev.options.map((o, i) => `· ${o}${i === ev.recommended ? " (recommended)" : ""}`).join("   "))}`,
                );
                if (ev.recommendedBecause && ev.recommended !== undefined) console.log(`  ${c.faint(ev.recommendedBecause)}`);
              }
              console.log(`  ${c.faint("type your answer and press enter")}
`);
              break;
            }
            case "question_answered":
              questionOpen = false;
              live.set("Thinking");
              break;
            case "subagent_update":
              // Only the transitions, not every progress tick: a specialist
              // reporting each tool call would bury the parent's own output.
              if (ev.agent.status === "running" && (ev.agent.steps ?? 0) === 0) {
                console.log(
                  `  ${c.brandDim(glyph.bar)} ${c.muted(`delegated to ${ev.agent.role}`)}`,
                );
              } else if (ev.agent.status !== "running") {
                console.log(
                  `  ${c.brandDim(glyph.bar)} ${c.muted(`${ev.agent.role} ${ev.agent.status}`)}`,
                );
              }
              break;
            case "model_retry":
              // The failed attempt's words are discarded by the loop; so is its echo here.
              currentSpeechBlock = "";
              streamed = 0;
              // Set aside to read a message just typed: nothing went wrong.
              if (ev.reason === "interjection") {
                live.set("Reading your message");
                break;
              }
              // Set aside to read a skill before a write it covers: nothing went wrong either.
              if (ev.reason === "skill") {
                live.set(ev.message.replace(/\.$/, ""));
                break;
              }
              live.set("Reconnecting");
              console.log(
                `  ${c.warn(glyph.warn)} ${c.muted(
                  `${ev.message}; retrying in ${Math.max(1, Math.round(ev.delayMs / 1000))}s (attempt ${ev.attempt + 1})`,
                )}`,
              );
              break;
            case "context_compacted":
              console.log(
                ev.method === "unchanged"
                  ? `  ${c.faint("there is not enough conversation to checkpoint yet")}`
                  : `  ${c.brandDim(glyph.bar)} ${c.muted(
                      `context ${ev.method === "checkpoint" ? "checkpointed into task memory" : "compacted"} · ${formatTokenCount(ev.tokensBefore)} → ${formatTokenCount(ev.tokensAfter)} tokens`,
                    )}`,
              );
              break;
            case "context_usage":
              lastContext = ev.usage;
              break;
            case "context_debug":
              lastContextDebug = ev.debug;
              break;
            case "user_message":
              flushSpeech();
              // An answer was typed under its question and is already on screen.
              if (ev.answers) break;
              console.log(`\n  ${c.brand(glyph.arrow)} ${c.text(ev.text)} ${c.faint("· read mid-task")}\n`);
              break;
          }
        },
        onAwaitConfirmation: async (conf) => {
          /*
           * No reader, no consent.
           *
           * In `--print` mode nothing can answer a question, and the loop
           * already distinguishes "the user said no" from "this surface cannot
           * ask" — so returning false here is read correctly as the latter
           * rather than as a refusal nobody made.
           */
          if (!router) return false;
          live.pause();
          try {
            return await promptConfirmation(conf.description, conf.payload, (q) => live.ask(q, (question) => router!.ask(question)));
          } finally {
            live.set("Thinking");
            live.resume();
          }
        },
      });
      live.stop();

      /*
       * Do not print the final answer twice.
       *
       * The streamed text is flushed whenever a tool call arrives, so the
       * transcript reads in order. Verification then emits its own tool events
       * — `verify_changes`, and the affected-test run — *after* the model has
       * finished speaking, which flushes the final answer as a side effect.
       * `currentSpeechBlock` is empty by the time the turn ends, so the
       * fallback below fired and printed the whole summary a second time.
       *
       * Observed live: a complete, correct summary duplicated verbatim, which
       * reads like the agent stuttered.
       */
      if (currentSpeechBlock.trim()) {
        console.log(formatTerminalMarkdown(currentSpeechBlock.trim()));
        currentSpeechBlock = "";
      } else if (turnResult.finalResponse && turnResult.finalResponse !== lastFlushed) {
        console.log(formatTerminalMarkdown(turnResult.finalResponse));
      }

      // Carry the conversation forward. The loop returns the full history,
      // including this turn's tool calls and results, which is exactly what
      // the next turn needs to understand a follow-up.
      conversation = turnResult.history;
      // A goal's turns are listed once, by objective, not as one prompt per turn.
      const typedForRecent = typedPrompt.startsWith(GOAL_TURN_PREFIX)
        ? null
        : typedPrompt.startsWith("/goal — Smart Loop mode.")
          ? `/goal ${titleSourceOf(typedPrompt)}`
          : typedPrompt;
      if (typedForRecent) prompts = [...prompts, typedForRecent];
      outcome = {
        stopReason: turnResult.stopReason,
        finalResponse: goalStatusText(turnResult),
        modifiedFiles: turnResult.modifiedFiles.length,
        toolCalls: turnResult.toolCallsExecuted,
      };
      // Kept only when the turn stopped short with work still open; a finished plan is dropped.
      openPlan =
        turnResult.stopReason !== "completed" && turnPlan.some((t) => t.status === "pending" || t.status === "in_progress")
          ? turnPlan
          : undefined;
      prefixSeal = turnResult.prefixSeal;
      if (turnResult.checkpoint) lastCheckpoint = turnResult.checkpoint;
      checkpointsWork = turnResult.checkpointUnavailable === undefined;
      /*
       * Saved after each turn rather than on exit: the sessions worth resuming
       * are disproportionately the ones that ended in a crash, a closed lid,
       * or a Ctrl-C, none of which run an exit handler.
       *
       * Awaited, not fired and forgotten. The first version used `void` here
       * and nothing was ever written — `/exit` calls `process.exit(0)` on the
       * very next tick, killing the pending write. It is a few milliseconds
       * against a local file, and it is the difference between the feature
       * working and appearing to.
       */
      await saveSession({
        workspacePath: config.workspacePath,
        sessionId,
        model: currentModel,
        // Restored next time this directory is opened. See `StoredSession`:
        // resuming a conversation without the settings that governed it puts
        // the session back in a mode the user had deliberately left.
        mode: currentMode,
        effort: currentEffort,
        tier: currentTier,
        tierExplicit: tierExplicitlySet,
        outputStyle: currentStyle,
        autoCompact: autoCompactSetting,
        goal,
        prompts,
        history: conversation,
      });

      const elapsedSec = ((Date.now() - startTime) / 1000).toFixed(1);
      const tokens = `${turnResult.outputTokens.toLocaleString()} output`;
      /*
       * Cache savings are reported only when they happened.
       *
       * A "0 saved" on every line is noise that teaches people to stop reading
       * the status line, which is where the genuinely important messages —
       * "out of steps", "audit trail incomplete" — also live.
       */
      const saved = turnResult.cache.hits > 0
        ? `, ${turnResult.cache.hits} cached`
        : "";
      const context =
        lastContext && lastContext.windowTokens > 0
          ? `, context ${Math.min(100, Math.round((lastContext.usedTokens / lastContext.windowTokens) * 100))}%`
          : "";
      const detail = `${turnResult.toolCallsExecuted} tools, ~${tokens} tokens${saved}, ${elapsedSec}s${context}`;

      console.log("\n");

      /*
       * Say which ending this was.
       *
       * "completed" previously covered running out of iterations and, later,
       * being cancelled — so a turn that gave up looked exactly like one that
       * finished. Each ending now says what happened and what to do next,
       * because "it stopped" without a reason is the least actionable thing a
       * tool can tell you.
       */
      switch (turnResult.stopReason) {
        case "completed":
          console.log(`  ${c.brand(glyph.ok)} ${c.muted(detail)}`);
          if (turnResult.checkpoint) {
            // The undo is only useful if you know it exists at the moment you
            // want it, which is right after the turn you regret.
            console.log(
              `  ${c.faint(glyph.dot)} ${c.faint(`/rewind to undo this turn (${shortId(turnResult.checkpoint.id)})`)}`,
            );
          }
          if (turnResult.review?.ran && !turnResult.review.clean) {
            console.log(
              `  ${c.warn(glyph.warn)} ${c.muted(`self-review raised ${turnResult.review.concerns.length} point(s)`)}`,
            );
          }
          console.log("");
          break;
        case "cancelled":
          console.log(`  ${c.warn(glyph.stop)} ${c.text("stopped")} ${c.muted(`${detail} \u00b7 context kept`)}\n`);
          break;
        case "max_iterations":
          console.log(`  ${c.warn(glyph.warn)} ${c.text("out of steps")} ${c.muted(`${detail} \u00b7 send another message to continue`)}\n`);
          break;
        case "token_budget_exhausted":
          console.log(`  ${c.warn(glyph.warn)} ${c.text("token budget reached")} ${c.muted(`${detail} \u00b7 send another message to continue`)}\n`);
          break;
        case "failed":
          console.log(`  ${c.danger(glyph.fail)} ${c.text("stopped on an error")} ${c.muted(`${detail} \u00b7 context kept, send another message to retry`)}\n`);
          break;
      }

      if (turnResult.checkpointUnavailable) {
        /*
         * Said once per turn, not once per session.
         *
         * It changes what auto mode does — it stops relaxing confirmations —
         * and a user who is suddenly being asked about things deserves the
         * reason next to the asking rather than in a banner they scrolled past
         * twenty minutes ago.
         */
        console.log(
          `  ${c.warn(glyph.warn)} ${c.muted(`no checkpoint: ${turnResult.checkpointUnavailable}`)}\n`,
        );
      }

      if (turnResult.auditFailures > 0) {
        // Surfaced rather than buried: a run whose audit trail is incomplete
        // should say so at the moment it happens, not in a log nobody reads.
        console.log(
          chalk.red(
            `  ⚠ ${turnResult.auditFailures} audit record(s) could not be saved: the trail for this turn is incomplete.\n`,
          ),
        );
      }
    } catch (err: unknown) {
      live.stop();
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`\n  ${c.danger(glyph.fail)} ${c.text(msg)}\n`);
      outcome = { stopReason: controller.signal.aborted ? "cancelled" : "failed", finalResponse: "", modifiedFiles: 0, toolCalls: 0, error: msg };
    } finally {
      live.stop();
      inFlight = null;
      questionOpen = false;
      drainInbox(controller.signal.aborted);
    }
    return outcome;
  };

  /** One line on where a goal stands. */
  const goalLine = (g: GoalState): string => {
    const where = `${g.turns} turn${g.turns === 1 ? "" : "s"}, ${g.filesChanged} file change${g.filesChanged === 1 ? "" : "s"}`;
    const mark = g.status === "achieved" ? c.brand(glyph.ok) : g.status === "active" ? c.brand(glyph.arrow) : c.warn(glyph.warn);
    const state = g.status === "active" && g.verifying ? "verifying" : g.status;
    return `  ${mark} ${c.text(`goal ${state}`)} ${c.muted(`· ${where}${g.note ? ` · ${g.note}` : ""}`)}`;
  };

  /** After a goal turn: the policy decides whether the next one starts, and when. */
  const afterGoal = (turn: GoalTurnOutcome): void => {
    if (!goal || goal.status !== "active") return;
    const { goal: next, next: then } = afterGoalTurn(goal, turn);
    goal = next;
    console.log(goalLine(next));
    if (!then) {
      if (next.status === "paused") console.log(`  ${c.faint("/goal resume to carry on, /goal stop to end it")}`);
      console.log("");
      return;
    }
    const startNext = (): void => {
      if (goal?.status === "active") queue.push({ turn: goalContinuation(goal), goal: true });
    };
    if (then.delayMs > 0) setTimeout(startNext, then.delayMs).unref?.();
    else startNext();
  };

  // Render initial banner
  renderBanner({
    model: currentModel,
    mode: currentMode,
    effort: currentEffort,
    // Only when a ceiling is actually being enforced. Passing the config
    // default made the banner warn "this workspace is limited to guarded
    // autonomy" on every session, including the ones where nothing was
    // limiting anything — the same phantom ceiling that broke bypass.
    tier: tierExplicitlySet ? currentTier : undefined,
    workspaceDir: config.workspacePath,
    checkpoints: checkpointsWork,
    version: packageInfo().version,
    name: account?.name ?? (() => {
      try {
        return userInfo().username;
      } catch {
        return null;
      }
    })(),
    recent: (prompts.length > 0 ? prompts : previous?.prompts ?? []).slice(-3).reverse().map((text) => ({ text, age: previous ? describeAge(previous.updatedAt) : "" })),
    // From the last check, so starting never waits on the network.
    notice: interactive ? updateNotice() : null,
  });

  if (previous && previous.history.length > 0) {
    const last = previous.prompts?.[previous.prompts.length - 1];
    console.log(
      `  ${c.brand(glyph.arrow)} ${c.muted(`resumed ${describeAge(previous.updatedAt)}`)}` +
        (last ? ` ${c.faint(`\u00b7 last: ${last.slice(0, 60)}`)}` : "") +
        `  ${c.faint("/new to start fresh")}`,
    );
    console.log("");
  }

  // If initial prompt provided (e.g. `soreqen code "my prompt"`)
  const initialPrompt = effectiveArgs.join(" ");
  if (initialPrompt && opts.print) {
    // One turn, nobody to answer anything, then out.
    console.log(`  ${c.brand.bold(glyph.arrow)} ${c.text(initialPrompt)}`);
    const outcome = await executeTurn(initialPrompt);
    await closeMcp();
    /*
     * The exit code says how the turn ended. `--print` is what a script or a
     * CI job runs, and it exited 0 on a failed turn (an expired key, 13 Nov
     * 2026), so a pipeline carried on as if the work had been done.
     *   0 completed · 1 failed · 2 stopped short (out of steps or budget) · 130 cancelled
     */
    process.exitCode = printExitCode(outcome.stopReason);
    return;
  }

  // Interactive Continuous REPL Mode
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: promptText,
    /*
     * Tab takes the first command the palette shows (welcome.ts), rather
     * than readline's own list of every candidate printed over the screen.
     */
    completer: (line: string): [string[], string] => {
      const first = matchCommands(line)[0];
      return [first ? [`${first.name} `] : [], line];
    },
  });
  replInterface = rl;

  /*
   * Ctrl-C stops the turn; Ctrl-C at an idle prompt exits.
   *
   * Previously it killed the process outright, which threw away the whole
   * conversation to stop one runaway turn — so the only way to interrupt the
   * agent was to lose everything it had learned. Now the first press aborts
   * the in-flight turn, which returns normally with its history intact.
   */
  rl.on("SIGINT", () => {
    /*
     * Ctrl-C at an approval answers it "no" and stops the turn.
     *
     * Without this the pending promise is never settled, so the turn hangs
     * holding a question nobody can now reach \u2014 the interrupt appears to do
     * nothing at all.
     */
    if (router?.awaitingAnswer) {
      console.log(`\n  ${c.danger(glyph.fail)} ${c.muted("denied")}`);
      router.cancelAsk();
    }
    if (inFlight) {
      console.log(`\n  ${c.warn(glyph.stop)} ${c.muted("stopping\u2026")}`);
      inFlight.abort();
      return;
    }
    // Ctrl-C at an idle prompt is a quit like any other, and loses the
    // settings write the same way if it does not wait for it.
    void pendingSave.then(async () => {
      await closeMcp();
      console.log(chalk.hex("#A8ADA5")("\nGoodbye! ⚡"));
      process.exit(0);
    });
  });

  // With a task given on the command line, the prompt follows its turn instead.
  /*
   * The idle prompt, framed (welcome.ts): a rule above, an example in the
   * input until a key is pressed, and "? for shortcuts" with the mode and
   * model under it. A turn's live line draws its own prompt; this is only
   * the one that waits.
   */
  const frame = createPromptFrame(Boolean(process.stdout.isTTY) && !opts.print);
  const idlePrompt = (): void => {
    frame.before();
    rl.prompt();
    frame.after(promptStatus(modeStyle(currentMode).label, currentModel, currentEffort));
  };
  // Not the Enter that sent a line: its prompt is already the next one, with a fresh example.
  process.stdin.on("keypress", (_s: string | undefined, key: { name?: string } | undefined) => {
    // After readline has applied the key, so the line and cursor are current.
    if (key?.name !== "return" && key?.name !== "enter") frame.key(rl.line, rl.cursor);
  });
  rl.prependListener("line", () => frame.sent());

  if (!initialPrompt) idlePrompt();

  const handleLine = async (line: string): Promise<void> => {
    const input = line.trim();
    /*
     * The command word, matched exactly.
     *
     * Commands were matched with `input.startsWith("/mode")`, and "/model"
     * starts with "/mode". The mode handler came first, so `/model` was
     * answered with "unknown mode" and could never be reached — switching
     * models from the REPL had never worked, whatever the model handler did.
     */
    const command = input.split(/\s+/)[0] ?? "";

    if (!input) {
      safePrompt();
      return;
    }

    if (input === "?") {
      for (const line of shortcutLines()) console.log(line);
      safePrompt();
      return;
    }

    // Handle Slash Commands
    if (input === "/exit" || input === "/quit") {
      // Let the settings write land. `process.exit` does not run pending I/O,
      // so quitting straight after `/mode` used to discard it.
      await pendingSave;
      await closeMcp();
      console.log(`  ${c.faint("bye")}
`);
      process.exit(0);
    }

    // `/clear` is the session from scratch, as in the app — and a clean screen to start it on.
    if (input === "/new" || input === "/clear") {
      conversation = [];
      prompts = [];
      openPlan = undefined;
      // A goal belongs to its conversation, as in the app: a new one starts without it.
      goal = null;
      // A new conversation starts with no task memory.
      sessionId = `cli_session_${Date.now()}`;
      lastContextDebug = null;
      await clearSession(config.workspacePath);
      if (input === "/clear") {
        console.clear();
        renderBanner({
          model: currentModel,
          mode: currentMode,
          effort: currentEffort,
          tier: tierExplicitlySet ? currentTier : undefined,
          workspaceDir: config.workspacePath,
          checkpoints: checkpointsWork,
        });
      }
      console.log(`  ${c.brand(glyph.ok)} ${c.muted("started a new conversation; your files are as they were")}\n`);
      safePrompt();
      return;
    }

    if (input === "/cls") {
      console.clear();
      renderBanner({
    model: currentModel,
    mode: currentMode,
    effort: currentEffort,
    // Only when a ceiling is actually being enforced. Passing the config
    // default made the banner warn "this workspace is limited to guarded
    // autonomy" on every session, including the ones where nothing was
    // limiting anything — the same phantom ceiling that broke bypass.
    tier: tierExplicitlySet ? currentTier : undefined,
    workspaceDir: config.workspacePath,
    checkpoints: checkpointsWork,
  });
      safePrompt();
      return;
    }

    if (input === "/help") {
      /*
       * The header line was a bare template literal.
       *
       * `` `\n  ${c.text.bold("Commands")}` `` on its own is an expression
       * statement: it builds a string, formats it, and discards it. Valid
       * TypeScript, no warning, and the heading simply never appeared. The
       * same mistake was in `/rules`, where it swallowed the entire rulebook —
       * see below.
       */
      // The same list the palette shows as you type `/` (welcome.ts COMMANDS).
      const nameW = Math.max(...COMMANDS.map((cmd) => cmd.name.length)) + 2;
      console.log(`\n  ${c.text.bold("Commands")}`);
      for (const cmd of COMMANDS) {
        const args = cmd.name === "/style" ? OUTPUT_STYLES.join("|") : cmd.args;
        console.log(`  ${c.brand(cmd.name.padEnd(nameW))}${args ? `${c.muted(args)}  ` : ""}${c.faint(cmd.description)}`);
      }
      console.log(`\n  ${c.faint("type / to see these as you type; tab completes the first")}`);
      console.log(`  ${c.faint("type while SoreQen works to add to the task; it reads it at its next step")}`);
      console.log(`  ${c.faint("@path attaches a file; drop an image onto the terminal to attach it")}`);
      console.log(`  ${c.faint("ctrl+c stops a running turn; again at the prompt quits")}\n`);
      safePrompt();
      return;
    }

    // ---- /goal -------------------------------------------------------------

    /*
     * Smart Loop mode, as in the app: turns follow one another until the
     * objective is achieved (and verified), blocked, stuck or stopped. The
     * plan lives in GOAL.md in the project. Ctrl+C pauses it.
     */
    if (command === "/goal") {
      const arg = input.slice("/goal".length).trim();
      const word = arg.toLowerCase();
      if (!arg) {
        console.log(goal ? `\n  ${c.text(goal.objective.split("\n")[0]!.slice(0, 160))}\n${goalLine(goal)}\n` : `\n  ${c.muted("No goal. /goal <objective> starts one; it keeps working, turn after turn, until the objective is met.")}\n`);
      } else if (word === "stop") {
        if (goal && goal.status !== "achieved" && goal.status !== "stopped") {
          goal = { ...goal, status: "stopped", updatedAt: Date.now(), note: "Stopped." };
          console.log(`\n${goalLine(goal)}\n`);
        } else {
          console.log(`\n  ${c.muted("No goal is running.")}\n`);
        }
      } else if (word === "resume") {
        if (goal && goal.status === "paused") {
          goal = { ...goal, status: "active", failures: 0, idleTurns: 0, updatedAt: Date.now(), note: "Resumed." };
          console.log(`\n${goalLine(goal)}\n`);
          queue.push({ turn: goalContinuation(goal), goal: true });
          return;
        }
        console.log(`\n  ${c.muted(goal ? `The goal is ${goal.status}, not paused.` : "No goal to resume.")}\n`);
      } else if (goal && (goal.status === "active" || goal.status === "paused")) {
        console.log(`\n  ${c.warn(glyph.warn)} ${c.text(`A goal is ${goal.status}. /goal stop ends it before a new one starts.`)}\n`);
      } else {
        goal = newGoal(arg);
        console.log(`\n${goalLine(goal)}\n  ${c.faint("Ctrl+C pauses it; /goal shows where it stands")}\n`);
        queue.push({ turn: goalKickoff(goal), goal: true });
        return;
      }
      safePrompt();
      return;
    }

    // ---- /mode -------------------------------------------------------------

    if (command === "/mode") {
      const requested = input.slice("/mode".length).trim();

      if (!requested) {
        console.log(`\n  ${c.text.bold("Modes")}`);
        for (const id of MODE_ORDER) {
          const spec = AGENT_MODES[id];
          const style = modeStyle(id);
          const marker = id === currentMode ? c.brand(glyph.ok) : " ";
          console.log(`  ${marker} ${style.paint(spec.label.padEnd(8))} ${c.muted(spec.summary)}`);
        }
        console.log(`\n  ${c.faint("/mode <name> to switch")}`);
        console.log(`  ${rule()}\n`);
        safePrompt();
        return;
      }

      const parsed = parseMode(requested);
      if (!parsed) {
        console.log(
          `  ${c.danger(glyph.fail)} ${c.text("unknown mode")} ${c.muted(MODE_ORDER.join(", "))}\n`,
        );
        safePrompt();
        return;
      }

      currentMode = parsed;
      persistConfig();
      const style = modeStyle(parsed);
      console.log(`  ${c.brand(glyph.ok)} ${c.text("mode")} ${style.paint(style.label)}`);

      /*
       * If a ceiling is going to narrow this, say so here.
       *
       * The whole bug was that this line printed "Bypass" and the session ran
       * as Auto. A mode label that can be false is worse than no label.
       */
      if (tierExplicitlySet) {
        const clamped = clampTier(tierForMode(parsed), currentTier);
        if (clamped !== tierForMode(parsed)) {
          console.log(
            `  ${c.warn(glyph.warn)} ${c.muted(
              `the ${currentTier} ceiling narrows this to ${modeForTier(clamped)}; /tier full_autonomy lifts it`,
            )}`,
          );
        }
      }
      console.log(`  ${c.faint(AGENT_MODES[parsed].summary)}`);

      /*
       * Bypass is announced, not just set.
       *
       * It is the one mode where the next thing that happens can be a `git
       * push` nobody was asked about. A person who typed it deliberately loses
       * one line to a reminder; a person who typed it not knowing what it
       * meant finds out before rather than after.
       */
      if (AGENT_MODES[parsed].requiresAcknowledgement) {
        console.log(
          `  ${c.danger(glyph.warn)} ${c.text("nothing will be confirmed with you from now on.")}`,
        );
        console.log(
          `  ${c.faint("hard-denied actions are still refused. /mode auto to go back.")}`,
        );
      }
      if (parsed === "auto" && !checkpointsWork) {
        console.log(
          `  ${c.warn(glyph.warn)} ${c.muted("this workspace has no checkpoints, so auto will still ask before risky changes")}`,
        );
      }
      console.log("");
      safePrompt();
      return;
    }

    // ---- /effort -----------------------------------------------------------

    if (command === "/effort") {
      const requested = input.slice("/effort".length).trim();

      if (!requested) {
        console.log(`\n  ${c.text.bold("Reasoning effort")}`);
        for (const spec of listEfforts(false)) {
          const style = effortStyle(spec.id);
          const marker = spec.id === currentEffort ? c.brand(glyph.ok) : " ";
          const tag = spec.isPremium ? c.brandDim(" · beyond the platform ceiling") : "";
          console.log(`  ${marker} ${style.paint(spec.label.padEnd(8))} ${c.muted(spec.summary)}${tag}`);
        }
        console.log(`\n  ${c.faint("/effort <name> to switch")}`);
        console.log(`  ${rule()}\n`);
        safePrompt();
        return;
      }

      const parsed = cliEffort(requested);
      if (!parsed) {
        console.log(
          `  ${c.danger(glyph.fail)} ${c.text("unknown effort")} ${c.muted(PLATFORM_EFFORTS.join(", "))}\n`,
        );
        safePrompt();
        return;
      }

      currentEffort = parsed;
      persistConfig();
      const style = effortStyle(parsed);
      console.log(`  ${c.brand(glyph.ok)} ${c.text("effort")} ${style.paint(style.label)}`);
      console.log(`  ${c.faint(EFFORT[parsed].summary)}\n`);
      safePrompt();
      return;
    }

    // ---- /style -------------------------------------------------------------

    if (command === "/style" || command === "/output-style") {
      const requested = input.slice(command.length).trim();
      if (!requested) {
        console.log(`\n  ${c.text.bold("Output style")}`);
        for (const id of OUTPUT_STYLES) {
          const marker = id === currentStyle ? c.brand(glyph.ok) : " ";
          console.log(`  ${marker} ${c.text(OUTPUT_STYLE[id].label.padEnd(12))} ${c.muted(OUTPUT_STYLE[id].summary)}`);
        }
        console.log(`\n  ${c.faint("/style <name> to switch")}`);
        console.log(`  ${rule()}\n`);
        safePrompt();
        return;
      }
      const parsed = parseOutputStyle(requested);
      if (!parsed) {
        console.log(`  ${c.danger(glyph.fail)} ${c.text("unknown style")} ${c.muted(OUTPUT_STYLES.join(", "))}\n`);
        safePrompt();
        return;
      }
      currentStyle = parsed;
      persistConfig();
      console.log(
        `  ${c.brand(glyph.ok)} ${c.text("style")} ${c.brand(OUTPUT_STYLE[parsed].label)}` +
          `${inFlight ? c.faint(" · from the next turn") : ""}`,
      );
      console.log(`  ${c.faint(OUTPUT_STYLE[parsed].summary)}\n`);
      safePrompt();
      return;
    }

    // ---- processes ---------------------------------------------------------

    if (input === "/ps") {
      const all = sandboxRunner.listProcesses?.(workspaceId) ?? [];
      if (all.length === 0) {
        console.log(`  ${c.faint("no commands have been started yet")}\n`);
      } else {
        console.log("");
        for (const p of [...all].sort((a, b) => b.startedAt - a.startedAt).slice(0, 20)) {
          const took = formatDuration((p.endedAt ?? Date.now()) - p.startedAt);
          const state =
            p.status === "running"
              ? c.brand(p.background ? "background" : "running")
              : p.status === "exited"
                ? (p.exitCode ?? 0) === 0
                  ? c.muted("exited 0")
                  : c.danger(`exited ${p.exitCode}`)
                : c.warn(p.stoppedBy ? `stopped by ${p.stoppedBy}` : p.status.replace("_", " "));
          console.log(`  ${c.faint(p.id)}  ${state} ${c.faint(took)}  ${c.text(truncateLine(p.description || p.command))}`);
        }
        console.log(`\n  ${c.faint("/stop <id> stops one")}\n`);
      }
      safePrompt();
      return;
    }

    if (command === "/stop") {
      const target = input.slice("/stop".length).trim();
      const running = (sandboxRunner.listProcesses?.(workspaceId) ?? []).filter((p) => p.status === "running");
      const chosen = target === "all" ? running : running.filter((p) => p.id === target);
      if (!target || chosen.length === 0) {
        console.log(
          `  ${c.faint(
            running.length === 0
              ? "nothing is running"
              : `name one of: ${running.map((p) => p.id).join(", ")}, or /stop all`,
          )}\n`,
        );
      } else {
        for (const p of chosen) {
          await sandboxRunner.stopProcess?.(workspaceId, p.id, "user");
          console.log(`  ${c.warn(glyph.stop)} ${c.muted(`stopped ${truncateLine(p.description || p.command)}`)}`);
        }
        console.log("");
      }
      safePrompt();
      return;
    }

    // ---- context -----------------------------------------------------------

    if (input === "/context") {
      const { model } = turnModel();
      const windowTokens = lastContext?.windowTokens ?? contextWindowFor(model);
      const messages = estimateHistoryTokens(conversation);
      const usage: ContextUsage = lastContext ?? {
        usedTokens: messages,
        windowTokens,
        compactAtTokens: effectiveCompactTokens(autoCompactSetting, windowTokens, 0),
        breakdown: { system: 0, tools: 0, messages },
      };
      renderContext(usage, describeAutoCompact(autoCompactSetting, windowTokens), lastContext === null);
      if (lastContextDebug) renderContextEngine(lastContextDebug);
      safePrompt();
      return;
    }

    /*
     * Both spellings.
     *
     * People type the noun. The setting is "auto-compaction", so `/autocompaction`
     * is what a person reaches for and `/autocompact` is what the command was
     * called — an unrecognised command is a dead end for something that has an
     * obvious intended meaning, so both work.
     */
    // /autocompact and /autocompaction are the older names.
    if (command === "/checkpoint-at" || command === "/autocompact" || command === "/autocompaction") {
      const requested = input.slice(command.length).trim();
      if (!requested) {
        console.log(
          `  ${c.muted(`checkpoints automatically at ${describeAutoCompact(autoCompactSetting, lastContext?.windowTokens ?? contextWindowFor(currentModel))}`)} ` +
            `${c.faint("· change it with /checkpoint-at 200k, /checkpoint-at 50, or /checkpoint-at default")}\n`,
        );
        safePrompt();
        return;
      }
      const parsed = parseAutoCompact(requested);
      if (!parsed.ok) {
        console.log(`  ${c.danger(glyph.fail)} ${c.text(parsed.error)}\n`);
        safePrompt();
        return;
      }
      autoCompactSetting = parsed.value;
      persistConfig();
      console.log(
        `  ${c.brand(glyph.ok)} ${c.text("checkpoints automatically at")} ${c.brand(describeAutoCompact(parsed.value, lastContext?.windowTokens ?? contextWindowFor(currentModel)))}` +
          `${inFlight ? c.faint(" · from the agent's next step") : ""}\n`,
      );
      safePrompt();
      return;
    }

    // /compact is the older name.
    if (input === "/checkpoint" || input === "/compact") {
      // During a turn: at its next step, where it cannot cut across work.
      if (inFlight) {
        compactRequested = true;
        console.log(`  ${c.brand(glyph.ok)} ${c.muted("the conversation will be checkpointed at the agent's next step")}`);
        safePrompt();
        return;
      }
      if (conversation.length === 0) {
        console.log(`  ${c.faint("there is no conversation to checkpoint yet")}\n`);
        safePrompt();
        return;
      }

      const { model, llmProvider: endpointProvider } = turnModel();
      const budget = Math.max(4_000, contextWindowFor(model) - 16_000);
      const controller = new AbortController();
      inFlight = controller;
      live.start();
      live.set("Checkpointing the conversation");
      try {
        // A checkpoint into task memory, as inside a turn; the summary only if that fails.
        const engine = await ContextEngine.open({ runner: sandboxRunner, workspaceId, sessionId, withoutIndex: true });
        const condensed =
          (await engine
            .checkpoint({
              history: conversation,
              provider: endpointProvider ?? llmProvider,
              ...(model ? { model } : {}),
              keepRecentTokens: Math.floor(budget * 0.15),
              signal: controller.signal,
            })
            .then((r) => (r ? { ...r, summary: r.message, checkpointed: true } : null))) ??
          (await summarizeHistory({
            history: conversation,
            provider: endpointProvider ?? llmProvider,
            model,
            keepRecentTokens: Math.floor(budget * 0.15),
            maxTranscriptTokens: Math.floor(budget * 0.6),
            signal: controller.signal,
          }));
        live.stop();
        if (!condensed) {
          console.log(`  ${c.faint("there is not enough conversation to checkpoint yet")}\n`);
        } else {
          conversation = condensed.history;
          // The prefix the cache was sealed on no longer exists.
          prefixSeal = null;
          lastContext = null;
          lastContextDebug = null;
          persistConfig();
          console.log(
            `  ${c.brand(glyph.ok)} ${c.text("checkpointed" in condensed ? "context checkpointed into task memory" : "context compacted into a summary")} ` +
              `${c.muted(`${formatTokenCount(condensed.tokensBefore)} → ${formatTokenCount(condensed.tokensAfter)} tokens`)}\n`,
          );
        }
      } catch (err: unknown) {
        live.stop();
        console.log(
          controller.signal.aborted
            ? `  ${c.warn(glyph.stop)} ${c.muted("checkpoint stopped · nothing was changed")}\n`
            : `  ${c.danger(glyph.fail)} ${c.text(`could not checkpoint: ${err instanceof Error ? err.message : String(err)}`)}\n`,
        );
      } finally {
        live.stop();
        inFlight = null;
        drainInbox(controller.signal.aborted);
      }
      safePrompt();
      return;
    }

    // ---- /checkpoints ------------------------------------------------------

    if (input === "/audit") {
      console.log(`  ${c.brand(glyph.ok)} ${c.text("audit trail")}`);
      console.log(`  ${c.muted(auditPathFor(config.workspacePath))}`);
      console.log(`  ${c.faint("one JSON object per line; every state-changing tool call")}\n`);
      safePrompt();
      return;
    }

    if (input === "/checkpoints") {
      const points = await listCheckpoints(sandboxRunner, workspaceId);
      if (points.length === 0) {
        console.log(`  ${c.faint("no checkpoints in this workspace yet")}\n`);
        safePrompt();
        return;
      }
      console.log(`\n  ${c.brand(glyph.bar)} ${c.text.bold(`Checkpoints · ${points.length}`)}`);
      for (const point of points) {
        const when = point.createdAt ? point.createdAt.slice(0, 19).replace("T", " ") : "";
        console.log(
          `  ${c.brandDim(shortId(point.id))}  ${c.faint(when)}  ${c.muted(point.label.slice(0, 60))}`,
        );
      }
      console.log(`\n  ${c.faint("/rewind <id> to restore one")}`);
      console.log(`  ${rule()}\n`);
      safePrompt();
      return;
    }

    // ---- /rewind -----------------------------------------------------------

    if (command === "/rewind") {
      const requested = input.slice("/rewind".length).trim();

      /*
       * Fall back to the newest checkpoint on disk.
       *
       * `lastCheckpoint` only exists for turns taken in *this* process, so a
       * fresh session reported "nothing to rewind to yet" while `/checkpoints`
       * listed several — two commands contradicting each other about the same
       * state, which is worse than either being wrong on its own. Resuming a
       * session and immediately undoing the last turn is a completely ordinary
       * thing to want.
       */
      let target = requested || lastCheckpoint?.id;
      if (!target) {
        const [newest] = await listCheckpoints(sandboxRunner, workspaceId);
        target = newest?.id;
      }

      if (!target) {
        console.log(
          `  ${c.faint("nothing to rewind to yet: checkpoints are taken before each turn")}\n`,
        );
        safePrompt();
        return;
      }

      const result = await restoreCheckpoint(sandboxRunner, workspaceId, target);
      if (!result.ok) {
        console.log(`  ${c.danger(glyph.fail)} ${c.text(result.reason ?? "restore failed")}\n`);
        safePrompt();
        return;
      }

      const count = result.restoredFiles.length;
      console.log(
        `  ${c.brand(glyph.ok)} ${c.text("workspace restored")} ` +
          `${c.muted(`${count} file${count === 1 ? "" : "s"} changed back`)}`,
      );
      for (const f of result.restoredFiles.slice(0, 8)) {
        console.log(`    ${c.faint(f)}`);
      }
      if (count > 8) console.log(`    ${c.faint(`…and ${count - 8} more`)}`);

      /*
       * The undo of the undo, told to the user at the only moment it helps.
       *
       * Someone who rewinds one turn too far has just lost real work to a
       * safety feature. `restoreCheckpoint` already snapshots the pre-restore
       * state; this is the line that makes that reachable.
       */
      if (result.undoId) {
        console.log(`  ${c.faint(`/rewind ${shortId(result.undoId)} to undo this restore`)}`);
      }
      if (result.reason) {
        console.log(`  ${c.warn(glyph.warn)} ${c.muted(result.reason)}`);
      }

      /*
       * The conversation is kept, deliberately.
       *
       * The files are back but the transcript is not wrong — it is an accurate
       * record of what was tried, and the next message is almost always "that
       * didn't work, do it differently". Clearing it would throw away the
       * context that makes the retry better than the first attempt.
       */
      console.log(`  ${c.faint("the conversation is kept; /new starts over as well")}\n`);
      safePrompt();
      return;
    }

    // ---- /map --------------------------------------------------------------

    if (input === "/map") {
      const map = await buildRepoMap(sandboxRunner, workspaceId, { force: true });
      if (!map.text) {
        console.log(`  ${c.faint("no source files to map in this workspace")}\n`);
        safePrompt();
        return;
      }
      console.log(
        `\n  ${c.brand(glyph.bar)} ${c.text.bold("Repository map")} ` +
          `${c.faint(`· ${map.filesIncluded} files, ${map.symbolCount} symbols, ~${map.approxTokens} tokens`)}`,
      );
      for (const line of map.text.split("\n")) console.log(`  ${c.muted(line)}`);
      console.log(`  ${rule()}\n`);
      safePrompt();
      return;
    }

    if (input === "/rules") {
      const rulebook = await MemoryManager.loadProjectRules(workspaceId, sandboxRunner);
      if (rulebook) {
        console.log(`\n  ${c.brand(glyph.bar)} ${c.text.bold(`Project rules \u00b7 ${rulebook.source}`)}`);
        // Was `c.text(rulebook.conventions)` on its own — an expression whose
        // value was discarded, so `/rules` printed a heading and nothing under
        // it. The same bug as the `/help` header, in a place where it hid the
        // entire contents of the file the user asked to see.
        for (const line of rulebook.conventions.split("\n")) {
          console.log(`  ${c.text(line)}`);
        }
        console.log("");
      } else {
        console.log(
          chalk.yellow(
            "\nℹ No .soreqenrules or SOREQEN.md found in workspace root. Using default production conventions.\n",
          ),
        );
      }
      safePrompt();
      return;
    }

    if (input === "/memory" || input.startsWith("/memory ")) {
      // What SoreQen remembers, global and this folder's; `/memory forget <name>` removes one.
      const store = cliMemory();
      const forgetName = /^\/memory\s+forget\s+(\S+)/.exec(input)?.[1];
      if (forgetName) {
        const gone = store.forget("project", forgetName) || store.forget("user", forgetName);
        console.log(`  ${gone ? c.text(`forgot ${forgetName}`) : c.faint(`no memory named ${forgetName}`)}\n`);
        safePrompt();
        return;
      }
      // `/memory show <name>`: one memory in full, with what it links to.
      const showName = /^\/memory\s+show\s+(\S+)/.exec(input)?.[1];
      if (showName) {
        const found = runMemoryTool(store, "recall", { name: showName });
        const m = found.success ? (found.data as { name: string; scope: string; kind: string; description: string; content: string; updatedAt: string; links?: Array<{ name: string; missing?: boolean }> }) : null;
        if (!m) {
          console.log(`  ${c.faint(`no memory named ${showName}`)}\n`);
        } else {
          console.log(`\n  ${c.text.bold(m.name)}  ${c.faint(`${m.scope === "user" ? "global" : "this folder"} · ${m.kind} · ${m.updatedAt.slice(0, 10)}`)}`);
          console.log(`  ${c.muted(m.description)}\n`);
          console.log(formatTerminalMarkdown(m.content));
          if (m.links?.length) console.log(`  ${c.faint(`links: ${m.links.map((l) => (l.missing ? `${l.name} (missing)` : l.name)).join(", ")}`)}`);
          console.log("");
        }
        safePrompt();
        return;
      }
      // `/memory edit <name>`: open the memory's file in your editor, as the app's Memory panel edits it.
      const editName = /^\/memory\s+edit\s+(\S+)/.exec(input)?.[1];
      if (editName) {
        const slug = memorySlug(editName);
        const dirs = [join(projectDataPath(config.workspacePath, soreqenHome()), "memory"), join(soreqenHome(), "memory")];
        const file = dirs.map((d) => join(d, `${slug}.md`)).find((f) => existsSync(f));
        if (!file) {
          console.log(`  ${c.faint(`no memory named ${editName}`)}\n`);
          safePrompt();
          return;
        }
        const editor = process.env["VISUAL"] || process.env["EDITOR"] || (process.platform === "win32" ? "notepad" : "vi");
        console.log(`  ${c.faint(`opening ${slug} in ${editor}; save and close it to come back`)}`);
        const ran = spawnSync(editor, [file], { stdio: "inherit", shell: process.platform === "win32" });
        // The index is rebuilt from the files, so a changed description shows at once.
        store.reindex(file.startsWith(dirs[0]!) ? "project" : "user");
        console.log(`  ${ran.error ? c.danger(`could not start ${editor}: ${ran.error.message}`) : c.text(`saved ${slug}`)}\n`);
        safePrompt();
        return;
      }
      // `/memory tidy`: merge, fix and prune, as Claude's consolidate-memory does.
      if (/^\/memory\s+tidy\b/.test(input)) {
        await executeTurn(MEMORY_TIDY_PROMPT);
        safePrompt();
        return;
      }
      const sections: Array<[string, ReturnType<MemoryStore["list"]>]> = [
        ["Global", store.list("user")],
        ["This folder", store.list("project")],
      ];
      const total = sections.reduce((n, [, rows]) => n + rows.length, 0);
      console.log(`\n  ${c.brand(glyph.bar)} ${c.text.bold(`Memory \u00b7 ${total} kept`)}`);
      for (const [title, rows] of sections) {
        if (rows.length === 0) continue;
        console.log(`  ${c.muted(title)}`);
        for (const m of rows) console.log(`    ${c.text(m.name)}  ${c.faint(m.description)}`);
      }
      if (total === 0) console.log(`  ${c.faint("nothing yet: SoreQen saves what it learns as it works")}`);
      console.log(`  ${c.faint(`kept in ${join(soreqenHome(), "memory")} \u00b7 /memory show|edit|forget <name> \u00b7 /memory tidy`)}\n`);
      safePrompt();
      return;
    }

    if (command === "/tier") {
      const parts = input.split(" ");
      const tierCandidate = parts[1] as PermissionTier;
      const validTiers: PermissionTier[] = [
        "read_only",
        "propose_only",
        "guarded_autonomy",
        "full_autonomy",
      ];
      if (validTiers.includes(tierCandidate)) {
        currentTier = tierCandidate;
        tierExplicitlySet = true;
        persistConfig();
        console.log(`  ${c.brand(glyph.ok)} ${c.text("tier")} ${tierStyle(currentTier).paint(tierStyle(currentTier).label)}\n`);
        /*
         * Say it now, not at the next turn's first refusal.
         *
         * A ceiling below the current mode's own tier is exactly the situation
         * that used to be invisible: the mode label kept saying Bypass while
         * the session behaved as Auto.
         */
        const clamped = clampTier(tierForMode(currentMode), currentTier);
        if (clamped !== tierForMode(currentMode)) {
          console.log(
            `  ${c.warn(glyph.warn)} ${c.muted(
              `this ceiling narrows ${currentMode} to ${modeForTier(clamped)} until you raise it`,
            )}\n`,
          );
        }
      } else {
        console.log(`  ${c.danger(glyph.fail)} ${c.text("unknown tier")} ${c.muted(validTiers.join(", "))}\n`);
      }
      safePrompt();
      return;
    }

    /*
     * The SoreQen account, from inside a session.
     *
     * `/login` needs no typing — the device flow waits for approval in the
     * browser — so it runs here without fighting the input router for stdin.
     * Adding a key does need typing a secret, which the router would echo and
     * record as a prompt, so `/keys` points at `soreqen keys set` instead.
     */
    if (command === "/login") {
      if (account) {
        console.log(`  ${c.muted(`Signed in as ${account.email || "your SoreQen account"}. /logout first to switch.`)}\n`);
      } else {
        try {
          account = await deviceLogin({
            onCode: (start) => {
              console.log(`\n  Opening ${start.verification_uri}: approve the code ${c.brand(start.user_code)} there.`);
              console.log(`  ${c.muted(`(Not opened? Go to ${start.verification_uri_complete})`)}\n`);
            },
          });
          const added = await applyAccount();
          console.log(`  ${c.brand(glyph.ok)} ${c.text(`Signed in as ${account.email || "your SoreQen account"}.`)}` +
            (added > 0 ? ` ${c.muted(`${added} SoreQen model${added === 1 ? "" : "s"} added; see /model.`)}` : ` ${c.muted("This plan has no hosted models; your own keys still work.")}`) + "\n");
        } catch (err) {
          console.log(`  ${c.danger(glyph.fail)} ${c.text(err instanceof LoginError ? err.message : String(err))}\n`);
        }
      }
      safePrompt();
      return;
    }

    if (command === "/logout") {
      if (!account) {
        console.log(`  ${c.muted("Not signed in.")}\n`);
      } else {
        await logout(account);
        account = null;
        await applyAccount();
        console.log(`  ${c.brand(glyph.ok)} ${c.text("Signed out of SoreQen on this machine.")}\n`);
      }
      safePrompt();
      return;
    }

    if (command === "/skills") {
      console.log("");
      for (const line of await describeSkills()) console.log(`  ${line}`);
      console.log("");
      safePrompt();
      return;
    }

    if (command === "/mcp") {
      console.log("");
      for (const line of describeMcp(mcpHub)) console.log(`  ${line}`);
      console.log(`\n  ${c.faint("soreqen mcp add | remove | trust. Changes apply the next time SoreQen starts")}\n`);
      safePrompt();
      return;
    }

    if (command === "/prompts") {
      console.log("");
      for (const line of await describePrompts(mcpHub)) console.log(`  ${line}`);
      console.log("");
      safePrompt();
      return;
    }

    /*
     * An MCP server's prompt, filled in and sent as the person's own message.
     * Queued as a turn rather than run here, so it takes its place in line
     * like anything else typed, and a prompt whose text happens to start with
     * "/" is still a message, not a command.
     */
    if (command === "/prompt") {
      const filled = await fillPrompt(mcpHub, input.slice(command.length));
      if ("error" in filled) {
        console.log(`  ${c.warn(glyph.warn)} ${c.muted(filled.error)}
`);
        safePrompt();
        return;
      }
      console.log(`  ${c.brandDim(glyph.arrow)} ${c.muted(`prompt ${input.slice(command.length).trim().split(/\s+/)[0]}:`)} ${c.text(truncateLine(filled.text))}`);
      queue.push({ turn: filled.text });
      return;
    }

    if (command === "/usage") {
      if (!account) {
        console.log(`  ${c.muted("Not signed in to SoreQen. /login to use your plan's models; your own keys have no SoreQen limits.")}\n`);
      } else {
        try {
          const usage = await fetchUsage(account);
          console.log("");
          for (const line of describeUsage(usage)) console.log(`  ${c.text(line)}`);
          console.log("");
        } catch (err) {
          console.log(`  ${c.danger(glyph.fail)} ${c.text(err instanceof Error ? err.message : String(err))}\n`);
        }
      }
      safePrompt();
      return;
    }

    if (command === "/burst") {
      if (!account) {
        console.log(`  ${c.muted("Not signed in to SoreQen. /login first.")}\n`);
      } else {
        try {
          console.log(`  ${c.text(await startBurst(account))}\n`);
        } catch (err) {
          console.log(`  ${c.danger(glyph.fail)} ${c.text(err instanceof Error ? err.message : String(err))}\n`);
        }
      }
      safePrompt();
      return;
    }

    if (command === "/keys") {
      console.log(`\n  ${c.text.bold("Your own API keys")} ${c.muted("(~/.soreqen/.env)")}`);
      for (const p of OWN_KEY_PROVIDERS) {
        const key = p.keyVars.map((v) => process.env[v]).find(Boolean);
        console.log(`  ${key ? c.brand(glyph.ok) : " "} ${c.text(p.label.padEnd(20))} ${c.muted(key ? maskKey(key) : "not set")}`);
      }
      console.log(`\n  ${c.muted("Add or change one in another terminal: soreqen keys set <provider>")}\n`);
      safePrompt();
      return;
    }

    if (command === "/model") {
      let modelCandidate = input.split(/\s+/)[1];
      // What the list shows: models switched off in Settings stay out, except the one in use.
      const currentId = findModel(catalogue, currentModel)?.id ?? currentModel;
      const listedModels = catalogue.filter((m) => !m.hidden || m.id === currentId);
      // `/model 2` picks the second listed model, so nobody has to type an id.
      if (modelCandidate && /^\d+$/.test(modelCandidate)) {
        const picked = listedModels[Number(modelCandidate) - 1];
        if (picked) modelCandidate = picked.id;
      }
      if (!modelCandidate) {
        if (catalogue.length === 0) {
          console.log(chalk.red("✖ Please specify a model name (e.g. /model mimo-v2.6-flash)\n"));
        } else {
          // No argument lists what can be chosen, numbered, marking the current one.
          const current = currentId;
          console.log("");
          listedModels.forEach((m, i) => {
            const mark = m.id === current ? c.brand(glyph.ok) : " ";
            console.log(`  ${mark} ${c.muted(`${i + 1}.`)} ${c.text(m.label.padEnd(22))} ${c.muted(m.id)}`);
          });
          const hiddenCount = catalogue.length - listedModels.length;
          console.log(
            `\n  ${c.muted("Switch with /model <number> or /model <id>")}` +
              (hiddenCount > 0 ? `\n  ${c.muted(`${hiddenCount} more switched off in Settings > Models on soreqen.com`)}` : "") +
              "\n",
          );
        }
      } else {
        const endpoint = findModel(catalogue, modelCandidate);
        if (catalogue.length > 0 && !endpoint) {
          console.log(
            chalk.red(`✖ Unknown model '${modelCandidate}'. Available: ${catalogue.map((m) => m.id).join(", ")}\n`),
          );
        } else {
          currentModel = endpoint?.id ?? modelCandidate;
          persistConfig();
          console.log(
            `  ${c.brand(glyph.ok)} ${c.text("model")} ${c.brand(endpoint?.label ?? currentModel)}\n`,
          );
        }
      }
      safePrompt();
      return;
    }

    // Execute Standard User Turn
    /*
     * Input is paused while a turn runs.
     *
     * `readline`'s "line" handler is fire-and-forget: it does not await the
     * async body, so every line that arrives during a turn starts *another*
     * turn immediately. Two turns then read and write `conversation`
     * concurrently and the last to finish wins, silently discarding the
     * other's history.
     *
     * It also broke non-interactive use outright. Piping three lines in ran
     * all three at once, and a trailing `/exit` called `process.exit` before
     * any of them had finished — so the whole session produced no output at
     * all, which is how this was found.
     */
    await executeTurn(input);
    safePrompt();
  };

  /*
   * Lines are queued and handled one at a time.
   *
   * `readline`'s "line" event is fire-and-forget — it does not await an async
   * handler — so every line that arrives while a turn is running starts
   * *another* turn concurrently. Two turns then read and write `conversation`
   * at once and whichever finishes last wins, silently discarding the other's
   * history.
   *
   * `rl.pause()` inside the handler does not help: when stdin is a pipe the
   * whole input arrives in one chunk and readline emits every line event
   * synchronously, before any `await` has yielded. So a piped session ran all
   * its prompts at once and a trailing `/exit` called `process.exit` before
   * any of them finished — producing no output whatsoever, which is how this
   * was found. Interactively it was subtler and worse: typing ahead corrupted
   * the conversation instead of queueing.
   *
   * An explicit queue is the only thing that actually serialises it.
   */
  /*
   * Whether the interface is gone.
   *
   * Turns outlive stdin. When input is piped, readline closes as soon as the
   * data has been read, but the queued turns are still running — and the
   * `rl.prompt()` at the end of each one then throws ERR_USE_AFTER_CLOSE,
   * crashing the process right after the work succeeded. Printing a prompt
   * nobody will type at is pointless anyway, so it is simply skipped.
   */
  let closed = false;
  const safePrompt = (): void => {
    if (!closed) idlePrompt();
  };

  /** A line typed or piped in — or the task given on the command line, which is a turn whatever it starts with. */
  type Queued = string | { turn: string; goal?: true };
  const queue = createSerialQueue<Queued>(async (item) => {
    if (typeof item === "string") return handleLine(item);
    if (item.goal && goal?.status !== "active") return;
    const outcome = await executeTurn(item.turn);
    if (item.goal) afterGoal(outcome);
    safePrompt();
  }, (err) => {
    console.error(`
  ${c.danger(glyph.fail)} ${c.text(err instanceof Error ? err.message : String(err))}
`);
  });

  /*
   * Every line goes through the router, and nothing else reads stdin.
   *
   * See `input-router.ts`: approvals used to open a second reader on the same
   * stream, so one `y` both approved the action and queued itself as a new
   * prompt.
   */
  enqueueLine = (line) => queue.push(line);

  /** Commands that are safe to run beside a working turn, answered straight away. */
  const BESIDE_A_TURN = new Set([
    "/help",
    "/context",
    "/checkpoint",
    "/checkpoint-at",
    "/compact",
    "/autocompact",
    "/autocompaction",
    "/style",
    "/output-style",
    "/audit",
    "/ps",
    "/stop",
    "/usage",
    "/burst",
    "/keys",
    "/skills",
    "/mcp",
    "/prompts",
  ]);

  router = createInputRouter({
    onPrompt: (line) => {
      const input = line.trim();
      if (inFlight && input) {
        if (!input.startsWith("/")) {
          inbox.push({ id: `q_${++inboxSeq}`, text: input });
          live.echoQueued(input, questionOpen ? "your answer" : undefined);
          return;
        }
        if (BESIDE_A_TURN.has(input.split(/\s+/)[0] ?? "")) {
          void handleLine(line).catch((err: unknown) =>
            console.error(`  ${c.danger(glyph.fail)} ${c.text(err instanceof Error ? err.message : String(err))}`),
          );
          return;
        }
      }
      queue.push(line);
    },
    write: (text) => process.stdout.write(text),
    onDiscarded: (line, reason) => {
      console.log(
        `  ${c.warn(glyph.warn)} ${c.muted(`ignored ${JSON.stringify(truncateLine(line))}: ${reason}`)}`,
      );
    },
  });

  rl.on("line", (line) => router!.accept(line));

  /*
   * The task given on the command line, run only now that input is read.
   *
   * It ran before the reader existed, so for the whole of the first turn
   * nothing read stdin: an `ask_user` there waited for ever on an answer that
   * was typed and never delivered, every approval was refused as though
   * "nobody can answer", and Ctrl-C killed the process instead of stopping
   * the turn. Through the queue, a piped stdin that closes early also waits
   * for it to finish instead of exiting beneath it.
   */
  if (initialPrompt) {
    console.log(`  ${c.brand.bold(glyph.arrow)} ${c.text(initialPrompt)}`);
    queue.push({ turn: initialPrompt });
  }


  /*
   * Finish the queue before exiting.
   *
   * "close" fires as soon as stdin ends, which for a pipe is immediately
   * after the input has been read — long before the queued turns have run.
   * Exiting there killed the process mid-drain, so a piped session printed
   * its banner and nothing else. Interactively it never showed, because
   * stdin stays open, which is why it survived until someone ran it
   * non-interactively.
   */
  rl.on("close", () => {
    closed = true;
    replClosed = true;
    void (async () => {
      await queue.drain();
      await pendingSave;
      await closeMcp();
      console.log(`\n  ${c.faint("bye")}\n`);
      process.exit(0);
    })();
  });
}

export async function runCli(args: string[] = process.argv): Promise<void> {
  const program = new Command();

  program
    .name("soreqen")
    .description("SoreQen Code: Autonomous AI Software Engineering Agent in Terminal")
    // The installed package's own version, not a number typed here.
    .version(packageInfo().version);

  // `soreqen code [prompt...]` Subcommand
  program
    .command("code", { isDefault: true })
    .description("Launch SoreQen Code autonomous agent session")
    .argument("[prompt...]", "Optional initial instruction to execute")
    /*
     * No Commander default, for the same reason `--mode`, `--effort` and
     * `--tier` have none: a default makes the option always present, so the
     * session restore could never tell "picked on the command line" from
     * "nothing passed" and a model chosen with `/model` was forgotten on every
     * restart. The fallback to MiMo lives in `loadCliConfig`.
     */
    .option("-m, --model <model>", "Model to use, e.g. mimo-v2.6-flash or deepseek-v4.1-flash")
    .option("-k, --api-key <key>", "OpenCode / OpenAI / Anthropic API Key")
    .option("-u, --base-url <url>", "Custom OpenAI-compatible API base URL")
    /*
      * No commander defaults on these three.
      *
      * A default here is indistinguishable from the user typing the value, and
      * three separate features depend on telling those apart:
      *
      *   - `--tier` defaulted to "guarded_autonomy", so `tierExplicitlySet`
      *     was *always* true and every turn sent a workspace ceiling nobody
      *     asked for. That is the bug that made `/mode bypass` silently run as
      *     auto — and it survived the first fix, because the fix keyed on
      *     "was a tier passed" and the answer was always yes.
      *   - `--mode` and `--effort` defaulting meant a saved session could
      *     never be restored: "did this launch specify a mode" was also always
      *     yes, so the stored one was never consulted.
      *
      * The defaults live in `DEFAULT_MODE` / `DEFAULT_EFFORT` and are applied
      * below, after the saved session has had its say.
      */
    .option(
      "--mode <mode>",
      "How much SoreQen asks: plan | manual | auto | bypass (default: auto, or the last mode used here)",
    )
    .option(
      "-e, --effort <effort>",
      "Reasoning effort: low | medium | high | extra | max (default: medium, or the last effort used here)",
    )
    .option(
      "-t, --tier <tier>",
      "Workspace ceiling the mode is clamped against (read_only | propose_only | guarded_autonomy | full_autonomy). Unset means the mode alone decides.",
    )
    .option("-w, --workspace <dir>", "Target workspace directory", process.cwd())
    .option("-p, --print", "Run prompt once and exit; exit code 0 done, 1 failed, 2 stopped short, 130 cancelled", false)
    .action(async (promptArr: string[], options: LaunchOptions) => {
      await startAgentSession(promptArr || [], options);
    });

  /*
   * The account and keys, outside a session: what someone types before the
   * first session, in a script, or on a machine they are setting up.
   */
  program
    .command("login")
    .description("Sign in with your SoreQen account (every plan, Free included, has credits for the hosted models)")
    .action(async () => {
      loadEnvFiles();
      const existing = loadAccount();
      if (existing) {
        console.log(`\n  Already signed in as ${existing.email || "your SoreQen account"}. Run \`soreqen logout\` to switch.\n`);
        return;
      }
      const signedIn = await setupSignIn();
      if (!signedIn) process.exit(1);
      console.log(signedIn.model ? chalk.dim(`  New sessions start on ${signedIn.model}.\n`) : "");
    });

  program
    .command("logout")
    .description("Sign this machine out of SoreQen")
    .action(async () => {
      const account = loadAccount();
      if (!account) {
        console.log("\n  Not signed in.\n");
        return;
      }
      await logout(account);
      const saved = loadUserConfig();
      if (saved.model?.startsWith(HOSTED_PREFIX)) saveUserConfig({ model: undefined });
      console.log("\n  Signed out of SoreQen on this machine.\n");
    });

  program
    .command("usage")
    .description("Your SoreQen credits: what you can spend now, the 5-hour and weekly windows, and Flex")
    .action(async () => {
      const account = loadAccount();
      if (!account) {
        console.log("\n  Not signed in. `soreqen login` to use your plan's models.\n");
        return;
      }
      try {
        console.log("");
        for (const line of describeUsage(await fetchUsage(account))) console.log(`  ${line}`);
        console.log("");
      } catch (err) {
        console.error(chalk.red(`\n  ${err instanceof Error ? err.message : String(err)}\n`));
        process.exit(1);
      }
    });

  program
    .command("burst")
    .description("Switch Burst Day on: 84% of your weekly limit in the next 24 hours, once a week")
    .action(async () => {
      const account = loadAccount();
      if (!account) {
        console.log("\n  Not signed in. `soreqen login` first.\n");
        return;
      }
      try {
        console.log(`\n  ${await startBurst(account)}\n`);
      } catch (err) {
        console.error(chalk.red(`\n  ${err instanceof Error ? err.message : String(err)}\n`));
        process.exit(1);
      }
    });

  program
    .command("flex [search]")
    .description("Find a Flex model and its price: paid from your Flex balance, at the provider's own price")
    .action(async (search?: string) => {
      const account = loadAccount();
      if (!account) {
        console.log("\n  Not signed in. `soreqen login` first.\n");
        return;
      }
      const found = await fetchFlexModels(account, search ?? "");
      console.log("");
      for (const m of found.models.slice(0, 40)) {
        const price = m.price ? `$${m.price.input} in, $${m.price.output} out per M` : "";
        console.log(`  ${m.id.padEnd(44)} ${price}`);
      }
      if (found.models.length > 40) console.log(`  ... and ${found.models.length - 40} more: narrow the search.`);
      if (found.models.length === 0) console.log("  No Flex model matches that.");
      console.log(`\n  Use one with /model soreqen/flex/<id>. Flex is paid from your Flex balance: top up at soreqen.com/credits.\n`);
    });

  program
    .command("setup")
    .description("Choose how SoreQen Code reaches a model: your SoreQen plan, or your own API key")
    .action(async () => {
      loadEnvFiles();
      await runSetup();
    });

  const keys = program.command("keys").description("Your own API keys, kept in ~/.soreqen/.env");
  keys
    .command("list", { isDefault: true })
    .description("Which providers have a key set")
    .action(() => {
      loadEnvFiles();
      console.log("");
      for (const p of OWN_KEY_PROVIDERS) {
        const key = p.keyVars.map((v) => process.env[v]).find(Boolean);
        const listed = modelList(p.modelVars.map((v) => process.env[v]).find(Boolean));
        const model = (listed.length > 0 ? listed : p.defaultModel ? [p.defaultModel] : []).join(", ");
        console.log(`  ${key ? chalk.green("✔") : " "} ${p.id.padEnd(11)} ${chalk.dim(key ? `${maskKey(key)}${model ? ` · ${model}` : ""}` : "not set")}`);
      }
      console.log("");
    });
  keys
    .command("set <provider>")
    .description(`Add or replace a key: ${OWN_KEY_PROVIDERS.map((p) => p.id).join(", ")}`)
    .option("-m, --model <model>", "The model to use with it")
    .action(async (providerId: string, options: { model?: string }) => {
      const provider = OWN_KEY_PROVIDERS.find((p) => p.id === providerId.toLowerCase());
      if (!provider) {
        console.error(chalk.red(`\n  Unknown provider '${providerId}'. One of: ${OWN_KEY_PROVIDERS.map((p) => p.id).join(", ")}\n`));
        process.exit(1);
      }
      const key = await ask(`\n  ${provider.label} API key ${chalk.dim("(not shown as you type)")}: `, { hidden: true });
      if (!key) process.exit(1);
      const listed = await listProviderModels(provider, key);
      if (!listed.ok) {
        console.error(chalk.red(`\n  ${provider.label} refused that key. Nothing was saved.\n`));
        process.exit(1);
      }
      const model = options.model ?? (provider.defaultModel && !listed.models.length ? provider.defaultModel : undefined);
      writeUserEnv({ [provider.keyVars[0]!]: key, ...(model ? { [provider.modelVars[0]!]: model } : {}) });
      console.log(chalk.green(`\n  ✔ Saved your ${provider.label} key.`) + (model ? chalk.dim(` Model: ${model}.`) : chalk.dim(` Pick a model with --model or \`soreqen setup\`.`)) + "\n");
    });
  keys
    .command("remove <provider>")
    .description("Delete a key")
    .action((providerId: string) => {
      const provider = OWN_KEY_PROVIDERS.find((p) => p.id === providerId.toLowerCase());
      if (!provider) {
        console.error(chalk.red(`\n  Unknown provider '${providerId}'.\n`));
        process.exit(1);
      }
      writeUserEnv(Object.fromEntries([...provider.keyVars, ...provider.modelVars].map((v) => [v, null])));
      console.log(`\n  Removed your ${provider.label} key.\n`);
    });

  program
    .command("update")
    .description("Install the newest SoreQen Code, the same way this one was installed")
    .action(async () => {
      process.exitCode = await runUpdate((line) => console.log(`  ${line}`));
    });

  const skills = program.command("skills").description("SoreQen's skills: which are on, and your own");
  skills
    .command("list", { isDefault: true })
    .description("Every skill and whether it is on")
    .action(async () => {
      console.log("");
      for (const line of await describeSkills()) console.log(`  ${line}`);
      console.log("");
    });
  for (const [verb, enabled] of [["enable", true], ["disable", false]] as const) {
    skills
      .command(`${verb} <name>`)
      .description(enabled ? "Switch a skill back on" : "Switch a skill off")
      .action(async (name: string) => {
        const done = await setSkillEnabled(name, enabled);
        if (!done) {
          console.error(chalk.red(`\n  No skill named '${name}'. \`soreqen skills\` lists them.\n`));
          process.exit(1);
        }
        console.log(`\n  ${chalk.green("✔")} ${done} is ${enabled ? "on" : "off"}.\n`);
      });
  }

  const mcp = program.command("mcp").description("MCP servers: tools from outside SoreQen, kept in ~/.soreqen/mcp.json");
  const collect = (value: string, all: string[]): string[] => [...all, value];
  const pairs = (list: string[], what: string): Record<string, string> =>
    Object.fromEntries(
      list.map((item) => {
        const at = item.indexOf("=");
        if (at < 1) {
          console.error(chalk.red(`\n  ${what} '${item}' should look like NAME=value.\n`));
          process.exit(1);
        }
        return [item.slice(0, at), item.slice(at + 1)];
      }),
    );
  mcp
    .command("list", { isDefault: true })
    .description("Connect to every configured server and show what it offers")
    .action(async () => {
      const { connectMcp: connect } = await import("@sqcode/mcp");
      const { hub, configs } = await connect({ soreqenHome: soreqenHome(), projectDir: process.cwd() });
      console.log("");
      for (const problem of configs.problems) console.log(`  ${chalk.yellow(problem)}`);
      for (const line of describeMcp(hub)) console.log(`  ${line}`);
      console.log("");
      await hub.close();
    });
  mcp
    .command("add <name> [command...]")
    .description("Add a server: `soreqen mcp add fs -- npx -y @modelcontextprotocol/server-filesystem .` or `--url https://…`")
    .option("--url <url>", "A remote server's address (streamable HTTP)")
    .option("--sse", "The remote server uses the older SSE transport")
    .option("--header <NAME=value>", "A header to send; ${VAR} is read from the environment", collect, [])
    .option("--env <NAME=value>", "An environment variable for a command server; ${VAR} is read from yours", collect, [])
    .option("--auto-approve", "Run this server's tools without asking (read-only tools never ask)")
    .action(async (name: string, command: string[], o: { url?: string; sse?: boolean; header: string[]; env: string[]; autoApprove?: boolean }) => {
      const { saveUserServer } = await import("@sqcode/mcp");
      if (!o.url && command.length === 0) {
        console.error(chalk.red("\n  Give a command after --, or --url for a remote server.\n"));
        process.exit(1);
      }
      try {
        saveUserServer(
          soreqenHome(),
          name,
          o.url
            ? { type: o.sse ? "sse" : "http", url: o.url, ...(o.header.length ? { headers: pairs(o.header, "Header") } : {}), ...(o.autoApprove ? { autoApprove: true } : {}) }
            : { type: "stdio", command: command[0]!, args: command.slice(1), ...(o.env.length ? { env: pairs(o.env, "Variable") } : {}), ...(o.autoApprove ? { autoApprove: true } : {}) },
        );
      } catch (err) {
        console.error(chalk.red(`\n  ${err instanceof Error ? err.message : String(err)}\n`));
        process.exit(1);
      }
      console.log(`\n  ${chalk.green("✔")} Added ${name}. ${chalk.dim("`soreqen mcp` checks that it connects.")}\n`);
    });
  mcp
    .command("remove <name>")
    .description("Remove one of your servers")
    .action(async (name: string) => {
      const { removeUserServer } = await import("@sqcode/mcp");
      const removed = removeUserServer(soreqenHome(), name);
      console.log(removed ? `\n  Removed ${name}.\n` : chalk.yellow(`\n  You have no server named ${name}.\n`));
    });
  mcp
    .command("trust")
    .description("Allow the MCP servers this project configures (.mcp.json), exactly as they are now")
    .action(async () => {
      const { McpTrust, readMcpConfigs } = await import("@sqcode/mcp");
      const configs = readMcpConfigs({ soreqenHome: soreqenHome(), projectDir: process.cwd() });
      if (!configs.projectHash) {
        console.log(chalk.dim("\n  This folder configures no MCP servers.\n"));
        return;
      }
      console.log(`\n  ${chalk.bold("Allowing these to run on this computer, for this folder:")}`);
      for (const s of configs.project) {
        const c = s.config;
        console.log(`    ${chalk.cyan(s.name.padEnd(16))} ${c.command ? `${c.command} ${(c.args ?? []).join(" ")}` : `${c.type} ${c.url}`}`);
      }
      new McpTrust(join(soreqenHome(), "mcp-trust.json")).trust(process.cwd(), configs.projectHash);
      console.log(chalk.dim("\n  If the configuration changes, you will be asked again.\n"));
    });
  mcp
    .command("untrust")
    .description("Stop allowing this project's MCP servers")
    .action(async () => {
      const { McpTrust } = await import("@sqcode/mcp");
      new McpTrust(join(soreqenHome(), "mcp-trust.json")).revoke(process.cwd());
      console.log("\n  This folder's MCP servers are no longer allowed.\n");
    });

  await program.parseAsync(args);
}
