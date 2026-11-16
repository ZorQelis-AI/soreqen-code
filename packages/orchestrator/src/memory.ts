/**
 * Memory: what SoreQen learns about the person and their projects, kept
 * between sessions.
 *
 * Task state (context/task-state.ts) is one session's working memory and ends
 * with it. This is the other kind: the person prefers pnpm, wants no
 * em-dashes, was burnt by a migration last month; this project deploys from
 * `main` by a tag, its staging database is on port 5433; the VPS set up last
 * week is at that address, reached with that key. Things no file in the
 * repository says, which the agent would otherwise be told again in every new
 * session, and would get wrong until it was.
 *
 * ## Shape
 *
 * One small markdown file per memory, with front matter, and an index
 * (MEMORY.md) of one line each. Two scopes:
 *
 *   - **global** (stored as `user`): about the person, and everything not
 *     tied to one folder: their machines, servers, accounts, where their
 *     projects live. ~/.soreqen/memory/
 *   - **project**: about one open folder, beside SoreQen's other data for it,
 *     never inside the person's folder.
 *
 * A chat with no folder of its own has no project memory: what it learns is
 * global. (It used to get a project memory of its throwaway session folder,
 * which no later chat could ever find, and which deleting the chat deleted.)
 *
 * Every turn starts with a snapshot: every memory's line, the ones that bear
 * on the request in full, and a list of other projects' memories, so a new
 * chat asked to "connect to that VPS" finds the project where it was set up.
 * A snapshot, not a live view: a memory saved midway through a turn shows
 * from the next one, so the system prompt, and with it the provider's prompt
 * cache, stays the same for the whole turn.
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export type MemoryScope = "user" | "project";
export const MEMORY_KINDS = ["user", "feedback", "project", "reference"] as const;
export type MemoryKind = (typeof MEMORY_KINDS)[number];

export interface MemoryEntry {
  scope: MemoryScope;
  /** The file's name without `.md`: short, kebab-case, the key to update or forget it by. */
  name: string;
  /** One line: what the memory is about, used to decide whether it is relevant. */
  description: string;
  kind: MemoryKind;
  content: string;
  updatedAt: string;
  /** For a memory of another project: which one. */
  project?: string;
}

/** Another project's memory: readable from here, written only from there. */
export interface OtherProjectMemory {
  /** Its folder's name, which is how the person and the model refer to it. */
  label: string;
  /** The folder, when known. */
  folder?: string;
  dir: string;
}

export interface MemoryDirs {
  /** Global: about the person, and everything not tied to one folder. */
  user?: string;
  /** The open project's own memory. */
  project?: string;
  /** The open project's folder, recorded beside its memory so other sessions can name it. */
  projectFolder?: string;
  /** Every other project that has memories. */
  others?: OtherProjectMemory[];
}

const NAME_MAX = 60;
const DESCRIPTION_MAX = 200;
const CONTENT_MAX = 4000;
/**
 * The longest note `remember` takes: about 200 words. Memories had become
 * logs (15 Oct 2026): a model's project memory was rewritten five times in
 * a day, each time longer, with every score, step count and status since it
 * began, 2,800 characters loaded into every turn of every session. A note
 * that does not fit is told to keep what a future session acts on.
 */
export const NOTE_MAX = 1_200;
/**
 * The longest note actually refused.
 *
 * A model cannot count characters as it writes. With the limit and the
 * refusal at the same 1,200, a note was refused at 1,788, then 1,301, 1,272
 * and 1,208 characters, five failed saves in a row for one memory, each a
 * red "Failed" row (reported 18 Oct 2026). The prompt still asks for 1,200;
 * up to this is saved, with a word to keep the next one shorter, and past it
 * the refusal says exactly how much to cut.
 */
export const NOTE_HARD_MAX = 1_600;
/** How alike two memories' subjects must be for a new one to be sent to the old one instead. */
const SAME_SUBJECT = 0.5;
/** At most this many per scope: memory is a short list of what matters, not a log. */
const ENTRIES_MAX = 200;
/** Of the snapshot, in characters (about 3,000 tokens): beyond it, one line each. */
const SNAPSHOT_BUDGET = 12_000;
/** Lines about other projects' memories, at most. */
const OTHERS_MAX = 40;
/** The file beside a project's memories that says which folder they are about. */
export const FOLDER_FILE = ".folder";

export function memorySlug(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, NAME_MAX);
}

function oneLine(text: string, max: number): string {
  return text.replace(/\s+/g, " ").trim().slice(0, max);
}

/** A memory's first sentence, for the index line when no description was given (not its first 200 characters). */
function firstSentence(text: string): string {
  const one = text.replace(/\s+/g, " ").trim();
  const end = one.search(/[.!?](\s|$)/);
  return end > 0 && end < 160 ? one.slice(0, end + 1) : one.length > 160 ? `${one.slice(0, 159)}…` : one;
}

const STOP = new Set(
  (
    "the and for that this with from into have has had was were are you your our its not but can will would should could " +
    "what when where which who how why all any some then than them they there these those just also only very more most " +
    "such about over under again once here been being does did doing done make made use used using want need like get got " +
    "let lets please now new old one two out off thing things work file files code"
  ).split(" "),
);

/** The words of a text that say what it is about. */
function topicWords(text: string): Set<string> {
  const out = new Set<string>();
  for (const w of text.toLowerCase().split(/[^a-z0-9]+/)) {
    if (w.length < 3 || STOP.has(w)) continue;
    out.add(w.length > 4 && w.endsWith("s") ? w.slice(0, -1) : w);
  }
  return out;
}

/**
 * Whether a memory goes into a turn's prompt whole, or as its index line.
 *
 * Every memory that fitted used to go in whole, newest first, whatever was
 * asked: a session opened with "hi" carried the full notes of a font build
 * and a model-readiness review, 5,400 of its first 23,000 tokens (measured
 * 6 Nov 2026). Who the person is applies to every request, so it stays
 * whole. How they want work done (feedback) comes whole as soon as the
 * request shares anything with it: its one-line description already states
 * the rule, and many are about one project ("Kestrel must match BlueStacks").
 * The rest come whole when the request is clearly about them. Everything
 * else is the line that says what it is, one `recall` away.
 */
const FULL_SCORE = 3;
// Which kinds of memory are always shown whole: user always; feedback when short or the
// request shares a word with it; the rest when the request is about them (FULL_SCORE).
/** A preference this short costs less whole than a description that might not state it. */
const SHORT_FEEDBACK = 600;
function inFull(entry: MemoryEntry, score: number): boolean {
  if (entry.kind === "user") return true;
  if (entry.kind === "feedback") return score >= 1 || entry.content.length <= SHORT_FEEDBACK;
  return score >= FULL_SCORE;
}

/** How much a memory has to do with what was asked: shared topic words, its name and description counting double. */
function relevance(entry: MemoryEntry, asked: Set<string>): number {
  if (asked.size === 0) return 0;
  let score = 0;
  for (const w of topicWords(`${entry.name.replace(/-/g, " ")} ${entry.description} ${entry.project ?? ""}`)) if (asked.has(w)) score += 2;
  for (const w of topicWords(entry.content)) if (asked.has(w)) score += 1;
  return score;
}

export class MemoryStore {
  constructor(private readonly dirs: MemoryDirs) {}

  /** Which store this is, as one string: its folders. */
  get key(): string {
    return `${this.dirs.user ?? ""}|${this.dirs.project ?? ""}`;
  }

  scopes(): MemoryScope[] {
    return (["user", "project"] as const).filter((s) => this.dirs[s]);
  }

  private dir(scope: MemoryScope): string {
    const dir = this.dirs[scope];
    if (!dir) {
      throw new Error(
        scope === "project"
          ? "No project folder is open in this session, so there is no project memory. Save it with scope 'global'."
          : "Global memory is not available here.",
      );
    }
    return dir;
  }

  list(scope: MemoryScope): MemoryEntry[] {
    return this.listIn(scope, this.dirs[scope]);
  }

  private listIn(scope: MemoryScope, dir: string | undefined, project?: string): MemoryEntry[] {
    if (!dir || !existsSync(dir)) return [];
    const out: MemoryEntry[] = [];
    for (const file of readdirSync(dir)) {
      if (!file.endsWith(".md") || file === "MEMORY.md") continue;
      try {
        const entry = this.parse(scope, file.slice(0, -3), readFileSync(join(dir, file), "utf8"));
        if (entry) out.push(project ? { ...entry, project } : entry);
      } catch {
        // One unreadable file costs that memory, not the rest.
      }
    }
    return out.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  /** Every other project's memories, each marked with its project. */
  others(): MemoryEntry[] {
    return (this.dirs.others ?? []).flatMap((o) => this.listIn("project", o.dir, o.label));
  }

  read(scope: MemoryScope, name: string, project?: string): MemoryEntry | null {
    const slug = memorySlug(name);
    if (!slug) return null;
    if (project) {
      const wanted = project.trim().toLowerCase();
      const other = (this.dirs.others ?? []).find(
        (o) => o.label.toLowerCase() === wanted || (o.folder !== undefined && o.folder.toLowerCase() === wanted),
      );
      if (!other) return null;
      const file = join(other.dir, `${slug}.md`);
      const entry = existsSync(file) ? this.parse("project", slug, readFileSync(file, "utf8")) : null;
      return entry ? { ...entry, project: other.label } : null;
    }
    const dir = this.dirs[scope];
    if (!dir) return null;
    const file = join(dir, `${slug}.md`);
    return existsSync(file) ? this.parse(scope, slug, readFileSync(file, "utf8")) : null;
  }

  /** Save a memory, or replace the one of the same name. */
  save(input: { scope: MemoryScope; name: string; description: string; kind?: string; content: string }): { entry: MemoryEntry; replaced: boolean } {
    const dir = this.dir(input.scope);
    const name = memorySlug(input.name);
    if (!name) throw new Error("A memory needs a name: a few words, like 'prefers-pnpm'.");
    const content = input.content.trim().slice(0, CONTENT_MAX);
    if (!content) throw new Error("A memory needs content.");
    const description = oneLine(input.description || firstSentence(content), DESCRIPTION_MAX);
    const kind = (MEMORY_KINDS as readonly string[]).includes(input.kind ?? "") ? (input.kind as MemoryKind) : input.scope === "user" ? "user" : "project";
    const replaced = existsSync(join(dir, `${name}.md`));
    if (!replaced && this.list(input.scope).length >= ENTRIES_MAX) {
      throw new Error(`There are already ${ENTRIES_MAX} memories here. Update or forget one that no longer matters first.`);
    }
    const entry: MemoryEntry = { scope: input.scope, name, description, kind, content, updatedAt: new Date().toISOString() };
    mkdirSync(dir, { recursive: true });
    const body = `---\nname: ${name}\ndescription: ${JSON.stringify(description)}\ntype: ${kind}\nupdated: ${entry.updatedAt}\n---\n\n${content}\n`;
    writeFileSync(join(dir, `${name}.md.tmp`), body, "utf8");
    renameSync(join(dir, `${name}.md.tmp`), join(dir, `${name}.md`));
    if (input.scope === "project" && this.dirs.projectFolder) {
      try {
        writeFileSync(join(dir, FOLDER_FILE), this.dirs.projectFolder, "utf8");
      } catch {
        // Only a label for other sessions; the memory itself is saved.
      }
    }
    this.writeIndex(input.scope);
    return { entry, replaced };
  }

  /**
   * An existing memory about what a new one is about, judged by the words of
   * its name and description: where the new fact belongs, instead of beside
   * it. "The API needs X" and later "the API needs Y" is one memory, "the API
   * needs X and Y" (asked for 15 Oct 2026).
   */
  sameSubject(scope: MemoryScope, name: string, description: string, content: string): MemoryEntry | null {
    const slug = memorySlug(name);
    // Subject to subject: names and one-line descriptions, not the bodies, which share words by chance.
    const mine = topicWords(`${slug.replace(/-/g, " ")} ${description || firstSentence(content)}`);
    if (mine.size === 0) return null;
    let best: { entry: MemoryEntry; score: number } | null = null;
    for (const entry of this.list(scope)) {
      if (entry.name === slug) continue;
      const theirs = topicWords(`${entry.name.replace(/-/g, " ")} ${entry.description}`);
      let shared = 0;
      for (const w of theirs) if (mine.has(w)) shared++;
      const score = theirs.size === 0 ? 0 : shared / Math.min(theirs.size, mine.size);
      if (shared >= 2 && score >= SAME_SUBJECT && (!best || score > best.score)) best = { entry, score };
    }
    return best?.entry ?? null;
  }

  forget(scope: MemoryScope, name: string): boolean {
    const dir = this.dirs[scope];
    const slug = memorySlug(name);
    if (!dir || !slug || !existsSync(join(dir, `${slug}.md`))) return false;
    rmSync(join(dir, `${slug}.md`), { force: true });
    this.writeIndex(scope);
    return true;
  }

  /**
   * What a turn starts with.
   *
   * Every memory has a line; the ones with most to do with what the person
   * just asked, then the newest, are shown in full while they fit. Another
   * project's memory is shown in full only when it bears on the request,
   * otherwise listed, so the agent knows it exists and can recall it.
   */
  snapshot(request = "", budget = SNAPSHOT_BUDGET): string {
    const asked = topicWords(request);
    let used = 0;
    const sections: string[] = [];
    const render = (title: string, entries: MemoryEntry[], limit = Infinity): void => {
      if (entries.length === 0) return;
      const ranked = entries
        .map((e, i) => ({ e, score: relevance(e, asked), i }))
        .sort((a, b) => b.score - a.score || a.i - b.i);
      const full: string[] = [];
      const lines: string[] = [];
      for (const { e, score } of ranked) {
        const where = e.project ? `[${e.project}] ` : "";
        const text = `- ${where}**${e.name}** (${e.kind}, ${e.updatedAt.slice(0, 10)}): ${e.content.replace(/\n+/g, " ")}`;
        if ((!e.project || score > 0) && inFull(e, score) && used + text.length <= budget) {
          full.push(text);
          used += text.length;
        } else if (lines.length < limit) {
          lines.push(`- ${where}${e.name}: ${e.description}`);
        }
      }
      const hidden = entries.length - full.length - lines.length;
      sections.push(
        [
          title,
          ...full,
          ...(lines.length > 0 ? [full.length > 0 ? "Listed only (read with recall):" : "(read with recall)", ...lines] : []),
          ...(hidden > 0 ? [`…and ${hidden} more.`] : []),
        ].join("\n"),
      );
    };
    if (this.dirs.user) render("### Global (about the person, their machines, servers and accounts; every project)", this.list("user"));
    if (this.dirs.project) render("### This project", this.list("project"));
    render(
      "### Other projects (not open now; read one with recall, passing its project name)",
      this.others().sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)),
      OTHERS_MAX,
    );
    return sections.join("\n\n");
  }

  /** Rewrite a scope's MEMORY.md from the files that are there. */
  reindex(scope: MemoryScope): void {
    this.writeIndex(scope);
  }

  private writeIndex(scope: MemoryScope): void {
    const dir = this.dirs[scope];
    if (!dir) return;
    const lines = this.list(scope).map((e) => `- [${e.name}](${e.name}.md): ${e.description}`);
    writeFileSync(join(dir, "MEMORY.md"), `# Memory\n\n${lines.join("\n")}\n`, "utf8");
  }

  private parse(scope: MemoryScope, name: string, text: string): MemoryEntry | null {
    const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(text);
    const head = m?.[1] ?? "";
    const field = (key: string): string => {
      const raw = new RegExp(`^${key}:\\s*(.*)$`, "m").exec(head)?.[1]?.trim() ?? "";
      if (raw.startsWith('"')) {
        try {
          return String(JSON.parse(raw));
        } catch {
          return raw.slice(1, -1);
        }
      }
      return raw;
    };
    const content = (m ? m[2]! : text).trim();
    if (!content) return null;
    const kind = field("type");
    return {
      scope,
      name,
      description: field("description") || oneLine(content, DESCRIPTION_MAX),
      kind: (MEMORY_KINDS as readonly string[]).includes(kind) ? (kind as MemoryKind) : scope === "user" ? "user" : "project",
      content,
      updatedAt: field("updated") || "1970-01-01T00:00:00.000Z",
    };
  }
}

/**
 * Every project under `<home>/projects` that has memories, except one.
 *
 * Labelled with the folder it is about when its memory recorded that, or
 * else with the data folder's name less its hash (`app-1a2b3c4d` → `app`).
 */
export function otherProjectMemories(projectsDir: string, exceptDir?: string): OtherProjectMemory[] {
  if (!existsSync(projectsDir)) return [];
  const except = exceptDir?.replace(/\\/g, "/").toLowerCase();
  const out: OtherProjectMemory[] = [];
  for (const name of readdirSync(projectsDir)) {
    const dir = join(projectsDir, name, "memory");
    if (dir.replace(/\\/g, "/").toLowerCase() === except) continue;
    try {
      if (!readdirSync(dir).some((f) => f.endsWith(".md") && f !== "MEMORY.md")) continue;
    } catch {
      continue;
    }
    let folder: string | undefined;
    try {
      folder = readFileSync(join(dir, FOLDER_FILE), "utf8").trim() || undefined;
    } catch {
      // Saved before folders were recorded.
    }
    const label = (folder ? folder.replace(/[\\/]+$/, "").split(/[\\/]/).pop() : undefined) || name.replace(/-[0-9a-f]{8}$/, "");
    out.push({ label, dir, ...(folder ? { folder } : {}) });
  }
  return out;
}

/**
 * Move one folder's memories into global memory.
 *
 * For chats that had a throwaway folder of their own: what they learned
 * belongs to the person, not to a folder no later chat will open. A memory
 * whose name is already taken globally keeps its own under a suffix; nothing
 * is overwritten. Returns how many moved.
 */
export function absorbIntoGlobal(fromDir: string, globalDir: string): number {
  if (!existsSync(fromDir)) return 0;
  let moved = 0;
  for (const file of readdirSync(fromDir)) {
    if (!file.endsWith(".md") || file === "MEMORY.md") continue;
    try {
      mkdirSync(globalDir, { recursive: true });
      let target = join(globalDir, file);
      for (let n = 2; existsSync(target); n++) target = join(globalDir, file.replace(/\.md$/, `-${n}.md`));
      renameSync(join(fromDir, file), target);
      moved++;
    } catch {
      // Left where it is; tried again next time.
    }
  }
  if (moved > 0) {
    new MemoryStore({ user: globalDir }).reindex("user");
    try {
      rmSync(join(fromDir, "MEMORY.md"), { force: true });
      rmSync(join(fromDir, FOLDER_FILE), { force: true });
    } catch {
      // Harmless leftovers.
    }
  }
  return moved;
}

/**
 * The prompt's section on memory: what is remembered, and how to use it.
 *
 * Modelled on how Claude Code's own memory is meant to work: save at the
 * moment something is learned, not when asked; one subject per memory with
 * why; update instead of duplicating; verify before relying on it. Saving
 * was asked for too eagerly (15 Oct 2026: a status log rewritten after every
 * check of a training run), so it now says most turns save nothing.
 */
export function memoryPromptSection(snapshot: string, scopes: MemoryScope[]): string {
  const hasProject = scopes.includes("project");
  const guide = [
    "## MEMORY (kept between sessions)",
    "",
    "You have a memory that outlives this session, like a colleague's notebook. It is how a future session, even after /clear or in a brand-new chat, knows what you set up, decided and learned today. Its current contents are below.",
    "",
    "### Using it",
    "- Read it at the start of every task. When the person refers to something from before (\"connect to that VPS\", \"deploy it like last time\", \"the bot we made\"), the answer is usually here: use it instead of asking them again.",
    "- A memory is a note from when it was written, not live state. Before acting on one that names a file, server, command or flag, check it still holds (the file exists, the host answers). If it is wrong, fix or `forget` it.",
    "- Memories listed without their content: read them with `recall`. Another project's: `recall` with `project` set to its name.",
    "",
    "### Saving to it: what is crucial, when you learn it",
    "Most turns save nothing. Save with `remember` only when this session establishes something a future session would get wrong, or spend real time rediscovering, without it — and could not get from the files. Ask that before every save; if the answer is no, do not save. When it is yes, save at the moment you learn it, without being asked. What clears that bar:",
    "- You set up or connect to infrastructure: a server or VPS (host/IP, SSH user, which key file, what runs there, how it is deployed and restarted), a database, a domain and its DNS, a cloud account, a CI pipeline.",
    "- How this project is built, run, tested or deployed when it is not written down; a trap that cost real time, and its fix.",
    "- A root cause you found by real investigation, and the conclusion it led to (\"the loss collapsed because X; fixed by Y\"), so a later session does not repeat the hunt.",
    "- How a non-obvious part of the project works, learned by reading a lot of it: the entry point, the config that controls X, the module everything passes through.",
    "- The person states a preference or corrects you (\"always…\", \"never…\", \"don't…\", \"I prefer…\"): save it with the reason, so you know when it applies.",
    "- The person confirms an approach you chose was right (\"yes, exactly\", \"keep doing it this way\", accepting an unusual choice without pushback): save that too. Saving only corrections makes you cautious and drifts you away from what already works.",
    "- A decision that outlives this task, and why; where things live outside this folder.",
    "- The person asks you to remember something: save it at once. Only say it will carry over after `remember` succeeded.",
    "",
    "### What a good memory looks like",
    `- A short note, a few lines (at most ${NOTE_MAX} characters): the facts a future session acts on, not a summary of the work. Quality over quantity.`,
    "- Specific and self-contained: names, paths, hosts, ports, commands, versions, absolute dates (convert \"yesterday\" to a date).",
    "- One memory per subject. Before saving, look down the list: when a memory already covers the subject, change that one instead of adding a second. For one fact that changed, `edit_memory` (replace just that text); for a note that needs rewriting, `remember` under its name with the whole new note (what is still true, plus the new fact, minus what is outdated). Do not rewrite a memory to restate it or to add today's work: a rewrite that adds nothing is not saved.",
    "- A memory you find wrong while working (a moved file, a changed host): fix it with `edit_memory` or `forget` it at once, not later.",
    "- Link related memories with [[their-name]] in the note (the server and the project deployed to it; a preference and the incident behind it). `recall` shows a memory's links.",
    "- For feedback and decisions, add **Why:** and **How to apply:** lines. A one-line description that says when it is relevant.",
    "- Kinds: user (who they are, their setup), feedback (how they want you to work), project (facts, decisions, how things run), reference (where to find things).",
    `- Scope: ${hasProject ? "'project' for what belongs to this folder (how it builds, deploys, its decisions); " : ""}'global' for the person and everything not tied to one folder: their preferences, machines, servers, accounts, and where their projects are.${hasProject ? "" : " No project folder is open in this session, so everything is global."}`,
    "",
    "### Never save",
    "- Progress, status, running numbers, step counts, a log of what was built, fixed or tested today, or a history of a run: they change by tomorrow and belong in your reply and the project's files. A long job's how-to-resume is fine; its latest numbers are not. A conclusion that changes how future work is done is not progress: save that.",
    "- Secrets: passwords, API keys, tokens, private keys. Save where they are kept instead (\"the key is in ~/.ssh/vps_ed25519\").",
    "- What the files or git history already say, what only matters to this task (that is update_task_state, which ends with the session), or guesses.",
    "",
    "Saving is quiet work: do not announce it beyond a few words.",
  ];
  return snapshot ? [...guide, "", snapshot].join("\n") : [...guide, "", "(Nothing remembered yet.)"].join("\n");
}

/**
 * The memories a note links to: `[[name]]`, as in Claude Code's memory.
 *
 * A server's memory links the project deployed to it, a preference links the
 * incident behind it. `recall` follows the links one step, so reading one
 * memory shows what else is known about its subject.
 */
export function linksIn(content: string): string[] {
  const out: string[] = [];
  for (const m of content.matchAll(/\[\[([^\]\n]{1,80})\]\]/g)) {
    const slug = memorySlug(m[1]!);
    if (slug && !out.includes(slug)) out.push(slug);
  }
  return out.slice(0, 20);
}

/** The tidy pass's instructions, shared with the app's screen (see `memory-tidy.ts` in shared). */
export { MEMORY_TIDY_PROMPT } from "@sqcode/shared";

const SCOPE_SCHEMA = {
  type: "string",
  enum: ["global", "project"],
  description: "global: the person and everything not tied to one folder (machines, servers, accounts). project: this open folder.",
};

/** The tools, offered only when there is a memory to use. */
export const MEMORY_TOOL_DEFINITIONS = [
  {
    name: "remember",
    description:
      "Save a short note to your memory that outlives this session, or rewrite the memory of the same name. Only for what a future session would need and could not find in the files: infrastructure you set up or connected to, how a project builds or deploys when that is not written down, a preference or correction, a decision and why. Not progress, results or a summary of the work. To add to a memory, rewrite it under its name as one note. See the MEMORY section of your instructions.",
    input_schema: {
      type: "object" as const,
      properties: {
        scope: SCOPE_SCHEMA,
        name: { type: "string", description: "Short kebab-case name, e.g. 'nexryzen-vps'. The same name rewrites that memory." },
        description: { type: "string", description: "One line: what it is about, for deciding later whether it is relevant." },
        kind: { type: "string", enum: [...MEMORY_KINDS], description: "user: who they are; feedback: how they want you to work; project: facts and decisions; reference: where to find things." },
        content: {
          type: "string",
          description: `The note itself: concise and specific enough to act on, at most ${NOTE_MAX} characters. When rewriting, the whole new note: what is still true, plus what you learned.`,
        },
        distinct: {
          type: "boolean",
          description: "Only when SoreQen pointed you to a memory on the same subject and this is genuinely a different one.",
        },
      },
      required: ["scope", "name", "content"],
    },
  },
  {
    name: "edit_memory",
    description:
      "Change part of a memory in place: replace old_text, which must appear exactly once in it, with new_text (empty to delete it). For one fact that changed (a new IP, a renamed command, a corrected path) without retyping the whole note. Can also replace the one-line description.",
    input_schema: {
      type: "object" as const,
      properties: {
        scope: SCOPE_SCHEMA,
        name: { type: "string", description: "The memory's name, as listed." },
        old_text: { type: "string", description: "The exact text to replace, copied from the memory; enough of it to be unique." },
        new_text: { type: "string", description: "What replaces it. Empty removes old_text." },
        description: { type: "string", description: "Optional: a new one-line description." },
      },
      required: ["scope", "name"],
    },
  },
  {
    name: "forget",
    description: "Remove a memory that is wrong or no longer true.",
    input_schema: {
      type: "object" as const,
      properties: {
        scope: SCOPE_SCHEMA,
        name: { type: "string" },
      },
      required: ["scope", "name"],
    },
  },
  {
    name: "recall",
    description: "Read one memory in full: one listed without its content, or another project's (pass `project`).",
    input_schema: {
      type: "object" as const,
      properties: {
        scope: SCOPE_SCHEMA,
        name: { type: "string" },
        project: { type: "string", description: "For another project's memory: the project name shown in brackets in the list." },
      },
      required: ["name"],
    },
  },
];

/** A memory's scope as the model writes it: `global` is stored as `user`, the name it always had. */
function scopeOf(raw: unknown, store: MemoryStore): MemoryScope | null {
  if (raw === "global" || raw === "user") return "user";
  if (raw === "project") return "project";
  if (raw === undefined || raw === null || raw === "") return store.scopes().includes("project") ? "project" : "user";
  return null;
}

/**
 * Whether `next` says nothing that `previous` did not.
 *
 * A memory rewritten under its own name on every turn, each time with the
 * same facts in a new order or one more detail of the day's work, was the
 * "it saves to memory every turn" of 13 Nov 2026. Such a rewrite is not
 * saved: the memory already says it.
 */
// TODO(human): decide when a rewrite of a memory "adds nothing" and is refused. The rule below
// is the shipped default: at most 3 fresh words and at most 8% of the new text's words.
export function addsNothing(previous: string, next: string): boolean {
  // A sentence's full stop is not part of the host or path it ends on.
  const words = (t: string): Set<string> =>
    new Set((t.toLowerCase().match(/[a-z0-9][a-z0-9._/-]{2,}/g) ?? []).map((w) => w.replace(/[._/-]+$/, "")).filter((w) => w.length >= 3));
  const before = words(previous);
  const after = words(next);
  if (after.size === 0) return true;
  let fresh = 0;
  for (const w of after) if (!before.has(w)) fresh++;
  // A handful of new words is rewording; a new host, path or reason is several.
  return fresh <= 3 && fresh / after.size <= 0.08;
}

const SECRET =
  /\b(sk|pk|rk)[-_][A-Za-z0-9_-]{16,}|-----BEGIN [A-Z ]*PRIVATE KEY-----|\bAKIA[0-9A-Z]{16}\b|\bgh[pousr]_[A-Za-z0-9]{30,}|\bxox[abprs]-[A-Za-z0-9-]{10,}|\b(password|passwd|pwd)\s*[:=]\s*(?=\S*[\d!@#$%^&*])[^\s,;]{6,}/i;

/** Run one of the memory tools. */
export function runMemoryTool(
  store: MemoryStore,
  name: string,
  input: Record<string, unknown>,
): { success: boolean; data?: unknown; error?: string } {
  const scope = scopeOf(input["scope"], store);
  if (!scope) return { success: false, error: "scope must be 'global' or 'project'." };
  const key = String(input["name"] ?? "");
  try {
    if (name === "remember") {
      const content = String(input["content"] ?? "").trim();
      const description = String(input["description"] ?? "");
      if (SECRET.test(content)) {
        return {
          success: false,
          error: "That looks like a secret (a password, API key or private key). Secrets are never saved to memory; save where it is kept instead.",
        };
      }
      if (content.length > NOTE_HARD_MAX) {
        const cut = content.length - NOTE_MAX;
        return {
          success: false,
          error:
            `Too long: ${content.length.toLocaleString("en-US")} characters, and a memory is about ${NOTE_MAX.toLocaleString("en-US")}. ` +
            `Cut about ${cut.toLocaleString("en-US")} characters (roughly ${Math.max(1, Math.round(cut / 6))} words) and save it once more. ` +
            "Keep what a future session needs to act: names, paths, hosts, commands, decisions and why. Drop progress, results, " +
            "counts, dates of what was done and history (those belong in your reply and the project's files).",
        };
      }
      if (store.read(scope, key) === null && input["distinct"] !== true) {
        const near = store.sameSubject(scope, key, description, content);
        if (near) {
          return {
            success: false,
            error:
              `A memory on this subject exists already: '${near.name}' (${near.description}). It says:\n"""\n${near.content.slice(0, 2_000)}\n"""\n` +
              `Update that one instead: remember with name '${near.name}' and one note that keeps what is still true in it, ` +
              "adds what you learned, and drops what is no longer true (one memory saying 'it needs X and Y', not one per fact). " +
              "Only if this is genuinely a different subject, save it again with distinct: true.",
          };
        }
      }
      const existing = store.read(scope, key);
      if (existing !== null && addsNothing(existing.content, content)) {
        return {
          success: true,
          data: { saved: memorySlug(key), scope: scope === "user" ? "global" : "project", unchanged: true, note: "Already remembered: nothing new to save." },
        };
      }
      const { entry, replaced } = store.save({
        scope,
        name: key,
        description,
        kind: String(input["kind"] ?? ""),
        content,
      });
      return {
        success: true,
        data: {
          saved: entry.name,
          scope: scope === "user" ? "global" : "project",
          replaced,
          ...(content.length > NOTE_MAX
            ? { note: `Saved, at ${content.length.toLocaleString("en-US")} characters: over the ${NOTE_MAX.toLocaleString("en-US")} a memory should be. Keep the next one shorter.` }
            : {}),
        },
      };
    }
    if (name === "forget") {
      return store.forget(scope, key)
        ? { success: true, data: { forgot: memorySlug(key), scope: scope === "user" ? "global" : "project" } }
        : { success: false, error: `No ${scope === "user" ? "global" : "project"} memory named '${key}'.` };
    }
    if (name === "edit_memory") {
      const existing = store.read(scope, key);
      if (!existing) {
        return { success: false, error: `No ${scope === "user" ? "global" : "project"} memory named '${key}'. Use remember to save a new one.` };
      }
      const oldText = typeof input["old_text"] === "string" ? input["old_text"] : "";
      const newText = typeof input["new_text"] === "string" ? input["new_text"] : "";
      const newDescription = typeof input["description"] === "string" ? input["description"].trim() : "";
      if (!oldText && !newDescription) return { success: false, error: "Give old_text (and new_text) to change the note, or description to change its one line." };
      let content = existing.content;
      if (oldText) {
        const at = content.indexOf(oldText);
        if (at < 0) {
          return { success: false, error: `old_text is not in '${existing.name}'. It says:\n"""\n${content.slice(0, 2_000)}\n"""\nCopy the text to replace exactly.` };
        }
        if (content.indexOf(oldText, at + oldText.length) >= 0) {
          return { success: false, error: "old_text appears more than once in that memory: include more of the surrounding text so it is unique." };
        }
        content = `${content.slice(0, at)}${newText}${content.slice(at + oldText.length)}`.trim();
        if (!content) return { success: false, error: "That would leave the memory empty: forget it instead." };
      }
      if (SECRET.test(content) || SECRET.test(newDescription)) {
        return { success: false, error: "That looks like a secret (a password, API key or private key). Secrets are never saved to memory; save where it is kept instead." };
      }
      if (content.length > NOTE_HARD_MAX) {
        return { success: false, error: `That makes the memory ${content.length.toLocaleString("en-US")} characters, over the ${NOTE_MAX.toLocaleString("en-US")} a memory should be. Shorten it while you edit.` };
      }
      const { entry } = store.save({ scope, name: existing.name, description: newDescription || existing.description, kind: existing.kind, content });
      return { success: true, data: { edited: entry.name, scope: scope === "user" ? "global" : "project" } };
    }
    const project = typeof input["project"] === "string" && input["project"].trim() ? input["project"] : undefined;
    const entry = project
      ? store.read("project", key, project)
      : (store.read(scope, key) ?? store.read(scope === "user" ? "project" : "user", key));
    if (!entry) {
      return { success: false, error: project ? `No memory named '${key}' in project '${project}'.` : `No memory named '${key}'.` };
    }
    // One step along its links, so related memories come with it.
    const links = linksIn(entry.content).map((slug) => {
      const linked = project ? store.read("project", slug, project) : (store.read("user", slug) ?? store.read("project", slug));
      return linked ? { name: linked.name, scope: linked.scope === "user" ? "global" : "project", description: linked.description } : { name: slug, missing: true };
    });
    return { success: true, data: links.length > 0 ? { ...entry, links } : entry };
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : String(err) };
  }
}
