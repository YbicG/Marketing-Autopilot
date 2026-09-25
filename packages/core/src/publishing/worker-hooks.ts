import { and, eq, inArray, ne } from "drizzle-orm";
import { schema, type Db } from "@mkt/db";
import { onVariantChanged, voidApproval } from "./approvals.ts";
import { scheduleEffects, type EffectDeps } from "./scheduler.ts";
import type { Actor } from "./store.ts";

const { posts, socialConnections, variants } = schema;
const WORKER: Actor = { type: "worker" };

type ConnectionStatus = "active" | "reauth_required" | "revoked" | "error";

/** Drizzle side of the worker's maint.connections_health (the worker has no drizzle-orm). */
export function dbConnectionStore(db: Db) {
  return {
    async listChecked() {
      return db
        .select({
          id: socialConnections.id,
          workspaceId: socialConnections.workspaceId,
          publisher: socialConnections.publisher,
          platform: socialConnections.platform,
          profileRef: socialConnections.profileRef,
          status: socialConnections.status,
        })
        .from(socialConnections)
        .where(ne(socialConnections.status, "revoked"));
    },
    async update(workspaceId: string, id: string, patch: { status: ConnectionStatus; tokenExpiresAt: Date | null; lastHealthAt: Date; handle?: string }) {
      await db
        .update(socialConnections)
        .set({ status: patch.status, tokenExpiresAt: patch.tokenExpiresAt, lastHealthAt: patch.lastHealthAt, ...(patch.handle ? { handle: patch.handle } : {}) })
        .where(and(eq(socialConnections.workspaceId, workspaceId), eq(socialConnections.id, id)));
    },
  };
}

/**
 * VideoDeps.voidApprovalsFor: a re-render or auto-fix after approval voids every live approval of
 * those variants (§4.3 video item) and removes their delayed jobs.
 */
export function voidApprovalsForVariants(db: Db, effects: EffectDeps, opts: { graceMin?: number } = {}) {
  return async (variantIds: string[], reason: string): Promise<void> => {
    if (!variantIds.length) return;
    const rows = await db
      .select({ id: posts.id, workspaceId: posts.workspaceId })
      .from(posts)
      .where(inArray(posts.variantId, variantIds));
    for (const r of rows) {
      const res = await voidApproval(db, r.workspaceId, r.id, reason, WORKER, opts);
      if (res?.effects.length) await scheduleEffects(effects, r.id, res.effects);
    }
  };
}

/** The engine's onVariantEdited: re-check every post of the variant, then apply the queue effects. */
export function variantEditedHook(db: Db, effects: EffectDeps, opts: { graceMin?: number } = {}) {
  return async (variantId: string): Promise<void> => {
    const [v] = await db.select({ workspaceId: variants.workspaceId }).from(variants).where(eq(variants.id, variantId));
    if (!v) return;
    for (const r of await onVariantChanged(db, v.workspaceId, variantId, WORKER, opts)) await scheduleEffects(effects, r.postId, r.effects);
  };
}
