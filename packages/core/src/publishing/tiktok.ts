import { TikTokOptions, TIKTOK_BRANDED_NOT_PRIVATE_TEXT } from "@mkt/contracts";
import type { CreatorInfo, ValidationIssue } from "@mkt/providers";
import { DAY_MS } from "./time.ts";

/** D17 and §8 volume caps. */
export const TIKTOK_WEEK_ONE_DAILY = 1;
export const TIKTOK_HARD_DAILY_MAX = 2;
/** TikTok's own API cap per creator; D17's hard max makes it the backstop, not the limit. */
export const TIKTOK_API_DAILY_CAP = 15;
export const TIKTOK_MAX_PENDING_DRAFTS = 5;

/** Week one of a TikTok account = 7 days from warmup_until's start, or from when we connected it. */
export function tiktokInWeekOne(conn: { warmupUntil: Date | null; createdAt: Date }, at: Date): boolean {
  const until = conn.warmupUntil ?? new Date(conn.createdAt.getTime() + 7 * DAY_MS);
  return at.getTime() < until.getTime();
}

export function tiktokDailyLimit(conn: { warmupUntil: Date | null; createdAt: Date; maxPerDay: number }, at: Date): number {
  if (tiktokInWeekOne(conn, at)) return TIKTOK_WEEK_ONE_DAILY;
  return Math.min(conn.maxPerDay, TIKTOK_HARD_DAILY_MAX, TIKTOK_API_DAILY_CAP);
}

export interface TikTokComposerInput {
  options: unknown;
  creatorInfo: CreatorInfo | null;
  /** Longest video in the post, if any. */
  videoSeconds?: number;
  /** Posts already counted today on this account (sent or ahead of this one). */
  postsToday?: number;
  dailyLimit?: number;
  /** Posts sitting in the TikTok inbox waiting for the user. */
  pendingDrafts?: number;
}

export interface TikTokComposerResult {
  issues: ValidationIssue[];
  options: TikTokOptions | null;
  /** "drafts" → the post ends in awaiting_user ("needs manual finish"). */
  mode: "direct" | "drafts";
}

/** The composer's rules (§8 "TikTok composer UX", D17). Runs in the composer and again at prepare. */
export function validateTikTokComposer(input: TikTokComposerInput): TikTokComposerResult {
  const issues: ValidationIssue[] = [];
  const block = (code: string, message: string) => issues.push({ code, message, severity: "block" });

  const raw = (input.options ?? {}) as Record<string, unknown>;
  if (raw.privacyLevel === undefined || raw.privacyLevel === null || raw.privacyLevel === "") {
    block("tiktok.privacy_required", "Choose who can see this TikTok.");
  }
  const parsed = TikTokOptions.safeParse(raw);
  if (!parsed.success) {
    for (const i of parsed.error.issues) {
      const path = i.path.join(".");
      if (path === "privacyLevel" && issues.some((x) => x.code === "tiktok.privacy_required")) continue;
      if (path === "musicConsent") block("tiktok.music_consent", "Confirm TikTok's Music Usage Confirmation before posting.");
      else if (i.message === TIKTOK_BRANDED_NOT_PRIVATE_TEXT) block("tiktok.branded_private", i.message);
      else block(`tiktok.${path || "options"}`, i.message);
    }
  }
  const options = parsed.success ? parsed.data : null;
  const mode = options?.postMode ?? "direct";

  const ci = input.creatorInfo;
  if (ci) {
    if (!ci.canPost) block("tiktok.cannot_post", "TikTok says this account can't post right now. Try again later.");
    if (options && ci.privacyOptions.length && !ci.privacyOptions.includes(options.privacyLevel)) {
      block("tiktok.privacy_unavailable", "This account doesn't allow that audience setting. Pick another.");
    }
    if (options && ci.commentDisabled && !options.disableComment) {
      block("tiktok.comments_off", "Comments are turned off for this account in TikTok.");
    }
    if (options && ci.duetDisabled && !options.disableDuet) block("tiktok.duet_off", "Duets are turned off for this account in TikTok.");
    if (options && ci.stitchDisabled && !options.disableStitch) block("tiktok.stitch_off", "Stitches are turned off for this account in TikTok.");
    if (ci.maxVideoSeconds && input.videoSeconds && input.videoSeconds > ci.maxVideoSeconds) {
      block("tiktok.too_long", `This account can post videos up to ${ci.maxVideoSeconds} seconds.`);
    }
  }
  if (input.postsToday !== undefined && input.dailyLimit !== undefined && input.postsToday >= input.dailyLimit) {
    block(
      "tiktok.daily_cap",
      input.dailyLimit === TIKTOK_WEEK_ONE_DAILY
        ? "New TikTok accounts post once a day in their first week."
        : `TikTok posts are capped at ${input.dailyLimit} a day.`,
    );
  }
  if (mode === "drafts" && (input.pendingDrafts ?? 0) >= TIKTOK_MAX_PENDING_DRAFTS) {
    block("tiktok.drafts_full", `You have ${TIKTOK_MAX_PENDING_DRAFTS} TikTok drafts waiting. Finish some in the app first.`);
  }
  return { issues, options, mode };
}
