/**
 * SoreQen credits as SoreQen Code's clients read them: the gateway's usage and
 * model lists, in the shapes the desktop app and the CLI show.
 *
 * The gateway counts in whole credits per window (5-hour, weekly, Burst Day)
 * plus the month's plan credits; bought credits are never paced; Flex is a
 * dollar wallet. See docs/SOREQEN_CREDITS_AND_GATEWAY.md in the website repo.
 */

export interface WindowUsage {
  used_percent: number;
  resets_at: string;
  /** Whole credits, when the window is counted in them. */
  used?: number;
  limit?: number;
}

/** SoreQen credits as the app shows them: whole credits, Flex in dollars. */
export interface CreditsView {
  /** What can be spent right now: plan credits the windows allow, plus bought ones. */
  spendable_now: number;
  plan: { granted: number; remaining: number; period_end: string } | null;
  purchased: { remaining: number; next_expiry: string | null };
  burst: { active: boolean; used: number; limit: number; ends_at: string | null; available_at: string | null } | null;
  five_hour_lifted: boolean;
  flex_usd: number;
}

export interface Usage {
  plan: string;
  hosted: boolean;
  allowed: boolean;
  reason?: string;
  message?: string;
  /** The plan's windows; "monthly" is the month's plan credits. */
  windows: Record<"five_hour" | "weekly" | "monthly", WindowUsage> | null;
  credits?: CreditsView;
}

/** A Flow model as SoreQen lists it. */
export interface HostedModel {
  id: string;
  name: string;
  context_window?: number | null;
  credits_per_request?: number;
  price_cliff_tokens?: number | null;
  auto?: boolean;
  /** The model a new session starts on: the gateway's `default_model`, the cheap one. */
  default?: boolean;
}

/** The gateway's model list, with its default marked. */
export function markDefaultModel(body: { data?: HostedModel[]; default_model?: string | null }): HostedModel[] {
  const models = (body.data ?? []).filter((m) => typeof m.id === "string");
  return models.map((m) => (m.id === body.default_model ? { ...m, default: true } : m));
}

/** What a picker shows under a Flow model's name. */
export function hostedDetail(m: HostedModel): string | undefined {
  return m.auto ? "Picks the model for each step" : creditsDetail(m.credits_per_request);
}

/** A Flex model: a provider's own price, from the Flex wallet. */
export interface FlexModel {
  id: string;
  name: string;
  context_window?: number | null;
  price?: { input: number; output: number };
}

export type GatewayWindow = { used: number; limit: number; used_percent: number; resets_at: string; lifted?: boolean };
export interface GatewayUsage {
  plan: string;
  credits?: {
    plan: { granted: number; remaining: number; period_end: string } | null;
    purchased: { remaining: number; next_expiry: string | null };
    spendable_now: number;
  };
  windows?: { five_hour: GatewayWindow; weekly: GatewayWindow; burst: { active: boolean; used: number; limit: number; ends_at: string | null; available_at: string | null } } | null;
  flex?: { balance_usd: number };
  message?: string;
}

/**
 * The gateway's credits, in the shape the app has always read: the 5-hour and
 * weekly windows as they are, and the month as the plan's credits used. The
 * hosted models are open to every account (Free buys credits), so `hosted` is
 * true whenever SoreQen answers; `allowed` says whether anything can be spent.
 */
export function usageFromGateway(body: GatewayUsage): Usage {
  const c = body.credits;
  // Read defensively: an older or unexpected answer leaves a field out rather than throwing.
  const w = body.windows && body.windows.five_hour && body.windows.weekly ? body.windows : null;
  const plan = c?.plan ?? null;
  const window = (x: GatewayWindow): WindowUsage => ({ used_percent: x.used_percent, resets_at: x.resets_at, used: x.used, limit: x.limit });
  const spendable = c?.spendable_now ?? 0;
  return {
    plan: body.plan,
    hosted: true,
    allowed: spendable > 0,
    ...(body.message ? { message: body.message } : {}),
    windows:
      w && plan
        ? {
            five_hour: window(w.five_hour),
            weekly: window(w.weekly),
            monthly: {
              used_percent: plan.granted > 0 ? Math.min(100, Math.round(((plan.granted - plan.remaining) / plan.granted) * 100)) : 100,
              resets_at: plan.period_end,
              used: plan.granted - plan.remaining,
              limit: plan.granted,
            },
          }
        : null,
    credits: {
      spendable_now: spendable,
      plan,
      purchased: c?.purchased ?? { remaining: 0, next_expiry: null },
      burst: w?.burst ?? null,
      five_hour_lifted: Boolean(w?.five_hour?.lifted),
      flex_usd: body.flex?.balance_usd ?? 0,
    },
  };
}

/** Flex models are told apart from Flow ones by this prefix on their id: under `soreqen/`, so whatever clears the hosted models clears them too. */
export const FLEX_PREFIX = "soreqen/flex/";

/** "About 2.4 credits a request", the way the picker says it. */
export function creditsDetail(perRequest: number | undefined): string | undefined {
  if (perRequest === undefined || !Number.isFinite(perRequest)) return undefined;
  const n = perRequest >= 10 ? Math.round(perRequest) : Math.round(perRequest * 10) / 10;
  return `\u2248 ${n} credit${n === 1 ? "" : "s"} a request`;
}

/** "$0.50 in, $2.00 out per M": Flex's provider price. */
export function flexDetail(price: FlexModel["price"]): string | undefined {
  if (!price) return undefined;
  const usd = (v: number) => `$${v < 0.1 ? v.toFixed(3) : v.toFixed(2)}`;
  return `${usd(price.input)} in, ${usd(price.output)} out per M`;
}

/**
 * The window a client should compact at: the model's own, but below the
 * prompt size where its price steps up, so a long session never crosses into
 * the dearer band unasked.
 */
export function effectiveWindow(contextWindow: number | null | undefined, priceCliff: number | null | undefined): number | undefined {
  const w = contextWindow ?? undefined;
  if (!priceCliff) return w;
  return w ? Math.min(w, priceCliff) : priceCliff;
}
