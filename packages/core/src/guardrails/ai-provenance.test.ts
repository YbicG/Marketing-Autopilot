// §8 "AI provenance" (D18): the tier is the highest of the ingredients; generative media defaults to
// C (blocked until M8); overrides only add disclosure; platform AI flags are mapped (§5.8).
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { schema, type Db } from "@mkt/db";
import { createTestDb } from "@mkt/db/testing";
import { handlePublishDue } from "../publishing/due.ts";
import { AI_CAPTION_LABEL, AI_FLAG_RULES, aiDisclosureFor, effectiveTier } from "../publishing/provenance.ts";
import { applyOverride, assertPublishableTier, computeTier, TierBlocked } from "../video/provenance.ts";
import { approvedPost, postRow, world } from "./harness.ts";

let db: Db;
let close: () => Promise<void>;
beforeAll(async () => {
  ({ db, close } = await createTestDb());
});
afterAll(() => close());

const ALL_FLAGS = ["is_aigc", "is_ai_generated", "containsSyntheticMedia", "made_with_ai"];

describe("§8 AI provenance", () => {
  it("the tier is the highest of the ingredients", () => {
    expect(effectiveTier(["A", "A"])).toBe("A");
    expect(effectiveTier(["A", "B", "A"])).toBe("B");
    expect(effectiveTier(["B", "C"])).toBe("C");
    expect(computeTier([{ kind: "asset", origin: "captured" }])).toBe("A");
    expect(computeTier([{ kind: "asset", origin: "captured" }, { kind: "tts" }])).toBe("B");
    expect(computeTier([{ kind: "asset", origin: "uploaded" }, { kind: "music" }])).toBe("B");
  });

  it("generative pictures and video default to C; a stored tier can only raise it", () => {
    expect(computeTier([{ kind: "generative_image" }])).toBe("C");
    expect(computeTier([{ kind: "generative_video" }])).toBe("C");
    expect(computeTier([{ kind: "generative_image", nonPhotorealChecked: true }])).toBe("B");
    expect(computeTier([{ kind: "asset", origin: "generated" }])).toBe("C");
    expect(computeTier([{ kind: "asset", origin: "captured", provenanceTier: "C" }])).toBe("C");
  });

  it("overrides only add disclosure", () => {
    expect(applyOverride("B", "A")).toBe("B");
    expect(applyOverride("A", "B")).toBe("B");
    expect(applyOverride("C", "A")).toBe("C");
    expect(aiDisclosureFor("x", "A", ALL_FLAGS, true).flags).toEqual({ made_with_ai: true });
  });

  it("tier C is blocked until M8", () => {
    expect(() => assertPublishableTier("C")).toThrow(TierBlocked);
    expect(() => assertPublishableTier("B")).not.toThrow();
    expect(aiDisclosureFor("tiktok", "C", ALL_FLAGS).blocked).toBe("Posts with AI-generated images or video can't be published yet.");
  });

  it("platform flags follow the §5.8 table", () => {
    expect(AI_FLAG_RULES).toEqual({
      tiktok: { flag: "is_aigc", tiers: ["B", "C"] },
      instagram: { flag: "is_ai_generated", tiers: ["B", "C"] },
      youtube: { flag: "containsSyntheticMedia", tiers: ["C"] },
      x: { flag: "made_with_ai", tiers: ["B", "C"] },
    });
    expect(aiDisclosureFor("tiktok", "B", ALL_FLAGS).flags).toEqual({ is_aigc: true });
    expect(aiDisclosureFor("instagram", "B", ALL_FLAGS).flags).toEqual({ is_ai_generated: true });
    expect(aiDisclosureFor("youtube", "B", ALL_FLAGS)).toMatchObject({ flags: {}, captionLabel: null });
    expect(aiDisclosureFor("x", "A", ALL_FLAGS)).toMatchObject({ flags: {}, captionLabel: null });
  });

  it("when the route can't carry the flag, the caption gets a label instead", () => {
    expect(aiDisclosureFor("tiktok", "B", [])).toMatchObject({ flags: {}, captionLabel: AI_CAPTION_LABEL });
    // Platforms with no flag at all (Threads, LinkedIn, Bluesky) always get the label for B.
    expect(aiDisclosureFor("threads", "B", ALL_FLAGS).captionLabel).toBe(AI_CAPTION_LABEL);
  });

  it("publish time: a tier C picture holds the post", async () => {
    const w = await world(db);
    await db.update(schema.assets).set({ provenanceTier: "C" }).where(eq(schema.assets.id, w.s.assetId));
    const id = await approvedPost(w);
    expect(await handlePublishDue(w.deps, { postId: id, generation: 1 })).toBe("failed");
    expect(w.adapter.submits).toHaveLength(0);
    expect((await postRow(db, id)).lastError).toBe("Posts with AI-generated images or video can't be published yet.");
  });

  it("publish time: tier B sends the X flag, or labels a Threads caption", async () => {
    const x = await world(db, { platform: "x" });
    await db.update(schema.assets).set({ provenanceTier: "B" }).where(eq(schema.assets.id, x.s.assetId));
    const xId = await approvedPost(x, { platform: "x" });
    expect(await handlePublishDue(x.deps, { postId: xId, generation: 1 })).toBe("submitted");
    expect(x.adapter.submits[0]!.aiFlags).toEqual({ made_with_ai: true });

    const t = await world(db);
    await db.update(schema.assets).set({ provenanceTier: "B" }).where(eq(schema.assets.id, t.s.assetId));
    const tId = await approvedPost(t);
    expect(await handlePublishDue(t.deps, { postId: tId, generation: 1 })).toBe("submitted");
    expect(t.adapter.submits[0]!.text.endsWith(AI_CAPTION_LABEL)).toBe(true);
  });
});
