/**
 * Turning code and prose into terms that can be matched.
 *
 * Code is not prose: `getUserSession`, `get_user_session` and "the user's
 * session" all mean the same thing to a person and share no word to a naive
 * tokenizer. So identifiers are split at case changes and underscores and
 * kept whole as well — the whole name matches a symbol search exactly, and
 * its parts match the words someone would use to describe it.
 */

const STOPWORDS = new Set(
  (
    "a an and are as at be but by for from has have if in into is it its of on or " +
    "that the their then there these this to was were will with not no do does " +
    "const let var function return import export default new class this true false null undefined " +
    "self def pass none public private static void async await from"
  ).split(" "),
);

/** Terms in `text`: whole identifiers, their parts, lowercased, without noise words. */
export function terms(text: string): string[] {
  const out: string[] = [];
  const words = text.match(/[A-Za-z_$][A-Za-z0-9_$]*|\d{2,}/g) ?? [];
  for (const word of words) {
    const whole = word.toLowerCase();
    if (whole.length >= 2 && !STOPWORDS.has(whole)) out.push(whole);
    const parts = word
      .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
      .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
      .split(/[_$\s]+/)
      .map((p) => p.toLowerCase())
      .filter((p) => p.length >= 2 && !STOPWORDS.has(p));
    if (parts.length > 1) out.push(...parts);
  }
  return out;
}

/**
 * The root of a word, crudely.
 *
 * Not a real stemmer, and it does not need to be: it only has to make
 * "authenticate", "authentication" and "authenticated" land on the same
 * term, so a question phrased one way finds code written another.
 */
export function stem(term: string): string {
  if (term.length <= 4) return term;
  return term
    .replace(/(ational|ation|ition|ions|ion)$/, "")
    .replace(/(izing|ising|izer|iser|ize|ise)$/, "")
    .replace(/(ings|ing|edly|ed|ers|er|ies|es|s)$/, "")
    .replace(/(ment|ness|able|ible|ful|less|ly)$/, "");
}

/** Term counts. */
export function termCounts(list: string[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const t of list) counts.set(t, (counts.get(t) ?? 0) + 1);
  return counts;
}

/** Identifiers that look like code symbols in free text: `camelCase`, `snake_case`, `Pascal`, `x.y`. */
export function mentionedSymbols(text: string): string[] {
  const found = new Set<string>();
  for (const m of text.matchAll(/`([^`\n]{2,80})`/g)) {
    for (const id of m[1]!.match(/[A-Za-z_$][A-Za-z0-9_$]{2,}/g) ?? []) found.add(id);
  }
  for (const id of text.match(/\b[a-z]+[A-Z][A-Za-z0-9]*\b|\b[A-Z][a-z0-9]+[A-Z][A-Za-z0-9]*\b|\b[a-z0-9]+_[a-z0-9_]+\b/g) ?? []) {
    found.add(id);
  }
  return [...found].slice(0, 40);
}

/** Paths that appear in free text, such as `src/auth/session.ts` or `app.py:42`. */
export function mentionedPaths(text: string): string[] {
  const found = new Set<string>();
  for (const m of text.matchAll(/(?:^|[\s`'"(])((?:\.{0,2}\/)?[\w@.-]+(?:\/[\w@.-]+)*\.[A-Za-z]{1,6})(?::\d+)?/g)) {
    const p = m[1]!.replace(/^\.\//, "");
    if (/^\d+(\.\d+)+$/.test(p)) continue; // a version number, not a file
    found.add(p);
  }
  return [...found].slice(0, 40);
}
