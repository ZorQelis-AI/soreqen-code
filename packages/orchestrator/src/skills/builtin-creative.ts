/**
 * Conditional skills for work beyond code: research reports, motion graphics
 * videos, writing and plans, office documents, and skills themselves.
 *
 * Each loads by task, the way frontend-design does for a website: "research
 * X and write me a report", "make a 30 second promo video", "draft an email
 * to…", "turn this into a PDF". The body is the method; the long technical
 * detail lives in reference files the agent opens with use_skill only when
 * it reaches that part of the work, so a skill costs a page, not a manual.
 */

import type { SkillDefinition, SkillTrigger } from "./builtin.js";
import { MOTION_BODY, MOTION_FILES } from "./motion-files.generated.js";

const skill = (
  name: string,
  title: string,
  description: string,
  trigger: SkillTrigger,
  body: string,
  refs?: Record<string, string>,
): SkillDefinition => {
  const trimmed = refs ? Object.fromEntries(Object.entries(refs).map(([k, v]) => [k, v.trim()])) : undefined;
  return {
    name,
    title,
    kind: "conditional",
    description,
    trigger,
    body: body.trim(),
    source: "soreqen",
    ...(trimmed ? { refs: trimmed, files: Object.keys(trimmed) } : {}),
  };
};

// ---------------------------------------------------------------------------
// Research
// ---------------------------------------------------------------------------

const RESEARCH = skill(
  "deep-research",
  "Deep research and reports",
  "Research a question thoroughly on the web and deliver a report: market or competitor analysis, technology comparisons, state of the art, due diligence, any question that needs many sources and real reasoning.",
  {
    words:
      /\b((deep(ly)?|thorough(ly)?|in-depth|proper(ly)?|detailed) research|research (deeply|thoroughly|properly|on|about|into|the|this|these|what|how|which|whether)|do (some |a |the )?research|research|investigate|deep ?dive|look into|find out (about|everything)|literature review|state of the art|market (research|analysis|size|landscape)|competitor (research|analysis)|competitive (analysis|landscape)|due diligence|feasibility (study|analysis)|white ?paper|analy[sz]e (the )?(market|industry|landscape|trends?)|(write|create|prepare|give me) (a |an )?(detailed |full |in-depth )?(report|analysis|brief(ing)?)|pros and cons|which is (the )?best|best (tools?|options?|frameworks?|libraries|services|providers|models?) for|latest (news|developments|research|releases)|what('s| is) new in)\b/i,
    // Bare "research" is often a company's line of work ("an AI research company"); "research this" is a task.
    strong: /\s/,
  },
  `
You are working as a senior research analyst. The deliverable is an answer the person can rely on and act on, with every claim traceable to a source.

## 1. Frame the question (no tools yet)
Write down, in update_task_state: the exact question; who the report is for and what decision it serves; the 3 to 7 sub-questions a complete answer must cover; what "done" looks like (a recommendation, a ranked list, a number, a comparison table). Infer the format the person wants from how they asked:
- "detailed", "in-depth", "full report": a long structured report saved to a file.
- "concise", "quick", "summary", "brief": a tight one-page answer in chat.
- "informative", "explain": a teaching report that builds understanding.
- No signal: a structured report of moderate length, saved to a file, with the answer in chat.
Ask (ask_user) only if the scope is genuinely ambiguous in a way that changes the work (two very different markets, two very different time frames).

## 2. Run the research engine at full power
- The main question: research with depth "max" and 4 to 6 queries from different angles (official names, synonyms, "X vs Y", the current year when recency matters, the numbers you need). Max plans sub-questions, runs up to five rounds that chase what earlier rounds missed, reads up to 40 sources, writes a cited report and checks every claim against its source before you get it. The report comes back whole: read all of it.
- Each sub-question the first pass left thin: research with depth "deep" or "standard" and targeted queries.
- Primary sources by name: fetch_url_content on the official docs, filings, papers, pricing pages, changelogs and datasets the research pointed to. A claim that matters gets its primary source read, not a blog's paraphrase of it.
- Run independent research calls together in one step.

## 3. Think before writing
- Triangulate: every key fact (a number, a date, a ranking) needs two independent sources, or is marked as resting on one.
- Check recency: note the date of each important source; prefer the newest authoritative one; flag anything older than the topic's half-life.
- Reconcile disagreements: when sources conflict, say which you trust and why (method, recency, independence).
- Reason past the sources: what the facts imply, the trade-offs, second-order effects, what would change the conclusion. Label analysis as analysis.
- Separate three things clearly: what sources say (cited), what you conclude (reasoned), and what nobody knows (open questions).

## 4. Write the report
Structure (scale it to the format chosen in step 1):
1. The answer: 2 to 5 sentences that directly answer the question, with the bottom line first.
2. Key findings: short headed sections, specific (numbers with units and dates, names, versions), each claim cited inline as [n].
3. Comparison table when options are being compared (criteria as rows or columns, consistent units).
4. Analysis: implications, trade-offs, risks, and a recommendation when the person has a decision to make, with the reasoning that leads to it.
5. Confidence and gaps: what is well established, what is uncertain, what the sources do not cover.
6. Sources: [n] Title, publisher, date, URL, only sources actually cited.
7. Where it helps the person go further: two or three follow-up questions worth researching next.

Rules: never invent a source, a quote, a number or a URL; if research did not find it, say so. Plain, precise language. Short paragraphs. No filler, no restating the question, no em dashes.

## 5. Deliver
- Long reports: write the report to a Markdown file (for example reports/<topic>.md in the workspace, or the location the person named) and give the answer and the 3 to 5 most important findings in chat with the file path.
- If the person asked for a PDF or Word file, also load the documents skill and produce it from the Markdown.
- Before finishing, reread the report once as the reader: does the first paragraph answer the question; is every number cited; is anything claimed that no source supports?`,
);

// ---------------------------------------------------------------------------
// Motion graphics
// ---------------------------------------------------------------------------

/*
 * Its files (the method, the Motion Kit engine and its reference, the
 * concept, technique and style references, the QA and export scripts) are
 * real files in motion-graphics-videos/, embedded by
 * scripts/gen-motion-skill.mjs; see that folder to change any of them.
 * Rebuilt 13 Nov 2026: films are written as data for a tested engine,
 * instead of hand-written animation code that broke.
 */
const MOTION = skill(
  "motion-graphics-videos",
  "Motion Graphics Videos",
  "Create motion graphics videos that move like film, not slides: product promos, launch videos, explainers, animated intros and logo stings, kinetic typography, social clips, with voiceover and music. One deterministic timeline, checked frame by frame, exported to MP4.",
  {
    words:
      /\b(motion ?graphics?|motion design|explainer|promo(tional)? (video|clip)|launch video|product video|demo video|(make|create|build|generate|produce|render|edit|animate)\b[^.\n]{0,30}\b(videos?|reels?|shorts)|remotion|hyper ?frames|voice ?-?over|narrat(ion|ed|or)|kinetic typography|lower thirds?|title (sequence|card)|animated (video|intro|logo|text|explainer)|logo (reveal|animation)|intro video|outro|trailer|youtube (video|intro)|tiktok|instagram reels?)\b/i,
    strong: /\s|remotion|hyper ?frames|voice ?-?over/i,
    // Not audio or video files: a speech model writes .wav samples, and that is no video.
    paths: /(^|\/)remotion\.config\.[jt]s$/i,
  },
  MOTION_BODY,
  MOTION_FILES,
);

// ---------------------------------------------------------------------------
// Writing and planning
// ---------------------------------------------------------------------------

const WRITING = skill(
  "writing-and-planning",
  "Writing and planning",
  "Write anything people will read (emails, messages, blog posts, articles, announcements, proposals, docs prose) or create a plan (the person's plan, a project plan, a roadmap, or your own plan for a task).",
  {
    words:
      /\b((write|draft|compose|rewrite|polish|improve|edit|proofread)\b[^.\n]{0,40}\b(emails?|mails?|messages?|dms?|replies|reply|blog( posts?)?|posts?|articles?|letters?|newsletters?|announcements?|essays?|cover letters?|proposals?|copy|captions?|tweets?|threads?|bios?|press releases?|speech(es)?|scripts?|summar(y|ies)|statements?|pitch(es)?|descriptions?)|(make|create|write|draft|build|prepare|give me)\b[^.\n]{0,30}\b(plans?|roadmaps?|strateg(y|ies)|outlines?|itinerar(y|ies)|schedules?|timelines?|okrs?|go-to-market|launch plans?|business plans?|study plans?|content calendars?)|cold emails?|linkedin posts?|tone of voice)\b/i,
    strong: /./,
  },
  `
You write like the best human writers and editors: clear, specific, warm when it should be, and always in service of the reader. Plans you write are decisions someone can act on today. Good writing and good plans come from the same discipline: know who it is for, decide what it must achieve, and remove everything that does not serve that.

## 1. Understand before drafting
Answer in a line each: who reads it, and what they already know and care about; what they should know, feel or do afterwards (the one outcome); the channel and how it is read (an email on a phone between meetings, a post skimmed in a feed, a proposal studied at a desk); the constraints (length, deadline, tone, what must or must not be said). Gather the facts first: read the thread being replied to, the doc being summarised, the person's earlier messages for their voice. If the one outcome is unclear and the guess would change the piece, ask one short question; otherwise decide and say what you assumed.

## 2. Find the shape
Write the core message in one sentence before anything else. Then choose a structure that fits the purpose: answer first (most business writing), problem, solution, proof, ask (persuasion), story arc (posts, talks), steps (instructions), comparison (decisions). Outline in a few lines for anything longer than a short message.

## 3. Draft for the reader
- Lead with the point: the first sentence carries the news, the answer or the ask; context follows.
- Specific beats general: numbers, names, dates, examples, a concrete before and after. "Cut build time from 9 to 3 minutes" beats "significantly improved performance".
- One idea per paragraph, its first sentence saying what the paragraph is for. Transitions that carry logic (because, so, but, which means), not filler.
- Plain words, strong verbs, active voice. Vary sentence length for rhythm: short sentences land points, longer ones carry reasoning.
- Show, then tell: an example or a moment before the general claim.
- Respect the reader's time and intelligence: no throat clearing, no stacked hedges, no explaining what they already know.

## 4. Sound human
Avoid the tells of generated text: "delve", "tapestry", "elevate", "unlock", "seamless", "robust", "game-changer", "in today's fast-paced world", "it's not just X, it's Y", "let's dive in", reflexive lists of three, every paragraph the same length, a summary that repeats the body, em dashes as all-purpose punctuation, exclamation marks standing in for enthusiasm, emojis unless the person uses them. Match the voice: the person's own style when you have samples (sentence length, formality, sign-offs, the words they use), the brand's tone for company writing, the reader's register. Write the way the sender would actually talk to this reader.

## 5. Edit in passes (this is where good becomes excellent)
1. Purpose: does it achieve the one outcome? Is the ask or the answer unmissable?
2. Structure: right order, nothing missing, nothing that belongs elsewhere. Could a reader who reads only the first lines act on it?
3. Paragraphs: each earns its place; cut the ones that restate.
4. Sentences: cut 20 percent of the words; replace vague words with exact ones; turn passive into active where the actor matters.
5. Facts: every name, number, date, link and claim checked against its source. Unknowns become visible placeholders like [Name] or [date], listed in your reply, never invented.
6. Read it aloud in your head as the recipient. Fix anything that sounds stiff, salesy or robotic. Then stop polishing.

## 6. Deliver
Give the finished piece ready to paste (a subject line with emails), not a template. Offer two or three options only where the choice is genuinely the person's (subject lines, headlines, an opening). One line on any assumption you made. Long pieces go in a file (Markdown, or a document via the documents skill when asked), with the opening and the key points in chat. Never send anything on the person's behalf unless they asked and the tool for it exists.

For the playbook of each form (email types, LinkedIn and X posts, newsletters, blog and technical posts, docs and READMEs, proposals and PRDs, release notes, cover letters, speeches, difficult messages), read references/forms.md.

## Plans that work
A plan is a set of decisions, not a list of activities.
1. Goal: one sentence, with how success is measured and by when.
2. Starting point and constraints: what exists now, budget, time, people, non-negotiables, dependencies on others.
3. Approach: the strategy in a short paragraph, the main alternative you rejected and why.
4. Steps: each concrete, owned and checkable (it ends in an observable result, never "work on X"); sequenced by dependency; sized (hours or days); the first step doable today.
5. Milestones and dates, with the critical path visible and buffer where the risk is.
6. Risks: the 3 to 5 that matter (run a quick pre-mortem: "it is three months later and this failed; why?"), each with an early sign and a response.
7. Decisions still open, who makes them, and by when.
8. How progress is reviewed: a weekly check, the metric, the point at which to change course.
Right-size it: a weekend project needs a dozen lines, a launch needs phases and owners. Present it as a numbered list or table the person can act from, plus a short "this week" list. For specific kinds of plan (project, launch and go-to-market, roadmap, sprint, study, business, content calendar, travel itinerary), read references/plans.md.

## Your own working plans
When planning your own work (update_todo_list): 3 to 8 items; each names a deliverable and how it will be verified ("Login form submits and shows errors: checked in the browser at 390px"); order by dependency; front-load the riskiest unknown; mark items done only when their check has passed; revise the plan the moment reality disagrees with it, and say so.`,
  {
    "references/forms.md": `
# Forms

## Email
- Subject: what it is about and what is needed ("Approve Q4 budget by Fri", "Notes from Tuesday + 2 decisions needed").
- First two lines: the ask or the news. Then the context in short paragraphs. Then a clear next step with a date. Then a short sign-off.
- Reply: answer their question first, in their order; quote only what you respond to.
- Follow-up: one line of context, the ask again, an easy out ("If it is not a priority now, just say so").
- Cold outreach: 50 to 120 words, about them not you, one specific reason for writing now, one small ask (a reply, not a meeting).
- Bad news or apology: say it plainly in the first line, own it without excuses, what you are doing about it, what they can expect. No "unfortunately" stacking.
- Asking a favour: the ask, why them, what it costs them (time), make it easy to say yes or no.
- Negotiation: anchor with reasons, one clear proposal, what you can be flexible on, a deadline if real.
- Declining: thanks, a clear no, a short reason if useful, an alternative if there is one.

## Messages (Slack, WhatsApp, Teams)
One message per thing, the point in the first line, no "Hi, quick question?" without the question. Threads for detail. Bullets for options.

## LinkedIn post
A first line that earns the "see more" (a specific claim, a number, a short story opening; not a question bait). Short paragraphs of one or two lines. One idea, told through something that happened, with the lesson made specific. End with a thought or a genuine question, not "Agree?". 120 to 250 words. Hashtags: 0 to 3, at the end.

## X (Twitter) post or thread
Single post: one sharp idea under 280 characters, concrete, no filler words. Thread: the first post states the payoff ("How we cut our cloud bill 60%: 7 changes"), each following post one self-contained point with a detail, the last one a summary or a link. Number them only if the order matters.

## Newsletter
A subject line that names the value; an opening that says why this issue matters now; sections with clear headings; one main story, a few short items; a personal sign-off. Scannable in 2 minutes, worth reading in 6.

## Blog post or article
A title that promises something specific; an opening paragraph that states the problem and what the reader gets; headings that tell the story on their own; examples, data, screenshots or code where relevant; a conclusion that gives the reader something to do. Technical posts: show the working code, the output, the gotchas; versions and dates.

## Docs and README
README: what it is in one sentence, why it exists, a quick start that works when copied (install, run, first result), then configuration, then deeper docs and contributing. Docs: task-based headings ("Deploy to Vercel"), steps numbered, one action per step, expected results shown, prerequisites first.

## Proposal, pitch or PRD
Proposal and pitch: the problem in the reader's terms, the outcome, the approach, why you, cost and timeline, risks, the decision asked for. PRD: problem and evidence, users and jobs to be done, goals and non-goals, requirements as user stories with acceptance criteria, metrics, open questions, rollout.

## Release notes and announcements
What changed, who it affects, what they need to do, where to learn more. Lead with the user benefit, not the implementation. Group by New, Improved, Fixed.

## Executive summary
The conclusion, the recommendation and the decision needed, in the first paragraph; three to five supporting points with numbers; risks and the cost of not acting.

## Cover letter
For this role and company specifically: why them (something real you know about them), two or three achievements that match what they need, with numbers, one line of personality, a confident close. Under 300 words.

## Speech or talk
Written for the ear: short sentences, repetition of the key line, signposts ("Three things."), one story that carries the message, a strong last line. About 130 words per minute.

## Marketing copy and landing pages
Headline: the outcome for the reader. Subhead: how. Benefits before features, proof (numbers, logos, quotes), objections answered, one call to action repeated. Specific beats clever.`,
    "references/plans.md": `
# Kinds of plan

## Project plan
Goal and success metric; scope (in and out); work breakdown into deliverables, then tasks of half a day to three days; owners (RACI where several people: responsible, accountable, consulted, informed); dependencies and the critical path; milestones with dates; risks with mitigations; a weekly review rhythm.

## Launch and go-to-market
Audience and positioning (for whom, the problem, why us, the one line); channels ranked by expected reach and cost; launch timeline (minus 4 weeks prep, minus 1 week assets, launch day hour by hour, plus 2 weeks follow-through); assets checklist (landing page, demo video, posts, emails, press, docs); success metrics (signups, activation, revenue) with targets; owners.

## Product roadmap
Themes tied to outcomes, not a feature list; Now, Next, Later columns with confidence falling to the right; prioritise with RICE (reach, impact, confidence, effort) or value versus effort; what is deliberately not on it; when it is reviewed.

## Sprint plan (one to two weeks)
The sprint goal in one sentence; committed items sized to capacity with 20 percent slack; each with acceptance criteria; risks and blockers; the demo at the end.

## Study plan
Target (exam, skill, date); a diagnostic of where they are; topics ordered by dependency and weight; weekly blocks with spaced repetition and practice tests; active recall over rereading; buffer weeks before the deadline; how progress is measured.

## Business plan (lean)
Problem, customer segment, unique value proposition, solution, channels, revenue streams, cost structure, key metrics, unfair advantage; then the 90-day milestones and the experiments that test the riskiest assumption first.

## Content calendar
Pillars (3 to 5 themes), formats per channel, cadence the person can sustain, a 4 to 8 week grid with title, format, channel, date and status, and a repurposing plan (one long piece into several short ones).

## Travel itinerary
Day by day with times, travel between places (mode and duration), bookings and their confirmation status, a realistic pace (one main thing per half day), alternatives for bad weather, costs, and practical notes (visas, money, transport passes).

## OKRs
One objective (qualitative, inspiring), three to four key results (measurable, with a baseline and a target), initiatives that drive them, owners, a mid-point check.`,
  },
);

// ---------------------------------------------------------------------------
// Documents
// ---------------------------------------------------------------------------

const DOCUMENTS = skill(
  "documents",
  "Documents: PDF, Word, PowerPoint, Excel",
  "Create or edit office documents and exports: PDF reports, Word (.docx) files, PowerPoint (.pptx) decks, Excel (.xlsx) sheets, proposals, invoices, resumes, certificates. Researched, well written, designed, with charts and diagrams where they help, in files that open cleanly.",
  {
    words:
      /\b((make|create|export|generate|convert|turn|save|build|design|write)\b[^.\n]{0,30}\b(pdfs?|presentations?|slides|decks?|reports? as (a )?pdf)|pdfs?|docx|word (doc|document|file)s?|ms word|pptx|power ?points?|slide ?decks?|slides|presentations?|keynote|xlsx|excel|spreadsheets?|workbooks?|google (docs|sheets|slides)|invoices?|resumes?|cvs?|certificates?|brochures?|one-?pagers?|letterheads?|printable|print-ready)\b/i,
    // "Resumes" is also what training does from a checkpoint; "the PDF" is often only asked where it is.
    strong:
      /^((make|create|export|generate|convert|turn|save|build|design|write)\b.*|docx|pptx|xlsx|word \w+|ms word|power ?points?|slide ?decks?|spreadsheets?|excel|google \w+|invoices?|brochures?|one-?pagers?|letterheads?|print-ready)$/i,
    paths: /\.(pdf|docx?|pptx?|xlsx?|odt|ods|odp)$/i,
  },
  `
You produce documents a demanding professional would be proud to send: well researched, clearly reasoned, well written, and designed so the reader finds what matters at a glance. The file opens without errors or repair prompts in the apps people use (Word, PowerPoint, Excel, Acrobat, Google Docs, LibreOffice) and looks deliberate on every page.

## 1. Understand the document's job
Who reads it, what decision or action it serves, and how it is read (printed and studied, skimmed on a screen, presented to a room, sent as an attachment). The type sets the shape: a report argues and informs, a proposal persuades, a deck is spoken over, a one-pager is scanned in a minute, a spreadsheet is worked in, an invoice or certificate must be exact. Note what you were given (data, notes, an earlier version, a template, brand guidelines) and what is missing.

## 2. Content first: research and reason
- Facts the document states must be true and current. When it needs knowledge you do not have from the person or the project (market numbers, standards, prices, recent events), research it: load the deep-research skill or run research, and cite sources in the document (footnotes, a sources section, or source lines under charts) where the reader would expect them.
- Think before writing: the main message in one sentence, the 3 to 6 points that support it, the evidence for each, the objections a sharp reader would raise and your answer to them. A document is an argument even when it is a report.
- Write it with the writing-and-planning discipline: answer or recommendation first (an executive summary for anything over three pages), one idea per section, headings that say something ("Costs fall 30% after month three", not "Costs"), specific numbers with units and dates, plain words, no filler and no em dashes. Never invent data, quotes or names; unknowns become visible placeholders like [Company address], listed in your summary.
- Save the content as Markdown or a structured data file before building the file, so the words can be reviewed and reused.

## 3. Visuals where they earn their place
Use a visual when it shows something faster than words: a trend (line chart), a comparison (bar chart, a table with consistent units), a share (stacked bar; pie only for 2 to 4 parts), a process or architecture (a diagram), a timeline, a before and after, the product itself (a screenshot). Rules: one message per visual, written as its title; label axes and units; highlight the one series that matters in the accent color and grey the rest; cite the data source under it; generate charts from the data in code (matplotlib, Plotly or Vega-Lite exported to SVG or PNG at 2x, or native Office charts) so they stay exact. Diagrams: Mermaid or Graphviz rendered to SVG, or drawn in SVG. Icons from an open set (Lucide, Tabler), photos only when licensed. No decoration for its own sake: no clip art, no stock photos that say nothing, no 3D charts.

## 4. Design system
Page size (A4 for India and Europe, US Letter for the US) or slide size (16:9); margins and a grid; two fonts at most with a type scale (for example 10.5 to 11 pt body, 14, 18 and 24 pt headings for documents; 24 pt minimum body, 36 pt or more titles for slides); a palette of 3 to 5 colors with roles (text, background, accent, support, muted); styles for headings, tables (header row, zebra or rules, right-aligned numbers), callouts and captions; a cover or title slide; headers and footers with page numbers. Use the person's brand (logo, colors, fonts, an existing template) when there is one. Read references/design.md for layouts by document type.

## 5. Check the toolchain (one step)
Probe what exists: python --version; python -c "import docx, pptx, openpyxl, reportlab, fitz, matplotlib" (each separately if one fails); node --version; soffice --version (LibreOffice, used to convert and to check); pdftoppm -v (Poppler, for page images). Install only what is missing, inside the project (a .venv for Python, local node_modules for Node), never globally. Read references/toolkit.md for the library per format.

## 6. Generate from a script, not by hand
Write a generator script (for example scripts/make_report.py) that builds the file from the content and data files, so a change is an edit and a rerun. Use the format's real structures: Word heading styles (so navigation and a table of contents work), real tables, real lists, slide layouts with placeholders, Excel formulas instead of pasted values, alt text on images, document properties (title, author).

## 7. Review like an editor and a designer
Every document is opened and looked at before it is delivered:
- Render pages to images: for PDF, pdftoppm -png -r 80 file.pdf out/page (or PyMuPDF); for DOCX, PPTX and XLSX, convert first: soffice --headless --convert-to pdf --outdir out file.docx. Then view_image the pages (all of them for short documents; the first, the last and the densest for long ones).
- Look for: text overflowing or cut at edges, overlapping elements, orphaned headings, tables split badly, font substitution, empty pages, low contrast, stretched or blurry images, inconsistent spacing, a chart whose message is not obvious.
- Read it as the intended reader: does the first page say what matters; is every number sourced or derived; is anything vague, repeated or unsupported; are names, dates and figures consistent everywhere?
- Structural checks: page or slide count as expected; pdffonts shows fonts embedded; text extracts in reading order (pdftotext); Excel has no #REF!, #NAME? or #DIV/0! after a LibreOffice recalculation; links work.
- Fix and regenerate until clean.

## 8. Deliver
The file path, its page or slide count, a two to four line summary of what it says, any placeholders still to fill, sources used, and how to regenerate it (the script and command). For edits to an existing document: work on a copy, preserve its styles, and say what changed.`,
  {
    "references/design.md": `
# Layouts by document type

## Report or white paper
Cover (title that states the finding, subtitle, date, author or company, logo); executive summary on page 2 (the answer, 3 to 5 key findings with numbers, the recommendation); contents for over 8 pages; sections with numbered headings; a key-figure callout or chart every one to two pages; conclusion and next steps; sources and an appendix for detail. Running header with the short title, footer with page numbers.

## Proposal
Cover; the client's problem in their words; the proposed outcome; approach and scope (with what is out of scope); timeline as a table or Gantt-style bar chart; team and credentials; pricing table with totals and terms; why us; next step and signature block.

## Slide deck
Title slide; agenda only for long decks; one message per slide written as the title sentence; a visual on most slides (chart, diagram, screenshot, big number); 3 to 5 short bullets at most; section divider slides; a summary and a clear ask at the end; speaker notes with what is said. Consistent title position, margins and colors on every slide.

## One-pager and brochure
A headline that states the value, three benefit blocks with icons, one proof element (a number, a logo row or a quote), a clear call to action with contact details. Generous white space; nothing smaller than 9 pt.

## Resume or CV
One page for under ten years of experience, two at most. Name and contact line; a two-line profile; experience with achievements as results with numbers (verb, what, result); skills grouped; education. One font, clear hierarchy, ATS-friendly (real text, no tables for layout in DOCX, no text in images).

## Invoice
Seller and buyer blocks, invoice number and dates, line items table (description, quantity, rate, amount), subtotal, taxes by type and rate (GST: CGST and SGST or IGST with GSTIN where it applies), total in figures and words, payment details and terms. Numbers right-aligned with consistent decimals.

## Spreadsheet model
An inputs sheet (assumptions, colored), calculation sheets, an outputs or dashboard sheet with charts; one table per sheet, frozen header rows, named ranges for key inputs, notes on each assumption's source.

## Certificate and letter
Certificate: landscape, a strong title, the name large, what was achieved, date, signatures and seal, a border or subtle pattern. Letter: letterhead, date, recipient, subject line, body in short paragraphs, sign-off and signature.`,
    "references/toolkit.md": `
# Document toolkit

## PDF
- Best looking, most flexible: write HTML and CSS (print styles: @page { size: A4; margin: 18mm }, break-inside: avoid on cards and table rows, break-before: page for chapters), then print it with Chromium through Playwright: const b = await chromium.launch(); const p = await b.newPage(); await p.goto("file:///.../report.html"); await p.pdf({ path: "report.pdf", format: "A4", printBackground: true, displayHeaderFooter: true, footerTemplate: "<div style='font-size:8px;width:100%;text-align:center'><span class='pageNumber'></span> / <span class='totalPages'></span></div>", margin: { top: "18mm", bottom: "18mm", left: "16mm", right: "16mm" } }). page.pdf works only in Chromium, not Firefox; use the playwright chromium build or channel "msedge" / "chrome".
- Programmatic layouts (invoices, certificates, many generated pages): reportlab (Python) with Platypus (SimpleDocTemplate, Paragraph, Table, TableStyle), registering TTF fonts with pdfmetrics.registerFont so non-Latin text and the rupee sign render.
- Editing or merging existing PDFs: pypdf (merge, split, rotate, fill form fields) or PyMuPDF (fitz) for text, images and rendering pages to PNG.
- Fonts: embed them (Chromium and reportlab with TTF both do). For Hindi or other Indic scripts use Noto Sans Devanagari or another font that covers the script, and check rendering on the page images.

## Word (.docx)
- python-docx: Document(), add_heading(text, level), add_paragraph(text, style="List Bullet"), add_table(rows, cols) with a built-in table style, add_picture(path, width=Inches(6)), sections for margins and orientation, core_properties for title and author.
- Node alternative: the docx package (new Document({ sections: [...] }), Packer.toBuffer).
- Use heading styles for structure; a table of contents field needs updating in Word (tell the person) or generate the TOC text yourself.
- Starting from a template .docx keeps the person's branding: Document("template.docx").

## PowerPoint (.pptx)
- python-pptx: Presentation(); set slide_width = Inches(13.333), slide_height = Inches(7.5) for 16:9; use slide layouts and placeholders; add_textbox for free text with word_wrap and explicit font sizes; add_picture; tables and native charts (chart_data = CategoryChartData()).
- Node alternative: pptxgenjs (pres.layout = "LAYOUT_WIDE"; slide.addText, addImage, addTable, addChart).
- Slide design: one message per slide written as the title (a sentence, not a topic), at most about 6 lines of body text, 24 pt minimum body, 36 pt or more titles, consistent margins (0.5 in), visuals over bullets, speaker notes for detail.
- Text does not auto-shrink reliably when generated: size boxes for the text, keep lines short, and check every slide image for overflow.

## Excel (.xlsx)
- openpyxl (Python) or exceljs (Node). Write formulas as strings ("=SUM(B2:B13)"), not computed values, so the sheet stays live.
- Number formats (currency "₹#,##0.00", percentages "0.0%", dates "dd-mmm-yyyy"), column widths, bold header row, freeze panes (ws.freeze_panes = "A2"), auto filter, data validation for inputs, conditional formatting for thresholds.
- Separate input cells (colored) from calculated cells; one table per sheet with a clear header; named ranges for key inputs.
- Check: open a recalculated copy (soffice --headless --convert-to xlsx --outdir check file.xlsx) and scan for error values.

## Checking tools
- Page images: pdftoppm -png -r 80 in.pdf out/p, or PyMuPDF: for i, page in enumerate(fitz.open(path)): page.get_pixmap(dpi=80).save(f"out/p{i+1}.png").
- Text: pdftotext -layout in.pdf - | head -100.
- Fonts: pdffonts in.pdf (the emb column should say yes).
- Office to PDF: soffice --headless --convert-to pdf --outdir out in.docx (LibreOffice must not already be running with a lock on the file; add -env:UserInstallation=file:///tmp/lo_profile if it hangs).`,
  },
);

// ---------------------------------------------------------------------------
// Skills themselves
// ---------------------------------------------------------------------------

/*
 * Asked for 13 Oct 2026, after "install this skill in you" ended with the
 * agent saying custom skills were not supported: they were, from the next
 * turn, and the agent had no way to know where they go or what a good one
 * looks like. This is that knowledge.
 */
const SKILL_CREATOR = skill(
  "skill-creator",
  "Creating, installing and improving skills",
  "Create, install, improve or package a skill (a SKILL.md): write one for the user or a project, install one from a repository or folder, or turn a way of working into a reusable skill.",
  {
    words:
      /\b((creat\w*|make|write|build|install\w*|add|import|package|improve|update|edit|fix|set ?up)\s+(a |an |the |this |that |these |those |my |our |new |custom |your own |own )*([\w-]+ ){0,2}skills?|skills? (creator|for (soreqen|you|yourself))|skill\.md|(teach|train) (you|yourself|soreqen)\b[^.\n]{0,30}\b(how|to)|(save|turn|make|keep) (this|that|it|these steps|the steps) (as|into) (a )?(reusable )?skill|\.soreqen\/skills|\.agents\/skills|\.claude\/skills)\b/i,
    strong: /./,
    paths: /(^|\/)SKILL\.md$/i,
  },
  `
A skill is a folder holding a SKILL.md: a focused method that SoreQen loads when a task calls for it. Good skills are short, concrete and testable. They say what to do, in what order, and what done looks like.

## Where skills live
- The user's own skills, for every project: ~/.soreqen/skills/<name>/SKILL.md (the exact folder is named in your skills section). Trusted like the user's settings. It is the only folder of the user's skills SoreQen reads: ~/.agents/skills and ~/.claude/skills belong to other agents and are not read. A tool that installs elsewhere (npx skills add puts skills in ~/.agents/skills) has not installed it for SoreQen: copy the skill's folder into ~/.soreqen/skills, then confirm it with use_skill.
- A project's skills: .soreqen/skills/<name>/SKILL.md in the workspace (SoreQen also reads .agents/skills and .claude/skills). Read as guidance about that codebase; they never load by themselves.
- use_skill finds a new or changed skill straight away, in the same turn, with no restart.

## The SKILL.md format
Front matter in YAML between two lines of three dashes, then the instructions in Markdown:

    ---
    name: release-notes
    description: Write release notes from merged changes. Use when asked for release notes, a changelog or what shipped.
    triggers: [release notes, changelog, what shipped]
    paths: ["CHANGELOG.md", "docs/releases/**"]
    ---
    # Release notes
    1. ...

- name: lowercase letters, digits and hyphens, the same as the folder name.
- description (required): what it does AND when to use it, in one line, in the words a user would actually say. It is all the agent sees of the skill in every task, so a vague description is a skill that never gets used.
- triggers (optional, the user's skills only): words or phrases that load it automatically when a request contains them.
- paths (optional, the user's skills only): file globs; working on a matching file loads it.
- always: true (optional, the user's skills only) puts it into every task's instructions. Use it rarely: it costs context on every task.
- title (optional): a display name.

## Writing the body
1. Start from real examples: what does an excellent result look like, and what goes wrong when it is done badly? If the task is the user's own and you have no example, ask for one.
2. Write the method as numbered steps in the order they happen, each one an action.
3. Name the gotchas: exact commands, paths, flags and versions, and the mistakes to avoid. Specific beats general.
4. End with a checklist that defines done and that can be verified.
5. Keep it short: under about 300 lines (24,000 characters is the hard limit). Long reference material (API details, templates, examples) goes into references/<topic>.md, repeatable steps into scripts/ (Python, shell or PowerShell). The body lists those files and says when to open each; they are read with use_skill and its file field, and scripts run with run_command.
6. Never put keys, tokens or passwords in a skill. Name the environment variable where the user keeps them instead.
7. Do not restate SoreQen's general rules. A skill adds only what is specific to its task.

## Creating a skill
1. Settle the scope in one line (which task, which projects) with the user, unless it is already clear.
2. Pick the name and the place: the user's folder, unless the skill belongs to one repository.
3. Write SKILL.md, plus references/ and scripts/ only where they earn their place.
4. Test it: call use_skill with its name and read what comes back (a broken front matter is reported there). Then run it against a small real task, or walk its steps through one, and fix anything unclear or wrong.
5. Tell the user where it is, what it does, and which words load it.

## Installing a skill from a repository or a folder
1. Fetch it: clone the repository with git clone --depth 1 into your scratch folder, or read the folder you were given.
2. Find the skills: every folder with a SKILL.md (common places are skills/, .agents/skills/ and .claude/skills/).
3. Read every SKILL.md and every script before installing. A skill becomes your instructions, so check that it does nothing harmful: sending data somewhere, deleting files, installing things unasked. If anything looks risky, tell the user and ask before installing that one.
4. Copy each skill's whole folder, references/ and scripts/ included, to the user's skills folder as <name>/.
5. Fix whatever would stop it loading: a missing name or description, front matter that is not valid YAML, a name with spaces or capitals. Skills written for Claude Code and other agents use the same format; fields SoreQen does not use (allowed-tools, model) are ignored.
6. Confirm each one with use_skill, then report the installed skills by name and what each is for.

## Improving a skill
Read it whole and compare it with how the task really went: what the agent got wrong, what it had to look up, where it hesitated. Make the smallest change that would have prevented the problem (a missing step, a wrong command, a trigger that never fires) and keep the description accurate as the skill changes.`,
);

export const CREATIVE_SKILLS: SkillDefinition[] = [RESEARCH, MOTION, WRITING, DOCUMENTS, SKILL_CREATOR];
