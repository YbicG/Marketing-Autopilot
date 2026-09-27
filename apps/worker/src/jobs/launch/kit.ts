// launch.kit (generate queue, paid, 1 attempt; §5.4 LC launch kit): write one kit piece. The
// "ads_export" kind is handed to the ads module through deps.adsKit.

import type { FetchRules, VenueRules } from "@mkt/core/engine";
import { executeLaunchKit, type KitDeps } from "@mkt/core/launch";
import type { GenerateJobs } from "@mkt/core/queue";
import { safeFetchText } from "@mkt/core/security";

type RateLookup = KitDeps["rates"];

export interface LaunchKitWorkerDeps {
  db: KitDeps["db"];
  /** Re-read per job so a corrected price applies without a redeploy. */
  rates: () => Promise<RateLookup>;
  client?: KitDeps["client"];
  publish?: KitDeps["publish"];
  /**
   * Community rules for subreddit drafts: `redditRulesFetcher((u, o) => safeFetchText(u, {...o, proxyUrl, selfIps}))`.
   * Without it drafts are written without rules (the human still checks them before posting).
   */
  fetchRules?: FetchRules;
  /** @mkt/core/ads's generator for kind "ads_export" (B4). Without it that kit is Needs you. */
  adsKit?: KitDeps["adsKit"];
}

export async function launchKitJob(deps: LaunchKitWorkerDeps, data: GenerateJobs["launch.kit"]): Promise<void> {
  await executeLaunchKit(
    {
      db: deps.db,
      rates: await deps.rates(),
      ...(deps.client ? { client: deps.client } : {}),
      ...(deps.publish ? { publish: deps.publish } : {}),
      ...(deps.fetchRules ? { fetchRules: deps.fetchRules } : {}),
      ...(deps.adsKit ? { adsKit: deps.adsKit } : {}),
    },
    data,
  );
}

const RULES_MAX_CHARS = 12_000;

/** Reddit's public rules JSON → plain text: "1. Title: description". */
export function redditRulesText(json: unknown): string {
  const rules = (json as { rules?: { short_name?: unknown; description?: unknown }[] } | null)?.rules;
  if (!Array.isArray(rules)) return "";
  return rules
    .map((r, i) => {
      const title = typeof r.short_name === "string" ? r.short_name.trim() : "";
      const desc = typeof r.description === "string" ? r.description.trim().replace(/\s+/g, " ") : "";
      return title || desc ? `${i + 1}. ${title}${desc ? `: ${desc}` : ""}` : "";
    })
    .filter(Boolean)
    .join("\n")
    .slice(0, RULES_MAX_CHARS);
}

type FetchText = (url: string, opts?: Parameters<typeof safeFetchText>[1]) => Promise<{ status: number; text: string }>;

/**
 * Fetches r/<sub>/about/rules.json through safe-fetch (the rules are data, never instructions).
 * Throws when Reddit doesn't answer with rules; the kit then drafts without them and the human
 * still reads the rules page before ticking "I checked the rules today".
 */
export function redditRulesFetcher(fetchText: FetchText = safeFetchText, now: () => Date = () => new Date()): FetchRules {
  return async (venue, community): Promise<VenueRules> => {
    if (venue !== "reddit" || !community) throw new Error("Only subreddit rules can be fetched.");
    const sub = community.replace(/^\/?r\//i, "").replace(/[^A-Za-z0-9_]/g, "");
    const res = await fetchText(`https://www.reddit.com/r/${sub}/about/rules.json`, {
      headers: { "user-agent": "MarketingAutopilot/1.0 (rules check for a human-posted draft)", accept: "application/json" },
      maxBytes: 1_000_000,
      timeoutMs: 10_000,
    });
    if (res.status !== 200) throw new Error(`Reddit answered ${res.status} for r/${sub}'s rules.`);
    let text = "";
    try {
      text = redditRulesText(JSON.parse(res.text));
    } catch {
      text = "";
    }
    if (!text) throw new Error(`No rules came back for r/${sub}.`);
    return { url: `https://www.reddit.com/r/${sub}/about/rules`, text, fetchedAt: now() };
  };
}
