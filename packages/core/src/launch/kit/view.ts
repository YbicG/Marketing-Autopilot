import { and, eq, inArray } from "drizzle-orm";
import { KIT_BODY_SCHEMAS, KIT_KINDS, KIT_LABELS, type KitIssue, type KitKind, type LaunchKitBody, type SubredditKitBody } from "@mkt/contracts";
import { schema, type Db } from "@mkt/db";
import { skipOpenTasks, syncSubredditTasks } from "./assisted.ts";
import { disclosuresOk, exportBlocker, kitHasBlock, sanitizeKitStrings, validateKitBody } from "./checks.ts";
import { kitFor, kitInputsFor, loadKitContext, kitPlanFor } from "./context.ts";
import { storeKit } from "./run.ts";

const { launchKits, assistedTasks } = schema;

// Read model and edits for the Launch tab's kit cards (workspace-scoped, plain data out).

export interface KitAssistedTask {
  id: string;
  venue: string;
  title: string | null;
  status: "todo" | "done" | "skipped";
  dueAt: string | null;
  deepLink: string | null;
  rulesUrl: string | null;
  rulesFetchedAt: string | null;
  rulesCheckedByHumanAt: string | null;
  postedUrl: string | null;
}

export interface KitCard {
  id: string;
  kind: KitKind;
  label: string;
  status: "planned" | "generating" | "ready" | "needs_you" | "failed";
  /** The kind's contract body (contracts/launch-kit.ts; ads_export: contracts/ads.ts), or null. */
  body: Record<string, unknown> | null;
  issues: KitIssue[];
  disclosuresOk: boolean;
  needsYouReason: string | null;
  exportAssetId: string | null;
  /** Null when "Download kit" can be pressed; otherwise the plain reason it can't. */
  exportBlockedReason: string | null;
  runId: string | null;
  updatedAt: string;
  /** Subreddit kits: the Copy & open tasks, with the "I checked the rules today" state. */
  assistedTasks: KitAssistedTask[];
}

export interface KitView {
  launchPlanId: string;
  launchDate: string;
  kits: KitCard[];
  /** Kinds with no kit yet (the "Make" buttons). */
  missing: KitKind[];
}

export async function kitView(db: Db, workspaceId: string, launchPlanId: string): Promise<KitView | null> {
  const plan = await kitPlanFor(db, workspaceId, launchPlanId);
  if (!plan) return null;
  const rows = await db.select().from(launchKits).where(and(eq(launchKits.workspaceId, workspaceId), eq(launchKits.launchPlanId, plan.id)));
  const taskIds = rows.flatMap((k) => (k.kind === "subreddit" ? ((k.body as SubredditKitBody | null)?.assistedTaskIds ?? []) : []));
  const tasks = taskIds.length ? await db.select().from(assistedTasks).where(and(eq(assistedTasks.workspaceId, workspaceId), inArray(assistedTasks.id, taskIds))) : [];
  const iso = (d: Date | null) => (d ? d.toISOString() : null);
  const order = new Map(KIT_KINDS.map((k, i) => [k, i]));
  const kits = rows
    .sort((a, b) => order.get(a.kind)! - order.get(b.kind)!)
    .map((k): KitCard => {
      const ids = k.kind === "subreddit" ? ((k.body as SubredditKitBody | null)?.assistedTaskIds ?? []) : [];
      return {
        id: k.id,
        kind: k.kind,
        label: KIT_LABELS[k.kind],
        status: k.status,
        body: k.body,
        issues: k.issues,
        disclosuresOk: k.disclosuresOk,
        needsYouReason: k.needsYouReason,
        exportAssetId: k.exportAssetId,
        exportBlockedReason: k.body ? exportBlocker(k.kind, k.status, k.issues, k.disclosuresOk) : "Nothing to download yet.",
        runId: k.runId,
        updatedAt: k.updatedAt.toISOString(),
        assistedTasks: tasks
          .filter((t) => ids.includes(t.id))
          .map((t) => ({
            id: t.id,
            venue: t.venue,
            title: t.title,
            status: t.status,
            dueAt: iso(t.dueAt),
            deepLink: t.deepLink,
            rulesUrl: t.rulesUrl,
            rulesFetchedAt: iso(t.rulesFetchedAt),
            rulesCheckedByHumanAt: iso(t.rulesCheckedByHumanAt),
            postedUrl: t.postedUrl,
          })),
      };
    });
  const have = new Set(rows.map((k) => k.kind));
  return { launchPlanId: plan.id, launchDate: plan.launchDate, kits, missing: KIT_KINDS.filter((k) => !have.has(k)) };
}

export interface SavedKit {
  status: KitCard["status"];
  issues: KitIssue[];
  disclosuresOk: boolean;
  body: LaunchKitBody;
}

/**
 * UI edits: the body is parsed with its kind's schema, links cleaned, re-checked and disclosures
 * recomputed. Any earlier download is dropped (the files changed). Throws a plain sentence.
 */
export async function saveKitBody(db: Db, workspaceId: string, kitId: string, raw: unknown, userId: string, now = new Date()): Promise<SavedKit | null> {
  const kit = await kitFor(db, workspaceId, kitId);
  if (!kit) return null;
  if (kit.kind === "ads_export") throw new Error("Edit the ads kit on the Ads tab.");
  if (kit.status === "generating" || kit.status === "planned") throw new Error("This kit is still being written. Wait for it to finish.");
  const parsed = KIT_BODY_SCHEMAS[kit.kind].safeParse(raw);
  if (!parsed.success) {
    const i = parsed.error.issues[0]!;
    throw new Error(`Something in the kit isn't filled in right (${i.path.join(" › ") || "kit"}): ${i.message}`);
  }
  if (parsed.data.kind !== kit.kind) throw new Error("That's a different kind of kit.");
  const inputs = await kitInputsFor(db, kit);
  const ctx = await loadKitContext(db, kit, inputs, now);
  const clean = sanitizeKitStrings(parsed.data as LaunchKitBody);
  // Ids the model or we set can't be changed from the UI.
  let body: LaunchKitBody = { ...clean.value, lastEditedBy: userId };
  if (body.kind === "subreddit") body = keepTaskIds(body, kit.body as SubredditKitBody | null);
  const issues = [...clean.issues, ...validateKitBody(body, ctx.check)];
  if (body.kind === "subreddit" && !kitHasBlock(issues)) {
    body = await syncSubredditTasks(
      db,
      workspaceId,
      body,
      { productId: kit.productId, site: ctx.build.site, campaign: ctx.build.campaign, dueDate: inputs.subreddit?.dueDate ?? ctx.plan.launchDate, timezone: ctx.timezone, rules: new Map() },
      now,
    );
  }
  if (body.kind === "subreddit") {
    const keep = new Set(body.assistedTaskIds);
    await skipOpenTasks(db, workspaceId, ((kit.body as SubredditKitBody | null)?.assistedTaskIds ?? []).filter((id) => !keep.has(id)));
  }
  await storeKit(db, kit.id, body, issues, now, { exportAssetId: null });
  return { status: kitHasBlock(issues) ? "needs_you" : "ready", issues, disclosuresOk: disclosuresOk(issues), body };
}

function keepTaskIds(body: SubredditKitBody, old: SubredditKitBody | null): SubredditKitBody {
  const known = new Map((old?.drafts ?? []).map((d) => [d.subreddit.toLowerCase(), d.assistedTaskId]));
  const drafts = body.drafts.map((d) => ({ ...d, assistedTaskId: known.get(d.subreddit.toLowerCase()) ?? null }));
  return { ...body, drafts, assistedTaskIds: drafts.map((d) => d.assistedTaskId).filter((x): x is string => !!x) };
}
