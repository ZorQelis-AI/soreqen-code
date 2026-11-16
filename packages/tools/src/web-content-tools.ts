/**
 * Fetching a page the agent was pointed at.
 *
 * ## What this has to defend against
 *
 * On the CLI this runs on the user's laptop. On the embedded surface it runs
 * on ZorQelis infrastructure, inside the network — next to the gateway, the
 * database, and the cloud provider's metadata service. A tool that fetches
 * "any URL the model asked for" is, on that surface, a request forgery
 * primitive with the server's own network position.
 *
 * The URL is also not necessarily the user's idea. It can come from a search
 * result, a README, or a page fetched a moment ago — so "the model chose it"
 * is not a trust argument.
 *
 * So: a scheme allowlist, a refusal to touch private address space, the same
 * check re-run after every redirect (a public host may 302 to 127.0.0.1), a
 * cap on how much is read, and one deadline covering the whole thing rather
 * than just the headers.
 */

import dns from "node:dns/promises";
import net from "node:net";
import { FetchUrlContentInputSchema, type FetchUrlContentInput } from "@sqcode/shared";

/** The whole request, not just its first byte. The previous version cleared
 *  its timer as soon as headers arrived, so a slow body was unbounded. */
const TOTAL_DEADLINE_MS = 15_000;

/** Read ceiling. `res.text()` buffers the entire body before anything gets to
 *  truncate it, so a large response was a memory problem regardless of
 *  `max_length`. */
const MAX_BODY_BYTES = 2 * 1024 * 1024;

/** Redirects followed. Enough for the http→https→www chains that are normal,
 *  few enough that a redirect loop ends. */
const MAX_REDIRECTS = 3;

export class BlockedAddressError extends Error {
  constructor(host: string, why: string) {
    super(`Refusing to fetch '${host}': ${why}.`);
    this.name = "BlockedAddressError";
  }
}

/**
 * Is this IP somewhere a fetch has no business going?
 *
 * Loopback, link-local (which is where every cloud metadata service lives),
 * private ranges, carrier-grade NAT, and the unspecified address. Exported
 * because the rule is worth testing directly — it is the part that matters and
 * the part with the fiddly edges.
 */
export function isBlockedAddress(ip: string): string | null {
  const version = net.isIP(ip);
  if (version === 0) return "it is not a resolvable address";

  if (version === 4) {
    const parts = ip.split(".").map(Number) as [number, number, number, number];
    const [a, b] = parts;
    if (a === 0) return "0.0.0.0/8 is unspecified";
    if (a === 10) return "10.0.0.0/8 is private";
    if (a === 127) return "127.0.0.0/8 is loopback";
    if (a === 169 && b === 254) return "169.254.0.0/16 is link-local (cloud metadata)";
    if (a === 172 && b >= 16 && b <= 31) return "172.16.0.0/12 is private";
    if (a === 192 && b === 168) return "192.168.0.0/16 is private";
    if (a === 100 && b >= 64 && b <= 127) return "100.64.0.0/10 is carrier-grade NAT";
    if (a >= 224) return "224.0.0.0/4 and above are multicast or reserved";
    return null;
  }

  const lower = ip.toLowerCase();
  if (lower === "::" || lower === "::1") return "the IPv6 loopback or unspecified address";
  if (lower.startsWith("fe80")) return "fe80::/10 is IPv6 link-local";
  if (/^f[cd]/.test(lower)) return "fc00::/7 is an IPv6 unique local address";
  // ::ffff:127.0.0.1 and friends — an IPv4 address wearing an IPv6 hat.
  const mapped = lower.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (mapped?.[1]) return isBlockedAddress(mapped[1]);
  return null;
}

/** Resolve a hostname and refuse it if any address it answers with is one we
 *  will not talk to. Every address, not just the first: a host that returns
 *  both a public and a loopback address must not be usable. */
export async function assertPublicHost(hostname: string): Promise<void> {
  const literal = net.isIP(hostname);
  if (literal !== 0) {
    const why = isBlockedAddress(hostname);
    if (why) throw new BlockedAddressError(hostname, why);
    return;
  }

  let addresses: { address: string }[];
  try {
    addresses = await dns.lookup(hostname, { all: true });
  } catch {
    throw new BlockedAddressError(hostname, "it could not be resolved");
  }

  for (const { address } of addresses) {
    const why = isBlockedAddress(address);
    if (why) throw new BlockedAddressError(hostname, `it resolves to ${address}, and ${why}`);
  }
}

/** Read at most `MAX_BODY_BYTES`, then stop pulling. */
async function readCapped(res: Response): Promise<string> {
  if (!res.body) return "";
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      chunks.push(value);
      total += value.byteLength;
      if (total >= MAX_BODY_BYTES) break;
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
  return new TextDecoder().decode(Buffer.concat(chunks.map((c) => Buffer.from(c))));
}

export async function toolFetchUrlContent(
  input: FetchUrlContentInput,
  signal?: AbortSignal,
): Promise<{
  url: string;
  status: number;
  content: string;
  truncated: boolean;
  ok: boolean;
  error?: string;
}> {
  /*
   * Actually parse it.
   *
   * The schema declared `.url()` and nothing ever called `.parse()` — this
   * function imported the *type* and destructured the input, so the validation
   * was dead code for the life of the file.
   */
  const parsed = FetchUrlContentInputSchema.parse(input);
  const maxLength = parsed.max_length ?? 10_000;

  const deadline = new AbortController();
  const timer = setTimeout(() => deadline.abort(), TOTAL_DEADLINE_MS);
  const onOuterAbort = (): void => deadline.abort();
  signal?.addEventListener("abort", onOuterAbort, { once: true });

  try {
    let current = parsed.url;
    let res: Response | undefined;

    for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
      let target: URL;
      try {
        target = new URL(current);
      } catch {
        return fail(current, `'${current}' is not a URL.`);
      }

      if (target.protocol !== "http:" && target.protocol !== "https:") {
        return fail(
          current,
          `'${target.protocol}' is not a scheme this tool will fetch. Only http and https.`,
        );
      }

      // Re-checked on every hop: a public host is free to redirect to 127.0.0.1.
      await assertPublicHost(target.hostname);

      res = await fetch(target.toString(), {
        signal: deadline.signal,
        redirect: "manual",
        headers: {
          "User-Agent": "SoreQen-Code-Agent/2.0 (+https://soreqen.ai)",
          Accept: "text/html,application/xhtml+xml,text/plain,application/json",
        },
      });

      if (res.status >= 300 && res.status < 400) {
        const location = res.headers.get("location");
        if (!location) break;
        current = new URL(location, target).toString();
        continue;
      }
      break;
    }

    if (!res) return fail(current, "Too many redirects.");

    const rawText = await readCapped(res);
    let cleaned = rawText;

    if (res.headers.get("content-type")?.includes("html") || rawText.includes("<html")) {
      cleaned = rawText
        .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, "")
        .replace(/<style\b[^<]*(?:(?!<\/style>)<[^<]*)*<\/style>/gi, "")
        .replace(/<svg\b[^<]*(?:(?!<\/svg>)<[^<]*)*<\/svg>/gi, "")
        .replace(/<h[1-6][^>]*>(.*?)<\/h[1-6]>/gi, "\n\n## $1\n")
        .replace(/<p[^>]*>(.*?)<\/p>/gi, "\n$1\n")
        .replace(/<li[^>]*>(.*?)<\/li>/gi, "\n- $1")
        .replace(/<pre[^>]*><code[^>]*>([\s\S]*?)<\/code><\/pre>/gi, "\n```\n$1\n```\n")
        .replace(/<code[^>]*>(.*?)<\/code>/gi, "`$1`")
        .replace(/<a\b[^>]*href="([^"]*)"[^>]*>(.*?)<\/a>/gi, "[$2]($1)")
        .replace(/<[^>]+>/g, "")
        .replace(/&nbsp;/g, " ")
        .replace(/&amp;/g, "&")
        .replace(/&lt;/g, "<")
        .replace(/&gt;/g, ">")
        .replace(/\n\s*\n\s*\n/g, "\n\n")
        .trim();
    }

    const truncated = cleaned.length > maxLength;
    const finalContent = truncated
      ? `${cleaned.slice(0, maxLength)}\n\n...[Content truncated]`
      : cleaned;

    return {
      url: current,
      status: res.status,
      content: finalContent,
      truncated,
      // A 404 is a real answer about a page that is not there — the fetch
      // worked. Only a transport failure is `ok: false`.
      ok: true,
    };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return fail(parsed.url, msg);
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", onOuterAbort);
  }
}

function fail(
  url: string,
  error: string,
): { url: string; status: number; content: string; truncated: boolean; ok: false; error: string } {
  return { url, status: 0, content: "", truncated: false, ok: false, error };
}
