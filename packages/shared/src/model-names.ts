/**
 * A model id as a person would write it: "mimo-v2.6-flash" → "MiMo V2.6 Flash".
 *
 * Own-key models have no name of their own, only the id their provider uses,
 * and the picker showed those ids raw (31 Oct 2026). Any id added later gets
 * the same treatment: words capitalised, versions upper-cased, and the brands
 * that have their own spelling spelled their way.
 */

/** Words with a spelling of their own. Keys are lower case. */
const SPELLING: Record<string, string> = {
  ai: "AI",
  api: "API",
  claude: "Claude",
  codestral: "Codestral",
  deepseek: "DeepSeek",
  gemini: "Gemini",
  gemma: "Gemma",
  glm: "GLM",
  gpt: "GPT",
  grok: "Grok",
  kimi: "Kimi",
  llama: "Llama",
  minimax: "MiniMax",
  mimo: "MiMo",
  mistral: "Mistral",
  moe: "MoE",
  oss: "OSS",
  phi: "Phi",
  qwen: "Qwen",
  qwq: "QwQ",
  soreqen: "SoreQen",
  tts: "TTS",
  vl: "VL",
};

/** A brand directly followed by its generation, as in "qwen3" or "gemma2". */
const BRAND_WITH_NUMBER = /^([a-z]+?)(\d[\w.]*)$/;

function word(raw: string): string {
  const lower = raw.toLowerCase();
  if (SPELLING[lower]) return SPELLING[lower]!;
  // Sizes, before versions, which "a3b" also looks like: 70b, 1.5b, a3b, 128k.
  if (/^(\d+(\.\d+)?[bkm]|a\d+(\.\d+)?b)$/.test(lower)) return lower.toUpperCase();
  // Versions and generations: v2.6, k2, r1, m2.5.
  if (/^[a-z]\d+(\.\d+)*[a-z]?$/.test(lower)) return lower[0]!.toUpperCase() + lower.slice(1);
  const branded = BRAND_WITH_NUMBER.exec(lower);
  if (branded && SPELLING[branded[1]!]) return SPELLING[branded[1]!]! + branded[2]!;
  if (/^\d/.test(raw)) return raw;
  return raw[0]!.toUpperCase() + raw.slice(1);
}

export function modelDisplayName(id: string): string {
  // The provider's prefix ("opencode/", "openai/") says where, not what.
  const name = id.slice(id.lastIndexOf("/") + 1).replace(/:.*$/, "");
  const split = name.split(/[-_\s]+/).filter(Boolean);
  if (split.length === 0) return id;
  /*
   * A version written with hyphens is one version: Anthropic's ids spell 5.5
   * as "5-5" ("claude-haiku-5-5"), and the picker read "Claude Haiku 5 5"
   * (reported 13 Nov 2026). Short numbers side by side join with a dot; a
   * date ("20241022") is never one of them.
   */
  const words: string[] = [];
  for (const w of split) {
    const prev = words[words.length - 1];
    if (prev !== undefined && /^\d{1,2}$/.test(w) && /^\d{1,2}(\.\d{1,2})*$/.test(prev)) words[words.length - 1] = `${prev}.${w}`;
    else words.push(w);
  }
  const out: string[] = [];
  for (let i = 0; i < words.length; i++) {
    const shown = word(words[i]!);
    // GPT keeps its hyphen before a generation: GPT-4o, GPT-6 Luna.
    if (shown === "GPT" && i + 1 < words.length && /^\d/.test(words[i + 1]!)) {
      out.push(`GPT-${words[++i]}`);
      continue;
    }
    out.push(shown);
  }
  return out.join(" ");
}
