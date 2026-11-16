/**
 * A session's name, from the first thing someone asked in it.
 *
 * It was the message's first 60 characters, as typed. A request written as a
 * brief came out as "# PROJECT: SoreQen Code — Custom Professional Type…",
 * markdown and all, in the header and the sidebar, and a request that opened
 * with "Listen" or "Hey" was named after the word (seen 6 Nov 2026). The name
 * is now the request's first real line: its markdown marks and a leading
 * label ("PROJECT:", "Task:") taken off, a greeting or a "Listen" dropped, and
 * cut at a word, not inside one.
 *
 * Applied to stored titles when they are shown as well, so sessions named the
 * old way read the new way without being renamed.
 */

/** The longest name, in characters, before it is cut at a word. */
export const TITLE_MAX = 60;

/** Greetings a request opens with: never its subject. */
const GREETING = /^(?:(?:ok(?:ay)?|hey|hi|hello|yo|alright|please)\b[\s,.!:;—-]*)+/i;
/**
 * Words that open a request as a lead-in ("Listen, …", "Listen I want…",
 * "So We need…"), but can also be its subject ("Look at the logs", "Listen to
 * podcasts app"): dropped only when what follows shows they were a lead-in.
 */
// Case matters for what follows (a capital starts the real request), so no `i` flag.
const LEAD_IN = /^(?:[Ll]isten|LISTEN|[Ll]ook|[Ss]o|[Nn]ow|[Ww]ell|[Rr]ight)(?:\s*[,.!:;—-]+\s*|\s+(?=[A-Z]|(?:[iI]|[iI]'m|[iI]m|[wW]e|[yY]ou)\b))/;
/** A label in front of the subject: "PROJECT:", "Task -", "Goal:". */
const LABEL = /^(?:project|task|goal|objective|request|title|subject|summary|feature|bug|issue|todo|context|brief)\s*[:\-–—]\s+/i;

/** One line without markdown: headings, quotes, list marks, emphasis, code ticks, links. */
function plainLine(line: string): string {
  return line
    .replace(/^\s{0,3}(?:#{1,6}\s+|>\s*|[-*+]\s+(?:\[[ xX]\]\s+)?|\d+[.)]\s+)/, "")
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/(\*\*|__)(.+?)\1/g, "$2")
    .replace(/(^|[\s(])[*_]([^*_\s][^*_]*?)[*_](?=[\s).,!?:;]|$)/g, "$1$2")
    .replace(/`+([^`]*)`+/g, "$1")
    .replace(/\s+/g, " ")
    .trim();
}

/** Cut to `max` at a word, dropping what a cut leaves dangling ("&", "—", ","). */
function cutAtWord(text: string, max: number): string {
  if (text.length <= max) return text;
  const room = text.slice(0, max - 1);
  const space = room.lastIndexOf(" ");
  const cut = space > max * 0.6 ? room.slice(0, space) : room;
  return `${cut.replace(/[\s,;:&—–\-/(]+$/, "")}…`;
}

/** The name for a session whose first message was `content`. */
export function sessionTitle(content: string, max = TITLE_MAX): string {
  const withoutCode = content.replace(/```[\s\S]*?(```|$)/g, " ");
  for (const raw of withoutCode.split(/\r?\n/)) {
    let line = plainLine(raw);
    if (!line || /^[-=_*#\s]+$/.test(line)) continue;
    line = line.replace(GREETING, "").replace(LEAD_IN, "").replace(LABEL, "").trim();
    if (!line) continue;
    // A first letter in capitals, as a name reads.
    return cutAtWord(line.charAt(0).toUpperCase() + line.slice(1), max);
  }
  return "New session";
}

/** A stored title, as it is shown: cleaned the same way, so old names read like new ones. */
export function displayTitle(title: string | null | undefined): string | null {
  if (!title) return null;
  const cleaned = sessionTitle(title.replace(/…$/, ""), Math.max(TITLE_MAX, title.length));
  if (cleaned === "New session") return title;
  // A stored title that was cut keeps its mark.
  return title.endsWith("…") && !cleaned.endsWith("…") ? `${cleaned}…` : cleaned;
}
