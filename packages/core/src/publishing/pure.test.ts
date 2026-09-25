import { describe, expect, it } from "vitest";
import {
  TikTokOptions,
  tiktokConsentText,
  tiktokContentLabel,
  TIKTOK_BRANDED_CONTENT_CONSENT_TEXT,
  TIKTOK_MUSIC_CONSENT_TEXT,
  YouTubeOptions,
} from "@mkt/contracts";
import { accountDailyLimit, checkCaps, type CapConnection, type CapPost } from "./caps.ts";
import { approvalHash, canonicalJson } from "./hash.ts";
import { buildUtm, resolveLinkTokens, shortId } from "./links.ts";
import { assistedDeepLink, rulesCheckedToday } from "./manual.ts";
import { aiDisclosureFor, effectiveTier, withCaptionLabel } from "./provenance.ts";
import { publishText } from "./store.ts";
import { isoWeek, localDay, shortSlot } from "./time.ts";
import { tiktokDailyLimit, validateTikTokComposer } from "./tiktok.ts";

const okTikTok = { privacyLevel: "PUBLIC_TO_EVERYONE", musicConsent: true };

describe("TikTok composer (D17)", () => {
  it("has no default privacy", () => {
    expect(TikTokOptions.safeParse({ musicConsent: true }).success).toBe(false);
    const r = validateTikTokComposer({ options: { musicConsent: true }, creatorInfo: null });
    expect(r.issues.map((i) => i.code)).toContain("tiktok.privacy_required");
  });

  it("defaults interactions off and direct post with inbox fallback off", () => {
    expect(TikTokOptions.parse(okTikTok)).toMatchObject({
      disableComment: true,
      disableDuet: true,
      disableStitch: true,
      postMode: "direct",
      disableInboxFallback: true,
      commercialContent: { enabled: false, yourBrand: false, brandedContent: false },
    });
  });

  it("branded content can't be private", () => {
    const r = validateTikTokComposer({
      options: { ...okTikTok, privacyLevel: "SELF_ONLY", commercialContent: { enabled: true, brandedContent: true } },
      creatorInfo: null,
    });
    expect(r.issues.map((i) => i.code)).toContain("tiktok.branded_private");
    // Your-brand-only content may be private.
    expect(
      validateTikTokComposer({
        options: { ...okTikTok, privacyLevel: "SELF_ONLY", commercialContent: { enabled: true, yourBrand: true } },
        creatorInfo: null,
      }).issues,
    ).toEqual([]);
  });

  it("commercial content on needs a choice, and music consent is required", () => {
    expect(validateTikTokComposer({ options: { ...okTikTok, commercialContent: { enabled: true } }, creatorInfo: null }).issues).toHaveLength(1);
    expect(validateTikTokComposer({ options: { privacyLevel: "PUBLIC_TO_EVERYONE" }, creatorInfo: null }).issues.map((i) => i.code)).toContain(
      "tiktok.music_consent",
    );
  });

  it("shows TikTok's consent text and labels verbatim", () => {
    const base = TikTokOptions.parse(okTikTok);
    expect(tiktokConsentText(base)).toBe(TIKTOK_MUSIC_CONSENT_TEXT);
    expect(TIKTOK_MUSIC_CONSENT_TEXT).toBe("By posting, you agree to TikTok's Music Usage Confirmation.");
    const branded = TikTokOptions.parse({ ...okTikTok, commercialContent: { enabled: true, brandedContent: true } });
    expect(tiktokConsentText(branded)).toBe(TIKTOK_BRANDED_CONTENT_CONSENT_TEXT);
    expect(tiktokContentLabel(branded)).toMatch(/Paid partnership/);
    expect(tiktokContentLabel(TikTokOptions.parse({ ...okTikTok, commercialContent: { enabled: true, yourBrand: true } }))).toMatch(
      /Promotional content/,
    );
  });

  it("creator_info caps block", () => {
    const r = validateTikTokComposer({
      options: { ...okTikTok, privacyLevel: "FOLLOWER_OF_CREATOR", disableComment: false },
      creatorInfo: { privacyOptions: ["PUBLIC_TO_EVERYONE", "SELF_ONLY"], canPost: false, maxVideoSeconds: 60, commentDisabled: true },
      videoSeconds: 90,
    });
    expect(r.issues.map((i) => i.code).sort()).toEqual(
      ["tiktok.cannot_post", "tiktok.comments_off", "tiktok.privacy_unavailable", "tiktok.too_long"].sort(),
    );
  });

  it("drafts mode needs a manual finish and stops at 5 pending drafts", () => {
    const opts = { ...okTikTok, postMode: "drafts" };
    expect(validateTikTokComposer({ options: opts, creatorInfo: null, pendingDrafts: 4 })).toMatchObject({ mode: "drafts", issues: [] });
    expect(validateTikTokComposer({ options: opts, creatorInfo: null, pendingDrafts: 5 }).issues[0]!.code).toBe("tiktok.drafts_full");
  });

  it("week one is 1 a day, then a hard max of 2", () => {
    const createdAt = new Date("2026-10-01T00:00:00Z");
    const conn = { createdAt, warmupUntil: null, maxPerDay: 3 };
    expect(tiktokDailyLimit(conn, new Date("2026-10-05T00:00:00Z"))).toBe(1);
    expect(tiktokDailyLimit(conn, new Date("2026-10-09T00:00:00Z"))).toBe(2);
  });
});

describe("caps", () => {
  const tz = "America/New_York";
  const conn = (over: Partial<CapConnection>): CapConnection => ({
    id: "c1",
    platform: "x",
    handle: "cj",
    shared: false,
    maxPerDay: 2,
    warmupUntil: null,
    createdAt: new Date("2026-01-01T00:00:00Z"),
    ...over,
  });
  const p = (over: Partial<CapPost>): CapPost => ({
    id: "p",
    productId: "A",
    platform: "x",
    connectionId: "c1",
    scheduledAt: new Date("2026-10-20T16:00:00Z"),
    state: "published",
    ...over,
  });

  it("never allows more than 3 per account even if max_per_day says more", () => {
    expect(accountDailyLimit([conn({ maxPerDay: 9 })], new Date()).limit).toBe(3);
  });

  it("shared accounts share one cap across products; unshared ones don't", () => {
    const conns = [conn({ id: "c1", shared: true }), conn({ id: "c2", shared: true, handle: "@CJ" })];
    const post = p({ id: "new", productId: "B", connectionId: "c2", state: "queued", scheduledAt: new Date("2026-10-20T22:00:00Z") });
    const others = [p({ id: "a1", scheduledAt: new Date("2026-10-20T13:00:00Z") }), p({ id: "a2", productId: "C", scheduledAt: new Date("2026-10-20T14:00:00Z") })];
    expect(checkCaps({ post, others, connections: conns, tz, mode: "prepare" }).map((i) => i.code)).toEqual(["cap.account"]);
    const unshared = [conn({ id: "c1" }), conn({ id: "c2", handle: "@CJ" })];
    expect(checkCaps({ post, others, connections: unshared, tz, mode: "prepare" })).toEqual([]);
  });

  it("counts by the workspace's local day", () => {
    // 03:00 UTC on the 21st is still the 20th in New York.
    const post = p({ id: "new", state: "queued", scheduledAt: new Date("2026-10-21T03:00:00Z") });
    const others = [p({ id: "a", scheduledAt: new Date("2026-10-20T13:00:00Z") }), p({ id: "b", scheduledAt: new Date("2026-10-20T15:00:00Z") })];
    expect(checkCaps({ post, others, connections: [conn({})], tz, mode: "prepare" }).map((i) => i.code)).toContain("cap.product_platform");
    expect(checkCaps({ post, others, connections: [conn({})], tz: "UTC", mode: "prepare" })).toEqual([]);
  });

  it("two posts preparing at once don't block each other; the earlier one wins", () => {
    const connections = [conn({ maxPerDay: 1 })];
    const first = p({ id: "a", state: "preparing" });
    const second = p({ id: "b", state: "preparing" });
    expect(checkCaps({ post: first, others: [second], connections, tz, mode: "prepare" })).toEqual([]);
    expect(checkCaps({ post: second, others: [first], connections, tz, mode: "prepare" })).toHaveLength(1);
  });
});

describe("hash", () => {
  it("is stable under key order and changes with text, media order and options", () => {
    const base = { text: "hi", mediaSha256s: ["a", "b"], platformOptions: { x: 1, y: { b: 2, a: 1 } } };
    expect(approvalHash(base)).toBe(approvalHash({ ...base, platformOptions: { y: { a: 1, b: 2 }, x: 1 } }));
    expect(approvalHash(base)).not.toBe(approvalHash({ ...base, text: "hi!" }));
    expect(approvalHash(base)).not.toBe(approvalHash({ ...base, mediaSha256s: ["b", "a"] }));
    expect(approvalHash(base)).not.toBe(approvalHash({ ...base, platformOptions: { x: 2, y: { a: 1, b: 2 } } }));
    expect(canonicalJson({ a: undefined, b: 1 })).toBe('{"b":1}');
  });
});

describe("links", () => {
  const utm = buildUtm({ platform: "threads", productSlug: "syllacal", campaignId: "0199aaaa-0000-7000-8000-00000000abcd", variantId: "v1", angleId: "a1" });
  it("builds the UTM set of §5.8", () => {
    expect(utm).toEqual({
      utm_source: "threads",
      utm_medium: "organic",
      utm_campaign: "syllacal-0000abcd",
      utm_content: "v1",
      utm_term: "a1",
    });
    expect(shortId("0199aaaa-0000-7000-8000-00000000abcd")).toBe("0000abcd");
  });
  it("replaces link tokens, uses 'link in bio' where captions can't link, and blocks unknown tokens", () => {
    const r = resolveLinkTokens("Try it {{link:landing}}", { landingUrl: "https://syllacal.com/?ref=x", utm, links: "clickable" });
    expect(r.text).toBe("Try it https://syllacal.com/?ref=x&utm_source=threads&utm_medium=organic&utm_campaign=syllacal-0000abcd&utm_content=v1&utm_term=a1");
    expect(r.links).toHaveLength(1);
    expect(resolveLinkTokens("Try {{link:landing}}", { landingUrl: "https://s.com", utm, links: "bio_only" }).text).toBe("Try link in bio");
    expect(resolveLinkTokens("Try {{link:landing}}", { landingUrl: "https://s.com", utm, links: "addon", linksAllowed: true }).links).toHaveLength(1);
    expect(resolveLinkTokens("{{link:pricing}}", { landingUrl: "https://s.com", utm, links: "clickable" }).problems).toHaveLength(1);
    expect(resolveLinkTokens("{{link:landing}}", { landingUrl: null, utm, links: "clickable" }).problems).toHaveLength(1);
    expect(resolveLinkTokens("see https://other.com", { landingUrl: null, utm, links: "clickable" }).warnings).toHaveLength(1);
  });
});

describe("provenance (D18)", () => {
  it("takes the highest tier and maps flags per §5.8", () => {
    expect(effectiveTier(["A", "B", "A"])).toBe("B");
    const all = ["is_aigc", "is_ai_generated", "containsSyntheticMedia", "made_with_ai"];
    expect(aiDisclosureFor("tiktok", "B", all).flags).toEqual({ is_aigc: true });
    expect(aiDisclosureFor("instagram", "B", all).flags).toEqual({ is_ai_generated: true });
    expect(aiDisclosureFor("youtube", "B", all).flags).toEqual({});
    expect(aiDisclosureFor("x", "A", all).flags).toEqual({});
    expect(aiDisclosureFor("x", "A", all, true).flags).toEqual({ made_with_ai: true });
    expect(aiDisclosureFor("youtube", "C", all).blocked).toBeTruthy();
    expect(aiDisclosureFor("tiktok", "B", []).captionLabel).toBe("(Made with AI)");
    expect(withCaptionLabel("hi", "(Made with AI)")).toBe("hi\n\n(Made with AI)");
  });

  it("YouTube needs madeForKids chosen", () => {
    expect(YouTubeOptions.safeParse({ title: "t" }).success).toBe(false);
    expect(YouTubeOptions.parse({ title: "t", madeForKids: false }).containsSyntheticMedia).toBe(false);
  });
});

describe("assisted venues", () => {
  it("deep links carry content only", () => {
    expect(assistedDeepLink("reddit", { url: "https://s.com/?utm_source=reddit", title: "My app", subreddit: "r/SideProject" })).toBe(
      "https://www.reddit.com/r/SideProject/submit?url=https%3A%2F%2Fs.com%2F%3Futm_source%3Dreddit&title=My%20app",
    );
    expect(assistedDeepLink("hackernews", { url: "https://s.com", title: "Show HN: x" })).toBe(
      "https://news.ycombinator.com/submitlink?u=https%3A%2F%2Fs.com&t=Show%20HN%3A%20x",
    );
    expect(assistedDeepLink("producthunt", { url: "https://s.com" })).toBeNull();
  });
  it("rules must be ticked today", () => {
    const now = new Date("2026-10-20T15:00:00Z");
    expect(rulesCheckedToday({ rulesCheckedByHumanAt: new Date("2026-10-20T13:00:00Z") }, now, "America/New_York")).toBe(true);
    expect(rulesCheckedToday({ rulesCheckedByHumanAt: new Date("2026-10-19T13:00:00Z") }, now, "America/New_York")).toBe(false);
    expect(rulesCheckedToday({ rulesCheckedByHumanAt: null }, now, "America/New_York")).toBe(false);
  });
});

describe("time", () => {
  it("formats local days, slots and ISO weeks", () => {
    const d = new Date("2026-10-20T23:30:00Z");
    expect(localDay(d, "America/New_York")).toBe("2026-10-20");
    expect(shortSlot(d, "America/New_York")).toBe("Tue 7:30 pm");
    expect(isoWeek(d, "America/New_York")).toBe("2026-W43");
    expect(isoWeek(new Date("2027-01-01T12:00:00Z"), "UTC")).toBe("2026-W53");
  });
});

describe("publishText", () => {
  it("reads a swipe post's caption object", () => {
    const t = publishText({ schemaVersion: 1, kind: "carousel", caption: { text: "Swipe", hashtags: ["study"] }, slides: [] });
    expect(t.text).toContain("Swipe");
    expect(t.text).toContain("#study");
  });
  it("reads the copy factory's TextVariantBody, adding the link token and hashtags", () => {
    const body = {
      schemaVersion: 1,
      kind: "post",
      variant: { platform: "threads", text: "Your syllabus, now a calendar", parts: [], hashtags: ["studytok"], linkToken: "{{link:landing}}", altText: null, firstComment: null, claimRefs: ["C1"] },
    };
    expect(publishText(body)).toEqual({ text: "Your syllabus, now a calendar\n\n{{link:landing}}\n\n#studytok" });
  });
  it("puts a thread's link on its last part", () => {
    const body = { variant: { text: "1/", parts: ["1/", "2/", "3/"], hashtags: [], linkToken: "{{link:landing}}", firstComment: "more" } };
    expect(publishText(body)).toEqual({ text: "1/", parts: ["1/", "2/", "3/\n\n{{link:landing}}"], firstComment: "more" });
  });
});
