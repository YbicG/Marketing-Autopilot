import { and, desc, eq, gte, inArray } from "drizzle-orm";
import type { SubredditKitBody } from "@mkt/contracts";
import { schema, uuidv7, type Db } from "@mkt/db";
import { RULES_MAX_AGE_DAYS, assistedDeepLink, type FetchRules, type VenueRules } from "../../engine/copy.ts";
import { withUtm } from "../../publishing/links.ts";
import { zonedTime } from "../../publishing/zoned.ts";

const { assistedTasks } = schema;

// Subreddit drafts as Copy & open tasks (§5.8 step 9): rules snapshotted (≤7 days), deep link with
// content only, and the human still ticks "I checked the rules today" on the task before posting.

const RULES_MAX_CHARS = 12_000;
export const redditVenue = (sub: string) => `reddit/${sub}`;

/** The newest snapshot of a community's rules no older than 7 days, or a fresh fetch (null if it fails). */
export async function communityRules(
  db: Db,
  workspaceId: string,
  sub: string,
  fetchRules: FetchRules | undefined,
  now: Date,
): Promise<VenueRules | null> {
  const cached = await cachedRules(db, workspaceId, sub, now);
  if (cached) return cached;
  if (!fetchRules) return null;
  try {
    const r = await fetchRules("reddit", sub);
    return { ...r, text: r.text.slice(0, RULES_MAX_CHARS) };
  } catch {
    return null;
  }
}

async function cachedRules(db: Db, workspaceId: string, sub: string, now: Date): Promise<VenueRules | null> {
  const fresh = new Date(now.getTime() - RULES_MAX_AGE_DAYS * 86_400_000);
  const [row] = await db
    .select()
    .from(assistedTasks)
    .where(and(eq(assistedTasks.workspaceId, workspaceId), eq(assistedTasks.venue, redditVenue(sub)), gte(assistedTasks.rulesFetchedAt, fresh)))
    .orderBy(desc(assistedTasks.rulesFetchedAt))
    .limit(1);
  return row?.rulesSnapshot && row.rulesFetchedAt ? { url: row.rulesUrl, text: row.rulesSnapshot, fetchedAt: row.rulesFetchedAt } : null;
}

/** The post as the human pastes it: {{link:landing}} becomes the tracking link (or is dropped without a site). */
export function assistedBody(body: string, site: string | null, campaign: string, sub: string): string {
  const url = site ? safeUtm(site, { utm_source: "reddit", utm_medium: "community", utm_campaign: campaign, utm_content: sub.toLowerCase() }) : null;
  return body
    .replace(/\{\{\s*link:landing\s*\}\}/g, url ?? "")
    .replace(/[ \t]{2,}/g, " ")
    .trim();
}

function safeUtm(site: string, utm: Record<string, string>): string | null {
  try {
    return withUtm(site, utm);
  } catch {
    return null;
  }
}

export interface SyncInput {
  productId: string;
  site: string | null;
  campaign: string;
  /** ISO date the posts are due; 10:00 local in `timezone`. */
  dueDate: string;
  timezone: string;
  rules: ReadonlyMap<string, VenueRules | null>;
}

/**
 * One assisted_tasks row per draft: open tasks are updated in place, done/skipped ones are left
 * alone and replaced. Returns the body with the task ids filled in.
 */
export async function syncSubredditTasks(db: Db, workspaceId: string, body: SubredditKitBody, input: SyncInput, now: Date): Promise<SubredditKitBody> {
  let dueAt: Date | null = null;
  try {
    dueAt = zonedTime(input.dueDate, "10:00", input.timezone);
  } catch {
    dueAt = null;
  }
  const existingIds = body.drafts.map((d) => d.assistedTaskId).filter((x): x is string => !!x);
  const existing = existingIds.length
    ? await db.select().from(assistedTasks).where(and(eq(assistedTasks.workspaceId, workspaceId), inArray(assistedTasks.id, existingIds)))
    : [];
  const byId = new Map(existing.map((t) => [t.id, t]));

  const drafts = [];
  for (const d of body.drafts) {
    const text = assistedBody(d.body, input.site, input.campaign, d.subreddit);
    const deepLink = assistedDeepLink("reddit", d.subreddit, { title: d.title, body: text }, input.site);
    const open = d.assistedTaskId ? byId.get(d.assistedTaskId) : undefined;
    if (open && open.status === "todo" && open.venue === redditVenue(d.subreddit)) {
      await db.update(assistedTasks).set({ title: d.title, body: text, deepLink, dueAt }).where(eq(assistedTasks.id, open.id));
      drafts.push(d);
      continue;
    }
    const rules = input.rules.get(d.subreddit) ?? (await cachedRules(db, workspaceId, d.subreddit, now));
    const id = uuidv7();
    await db.insert(assistedTasks).values({
      id,
      workspaceId,
      productId: input.productId,
      venue: redditVenue(d.subreddit),
      title: d.title,
      body: text,
      dueAt,
      rulesUrl: rules?.url ?? d.rulesUrl,
      rulesSnapshot: rules?.text ?? null,
      rulesFetchedAt: rules?.fetchedAt ?? null,
      deepLink,
    });
    drafts.push({ ...d, assistedTaskId: id });
  }
  return { ...body, drafts, assistedTaskIds: drafts.map((d) => d.assistedTaskId!).filter(Boolean) };
}

/** Regenerating a subreddit kit: its open tasks are skipped so the old drafts don't linger in Copy & open. */
export async function skipOpenTasks(db: Db, workspaceId: string, taskIds: readonly string[]): Promise<void> {
  if (!taskIds.length) return;
  await db
    .update(assistedTasks)
    .set({ status: "skipped" })
    .where(and(eq(assistedTasks.workspaceId, workspaceId), inArray(assistedTasks.id, [...taskIds]), eq(assistedTasks.status, "todo")));
}
