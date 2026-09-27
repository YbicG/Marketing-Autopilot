// §8 "Volume caps": 2 per platform per day per product; 2 per day per shared account (max 3);
// warm-up; TikTok 15/day and 5 pending drafts; SEO 2/week (M5).
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type Db } from "@mkt/db";
import { createTestDb } from "@mkt/db/testing";
import { CONNECTION_HARD_MAX, PRODUCT_PLATFORM_DAILY_CAP, WARMUP_DAILY, checkCaps, type CapConnection, type CapPost } from "../publishing/caps.ts";
import { handlePublishDue } from "../publishing/due.ts";
import { addPost } from "../publishing/test-fixtures.ts";
import { TIKTOK_API_DAILY_CAP, TIKTOK_HARD_DAILY_MAX, TIKTOK_MAX_PENDING_DRAFTS, tiktokDailyLimit, validateTikTokComposer } from "../publishing/tiktok.ts";
import { approvedPost, postRow, SLOT, world } from "./harness.ts";

let db: Db;
let close: () => Promise<void>;
beforeAll(async () => {
  ({ db, close } = await createTestDb());
});
afterAll(() => close());

const TZ = "America/New_York";
const OLD = new Date("2026-01-01T00:00:00Z");
const conn = (id: string, over: Partial<CapConnection> = {}): CapConnection => ({ id, platform: "threads", handle: id, shared: false, maxPerDay: 3, warmupUntil: null, createdAt: OLD, ...over });
let n = 0;
const sent = (over: Partial<CapPost> = {}): CapPost => ({ id: `p${++n}`, productId: "prodA", platform: "threads", connectionId: "c1", scheduledAt: new Date(SLOT.getTime() - 3_600_000), state: "published", ...over });
const me = (over: Partial<CapPost> = {}): CapPost => ({ id: "zz-me", productId: "prodA", platform: "threads", connectionId: "c1", scheduledAt: SLOT, state: "preparing", ...over });
const codes = (post: CapPost, others: CapPost[], connections: CapConnection[]) => checkCaps({ post, others, connections, tz: TZ, mode: "prepare" }).map((i) => i.code);

describe("§8 Volume caps", () => {
  it("2 posts per platform per day per product", () => {
    expect(PRODUCT_PLATFORM_DAILY_CAP).toBe(2);
    const c = [conn("c1"), conn("c2")];
    expect(codes(me(), [sent()], c)).toEqual([]);
    // Two already out on Threads for this product, from different accounts: the third is held.
    expect(codes(me(), [sent(), sent({ connectionId: "c2" })], c)).toContain("cap.product_platform");
    // Other products and other platforms don't count.
    expect(codes(me(), [sent({ productId: "prodB" }), sent({ platform: "x", connectionId: "c2" })], c)).toEqual([]);
  });

  it("the day is the workspace's local day, not UTC", () => {
    // SLOT is Oct 20 7:30 pm in New York (Oct 20 23:30 UTC).
    const sameLocalDay = sent({ scheduledAt: new Date("2026-10-20T14:00:00Z") });
    const nextLocalDay = sent({ scheduledAt: new Date("2026-10-21T05:00:00Z") }); // 1 am Oct 21 local
    expect(codes(me(), [sameLocalDay, sent({ scheduledAt: new Date("2026-10-20T15:00:00Z"), connectionId: "c2" })], [conn("c1"), conn("c2")])).toContain("cap.product_platform");
    expect(codes(me(), [nextLocalDay, sent({ scheduledAt: new Date("2026-10-21T06:00:00Z"), connectionId: "c2" })], [conn("c1"), conn("c2")])).toEqual([]);
  });

  it("a shared personal account counts every product's posts, and never goes above 3 a day", () => {
    expect(CONNECTION_HARD_MAX).toBe(3);
    const shared = [conn("c1", { shared: true, handle: "cj", maxPerDay: 2 }), conn("c9", { shared: true, handle: "@CJ", maxPerDay: 2 })];
    const other = sent({ productId: "prodB", connectionId: "c9" });
    const other2 = sent({ productId: "prodC", connectionId: "c9" });
    expect(codes(me(), [other], shared)).toEqual([]);
    expect(codes(me(), [other, other2], shared)).toContain("cap.account");
    // A connection asking for 10 a day is still held at 3.
    const greedy = [conn("c1", { maxPerDay: 10 })];
    const three = [sent({ platform: "threads", productId: "p1" }), sent({ productId: "p2" }), sent({ productId: "p3" })];
    expect(codes(me(), three, greedy)).toContain("cap.account");
  });

  it("an account in warm-up posts once a day", () => {
    expect(WARMUP_DAILY).toBe(1);
    const warm = [conn("c1", { warmupUntil: new Date(SLOT.getTime() + 86_400_000) })];
    expect(codes(me(), [sent()], warm)).toContain("cap.warmup");
  });

  it("TikTok: 1 a day in week one, then at most 2 (the API allows 15)", () => {
    expect(TIKTOK_API_DAILY_CAP).toBe(15);
    expect(TIKTOK_HARD_DAILY_MAX).toBeLessThanOrEqual(TIKTOK_API_DAILY_CAP);
    expect(tiktokDailyLimit({ warmupUntil: null, createdAt: new Date(SLOT.getTime() - 2 * 86_400_000), maxPerDay: 3 }, SLOT)).toBe(1);
    expect(tiktokDailyLimit({ warmupUntil: null, createdAt: OLD, maxPerDay: 15 }, SLOT)).toBe(TIKTOK_HARD_DAILY_MAX);
    const tk = [conn("c1", { platform: "tiktok" })];
    expect(codes(me({ platform: "tiktok" }), [sent({ platform: "tiktok" }), sent({ platform: "tiktok", productId: "prodB" })], tk)).toContain("cap.tiktok");
  });

  it("TikTok: no new draft while 5 are waiting in the inbox", () => {
    expect(TIKTOK_MAX_PENDING_DRAFTS).toBe(5);
    const options = { privacyLevel: "PUBLIC_TO_EVERYONE", musicConsent: true, postMode: "drafts" };
    expect(validateTikTokComposer({ options, creatorInfo: null, pendingDrafts: 4 }).issues).toEqual([]);
    expect(validateTikTokComposer({ options, creatorInfo: null, pendingDrafts: 5 }).issues.map((i) => i.code)).toEqual(["tiktok.drafts_full"]);
  });

  it("publish time: the third Threads post of the day for a product is held", async () => {
    const w = await world(db);
    await addPost(db, w.s, new Date(SLOT.getTime() - 7_200_000), { state: "published" });
    await addPost(db, w.s, new Date(SLOT.getTime() - 3_600_000), { state: "published" });
    const id = await approvedPost(w);
    expect(await handlePublishDue(w.deps, { postId: id, generation: 1 })).toBe("failed");
    expect(w.adapter.submits).toHaveLength(0);
    expect((await postRow(db, id)).lastError).toMatch(/Already 2 threads posts for this product that day/);
  });

  it.todo("SEO pages: at most 2 a week — M5 (SEO generator not built)");
});
