import { and, asc, eq, ne } from "drizzle-orm";
import { schema, uuidv7, type Db } from "@mkt/db";
import type { AccountHealth } from "@mkt/providers";

const { products, socialConnections } = schema;

type Publisher = (typeof socialConnections.$inferSelect)["publisher"];
export type ConnectionStatus = (typeof socialConnections.$inferSelect)["status"];

/** §2.3 Where to post: personal X/Bluesky/LinkedIn accounts serve every product, so they share one cap. */
export const SHARED_PLATFORMS: ReadonlySet<string> = new Set(["x", "bluesky", "linkedin"]);

export async function listProducts(db: Db, workspaceId: string) {
  return db
    .select({ id: products.id, slug: products.slug, name: products.name, status: products.status })
    .from(products)
    .where(eq(products.workspaceId, workspaceId))
    .orderBy(asc(products.createdAt));
}

export interface ConnectionView {
  id: string;
  productId: string | null;
  productName: string | null;
  publisher: Publisher;
  platform: string;
  handle: string | null;
  profileRef: string;
  shared: boolean;
  maxPerDay: number;
  status: ConnectionStatus;
  tokenExpiresAt: Date | null;
  lastHealthAt: Date | null;
  createdAt: Date;
}

/** The health list on Settings → Where to post. */
export async function listConnections(db: Db, workspaceId: string): Promise<ConnectionView[]> {
  return db
    .select({
      id: socialConnections.id,
      productId: socialConnections.productId,
      productName: products.name,
      publisher: socialConnections.publisher,
      platform: socialConnections.platform,
      handle: socialConnections.handle,
      profileRef: socialConnections.profileRef,
      shared: socialConnections.shared,
      maxPerDay: socialConnections.maxPerDay,
      status: socialConnections.status,
      tokenExpiresAt: socialConnections.tokenExpiresAt,
      lastHealthAt: socialConnections.lastHealthAt,
      createdAt: socialConnections.createdAt,
    })
    .from(socialConnections)
    .leftJoin(products, eq(products.id, socialConnections.productId))
    .where(eq(socialConnections.workspaceId, workspaceId))
    .orderBy(asc(products.name), asc(socialConnections.platform));
}

function validDate(s: string | undefined): Date | null {
  if (!s) return null;
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** Same rule as the worker's health job: an active account whose token already expired needs reconnecting. */
function statusFor(h: AccountHealth, expires: Date | null, now: Date): ConnectionStatus {
  return h.status === "active" && expires !== null && expires <= now ? "reauth_required" : h.status;
}

export interface SyncInput {
  productId: string;
  publisher: Publisher;
  profileRef: string;
  health: AccountHealth[];
  now?: Date;
}

/**
 * After a hosted connect link returns: upsert one row per account the publisher reports for this
 * profile. New rows get the shared flag for personal platforms; an existing row keeps the user's
 * max-per-day and shared choices. Rows the publisher no longer lists need a reconnect.
 */
export async function syncConnections(db: Db, workspaceId: string, input: SyncInput): Promise<{ upserted: number; missing: number }> {
  const now = input.now ?? new Date();
  const [product] = await db
    .select({ id: products.id })
    .from(products)
    .where(and(eq(products.workspaceId, workspaceId), eq(products.id, input.productId)));
  if (!product) throw new Error("syncConnections: product not in this workspace");

  const seen = new Set<string>();
  let upserted = 0;
  const missing = await db.transaction(async (tx) => {
    for (const h of input.health) {
      if (seen.has(h.platform)) continue;
      seen.add(h.platform);
      const expires = validDate(h.tokenExpiresAt);
      const status = statusFor(h, expires, now);
      await tx
        .insert(socialConnections)
        .values({
          id: uuidv7(),
          workspaceId,
          productId: input.productId,
          publisher: input.publisher,
          platform: h.platform,
          handle: h.handle ?? null,
          profileRef: input.profileRef,
          shared: SHARED_PLATFORMS.has(h.platform),
          status,
          tokenExpiresAt: expires,
          lastHealthAt: now,
        })
        .onConflictDoUpdate({
          target: [socialConnections.workspaceId, socialConnections.publisher, socialConnections.platform, socialConnections.profileRef],
          set: {
            status,
            tokenExpiresAt: expires,
            lastHealthAt: now,
            productId: input.productId,
            ...(h.handle ? { handle: h.handle } : {}),
          },
        });
      upserted++;
    }

    const existing = await tx
      .select({ id: socialConnections.id, platform: socialConnections.platform })
      .from(socialConnections)
      .where(
        and(
          eq(socialConnections.workspaceId, workspaceId),
          eq(socialConnections.publisher, input.publisher),
          eq(socialConnections.profileRef, input.profileRef),
          ne(socialConnections.status, "revoked"),
        ),
      );
    const gone = existing.filter((r) => !seen.has(r.platform));
    for (const row of gone) {
      await tx
        .update(socialConnections)
        .set({ status: "reauth_required", lastHealthAt: now })
        .where(and(eq(socialConnections.workspaceId, workspaceId), eq(socialConnections.id, row.id)));
    }
    return gone.length;
  });
  return { upserted, missing };
}

/** Max posts per day (1–3, the DB check) and the shared flag, edited on the health list. */
export async function updateConnectionLimits(
  db: Db,
  workspaceId: string,
  id: string,
  patch: { maxPerDay?: number; shared?: boolean },
): Promise<boolean> {
  if (patch.maxPerDay !== undefined && (!Number.isInteger(patch.maxPerDay) || patch.maxPerDay < 1 || patch.maxPerDay > 3)) {
    throw new Error("maxPerDay must be 1, 2 or 3");
  }
  const set = {
    ...(patch.maxPerDay !== undefined ? { maxPerDay: patch.maxPerDay } : {}),
    ...(patch.shared !== undefined ? { shared: patch.shared } : {}),
  };
  if (!Object.keys(set).length) return false;
  const rows = await db
    .update(socialConnections)
    .set(set)
    .where(and(eq(socialConnections.workspaceId, workspaceId), eq(socialConnections.id, id)))
    .returning({ id: socialConnections.id });
  return rows.length > 0;
}
