import type { Db } from "@mkt/db";
import { BRAVE_SECRET, EXA_SECRET } from "../cost/subscriptions.ts";
import { resolveSecret } from "../security/vault.ts";
import type { FetchText } from "./types.ts";

/**
 * Web search for research when it runs on OpenRouter, which has no server-side search tool.
 * Exa first, then Brave, whichever the workspace has a key for (vault, then env).
 */

export interface SearchHit {
  title: string;
  url: string;
  snippet: string;
}

export type WebSearch = (query: string) => Promise<SearchHit[]>;

export type PostJson = (url: string, init: { headers: Record<string, string>; body: string }) => Promise<{ status: number; text: string }>;

const defaultPost: PostJson = async (url, init) => {
  const res = await fetch(url, { method: "POST", headers: { "content-type": "application/json", ...init.headers }, body: init.body, signal: AbortSignal.timeout(20_000) });
  return { status: res.status, text: await res.text() };
};

const RESULTS = 8;
const clip = (s: unknown, n = 500) => (typeof s === "string" ? s.replace(/\s+/g, " ").trim().slice(0, n) : "");

export function exaSearch(apiKey: string, post: PostJson = defaultPost): WebSearch {
  return async (query) => {
    const res = await post("https://api.exa.ai/search", {
      headers: { "x-api-key": apiKey },
      body: JSON.stringify({ query, numResults: RESULTS, type: "auto", contents: { text: { maxCharacters: 600 } } }),
    });
    if (res.status >= 400) throw new Error(`Exa search failed (${res.status})`);
    const results = (JSON.parse(res.text) as { results?: { title?: string; url?: string; text?: string }[] }).results ?? [];
    return results.filter((r) => r.url).map((r) => ({ title: clip(r.title, 200), url: r.url!, snippet: clip(r.text) }));
  };
}

export function braveSearch(apiKey: string, fetchText: FetchText): WebSearch {
  return async (query) => {
    const res = await fetchText(`https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}&count=${RESULTS}`, {
      headers: { accept: "application/json", "x-subscription-token": apiKey },
      timeoutMs: 15_000,
      maxBytes: 2_000_000,
    });
    if (res.status >= 400) throw new Error(`Brave search failed (${res.status})`);
    const results = (JSON.parse(res.text) as { web?: { results?: { title?: string; url?: string; description?: string }[] } }).web?.results ?? [];
    return results.filter((r) => r.url).map((r) => ({ title: clip(r.title, 200), url: r.url!, snippet: clip(r.description?.replace(/<[^>]+>/g, "")) }));
  };
}

/** Null when neither key is set. */
export async function resolveWebSearch(
  db: Db,
  workspaceId: string,
  deps: { fetchText: FetchText; post?: PostJson; env?: NodeJS.ProcessEnv },
): Promise<WebSearch | null> {
  const opts = deps.env ? { env: deps.env } : {};
  const exa = await resolveSecret(db, workspaceId, EXA_SECRET, "EXA_API_KEY", opts);
  if (exa) return exaSearch(exa, deps.post);
  const brave = await resolveSecret(db, workspaceId, BRAVE_SECRET, "BRAVE_API_KEY", opts);
  if (brave) return braveSearch(brave, deps.fetchText);
  return null;
}

/** Page text for the fetch tool: tags, scripts and styles out, whitespace collapsed, capped. */
export function pageText(html: string, max = 20_000): string {
  return html
    .replace(/<(script|style|noscript|svg)[\s\S]*?<\/\1>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);
}
