/**
 * Deep research: several rounds, each aimed at what the last one lacked, and
 * a report that cites every claim.
 *
 * One round of `research` (tools/research.ts) searches a handful of ways and
 * reads the best pages. An open question ("which vector database for 50M
 * embeddings on one box", "what changed in React 20's compiler") is not
 * answered by one round: the first pass finds the landscape, and the useful
 * pages are the ones it points to. So, as an analyst works:
 *
 *   1. **Plan.** The question split into the sub-questions an answer must
 *      cover, and searches aimed at each.
 *   2. **Gather** (one round of tools/research.ts).
 *   3. **Find the gaps.** The model reads what was found against the plan and
 *      names what is missing, thin or contradictory, with searches for it.
 *      Pages already read are not read again.
 *   4. Rounds until nothing is missing, at most three.
 *   5. **Report**, from the passages alone, every claim cited [n], with where
 *      the sources disagree and what they leave open.
 *
 * The model is the session's own. Each step that fails falls back to the
 * plain one (no plan: the question's own variants; no report: the evidence),
 * so a model that cannot write JSON still gets an answer.
 */

import { expandQueries, formatEvidence, gatherEvidence, normaliseUrl, type Evidence, type EvidenceSource } from "@sqcode/tools";
import { thinkingBudgetFor, type Effort } from "@sqcode/shared";
import { withIdleTimeout } from "./stream-idle.js";
import type { LLMProvider } from "./types.js";

export interface DeepResearchOptions {
  question: string;
  queries?: string[];
  provider: LLMProvider;
  model?: string;
  signal?: AbortSignal;
  onProgress?: (message: string) => void;
  today?: string;
  /**
   * "max": the engine at full stretch, for a report the person will rely on.
   * More sub-questions, more rounds and sources, a longer report.
   */
  intensity?: "deep" | "max";
  /** For tests: one round of gathering. */
  gather?: typeof gatherEvidence;
  /** For tests: the silence after which a model request counts as stalled. */
  idleMs?: number;
  /** For tests: the time after which no new round starts and the report is written. */
  budgetMs?: number;
}

/** How far each intensity goes: rounds, sources per round, total sources, report length. */
const LIMITS = {
  deep: { rounds: 3, first: 10, followUp: 6, total: 22, subQuestions: 5, queries: 7, gapQueries: 4, evidenceChars: 60_000, reportTokens: 6_000, minutes: 15 },
  max: { rounds: 5, first: 14, followUp: 8, total: 40, subQuestions: 7, queries: 10, gapQueries: 6, evidenceChars: 110_000, reportTokens: 12_000, minutes: 30 },
} as const;

function jsonIn(text: string): Record<string, unknown> | null {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try {
    return JSON.parse(text.slice(start, end + 1)) as Record<string, unknown>;
  } catch {
    return null;
  }
}

const strings = (v: unknown, max: number): string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === "string" && x.trim().length > 0).map((x) => x.trim()).slice(0, max) : [];

/**
 * One step of the engine, with the thinking the step deserves: planning and
 * the report are where reasoning pays (what to look for, what the evidence
 * means), so they think hardest; checking for gaps less. Room for the
 * thinking is added to the answer's, because a reasoning model spends its
 * output allowance on thought first.
 */
async function ask(o: DeepResearchOptions, system: string, prompt: string, maxTokens: number, thinking: Effort = "medium"): Promise<string> {
  /*
   * Its own abort, so a stalled request can be closed without stopping the
   * turn; stopping the turn still closes it. These requests read the stream
   * with no limit at all, and one that went quiet held the research for hours
   * after "13 sources" (reported 29 Oct 2026). Now a silent stream throws, and
   * the step it belongs to is skipped: the plan falls back to the question's
   * own queries, the gap check ends the rounds, the report falls back to the
   * evidence.
   */
  const stop = new AbortController();
  const forward = (): void => stop.abort();
  if (o.signal?.aborted) stop.abort();
  else o.signal?.addEventListener("abort", forward, { once: true });
  try {
    let text = "";
    const stream = o.provider.chatStream({
      step: "subagent",
      system,
      messages: [{ role: "user", content: prompt }],
      ...(o.model ? { model: o.model } : {}),
      maxTokens: maxTokens + thinkingBudgetFor(thinking),
      temperature: 0.2,
      reasoning: thinking,
      signal: stop.signal,
    });
    // The report thinks hardest, so it is given the longest silence before it counts as stalled.
    const idleMs = o.idleMs ?? (thinking === "extra" || thinking === "max" ? REPORT_IDLE_MS : STEP_IDLE_MS);
    for await (const chunk of withIdleTimeout(stream, idleMs, () => stop.abort())) if (chunk.type === "token") text += chunk.text;
    return text;
  } finally {
    o.signal?.removeEventListener("abort", forward);
  }
}

/** Silence after which a planning or gap-checking request has stalled. */
const STEP_IDLE_MS = 4 * 60_000;
/** The same for the report, which may think for minutes before its first word. */
const REPORT_IDLE_MS = 10 * 60_000;

const PLAN = [
  "You plan web research for a question. Split it into the 2-7 sub-questions a complete, expert answer must cover, then write search queries that would find authoritative sources for each:",
  "official documentation, papers, standards, changelogs and release notes, benchmarks, and first-hand reports, over listicles.",
  "Vary the angle: the official names, the exact error text, 'X vs Y', the year when recency matters. 4-10 queries, each under 12 words.",
  'Answer with JSON only: {"sub_questions": ["..."], "queries": ["..."]}',
].join(" ");

const GAPS = [
  "You review research in progress. Given the question, the sub-questions it must answer, and the sources found so far (numbered, with excerpts),",
  "decide what is still missing, thin (one weak source), out of date, or contradicted between sources. For each gap write a targeted search query.",
  "If the sources already answer every sub-question well, say so.",
  'Answer with JSON only: {"covered": true|false, "gaps": ["..."], "queries": ["..."]} with at most 6 queries.',
].join(" ");

const REPORT = [
  "You are a senior research analyst writing a report from numbered sources. Use only what the sources say; cite every factual claim inline as [n] (several as [2][5]), placed right after the claim it supports.",
  "Reason before you write: what the evidence establishes, where independent sources agree, where they conflict and which to trust (primary over secondary, recent over dated, measured over claimed), and what follows from it.",
  "Structure, in Markdown: '## Answer' with the bottom line in 2-5 sentences; '## Key findings' under short ### headings, each specific (versions, numbers with units, dates, names);",
  "a comparison table when options or numbers are being compared; '## Analysis' with implications, trade-offs and, when there is a decision, a recommendation and why (label your own reasoning as analysis, not as a sourced fact);",
  "'## Disagreements and gaps' for conflicts, single-source or dated claims, and what the sources do not cover; '## Sources' as [n] Title (site, date): URL for each source you cited.",
  "Be complete but dense: no filler, no restating the question, no generic advice the sources do not support, no em dashes. Never invent a number, quote, source or URL.",
].join(" ");

const VERIFY = [
  "You check a research report against its numbered sources, claim by claim, like a fact-checker.",
  "Find every sentence whose citation does not support it (wrong [n], a number or date that differs from the source, a claim the source does not make, a claim with no citation that needs one).",
  "If there are none, answer exactly OK. Otherwise return the whole report, corrected: fix the citation or the claim to match the sources, or remove the claim; change nothing else.",
].join(" ");

function brief(sources: EvidenceSource[]): string {
  return sources
    .map((s) => `[${s.n}] ${s.title} (${s.site}${s.published ? `, ${s.published}` : ""})\n${s.passages.join(" ").slice(0, 500)}`)
    .join("\n\n");
}

/** Evidence for the report, cut to a budget by dropping the lowest-ranked passages first. */
function evidenceText(question: string, sources: EvidenceSource[], budget: number): string {
  let shown = sources.map((s) => ({ ...s, passages: [...s.passages] }));
  const size = (): number => shown.reduce((n, s) => n + s.passages.join("").length + s.title.length + s.url.length + 40, 0);
  while (size() > budget && shown.some((s) => s.passages.length > 1)) {
    const longest = shown.reduce((a, b) => (b.passages.length > a.passages.length ? b : a));
    longest.passages.pop();
  }
  shown = shown.filter((s) => s.passages.length > 0);
  const e: Evidence = { question, queries: [], providers: [], sources: shown, unread: [], failedQueries: [] };
  return formatEvidence(e, { instructions: false }).split("\n").slice(3).join("\n");
}

export async function deepResearch(o: DeepResearchOptions): Promise<{ success: boolean; data?: unknown; error?: string }> {
  const gather = o.gather ?? gatherEvidence;
  const today = o.today ?? new Date().toISOString().slice(0, 10);
  const limit = LIMITS[o.intensity ?? "deep"];
  const question = o.question.trim();
  if (question.length < 3) return { success: false, error: "research needs a 'question'." };

  // 1. Plan.
  o.onProgress?.("Planning the research");
  let subQuestions: string[] = [];
  let queries = expandQueries(question, o.queries);
  try {
    const plan = jsonIn(await ask(o, PLAN, `Today is ${today}.\nQuestion: ${question}${o.queries?.length ? `\nQueries already suggested: ${o.queries.join(" | ")}` : ""}`, 1_500, "high"));
    subQuestions = strings(plan?.["sub_questions"], limit.subQuestions);
    const planned = strings(plan?.["queries"], limit.queries);
    if (planned.length > 0) queries = expandQueries(question, [...(o.queries ?? []), ...planned]).slice(0, limit.queries);
  } catch (err) {
    if (o.signal?.aborted) throw err;
  }

  // 2-4. Rounds.
  const sources: EvidenceSource[] = [];
  const seen = new Set<string>();
  const allQueries: string[] = [];
  let unread = 0;
  let round = 0;
  let nextQueries = queries;
  /*
   * Rounds stop at a time budget as well as a count: what has been read by
   * then goes into the report. Each step is bounded on its own (a stalled
   * request, a page that will not load), and this bounds the sum of them.
   */
  const budgetMs = o.budgetMs ?? limit.minutes * 60_000;
  const started = Date.now();
  while (round < limit.rounds && nextQueries.length > 0) {
    if (round > 0 && Date.now() - started > budgetMs) {
      o.onProgress?.(`Out of time for another round: writing the report from ${sources.length} sources`);
      break;
    }
    round++;
    o.onProgress?.(round === 1 ? `Round 1: ${nextQueries.length} searches` : `Round ${round}: following up on ${nextQueries.length} gaps`);
    const evidence = await gather({
      question,
      queries: nextQueries,
      maxSources: round === 1 ? limit.first : limit.followUp,
      passagesPerSource: 3,
      exclude: seen,
      firstNumber: sources.length + 1,
      ...(o.signal ? { signal: o.signal } : {}),
      ...(o.onProgress ? { onProgress: o.onProgress } : {}),
    });
    allQueries.push(...evidence.queries);
    unread += evidence.unread.length;
    for (const s of evidence.sources) {
      seen.add(normaliseUrl(s.url));
      sources.push(s);
    }
    for (const u of evidence.unread) seen.add(normaliseUrl(u.url));
    if (round >= limit.rounds || sources.length >= limit.total) break;

    o.onProgress?.(`Checking ${sources.length} sources for gaps`);
    let review: Record<string, unknown> | null = null;
    try {
      review = jsonIn(
        await ask(
          o,
          GAPS,
          `Today is ${today}.\nQuestion: ${question}\nSub-questions:\n${subQuestions.map((q) => `- ${q}`).join("\n") || "- (answer the question fully)"}\nSearched so far: ${allQueries.join(" | ")}\n\nSources:\n${brief(sources)}`,
          1_200,
          "medium",
        ),
      );
    } catch (err) {
      if (o.signal?.aborted) throw err;
    }
    if (!review || review["covered"] === true) break;
    nextQueries = strings(review["queries"], limit.gapQueries).filter((q) => !allQueries.some((a) => a.toLowerCase() === q.toLowerCase()));
  }

  if (sources.length === 0) {
    return { success: false, error: `Nothing could be read for "${question}" (searched: ${allQueries.join(" | ")}). Try narrower queries, or fetch_url_content on a page you know.` };
  }

  // 5. Report.
  o.onProgress?.(`Writing the report from ${sources.length} sources`);
  try {
    const report = await ask(
      o,
      REPORT,
      `Today is ${today}.\nQuestion: ${question}\n${subQuestions.length ? `It must cover:\n${subQuestions.map((q) => `- ${q}`).join("\n")}\n` : ""}\nSources:\n${evidenceText(question, sources, limit.evidenceChars)}`,
      limit.reportTokens,
      o.intensity === "max" ? "max" : "extra",
    );
    let final = report.trim();
    // Max: every claim checked against its source before the report is handed over.
    if (final.length > 200 && o.intensity === "max") {
      o.onProgress?.("Checking every claim against its source");
      try {
        const checked = (
          await ask(o, VERIFY, `Sources:\n${evidenceText(question, sources, limit.evidenceChars)}\n\nReport:\n${final}`, limit.reportTokens, "high")
        ).trim();
        if (checked.length > final.length * 0.6 && !/^OK\.?$/i.test(checked)) final = checked;
      } catch (err) {
        if (o.signal?.aborted) throw err;
      }
    }
    if (final.length > 200) {
      const note =
        `${o.intensity === "max" ? "Maximum-depth" : "Deep"} research: ${round} round${round === 1 ? "" : "s"}, ${allQueries.length} searches, ` +
        `${sources.length} sources read${unread ? `, ${unread} unreadable` : ""}${o.intensity === "max" ? ", every claim checked against its source" : ""}. ` +
        "The report below cites them as [n]; keep those citations (and the Sources list) when you answer from it.";
      return { success: true, data: `${note}\n\n${final}` };
    }
  } catch (err) {
    if (o.signal?.aborted) throw err;
  }
  // No report: the evidence itself, as a standard round gives it.
  const e: Evidence = { question, queries: allQueries, providers: [], sources, unread: [], failedQueries: [] };
  return { success: true, data: formatEvidence(e) };
}
