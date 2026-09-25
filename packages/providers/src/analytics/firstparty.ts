import { httpRequest, ProviderHttpError, type FetchLike } from "../core/http.ts";

/**
 * First-party conversions (§5.9, SyllaCal UTM PR 1). The product exposes an aggregate endpoint
 * with no personal data; maint.conversions_pull reads it daily.
 *
 * Contract for the product side (what the SyllaCal PR must implement):
 *   GET <base>/api/marketing/aggregate?from=YYYY-MM-DD&to=YYYY-MM-DD
 *   Authorization: Bearer <FIRSTPARTY_ANALYTICS_TOKEN>   (constant-time compare; 401 otherwise)
 *   200 application/json:
 *     { "rows": [ { "day": "2026-10-20", "utm_source": "tiktok", "utm_content": "<variantId>",
 *                   "utm_term": "<angleId>", "visits": 12, "signups": 2, "purchases": 0 } ] }
 *   - `from`/`to` are inclusive UTC days; at most 92 days per call (400 otherwise).
 *   - One row per (day, utm_source, utm_content, utm_term) from the first-touch UTM cookie;
 *     missing UTM values are "" (never null), so direct traffic is a row with all three empty.
 *   - Counts are integers ≥ 0. Visits count page_view sessions; capture traffic (the
 *     `X-Marketing-Capture: 1` header) is excluded. No user ids, emails or IPs, ever.
 *   - Cache-Control: no-store.
 */

export interface AggregateRow {
  day: string;
  utm_source: string;
  utm_content: string;
  utm_term: string;
  visits: number;
  signups: number;
  purchases: number;
}

const count = (v: unknown, field: string, i: number): number => {
  if (typeof v !== "number" || !Number.isInteger(v) || v < 0) throw new Error(`aggregate row ${i}: ${field} must be a whole number ≥ 0`);
  return v;
};
const utm = (v: unknown): string => (typeof v === "string" ? v : "");

/** Hand-rolled check (providers has no zod install yet); strict on counts and day, lenient on UTM values. */
export function parseAggregateResponse(json: unknown): AggregateRow[] {
  const rows = json && typeof json === "object" ? (json as { rows?: unknown }).rows : undefined;
  if (!Array.isArray(rows)) throw new Error("aggregate response has no rows array");
  return rows.map((raw, i) => {
    const r = (raw ?? {}) as Record<string, unknown>;
    if (typeof r.day !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(r.day)) throw new Error(`aggregate row ${i}: bad day`);
    return {
      day: r.day,
      utm_source: utm(r.utm_source),
      utm_content: utm(r.utm_content),
      utm_term: utm(r.utm_term),
      visits: count(r.visits, "visits", i),
      signups: count(r.signups, "signups", i),
      purchases: count(r.purchases, "purchases", i),
    };
  });
}

export const MAX_AGGREGATE_DAYS = 92;

export interface FirstPartyOptions {
  baseUrl: string;
  token: string;
  fetch?: FetchLike;
  signal?: AbortSignal;
  timeoutMs?: number;
}

export function aggregateUrl(baseUrl: string, from: string, to: string): string {
  const u = new URL("/api/marketing/aggregate", baseUrl);
  u.searchParams.set("from", from);
  u.searchParams.set("to", to);
  return u.toString();
}

export async function fetchFirstPartyAggregate(opts: FirstPartyOptions, from: string, to: string): Promise<AggregateRow[]> {
  if (!opts.token) throw new Error("Add the first-party analytics token first.");
  const days = (Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000 + 1;
  if (!Number.isFinite(days) || days < 1 || days > MAX_AGGREGATE_DAYS) throw new Error(`date range must be 1–${MAX_AGGREGATE_DAYS} days`);
  const res = await httpRequest(aggregateUrl(opts.baseUrl, from, to), {
    headers: { Authorization: `Bearer ${opts.token}`, Accept: "application/json" },
    fetch: opts.fetch,
    signal: opts.signal,
    timeoutMs: opts.timeoutMs,
  });
  if (res.status !== 200) throw new ProviderHttpError(res.status, res.json ?? res.text, `first-party aggregate failed (${res.status})`);
  return parseAggregateResponse(res.json);
}
