import { definePublisher } from "../core/registry.ts";
import { ProviderTimeout } from "../core/http.ts";
import type { MetricSnapshot, Platform, PublisherAdapter, PublishRequest, PublishStatus, WebhookEvent } from "../core/types.ts";
import { PLATFORM_CAPS } from "./caps.ts";
import { parseUploadPostWebhook, validateRequest } from "./upload-post.ts";

/**
 * Scriptable publisher (id "fake") for scheduler and reconcile tests (PROVIDER_MODE=fake).
 *  - accept:             submit → accepted; status → pending for `pollsUntilDone` polls, then published
 *  - publish:            submit → published at once
 *  - fail:               submit → failed (not retryable)
 *  - timeout-then-found: submit throws a timeout, but the post did arrive: lookup → published
 *  - absent:             submit throws a timeout and nothing arrived: lookup → "absent"
 *  - awaiting_user:      submit → accepted; status → awaiting_user (TikTok drafts)
 */
export type FakeBehaviour = "accept" | "publish" | "fail" | "timeout-then-found" | "absent" | "awaiting_user";

export interface FakePublisherScript {
  /** Default for every externalId not in `byExternalId`. */
  behaviour?: FakeBehaviour;
  byExternalId?: Record<string, FakeBehaviour>;
  pollsUntilDone?: number;
  metrics?: Partial<MetricSnapshot>;
}

export interface FakeCall {
  method: string;
  externalId?: string;
  req?: PublishRequest;
}

export interface FakePublisher extends PublisherAdapter {
  calls: FakeCall[];
  script: FakePublisherScript;
  /** Submissions that reached the "platform" (what a real duplicate check would count). */
  delivered: Map<string, PublishRequest>;
  reset(): void;
}

const ALL: readonly Platform[] = ["tiktok", "instagram", "youtube", "threads", "x", "linkedin", "bluesky", "facebook", "pinterest"];

export function createFakePublisher(script: FakePublisherScript = {}): FakePublisher {
  const calls: FakeCall[] = [];
  const delivered = new Map<string, PublishRequest>();
  const polls = new Map<string, number>();
  const behaviourFor = (id: string): FakeBehaviour => fake.script.byExternalId?.[id] ?? fake.script.behaviour ?? "accept";
  const published = (id: string): PublishStatus => ({
    state: "published",
    requestId: `req_${id}`,
    postId: `post_${id}`,
    url: `https://example.test/p/${encodeURIComponent(id)}`,
  });

  const fake: FakePublisher = {
    meta: { id: "fake", kind: "publish", requiredSecrets: [] },
    platforms: ALL,
    calls,
    script,
    delivered,
    reset() {
      calls.length = 0;
      delivered.clear();
      polls.clear();
    },
    caps: (p) => PLATFORM_CAPS[p],
    async ensureProfile(_ctx, profileName) {
      calls.push({ method: "ensureProfile" });
      return { profileRef: `fake-${profileName}` };
    },
    async connectLink(_ctx, profileRef) {
      calls.push({ method: "connectLink" });
      return { url: `https://example.test/connect/${profileRef}` };
    },
    async health() {
      calls.push({ method: "health" });
      return [];
    },
    async creatorInfo(_ctx, _ref, platform) {
      calls.push({ method: "creatorInfo" });
      if (platform !== "tiktok") return null;
      return { privacyOptions: ["PUBLIC_TO_EVERYONE", "MUTUAL_FOLLOW_FRIENDS", "SELF_ONLY"], canPost: true, maxVideoSeconds: 600 };
    },
    validate: validateRequest,
    async submit(_ctx, req) {
      calls.push({ method: "submit", externalId: req.externalId, req });
      const b = behaviourFor(req.externalId);
      if (b === "fail") return { state: "failed", reason: "The fake platform refused the post.", retryable: false };
      if (b === "absent") throw new ProviderTimeout();
      delivered.set(req.externalId, req);
      if (b === "timeout-then-found") throw new ProviderTimeout();
      if (b === "publish") return published(req.externalId);
      return { state: "accepted", requestId: `req_${req.externalId}` };
    },
    async status(_ctx, ref) {
      calls.push({ method: "status", externalId: ref.externalId });
      const b = behaviourFor(ref.externalId);
      if (!delivered.has(ref.externalId)) return { state: "pending", requestId: ref.requestId };
      if (b === "awaiting_user") return { state: "awaiting_user", reason: "Finish it in the app." };
      const n = (polls.get(ref.externalId) ?? 0) + 1;
      polls.set(ref.externalId, n);
      if (n <= (fake.script.pollsUntilDone ?? 0)) return { state: "pending", requestId: `req_${ref.externalId}` };
      return published(ref.externalId);
    },
    async lookupByExternalId(_ctx, externalId) {
      calls.push({ method: "lookupByExternalId", externalId });
      return delivered.has(externalId) ? published(externalId) : "absent";
    },
    parseWebhook(rawBody, headers, secret): WebhookEvent {
      return parseUploadPostWebhook(rawBody, headers, secret);
    },
    async metrics() {
      calls.push({ method: "metrics" });
      const m = fake.script.metrics;
      if (!m) return null;
      return {
        views: null,
        likes: null,
        comments: null,
        shares: null,
        saves: null,
        profileVisits: null,
        follows: null,
        linkClicks: null,
        engagedViews: null,
        unknown: [],
        ...m,
      };
    },
  };
  return fake;
}

/** The registered instance (`publisher("fake")`). Tests may mutate `.script` and call `.reset()`. */
export const fakePublisher = definePublisher(createFakePublisher()) as FakePublisher;
