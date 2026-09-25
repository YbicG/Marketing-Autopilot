import { and, eq } from "drizzle-orm";
import { schema, uuidv7, type Db } from "@mkt/db";
import { commitEvents, ctxOf, type PublishDeps } from "./due.ts";
import { loadPost, type Actor } from "./store.ts";
import { localDay } from "./time.ts";

const { assistedTasks, auditLog } = schema;

type Deps = Pick<PublishDeps, "db" | "gateway" | "graceMin" | "now" | "scheduleAnalytics" | "notify">;

function checkUrl(url: string): string {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    throw new Error("Paste the link to the live post.");
  }
  if (u.protocol !== "https:" && u.protocol !== "http:") throw new Error("Paste the link to the live post.");
  return u.toString();
}

/**
 * "Download & post yourself" (§5.8 step 10): the person posted it by hand and pastes the URL.
 * Nothing was sent by us, so this works from any state before submitting (and from failed).
 */
export async function markManualPosted(deps: Deps, workspaceId: string, postId: string, url: string, actor: Actor) {
  const post = await loadPost(deps.db, workspaceId, postId);
  if (!post) throw new Error("Post not found");
  return commitEvents(deps, post, [{ type: "posted_manually", url: checkUrl(url) }], ctxOf(deps), actor);
}

/** TikTok drafts mode / inbox fallback: the person finished it in the TikTok app. */
export async function markTikTokDraftDone(deps: Deps, workspaceId: string, postId: string, url: string | undefined, actor: Actor) {
  const post = await loadPost(deps.db, workspaceId, postId);
  if (!post) throw new Error("Post not found");
  return commitEvents(deps, post, [{ type: "user_done", ...(url ? { url: checkUrl(url) } : {}) }], ctxOf(deps), actor);
}

// ── Copy & open (assisted venues, §5.8 step 9) ──

/**
 * Deep links carry content only: no tracking beyond the UTM already in `url`, no votes, no
 * account data. null = the venue has no prefill link; the card copies the text and opens the venue.
 */
export function assistedDeepLink(venue: string, p: { url?: string; title?: string; text?: string; subreddit?: string }): string | null {
  const q = (params: Record<string, string | undefined>) =>
    Object.entries(params)
      .filter((e): e is [string, string] => !!e[1])
      .map(([k, v]) => `${k}=${encodeURIComponent(v)}`)
      .join("&");
  switch (venue) {
    case "reddit": {
      const sub = p.subreddit?.replace(/^\/?r\//, "").replace(/[^A-Za-z0-9_]/g, "");
      const base = sub ? `https://www.reddit.com/r/${sub}/submit` : "https://www.reddit.com/submit";
      return `${base}?${q(p.url ? { url: p.url, title: p.title } : { title: p.title, text: p.text })}`;
    }
    case "hackernews":
      return `https://news.ycombinator.com/submitlink?${q({ u: p.url, t: p.title })}`;
    default:
      return null;
  }
}

/** Rules were checked "today" in the workspace's time zone. */
export function rulesCheckedToday(task: { rulesCheckedByHumanAt: Date | null }, now: Date, tz: string): boolean {
  return !!task.rulesCheckedByHumanAt && localDay(task.rulesCheckedByHumanAt, tz) === localDay(now, tz);
}

/** The human opened the venue's rules and ticked "checked today". Only a person can tick it. */
export async function markRulesChecked(db: Db, workspaceId: string, taskId: string, userId: string, now = new Date()) {
  const [row] = await db
    .update(assistedTasks)
    .set({ rulesCheckedByHumanAt: now })
    .where(and(eq(assistedTasks.id, taskId), eq(assistedTasks.workspaceId, workspaceId)))
    .returning();
  if (!row) throw new Error("Task not found");
  await db.insert(auditLog).values({
    id: uuidv7(),
    workspaceId,
    actorType: "user",
    actorId: userId,
    action: "assisted.rules_checked",
    entity: `assisted_task:${taskId}`,
  });
  return row;
}

/** Mark an assisted task posted. Venues with rules need today's human tick first. */
export async function markAssistedPosted(
  db: Db,
  workspaceId: string,
  taskId: string,
  url: string,
  opts: { userId: string; tz: string; now?: Date },
) {
  const now = opts.now ?? new Date();
  const [task] = await db
    .select()
    .from(assistedTasks)
    .where(and(eq(assistedTasks.id, taskId), eq(assistedTasks.workspaceId, workspaceId)));
  if (!task) throw new Error("Task not found");
  if ((task.rulesUrl || task.rulesSnapshot) && !rulesCheckedToday(task, now, opts.tz)) {
    throw new Error("Open the community's rules and tick \"checked today\" first.");
  }
  const [row] = await db
    .update(assistedTasks)
    .set({ postedUrl: checkUrl(url), status: "done" })
    .where(eq(assistedTasks.id, taskId))
    .returning();
  await db.insert(auditLog).values({
    id: uuidv7(),
    workspaceId,
    actorType: "user",
    actorId: opts.userId,
    action: "assisted.posted",
    entity: `assisted_task:${taskId}`,
    data: { url: row!.postedUrl },
  });
  return row!;
}
