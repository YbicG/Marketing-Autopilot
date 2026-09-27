import { and, eq } from "drizzle-orm";
import { BroadcastSettings, broadcastParagraphs, type EmailIssue } from "@mkt/contracts";
import { schema } from "@mkt/db";
import type { DbOrTx } from "../publishing/store.ts";
import { broadcastHash } from "./hash.ts";
import { broadcastUtm, fromHeader, renderBroadcast, replyToHeader, type EmailSettingsLike, type RenderedBroadcast } from "./render.ts";
import type { BroadcastRow } from "./store.ts";
import { previousBroadcastStats } from "./suppression.ts";
import { validateBroadcast, type EmailClaimInfo } from "./validate.ts";

const { claims, launchPlans, products } = schema;

export type ProductRow = typeof products.$inferSelect;

/** products.email_settings as the editor sees it (jsonb, so extra keys like euConsentAck survive). */
export function settingsOf(product: Pick<ProductRow, "emailSettings">): EmailSettingsLike | null {
  const raw = product.emailSettings as unknown;
  if (!raw || typeof raw !== "object") return null;
  const parsed = BroadcastSettings.partial().safeParse(raw);
  return parsed.success ? parsed.data : (raw as EmailSettingsLike);
}

export async function claimMapFor(db: DbOrTx, product: Pick<ProductRow, "currentDnaVersionId">): Promise<Map<string, EmailClaimInfo>> {
  if (!product.currentDnaVersionId) return new Map();
  const rows = await db.select().from(claims).where(eq(claims.dnaVersionId, product.currentDnaVersionId));
  return new Map(rows.map((c) => [c.ref, { ref: c.ref, kind: c.kind, publicOk: c.publicOk, status: c.status, expiresAt: c.expiresAt }]));
}

export interface BroadcastContext {
  product: ProductRow;
  settings: EmailSettingsLike | null;
  campaignId: string | null;
  claims: Map<string, EmailClaimInfo>;
}

export async function broadcastContext(db: DbOrTx, row: BroadcastRow): Promise<BroadcastContext | null> {
  const [product] = await db
    .select()
    .from(products)
    .where(and(eq(products.id, row.productId), eq(products.workspaceId, row.workspaceId)));
  if (!product) return null;
  const [plan] = row.launchPlanId
    ? await db.select({ campaignId: launchPlans.campaignId }).from(launchPlans).where(eq(launchPlans.id, row.launchPlanId))
    : [];
  return { product, settings: settingsOf(product), campaignId: plan?.campaignId ?? null, claims: await claimMapFor(db, product) };
}

export function renderRow(row: Pick<BroadcastRow, "id" | "subject" | "preheader" | "body">, ctx: BroadcastContext): RenderedBroadcast {
  return renderBroadcast(
    { subject: row.subject, preheader: row.preheader, paragraphs: broadcastParagraphs(row.body) },
    ctx.settings ?? {},
    {
      landingUrl: ctx.product.urls.website ?? null,
      utm: broadcastUtm({ productSlug: ctx.product.slug, campaignId: ctx.campaignId, broadcastId: row.id }),
    },
  );
}

/** Full §8 check of the row as it would be sent. `rendered` adds the footer checks. */
export async function checkRow(
  db: DbOrTx,
  row: BroadcastRow,
  ctx: BroadcastContext,
  now: Date,
  rendered: RenderedBroadcast | null,
): Promise<EmailIssue[]> {
  const prev = await previousBroadcastStats(db, row.workspaceId, row.productId, row.id);
  const issues = validateBroadcast({
    subject: row.subject,
    preheader: row.preheader,
    paragraphs: broadcastParagraphs(row.body),
    claimRefs: row.claimIds,
    settings: ctx.settings,
    audienceId: row.audienceId,
    scheduledAt: row.scheduledAt,
    now,
    claims: ctx.claims,
    rendered: rendered ? { html: rendered.html, text: rendered.text } : null,
    previous: prev ? { delivered: prev.delivered, complained: prev.complained } : null,
  });
  return [...issues, ...(rendered?.problems ?? []).filter((p) => !issues.some((x) => x.code === p.code))];
}

/** The hash an approval of this row covers, from what Resend will receive. Null if it can't be sent yet. */
export function hashRow(row: Pick<BroadcastRow, "subject" | "html" | "text" | "audienceId" | "scheduledAt">, settings: EmailSettingsLike | null): string | null {
  if (!row.html || !row.text || !row.audienceId || !row.scheduledAt || !settings?.fromEmail) return null;
  return broadcastHash({
    subject: row.subject,
    html: row.html,
    text: row.text,
    audienceId: row.audienceId,
    scheduledAt: row.scheduledAt,
    from: fromHeader(settings),
    replyTo: replyToHeader(settings),
  });
}

