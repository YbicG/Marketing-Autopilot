import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { definePublisher } from "../core/registry.ts";
import { httpRequest, ProviderTimeout } from "../core/http.ts";
import { verifyHmacSha256 } from "../core/hmac.ts";
import type { Platform, PostType, ProviderCtx, PublisherAdapter, PublishMedia, PublishRequest } from "../core/types.ts";
import { aiFlagsForTier, PLATFORM_CAPS } from "./caps.ts";
import { createFakePublisher } from "./fake.ts";
import {
  buildSubmitRequest,
  createUploadPost,
  durationToExpiry,
  mapHealth,
  mapHistoryResponse,
  mapMetrics,
  mapStatusResponse,
  mapSubmitResponse,
  parseUploadPostWebhook,
  profileUsername,
  toFormData,
  validateRequest,
  WebhookSignatureError,
} from "./upload-post.ts";

const media = (n: number, mime = "image/jpeg"): PublishMedia[] =>
  Array.from({ length: n }, (_, i) => ({
    assetId: `a${i}`,
    sha256: `h${i}`,
    mime,
    filename: `f${i}.${mime.split("/")[1]}`,
    open: async () => new Uint8Array([i, 1, 2]),
  }));

function req(platform: Platform, postType: PostType, over: Partial<PublishRequest> = {}): PublishRequest {
  return {
    externalId: "pst_0192_g1",
    profileRef: "syllacal",
    platform,
    postType,
    text: "Plan your whole semester in 5 minutes.",
    media: postType === "text" ? [] : postType === "video" ? media(1, "video/mp4") : postType === "carousel" ? media(3) : media(1),
    options: {},
    aiFlags: {},
    ...over,
  };
}

const fieldsOf = (fields: [string, string][]) => {
  const out: Record<string, string[]> = {};
  for (const [k, v] of fields) (out[k] ??= []).push(v);
  return out;
};

describe("buildSubmitRequest", () => {
  it("TikTok video: direct post, inbox fallback off, toggles, brand flags and AIGC", () => {
    const b = buildSubmitRequest(
      req("tiktok", "video", {
        options: { privacy_level: "PUBLIC_TO_EVERYONE", disable_comment: true, disableDuet: false, brand_organic_toggle: true, auto_add_music: true, junk: "x" },
        aiFlags: { is_aigc: true },
      }),
      { apiKey: "k1" },
    );
    expect(b.url).toBe("https://api.upload-post.com/api/upload");
    expect(b.headers.Authorization).toBe("Apikey k1");
    expect(b.headers["Idempotency-Key"]).toBe("pst_0192_g1");
    const f = fieldsOf(b.fields);
    expect(f).toMatchObject({
      user: ["syllacal"],
      "platform[]": ["tiktok"],
      title: ["Plan your whole semester in 5 minutes."],
      external_id: ["pst_0192_g1"],
      request_id: ["pst_0192_g1"],
      async_upload: ["true"],
      post_mode: ["DIRECT_POST"],
      disable_inbox_fallback: ["true"],
      privacy_level: ["PUBLIC_TO_EVERYONE"],
      disable_comment: ["true"],
      disable_duet: ["false"],
      brand_organic_toggle: ["true"],
      is_aigc: ["true"],
    });
    expect(f.junk).toBeUndefined();
    expect(f.auto_add_music).toBeUndefined(); // photo-only option
    expect(b.files).toHaveLength(1);
    expect(b.files[0]!.field).toBe("video");
  });

  it("TikTok photo: photos[], short title + description, auto_add_music, drafts option", () => {
    const b = buildSubmitRequest(
      req("tiktok", "carousel", {
        title: "5-minute semester",
        options: { privacy: "SELF_ONLY", autoAddMusic: true, disable_duet: true, send_to_drafts: true },
      }),
      { apiKey: "k" },
    );
    expect(b.endpoint).toBe("upload_photos");
    const f = fieldsOf(b.fields);
    expect(f.title).toEqual(["5-minute semester"]);
    expect(f.description).toEqual(["Plan your whole semester in 5 minutes."]);
    expect(f.auto_add_music).toEqual(["true"]);
    expect(f.privacy_level).toEqual(["SELF_ONLY"]);
    expect(f.disable_duet).toBeUndefined();
    expect(f.post_mode).toEqual(["MEDIA_UPLOAD"]);
    expect(f.disable_inbox_fallback).toBeUndefined();
    expect(b.files.map((x) => x.field)).toEqual(["photos[]", "photos[]", "photos[]"]);
  });

  it("IG carousel: IMAGE media type and is_ai_generated on the post", () => {
    const b = buildSubmitRequest(req("instagram", "carousel", { aiFlags: { is_ai_generated: true, is_aigc: true } }), { apiKey: "k" });
    const f = fieldsOf(b.fields);
    expect(b.url.endsWith("/api/upload_photos")).toBe(true);
    expect(f.media_type).toEqual(["IMAGE"]);
    expect(f.is_ai_generated).toEqual(["true"]);
    expect(f.is_aigc).toBeUndefined(); // not an Instagram flag
  });

  it("YouTube: title/description split, made-for-kids alias, synthetic media, tags array", () => {
    const b = buildSubmitRequest(
      req("youtube", "video", { title: "SyllaCal in 30 seconds", options: { madeForKids: false, privacyStatus: "public", tags: ["study", "college"] }, aiFlags: { containsSyntheticMedia: false } }),
      { apiKey: "k" },
    );
    const f = fieldsOf(b.fields);
    expect(f.title).toEqual(["SyllaCal in 30 seconds"]);
    expect(f.description).toEqual(["Plan your whole semester in 5 minutes."]);
    expect(f.selfDeclaredMadeForKids).toEqual(["false"]);
    expect(f.containsSyntheticMedia).toEqual(["false"]);
    expect(f["tags[]"]).toEqual(["study", "college"]);
  });

  it("X: made_with_ai only on media posts; text goes to upload_text with no files", () => {
    const media = buildSubmitRequest(req("x", "image", { aiFlags: { made_with_ai: true } }), { apiKey: "k" });
    expect(fieldsOf(media.fields).made_with_ai).toEqual(["true"]);
    expect(fieldsOf(media.fields)["platform[]"]).toEqual(["x"]);
    const text = buildSubmitRequest(req("x", "text", { aiFlags: { made_with_ai: true } }), { apiKey: "k" });
    expect(text.endpoint).toBe("upload_text");
    expect(text.files).toEqual([]);
    expect(fieldsOf(text.fields).made_with_ai).toBeUndefined();
  });

  it("Threads text with a first comment and no AI flag passthrough", () => {
    const b = buildSubmitRequest(req("threads", "text", { firstComment: "Link in bio", aiFlags: { is_ai_generated: true }, options: { threads_topic_tag: "College" } }), { apiKey: "k" });
    const f = fieldsOf(b.fields);
    expect(b.url.endsWith("/api/upload_text")).toBe(true);
    expect(f.first_comment).toEqual(["Link in bio"]);
    expect(f.threads_topic_tag).toEqual(["College"]);
    expect(f.is_ai_generated).toBeUndefined();
  });

  it("LinkedIn document: sync endpoint, document field, title + commentary", () => {
    const b = buildSubmitRequest(req("linkedin", "document", { title: "Semester planner guide", media: media(1, "application/pdf") }), { apiKey: "k" });
    const f = fieldsOf(b.fields);
    expect(b.endpoint).toBe("upload_document");
    expect(f.async_upload).toBeUndefined();
    expect(f.title).toEqual(["Semester planner guide"]);
    expect(b.files[0]!.field).toBe("document");
  });

  it("builds multipart with the file bytes", async () => {
    const { form, bytes } = await toFormData(buildSubmitRequest(req("instagram", "carousel"), { apiKey: "k" }));
    expect(bytes).toBe(9);
    expect(form.getAll("photos[]")).toHaveLength(3);
    expect(form.get("user")).toBe("syllacal");
  });
});

describe("AI flags per provenance tier (§5.8)", () => {
  it("maps tiers to each platform's flag", () => {
    expect(aiFlagsForTier("tiktok", "B")).toEqual({ flags: { is_aigc: true }, needsCaptionLabel: false });
    expect(aiFlagsForTier("instagram", "C").flags).toEqual({ is_ai_generated: true });
    expect(aiFlagsForTier("youtube", "B").flags).toEqual({ containsSyntheticMedia: false });
    expect(aiFlagsForTier("youtube", "C").flags).toEqual({ containsSyntheticMedia: true });
    expect(aiFlagsForTier("x", "B").flags).toEqual({ made_with_ai: true });
    expect(aiFlagsForTier("x", "A").flags).toEqual({ made_with_ai: false });
    expect(aiFlagsForTier("threads", "B")).toEqual({ flags: {}, needsCaptionLabel: true });
    expect(aiFlagsForTier("linkedin", "A")).toEqual({ flags: {}, needsCaptionLabel: false });
  });
});

describe("validateRequest", () => {
  const codes = (r: PublishRequest) => validateRequest(r).map((i) => `${i.severity}:${i.code}`);

  it("TikTok needs a privacy choice; branded content can't be private", () => {
    expect(codes(req("tiktok", "video"))).toContain("block:tiktok_privacy_required");
    expect(codes(req("tiktok", "video", { options: { privacy_level: "SELF_ONLY", brand_content_toggle: true } }))).toContain("block:tiktok_branded_private");
    expect(codes(req("tiktok", "video", { options: { privacy_level: "PUBLIC_TO_EVERYONE" } }))).toEqual([]);
  });

  it("caption limits: X blocks, Threads text splits, Threads counts bytes", () => {
    expect(codes(req("x", "text", { text: "a".repeat(281) }))).toContain("block:caption_too_long");
    expect(codes(req("threads", "text", { text: "a".repeat(501) }))).toEqual(["warn:caption_split"]);
    expect(codes(req("threads", "image", { text: "😀".repeat(126) }))).toContain("block:caption_too_long");
  });

  it("carousel counts, YouTube title + kids, X links, unsupported AI flags", () => {
    expect(codes(req("x", "carousel", { media: media(5) }))).toContain("block:carousel_too_big");
    expect(codes(req("instagram", "carousel", { media: media(1) }))).toContain("block:carousel_too_small");
    const yt = codes(req("youtube", "video"));
    expect(yt).toContain("block:title_required");
    expect(yt).toContain("block:youtube_made_for_kids_required");
    expect(codes(req("x", "text", { text: "see https://syllacal.com" }))).toContain("warn:links_removed");
    expect(codes(req("linkedin", "image", { aiFlags: { is_ai_generated: true } }))).toContain("warn:ai_flag_unsupported");
    expect(codes(req("instagram", "image", { media: media(1, "image/webp") }))).toContain("block:media_type_unsupported");
  });
});

describe("response mapping", () => {
  it("submit", () => {
    expect(mapSubmitResponse(200, { success: true, request_id: "r1" }, "x", "e")).toEqual({ state: "accepted", requestId: "r1" });
    expect(mapSubmitResponse(202, { success: true, job_id: "j1" }, "x", "e")).toEqual({ state: "accepted", requestId: "job:j1" });
    expect(mapSubmitResponse(200, { success: true, results: { instagram: { success: true, url: "https://i/p/1" } } }, "instagram", "e")).toMatchObject({
      state: "published",
      url: "https://i/p/1",
    });
    expect(mapSubmitResponse(200, { results: { linkedin: { success: false, error: "Expired access token" } } }, "linkedin", "e")).toEqual({
      state: "failed",
      reason: "Expired access token",
      retryable: false,
    });
    expect(mapSubmitResponse(503, null, "x", "e")).toMatchObject({ state: "failed", retryable: true });
    expect(mapSubmitResponse(429, {}, "x", "e")).toMatchObject({ state: "failed", retryable: true });
    expect(mapSubmitResponse(400, { message: "Invalid platform" }, "x", "e")).toEqual({ state: "failed", reason: "Invalid platform", retryable: false });
    expect(mapSubmitResponse(409, {}, "x", "e")).toEqual({ state: "pending", requestId: "e" });
  });

  it("status", () => {
    expect(mapStatusResponse(404, {}, "x")).toBe("absent");
    expect(mapStatusResponse(200, { status: "not_found" })).toBe("absent");
    expect(mapStatusResponse(200, { request_id: "r", status: "in_progress", results: [{ platform: "x", success: true, message: "Queued" }] }, "x")).toEqual({
      state: "pending",
      requestId: "r",
    });
    expect(mapStatusResponse(200, { request_id: "r", status: "completed", results: [{ platform: "x", success: true, post_url: "https://x.com/s/1" }] }, "x")).toMatchObject({
      state: "published",
      url: "https://x.com/s/1",
    });
    expect(mapStatusResponse(200, { status: "processing", results: [{ platform: "tiktok", success: true, fallback_to_inbox: true }] }, "tiktok")).toMatchObject({
      state: "awaiting_user",
    });
    expect(
      mapStatusResponse(200, { status: "failed", results: [{ platform: "tiktok", success: false, error_code: "reached_active_user_cap", error: "cap" }] }, "tiktok"),
    ).toMatchObject({ state: "failed", retryable: false });
    expect(mapStatusResponse(500, {})).toEqual({ state: "pending", requestId: undefined });
  });

  it("history", () => {
    expect(mapHistoryResponse({ history: [] })).toBe("absent");
    expect(
      mapHistoryResponse({
        history: [
          { platform: "tiktok", success: false, error_message: "old", upload_timestamp: "2026-10-01T00:00:00Z" },
          { platform: "tiktok", success: true, post_url: "https://t/1", platform_post_id: "7", request_id: "r", upload_timestamp: "2026-10-02T00:00:00Z" },
        ],
      }),
    ).toEqual({ state: "published", requestId: "r", postId: "7", url: "https://t/1" });
  });

  it("metrics: zeros are unknown, nothing known is null", () => {
    const m = mapMetrics({ platforms: { tiktok: { post_metrics: { views: 120, likes: 0, shares: 3, profile_views: 4 } } } }, "tiktok");
    expect(m).toMatchObject({ views: 120, likes: null, shares: 3, profileVisits: 4 });
    expect(m!.unknown).toContain("likes");
    expect(mapMetrics({ platforms: { tiktok: { post_metrics: {} } } }, "tiktok")).toBeNull();
  });

  it("health and connect-link expiry", () => {
    const h = mapHealth({ profile: { social_accounts: { tiktok: { handle: "syllacal" }, instagram: "", youtube: { display_name: "S", reauth_required: true } } } });
    expect(h).toEqual([
      { platform: "tiktok", handle: "syllacal", status: "active", tokenExpiresAt: undefined },
      { platform: "youtube", handle: "S", status: "reauth_required", tokenExpiresAt: undefined },
    ]);
    expect(durationToExpiry("48h", 0)).toBe(new Date(48 * 3_600_000).toISOString());
    expect(profileUsername("SyllaCal App!")).toBe("syllacal-app");
  });
});

describe("webhooks", () => {
  const secret = "whsec_test";
  const now = 1_790_000_000_000;
  const sign = (body: string, ts = String(now / 1000)) => ({
    "X-Upload-Post-Signature": `sha256=${createHmac("sha256", secret).update(`${ts}.${body}`).digest("hex")}`,
    "X-Upload-Post-Timestamp": ts,
    "X-Upload-Post-Delivery": "dlv_1",
  });

  it("parses upload_completed, failure, inbox fallback and reauth", () => {
    const ok = JSON.stringify({ event: "upload_completed", job_id: "j1", platform: "instagram", result: { success: true, url: "https://i/p/1", post_id: "17" } });
    expect(parseUploadPostWebhook(ok, sign(ok), secret, now)).toEqual({
      kind: "upload_completed",
      eventId: "dlv_1",
      externalId: undefined,
      requestId: "j1",
      platform: "instagram",
      postId: "17",
      url: "https://i/p/1",
    });
    const bad = JSON.stringify({ event: "upload_completed", platform: "twitter", result: { success: false, error: "Duplicate" } });
    expect(parseUploadPostWebhook(bad, sign(bad), secret, now)).toMatchObject({ kind: "upload_failed", reason: "Duplicate", platform: "x" });
    const inbox = JSON.stringify({ event: "upload_completed", platform: "tiktok", result: { success: true, fallback_to_inbox: true } });
    expect(parseUploadPostWebhook(inbox, sign(inbox), secret, now)).toMatchObject({ kind: "inbox_fallback" });
    const re = JSON.stringify({ event: "social_account_reauth_required", platform: "youtube", profile_username: "syllacal" });
    expect(parseUploadPostWebhook(re, sign(re), secret, now)).toMatchObject({ kind: "reauth_required", profileRef: "syllacal", platform: "youtube" });
    const other = JSON.stringify({ event: "social_account_connected" });
    expect(parseUploadPostWebhook(other, sign(other), secret, now)).toEqual({ kind: "ignored", eventId: "dlv_1", type: "social_account_connected" });
  });

  it("rejects bad signatures, tampering and stale timestamps", () => {
    const body = JSON.stringify({ event: "upload_completed" });
    const h = sign(body);
    expect(() => parseUploadPostWebhook(body + " ", h, secret, now)).toThrow(WebhookSignatureError);
    expect(() => parseUploadPostWebhook(body, h, "other", now)).toThrow(WebhookSignatureError);
    expect(() => parseUploadPostWebhook(body, h, secret, now + 10 * 60_000)).toThrow(/stale/);
    expect(() => parseUploadPostWebhook(body, {}, secret, now)).toThrow(/missing/);
  });

  it("verifyHmacSha256 accepts prefixed hex, bare hex and base64", () => {
    const mac = createHmac("sha256", "s").update("body").digest();
    expect(verifyHmacSha256("body", `sha256=${mac.toString("hex")}`, "s")).toBe(true);
    expect(verifyHmacSha256("body", mac.toString("hex").toUpperCase(), "s")).toBe(true);
    expect(verifyHmacSha256("body", mac.toString("base64"), "s")).toBe(true);
    expect(verifyHmacSha256("body", mac.toString("base64url"), "s")).toBe(true);
    expect(verifyHmacSha256("body!", mac.toString("hex"), "s")).toBe(false);
    expect(verifyHmacSha256("body", "sha256=zz", "s")).toBe(false);
    expect(verifyHmacSha256("body", null, "s")).toBe(false);
  });
});

describe("adapter over a fake fetch", () => {
  const ctx: ProviderCtx = { secret: async (p) => (p === "upload_post.api_key" ? "key" : null) };
  const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

  it("lookupByExternalId: status first, then history, absent only if both miss", async () => {
    const seen: string[] = [];
    const adapter = createUploadPost({
      fetch: async (url) => {
        seen.push(url);
        if (url.includes("/status")) return json(404, { status: "not_found" });
        return json(200, { history: [] });
      },
    });
    expect(await adapter.lookupByExternalId(ctx, "pst_1_g1")).toBe("absent");
    expect(seen[0]).toContain("/api/uploadposts/status?request_id=pst_1_g1");
    expect(seen[1]).toContain("/api/uploadposts/history?limit=10&external_id=pst_1_g1");

    const running = createUploadPost({ fetch: async () => json(200, { status: "processing", request_id: "pst_1_g1" }) });
    expect(await running.lookupByExternalId(ctx, "pst_1_g1")).toEqual({ state: "pending", requestId: "pst_1_g1" });
  });

  it("submit posts multipart and maps an async ack; missing key throws", async () => {
    let body: unknown;
    const adapter = createUploadPost({
      fetch: async (url, init) => {
        expect(url).toBe("https://api.upload-post.com/api/upload_photos");
        body = init.body;
        return json(200, { success: true, request_id: "r9" });
      },
    });
    expect(await adapter.submit(ctx, req("instagram", "carousel"))).toEqual({ state: "accepted", requestId: "r9" });
    expect(body).toBeInstanceOf(FormData);
    await expect(adapter.submit({ secret: async () => null }, req("x", "text"))).rejects.toThrow(/Upload-Post API key/);
  });

  it("ensureProfile treats 409 as already there", async () => {
    const adapter = createUploadPost({ fetch: async () => json(409, { success: false }) });
    expect(await adapter.ensureProfile(ctx, "SyllaCal")).toEqual({ profileRef: "syllacal" });
  });
});

describe("http deadline", () => {
  it("aborts a hung request with ProviderTimeout", async () => {
    const hang = (_u: string, init: RequestInit) =>
      new Promise<Response>((_, reject) => init.signal!.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError"))));
    await expect(httpRequest("https://x.test", { fetch: hang, timeoutMs: 20 })).rejects.toBeInstanceOf(ProviderTimeout);
  });
});

describe("registry", () => {
  it("definePublisher refuses assisted-only venues", () => {
    const bad = { ...createFakePublisher(), meta: { id: "bad", kind: "publish" as const, requiredSecrets: [] }, platforms: ["reddit"] as unknown as Platform[] };
    expect(() => definePublisher(bad as PublisherAdapter)).toThrow(/assisted-only/);
  });

  it("every platform has caps", () => {
    for (const p of createUploadPost().platforms) expect(PLATFORM_CAPS[p].platform).toBe(p);
  });
});

describe("fake publisher", () => {
  const ctx: ProviderCtx = { secret: async () => null };

  it("scripts accept → poll → published, fail, timeout-then-found and absent", async () => {
    const f = createFakePublisher({ behaviour: "accept", pollsUntilDone: 1, byExternalId: { f: "fail", t: "timeout-then-found", a: "absent" } });
    expect(await f.submit(ctx, req("x", "text", { externalId: "ok" }))).toEqual({ state: "accepted", requestId: "req_ok" });
    expect((await f.status(ctx, { externalId: "ok" })).state).toBe("pending");
    expect((await f.status(ctx, { externalId: "ok" })).state).toBe("published");
    expect((await f.submit(ctx, req("x", "text", { externalId: "f" }))).state).toBe("failed");
    await expect(f.submit(ctx, req("x", "text", { externalId: "t" }))).rejects.toBeInstanceOf(ProviderTimeout);
    expect(await f.lookupByExternalId(ctx, "t")).toMatchObject({ state: "published" });
    await expect(f.submit(ctx, req("x", "text", { externalId: "a" }))).rejects.toBeInstanceOf(ProviderTimeout);
    expect(await f.lookupByExternalId(ctx, "a")).toBe("absent");
    expect(f.delivered.size).toBe(2);
  });
});
