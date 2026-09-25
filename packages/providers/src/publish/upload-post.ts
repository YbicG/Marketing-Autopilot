import { createHash } from "node:crypto";
import { definePublisher } from "../core/registry.ts";
import { httpRequest, ProviderHttpError, type FetchLike, type HttpResult } from "../core/http.ts";
import { verifyHmacSha256 } from "../core/hmac.ts";
import type {
  AccountHealth,
  ConnectLink,
  CreatorInfo,
  MetricSnapshot,
  Platform,
  PublisherAdapter,
  PublishMedia,
  PublishRequest,
  PublishStatus,
  ProviderCtx,
  ValidationIssue,
  WebhookEvent,
} from "../core/types.ts";
import { LINKEDIN_DOCUMENT_TITLE_MAX, PLATFORM_CAPS, TIKTOK_PHOTO_LIMITS, YOUTUBE_TITLE_MAX } from "./caps.ts";

/**
 * Upload-Post adapter (§5.8, §6). One Upload-Post profile ("user") per product; the M2 scheduler
 * uploads the approved file at slot time in async mode, then polls by request id. Every shape the
 * docs don't pin down lives in a function marked UNVERIFIED and is listed in
 * docs/spikes/upload-post.md for the server spike.
 */

export const UPLOAD_POST_BASE = "https://api.upload-post.com";
export const SECRET_API_KEY = "upload_post.api_key";
export const SECRET_WEBHOOK = "upload_post.webhook_secret";
/** Webhooks older than this are refused (replay guard; Upload-Post signs `<timestamp>.<body>`). */
export const WEBHOOK_TOLERANCE_MS = 5 * 60_000;

const PLATFORMS = ["tiktok", "instagram", "youtube", "threads", "x", "linkedin", "bluesky", "facebook", "pinterest"] as const;

// ── naming ──

/** UNVERIFIED: /api/upload lists "twitter" in platform[], /api/upload_text and the status example use "x". */
export function upPlatform(p: Platform): string {
  return p === "x" ? "x" : p;
}

export function fromUpPlatform(name: unknown): Platform | undefined {
  if (typeof name !== "string") return undefined;
  const n = name.toLowerCase();
  if (n === "twitter" || n === "x") return "x";
  return (PLATFORMS as readonly string[]).includes(n) ? (n as Platform) : undefined;
}

/** Upload-Post usernames: our own stable ids, so keep them to a safe alphabet. */
export function profileUsername(name: string): string {
  const u = name
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
  if (!u) throw new Error("profile name has no usable characters");
  return u;
}

// ── request building (pure) ──

export interface BuiltRequest {
  method: "POST";
  url: string;
  headers: Record<string, string>;
  /** Ordered multipart text fields; repeated names are arrays (e.g. platform[]). */
  fields: [string, string][];
  files: { field: string; media: PublishMedia }[];
  endpoint: "upload" | "upload_photos" | "upload_text" | "upload_document";
}

/**
 * Per-platform option names we pass through, as Upload-Post spells them. Anything else in
 * req.options is dropped, so a stray UI field can never reach the platform.
 */
const OPTION_KEYS: Record<Platform, readonly string[]> = {
  tiktok: [
    "privacy_level",
    "disable_comment",
    "disable_duet",
    "disable_stitch",
    "brand_content_toggle",
    "brand_organic_toggle",
    "auto_add_music",
    "photo_cover_index",
    "cover_timestamp",
    "tiktok_music_id",
  ],
  instagram: ["media_type", "share_to_feed", "collaborators", "location_id", "thumb_offset", "instagram_alt_text"],
  youtube: ["privacyStatus", "categoryId", "tags", "selfDeclaredMadeForKids", "embeddable", "license", "defaultLanguage", "defaultAudioLanguage", "hasPaidProductPlacement", "youtube_notify_subscribers"],
  threads: ["threads_topic_tag", "threads_reply_control", "threads_alt_text", "threads_long_text_as_post"],
  x: ["reply_settings", "x_long_text_as_post", "x_alt_text", "x_paid_partnership"],
  linkedin: ["visibility", "target_linkedin_page_id", "linkedin_disable_reshare", "linkedin_alt_text"],
  bluesky: ["bluesky_langs", "bluesky_alt_text", "bluesky_threadgate", "bluesky_gallery"],
  facebook: ["facebook_page_id", "facebook_media_type", "facebook_alt_text"],
  pinterest: ["pinterest_board_id", "pinterest_link", "pinterest_alt_text", "pinterest_board_section_id"],
};

/** Friendlier names the composer may use → Upload-Post's names. */
const OPTION_ALIASES: Record<string, string> = {
  privacy: "privacy_level",
  privacyLevel: "privacy_level",
  disableComment: "disable_comment",
  disableDuet: "disable_duet",
  disableStitch: "disable_stitch",
  brandContent: "brand_content_toggle",
  brandOrganic: "brand_organic_toggle",
  autoAddMusic: "auto_add_music",
  madeForKids: "selfDeclaredMadeForKids",
  youtubePrivacy: "privacyStatus",
  linkedinPageId: "target_linkedin_page_id",
  facebookPageId: "facebook_page_id",
  pinterestBoardId: "pinterest_board_id",
};

/** Duet/stitch/cover frame are video-only on TikTok. */
const TIKTOK_VIDEO_ONLY = new Set(["disable_duet", "disable_stitch", "cover_timestamp"]);
const TIKTOK_PHOTO_ONLY = new Set(["auto_add_music", "photo_cover_index"]);

export function normalizeOptions(platform: Platform, postType: PublishRequest["postType"], options: Record<string, unknown>): Record<string, unknown> {
  const allowed = new Set(OPTION_KEYS[platform]);
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(options)) {
    const key = OPTION_ALIASES[k] ?? k;
    if (!allowed.has(key) || v === undefined || v === null || v === "") continue;
    if (platform === "tiktok" && postType === "carousel" && TIKTOK_VIDEO_ONLY.has(key)) continue;
    if (platform === "tiktok" && postType === "video" && TIKTOK_PHOTO_ONLY.has(key)) continue;
    out[key] = v;
  }
  return out;
}

function endpointFor(req: PublishRequest): BuiltRequest["endpoint"] {
  switch (req.postType) {
    case "video":
      return "upload";
    case "image":
    case "carousel":
      return "upload_photos";
    case "document":
      return "upload_document";
    case "text":
    case "thread":
      return "upload_text";
  }
}

/**
 * Which text goes in `title` vs `description`. Upload-Post uses `title` as the caption on most
 * platforms and `description` as the long body on YouTube, LinkedIn documents and Pinterest.
 * UNVERIFIED: TikTok photo posts take a ≤90 title + a ≤4000 description; we assume `description`
 * is the photo caption and send the short title separately.
 */
export function captionFields(req: PublishRequest): [string, string][] {
  const title = req.title?.trim();
  if (req.platform === "youtube") return [["title", title ?? req.text.slice(0, YOUTUBE_TITLE_MAX)], ["description", req.text]];
  if (req.postType === "document") return [["title", title ?? req.text.slice(0, LINKEDIN_DOCUMENT_TITLE_MAX)], ["description", req.text]];
  if (req.platform === "pinterest") return [["title", title ?? req.text.slice(0, 100)], ["description", req.text]];
  if (req.platform === "tiktok" && req.postType === "carousel") {
    return [["title", title ?? req.text.slice(0, TIKTOK_PHOTO_LIMITS.titleMax)], ["description", req.text]];
  }
  return [["title", req.text]];
}

function fieldValue(v: unknown): string {
  if (typeof v === "boolean") return v ? "true" : "false";
  if (typeof v === "number") return String(v);
  if (typeof v === "string") return v;
  return JSON.stringify(v);
}

export function buildSubmitRequest(req: PublishRequest, opts: { apiKey: string; baseUrl?: string }): BuiltRequest {
  const endpoint = endpointFor(req);
  const fields: [string, string][] = [
    ["user", req.profileRef],
    ["platform[]", upPlatform(req.platform)],
    ...captionFields(req),
    // external_id lets a retry find the post (history?external_id=); request_id = the same key
    // lets us poll status even if the submit response is lost (docs: "provide your own request_id").
    ["external_id", req.externalId],
    ["request_id", req.externalId],
  ];
  // /api/upload_document is documented without async mode; it answers synchronously.
  if (endpoint !== "upload_document") fields.push(["async_upload", "true"]);
  if (req.firstComment) fields.push(["first_comment", req.firstComment]);

  const options = normalizeOptions(req.platform, req.postType, req.options);
  if (req.platform === "tiktok") {
    // D17: Direct post and fail instead of silently landing in drafts; "Send to my TikTok drafts"
    // is an explicit option that uploads as MEDIA_UPLOAD.
    const toDrafts = req.options.send_to_drafts === true || req.options.post_mode === "MEDIA_UPLOAD";
    fields.push(["post_mode", toDrafts ? "MEDIA_UPLOAD" : "DIRECT_POST"]);
    if (!toDrafts) fields.push(["disable_inbox_fallback", "true"]);
  }
  if (req.platform === "instagram" && req.postType !== "video" && options.media_type === undefined) {
    options.media_type = "IMAGE";
  }
  for (const [k, v] of Object.entries(options)) {
    // UNVERIFIED: array params (YouTube tags) as repeated `name[]`, like platform[].
    if (Array.isArray(v)) for (const item of v) fields.push([`${k}[]`, fieldValue(item)]);
    else fields.push([k, fieldValue(v)]);
  }

  // Only flags this route actually passes through (§5.8 step 2); validate() warns about the rest.
  const supported = new Set(PLATFORM_CAPS[req.platform].aiFlags);
  for (const [flag, on] of Object.entries(req.aiFlags)) {
    if (!supported.has(flag)) continue;
    if (req.platform === "x" && req.postType === "text") continue; // made_with_ai is media-only
    fields.push([flag, on ? "true" : "false"]);
  }

  const fileField = endpoint === "upload" ? "video" : endpoint === "upload_photos" ? "photos[]" : "document";
  const files = endpoint === "upload_text" ? [] : req.media.map((media) => ({ field: fileField, media }));

  return {
    method: "POST",
    url: `${opts.baseUrl ?? UPLOAD_POST_BASE}/api/${endpoint}`,
    headers: {
      Authorization: `Apikey ${opts.apiKey}`,
      Accept: "application/json",
      // Documented duplicate guard: a matching job returns the existing one instead of a new post.
      "Idempotency-Key": req.externalId,
    },
    fields,
    files,
    endpoint,
  };
}

/** Reads each approved file from storage at submit time and builds the multipart body. */
export async function toFormData(built: BuiltRequest): Promise<{ form: FormData; bytes: number }> {
  const form = new FormData();
  for (const [k, v] of built.fields) form.append(k, v);
  let bytes = 0;
  for (const { field, media } of built.files) {
    const body = await media.open();
    bytes += body.byteLength;
    form.append(field, new Blob([body as Uint8Array<ArrayBuffer>], { type: media.mime }), media.filename);
  }
  return { form, bytes };
}

/** Uploads need longer than an API call: 30 s plus 2 s per MB, capped at 15 min. */
export function uploadTimeoutMs(bytes: number): number {
  return Math.min(15 * 60_000, 30_000 + Math.ceil(bytes / 1_000_000) * 2_000);
}

// ── validation (pure) ──

const URL_RE = /\bhttps?:\/\/\S+|\bwww\.\S+/i;

function utf8Bytes(s: string): number {
  return Buffer.byteLength(s, "utf8");
}

export function validateRequest(req: PublishRequest): ValidationIssue[] {
  const caps = PLATFORM_CAPS[req.platform];
  const issues: ValidationIssue[] = [];
  const block = (code: string, message: string) => issues.push({ code, message, severity: "block" });
  const warn = (code: string, message: string) => issues.push({ code, message, severity: "warn" });
  const opts = normalizeOptions(req.platform, req.postType, req.options);

  if (!caps.postTypes.includes(req.postType)) block("post_type_unsupported", `${req.platform} doesn't take this kind of post through Upload-Post.`);

  // Threads counts UTF-8 bytes; everything else counts UTF-16 code units (docs, character-limits).
  const length = req.platform === "threads" ? utf8Bytes(req.text) : req.text.length;
  if (length > caps.maxCaptionChars) {
    const autoSplit = (req.platform === "threads" || req.platform === "bluesky") && (req.postType === "text" || req.postType === "thread");
    if (autoSplit) warn("caption_split", `This is longer than ${caps.maxCaptionChars} characters, so it will be posted as a thread.`);
    else block("caption_too_long", `The text is ${length} characters; ${req.platform} allows ${caps.maxCaptionChars}.`);
  }

  const needsMedia = req.postType !== "text" && req.postType !== "thread";
  if (needsMedia && req.media.length === 0) block("media_missing", "This post needs a file.");
  if ((req.postType === "video" || req.postType === "document" || req.postType === "image") && req.media.length > 1) {
    block("too_many_files", "This kind of post takes one file.");
  }
  if (req.postType === "carousel") {
    if (req.media.length < 2) block("carousel_too_small", "A swipe post needs at least 2 images.");
    if (caps.maxCarouselItems && req.media.length > caps.maxCarouselItems) {
      block("carousel_too_big", `${req.platform} allows ${caps.maxCarouselItems} images in a swipe post; this one has ${req.media.length}.`);
    }
  }
  for (const m of req.media) {
    if ((req.postType === "image" || req.postType === "carousel") && !caps.media.imageMimes.includes(m.mime)) {
      block("media_type_unsupported", `${req.platform} doesn't accept ${m.mime} images.`);
    }
    if (req.postType === "video" && !m.mime.startsWith("video/")) block("media_type_unsupported", "This post needs a video file.");
    if (req.postType === "document" && m.mime !== "application/pdf") block("media_type_unsupported", "LinkedIn documents are sent as PDF.");
  }

  if (req.platform === "tiktok") {
    // §8 TikTok composer UX: privacy has no default; branded content can't be private.
    if (!opts.privacy_level) block("tiktok_privacy_required", "Pick who can see this TikTok post.");
    if (opts.brand_content_toggle === true && opts.privacy_level === "SELF_ONLY") {
      block("tiktok_branded_private", "Branded content can't be posted as private on TikTok.");
    }
    if (req.postType === "carousel" && (req.title ?? "").length > TIKTOK_PHOTO_LIMITS.titleMax) {
      block("title_too_long", `TikTok photo titles are at most ${TIKTOK_PHOTO_LIMITS.titleMax} characters.`);
    }
    if (req.postType === "carousel" && req.text.length > TIKTOK_PHOTO_LIMITS.descriptionMax) {
      block("caption_too_long", `TikTok photo captions are at most ${TIKTOK_PHOTO_LIMITS.descriptionMax} characters.`);
    }
  }
  if (req.platform === "youtube") {
    if (!req.title?.trim()) block("title_required", "YouTube needs a title.");
    else if (req.title.length > YOUTUBE_TITLE_MAX) block("title_too_long", `YouTube titles are at most ${YOUTUBE_TITLE_MAX} characters.`);
    if (typeof opts.selfDeclaredMadeForKids !== "boolean") block("youtube_made_for_kids_required", "Say whether this video is made for kids.");
  }
  if (req.postType === "document" && (req.title ?? "").length > LINKEDIN_DOCUMENT_TITLE_MAX) {
    block("title_too_long", `LinkedIn document titles are at most ${LINKEDIN_DOCUMENT_TITLE_MAX} characters.`);
  }
  if (req.platform === "facebook" && !opts.facebook_page_id) block("facebook_page_required", "Pick the Facebook Page to post to.");
  if (req.platform === "pinterest" && !opts.pinterest_board_id) block("pinterest_board_required", "Pick the Pinterest board to save to.");

  if (caps.links === "addon" && (URL_RE.test(req.text) || URL_RE.test(req.firstComment ?? ""))) {
    warn("links_removed", "Links are removed from X posts unless the X links add-on is on. Point people to the link in your bio instead.");
  }
  if (caps.links === "bio_only" && URL_RE.test(req.text)) {
    warn("links_not_clickable", `Links in ${req.platform} captions can't be tapped. Use the link in your bio.`);
  }

  const supported = new Set(caps.aiFlags);
  const unsupported = Object.entries(req.aiFlags).filter(([flag, on]) => on && !supported.has(flag));
  if (unsupported.length || (req.platform === "x" && req.postType === "text" && Object.values(req.aiFlags).some(Boolean))) {
    warn("ai_flag_unsupported", `${req.platform} has no AI label we can set here. Add "Made with AI" to the caption.`);
  }
  return issues;
}

// ── response mapping (pure) ──

type Json = Record<string, unknown>;
const obj = (v: unknown): Json => (v && typeof v === "object" && !Array.isArray(v) ? (v as Json) : {});
const str = (v: unknown): string | undefined => (typeof v === "string" && v ? v : typeof v === "number" ? String(v) : undefined);

function errorMessage(json: unknown, fallback: string): string {
  const j = obj(json);
  return str(j.message) ?? str(j.error) ?? str(j.detail) ?? fallback;
}

/** One platform's result from a sync upload, the status endpoint or a webhook. */
export function platformResultToStatus(r: Json, requestId?: string): PublishStatus {
  if (r.fallback_to_inbox === true) {
    return { state: "awaiting_user", reason: "TikTok put this in your drafts. Open TikTok to finish posting it." };
  }
  if (r.skipped === true) {
    return { state: "failed", reason: "That account isn't connected to Upload-Post any more. Reconnect it in Settings.", retryable: false };
  }
  if (r.success === true) {
    return {
      state: "published",
      requestId,
      postId: str(r.post_id) ?? str(r.platform_post_id) ?? str(r.publish_id),
      url: str(r.url) ?? str(r.post_url),
    };
  }
  if (str(r.error_code) === "reached_active_user_cap") {
    return { state: "failed", reason: "TikTok's daily posting limit for this account was reached. Reschedule it for tomorrow.", retryable: false };
  }
  return { state: "failed", reason: str(r.error) ?? str(r.error_message) ?? str(r.message) ?? "The platform refused the post.", retryable: false };
}

function findResult(results: unknown, platform?: Platform): Json | undefined {
  if (Array.isArray(results)) {
    const rows = results.map(obj);
    return (platform ? rows.find((r) => fromUpPlatform(r.platform) === platform) : undefined) ?? rows[0];
  }
  const map = obj(results);
  const entries = Object.entries(map);
  if (!entries.length) return undefined;
  const hit = platform ? entries.find(([k]) => fromUpPlatform(k) === platform) : undefined;
  return obj((hit ?? entries[0]!)[1]);
}

export function mapSubmitResponse(httpStatus: number, json: unknown, platform: Platform, externalId: string): PublishStatus {
  const j = obj(json);
  if (httpStatus >= 200 && httpStatus < 300) {
    if (str(j.request_id)) return { state: "accepted", requestId: str(j.request_id)! };
    // The scheduled (fallback) path answers 202 with a job id; status() polls it with job_id=.
    if (str(j.job_id)) return { state: "accepted", requestId: `job:${str(j.job_id)}` };
    const r = findResult(j.results, platform);
    if (r) return platformResultToStatus(r);
    // We sent our own request_id, so an ack without one can still be polled by it.
    return { state: "accepted", requestId: externalId };
  }
  // Idempotency-Key hit on a job that is still running: let the poller reconcile it.
  if (httpStatus === 409) return { state: "pending", requestId: externalId };
  if (httpStatus === 408 || httpStatus === 429 || httpStatus >= 500) {
    return { state: "failed", reason: `Upload-Post is busy right now (${httpStatus}). It will be tried again.`, retryable: true };
  }
  if (httpStatus === 401) return { state: "failed", reason: "Upload-Post didn't accept the API key. Check it in Settings → Keys.", retryable: false };
  if (httpStatus === 403) return { state: "failed", reason: errorMessage(json, "Your Upload-Post plan doesn't allow this post."), retryable: false };
  return { state: "failed", reason: errorMessage(json, `Upload-Post refused the post (${httpStatus}).`), retryable: false };
}

const RUNNING = new Set(["pending", "queued", "processing", "in_progress"]);

export function mapStatusResponse(httpStatus: number, json: unknown, platform?: Platform): PublishStatus | "absent" {
  const j = obj(json);
  const status = str(j.status);
  if (httpStatus === 404 || status === "not_found") return "absent";
  if (httpStatus >= 500 || httpStatus === 429) return { state: "pending", requestId: str(j.request_id) };
  if (httpStatus >= 400) return { state: "failed", reason: errorMessage(json, `Upload-Post status check failed (${httpStatus}).`), retryable: false };
  const requestId = str(j.request_id) ?? str(j.job_id);
  const r = findResult(j.results, platform);
  // A platform can report success with message "Queued" while the upload is still running.
  if (!status || RUNNING.has(status)) {
    if (r && (r.fallback_to_inbox === true || (r.success === false && !r.skipped && (r.error || r.error_code)))) return platformResultToStatus(r, requestId);
    return { state: "pending", requestId };
  }
  if (r) return platformResultToStatus(r, requestId);
  if (status === "completed") return { state: "published", requestId };
  return { state: "failed", reason: errorMessage(json, "Upload-Post reported that the upload failed."), retryable: false };
}

/** UNVERIFIED: the history list's top-level key isn't shown in the docs. */
export function historyItems(json: unknown): Json[] {
  if (Array.isArray(json)) return json.map(obj);
  const j = obj(json);
  for (const k of ["history", "items", "uploads", "data", "results"]) {
    if (Array.isArray(j[k])) return (j[k] as unknown[]).map(obj);
  }
  return [];
}

export function mapHistoryResponse(json: unknown, platform?: Platform): PublishStatus | "absent" {
  const items = historyItems(json).filter((i) => !platform || !i.platform || fromUpPlatform(i.platform) === platform);
  if (!items.length) return "absent";
  const latest = items.sort((a, b) => String(b.upload_timestamp ?? "").localeCompare(String(a.upload_timestamp ?? "")))[0]!;
  return platformResultToStatus(latest, str(latest.request_id) ?? str(latest.job_id));
}

/**
 * UNVERIFIED: per-post analytics field names. The docs name the block (`post_metrics`) and some
 * TikTok extras (profile_views, new_followers, favorites) but not every key, so we try the likely
 * spellings. §5.9: a 0 from an aggregator counts as unknown.
 */
const METRIC_KEYS: Record<Exclude<keyof MetricSnapshot, "unknown">, string[]> = {
  views: ["views", "video_views", "plays", "play_count", "impressions"],
  likes: ["likes", "like_count", "reactions"],
  comments: ["comments", "comment_count", "replies"],
  shares: ["shares", "share_count", "reposts", "retweets"],
  saves: ["saves", "saved", "favorites", "bookmarks"],
  profileVisits: ["profile_views", "profile_visits", "profileViews"],
  follows: ["new_followers", "follows", "followers_gained"],
  linkClicks: ["link_clicks", "url_clicks", "outbound_clicks", "website_clicks"],
  engagedViews: ["engaged_views", "engagedViews"],
};

export function mapMetrics(json: unknown, platform: Platform): MetricSnapshot | null {
  const j = obj(json);
  const blocks = j.platforms ?? j.results ?? j.data;
  let block: Json | undefined;
  if (Array.isArray(blocks)) block = blocks.map(obj).find((b) => fromUpPlatform(b.platform) === platform);
  else if (blocks) block = obj(obj(blocks)[upPlatform(platform)] ?? obj(blocks)[platform === "x" ? "twitter" : platform]);
  block ??= obj(j[upPlatform(platform)]);
  if (!Object.keys(block).length) block = j;
  const m = obj(block.post_metrics ?? block.metrics ?? block);
  const out = { unknown: [] as string[] } as MetricSnapshot;
  let any = false;
  for (const [field, keys] of Object.entries(METRIC_KEYS) as [Exclude<keyof MetricSnapshot, "unknown">, string[]][]) {
    const raw = keys.map((k) => m[k]).find((v) => typeof v === "number" || (typeof v === "string" && /^\d+$/.test(v)));
    const n = raw === undefined ? null : Number(raw);
    if (n === null || n === 0 || !Number.isFinite(n)) {
      out[field] = null;
      out.unknown.push(field);
    } else {
      out[field] = n;
      any = true;
    }
  }
  return any ? out : null;
}

/** UNVERIFIED: token expiry isn't in the documented profile shape; we read the likely keys. */
export function mapHealth(json: unknown): AccountHealth[] {
  const j = obj(json);
  const accounts = obj(obj(j.profile).social_accounts ?? j.social_accounts);
  const out: AccountHealth[] = [];
  for (const [name, raw] of Object.entries(accounts)) {
    const platform = fromUpPlatform(name);
    if (!platform || !raw || typeof raw !== "object") continue; // "" = not connected
    const a = obj(raw);
    const expired = a.reauth_required === true || a.expired === true || a.status === "reauth_required";
    out.push({
      platform,
      handle: str(a.handle) ?? str(a.username) ?? str(a.display_name),
      status: a.status === "disconnected" || a.status === "revoked" ? "revoked" : expired ? "reauth_required" : "active",
      tokenExpiresAt: str(a.token_expires_at) ?? str(a.expires_at),
    });
  }
  return out;
}

export function mapCreatorInfo(json: unknown): CreatorInfo {
  const j = obj(json);
  const privacyOptions = Array.isArray(j.privacy_level_options) ? j.privacy_level_options.filter((x): x is string => typeof x === "string") : [];
  return {
    privacyOptions,
    canPost: j.success !== false && privacyOptions.length > 0,
    maxVideoSeconds: typeof j.max_video_post_duration_sec === "number" ? j.max_video_post_duration_sec : undefined,
    commentDisabled: j.comment_disabled === true,
    duetDisabled: j.duet_disabled === true,
    stitchDisabled: j.stitch_disabled === true,
    raw: j,
  };
}

/** "48h" / "30m" / "2d" → absolute ISO time. */
export function durationToExpiry(duration: unknown, now = Date.now()): string | undefined {
  const m = typeof duration === "string" ? /^(\d+)\s*([smhd])$/i.exec(duration.trim()) : null;
  if (!m) return undefined;
  const unit = { s: 1_000, m: 60_000, h: 3_600_000, d: 86_400_000 }[m[2]!.toLowerCase() as "s" | "m" | "h" | "d"];
  return new Date(now + Number(m[1]) * unit).toISOString();
}

// ── webhooks (pure) ──

export class WebhookSignatureError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WebhookSignatureError";
  }
}

/**
 * Docs: `X-Upload-Post-Signature: sha256=<hex HMAC-SHA256(secret, "<timestamp>.<raw body>")>`,
 * `X-Upload-Post-Timestamp` (unix s), `X-Upload-Post-Event`, `X-Upload-Post-Delivery` (unique id).
 * UNVERIFIED: whether upload_completed carries request_id / external_id for async uploads (the
 * documented example has only job_id); failures arrive as upload_completed with result.success=false.
 */
export function parseUploadPostWebhook(rawBody: string, headers: Record<string, string>, secret: string, now = Date.now()): WebhookEvent {
  const h: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) h[k.toLowerCase()] = v;
  const sig = h["x-upload-post-signature"];
  const ts = h["x-upload-post-timestamp"];
  if (!sig) throw new WebhookSignatureError("missing signature");
  if (ts) {
    const tsMs = Number(ts) * 1000;
    if (!Number.isFinite(tsMs) || Math.abs(now - tsMs) > WEBHOOK_TOLERANCE_MS) throw new WebhookSignatureError("stale timestamp");
    if (!verifyHmacSha256(`${ts}.${rawBody}`, sig, secret)) throw new WebhookSignatureError("bad signature");
  } else if (!verifyHmacSha256(rawBody, sig, secret)) {
    throw new WebhookSignatureError("bad signature");
  }

  let body: Json;
  try {
    body = obj(JSON.parse(rawBody));
  } catch {
    throw new WebhookSignatureError("body is not JSON");
  }
  const eventId = h["x-upload-post-delivery"] ?? createHash("sha256").update(rawBody).digest("hex");
  const type = str(body.event) ?? h["x-upload-post-event"] ?? "unknown";
  const platform = fromUpPlatform(body.platform);
  const result = obj(body.result);
  const requestId = str(body.request_id) ?? str(body.job_id);
  const externalId = str(body.external_id);

  if (type === "upload_completed") {
    if (result.fallback_to_inbox === true || body.fallback_to_inbox === true) return { kind: "inbox_fallback", eventId, externalId, requestId, platform };
    if (result.success === false) {
      return { kind: "upload_failed", eventId, externalId, requestId, platform, reason: str(result.error) ?? "The platform refused the post." };
    }
    return { kind: "upload_completed", eventId, externalId, requestId, platform, postId: str(result.post_id) ?? str(result.publish_id), url: str(result.url) };
  }
  if (type === "social_account_reauth_required" || type === "social_account_disconnected") {
    return { kind: "reauth_required", eventId, profileRef: str(body.profile_username), platform };
  }
  return { kind: "ignored", eventId, type };
}

// ── adapter ──

export interface UploadPostOptions {
  baseUrl?: string;
  fetch?: FetchLike;
  /** Where the hosted connect page sends the user back to (Settings → Accounts). */
  redirectUrl?: string;
  now?: () => number;
}

async function apiKey(ctx: ProviderCtx): Promise<string> {
  const key = await ctx.secret(SECRET_API_KEY);
  if (!key) throw new Error("Add your Upload-Post API key in Settings → Keys first.");
  return key;
}

function ensureOk(res: HttpResult, what: string): void {
  if (res.status < 200 || res.status >= 300) {
    throw new ProviderHttpError(res.status, res.json ?? res.text, `Upload-Post ${what} failed (${res.status}): ${errorMessage(res.json, res.text.slice(0, 200))}`);
  }
}

export function createUploadPost(opts: UploadPostOptions = {}): PublisherAdapter {
  const base = opts.baseUrl ?? UPLOAD_POST_BASE;
  const now = opts.now ?? Date.now;
  const call = async (ctx: ProviderCtx, path: string, init: { method?: string; json?: unknown; query?: Record<string, string> } = {}) => {
    const key = await apiKey(ctx);
    const qs = init.query ? `?${new URLSearchParams(init.query).toString()}` : "";
    return httpRequest(`${base}${path}${qs}`, {
      method: init.method ?? "GET",
      headers: {
        Authorization: `Apikey ${key}`,
        Accept: "application/json",
        ...(init.json !== undefined ? { "Content-Type": "application/json" } : {}),
      },
      body: init.json !== undefined ? JSON.stringify(init.json) : undefined,
      signal: ctx.signal,
      fetch: opts.fetch,
    });
  };

  const statusByRequest = async (ctx: ProviderCtx, requestId: string, platform?: Platform) => {
    const query: Record<string, string> = requestId.startsWith("job:") ? { job_id: requestId.slice(4) } : { request_id: requestId };
    const res = await call(ctx, "/api/uploadposts/status", { query });
    return mapStatusResponse(res.status, res.json, platform);
  };

  const history = async (ctx: ProviderCtx, query: Record<string, string>, platform?: Platform) => {
    const res = await call(ctx, "/api/uploadposts/history", { query: { limit: "10", ...query } });
    if (res.status === 404) return "absent" as const;
    ensureOk(res, "history lookup");
    return mapHistoryResponse(res.json, platform);
  };

  return {
    meta: { id: "upload_post", kind: "publish", requiredSecrets: [SECRET_API_KEY, SECRET_WEBHOOK] },
    platforms: PLATFORMS,
    caps: (platform) => PLATFORM_CAPS[platform],

    async ensureProfile(ctx, profileName) {
      const username = profileUsername(profileName);
      const res = await call(ctx, "/api/uploadposts/users", { method: "POST", json: { username } });
      if (res.status !== 409) ensureOk(res, "profile create");
      return { profileRef: username };
    },

    async connectLink(ctx, profileRef, platforms): Promise<ConnectLink> {
      const res = await call(ctx, "/api/uploadposts/users/generate-jwt", {
        method: "POST",
        json: {
          username: profileRef,
          platforms: platforms.map(upPlatform),
          ...(opts.redirectUrl ? { redirect_url: opts.redirectUrl, redirect_button_text: "Back to Marketing" } : {}),
        },
      });
      ensureOk(res, "connect link");
      const j = obj(res.json);
      const url = str(j.access_url);
      if (!url) throw new Error("Upload-Post didn't return a connect link.");
      return { url, expiresAt: durationToExpiry(j.duration, now()) };
    },

    async health(ctx, profileRef) {
      const res = await call(ctx, `/api/uploadposts/users/${encodeURIComponent(profileRef)}`);
      if (res.status === 404) return [];
      ensureOk(res, "profile read");
      return mapHealth(res.json);
    },

    async creatorInfo(ctx, profileRef, platform) {
      if (platform !== "tiktok") return null;
      const res = await call(ctx, "/api/uploadposts/tiktok/settings", { query: { profile: profileRef } });
      ensureOk(res, "TikTok settings");
      return mapCreatorInfo(res.json);
    },

    validate: validateRequest,

    async submit(ctx, req) {
      const built = buildSubmitRequest(req, { apiKey: await apiKey(ctx), baseUrl: base });
      const { form, bytes } = await toFormData(built);
      // A timeout throws: the scheduler marks the post unknown and calls lookupByExternalId (§4.3).
      const res = await httpRequest(built.url, {
        method: "POST",
        headers: built.headers,
        body: form,
        timeoutMs: uploadTimeoutMs(bytes),
        signal: ctx.signal,
        fetch: opts.fetch,
      });
      return mapSubmitResponse(res.status, res.json, req.platform, req.externalId);
    },

    async status(ctx, ref) {
      const s = await statusByRequest(ctx, ref.requestId ?? ref.externalId);
      // Unknown to the status endpoint: never "absent" here, only lookupByExternalId may say that.
      if (s === "absent") return { state: "pending", requestId: ref.requestId };
      if (s.state === "published" && !s.url) {
        // The status endpoint's per-platform rows don't document a URL; history has post_url.
        const h = await history(ctx, { external_id: ref.externalId }).catch(() => "absent" as const);
        if (h !== "absent" && h.state === "published") return { ...h, requestId: s.requestId ?? h.requestId };
      }
      return s;
    },

    async lookupByExternalId(ctx, externalId) {
      // We submit with request_id = externalId, so the status endpoint knows running uploads that
      // history doesn't list yet. Only both saying "never heard of it" is absent.
      const s = await statusByRequest(ctx, externalId);
      if (s !== "absent") return s;
      return history(ctx, { external_id: externalId });
    },

    parseWebhook: (rawBody, headers, secret) => parseUploadPostWebhook(rawBody, headers, secret, now()),

    async metrics(ctx, ref) {
      if (!ref.requestId || ref.requestId.startsWith("job:")) return null;
      const res = await call(ctx, `/api/uploadposts/post-analytics/${encodeURIComponent(ref.requestId)}`, {
        query: { platform: upPlatform(ref.platform) },
      });
      if (res.status === 404) return null;
      ensureOk(res, "post analytics");
      return mapMetrics(res.json, ref.platform);
    },
  };
}

export const uploadPost = definePublisher(createUploadPost());
