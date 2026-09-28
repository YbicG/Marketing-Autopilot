import { z } from "zod";
import { schema } from "@mkt/db";
import { and, eq, inArray } from "drizzle-orm";
import { resultsByAngle } from "../analytics/results.ts";
import { spendBreakdown } from "../cost/spending.ts";
import { periodMonth } from "../cost/ledger.ts";
import { patPeriod } from "../cost/pat-limits.ts";
import { latestCampaign } from "../engine/package-options.ts";
import { variantText } from "../engine/package.ts";
import { currentDna } from "../ingest/dna.ts";
import { claimsFor } from "../ingest/profile.ts";
import { productBySlug } from "../ingest/strategy.ts";
import { launchView } from "../launch/plan/plan.ts";
import { projectSummaries } from "../publishing/projects.ts";
import { queueView } from "../publishing/queue-view.ts";
import { getRun, runSpentMicros } from "../runs/summary.ts";
import { defineTool, ToolError, type ToolRunCtx } from "./registry.ts";

const { contentItems, posts, variants } = schema;

// Read tools (§9): look things up for the token's workspace, change nothing.

export const ProductSlug = z.string().min(1).max(80).describe("The product's short name from list_products (slug)");

/** The token's product by slug; a slug of another workspace reads as not found. */
export async function productOf(ctx: Pick<ToolRunCtx, "db" | "pat">, slug: string) {
  const p = await productBySlug(ctx.db, ctx.pat.workspaceId, slug);
  if (!p) throw new ToolError("not_found", `There's no product called ${slug}. list_products shows them.`);
  return p;
}

export const listProducts = defineTool({
  name: "list_products",
  description: "List the products (projects) in this workspace, with where each one is up to and what needs the owner.",
  input: z.object({}),
  output: z.custom<Awaited<ReturnType<typeof projectSummaries>>>(),
  effect: "read",
  scopes: ["read"],
  run: (ctx) => projectSummaries(ctx.db, ctx.pat.workspaceId, ctx.now),
});

export const getProductDna = defineTool({
  name: "get_product_dna",
  description: "Read a product's profile (what it is, who it's for, the offer, the market) and the facts posts may cite (C1, C2…).",
  input: z.object({ product: ProductSlug }),
  output: z.custom<{ dnaVersionId: string; version: number; status: string; dna: unknown; facts: unknown[] } | null>(),
  effect: "read",
  scopes: ["read"],
  async run(ctx, { product }) {
    const p = await productOf(ctx, product);
    const dna = await currentDna(ctx.db, p.id);
    if (!dna) return null;
    const facts = await claimsFor(ctx.db, dna.id);
    return {
      dnaVersionId: dna.id,
      version: dna.version,
      status: dna.status,
      dna: dna.dna,
      facts: facts.map((c) => ({ ref: c.ref, kind: c.kind, text: c.text, publicOk: c.publicOk, status: c.status, expiresAt: c.expiresAt })),
    };
  },
});

const DAY_MS = 86_400_000;

export const getCalendar = defineTool({
  name: "get_calendar",
  description: "The posting calendar: posts from a date for up to 60 days, grouped by day, with what needs the owner.",
  input: z.object({
    product: ProductSlug.optional(),
    from: z.string().date().optional().describe("First day (YYYY-MM-DD); today if left out"),
    days: z.number().int().min(1).max(60).default(14),
  }),
  output: z.custom<Awaited<ReturnType<typeof queueView>>>(),
  effect: "read",
  scopes: ["read"],
  async run(ctx, input) {
    const p = input.product ? await productOf(ctx, input.product) : null;
    const from = input.from ? new Date(`${input.from}T00:00:00Z`) : new Date(ctx.now.getTime() - DAY_MS);
    return queueView(ctx.db, ctx.pat.workspaceId, { from, to: new Date(from.getTime() + input.days * DAY_MS), productId: p?.id, now: ctx.now });
  },
});

export const listContent = defineTool({
  name: "list_content",
  description: "The pieces in a product's newest campaign, each with its platform versions (variant ids for schedule_posts), their text and any post made from them.",
  input: z.object({ product: ProductSlug, limit: z.number().int().min(1).max(200).default(50) }),
  output: z.custom<{ campaignId: string | null; items: unknown[] }>(),
  effect: "read",
  scopes: ["read"],
  async run(ctx, input) {
    const p = await productOf(ctx, input.product);
    const latest = await latestCampaign(ctx.db, ctx.pat.workspaceId, p.id);
    if (!latest) return { campaignId: null, items: [] };
    const items = (
      await ctx.db
        .select()
        .from(contentItems)
        .where(and(eq(contentItems.campaignId, latest.campaign.id), eq(contentItems.workspaceId, ctx.pat.workspaceId)))
    )
      .sort((a, b) => (a.day ?? 999) - (b.day ?? 999) || a.createdAt.getTime() - b.createdAt.getTime())
      .slice(0, input.limit);
    const ids = items.map((i) => i.id);
    const vs = ids.length ? await ctx.db.select().from(variants).where(inArray(variants.contentItemId, ids)) : [];
    const vIds = vs.map((v) => v.id);
    const ps = vIds.length
      ? await ctx.db.select({ id: posts.id, variantId: posts.variantId, state: posts.state, scheduledAt: posts.scheduledAt }).from(posts).where(inArray(posts.variantId, vIds))
      : [];
    return {
      campaignId: latest.campaign.id,
      items: items.map((i) => ({
        id: i.id,
        kind: i.kind,
        day: i.day,
        status: i.status,
        needsYouReason: i.needsYouReason,
        byAgent: i.slotKind === "agent",
        variants: vs
          .filter((v) => v.contentItemId === i.id)
          .map((v) => ({
            id: v.id,
            platform: v.platform,
            text: variantText(v.body),
            issues: ((v.qa as { issues?: { severity: string; message: string }[] } | null)?.issues ?? []).map((x) => ({ severity: x.severity, message: x.message })),
            posts: ps.filter((x) => x.variantId === v.id).map((x) => ({ id: x.id, state: x.state, scheduledAt: x.scheduledAt })),
          })),
      })),
    };
  },
});

export const getResults = defineTool({
  name: "get_results",
  description: "How a product's posts did, by angle (reach, clicks, sign-ups where known).",
  input: z.object({ product: ProductSlug }),
  output: z.custom<Awaited<ReturnType<typeof resultsByAngle>>>(),
  effect: "read",
  scopes: ["read"],
  async run(ctx, input) {
    const p = await productOf(ctx, input.product);
    return resultsByAngle(ctx.db, ctx.pat.workspaceId, p.id);
  },
});

export const getLaunchTasks = defineTool({
  name: "get_launch_tasks",
  description: "A product's launch plan: the launch-day tasks, what's done and what's next.",
  input: z.object({ product: ProductSlug }),
  output: z.custom<Awaited<ReturnType<typeof launchView>>>(),
  effect: "read",
  scopes: ["read"],
  async run(ctx, input) {
    const p = await productOf(ctx, input.product);
    return launchView(ctx.db, ctx.pat.workspaceId, p.id, ctx.now);
  },
});

export const getJob = defineTool({
  name: "get_job",
  description: "Where a long job (a jobId from run_package) is up to, and what it has spent so far.",
  input: z.object({ jobId: z.string().uuid() }),
  output: z.custom<{ jobId: string; kind: string; status: string; error: string | null; spentMicros: number; startedAt: Date | null; finishedAt: Date | null }>(),
  effect: "read",
  scopes: ["read"],
  async run(ctx, { jobId }) {
    const run = await getRun(ctx.db, ctx.pat.workspaceId, jobId);
    if (!run) throw new ToolError("not_found", "There's no job with that id.");
    return {
      jobId: run.id,
      kind: run.kind,
      status: run.status,
      // The stored error carries an internal code; the plain part is what's after it.
      error: run.error ? run.error.replace(/^[a-z_]+: /, "") : null,
      spentMicros: await runSpentMicros(ctx.db, run.id),
      startedAt: run.startedAt,
      finishedAt: run.finishedAt,
    };
  },
});

export const getSpend = defineTool({
  name: "get_spend",
  description: "This month's AI spending for the workspace, and what this token has spent against its own $10 a month.",
  input: z.object({ month: z.string().regex(/^\d{4}-\d{2}$/).optional().describe("YYYY-MM; this month if left out") }),
  output: z.custom<{ workspace: unknown; token: { spentMicros: number; reservedMicros: number; capMicros: number } }>(),
  effect: "read",
  scopes: ["read"],
  async run(ctx, input) {
    const month = input.month ?? periodMonth(ctx.now);
    const p = await patPeriod(ctx.db, ctx.pat.workspaceId, ctx.pat.patId, month);
    return {
      workspace: await spendBreakdown(ctx.db, ctx.pat.workspaceId, month),
      token: { spentMicros: p.spentMicros, reservedMicros: p.reservedMicros, capMicros: p.capMicros },
    };
  },
});

export const READ_TOOLS = [listProducts, getProductDna, getCalendar, listContent, getResults, getLaunchTasks, getJob, getSpend];
