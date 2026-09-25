/**
 * Provider contracts (§6). Providers never import @mkt/db: callers pass secrets in and get usage
 * back, and core/cost wraps every PaidOp in runPaidCall.
 */

export type ProviderKind = "publish" | "tts" | "align" | "stt" | "music" | "sfx" | "analytics" | "search" | "email";

export interface ProviderMeta {
  id: string;
  kind: ProviderKind;
  /** Vault purposes this provider needs, e.g. ["upload_post.api_key"]. */
  requiredSecrets: string[];
  /** Pinned model snapshots, when the provider has models. */
  models?: { id: string; deprecatedAfter?: string }[];
  /** Keys into the static price table (core/cost/pricing.ts). */
  pricingKeys?: string[];
}

export interface PaidUsage {
  /** What the ledger should settle, in micro-dollars. Quota plans report their effective rate. */
  actualMicros: number;
  units?: Record<string, number>;
}

/** A paid operation: estimate before, usage after (§6). */
export interface PaidOp<Req, Res> {
  estimate(req: Req): number;
  execute(req: Req, ctx: ProviderCtx): Promise<{ result: Res; usage: PaidUsage; providerRequestId?: string; servedModel?: string }>;
}

export interface ProviderCtx {
  /** Resolved from the vault first, then env (D19). Missing -> the caller shows the fallback. */
  secret(purpose: string): Promise<string | null>;
  signal?: AbortSignal;
}

// ── publishing ──

export type Platform = "tiktok" | "instagram" | "youtube" | "threads" | "x" | "linkedin" | "bluesky" | "facebook" | "pinterest";

export type PostType = "text" | "image" | "carousel" | "video" | "document" | "thread";

export interface PlatformCaps {
  platform: Platform;
  postTypes: PostType[];
  maxCaptionChars: number;
  maxCarouselItems?: number;
  media: { imageMimes: string[]; videoMaxBytes?: number; videoMaxSeconds?: number };
  /** "clickable" | "bio_only" | "addon" (X via Upload-Post only with the links add-on, D24). */
  links: "clickable" | "bio_only" | "addon";
  /** Which AI-disclosure flags this route passes through (§5.8 step 2). */
  aiFlags: string[];
  draftMode: boolean;
  dailyCap: number;
}

export interface PublishMedia {
  assetId: string;
  sha256: string;
  mime: string;
  filename: string;
  /** Streams the approved final file from storage at submit time; media never needs a public URL before M8. */
  open(): Promise<Uint8Array>;
}

export interface PublishRequest {
  /** = posts.idempotency_key: pst_{id}_g{n}. Sent as external_id so a retry can look it up first. */
  externalId: string;
  profileRef: string;
  platform: Platform;
  postType: PostType;
  text: string;
  title?: string;
  firstComment?: string;
  media: PublishMedia[];
  /** Platform options exactly as approved (TikTok privacy, toggles, brand flags, madeForKids…). */
  options: Record<string, unknown>;
  /** Mapped from the provenance tier (§5.8): e.g. { is_aigc: true }. */
  aiFlags: Record<string, boolean>;
}

export type PublishStatus =
  | { state: "accepted"; requestId: string }
  | { state: "published"; requestId?: string; postId?: string; url?: string }
  | { state: "failed"; reason: string; retryable: boolean }
  | { state: "awaiting_user"; reason: string }
  | { state: "pending"; requestId?: string };

export interface ValidationIssue {
  code: string;
  message: string;
  severity: "block" | "warn";
}

export interface ConnectLink {
  url: string;
  expiresAt?: string;
}

export interface AccountHealth {
  platform: Platform;
  handle?: string;
  status: "active" | "reauth_required" | "revoked" | "error";
  tokenExpiresAt?: string;
}

export interface CreatorInfo {
  /** TikTok creator_info: privacy options the account allows, caps, toggles it can change. */
  privacyOptions: string[];
  canPost: boolean;
  maxVideoSeconds?: number;
  commentDisabled?: boolean;
  duetDisabled?: boolean;
  stitchDisabled?: boolean;
  raw?: Record<string, unknown>;
}

export interface MetricSnapshot {
  /** null = the aggregator returned nothing or 0 for a metric it doesn't really report (§5.9). */
  views: number | null;
  likes: number | null;
  comments: number | null;
  shares: number | null;
  saves: number | null;
  profileVisits: number | null;
  follows: number | null;
  linkClicks: number | null;
  engagedViews: number | null;
  unknown: string[];
}

export type WebhookEvent =
  | { kind: "upload_completed"; eventId: string; externalId?: string; requestId?: string; postId?: string; url?: string; platform?: Platform }
  | { kind: "upload_failed"; eventId: string; externalId?: string; requestId?: string; reason: string; platform?: Platform }
  | { kind: "reauth_required"; eventId: string; profileRef?: string; platform?: Platform }
  | { kind: "inbox_fallback"; eventId: string; externalId?: string; requestId?: string; platform?: Platform }
  | { kind: "ignored"; eventId: string; type: string };

/** §6 PublisherAdapter. publishNow is M8 (direct adapters); the M2 scheduler submits at slot time via submit(). */
export interface PublisherAdapter {
  meta: ProviderMeta & { kind: "publish" };
  caps(platform: Platform): PlatformCaps;
  /** Which platforms this adapter posts to. Must never include an ASSISTED_ONLY_TARGETS venue. */
  platforms: readonly Platform[];
  ensureProfile(ctx: ProviderCtx, profileName: string): Promise<{ profileRef: string }>;
  connectLink(ctx: ProviderCtx, profileRef: string, platforms: Platform[]): Promise<ConnectLink>;
  health(ctx: ProviderCtx, profileRef: string): Promise<AccountHealth[]>;
  creatorInfo(ctx: ProviderCtx, profileRef: string, platform: Platform): Promise<CreatorInfo | null>;
  validate(req: PublishRequest): ValidationIssue[];
  /** Upload now, at the slot time (async mode). Called at most once per externalId. */
  submit(ctx: ProviderCtx, req: PublishRequest): Promise<PublishStatus>;
  status(ctx: ProviderCtx, ref: { requestId?: string; externalId: string }): Promise<PublishStatus>;
  /** "absent" is the only answer that lets an unknown post be re-sent (§4.3). */
  lookupByExternalId(ctx: ProviderCtx, externalId: string): Promise<PublishStatus | "absent">;
  /** Verifies the signature over the raw body and parses it. Throws on a bad signature. */
  parseWebhook(rawBody: string, headers: Record<string, string>, webhookSecret: string): WebhookEvent;
  metrics(ctx: ProviderCtx, ref: { postId?: string; requestId?: string; platform: Platform }): Promise<MetricSnapshot | null>;
}
