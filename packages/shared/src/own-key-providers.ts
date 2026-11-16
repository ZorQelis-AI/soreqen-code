/**
 * Model providers someone can bring their own API key for — one table for
 * the CLI and the desktop app, so both offer the same choices with the same
 * defaults.
 */

/**
 * The providers someone can bring their own key for, in the order a key is
 * taken when several are set.
 *
 * Each carries its own base URL and default model. They used to share one
 * fallback chain, so a machine with only `OPENAI_API_KEY` set sent that key
 * to OpenCode's URL — the base URL fell through to the first provider's.
 * A provider without a sensible default model (OpenAI, OpenRouter) needs one
 * named, and says so.
 */
export interface OwnKeyProvider {
  id: "opencode" | "anthropic" | "openai" | "openrouter" | "deepseek";
  label: string;
  keyVars: string[];
  baseURLVars: string[];
  defaultBaseURL?: string;
  modelVars: string[];
  defaultModel?: string;
  /** Where to get a key, for the first-run setup. */
  keyUrl: string;
}

export const OWN_KEY_PROVIDERS: OwnKeyProvider[] = [
  {
    id: "opencode",
    label: "OpenCode (Zen / Go)",
    keyVars: ["OPENCODE_API_KEY", "MIMO_API_KEY"],
    baseURLVars: ["OPENCODE_BASE_URL", "MIMO_BASE_URL"],
    defaultBaseURL: "https://opencode.ai/zen/go/v1",
    modelVars: ["OPENCODE_MODEL", "MIMO_MODEL"],
    defaultModel: "mimo-v2.6-flash",
    keyUrl: "https://opencode.ai/auth",
  },
  {
    id: "anthropic",
    label: "Anthropic",
    keyVars: ["ANTHROPIC_API_KEY"],
    baseURLVars: [],
    modelVars: ["ANTHROPIC_MODEL"],
    defaultModel: "claude-sonnet-5",
    keyUrl: "https://console.anthropic.com/settings/keys",
  },
  {
    id: "openai",
    label: "OpenAI",
    keyVars: ["OPENAI_API_KEY"],
    baseURLVars: ["OPENAI_BASE_URL"],
    defaultBaseURL: "https://api.openai.com/v1",
    modelVars: ["OPENAI_MODEL"],
    keyUrl: "https://platform.openai.com/api-keys",
  },
  {
    id: "openrouter",
    label: "OpenRouter",
    keyVars: ["OPENROUTER_API_KEY"],
    baseURLVars: [],
    defaultBaseURL: "https://openrouter.ai/api/v1",
    modelVars: ["OPENROUTER_MODEL"],
    keyUrl: "https://openrouter.ai/keys",
  },
  {
    id: "deepseek",
    label: "DeepSeek",
    keyVars: ["DEEPSEEK_API_KEY"],
    baseURLVars: ["DEEPSEEK_BASE_URL"],
    defaultBaseURL: "https://api.deepseek.com",
    modelVars: ["DEEPSEEK_MODEL"],
    defaultModel: "deepseek-chat",
    keyUrl: "https://platform.deepseek.com/api_keys",
  },
];

/**
 * The models one key is used for, from its model variable.
 *
 * One key reaches every model its plan serves, so the variable holds a
 * comma-separated list — `OPENCODE_MODEL=glm-5.3-flash,mimo-v2.6-flash` — and
 * a single name, as every existing file has, is a list of one. The first is
 * the one the CLI uses when told nothing else.
 */
export function modelList(value: string | undefined | null): string[] {
  const seen = new Set<string>();
  for (const part of (value ?? "").split(",")) {
    const name = part.trim();
    if (name) seen.add(name);
  }
  return [...seen];
}

/**
 * An own-key provider's OpenAI-compatible base URL. Anthropic serves an
 * OpenAI-compatible endpoint beside its own API, which is what lets one
 * client code path reach every provider here.
 */
export function openAICompatibleBaseURL(provider: OwnKeyProvider, configured?: string): string | undefined {
  if (configured) return configured;
  if (provider.id === "anthropic") return "https://api.anthropic.com/v1";
  return provider.defaultBaseURL;
}
