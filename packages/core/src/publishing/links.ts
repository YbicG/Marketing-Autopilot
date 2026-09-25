import { and, desc, eq, isNotNull } from "drizzle-orm";
import { schema, uuidv7, type Db } from "@mkt/db";
import type { DbOrTx } from "./store.ts";
import { isoWeek } from "./time.ts";

const { angles, bioLinks, products, socialConnections, strategies, trackedLinks } = schema;

/** The short campaign id in utm_campaign: the random tail of the UUIDv7 (its head is a timestamp). */
export function shortId(id: string): string {
  return id.replaceAll("-", "").slice(-8);
}

export interface UtmInput {
  platform: string;
  productSlug: string;
  campaignId: string;
  variantId: string;
  angleId: string | null;
}

/** §5.8 step 2: plain UTM links (D11). No redirect service. */
export function buildUtm(i: UtmInput): Record<string, string> {
  return {
    utm_source: i.platform,
    utm_medium: "organic",
    utm_campaign: `${i.productSlug}-${shortId(i.campaignId)}`,
    utm_content: i.variantId,
    ...(i.angleId ? { utm_term: i.angleId } : {}),
  };
}

export function withUtm(url: string, utm: Record<string, string>): string {
  const u = new URL(url);
  for (const [k, v] of Object.entries(utm)) u.searchParams.set(k, v);
  return u.toString();
}

export const LINK_TOKEN = /\{\{\s*link:([a-z0-9_-]+)\s*\}\}/gi;
const RAW_URL = /\bhttps?:\/\/[^\s)]+/gi;

export interface ResolvedLinks {
  text: string;
  links: { token: string; url: string }[];
  /** Blocking: unknown token, or a link with no website to point at. */
  problems: string[];
  /** Warn (D20): raw URLs typed into the text instead of a link token. */
  warnings: string[];
}

/**
 * Replace `{{link:landing}}` with the tracking link. Where the platform has no clickable caption
 * links (caps.links = bio_only), the token becomes "link in bio" and the bio link carries the tracking.
 */
export function resolveLinkTokens(
  text: string,
  opts: { landingUrl: string | null; utm: Record<string, string>; links: "clickable" | "bio_only" | "addon"; linksAllowed?: boolean },
): ResolvedLinks {
  const links: ResolvedLinks["links"] = [];
  const problems: string[] = [];
  const clickable = opts.links === "clickable" || (opts.links === "addon" && opts.linksAllowed === true);
  const raw = text.replace(LINK_TOKEN, "").match(RAW_URL) ?? [];
  const out = text.replace(LINK_TOKEN, (_m, name: string) => {
    const token = name.toLowerCase();
    if (token !== "landing") {
      problems.push(`Unknown link "${name}". Only your website link can go in a post.`);
      return "";
    }
    if (!opts.landingUrl) {
      problems.push("Add your website address to this product so the post's link has somewhere to go.");
      return "";
    }
    if (!clickable) return "link in bio";
    const url = withUtm(opts.landingUrl, opts.utm);
    links.push({ token, url });
    return url;
  });
  return {
    text: out,
    links,
    problems,
    warnings: raw.length ? ["This post has a link typed in by hand; it won't be tracked."] : [],
  };
}

export async function recordTrackedLinks(
  db: DbOrTx,
  p: { workspaceId: string; productId: string; variantId: string; utm: Record<string, string> },
  links: { token: string; url: string }[],
): Promise<void> {
  for (const l of links) {
    const [existing] = await db
      .select({ id: trackedLinks.id })
      .from(trackedLinks)
      .where(and(eq(trackedLinks.variantId, p.variantId), eq(trackedLinks.url, l.url)));
    if (existing) continue;
    await db.insert(trackedLinks).values({
      id: uuidv7(),
      workspaceId: p.workspaceId,
      productId: p.productId,
      variantId: p.variantId,
      token: l.token,
      url: l.url,
      utm: p.utm,
    });
  }
}

/**
 * D11 bio link for one account and week: utm_content (and utm_term) = the lead angle, so signups
 * from "link in bio" land on the angle that account is leading with this week.
 */
export function bioLinkUrl(landingUrl: string, platform: string, productSlug: string, angleId: string): string {
  return withUtm(landingUrl, {
    utm_source: platform,
    utm_medium: "organic",
    utm_campaign: `${productSlug}-bio`,
    utm_content: angleId,
    utm_term: angleId,
  });
}

/**
 * Weekly rotation (D11). The lead angle is the caller's pick per product (e.g. the Results v0
 * leader) or else the product's active angle with the biggest share. Idempotent per (connection, week).
 */
export async function rotateBioLinks(
  db: Db,
  workspaceId: string,
  opts: { now?: Date; tz: string; leadAngle?: (productId: string) => Promise<string | null> },
): Promise<{ connectionId: string; week: string; url: string; created: boolean }[]> {
  const now = opts.now ?? new Date();
  const week = isoWeek(now, opts.tz);
  const conns = await db
    .select({ conn: socialConnections, product: products })
    .from(socialConnections)
    .innerJoin(products, eq(products.id, socialConnections.productId))
    .where(and(eq(socialConnections.workspaceId, workspaceId), eq(socialConnections.status, "active"), isNotNull(socialConnections.productId)));
  const out: { connectionId: string; week: string; url: string; created: boolean }[] = [];
  const leadCache = new Map<string, string | null>();
  for (const { conn, product } of conns) {
    if (!product.urls.website) continue;
    if (!leadCache.has(product.id)) {
      leadCache.set(product.id, (await opts.leadAngle?.(product.id)) ?? (await defaultLeadAngle(db, workspaceId, product.id)));
    }
    const angleId = leadCache.get(product.id);
    if (!angleId) continue;
    const url = bioLinkUrl(product.urls.website, conn.platform, product.slug, angleId);
    const [row] = await db
      .insert(bioLinks)
      .values({ id: uuidv7(), workspaceId, connectionId: conn.id, week, angleId, url, utmContent: angleId })
      .onConflictDoNothing({ target: [bioLinks.connectionId, bioLinks.week] })
      .returning({ id: bioLinks.id });
    const [cur] = row ? [{ url }] : await db.select({ url: bioLinks.url }).from(bioLinks).where(and(eq(bioLinks.connectionId, conn.id), eq(bioLinks.week, week)));
    out.push({ connectionId: conn.id, week, url: cur!.url, created: !!row });
  }
  return out;
}

async function defaultLeadAngle(db: Db, workspaceId: string, productId: string): Promise<string | null> {
  const [s] = await db
    .select({ id: strategies.id })
    .from(strategies)
    .where(and(eq(strategies.workspaceId, workspaceId), eq(strategies.productId, productId)))
    .orderBy(desc(strategies.createdAt))
    .limit(1);
  if (!s) return null;
  const [a] = await db
    .select({ id: angles.id })
    .from(angles)
    .where(and(eq(angles.strategyId, s.id), eq(angles.status, "active")))
    .orderBy(desc(angles.sharePct), angles.idx)
    .limit(1);
  return a?.id ?? null;
}
