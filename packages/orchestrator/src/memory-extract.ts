/**
 * After a turn: anything worth remembering that the agent did not save?
 *
 * The prompt asks the agent to save what a future session needs at the
 * moment it learns it, and a strong model does. A small one, busy with the
 * task, often does not: it sets up a server, deploys to it, says "done", and
 * the next chat knows nothing about it. This is the safety net. Once a turn
 * that did real work has ended without a `remember`, one short call reads
 * what the turn did (the request, the commands, the files, the reply) next to
 * what is already remembered, and saves at most a few memories, or nothing,
 * which is the usual answer.
 *
 * It runs after the turn, so it never delays the reply, and it cannot touch
 * anything but memory. Everything it saves goes through `runMemoryTool`, so
 * the secret filter applies to it as to the agent.
 */

import { NOTE_MAX, runMemoryTool, type MemoryStore } from "./memory.js";
import type { LLMProvider } from "./types.js";

/** At most this many memories from one turn: a turn that "learned" more is being summarised, not remembered. */
const MAX_PER_TURN = 2;

/**
 * Commands that touch something outside the project: a server, a cloud, a
 * database, a registry. What they set up is what a later session asks about
 * ("connect to that VPS") and cannot find in the files.
 */
const INFRASTRUCTURE =
  /\b(ssh|scp|rsync|sftp|docker|podman|kubectl|helm|terraform|ansible|vercel|netlify|flyctl|wrangler|gcloud|aws|az|doctl|heroku|railway|supabase|firebase|systemctl|pm2|nginx|caddy|certbot|psql|mysql|mongosh|redis-cli|npm publish|pnpm publish|git (push|remote)|gh (repo|release|secret)|nslookup)\b/i;

/** A turn this long did real work: it may have found a cause, learned how something works, or set something up. */
const SUBSTANTIAL_CALLS = 20;

/**
 * After a look that saved something, long turns are not looked at again for
 * this long. A long session's every turn crossed the old bar of 8 calls, and
 * each look found one more detail to fold into a memory — a save on every
 * turn (13 Nov 2026). A preference stated or a server touched is still read
 * at once.
 */
const LONG_TURN_COOLDOWN_MS = 45 * 60_000;
const lastSaved = new Map<string, number>();

/** Note a save from a look, for the cooldown. Keyed by the memory store. */
export function noteExtracted(storeKey: string, at = Date.now()): void {
  lastSaved.set(storeKey, at);
}

/**
 * Whether a turn is worth a look.
 *
 * A request that sounds like a preference or a correction may state one; a
 * turn that worked on a server, a cloud or a database may have set something
 * up; a long turn may have found a root cause or learned how a part works.
 * A short one is none of these. The gate used to be two commands, and every
 * turn was summarised into memory (15 Oct 2026); then it was only preferences
 * and infrastructure, and crucial findings went unsaved (16 Oct 2026). What
 * keeps a look from becoming a summary is the extractor's own bar, the
 * note size limit and the one-memory-per-subject rule, not this gate.
 */
export function worthExtracting(input: {
  request: string;
  toolCalls: number;
  commands: number;
  filesChanged: number;
  /** The commands the turn ran, as written. */
  commandLines?: readonly string[];
  /** Which memory store, for the cooldown after a save. */
  storeKey?: string;
  now?: number;
}): boolean {
  if (/\b(remember|always|never|from now on|don'?t ever|stop doing|i prefer|prefer to|my (server|vps|domain|account|setup))\b/i.test(input.request)) return true;
  // A confirmed approach is feedback as much as a correction is (see the MEMORY prompt).
  if (/\b(exactly (what|how) i (wanted|want|meant)|keep (doing|it) (it )?(like|this|that) ?(way)?|that'?s the (right )?way|do it like this (from now|every|next))\b/i.test(input.request)) return true;
  if ((input.commandLines ?? []).some((c) => INFRASTRUCTURE.test(c))) return true;
  if (input.toolCalls < SUBSTANTIAL_CALLS) return false;
  const saved = input.storeKey ? lastSaved.get(input.storeKey) : undefined;
  return saved === undefined || (input.now ?? Date.now()) - saved >= LONG_TURN_COOLDOWN_MS;
}

const SYSTEM = [
  "You keep the long-term memory of a coding agent. You are shown one finished turn of its work, and what is already remembered.",
  "Decide whether the turn established anything crucial that a FUTURE session (a new chat, possibly in another folder, possibly weeks later) would need and could not get by reading the project's files. What is crucial:",
  "- infrastructure set up or used: a server/VPS (host or IP, SSH user, key file path, what runs there, its paths, how it is deployed and restarted), databases, domains and DNS, cloud accounts, CI;",
  "- how this project is built, run, tested or deployed when that is not obvious from its files, and traps that cost time with their fix;",
  "- a root cause found by real investigation and the conclusion it led to, so a later session does not repeat the hunt;",
  "- how a non-obvious part of the project works, when the turn had to read a lot to learn it;",
  "- the person's preferences, corrections, and approaches they confirmed were right, about how to work, with why;",
  "- decisions made and why; where things live outside the project.",
  "Do NOT save: progress, status, running numbers, or a log of what was built, fixed or tested (they change, and belong in the reply; a conclusion that changes future work is not progress); secrets (passwords, keys, tokens; save where they are kept instead); what the files or git history already say; details only of this task; guesses; anything already in the memory list.",
  "Most turns teach nothing lasting, and the right answer is an empty list. Save only what a future session would get wrong, or spend real time rediscovering, without it. Updating a remembered subject counts only when the turn changed what is true about it — not to restate it or add today's work.",
  "One memory per subject: when the turn adds to a remembered subject, rewrite that memory under its exact name as one note (what is still true, plus the new fact). Never a second memory beside it.",
  "",
  `Answer with JSON only: {"memories": [{"scope": "global" or "project", "name": "kebab-case-name", "description": "one line: when this is relevant", "kind": "user|feedback|project|reference", "content": "a concise note: specific, self-contained, absolute dates, at most ${NOTE_MAX} characters"}]}`,
  `At most ${MAX_PER_TURN}. scope "project" only for facts about the open folder; anything about the person, their machines, servers or accounts is "global". To update an existing memory, reuse its exact name and give the full new content.`,
].join("\n");

export interface ExtractOptions {
  provider: LLMProvider;
  model?: string | undefined;
  store: MemoryStore;
  request: string;
  /** What the turn did: the ledger's record of files, commands and checks. */
  record: string;
  reply: string;
  signal?: AbortSignal;
  /** Today, for converting relative dates. */
  today?: string;
}

/** Pull the first JSON object out of a reply that may have prose or a fence around it. */
function jsonIn(text: string): unknown {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try {
    return JSON.parse(text.slice(start, end + 1));
  } catch {
    return null;
  }
}

/** Run the check and save what it finds. Returns the names saved; never throws. */
export async function extractMemories(options: ExtractOptions): Promise<string[]> {
  const { store } = options;
  const known = store.snapshot(options.request, 6_000) || "(nothing remembered yet)";
  const prompt = [
    `Today is ${options.today ?? new Date().toISOString().slice(0, 10)}.`,
    store.scopes().includes("project") ? "A project folder is open in this session." : "No project folder is open in this session: everything is global.",
    "",
    "<already_remembered>",
    known,
    "</already_remembered>",
    "",
    "<the_person_asked>",
    options.request.slice(0, 4_000),
    "</the_person_asked>",
    "",
    "<what_the_turn_did>",
    options.record.slice(0, 6_000),
    "</what_the_turn_did>",
    "",
    "<the_agent_replied>",
    options.reply.slice(0, 4_000),
    "</the_agent_replied>",
  ].join("\n");

  let text = "";
  try {
    const stream = options.provider.chatStream({
      step: "summary",
      system: SYSTEM,
      messages: [{ role: "user", content: prompt }],
      ...(options.model ? { model: options.model } : {}),
      maxTokens: 4_000,
      temperature: 0,
      reasoning: "low",
      ...(options.signal ? { signal: options.signal } : {}),
    });
    for await (const chunk of stream) if (chunk.type === "token") text += chunk.text;
  } catch {
    return [];
  }

  const parsed = jsonIn(text) as { memories?: unknown } | null;
  const items = Array.isArray(parsed?.memories) ? (parsed!.memories as Array<Record<string, unknown>>) : [];
  const saved: string[] = [];
  for (const item of items.slice(0, MAX_PER_TURN)) {
    if (!item || typeof item !== "object") continue;
    let scope = item["scope"] === "project" ? "project" : "global";
    if (scope === "project" && !store.scopes().includes("project")) scope = "global";
    const result = runMemoryTool(store, "remember", { ...item, scope });
    const data = result.data as { saved?: string; unchanged?: boolean } | undefined;
    // A rewrite that added nothing was not saved, and is not announced as saved.
    if (result.success && !data?.unchanged) saved.push(String(data?.saved ?? item["name"]));
  }
  return saved;
}
