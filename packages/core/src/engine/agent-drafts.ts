import { and, eq } from "drizzle-orm";
import { PLATFORM_LIMITS, type PostFormat, type PostVariant, type SocialPlatform, type TextVariantBody } from "@mkt/contracts";
import { schema, uuidv7, type Db } from "@mkt/db";
import { bundleById } from "./bundle.ts";
import { variantContentHash } from "./hash.ts";
import { latestCampaign } from "./package-options.ts";
import { hasBlock, sanitizeVariant, validateVariant, type ClaimInfo, type CopyIssue } from "./validate.ts";

const { claims, contentItems, variants } = schema;

/** One platform's copy as an agent writes it (create_post_variants, §9). */
export interface AgentPost {
  platform: SocialPlatform;
  /** The post; for a thread, leave empty and pass parts. */
  text: string;
  parts?: string[];
  hashtags?: string[];
  altText?: string | null;
  firstComment?: string | null;
  claimRefs?: string[];
}

export interface AgentDrafts {
  contentItemId: string;
  campaignId: string;
  variants: { variantId: string; platform: SocialPlatform; issues: CopyIssue[] }[];
}

export type AgentDraftsResult = { ok: true; drafts: AgentDrafts } | { ok: false; message: string };

/**
 * An agent's own post or thread, saved as drafts in the product's newest campaign (D9, §9): one
 * content item (slot kind "agent", outside the plan's slots) with a variant per platform, run through
 * the same link, length, jargon and fact checks as generated copy. No posts are made: putting a
 * draft on the calendar is schedule_posts, and approving it is the owner's, in the app.
 */
export async function writeAgentDrafts(
  db: Db,
  workspaceId: string,
  productId: string,
  input: { kind: "post" | "thread"; posts: readonly AgentPost[]; author: string },
  now = new Date(),
): Promise<AgentDraftsResult> {
  const latest = await latestCampaign(db, workspaceId, productId);
  if (!latest) return { ok: false, message: "This product has no campaign yet. Make one in the app first." };
  const { campaign } = latest;
  const bundle = campaign.bundleId ? await bundleById(db, workspaceId, campaign.bundleId) : null;
  if (!bundle) return { ok: false, message: "This campaign isn't ready for new posts yet." };

  const format: PostFormat = input.kind === "thread" ? "thread" : "text";
  const seen = new Set<SocialPlatform>();
  for (const p of input.posts) {
    if (seen.has(p.platform)) return { ok: false, message: `${PLATFORM_LIMITS[p.platform].label} is listed twice.` };
    seen.add(p.platform);
    if (!PLATFORM_LIMITS[p.platform].formats.includes(format)) {
      return { ok: false, message: `${PLATFORM_LIMITS[p.platform].label} doesn't take ${input.kind === "thread" ? "threads" : "text posts"}.` };
    }
  }

  const claimRows = await db.select().from(claims).where(eq(claims.dnaVersionId, bundle.dnaVersionId));
  const claimMap = new Map<string, ClaimInfo>(claimRows.map((c) => [c.ref, { ref: c.ref, kind: c.kind, publicOk: c.publicOk, status: c.status, expiresAt: c.expiresAt }]));

  const checked = input.posts.map((p) => {
    const parts = input.kind === "thread" ? (p.parts ?? []).filter((s) => s.trim()) : [];
    const draft: PostVariant = {
      platform: p.platform,
      text: parts[0] ?? p.text,
      parts,
      hashtags: p.hashtags ?? [],
      linkToken: null,
      altText: p.altText ?? null,
      firstComment: p.firstComment ?? null,
      claimRefs: p.claimRefs ?? [],
    };
    // No slot yet, so no date: the date-bound checks (X links in launch week, expiring facts, repeats) run again at schedule time.
    const ctx = { platform: p.platform, format, scheduledAt: null, claims: claimMap, recentTexts: [], xLinksAllowed: false };
    const s = sanitizeVariant(draft, ctx);
    return { platform: p.platform, variant: s.variant, issues: [...s.issues, ...validateVariant(s.variant, ctx)] };
  });

  const itemId = uuidv7();
  const out: AgentDrafts = { contentItemId: itemId, campaignId: campaign.id, variants: [] };
  await db.transaction(async (tx) => {
    await tx.insert(contentItems).values({
      id: itemId,
      workspaceId,
      campaignId: campaign.id,
      deliverableKey: `${input.kind}:agent:${itemId}`,
      kind: input.kind,
      slotKind: "agent",
      status: checked.some((c) => hasBlock(c.issues)) ? "needs_you" : "ready",
      needsYouReason: checked.flatMap((c) => c.issues).find((i) => i.severity === "block")?.message ?? null,
      claimIds: [...new Set(checked.flatMap((c) => c.variant.claimRefs))],
      createdAt: now,
      updatedAt: now,
    });
    for (const c of checked) {
      const variantId = uuidv7();
      const body = { schemaVersion: 1, kind: input.kind, variant: c.variant } satisfies TextVariantBody;
      await tx.insert(variants).values({
        id: variantId,
        workspaceId,
        contentItemId: itemId,
        platform: c.platform,
        body,
        qa: { issues: c.issues, checkedAt: now.toISOString(), author: input.author } as unknown as Record<string, unknown>,
        promptVersion: "agent",
        contentHash: variantContentHash({ platform: c.platform, body }),
      });
      out.variants.push({ variantId, platform: c.platform, issues: c.issues });
    }
  });
  return { ok: true, drafts: out };
}

/** A draft variant of this workspace and product (schedule_posts), with its item and blocking issues. */
export async function agentVariant(db: Db, workspaceId: string, variantId: string) {
  const [row] = await db
    .select({ variant: variants, item: contentItems })
    .from(variants)
    .innerJoin(contentItems, eq(contentItems.id, variants.contentItemId))
    .where(and(eq(variants.id, variantId), eq(variants.workspaceId, workspaceId)));
  return row ?? null;
}
