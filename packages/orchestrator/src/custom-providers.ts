/**
 * Providers someone adds by hand, read the same way by every surface.
 *
 * The list lives in `~/.soreqen/providers.json` (no secrets; each provider
 * names the `.env` variable its key is kept under). The desktop app's
 * Settings writes it. Until 13 Nov 2026 only the desktop runtime could read
 * it, so a provider added in the app — Gemini, Groq, Ollama — did not exist
 * in the CLI: `/model gemini/gemini-2.5-pro` answered "unknown model" on the
 * same machine. The reader moved here, beside the catalogue, so the app and
 * the CLI build their pickers from one definition.
 */

import { existsSync, readFileSync } from "node:fs";
import { modelDisplayName } from "@sqcode/shared";
import type { ModelEndpoint } from "./model-catalogue.js";

export type ProviderProtocol = "auto" | "anthropic" | "openai-chat" | "openai-responses";
export const PROTOCOLS: ProviderProtocol[] = ["auto", "openai-chat", "openai-responses", "anthropic"];

export interface CustomProvider {
  /** Stable, lowercase: the first part of each model's id in the picker. */
  id: string;
  label: string;
  baseURL: string;
  protocol: ProviderProtocol;
  /** The `.env` variable holding its key; none for a local server that takes no key. */
  keyVar?: string;
  models: string[];
  /** Headers the endpoint asks for beyond its key (an organisation id, a project). */
  headers?: Record<string, string>;
}

function isProvider(p: unknown): p is CustomProvider {
  if (!p || typeof p !== "object") return false;
  const o = p as Record<string, unknown>;
  return (
    typeof o["id"] === "string" &&
    typeof o["label"] === "string" &&
    typeof o["baseURL"] === "string" &&
    Array.isArray(o["models"]) &&
    PROTOCOLS.includes(o["protocol"] as ProviderProtocol)
  );
}

/** The hand-added providers in `path`; none when the file is missing or unreadable. */
export function readProviders(path: string): CustomProvider[] {
  if (!existsSync(path)) return [];
  try {
    const raw = JSON.parse(readFileSync(path, "utf8")) as { providers?: unknown };
    if (!Array.isArray(raw.providers)) return [];
    return raw.providers
      .filter(isProvider)
      .map((p) => ({ ...p, models: [...new Set(p.models.filter((m): m is string => typeof m === "string").map((m) => m.trim()).filter(Boolean))] }));
  } catch {
    return [];
  }
}

/** The `.env` variable a provider's key is kept under. */
export function keyVarFor(id: string): string {
  return `SOREQEN_PROVIDER_${id.toUpperCase().replace(/[^A-Z0-9]+/g, "_")}_KEY`;
}

/** Whether an address is this computer: a local server takes any key, or none. */
export function isLocal(baseURL: string): boolean {
  return /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\]|0\.0\.0\.0)(:\d+)?\//i.test(`${baseURL.replace(/\/+$/, "")}/`);
}

/**
 * One catalogue entry per model of every hand-added provider. A provider
 * whose key is missing is left out rather than listed and broken.
 */
export function customEndpoints(
  providers: CustomProvider[],
  keys: Record<string, string | undefined>,
  section?: string,
): ModelEndpoint[] {
  const out: ModelEndpoint[] = [];
  for (const p of providers) {
    const key = p.keyVar ? keys[p.keyVar]?.trim() : undefined;
    if (!key && !isLocal(p.baseURL)) continue;
    for (const model of p.models) {
      out.push({
        id: `${p.id}/${model}`,
        label: modelDisplayName(model),
        upstreamModel: model,
        baseURL: p.baseURL.replace(/\/+$/, ""),
        // The OpenAI client will not send a request without some key; a local server ignores it.
        apiKey: key || "local",
        group: p.label,
        ...(section ? { section } : {}),
        protocol: p.protocol,
        ...(p.headers && Object.keys(p.headers).length > 0 ? { headers: p.headers } : {}),
      });
    }
  }
  return out;
}
