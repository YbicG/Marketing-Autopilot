import { and, eq, inArray } from "drizzle-orm";
import { schema } from "@mkt/db";
import { canonicalJson } from "./hash.ts";
import type { DbOrTx } from "./store.ts";

const { campaignBundles, campaigns, claims, contentItems, productDnaVersions, products, variants } = schema;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type ClaimRow = typeof claims.$inferSelect;

export interface ClaimRules {
  scheduledAt: Date;
  now: Date;
}

/** §8 claim rules for one claim as it stands now. null = fine. */
export function claimProblem(c: ClaimRow, current: ClaimRow | null | undefined, rules: ClaimRules, onCurrentVersion: boolean): string | null {
  if (c.status === "rejected") return `You rejected a fact this post uses ("${short(c.text)}").`;
  if (!c.publicOk) return `A fact this post uses isn't public ("${short(c.text)}").`;
  if (c.kind === "testimonial" && c.status !== "verified") return `A testimonial this post uses isn't verified yet ("${short(c.text)}").`;
  if (c.expiresAt && c.expiresAt.getTime() < rules.scheduledAt.getTime()) {
    return `A fact this post uses expires before it posts ("${short(c.text)}").`;
  }
  if (!onCurrentVersion) {
    if (!current) return `A fact this post uses was removed from your product profile ("${short(c.text)}").`;
    if (current.text !== c.text) return `A fact this post uses changed in your product profile ("${short(c.text)}").`;
    return claimProblem(current, current, rules, true);
  }
  return null;
}

function short(s: string): string {
  return s.length > 60 ? `${s.slice(0, 57)}...` : s;
}

function getPath(obj: unknown, path: string): unknown {
  let cur: unknown = obj;
  for (const k of path.split(".").filter(Boolean)) {
    if (cur && typeof cur === "object") cur = (cur as Record<string, unknown>)[k];
    else return undefined;
  }
  return cur;
}

/**
 * Why a post's content is no longer safe to publish as approved (§5.8 steps 2 and 6): claims it
 * cites were rejected, aren't public, expire before `scheduledAt`, or changed in a newer profile;
 * or profile fields it used changed. Claim ids may be claim uuids or refs (C1…) of the bundle's DNA version.
 */
export async function contentProblems(db: DbOrTx, variantId: string, rules: ClaimRules): Promise<string[]> {
  const [row] = await db
    .select({ item: contentItems, variant: variants, campaign: campaigns, product: products })
    .from(variants)
    .innerJoin(contentItems, eq(contentItems.id, variants.contentItemId))
    .innerJoin(campaigns, eq(campaigns.id, contentItems.campaignId))
    .innerJoin(products, eq(products.id, campaigns.productId))
    .where(eq(variants.id, variantId));
  if (!row) return ["This post's content is missing."];
  const { item, variant, campaign, product } = row;

  const [bundle] = campaign.bundleId
    ? await db.select().from(campaignBundles).where(eq(campaignBundles.id, campaign.bundleId))
    : [];
  const baseVersionId = bundle?.dnaVersionId ?? product.currentDnaVersionId;
  const currentVersionId = product.currentDnaVersionId;

  const inner = (variant.body.variant ?? variant.body) as Record<string, unknown>;
  const bodyRefs = Array.isArray(inner.claimRefs) ? inner.claimRefs.filter((x): x is string => typeof x === "string") : [];
  const wanted = [...new Set([...item.claimIds, ...bodyRefs])];
  const problems: string[] = [];

  if (wanted.length) {
    const ids = wanted.filter((x) => UUID.test(x));
    const refs = wanted.filter((x) => !UUID.test(x));
    const found: ClaimRow[] = [];
    if (ids.length) found.push(...(await db.select().from(claims).where(and(eq(claims.workspaceId, item.workspaceId), inArray(claims.id, ids)))));
    if (refs.length && baseVersionId) {
      found.push(...(await db.select().from(claims).where(and(eq(claims.dnaVersionId, baseVersionId), inArray(claims.ref, refs)))));
    }
    const missing = wanted.filter((k) => !found.some((c) => c.id === k || c.ref === k));
    if (missing.length) problems.push("A fact this post uses is no longer in your product profile.");

    const oldOnes = found.filter((c) => c.dnaVersionId !== currentVersionId);
    const currentByRef = new Map<string, ClaimRow>();
    if (oldOnes.length && currentVersionId) {
      const cur = await db
        .select()
        .from(claims)
        .where(and(eq(claims.dnaVersionId, currentVersionId), inArray(claims.ref, oldOnes.map((c) => c.ref))));
      for (const c of cur) currentByRef.set(c.ref, c);
    }
    for (const c of found) {
      const onCurrent = !currentVersionId || c.dnaVersionId === currentVersionId;
      const p = claimProblem(c, currentByRef.get(c.ref) ?? null, rules, onCurrent);
      if (p) problems.push(p);
    }
  }

  if (item.dnaFieldsUsed.length && baseVersionId && currentVersionId && baseVersionId !== currentVersionId) {
    const versions = await db
      .select({ id: productDnaVersions.id, dna: productDnaVersions.dna })
      .from(productDnaVersions)
      .where(inArray(productDnaVersions.id, [baseVersionId, currentVersionId]));
    const base = versions.find((v) => v.id === baseVersionId)?.dna;
    const cur = versions.find((v) => v.id === currentVersionId)?.dna;
    if (base && cur) {
      const changed = item.dnaFieldsUsed.filter((p) => canonicalJson(getPath(base, p) ?? null) !== canonicalJson(getPath(cur, p) ?? null));
      if (changed.length) problems.push(`Your product profile changed (${changed.join(", ")}) since this was written.`);
    }
  }
  return [...new Set(problems)];
}
