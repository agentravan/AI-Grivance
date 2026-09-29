/**
 * lib/search.ts — live web context, fenced in on purpose.
 *
 * WHERE SEARCH IS ALLOWED
 *   • L&D chat: only for "live fact" questions (price / fee / exam / still offered /
 *     latest version) that name a known certification or course. The query sent to
 *     the search engine is BUILT FROM A TEMPLATE + that name — the employee's own
 *     words never leave the server.
 *   • Admin "Regulatory & Skills Pulse" (lib/pulse.ts): fixed topic queries, no
 *     employee data at all; results go to DRAFT and need a named approval.
 *   • HR Grievance: NEVER. There is deliberately no code path from the grievance
 *     module to this file.
 *
 * COST CONTROL
 *   Tavily (1 credit per basic search). Results cached 7 days in Redis; a monthly
 *   counter hard-stops at WEB_MONTHLY_CAP (default 900) to stay inside the free tier.
 *
 * SAFETY
 *   Web text is untrusted: HTML stripped, instruction-like lines removed, capped at
 *   800 chars, and fenced in the prompt below company policy (policy wins).
 */
import { createHash } from "node:crypto";
import { store } from "./store";
import type { WebSource } from "./types";

export interface WebResult extends WebSource {
  snippet: string;
}

const CACHE_TTL = 7 * 24 * 60 * 60;

export function webSearchEnabled(): boolean {
  return Boolean(process.env.TAVILY_API_KEY) && process.env.ENABLE_WEB_SEARCH !== "false";
}

const monthlyCap = () => Number(process.env.WEB_MONTHLY_CAP) || 900;
const monthKey = () => `web:count:${new Date().toISOString().slice(0, 7)}`;

// ───────────────────────────── trigger rules ─────────────────────────────

/** Questions about facts that change over time (English, Hindi, Hinglish). */
const LIVE_INTENT =
  /\b(price|pricing|cost|costs|fee|fees|voucher|exam (date|fee|pattern)|still (offered|available|valid)|latest (version|syllabus|exam)|renewal|expire[sd]?|validity|kitna|kitni|kitne)\b|कीमत|फीस|शुल्क|कितना|कितनी/i;

/**
 * Well-known certifications / course families. Extend per client via
 * WEB_ENTITIES="Tally Prime, NISM Series VIII, ..." (comma-separated).
 */
const BASE_ENTITIES = [
  "AWS Certified Cloud Practitioner", "AWS Solutions Architect", "AWS Developer", "AWS",
  "Azure Fundamentals", "AZ-900", "AZ-104", "AZ-204", "Azure",
  "Google Cloud", "GCP", "Google Data Analytics", "Google Project Management",
  "PMP", "CAPM", "PRINCE2", "Certified ScrumMaster", "CSM", "PSM", "SAFe", "ITIL",
  "Six Sigma Green Belt", "Six Sigma Black Belt", "Six Sigma", "Lean Six Sigma",
  "CISSP", "CISA", "CISM", "CEH", "CompTIA Security+", "CompTIA A+", "CompTIA",
  "CCNA", "CCNP", "Salesforce Administrator", "Salesforce",
  "SHRM-CP", "SHRM-SCP", "SHRM", "CIPD", "HRCI", "PHR", "SPHR",
  "CFA", "FRM", "ACCA", "CPA", "CMA",
  "Tableau", "Power BI", "PL-300", "Microsoft Excel", "Python", "Data Science",
  "Coursera", "Udemy", "LinkedIn Learning", "NPTEL", "SWAYAM",
];

function entities(): string[] {
  const extra = (process.env.WEB_ENTITIES ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  // Longest first so "AWS Solutions Architect" wins over "AWS".
  return [...extra, ...BASE_ENTITIES].sort((a, b) => b.length - a.length);
}

export function extractEntity(text: string): string | null {
  const t = text.toLowerCase();
  for (const e of entities()) {
    const esc = e.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    if (new RegExp(`(^|[^a-z0-9])${esc}([^a-z0-9]|$)`).test(t)) return e;
  }
  return null;
}

/**
 * Decide whether an L&D question should get live web context.
 * @param policyHasAnswer true if the retrieved company excerpts already mention
 *        this entity together with an amount — then company data is enough.
 */
export function planLdSearch(text: string, policyHasAnswer: boolean): string | null {
  if (!webSearchEnabled() || policyHasAnswer || !LIVE_INTENT.test(text)) return null;
  const entity = extractEntity(text);
  if (!entity) return null;
  const year = new Date().getFullYear();
  // Templated query — the employee's raw words are never sent.
  if (/still|latest|valid|validity|expire|renewal/i.test(text)) {
    return `${entity} certification current status latest version ${year} official`;
  }
  return `${entity} certification exam fee India ${year} official`;
}

/** Does any excerpt mention the entity next to a money amount? */
export function excerptsCoverPrice(excerptTexts: string[], text: string): boolean {
  const entity = extractEntity(text);
  if (!entity) return false;
  const e = entity.toLowerCase();
  return excerptTexts.some((x) => x.toLowerCase().includes(e) && /(₹|rs\.?|inr|usd|\$)\s?\d/i.test(x));
}

// ───────────────────────────── Tavily call ─────────────────────────────

/** Remove markup and anything that looks like instructions aimed at an AI. */
export function sanitizeSnippet(s: string, max = 800): string {
  return s
    .replace(/<[^>]*>/g, " ")
    .split(/\n+/)
    .filter((line) => !/(ignore (all|previous|the above)|system prompt|you are (now )?an? (ai|assistant)|disregard|new instructions)/i.test(line))
    .join(" ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);
}

const domainOf = (url: string) => {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
};

export async function webSearch(
  query: string,
  opts: { maxResults?: number; includeDomains?: string[]; topic?: "general" | "news"; timeRange?: "week" | "month" | "year" } = {},
): Promise<WebResult[]> {
  const key = process.env.TAVILY_API_KEY;
  if (!key) return [];

  const cacheKey = `web:cache:${createHash("sha256").update(JSON.stringify([query, opts])).digest("hex").slice(0, 32)}`;
  const cached = await store.getJSON<WebResult[]>(cacheKey);
  if (cached) return cached;

  // Monthly hard cap protects the free tier.
  const used = await store.incrWindow(monthKey(), 32 * 24 * 60 * 60);
  if (used > monthlyCap()) return [];

  const includeDomains =
    opts.includeDomains ??
    (process.env.WEB_INCLUDE_DOMAINS ?? "").split(",").map((d) => d.trim()).filter(Boolean);

  try {
    const res = await fetch("https://api.tavily.com/search", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
      body: JSON.stringify({
        query,
        search_depth: "basic",
        max_results: opts.maxResults ?? 3,
        topic: opts.topic ?? "general",
        ...(opts.timeRange ? { time_range: opts.timeRange } : {}),
        ...(includeDomains.length ? { include_domains: includeDomains } : {}),
      }),
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) {
      console.error(`[aegis] web search failed: HTTP ${res.status}`);
      return [];
    }
    const data = (await res.json()) as { results?: { title?: string; url?: string; content?: string }[] };
    const checkedAt = new Date().toISOString();
    const results: WebResult[] = (data.results ?? [])
      .filter((r) => r.url && r.content)
      .map((r) => ({
        title: sanitizeSnippet(r.title ?? domainOf(r.url!), 140),
        url: r.url!,
        domain: domainOf(r.url!),
        snippet: sanitizeSnippet(r.content!),
        checkedAt,
      }));
    await store.setJSONEx(cacheKey, results, CACHE_TTL);
    return results;
  } catch {
    console.error("[aegis] web search error (timeout or network)");
    return [];
  }
}
