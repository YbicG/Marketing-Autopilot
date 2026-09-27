import { and, desc, eq, inArray, ne } from "drizzle-orm";
import { KitInputs, KitKind } from "@mkt/contracts";
import { schema, type Db } from "@mkt/db";
import type { KitFileCtx } from "./export.ts";

const { launchPlans, launchKits, generationRuns } = schema;

// Small reads for the launch kit pages (web /p/[slug]/launch/kits): which plan the kits belong to,
// and what the user typed last time so "Write it again" starts from it.

export interface KitPlanRef {
  id: string;
  launchDate: string;
  status: "draft" | "active" | "done";
}

/** The product's active launch plan, else its newest draft. Finished plans don't take new kits. */
export async function kitPlanForProduct(db: Db, workspaceId: string, productId: string): Promise<KitPlanRef | null> {
  const cols = { id: launchPlans.id, launchDate: launchPlans.launchDate, status: launchPlans.status };
  const scope = and(eq(launchPlans.workspaceId, workspaceId), eq(launchPlans.productId, productId));
  const [active] = await db.select(cols).from(launchPlans).where(and(scope, eq(launchPlans.status, "active"))).orderBy(desc(launchPlans.createdAt)).limit(1);
  if (active) return active;
  const [draft] = await db.select(cols).from(launchPlans).where(and(scope, ne(launchPlans.status, "done"))).orderBy(desc(launchPlans.createdAt)).limit(1);
  return draft ?? null;
}

/** Each kit's inputs from its own last run, merged into one KitInputs (invalid leftovers are dropped). */
export async function lastKitInputs(db: Db, workspaceId: string, launchPlanId: string): Promise<KitInputs> {
  const kits = await db
    .select({ kind: launchKits.kind, runId: launchKits.runId })
    .from(launchKits)
    .where(and(eq(launchKits.workspaceId, workspaceId), eq(launchKits.launchPlanId, launchPlanId)));
  const runIds = [...new Set(kits.map((k) => k.runId).filter((x): x is string => !!x))];
  if (!runIds.length) return {};
  const runs = await db
    .select({ id: generationRuns.id, input: generationRuns.input })
    .from(generationRuns)
    .where(and(eq(generationRuns.workspaceId, workspaceId), inArray(generationRuns.id, runIds)));
  const byRun = new Map(runs.map((r) => [r.id, r.input]));
  const out: KitInputs = {};
  for (const k of kits) {
    const kind = KitKind.safeParse(k.kind);
    if (!kind.success || !k.runId) continue;
    const inputs = (byRun.get(k.runId)?.inputs ?? {}) as Record<string, unknown>;
    if (inputs[kind.data] === undefined) continue;
    const one = KitInputs.safeParse({ [kind.data]: inputs[kind.data] });
    if (one.success) Object.assign(out, one.data);
  }
  return out;
}

/** Link context for showing kit text on screen the way the download writes it (same as loadKitContext). */
export function kitFileCtxFor(product: { name: string; slug: string; urls: { website?: string | null } }, launchDate: string): KitFileCtx {
  return { productName: product.name, site: product.urls.website ?? null, campaign: `${product.slug}-launch`, launchDate };
}
