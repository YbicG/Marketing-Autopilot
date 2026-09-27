import { describe, expect, it } from "vitest";
import type { AmbassadorKitBody, KitInputs, PressKitBody, ReplyBankBody, SubredditKitBody } from "@mkt/contracts";
import { buildKitBody, profileFacts, type BuildCtx } from "./build.ts";
import { disclosuresOk, exportBlocker, kitHasBlock, normalizePrice, sanitizeKitText, validateKitBody, type KitCheckCtx, type KitClaim } from "./checks.ts";
import { estimateKitRun } from "./estimate.ts";
import { kitFiles, resolveKitLinks } from "./export.ts";
import { AMBASSADOR_CAPTION_PREFIX, AMBASSADOR_DISCLOSURE, TIKTOK_BRANDED_CONTENT_STEPS, ambassadorLink, ambassadorRef, creatorDisclosure } from "./links.ts";

const claims = new Map<string, KitClaim>([
  ["C1", { ref: "C1", kind: "feature", publicOk: true, status: "sourced", expiresAt: null }],
  ["C2", { ref: "C2", kind: "stat", publicOk: false, status: "sourced", expiresAt: null }],
  ["C3", { ref: "C3", kind: "stat", publicOk: true, status: "sourced", expiresAt: new Date("2026-12-01T00:00:00Z") }],
  ["C4", { ref: "C4", kind: "testimonial", publicOk: true, status: "sourced", expiresAt: null }],
]);

const ctx = (inputs: KitInputs = {}): KitCheckCtx => ({
  claims,
  validThrough: new Date("2027-01-19T23:59:59Z"),
  knownPrices: new Set(["$4.99", "$9.99"]),
  competitors: ["Notion templates"],
  inputs,
  assetIds: new Set(["0190a000-0000-7000-8000-000000000001"]),
});

const reply = (r: string, refs: string[] = []): ReplyBankBody => ({ schemaVersion: 1, kind: "reply_bank", replies: [{ trigger: "Is it free?", reply: r, claimRefs: refs }] });

describe("ambassadorLink", () => {
  it("builds /go/<ref> on the site's origin with tracking params", () => {
    const url = ambassadorLink("https://syllacal.com/some/page?x=1", "maya-chen", { campaign: "syllacal-launch" });
    expect(url).toBe("https://syllacal.com/go/maya-chen?utm_source=ambassador&utm_medium=referral&utm_campaign=syllacal-launch&utm_content=maya-chen");
  });
  it("refuses refs SyllaCal's /go route would ignore", () => {
    expect(() => ambassadorLink("https://syllacal.com", "maya chen")).toThrow(/referral code/);
    expect(() => ambassadorLink("https://syllacal.com", "a".repeat(65))).toThrow();
    expect(() => ambassadorLink("ftp://x.com", "ok")).toThrow(/https/);
  });
  it("makes unique codes from names", () => {
    const taken = new Set<string>();
    expect(ambassadorRef("Maya Chén", taken)).toBe("maya-chen");
    expect(ambassadorRef("Maya Chen", taken)).toBe("maya-chen-2");
    expect(ambassadorRef("!!!", taken)).toBe("ambassador");
  });
});

describe("kit checks", () => {
  it("reply bank: a number needs a public fact that lasts through launch", () => {
    const noSource = validateKitBody(reply("Over 1,200 students use it."), ctx());
    expect(noSource.find((i) => i.code === "number_without_source")?.severity).toBe("block");
    expect(kitHasBlock(validateKitBody(reply("Over 1,200 students use it.", ["C1"]), ctx()))).toBe(false);
    expect(validateKitBody(reply("Over 1,200 students use it.", ["C2"]), ctx()).map((i) => i.code)).toContain("internal_fact");
    expect(validateKitBody(reply("Over 1,200 students use it.", ["C9"]), ctx()).map((i) => i.code)).toContain("unknown_fact");
    expect(validateKitBody(reply("Over 1,200 students use it.", ["C3"]), ctx()).map((i) => i.code)).toContain("fact_expires");
    expect(validateKitBody(reply("People love it.", ["C4"]), ctx()).map((i) => i.code)).toContain("unverified_testimonial");
  });

  it("prices must match the profile exactly", () => {
    expect(validateKitBody(reply("It's $4.99 once."), ctx()).filter((i) => i.severity === "block")).toEqual([]);
    expect(validateKitBody(reply("It's $3.99 once."), ctx()).map((i) => i.code)).toContain("price_not_exact");
    expect(normalizePrice("$ 5")).toBe("$5.00");
  });

  it("links: at most one per reply, and linking replies say you made it", () => {
    const two = validateKitBody(reply("I made it: {{link:landing}} and {{link:landing}}"), ctx());
    expect(two.map((i) => i.code)).toContain("link_spam");
    const undisclosed = validateKitBody(reply("Get it here: {{link:landing}}"), ctx());
    expect(undisclosed.map((i) => i.code)).toContain("no_maker_disclosure");
    expect(disclosuresOk(undisclosed)).toBe(false);
    expect(disclosuresOk(validateKitBody(reply("I made this, it's here: {{link:landing}}"), ctx()))).toBe(true);
    expect(validateKitBody(reply("Please upvote it!"), ctx()).map((i) => i.code)).toContain("asks_for_votes");
    expect(validateKitBody(reply("Rated 4.9 stars ★"), ctx()).map((i) => i.code)).toContain("invented_review");
    expect(validateKitBody(reply("Way better than Notion templates."), ctx()).map((i) => i.code)).toContain("competitor_without_source");
  });

  it("sanitizes raw web addresses and unknown link tokens", () => {
    expect(sanitizeKitText("Try https://evil.example/x now {{link:promo}}")).toEqual({ text: "Try now", removed: 2 });
  });

  const press = (over: Partial<PressKitBody> = {}): PressKitBody => ({
    schemaVersion: 1,
    kind: "press",
    facts: [{ label: "Name", value: "SyllaCal", claimRefs: [], source: "profile" }],
    boilerplate: "SyllaCal turns a syllabus into calendar events.",
    founderQuote: { text: "I built it for my own semester.", editMe: false, note: "" },
    assets: [],
    pitches: Array.from({ length: 10 }, (_, i) => ({ outletType: "campus_paper" as const, outlet: "[Outlet]", subject: `Idea ${i}`, body: "Hi [Editor first name], I built SyllaCal.", claimRefs: [] })),
    claimRefs: [],
    ...over,
  });

  it("press: no invented outlets, editors or emails", () => {
    expect(kitHasBlock(validateKitBody(press(), ctx()))).toBe(false);
    const bad = press({ pitches: [{ outletType: "podcast", outlet: "The Daily Bruin", subject: "Hi", body: "Hi Sarah, I built SyllaCal. Email sarah@bruin.edu", claimRefs: [] }] });
    const codes = validateKitBody(bad, ctx()).map((i) => i.code);
    expect(codes).toEqual(expect.arrayContaining(["invented_outlet", "invented_name", "invented_contact", "pitch_count"]));
    const given = validateKitBody(bad, ctx({ press: { targets: [{ outlet: "The Daily Bruin", kind: "campus_paper", contactName: "Sarah Lee", email: "sarah@bruin.edu" }] } }));
    expect(given.filter((i) => i.severity === "block")).toEqual([]);
    const noMaker = press({ pitches: [{ outletType: "podcast", outlet: "[Outlet]", subject: "S", body: "Hi [Editor first name], meet SyllaCal.", claimRefs: [] }] });
    expect(disclosuresOk(validateKitBody(noMaker, ctx()))).toBe(false);
  });

  const amb = (over: Partial<AmbassadorKitBody> = {}): AmbassadorKitBody => ({
    schemaVersion: 1,
    kind: "ambassador",
    pitch: "Help classmates stop typing deadlines by hand.",
    perks: ["[What you'll give ambassadors]"],
    templates: [1, 2, 3].map(() => ({ channel: "dm" as const, subject: null, text: "Hey [Name], want to be a SyllaCal ambassador at [Campus]?" })),
    postingGuide: ["Post once a week", "Always disclose"],
    captionExamples: [`${AMBASSADOR_CAPTION_PREFIX} Syllabus week took me 2 minutes.`],
    disclosure: AMBASSADOR_DISCLOSURE,
    brandedContentSteps: [...TIKTOK_BRANDED_CONTENT_STEPS],
    links: [{ name: "Maya", ref: "maya", url: "https://syllacal.com/go/maya" }],
    claimRefs: [],
    ...over,
  });

  it("ambassador: disclosure first in every caption, branded content steps, no promised earnings", () => {
    expect(disclosuresOk(validateKitBody(amb(), ctx()))).toBe(true);
    const late = validateKitBody(amb({ captionExamples: ["Syllabus week took me 2 minutes #ad"] }), ctx());
    expect(late.map((i) => i.code)).toContain("caption_without_disclosure");
    expect(disclosuresOk(late)).toBe(false);
    expect(disclosuresOk(validateKitBody(amb({ brandedContentSteps: ["Post it"] }), ctx()))).toBe(false);
    expect(validateKitBody(amb({ pitch: "You'll earn $500 a month, guaranteed." }), ctx()).map((i) => i.code)).toContain("promises_results");
    expect(validateKitBody(amb({ templates: [{ channel: "dm", subject: null, text: "Hey Jordan, join us" }] }), ctx()).map((i) => i.code)).toContain("invented_name");
  });

  it("creator: the paid partnership label is required", () => {
    const d = creatorDisclosure("SyllaCal");
    const body = { schemaVersion: 1 as const, kind: "creator" as const, whatItIs: "It reads a syllabus.", whatToShow: ["Dropping a PDF"], dos: ["Be honest"], donts: ["Promise grades"], disclosure: d, brandedContentSteps: [...TIKTOK_BRANDED_CONTENT_STEPS], dmTemplates: [{ text: "Hi [Creator name]" }], claimRefs: [] };
    expect(disclosuresOk(validateKitBody(body, ctx()))).toBe(true);
    expect(disclosuresOk(validateKitBody({ ...body, disclosure: { ...d, rules: ["Be nice"] } }, ctx()))).toBe(false);
    expect(disclosuresOk(validateKitBody({ ...body, disclosure: { ...d, captionPrefix: "Check this out" } }, ctx()))).toBe(false);
  });

  it("subreddit: maker line required; suggested communities warn", () => {
    const sub = (b: string, proposed = false): SubredditKitBody => ({
      schemaVersion: 1,
      kind: "subreddit",
      drafts: [{ subreddit: "college", title: "I made a thing", body: b, whyThisFits: "Students", bestTime: "Tue 10am", rulesUrl: "https://www.reddit.com/r/college/about/rules", claimRefs: [], likelyNotAllowed: false, proposed, checkNote: null, assistedTaskId: null }],
      assistedTaskIds: [],
    });
    expect(disclosuresOk(validateKitBody(sub("Here's an app."), ctx({ subreddit: { communities: ["college"], dueDate: null } })))).toBe(false);
    const ok = validateKitBody(sub("I made this for my own classes."), ctx({ subreddit: { communities: ["college"], dueDate: null } }));
    expect(ok).toEqual([]);
    expect(validateKitBody(sub("I made this.", true), ctx()).map((i) => i.code)).toContain("community_unchecked");
  });

  it("export blocker explains itself", () => {
    expect(exportBlocker("press", "ready", [], true)).toBeNull();
    expect(exportBlocker("press", "needs_you", [{ code: "no_maker_disclosure", severity: "block", message: "Pitch 1 doesn't say you made the app." }], false)).toMatch(/disclosure/);
    expect(exportBlocker("press", "generating", [], true)).toMatch(/still/);
  });
});

describe("build", () => {
  const bctx: BuildCtx = {
    productName: "SyllaCal",
    site: "https://syllacal.com",
    campaign: "syllacal-launch",
    inputs: { ambassador: { ambassadors: [{ name: "Maya Chen", ref: null }, { name: "Leo", ref: "leo_ucsd" }], reward: null } },
    dna: null,
    assets: [],
  };
  it("ambassador: our disclosure, steps and links, not the model's", () => {
    const b = buildKitBody("ambassador", { pitch: "p", perks: ["[What you'll give ambassadors]"], templates: [{ channel: "email", subject: "Hi", text: "t https://x.y" }], postingGuide: ["g"], captionExamples: ["c"], claimRefs: ["C1", "bogus"] }, bctx);
    const body = b.body as AmbassadorKitBody;
    expect(body.links.map((l) => l.ref)).toEqual(["maya-chen", "leo_ucsd"]);
    expect(body.links[0]!.url).toContain("/go/maya-chen?");
    expect(body.disclosure.captionPrefix).toBe(AMBASSADOR_CAPTION_PREFIX);
    expect(body.claimRefs).toEqual(["C1"]);
    expect(body.templates[0]!.text).toBe("t");
    expect(b.issues.map((i) => i.code)).toContain("raw_link_removed");
  });
  it("subreddit: only the communities the user chose, marked unchecked otherwise", () => {
    const m = { drafts: ["r/College", "UCSD", "other"].map((s) => ({ subreddit: s, title: "t", body: "I made this", whyThisFits: "w", bestTime: "b", claimRefs: [], likelyNotAllowed: false })) };
    const chosen = buildKitBody("subreddit", m, { ...bctx, inputs: { subreddit: { communities: ["college", "UCSD"], dueDate: null } } }).body as SubredditKitBody;
    expect(chosen.drafts.map((d) => [d.subreddit, d.proposed])).toEqual([["college", false], ["UCSD", false]]);
    const proposed = buildKitBody("subreddit", m, { ...bctx, inputs: {} }).body as SubredditKitBody;
    expect(proposed.drafts.every((d) => d.proposed && d.checkNote)).toBe(true);
  });
  it("press: profile rows carry exact prices", () => {
    const rows = profileFacts(
      {
        identity: { name: "SyllaCal", oneLiner: "Syllabus to calendar in 15 seconds", category: "", platforms: ["web"], whoItsFor: "Students", audiences: [], jobs: [], voice: { tone: "", wordsToUse: [], wordsToAvoid: [] } },
        offer: { features: [], pricing: { model: "one_time", summary: "", tiers: [{ name: "Basic", price: "$4.99", period: "one-time", notes: null }] }, proof: [], differentiators: [] },
        market: { competitors: [], pains: [], seasonality: { peaks: [], summary: "" }, channels: [], searchTerms: [] },
      },
      "SyllaCal",
    );
    expect(rows.find((r) => r.label === "Price: Basic")?.value).toBe("$4.99 one-time");
    // Profile rows may hold numbers ("15 seconds") without a claim.
    const body: PressKitBody = { schemaVersion: 1, kind: "press", facts: rows, boilerplate: "b", founderQuote: { text: "q", editMe: false, note: "" }, assets: [], pitches: [], claimRefs: [] };
    expect(validateKitBody(body, ctx()).filter((i) => i.code === "number_without_source")).toEqual([]);
  });
});

describe("estimate and files", () => {
  it("prices each kit and sets a cap of at least $1", () => {
    const e = estimateKitRun(["press", "reply_bank", "press"]);
    expect(e.lines.map((l) => l.kind)).toEqual(["press", "reply_bank"]);
    expect(e.expected).toBe(150_000 + 90_000 + 40_000);
    expect(e.capMicros).toBeGreaterThanOrEqual(1_000_000);
  });
  it("renders markdown with tracking links", () => {
    const fctx = { productName: "SyllaCal", site: "https://syllacal.com", campaign: "syllacal-launch", launchDate: "2027-01-19" };
    expect(resolveKitLinks("Get it: {{link:landing}}", fctx, "reply_bank")).toBe("Get it: https://syllacal.com/?utm_source=reply_bank&utm_medium=launch_kit&utm_campaign=syllacal-launch");
    const files = kitFiles(reply("I made this: {{link:landing}}"), fctx);
    expect(files.map((f) => f.name)).toEqual(["README.md", "reply-bank.md"]);
    expect(files[1]!.text).toContain("utm_source=reply_bank");
  });
});
