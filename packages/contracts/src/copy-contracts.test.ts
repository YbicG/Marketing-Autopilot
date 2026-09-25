import { describe, expect, it } from "vitest";
import { CarouselSpec } from "./carousel-spec.ts";
import { PLATFORM_LIMITS, countChars, textLimit } from "./platforms.ts";
import { PostVariant } from "./post-set.ts";
import { JARGON_TERMS, findJargon, plainify } from "./vocabulary.ts";

describe("countChars", () => {
  it("weights X links at 23 and wide characters at 2", () => {
    expect(countChars("x", "hello")).toBe(5);
    expect(countChars("x", "see {{link:landing}}")).toBe(4 + 23);
    expect(countChars("x", "see https://example.com/a/very/long/path?x=1")).toBe(4 + 23);
    expect(countChars("x", "日本")).toBe(4);
    expect(countChars("x", "👍")).toBe(2);
    expect(countChars("x", "👩‍💻")).toBe(2);
  });
  it("counts Bluesky graphemes and others in UTF-16", () => {
    expect(countChars("bluesky", "👩‍💻ab")).toBe(3);
    expect(countChars("threads", "👍")).toBe(2);
    expect(countChars("threads", "{{link:landing}}")).toBe(PLATFORM_LIMITS.threads.linkLength);
  });
  it("uses the TikTok photo description limit", () => {
    expect(textLimit("tiktok", "video")).toBe(2200);
    expect(textLimit("tiktok", "photo")).toBe(4000);
    expect(textLimit("x")).toBe(280);
    expect(textLimit("bluesky")).toBe(300);
  });
});

describe("vocabulary", () => {
  it("finds whole words only", () => {
    expect(findJargon("Our ICP loves this CTA").map((h) => h.term)).toEqual(["ICP", "CTA"]);
    expect(findJargon("hooked on hookah")).toEqual([]);
    expect(findJargon("a strong hook")).toHaveLength(1);
    expect(findJargon("a strong hook", "post")).toHaveLength(0);
    expect(JARGON_TERMS).toContain("UTM");
  });
  it("plainifies with sentence capitals and plurals", () => {
    expect(plainify("Pick 3 hooks. CTA is weak.")).toBe("Pick 3 opening lines. What you want them to do next is weak.");
    expect(plainify("Check the UTM and the carousel")).toBe("Check the tracking link and the swipe post");
    expect(plainify("conversion rate went up")).toBe("Signups / sales went up");
  });
});

describe("schemas", () => {
  it("rejects hashtags with # and URLs in slides", () => {
    const v = { platform: "x", text: "hi", parts: [], hashtags: ["#bad"], linkToken: null, altText: null, firstComment: null, claimRefs: [] };
    expect(PostVariant.safeParse(v).success).toBe(false);
    expect(PostVariant.safeParse({ ...v, hashtags: ["good"] }).success).toBe(true);
    const slide = { template: "hero", headline: "Go to https://x.com", body: null, assetId: null };
    const spec = { schemaVersion: 1, slides: [slide, slide, slide], captions: {}, altText: null, claimRefs: [] };
    expect(CarouselSpec.safeParse(spec).success).toBe(false);
  });
});
