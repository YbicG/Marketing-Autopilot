import { and, eq, inArray } from "drizzle-orm";
import { M2_GENERATORS, type CampaignPlan, type ContentKind, type GeneratorId, type SocialPlatform } from "@mkt/contracts";
import { schema, type Db } from "@mkt/db";
import { formatUsd } from "../cost/pricing.ts";
import { refillPriceMicros } from "./estimate.ts";
import type { CopyIssue } from "./validate.ts";

const { campaigns, contentItems, variants, posts, angles } = schema;

// Campaign board (§2.3): a 30-day strip plus groups by type. Each card: platforms, angle, status,
// checks, cost, AI-label chip. Empty slots read "Open · Make more ~$0.40".

export type BoardStatus = "Drafting" | "Ready" | "Needs you" | "Approved" | "Scheduled" | "Posted" | "Failed";

export const KIND_LABELS: Record<ContentKind, string> = {
  post: "Post",
  thread: "Thread",
  carousel: "Swipe post",
  video: "Short video",
  email: "Email",
  bio: "Profile bio",
  pinned: "Pinned post",
};

export const KIND_GENERATOR: Record<ContentKind, GeneratorId | null> = {
  post: "posts",
  thread: "threads",
  carousel: "carousel",
  video: "video",
  bio: "bio",
  pinned: "bio",
  email: null,
};

export interface BoardItemInput {
  id: string;
  deliverableKey: string;
  kind: ContentKind;
  status: string;
  needsYouReason: string | null;
  day: number | null;
  angleIdx: number | null;
  costMicros: number;
  stale: boolean;
}
export interface BoardVariantInput {
  id: string;
  contentItemId: string;
  platform: string;
  qa: { issues?: CopyIssue[] } | null;
  provenanceTier: "A" | "B" | "C";
  assetIds: string[];
  body: Record<string, unknown>;
}
export interface BoardPostInput {
  variantId: string;
  state: string;
}

export interface BoardCard {
  contentItemId: string;
  deliverableKey: string;
  kind: ContentKind;
  typeLabel: string;
  day: number | null;
  platforms: string[];
  angle: { idx: number; title: string } | null;
  status: BoardStatus;
  reason: string | null;
  checks: { blocks: number; warns: number };
  costMicros: number;
  /** Provenance tier of the most generated part: A (captured/template) · B (AI voice) · C (AI images/video). */
  aiLabel: "A" | "B" | "C";
  thumbnailAssetId: string | null;
  stale: boolean;
}

export interface OpenCard {
  slotId: string;
  day: number;
  date: string;
  platform: SocialPlatform;
  kind: ContentKind;
  typeLabel: string;
  /** "Open · Make more ~$0.40", or "Open · Coming soon" when the generator isn't on yet. */
  label: string;
  priceMicros: number;
  available: boolean;
}

export interface BoardDay {
  day: number;
  date: string;
  launch: boolean;
  entries: { slotId: string; platform: SocialPlatform; kind: ContentKind; time: string; status: BoardStatus | "Open"; contentItemId: string | null }[];
}

export interface Board {
  launchDay: number;
  strip: BoardDay[];
  groups: { kind: ContentKind; label: string; cards: BoardCard[]; open: OpenCard[] }[];
  totals: { costMicros: number; byStatus: Record<BoardStatus, number>; open: number };
}

const SCHEDULED = new Set(["queued", "preparing", "submitting", "submitted", "unknown"]);

export function cardStatus(itemStatus: string, postStates: string[]): BoardStatus {
  if (itemStatus === "planned" || itemStatus === "generating" || itemStatus === "finalizing") return "Drafting";
  if (itemStatus === "needs_you") return "Needs you";
  if (itemStatus === "failed") return "Failed";
  if (!postStates.length) return itemStatus === "approved" ? "Approved" : "Ready";
  if (postStates.some((s) => s === "failed")) return "Failed";
  if (postStates.some((s) => s === "missed" || s === "awaiting_user")) return "Needs you";
  if (postStates.every((s) => s === "published" || s === "canceled")) return "Posted";
  if (postStates.every((s) => SCHEDULED.has(s) || s === "published" || s === "canceled")) return "Scheduled";
  if (postStates.every((s) => s !== "draft" && s !== "pending_approval")) return "Approved";
  return "Ready";
}

const tierRank = { A: 0, B: 1, C: 2 } as const;

/** Pure: plan + rows → board. */
export function buildBoard(input: {
  plan: CampaignPlan;
  items: BoardItemInput[];
  variants: BoardVariantInput[];
  posts: BoardPostInput[];
  angleTitles: Map<number, string>;
  generators?: readonly GeneratorId[];
}): Board {
  const on = new Set(input.generators ?? M2_GENERATORS);
  const postsByVariant = new Map<string, string[]>();
  for (const p of input.posts) postsByVariant.set(p.variantId, [...(postsByVariant.get(p.variantId) ?? []), p.state]);
  const variantsByItem = new Map<string, BoardVariantInput[]>();
  for (const v of input.variants) variantsByItem.set(v.contentItemId, [...(variantsByItem.get(v.contentItemId) ?? []), v]);
  const itemsByKey = new Map(input.items.map((i) => [i.deliverableKey, i]));

  const byStatus: Record<BoardStatus, number> = { Drafting: 0, Ready: 0, "Needs you": 0, Approved: 0, Scheduled: 0, Posted: 0, Failed: 0 };
  const cards = new Map<string, BoardCard>();
  for (const i of input.items) {
    if (i.status === "skipped") continue;
    const vs = variantsByItem.get(i.id) ?? [];
    const issues = vs.flatMap((v) => v.qa?.issues ?? []);
    const status = cardStatus(i.status, vs.flatMap((v) => postsByVariant.get(v.id) ?? []));
    byStatus[status]++;
    const rendered = vs.map((v) => (v.body.renderedAssetIds as string[] | undefined)?.[0] ?? v.assetIds[0]).find(Boolean) ?? null;
    cards.set(i.id, {
      contentItemId: i.id,
      deliverableKey: i.deliverableKey,
      kind: i.kind,
      typeLabel: KIND_LABELS[i.kind],
      day: i.day,
      platforms: [...new Set(vs.map((v) => v.platform))],
      angle: i.angleIdx === null ? null : { idx: i.angleIdx, title: input.angleTitles.get(i.angleIdx) ?? `Angle ${i.angleIdx + 1}` },
      status,
      reason: i.needsYouReason,
      checks: { blocks: issues.filter((x) => x.severity === "block").length, warns: issues.filter((x) => x.severity === "warn").length },
      costMicros: i.costMicros,
      aiLabel: vs.reduce<"A" | "B" | "C">((m, v) => (tierRank[v.provenanceTier] > tierRank[m] ? v.provenanceTier : m), "A"),
      thumbnailAssetId: rendered,
      stale: i.stale,
    });
  }

  const open: OpenCard[] = [];
  const strip: BoardDay[] = [];
  for (let d = 1; d <= input.plan.days; d++) {
    const slots = input.plan.slots.filter((s) => s.day === d);
    strip.push({
      day: d,
      date: slots[0]?.date ?? "",
      launch: d === input.plan.launchDay,
      entries: [],
    });
  }
  for (const s of input.plan.slots) {
    const item = s.deliverableKey ? itemsByKey.get(s.deliverableKey) : undefined;
    // Failed items stay as a Failed card (Try again / Make more); skipped ones free their slot.
    const isOpen = s.status === "open" || !item || item.status === "skipped";
    const day = strip[s.day - 1];
    if (day && !day.date) day.date = s.date;
    if (isOpen) {
      const gen = KIND_GENERATOR[s.kind];
      const available = !!gen && on.has(gen) && s.openReason !== "coming_soon";
      const price = refillPriceMicros(s.kind);
      open.push({
        slotId: s.id,
        day: s.day,
        date: s.date,
        platform: s.platform,
        kind: s.kind,
        typeLabel: KIND_LABELS[s.kind],
        label: available ? `Open · Make more ~${formatUsd(price)}` : "Open · Coming soon",
        priceMicros: price,
        available,
      });
    }
    day?.entries.push({
      slotId: s.id,
      platform: s.platform,
      kind: s.kind,
      time: s.time,
      status: isOpen || !item ? "Open" : (cards.get(item.id)?.status ?? "Drafting"),
      contentItemId: isOpen || !item ? null : item.id,
    });
  }

  const kinds = [...new Set<ContentKind>([...[...cards.values()].map((c) => c.kind), ...open.map((o) => o.kind)])];
  const order: ContentKind[] = ["video", "carousel", "post", "thread", "bio", "pinned", "email"];
  kinds.sort((a, b) => order.indexOf(a) - order.indexOf(b));
  return {
    launchDay: input.plan.launchDay,
    strip,
    groups: kinds.map((k) => ({
      kind: k,
      label: `${KIND_LABELS[k]}s`,
      cards: [...cards.values()].filter((c) => c.kind === k).sort((a, b) => (a.day ?? 999) - (b.day ?? 999)),
      open: open.filter((o) => o.kind === k),
    })),
    totals: { costMicros: [...cards.values()].reduce((n, c) => n + c.costMicros, 0), byStatus, open: open.length },
  };
}

/** Workspace-scoped loader for the board page. */
export async function campaignBoard(db: Db, workspaceId: string, campaignId: string, generators?: readonly GeneratorId[]): Promise<Board | null> {
  const [c] = await db.select().from(campaigns).where(and(eq(campaigns.id, campaignId), eq(campaigns.workspaceId, workspaceId)));
  if (!c?.plan) return null;
  const items = await db.select().from(contentItems).where(and(eq(contentItems.campaignId, c.id), eq(contentItems.workspaceId, workspaceId)));
  const ids = items.map((i) => i.id);
  const vs = ids.length ? await db.select().from(variants).where(and(eq(variants.workspaceId, workspaceId), inArray(variants.contentItemId, ids))) : [];
  const vIds = vs.map((v) => v.id);
  const ps = vIds.length ? await db.select({ variantId: posts.variantId, state: posts.state }).from(posts).where(inArray(posts.variantId, vIds)) : [];
  const angleRows = await db.select().from(angles).where(eq(angles.strategyId, c.strategyId));
  return buildBoard({
    plan: c.plan as unknown as CampaignPlan,
    items: items.map((i) => ({
      id: i.id,
      deliverableKey: i.deliverableKey,
      kind: i.kind,
      status: i.status,
      needsYouReason: i.needsYouReason,
      day: i.day,
      angleIdx: (i.brief as { angleIdx?: number } | null)?.angleIdx ?? null,
      costMicros: i.costMicros,
      stale: i.stale,
    })),
    variants: vs.map((v) => ({
      id: v.id,
      contentItemId: v.contentItemId,
      platform: v.platform,
      qa: v.qa as BoardVariantInput["qa"],
      provenanceTier: v.provenanceTier,
      assetIds: v.assetIds,
      body: v.body,
    })),
    posts: ps,
    angleTitles: new Map(angleRows.map((a) => [a.idx, String((a.card as { title?: string }).title ?? "")])),
    generators,
  });
}
