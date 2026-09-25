// Test-only helpers (imported by *.test.ts): a seeded product/campaign/post graph and a fake publisher.
import { createHash } from "node:crypto";
import { eq } from "drizzle-orm";
import { schema, uuidv7, type Db } from "@mkt/db";
import type {
  MetricSnapshot,
  Platform,
  PlatformCaps,
  PublisherAdapter,
  PublishRequest,
  PublishStatus,
  ValidationIssue,
} from "@mkt/providers";
import type { PublishDeps } from "./due.ts";
import { memoryJobGateway } from "./scheduler.ts";

export const sha = (b: Uint8Array | string) => createHash("sha256").update(b).digest("hex");

export interface FakeAdapter extends PublisherAdapter {
  submits: PublishRequest[];
  lookups: string[];
  statuses: string[];
  onSubmit: (req: PublishRequest) => Promise<PublishStatus>;
  onLookup: (externalId: string) => Promise<PublishStatus | "absent">;
  onStatus: (externalId: string) => Promise<PublishStatus>;
  onMetrics: () => Promise<MetricSnapshot | null>;
  validateIssues: ValidationIssue[];
  aiFlags: string[];
}

export function fakeAdapter(): FakeAdapter {
  const platforms: Platform[] = ["tiktok", "instagram", "youtube", "threads", "x", "linkedin", "bluesky"];
  const a: FakeAdapter = {
    meta: { id: "fake_pub", kind: "publish", requiredSecrets: [] },
    platforms,
    submits: [],
    lookups: [],
    statuses: [],
    validateIssues: [],
    aiFlags: ["is_aigc", "is_ai_generated", "containsSyntheticMedia", "made_with_ai"],
    onSubmit: async (req) => ({ state: "accepted", requestId: `req_${req.externalId}` }),
    onLookup: async () => "absent",
    onStatus: async () => ({ state: "pending" }),
    onMetrics: async () => null,
    caps(platform): PlatformCaps {
      return {
        platform,
        postTypes: ["text", "image", "carousel", "video", "document", "thread"],
        maxCaptionChars: 2200,
        media: { imageMimes: ["image/png", "image/jpeg"] },
        links: platform === "instagram" || platform === "tiktok" ? "bio_only" : platform === "x" ? "addon" : "clickable",
        aiFlags: a.aiFlags,
        draftMode: platform === "tiktok",
        dailyCap: 15,
      };
    },
    ensureProfile: async () => ({ profileRef: "p" }),
    connectLink: async () => ({ url: "https://connect.test" }),
    health: async () => [],
    creatorInfo: async () => null,
    validate: () => a.validateIssues,
    submit: async (_ctx, req) => {
      a.submits.push(req);
      // Read the media the way a real multipart upload would.
      for (const m of req.media) await m.open();
      return a.onSubmit(req);
    },
    status: async (_ctx, ref) => {
      a.statuses.push(ref.externalId);
      return a.onStatus(ref.externalId);
    },
    lookupByExternalId: async (_ctx, externalId) => {
      a.lookups.push(externalId);
      return a.onLookup(externalId);
    },
    parseWebhook: () => ({ kind: "ignored", eventId: "x", type: "x" }),
    metrics: async () => a.onMetrics(),
  };
  return a;
}

export interface Seeded {
  workspaceId: string;
  productId: string;
  dnaVersionId: string;
  claimId: string;
  angleId: string;
  campaignId: string;
  contentItemId: string;
  variantId: string;
  assetId: string;
  connectionId: string;
}

/** Each seeded asset gets its own bytes (assets are unique per workspace + sha256). */
export const MEDIA = new Map<string, Uint8Array>();

export async function seedWorkspace(db: Db, opts: { slug?: string; workspaceId?: string; platform?: string; shared?: boolean; handle?: string } = {}): Promise<Seeded> {
  const workspaceId = opts.workspaceId ?? uuidv7();
  if (!opts.workspaceId) await db.insert(schema.workspaces).values({ id: workspaceId, name: "test", timezone: "America/New_York" });
  const productId = uuidv7();
  const slug = opts.slug ?? `syllacal${productId.slice(-4)}`;
  await db.insert(schema.products).values({ id: productId, workspaceId, slug, name: "SyllaCal", urls: { website: "https://syllacal.com/" } });
  const dnaVersionId = uuidv7();
  await db.insert(schema.productDnaVersions).values({
    id: dnaVersionId,
    workspaceId,
    productId,
    version: 1,
    status: "confirmed",
    dna: { offer: { pricing: "Free" } },
    fields: {},
    sourceMap: {},
  });
  await db.update(schema.products).set({ currentDnaVersionId: dnaVersionId }).where(eq(schema.products.id, productId));
  const claimId = uuidv7();
  await db.insert(schema.claims).values({
    id: claimId,
    workspaceId,
    productId,
    dnaVersionId,
    ref: "C1",
    kind: "feature",
    text: "Turns a syllabus into a calendar",
    sourceRefs: ["S1"],
    publicOk: true,
  });
  const strategyId = uuidv7();
  await db.insert(schema.strategies).values({ id: strategyId, workspaceId, productId, dnaVersionId, output: {} });
  const angleId = uuidv7();
  await db.insert(schema.angles).values({ id: angleId, workspaceId, strategyId, idx: 0, card: { title: "Syllabus to calendar" }, sharePct: 60 });
  const bundleId = uuidv7();
  await db.insert(schema.campaignBundles).values({ id: bundleId, workspaceId, productId, strategyId, dnaVersionId, version: 1, text: "x", claimRefs: ["C1"] });
  const campaignId = uuidv7();
  await db.insert(schema.campaigns).values({
    id: campaignId,
    workspaceId,
    productId,
    strategyId,
    bundleId,
    tier: "quick",
    startDate: "2026-10-19",
    launchDate: "2026-11-03",
    platforms: ["threads"],
  });
  const contentItemId = uuidv7();
  await db.insert(schema.contentItems).values({
    id: contentItemId,
    workspaceId,
    campaignId,
    angleId,
    deliverableKey: `post:${contentItemId}`,
    kind: "post",
    claimIds: ["C1"],
    dnaFieldsUsed: ["offer.pricing"],
  });
  const assetId = uuidv7();
  const bytes = new TextEncoder().encode(`media ${assetId}`);
  const storageKey = `ws/${workspaceId}/a/${assetId}.png`;
  MEDIA.set(storageKey, bytes);
  await db.insert(schema.assets).values({
    id: assetId,
    workspaceId,
    productId,
    kind: "still",
    origin: "template",
    mime: "image/png",
    sha256: sha(bytes),
    storageKey,
  });
  const variantId = uuidv7();
  await db.insert(schema.variants).values({
    id: variantId,
    workspaceId,
    contentItemId,
    platform: opts.platform ?? "threads",
    body: {
      schemaVersion: 1,
      kind: "post",
      variant: {
        platform: opts.platform ?? "threads",
        text: "Your syllabus, now a calendar",
        parts: [],
        hashtags: [],
        linkToken: "{{link:landing}}",
        altText: null,
        firstComment: null,
        claimRefs: ["C1"],
      },
    },
    assetIds: [assetId],
    contentHash: "v1",
  });
  const connectionId = uuidv7();
  await db.insert(schema.socialConnections).values({
    id: connectionId,
    workspaceId,
    productId,
    publisher: "upload_post",
    platform: opts.platform ?? "threads",
    handle: opts.handle ?? `acct${connectionId.slice(-6)}`,
    profileRef: `prof_${connectionId}`,
    shared: opts.shared ?? false,
    createdAt: new Date("2026-01-01T00:00:00Z"),
  });
  return { workspaceId, productId, dnaVersionId, claimId, angleId, campaignId, contentItemId, variantId, assetId, connectionId };
}

export async function addPost(
  db: Db,
  s: Seeded,
  scheduledAt: Date,
  over: Partial<typeof schema.posts.$inferInsert> = {},
): Promise<string> {
  const id = over.id ?? uuidv7();
  await db.insert(schema.posts).values({
    id,
    workspaceId: s.workspaceId,
    productId: s.productId,
    variantId: s.variantId,
    connectionId: s.connectionId,
    platform: "threads",
    scheduledAt,
    state: "pending_approval",
    idempotencyKey: `pst_${id}_g1`,
    ...over,
  });
  return id;
}

export function testDeps(db: Db, clock: { now: Date }, adapter: FakeAdapter, graceMin = 120) {
  const gateway = memoryJobGateway();
  const analytics: { postId: string; publishedAt: Date }[] = [];
  const deps: PublishDeps = {
    db,
    gateway,
    graceMin,
    now: () => clock.now,
    adapterFor: () => adapter,
    ctxFor: () => ({ secret: async () => "test-key" }),
    openMedia: async ({ storageKey }) => MEDIA.get(storageKey) ?? new Uint8Array(),
    scheduleAnalytics: async (postId, publishedAt) => {
      analytics.push({ postId, publishedAt });
    },
    submitTimeoutMs: 200,
  };
  return { deps, gateway, analytics };
}
