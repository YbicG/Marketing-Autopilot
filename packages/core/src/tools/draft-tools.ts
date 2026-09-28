import { and, eq, isNull, notInArray, or } from "drizzle-orm";
import { z } from "zod";
import type { PostVariant } from "@mkt/contracts";
import { schema, uuidv7 } from "@mkt/db";
import { agentVariant, writeAgentDrafts } from "../engine/agent-drafts.ts";
import { claimIssues, hasBlock, type ClaimInfo, type CopyIssue } from "../engine/validate.ts";
import { rescheduleCapIssues } from "../publishing/ui-actions.ts";
import type { PostRow } from "../publishing/store.ts";
import { proposeDnaChange } from "./dna-changes.ts";
import { ProductSlug, productOf } from "./read-tools.ts";
import { defineTool, ToolError } from "./registry.ts";

const { campaigns, campaignBundles, claims, posts, socialConnections, workspaces } = schema;

// Draft and publish-request tools (§9): everything they write waits for the owner in the app.

const TEXT_PLATFORMS = ["threads", "x", "linkedin", "bluesky"] as const;

const AgentPostIn = z.object({
  platform: z.enum(TEXT_PLATFORMS).describe("Where it's for; threads (several linked posts) only on x and bluesky"),
  text: z.string().max(5_000).default("").describe("The post. Put {{link:landing}} where the link goes; no web addresses."),
  parts: z.array(z.string().min(1).max(3_000)).max(25).optional().describe("A thread's posts in order (kind thread only)"),
  hashtags: z.array(z.string().max(60)).max(30).optional().describe("Without the #"),
  altText: z.string().max(1_000).nullish(),
  firstComment: z.string().max(3_000).nullish(),
  claimRefs: z.array(z.string().regex(/^C\d+$/)).max(20).optional().describe("The facts (C1, C2…) behind every number, quote or comparison"),
});

export const createPostVariants = defineTool({
  name: "create_post_variants",
  description:
    "Save your own post or thread for a product as drafts, one version per platform. They go through the same checks as the app's copy and appear on the content board. Nothing is scheduled or posted; the owner reviews and approves in the app.",
  input: z.object({
    product: ProductSlug,
    kind: z.enum(["post", "thread"]).default("post"),
    posts: z.array(AgentPostIn).min(1).max(TEXT_PLATFORMS.length),
  }),
  output: z.custom<{ contentItemId: string; variants: { variantId: string; platform: string; problems: string[]; warnings: string[] }[] }>(),
  effect: "draft",
  scopes: ["draft"],
  async run(ctx, input) {
    const p = await productOf(ctx, input.product);
    if (input.kind === "post" && input.posts.some((x) => !x.text.trim())) throw new ToolError("invalid", "Each post needs its text.");
    if (input.kind === "thread" && input.posts.some((x) => !x.parts?.length)) throw new ToolError("invalid", "A thread needs its parts.");
    const r = await writeAgentDrafts(ctx.db, ctx.pat.workspaceId, p.id, { kind: input.kind, posts: input.posts, author: `pat:${ctx.pat.patId}` }, ctx.now);
    if (!r.ok) throw new ToolError("conflict", r.message);
    return {
      contentItemId: r.drafts.contentItemId,
      variants: r.drafts.variants.map((v) => ({
        variantId: v.variantId,
        platform: v.platform,
        problems: v.issues.filter((i) => i.severity === "block").map((i) => i.message),
        warnings: v.issues.filter((i) => i.severity === "warn").map((i) => i.message),
      })),
    };
  },
});

export const proposeDnaChangeTool = defineTool({
  name: "propose_dna_change",
  description:
    "Suggest a change to one field of a product's profile (e.g. identity.oneLiner). It doesn't change anything: the owner sees it on the plan screen and accepts or rejects it.",
  input: z.object({
    product: ProductSlug,
    path: z.string().regex(/^[a-z]+\.[A-Za-z]+$/).max(100).describe("section.field, as in get_product_dna"),
    value: z.unknown().describe("The whole new value of that field, in the same shape"),
    reason: z.string().max(500).optional().describe("Why, in a sentence the owner will read"),
  }),
  output: z.custom<{ requestId: string; status: "pending" }>(),
  effect: "draft",
  scopes: ["draft"],
  async run(ctx, input) {
    const p = await productOf(ctx, input.product);
    const r = await proposeDnaChange(ctx.db, ctx.pat.workspaceId, p.id, { path: input.path, value: input.value, reason: input.reason, patId: ctx.pat.patId });
    if (!r.ok) throw new ToolError("invalid", r.message);
    return { requestId: r.requestId, status: "pending" as const };
  },
});

/** Posts in these states still stand for their variant: a second one would post the same copy twice. */
const DONE_STATES = ["canceled", "failed", "missed"] as const;

export const schedulePosts = defineTool({
  name: "schedule_posts",
  description:
    "Put draft versions (variant ids from create_post_variants or list_content) on the calendar at future times. Each post waits for the owner to approve it in the app; nothing goes out until then.",
  input: z.object({
    product: ProductSlug,
    posts: z.array(z.object({ variantId: z.string().uuid(), at: z.string().datetime({ offset: true }).describe("When to post (ISO time)") })).min(1).max(30),
  }),
  output: z.custom<{ scheduled: { variantId: string; postId: string; state: string; scheduledAt: string }[]; refused: { variantId: string; reason: string }[] }>(),
  effect: "publish_request",
  scopes: ["draft"],
  async run(ctx, input) {
    const { db, pat, now } = ctx;
    const p = await productOf(ctx, input.product);
    const [ws] = await db.select({ tz: workspaces.timezone }).from(workspaces).where(eq(workspaces.id, pat.workspaceId));
    const tz = ws?.tz ?? "UTC";
    const scheduled: { variantId: string; postId: string; state: string; scheduledAt: string }[] = [];
    const refused: { variantId: string; reason: string }[] = [];

    for (const want of input.posts) {
      const at = new Date(want.at);
      const refuse = (reason: string) => refused.push({ variantId: want.variantId, reason });
      if (at.getTime() <= now.getTime() + 5 * 60_000) {
        refuse("Pick a time at least five minutes from now.");
        continue;
      }
      const row = await agentVariant(db, pat.workspaceId, want.variantId);
      const [camp] = row ? await db.select().from(campaigns).where(eq(campaigns.id, row.item.campaignId)) : [];
      if (!row || !camp || camp.productId !== p.id) {
        refuse("That version isn't one of this product's.");
        continue;
      }
      const v = (row.variant.body as { variant?: PostVariant }).variant;
      if (!v || !(TEXT_PLATFORMS as readonly string[]).includes(row.variant.platform)) {
        refuse("Only text posts and threads can be scheduled this way.");
        continue;
      }
      const live = await db
        .select({ id: posts.id })
        .from(posts)
        .where(and(eq(posts.variantId, row.variant.id), notInArray(posts.state, [...DONE_STATES])));
      if (live.length) {
        refuse("That version is already on the calendar.");
        continue;
      }

      // The date-bound fact checks run now that there is a date (expiring facts).
      const bundleClaims = camp.bundleId
        ? await db
            .select({ ref: claims.ref, kind: claims.kind, publicOk: claims.publicOk, status: claims.status, expiresAt: claims.expiresAt })
            .from(claims)
            .innerJoin(campaignBundles, eq(campaignBundles.dnaVersionId, claims.dnaVersionId))
            .where(eq(campaignBundles.id, camp.bundleId))
        : [];
      const claimMap = new Map<string, ClaimInfo>(bundleClaims.map((c) => [c.ref, c]));
      const issues: CopyIssue[] = [...(((row.variant.qa as { issues?: CopyIssue[] } | null)?.issues) ?? []), ...claimIssues(v.claimRefs, claimMap, at)];

      const [conn] = await db
        .select({ id: socialConnections.id })
        .from(socialConnections)
        .where(
          and(
            eq(socialConnections.workspaceId, pat.workspaceId),
            eq(socialConnections.platform, row.variant.platform),
            eq(socialConnections.status, "active"),
            or(eq(socialConnections.productId, p.id), isNull(socialConnections.productId)),
          ),
        )
        .limit(1);

      const postId = uuidv7();
      const candidate = {
        id: postId,
        workspaceId: pat.workspaceId,
        productId: p.id,
        platform: row.variant.platform,
        connectionId: conn?.id ?? null,
        scheduledAt: at,
      } as PostRow;
      const caps = await rescheduleCapIssues(db, candidate, at, tz);
      if (caps.length) {
        refuse(`${caps.join(" ")} Pick another time.`);
        continue;
      }
      const state = hasBlock(issues) ? "draft" : "pending_approval";
      await db.insert(posts).values({
        id: postId,
        workspaceId: pat.workspaceId,
        productId: p.id,
        variantId: row.variant.id,
        connectionId: conn?.id ?? null,
        platform: row.variant.platform,
        scheduledAt: at,
        state,
        generation: 1,
        idempotencyKey: `pst_${postId}_g1`,
      });
      scheduled.push({ variantId: row.variant.id, postId, state, scheduledAt: at.toISOString() });
    }
    if (!scheduled.length && refused.length === 1) throw new ToolError("conflict", refused[0]!.reason);
    return { scheduled, refused };
  },
});

export const DRAFT_TOOLS = [createPostVariants, proposeDnaChangeTool, schedulePosts];
