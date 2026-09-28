// §8 "Unique content per account": trigram Jaccard < 0.6 per connection over 14 days (block on X,
// warn elsewhere); one opening line per master per account; video scene (dHash) spacing.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { GENERATORS, type PostVariant } from "@mkt/contracts";
import { schema, uuidv7, type Db } from "@mkt/db";
import { createTestDb } from "@mkt/db/testing";
import { planCalendar } from "../engine/calendar.ts";
import { saveTextVariant } from "../engine/editor.ts";
import { buildRecipe } from "../engine/recipe.ts";
import { SIMILARITY_LIMIT, SIMILARITY_WINDOW_DAYS, trigramJaccard, validateVariant } from "../engine/validate.ts";
import { addPost, type Seeded } from "../publishing/test-fixtures.ts";
import { approvePosts, uiSessionFromCookie } from "../publishing/approvals.ts";
import { ensureVideoPosts } from "../video/editor.ts";
import { overlapIssues, platformIssues } from "../video/qa-rules.ts";
import { seedVideoWorld } from "../video/testing.ts";
import { SLOT, world } from "./harness.ts";

let db: Db;
let close: () => Promise<void>;
beforeAll(async () => {
  ({ db, close } = await createTestDb());
});
afterAll(() => close());

const A = "Syllabus week, done in 15 seconds. Drop in the PDF and every deadline lands in your calendar.";
const A2 = "Syllabus week, done in 15 seconds! Drop in the PDF and every deadline lands in your calendar";
const B = "Hell week is coming. See every exam and paper stacked up before it hits, so nothing sneaks up.";

const post = (text: string, platform: PostVariant["platform"]): PostVariant => ({
  platform,
  text,
  parts: [],
  hashtags: [],
  linkToken: null,
  altText: null,
  firstComment: null,
  claimRefs: [],
});
const ctx = (platform: "x" | "threads", recentTexts: string[]) => ({ platform, format: "text" as const, scheduledAt: SLOT, claims: new Map(), recentTexts, xLinksAllowed: false });

/** Another content item + variant + post on the same connection, `days` from the slot. */
async function otherPostOnConnection(s: Seeded, platform: string, text: string, days: number) {
  const contentItemId = uuidv7();
  await db.insert(schema.contentItems).values({ id: contentItemId, workspaceId: s.workspaceId, campaignId: s.campaignId, angleId: s.angleId, deliverableKey: `post:${contentItemId}`, kind: "post", claimIds: [] });
  const variantId = uuidv7();
  await db.insert(schema.variants).values({
    id: variantId,
    workspaceId: s.workspaceId,
    contentItemId,
    platform,
    body: { schemaVersion: 1, kind: "post", variant: post(text, platform as PostVariant["platform"]) },
    assetIds: [],
    contentHash: `v-${variantId}`,
  });
  await addPost(db, s, new Date(SLOT.getTime() + days * 86_400_000), { variantId, platform });
}

describe("§8 Unique content per account", () => {
  it("trigram Jaccard: near copies score over the limit, different posts under it", () => {
    expect(SIMILARITY_LIMIT).toBe(0.6);
    expect(SIMILARITY_WINDOW_DAYS).toBe(14);
    expect(trigramJaccard(A, A2)).toBeGreaterThanOrEqual(SIMILARITY_LIMIT);
    expect(trigramJaccard(A, B)).toBeLessThan(SIMILARITY_LIMIT);
    // Links and punctuation don't make a copy look new.
    expect(trigramJaccard(`${A} {{link:landing}}`, `${A} https://syllacal.com/?x=1`)).toBe(1);
  });

  it("blocks on X, warns elsewhere", () => {
    expect(validateVariant(post(A, "x"), ctx("x", [A2])).map((i) => `${i.code}:${i.severity}`)).toContain("too_similar:block");
    expect(validateVariant(post(A, "threads"), ctx("threads", [A2])).map((i) => `${i.code}:${i.severity}`)).toContain("too_similar:warn");
    expect(validateVariant(post(A, "x"), ctx("x", [B])).map((i) => i.code)).not.toContain("too_similar");
  });

  it("editor save compares against other posts on the same connection within 14 days only", async () => {
    const w = await world(db, { platform: "x" });
    await addPost(db, w.s, SLOT, { platform: "x" });
    await otherPostOnConnection(w.s, "x", A2, 20); // outside the window: ignored
    const first = await saveTextVariant(db, w.s.workspaceId, w.s.variantId, { text: A }, w.clock.now);
    expect(first.ok && first.issues.map((i) => i.code)).not.toContain("too_similar");

    await otherPostOnConnection(w.s, "x", A2, 3); // inside the window
    const second = await saveTextVariant(db, w.s.workspaceId, w.s.variantId, { text: A }, w.clock.now);
    expect(second.ok && second.issues.map((i) => `${i.code}:${i.severity}`)).toContain("too_similar:block");
  });

  it("the calendar gives each account one opening line per master", () => {
    const plan = planCalendar({ recipe: buildRecipe("web_b2c", "standard", { generators: [...GENERATORS] }), launchDate: "2026-10-20", timezone: "America/New_York" });
    const video = plan.slots.filter((s) => s.kind === "video");
    expect(video.length).toBeGreaterThan(0);
    const perMaster = new Map<number, number[]>();
    for (const s of video) perMaster.set(s.masterIdx!, [...(perMaster.get(s.masterIdx!) ?? []), s.hookIdx!]);
    for (const hooks of perMaster.values()) expect(new Set(hooks).size).toBe(hooks.length);
    const seen = new Set(video.map((s) => `${s.platform}|${s.masterIdx}`));
    expect(seen.size).toBe(video.length);
  });

  it("videos sharing most scenes with a recent one are flagged (dHash contact sheets)", () => {
    const tiles = Array.from({ length: 9 }, (_, i) => i.toString(16).repeat(16));
    expect(overlapIssues(tiles, [{ label: "another video", hashes: tiles }]).map((i) => i.code)).toEqual(["scene_overlap"]);
    const other = Array.from({ length: 9 }, () => "f0f0f0f0f0f0f0f0");
    expect(overlapIssues(tiles, [{ label: "another video", hashes: other }])).toEqual([]);
  });

  it("scene overlap blocks on X (its post stays a draft and can't be approved), warns elsewhere", async () => {
    const tiles = Array.from({ length: 9 }, (_, i) => i.toString(16).repeat(16));
    const renderIssues = overlapIssues(tiles, [{ label: "another video", hashes: tiles }]);
    expect(platformIssues(renderIssues, "tiktok").map((i) => i.severity)).toEqual(["warn"]);
    expect(platformIssues(renderIssues, "x").map((i) => i.severity)).toEqual(["block"]);

    // The per-platform variants writePlatformVariants (video/finalize.ts) would write.
    const w = await seedVideoWorld(db);
    const at = "2026-10-05T15:00:00.000Z";
    await db
      .update(schema.campaigns)
      .set({ plan: { slots: ["x", "tiktok"].map((platform) => ({ id: `slot-${platform}`, platform, scheduledAt: at, connectionId: null })), items: [] } })
      .where(eq(schema.campaigns.id, w.campaignId));
    await db.update(schema.contentItems).set({ brief: { schemaVersion: 1, targets: [{ platform: "x" }, { platform: "tiktok" }], slotIds: ["slot-x", "slot-tiktok"] } }).where(eq(schema.contentItems.id, w.itemId));
    for (const platform of ["x", "tiktok"]) {
      await db.insert(schema.variants).values({
        id: uuidv7(),
        workspaceId: w.ws,
        contentItemId: w.itemId,
        platform,
        body: { kind: "video" },
        assetIds: [w.shotId],
        qa: { issues: platformIssues(renderIssues, platform) },
        contentHash: `h-${platform}`,
      });
    }
    const { postIds } = await ensureVideoPosts(db, w.ws, w.itemId);
    const rows = await db.select().from(schema.posts).where(eq(schema.posts.workspaceId, w.ws));
    const byPlatform = Object.fromEntries(rows.map((p) => [p.platform, p]));
    expect(byPlatform.x!.state).toBe("draft");
    expect(byPlatform.tiktok!.state).toBe("pending_approval");
    expect(postIds).toEqual([byPlatform.tiktok!.id]);
    const session = uiSessionFromCookie({ userId: "user-1", workspaceId: w.ws, originChecked: true, csrfChecked: true });
    const r = await approvePosts(db, session, [byPlatform.x!.id]);
    expect(r.approved).toHaveLength(0);
  });
});
