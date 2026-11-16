import { CREATIVE_SKILLS } from "./builtin-creative.js";
import { FRONTEND_DESIGN } from "./builtin-frontend.js";

/**
 * SoreQen's own skills: the 28 that ship with SoreQen Code.
 *
 * Source: `docs/SoreQen_Skills.md`. Twelve are **always on** — the engineering
 * kernel every task runs under, placed in the system prompt so it is part of
 * the cached prefix and costs nothing after the first step. Sixteen are
 * **conditional** — focused checklists loaded when a task calls for one, by the
 * agent with `use_skill` or automatically when the request clearly matches.
 *
 * A conditional skill is a checklist, not permission for scope: loading
 * "observability" for a bug fix does not mean adding metrics to it.
 */

export type SkillKind = "always" | "conditional";

export interface SkillTrigger {
  /** Words in the request that suggest this skill. Each distinct match scores 1, or 2 when `strong`. */
  words?: RegExp;
  /**
   * Which of those matches say on their own that the work is this skill's:
   * "tailwind", "write tests", "deep research". A common word ("website",
   * "test", "download") scores 1 and needs another beside it; see
   * `SkillSet.match`.
   */
  strong?: RegExp;
  /** File paths named in the request that suggest it. A match scores 2. */
  paths?: RegExp;
  /** Whether writing a file `paths` covers loads the skill mid-turn (`SkillSet.reachedBy`). Default true. */
  reach?: boolean;
}

export interface SkillDefinition {
  /** Stable, kebab-case: what `use_skill` takes and what settings store. */
  name: string;
  title: string;
  kind: SkillKind;
  /** One line: what it is for. For conditional skills, when to load it. */
  description: string;
  /** The instructions, in Markdown. */
  body: string;
  /** Conditional skills only: when to load it without being asked. */
  trigger?: SkillTrigger;
  /** Where it came from. Built-ins are SoreQen's own. */
  source: "soreqen" | "user" | "project";
  /**
   * The skill's other files — `references/…`, `examples/…`, `scripts/…` —
   * relative to its folder, `/`-separated. Listed when the skill is loaded
   * and read on request, so a long reference costs nothing until it is needed.
   */
  files?: string[];
  /**
   * Where the files are: for the person's skills, the folder on this
   * machine; for a project's, the folder relative to the workspace root
   * (`.soreqen/skills/<name>` when absent).
   */
  dir?: string;
  /** SoreQen's own skills only: the text of each file in `files`, shipped inside SoreQen. */
  refs?: Record<string, string>;
}

const always = (name: string, title: string, description: string, body: string): SkillDefinition => ({
  name,
  title,
  kind: "always",
  description,
  body: body.trim(),
  source: "soreqen",
});

const conditional = (
  name: string,
  title: string,
  description: string,
  trigger: SkillTrigger,
  body: string,
): SkillDefinition => ({ name, title, kind: "conditional", description, trigger, body: body.trim(), source: "soreqen" });

/** The order rules are applied in when they pull different ways. */
export const OPERATING_PRIORITY = [
  "Safety, authorization, and preservation of user work.",
  "Repository and instruction discovery.",
  "User intent and acceptance criteria.",
  "Existing conventions and compatibility.",
  "Smallest correct implementation.",
  "Validation and evidence.",
  "Diff review and transparent reporting.",
];

/** Gone through before the closing summary. */
export const COMPLETION_CHECKLIST = [
  "Repository instructions and existing patterns were checked.",
  "User intent and acceptance criteria are clear.",
  "Unrelated changes were preserved.",
  "Implementation is the smallest coherent solution.",
  "Relevant tests/checks were run and honestly reported.",
  "Security and meaningful edge cases were considered.",
  "Final diff is reviewable.",
  "UI work, if any, passes the frontend anti-slop gate (frontend-design).",
  "Documentation was updated when behavior or setup changed.",
];

// ---------------------------------------------------------------------------
// Always on: the engineering kernel
// ---------------------------------------------------------------------------

export const KERNEL_SKILLS: SkillDefinition[] = [
  always(
    "orient-repository",
    "Orient in the repository",
    "Understand the existing project before changing it.",
    `
Before changing code:
- Inspect the tree, package manifests, lockfiles, entry points, and relevant configuration.
- Read repository instructions, contribution guides, README files, and local agent rules.
- Identify the language, framework, package manager, runtime, test runner, linter, formatter, and build command.
- Locate the narrowest relevant source files and existing tests.
- Check \`git status\` (git_operation) and preserve unrelated user changes.
Do not invent architecture before understanding the existing one.`,
  ),
  always(
    "clarify-task",
    "Clarify the task",
    "Turn the request into outcomes and acceptance criteria.",
    `
Translate the request into: intended outcome; current behavior; desired behavior; acceptance criteria; constraints and compatibility requirements; files and systems likely to be affected.
Make a reasonable, reversible assumption for low-risk ambiguity. Ask (ask_user) only when ambiguity could materially change behavior, data, security, permissions, or production impact.`,
  ),
  always(
    "plan-proportionally",
    "Plan proportionally",
    "A short plan for small changes, a detailed one for risky changes.",
    `
1. Understand or reproduce the behavior.
2. Find the root cause or correct extension point.
3. Implement the smallest coherent change.
4. Add or update focused tests.
5. Run focused validation, then broader checks as appropriate.
6. Review the final diff and summarize evidence.
Avoid ceremony for one-line fixes; do not skip planning for migrations, security, or broad refactors.`,
  ),
  always(
    "follow-conventions",
    "Follow local conventions",
    "Use the repository's patterns before your own defaults.",
    `
Prefer the repository's existing patterns for naming, structure, state, errors, logging, APIs, tests, styling, and abstractions. Extend an existing utility before creating a competing one. Keep compatibility unless the task explicitly authorizes a breaking change.`,
  ),
  always(
    "minimal-changes",
    "Make minimal, coherent changes",
    "Change only what the request needs, and keep it consistent.",
    `
Change only what is necessary to solve the request. Do not include unrelated formatting, renaming, dependency upgrades, speculative abstractions, or broad refactors. Keep a change internally consistent: update implementation, tests, types, docs, and configuration when the behavior requires it.`,
  ),
  always(
    "debug-from-evidence",
    "Debug from evidence",
    "Reproduce, hypothesize, confirm, fix the root cause.",
    `
For bugs, reproduce the failure when practical. Read the stack trace, logs, failing test, and relevant data flow. State a hypothesis (record it with update_task_state), validate it, then fix the root cause rather than masking symptoms. Prefer a regression test that fails before the fix and passes afterward.`,
  ),
  always(
    "validate-behavior",
    "Validate behavior",
    "Run the narrowest useful checks first, then widen.",
    `
format check → lint → type check → focused tests → broader tests → build
Use the project's actual commands. If a check cannot run, say why. Never claim a test, build, or review was performed when it was not.`,
  ),
  always(
    "edge-cases",
    "Consider relevant edge cases",
    "Examine the changed path's failure modes, not every conceivable one.",
    `
For the changed path, examine invalid and empty input, missing values, duplicates, retries, timeouts, partial failure, concurrency, permissions, backward compatibility, and offline/network failure. Do not add irrelevant defensive code or obscure the main logic.`,
  ),
  always(
    "security-active",
    "Keep security active",
    "Every change is also a security review of what it touches.",
    `
Look for hardcoded secrets, injection, unsafe shell or filesystem operations, path traversal, insecure deserialization, missing authorization, sensitive logs, weak cryptography, unsafe uploads, dependency risk, and incorrect CORS/CSRF behavior. Never print, commit, or expose secrets. Treat external input as untrusted.`,
  ),
  always(
    "dependency-hygiene",
    "Maintain dependency and environment hygiene",
    "Use what the project already uses; add dependencies deliberately.",
    `
Use the existing package manager and runtime. Check whether a dependency already exists before adding one. Prefer the standard library when it is adequate. Explain new dependencies, update lockfiles correctly, and avoid opportunistic upgrades.`,
  ),
  always(
    "git-safety",
    "Manage Git safely",
    "Never lose the person's work.",
    `
Inspect status before edits and review the final diff with status and diff summary. Do not overwrite unrelated work. Do not run destructive commands such as reset, clean, mass deletion, or force-push unless explicitly authorized. Do not commit unless requested.`,
  ),
  always(
    "communicate-result",
    "Communicate the result",
    "Report what happened, from evidence.",
    `
Report: what changed and why; files or areas changed; tests and checks actually run, including failures; assumptions and known limitations; follow-up work only when genuinely useful.`,
  ),
];

// ---------------------------------------------------------------------------
// Conditional: loaded when the task calls for them
// ---------------------------------------------------------------------------

export const CONDITIONAL_SKILLS: SkillDefinition[] = [
  conditional(
    "product-intent",
    "Product intent and acceptance criteria",
    "The request is vague, user-facing, or behavior-heavy: a new feature, app, flow or product.",
    {
      words:
        /\b(build|create|make|design)\b[^.\n]{0,40}\b(app|application|feature|product|flow|tool|web ?site|site|landing ?page|dashboard|portfolio|blog|store|shop|game|platform|mvp|prototype|saas)\b|\buser (stor(y|ies)|journeys?|flows?)\b|\bacceptance criteria\b|\brequirements?\b|\bspec(ification)?\b|\b(i|we) (want|need)\b[^.\n]{0,30}\b(app|application|feature|product|tool|platform|web ?site|system|bot)\b|\b(idea for|mvp|from scratch)\b/i,
      strong: /^(build|create|make|design|i|we)\b|user |acceptance criteria|^mvp$/i,
    },
    `
Convert the request into:
- User journeys: who does what, in what order, to reach which outcome.
- Non-goals: what is deliberately out of scope.
- Acceptance criteria: observable, checkable statements of done.
- The empty, loading, error and success states of each journey.
- Measurable completion conditions.
Keep product decisions visible (in the plan and the summary) instead of burying them in implementation details. When a decision is genuinely the user's, ask it once with ask_user and options.`,
  ),
  // The frontend skill, with its worked directions and review pass: builtin-frontend.ts.
  FRONTEND_DESIGN,
  conditional(
    "accessibility",
    "Accessibility and inclusive interaction",
    "UI work, forms, navigation, modals, tables, or flows used by diverse users.",
    {
      words:
        /\b(a11y|accessib\w*|screen ?reader|aria|wcag|keyboard (navigation|shortcuts?|users?)|contrast|forms?|modals?|dialogs?|navigation|tab order|alt text)\b/i,
      strong: /^(a11y|accessib\w*|screen ?reader|aria|wcag|keyboard \w+|tab order|alt text)$/i,
    },
    `
Check: semantic structure (landmarks, headings in order, lists, buttons that are buttons); keyboard operation of every control; focus management (moves into dialogs, returns on close, never lost); labels on every input; live announcements for async results and errors; contrast of text and controls; zoom to 200% and reflow at 320px; reduced motion; touch targets of at least 44px; error recovery that says what to fix.
Test behavior, not just static attributes: tab through the flow with browser_interact (press Tab / Enter / Escape) and read browser_snapshot, which shows the accessible names a screen reader would announce.`,
  ),
  conditional(
    "state-async",
    "State, async, and failure design",
    "A feature fetches data, mutates server state, uploads files, streams results, or depends on the network.",
    {
      words:
        /\b(loading (states?|spinners?|skeletons?)|fetch\w*|async|await|loading|spinner|upload\w*|download\w*|stream\w*|websocket|sse|polling|offline|retr(y|ies)|optimistic|mutation|react query|tanstack|swr|debounce|race condition|cancel\w*|pagination|infinite scroll|real-?time|live updates?|sync\w*|background (fetch|refresh)|react server (components|actions)|server actions?)\b/i,
      strong: /^(loading \w+|websocket|optimistic|react query|tanstack|swr|debounce|race condition|infinite scroll|background \w+|react server \w+|server actions?)$/i,
    },
    `
Model every state the feature can be in: idle, loading, refreshing, success, empty, partial, error, retry, stale, optimistic, and canceled.
Define duplicate-submit and race behavior: what a second click does, what happens when an older response arrives after a newer one, what cancel does to a request in flight.
Keep server state, local UI state, and URL state distinct; do not mirror server data into local state without a reason.
Make failures actionable: say what failed and what the person can do, and keep their input when a submit fails.`,
  ),
  conditional(
    "data-schema",
    "Data and schema evolution",
    "Database changes, persisted formats, migrations, event schemas, or API contract changes.",
    {
      words:
        /\b(migrations?|schema|database|db|sql|postgres\w*|mysql|sqlite|mongo\w*|prisma|drizzle|typeorm|sequelize|column|tables?|index(es)?|backfill|persist\w*|event schema|serializ\w*|orm|supabase|firebase|firestore|redis|dynamo\w*|data ?models?|entit(y|ies)|foreign keys?|seed data)\b/i,
      strong: /^(migrations?|prisma|drizzle|typeorm|sequelize|backfill|orm|foreign keys?|seed data|event schema|data ?models?)$/i,
      paths: /(migrations?\/|schema\.prisma$|\.sql$|schema\.(ts|js|py)$)/i,
    },
    `
Inspect real usage and data volume before designing the change. Plan: forward compatibility (old code reading new data, new code reading old data); backfill strategy; indexes and lock time on large tables; rollback or roll-forward behavior; nullability and defaults; deployment ordering between schema, code and data.
Never assume a migration is safe because it works on an empty database. Prefer additive, expand-then-contract changes over in-place rewrites. Dropping or truncating anything is on the STOP AND ASK list.`,
  ),
  conditional(
    "api-contracts",
    "API and contract quality",
    "Adding or changing APIs, webhooks, SDKs, or service boundaries.",
    {
      words:
        /\b(api|apis|endpoints?|webhooks?|sdk|rest api|graphql|grpc|trpc|openapi|swagger|api contract|status codes?|rate limit\w*|backend|server routes?|route handlers?|express|fastapi|flask|django|nestjs|hono|request body|response (body|shape|format))\b/i,
      strong: /^(endpoints?|webhooks?|graphql|grpc|trpc|openapi|swagger|rest api|api contract|status codes?|rate limit\w*|route handlers?|request body|response \w+)$/i,
      paths: /(\/api\/|\/routes?\/|\/controllers?\/|\/handlers?\/|openapi\.(ya?ml|json)$)/i,
    },
    `
Define the input, output, and error contracts explicitly. Cover: validation of every input; authentication and authorization (who may call it, and on whose data); idempotency for anything retried; pagination; rate limits; timeouts; observability; versioning and backward compatibility for existing callers; documentation.
Test malformed, unauthorized, duplicated, and partial requests, not only the happy path.`,
  ),
  conditional(
    "performance",
    "Performance and resource budgets",
    "Performance is requested, or a change touches rendering, queries, bundles, caching, concurrency or large data.",
    {
      words:
        /\b(perf\w*|slow\w*|faster|speed( up)?|optimi[sz]\w*|latency|throughput|memory|cpu|bundle size|lighthouse|n\+1|profil\w*|benchmark\w*|cach(e|ing)|lag\w*|jank)\b/i,
      strong: /^(performance|perf|latency|throughput|bundle size|lighthouse|n\+1|profiling|jank)$/i,
    },
    `
Measure before optimizing: establish a relevant budget (a latency, a frame time, a bundle size, a query count) and a reproducible measurement.
Identify the bottleneck with evidence, change one major variable at a time, and compare before and after with the same measurement.
Check memory, CPU, network, database queries, bundle size, and perceived responsiveness as applicable. Report the numbers, not the impression.`,
  ),
  conditional(
    "observability",
    "Observability and operability",
    "Background jobs, production services, integrations, payments, notifications, anything hard to reproduce locally.",
    {
      words:
        /\b(logg?(ing|er)|logs|metrics?|tracing|traces|telemetry|monitor\w*|alert\w*|background jobs?|queues?|cron|workers?|payments?|billing|notifications?|health ?checks?|on-?call|incident|sentry|opentelemetry)\b/i,
      strong: /^(observability|telemetry|opentelemetry|sentry|tracing|on-?call|incident|health ?checks?)$/i,
    },
    `
Add what an operator needs at 3 a.m.: structured logs with context; useful metrics; traces or correlation IDs across boundaries; health and readiness behavior; actionable error messages; safe redaction of secrets and personal data; a retry policy with backoff; dead-letter or recovery handling for work that fails; and runbook-level documentation of how to tell it is broken and what to do.`,
  ),
  conditional(
    "test-strategy",
    "Test strategy and change safety",
    "High-risk behavior, regressions, critical workflows, or weakly tested code.",
    {
      words:
        /\b((write|add|missing|more|failing|fix( the)?) (unit |integration |e2e |end-to-end )?tests?|tests?|testing|regressions?|coverage|flaky|e2e|end-to-end|unit tests?|integration tests?|tdd|spec files?|pytest|jest|vitest|playwright|cypress|mocha|test cases?)\b/i,
      strong: /^((write|add|missing|more|failing|fix)\b.*|flaky|e2e|end-to-end|unit tests?|integration tests?|tdd|spec files?|pytest|jest|vitest|cypress|mocha|test cases?)$/i,
      paths: /(\.(test|spec)\.[jt]sx?$|_test\.(go|py)$|\/tests?\/)/i,
    },
    `
Choose the lowest-cost test that proves the behavior, then add integration or end-to-end coverage where boundaries matter. Test user-visible outcomes and failure paths. For a bug, write the test that fails before the fix and passes after it, and run it both ways.
Avoid brittle tests coupled to implementation details, snapshot tests of things nobody reviews, and mocks that assert the code calls itself. Never weaken or skip a test to make it pass.`,
  ),
  conditional(
    "release-safety",
    "Release and migration safety",
    "Production configuration, feature flags, rollouts, upgrades, or changes that cannot be instantly undone.",
    {
      words:
        /\b(release|deploy\w*|rollout|roll out|feature flags?|production|prod|staging|rollback|canary|upgrade|ci\/cd|pipeline|infrastructure|docker\w*|kubernetes|k8s|terraform|ship (it|this)|go live|host(ing|ed)?|vercel|netlify|coolify|fly\.io|render\.com|aws|gcp|azure|github actions|publish(ing)? (to|on) (npm|pypi|the store))\b/i,
      strong: /^(deploy\w*|rollout|roll out|rollback|canary|feature flags?|staging|ci\/cd|github actions|kubernetes|k8s|terraform|ship \w+|go live|publish\w* \w+ .+)$/i,
      paths: /(\.github\/workflows\/|dockerfile|docker-compose|\.tf$)/i,
    },
    `
Separate deploy from release when useful (a flag, a config switch). Define preconditions, the monitoring signals that say it is working or not, rollback and roll-forward steps, compatibility windows between old and new versions, and the cleanup of temporary flags.
Prefer reversible rollout mechanisms. Changing CI/CD, deployment configuration or production infrastructure needs explicit instruction (STOP AND ASK).`,
  ),
  conditional(
    "dependency-review",
    "Dependency and supply-chain review",
    "Introducing, upgrading, or removing dependencies.",
    {
      words:
        /\b((add|introduce|upgrade|update|bump|replace|remove|swap|choose|pick)\b[^.\n]{0,25}\b(dependenc(y|ies)|packages?|librar(y|ies))|dependenc(y|ies)|upgrade|bump|package|packages|library|libraries|vulnerab\w*|supply.chain|npm audit|audit|lockfile|outdated)\b/i,
      strong: /^((add|introduce|upgrade|update|bump|replace|remove|swap|choose|pick)\b.*\b(dependenc|package|librar)\w*|vulnerab\w*|supply.chain|npm audit|lockfile|outdated)$/i,
      paths: /(package\.json|requirements\.txt|pyproject\.toml|cargo\.toml|go\.mod|gemfile|pom\.xml|build\.gradle)$/i,
      // A new project writes its package.json on the way to everything else.
      reach: false,
    },
    `
Before adding one, check: whether the functionality already exists in the project or the standard library; license and maintenance signals (recent releases, open issues, maintainers); transitive impact; bundle and runtime cost; known vulnerabilities; and the lockfile change it causes.
Keep the diff and upgrade scope narrow: one dependency at a time, no opportunistic upgrades. Installing a dependency not implied by the task is on the STOP AND ASK list.`,
  ),
  conditional(
    "documentation",
    "Documentation and developer experience",
    "Behavior, setup, public interfaces, commands, environment variables or architecture change.",
    {
      words:
        /\b((write|update|add|improve|create|fix)\b[^.\n]{0,20}\b(docs|documentation|readme|guide|changelog|docstrings?|comments)|docs?|documentation|readme|guide|setup|install instructions|env(ironment)? var\w*|\.env|onboarding|changelog|comments?|jsdoc|docstrings?|public api)\b/i,
      strong: /^((write|update|add|improve|create|fix)\b.*|jsdoc|docstrings?)$/i,
      paths: /(readme|changelog|contributing)(\.md)?$|\/docs?\//i,
    },
    `
Update the smallest authoritative document: the one people actually read for this. Include copy-pasteable examples, explain failure modes and how to recover from them, and remove stale instructions rather than adding contradicting ones. Documentation is part of the implementation when users or maintainers rely on it.`,
  ),
  // Research, motion graphics, writing and planning, documents: builtin-creative.ts.
  ...CREATIVE_SKILLS,
];

export const BUILTIN_SKILLS: SkillDefinition[] = [...KERNEL_SKILLS, ...CONDITIONAL_SKILLS];
