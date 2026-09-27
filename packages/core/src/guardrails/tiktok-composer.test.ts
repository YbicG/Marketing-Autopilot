// §8 "TikTok composer UX" (TikTok's Content Sharing guidelines): privacy has no default; interaction
// toggles start off; commercial content is disclosed; branded content can't be private; the consent
// line is TikTok's wording verbatim; creator_info limits apply. The no-watermark rule is tested in
// packages/video/src/guardrails/tiktok-watermark.test.ts (the spec lint lives in @mkt/video).
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  TIKTOK_BRANDED_CONTENT_CONSENT_TEXT,
  TIKTOK_BRANDED_NOT_PRIVATE_TEXT,
  TIKTOK_LABEL_PAID_PARTNERSHIP,
  TIKTOK_LABEL_PROMOTIONAL,
  TIKTOK_MUSIC_CONSENT_TEXT,
  TikTokOptions,
  tiktokConsentText,
  tiktokContentLabel,
} from "@mkt/contracts";
import { type Db } from "@mkt/db";
import { createTestDb } from "@mkt/db/testing";
import { approvePosts } from "../publishing/approvals.ts";
import { handlePublishDue } from "../publishing/due.ts";
import { addPost } from "../publishing/test-fixtures.ts";
import { validateTikTokComposer } from "../publishing/tiktok.ts";
import { approvedPost, postRow, sessionFor, SLOT, world } from "./harness.ts";

let db: Db;
let close: () => Promise<void>;
beforeAll(async () => {
  ({ db, close } = await createTestDb());
});
afterAll(() => close());

const base = { privacyLevel: "PUBLIC_TO_EVERYONE", musicConsent: true };
const issueCodes = (input: Parameters<typeof validateTikTokComposer>[0]) => validateTikTokComposer(input).issues.map((i) => i.code);

describe("§8 TikTok composer UX", () => {
  it("privacy has no default: the person must pick it", () => {
    expect(TikTokOptions.safeParse({ musicConsent: true }).success).toBe(false);
    expect(issueCodes({ options: { musicConsent: true }, creatorInfo: null })).toEqual(["tiktok.privacy_required"]);
    expect(issueCodes({ options: { ...base, privacyLevel: "" }, creatorInfo: null })).toContain("tiktok.privacy_required");
  });

  it("an approval without a chosen audience is refused", async () => {
    const w = await world(db, { platform: "tiktok" });
    const id = await addPost(db, w.s, SLOT, { platform: "tiktok", platformOptions: { musicConsent: true } });
    const r = await approvePosts(db, sessionFor(w.s), [id], { now: w.clock.now });
    expect(r.approved).toEqual([]);
    expect((await postRow(db, id)).state).toBe("pending_approval");
  });

  it("comments, duets and stitches start turned off", () => {
    const o = TikTokOptions.parse(base);
    expect([o.disableComment, o.disableDuet, o.disableStitch]).toEqual([true, true, true]);
    expect(o.commercialContent).toEqual({ enabled: false, yourBrand: false, brandedContent: false });
  });

  it("music consent must be given", () => {
    expect(issueCodes({ options: { privacyLevel: "PUBLIC_TO_EVERYONE" }, creatorInfo: null })).toEqual(["tiktok.music_consent"]);
    expect(issueCodes({ options: { ...base, musicConsent: false }, creatorInfo: null })).toEqual(["tiktok.music_consent"]);
  });

  it("commercial content must say whose brand, and gets TikTok's label", () => {
    expect(TikTokOptions.safeParse({ ...base, commercialContent: { enabled: true } }).success).toBe(false);
    const own = TikTokOptions.parse({ ...base, commercialContent: { enabled: true, yourBrand: true } });
    expect(tiktokContentLabel(own)).toBe(TIKTOK_LABEL_PROMOTIONAL);
    const paid = TikTokOptions.parse({ ...base, commercialContent: { enabled: true, brandedContent: true } });
    expect(tiktokContentLabel(paid)).toBe(TIKTOK_LABEL_PAID_PARTNERSHIP);
    expect(tiktokContentLabel(TikTokOptions.parse(base))).toBeNull();
  });

  it("branded content can't be private", () => {
    const r = validateTikTokComposer({ options: { ...base, privacyLevel: "SELF_ONLY", commercialContent: { enabled: true, brandedContent: true } }, creatorInfo: null });
    expect(r.issues).toEqual([{ code: "tiktok.branded_private", message: TIKTOK_BRANDED_NOT_PRIVATE_TEXT, severity: "block" }]);
  });

  it("the consent line is TikTok's wording, verbatim", () => {
    expect(TIKTOK_MUSIC_CONSENT_TEXT).toBe("By posting, you agree to TikTok's Music Usage Confirmation.");
    expect(TIKTOK_BRANDED_CONTENT_CONSENT_TEXT).toBe("By posting, you agree to TikTok's Branded Content Policy and Music Usage Confirmation.");
    expect(tiktokConsentText(TikTokOptions.parse(base))).toBe(TIKTOK_MUSIC_CONSENT_TEXT);
    expect(tiktokConsentText(TikTokOptions.parse({ ...base, commercialContent: { enabled: true, brandedContent: true } }))).toBe(TIKTOK_BRANDED_CONTENT_CONSENT_TEXT);
  });

  it("creator_info limits: can't post, audience not offered, toggles the account locked, video too long", () => {
    const ci = { privacyOptions: ["PUBLIC_TO_EVERYONE", "SELF_ONLY"], canPost: true };
    expect(issueCodes({ options: base, creatorInfo: ci })).toEqual([]);
    expect(issueCodes({ options: base, creatorInfo: { ...ci, canPost: false } })).toEqual(["tiktok.cannot_post"]);
    expect(issueCodes({ options: { ...base, privacyLevel: "MUTUAL_FOLLOW_FRIENDS" }, creatorInfo: ci })).toEqual(["tiktok.privacy_unavailable"]);
    const on = { ...base, disableComment: false, disableDuet: false, disableStitch: false };
    expect(issueCodes({ options: on, creatorInfo: { ...ci, commentDisabled: true, duetDisabled: true, stitchDisabled: true } })).toEqual([
      "tiktok.comments_off",
      "tiktok.duet_off",
      "tiktok.stitch_off",
    ]);
    expect(issueCodes({ options: base, creatorInfo: { ...ci, maxVideoSeconds: 60 }, videoSeconds: 61 })).toEqual(["tiktok.too_long"]);
  });

  it("publish time: creator_info is read again and a disallowed audience holds the post", async () => {
    const w = await world(db, { platform: "tiktok" });
    w.adapter.creatorInfo = async () => ({ privacyOptions: ["SELF_ONLY"], canPost: true });
    const id = await approvedPost(w, { platform: "tiktok", platformOptions: base });
    expect(await handlePublishDue(w.deps, { postId: id, generation: 1 })).toBe("failed");
    expect(w.adapter.submits).toHaveLength(0);
    expect((await postRow(db, id)).lastError).toBe("This account doesn't allow that audience setting. Pick another.");
  });

  it.todo("the composer shows the consent line under the Post button and no preselected audience — apps/web (Playwright suite)");
});
