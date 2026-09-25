import { z } from "zod";
import { PostFormat, SocialPlatform } from "./platforms.ts";
import { ContentKind, GeneratorId } from "./recipe.ts";

// ── CampaignPlan (§5.3): the pure calendar planner's output. Claude only writes the briefs. ──

/**
 * Opening-line styles the planner rotates through. Same ids as video-spec's HookStyle
 * (render-api.md), repeated here so text posts don't depend on the video contract.
 */
export const OPENING_STYLES = [
  "pain_callout",
  "speed_demo",
  "before_after_split",
  "pov",
  "contrarian",
  "question",
  "real_stat",
  "listicle_disclosed",
  "build_in_public",
  "reply_to_complaint",
] as const;
export const OpeningStyle = z.enum(OPENING_STYLES);
export type OpeningStyle = z.infer<typeof OpeningStyle>;

/** Why a slot is Open (D12: never silently padded). */
export const OpenReason = z.enum([
  /** The generator for this kind isn't switched on yet (videos until M3a). */
  "coming_soon",
  /** Its content failed or was skipped: "Make more" fills it. */
  "not_generated",
  /** Left empty on purpose (a refill slot). */
  "open",
]);
export type OpenReason = z.infer<typeof OpenReason>;

const IsoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

export const PlanSlot = z.object({
  /** Stable, colon-free: "tiktok-d03-1". */
  id: z.string(),
  /** 1..30; the launch is day 14 by default. */
  day: z.number().int().positive(),
  date: IsoDate,
  /** Local time in the workspace timezone ("19:30"). */
  time: z.string().regex(/^\d{2}:\d{2}$/),
  /** The same moment in UTC, ISO 8601. */
  scheduledAt: z.string(),
  platform: SocialPlatform,
  format: PostFormat,
  kind: ContentKind,
  /** Recipe line key (for refills). */
  lineKey: z.string(),
  connectionId: z.string().nullable(),
  status: z.enum(["filled", "open"]),
  openReason: OpenReason.nullable(),
  deliverableKey: z.string().nullable(),
  angleIdx: z.number().int().nonnegative().nullable(),
  openingStyle: OpeningStyle.nullable(),
  /** Video masters: which of the master's opening lines this account uses (D16: one per account). */
  hookIdx: z.number().int().nonnegative().nullable(),
  masterIdx: z.number().int().nonnegative().nullable(),
  launch: z.boolean(),
});
export type PlanSlot = z.infer<typeof PlanSlot>;

export const PlanItem = z.object({
  /** Stable key in the campaign, exactly one colon: "post:text-07", "video:master-02" (see engine/package.ts). */
  deliverableKey: z.string().regex(/^[a-z]+:[a-z0-9-]+$/),
  kind: ContentKind,
  generator: GeneratorId,
  lineKey: z.string(),
  idx: z.number().int().nonnegative(),
  angleIdx: z.number().int().nonnegative(),
  openingStyle: OpeningStyle,
  /** First scheduled day, null for unscheduled drafts (bio, pinned). */
  day: z.number().int().positive().nullable(),
  slotIds: z.array(z.string()),
  targets: z.array(z.object({ platform: SocialPlatform, format: PostFormat })),
  masterIdx: z.number().int().nonnegative().nullable(),
  launch: z.boolean(),
});
export type PlanItem = z.infer<typeof PlanItem>;

export const CampaignPlan = z.object({
  schemaVersion: z.literal(1),
  startDate: IsoDate,
  launchDate: IsoDate,
  launchDay: z.number().int(),
  timezone: z.string(),
  days: z.number().int().positive(),
  slots: z.array(PlanSlot),
  items: z.array(PlanItem),
  /** Deliverables that didn't fit under the caps. Reported, never squeezed in. */
  overflow: z.array(z.object({ platform: SocialPlatform, format: PostFormat, lineKey: z.string(), count: z.number().int() })),
  warnings: z.array(z.string()),
});
export type CampaignPlan = z.infer<typeof CampaignPlan>;

// ── campaign.plan (Opus): one brief per planned deliverable. Model-facing: plain, nullable, no min/max. ──

export const ItemBriefModel = z.object({
  deliverableKey: z.string(),
  /** What this piece is about, in one sentence. */
  topic: z.string(),
  /** A first idea for the opening line, in the slot's style. */
  openingLine: z.string(),
  keyPoints: z.array(z.string()),
  /** Public claim refs (C1…) this piece may lean on. */
  claimRefs: z.array(z.string()),
  /** Real screenshots (asset ids) that show it. */
  screenshotAssetIds: z.array(z.string()),
  /** What we want the viewer to do next, in plain words. */
  nextStep: z.string(),
});
export type ItemBriefModel = z.infer<typeof ItemBriefModel>;

export const CampaignBriefsModel = z.object({ briefs: z.array(ItemBriefModel) });
export type CampaignBriefsModel = z.infer<typeof CampaignBriefsModel>;

/** What content_items.brief holds: the planner's placement plus Claude's brief once written. */
export const ItemBrief = z.object({
  schemaVersion: z.literal(1),
  lineKey: z.string(),
  targets: z.array(z.object({ platform: SocialPlatform, format: PostFormat })),
  slotIds: z.array(z.string()),
  angleIdx: z.number().int().nonnegative(),
  openingStyle: OpeningStyle,
  masterIdx: z.number().int().nonnegative().nullable(),
  launch: z.boolean(),
  written: ItemBriefModel.nullable(),
});
export type ItemBrief = z.infer<typeof ItemBrief>;
