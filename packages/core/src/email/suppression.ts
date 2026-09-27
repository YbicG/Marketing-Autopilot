import { and, desc, eq, ne, sql } from "drizzle-orm";
import { schema, uuidv7, type Db } from "@mkt/db";
import type { ProviderCtx, ResendProvider } from "@mkt/providers";
import type { DbOrTx } from "../publishing/store.ts";
import { hashEmail } from "./hash.ts";

const { emailBroadcasts, emailSuppressions, webhookEvents } = schema;

export type SuppressionReason = "unsubscribed" | "bounced" | "complained" | "manual";

/** Stores only sha256(lower(trim(email))). Idempotent per workspace + address. */
export async function recordSuppression(db: DbOrTx, workspaceId: string, email: string, reason: SuppressionReason, source: string): Promise<boolean> {
  return recordSuppressionHash(db, workspaceId, hashEmail(email), reason, source);
}

export async function recordSuppressionHash(db: DbOrTx, workspaceId: string, emailHash: string, reason: SuppressionReason, source: string): Promise<boolean> {
  if (!/^[0-9a-f]{64}$/.test(emailHash)) throw new Error("not an email hash");
  const rows = await db
    .insert(emailSuppressions)
    .values({ id: uuidv7(), workspaceId, emailHash, reason, source })
    .onConflictDoNothing({ target: [emailSuppressions.workspaceId, emailSuppressions.emailHash] })
    .returning({ id: emailSuppressions.id });
  return rows.length > 0;
}

export async function isSuppressed(db: DbOrTx, workspaceId: string, email: string): Promise<boolean> {
  const [r] = await db
    .select({ id: emailSuppressions.id })
    .from(emailSuppressions)
    .where(and(eq(emailSuppressions.workspaceId, workspaceId), eq(emailSuppressions.emailHash, hashEmail(email))));
  return !!r;
}

/** Never page forever: 500 × 100 = 50k contacts is far past a solo developer's buyer list. */
const MAX_PAGES = 500;

export interface EnforceResult {
  checked: number;
  /** Contacts we marked unsubscribed at Resend because they're on our suppression list. */
  unsubscribed: number;
  /** Contacts already unsubscribed at Resend that we added to our own list. */
  learned: number;
}

/**
 * "Suppression list checked before every send" (§5.4): page the audience's contacts; anyone whose
 * hash is suppressed but still subscribed at Resend is unsubscribed there before the broadcast is
 * created. Contacts Resend already has as unsubscribed are copied into our list, so they stay
 * suppressed if the list is ever re-imported.
 */
export async function enforceSuppressions(
  provider: Pick<ResendProvider, "listContacts" | "updateContact">,
  ctx: ProviderCtx,
  audienceId: string,
  db: Db,
  workspaceId: string,
): Promise<EnforceResult> {
  const rows = await db.select({ h: emailSuppressions.emailHash }).from(emailSuppressions).where(eq(emailSuppressions.workspaceId, workspaceId));
  const suppressed = new Set(rows.map((r) => r.h));
  const out: EnforceResult = { checked: 0, unsubscribed: 0, learned: 0 };
  let after: string | null = null;
  for (let page = 0; page < MAX_PAGES; page++) {
    const p = await provider.listContacts(ctx, audienceId, { after, limit: 100 });
    for (const c of p.contacts) {
      out.checked++;
      const h = hashEmail(c.email);
      if (c.unsubscribed) {
        if (!suppressed.has(h) && (await recordSuppressionHash(db, workspaceId, h, "unsubscribed", "resend"))) out.learned++;
        suppressed.add(h);
      } else if (suppressed.has(h)) {
        await provider.updateContact(ctx, c.id, { unsubscribed: true });
        out.unsubscribed++;
      }
    }
    if (!p.hasMore || !p.next) return out;
    after = p.next;
  }
  throw new Error("Your Resend list is too long to check before sending. Split it and try again.");
}

// ── webhook counts (spam-rate rule) ──

export interface BroadcastStats {
  sent: number;
  delivered: number;
  bounced: number;
  complained: number;
  opened: number;
  clicked: number;
}

/** Counts of stored Resend webhooks for one Resend broadcast id (each row is one recipient event). */
export async function broadcastStats(db: DbOrTx, resendBroadcastId: string): Promise<BroadcastStats> {
  const rows = await db
    .select({ type: webhookEvents.type, n: sql<number>`count(*)::int` })
    .from(webhookEvents)
    .where(and(eq(webhookEvents.provider, "resend"), sql`(${webhookEvents.body}::jsonb ->> 'broadcastId') = ${resendBroadcastId}`))
    .groupBy(webhookEvents.type);
  const by = new Map(rows.map((r) => [r.type, Number(r.n)]));
  return {
    sent: by.get("email.sent") ?? 0,
    delivered: by.get("email.delivered") ?? 0,
    bounced: by.get("email.bounced") ?? 0,
    complained: by.get("email.complained") ?? 0,
    opened: by.get("email.opened") ?? 0,
    clicked: by.get("email.clicked") ?? 0,
  };
}

/** The product's most recent sent broadcast other than `exceptId`, with its counts. */
export async function previousBroadcastStats(db: DbOrTx, workspaceId: string, productId: string, exceptId: string): Promise<(BroadcastStats & { broadcastId: string }) | null> {
  const [prev] = await db
    .select({ id: emailBroadcasts.id, resendId: emailBroadcasts.resendBroadcastId })
    .from(emailBroadcasts)
    .where(
      and(
        eq(emailBroadcasts.workspaceId, workspaceId),
        eq(emailBroadcasts.productId, productId),
        eq(emailBroadcasts.status, "sent"),
        ne(emailBroadcasts.id, exceptId),
      ),
    )
    .orderBy(desc(emailBroadcasts.sentAt), desc(emailBroadcasts.id))
    .limit(1);
  if (!prev?.resendId) return null;
  return { broadcastId: prev.id, ...(await broadcastStats(db, prev.resendId)) };
}
