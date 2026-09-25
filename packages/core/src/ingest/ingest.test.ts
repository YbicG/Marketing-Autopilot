import { describe, expect, it } from "vitest";
import type { FieldMetaMap, ProductDna } from "@mkt/contracts";
import { classifyInput, linkedSources, slugify } from "./classify.ts";
import { buildEvidenceBundle, claimIsPublic, supportedBy } from "./evidence.ts";
import { applyPins, editField, fieldPathOf, mergeEvidence, unsureItems } from "./merge-evidence.ts";
import { buildClaims } from "./profile.ts";
import { packageFacts as packageFactsForTest } from "./run.ts";
import { defaultLaunchDate } from "./strategy.ts";

describe("classifyInput", () => {
  it.each([
    ["syllacal.com", { kind: "website", url: "https://syllacal.com/" }],
    ["https://www.syllacal.com/pricing#x", { kind: "website", url: "https://www.syllacal.com/pricing" }],
    ["github.com/cj/syllacal", { kind: "github", owner: "cj", repo: "syllacal", url: "https://github.com/cj/syllacal" }],
    ["https://github.com/cj/syllacal.git", { kind: "github", owner: "cj", repo: "syllacal", url: "https://github.com/cj/syllacal" }],
    ["https://github.com/cj/syllacal/tree/main/src", { kind: "github", owner: "cj", repo: "syllacal", url: "https://github.com/cj/syllacal" }],
    ["https://github.com/features/actions", { kind: "website", url: "https://github.com/features/actions" }],
    ["It turns a syllabus into a calendar", { kind: "notes", text: "It turns a syllabus into a calendar" }],
    ["localhost", { kind: "notes", text: "localhost" }],
    ["javascript:alert(1)", { kind: "notes", text: "javascript:alert(1)" }],
  ])("%s", (raw, expected) => {
    expect(classifyInput(raw)).toEqual(expected);
  });
});

describe("source graph", () => {
  it("links a folder to its repo and website", () => {
    expect(
      linkedSources({
        gitRemote: "https://github.com/cj/SyllaCal",
        packageJson: { homepage: "https://syllacal.com", repository: { url: "git+https://github.com/other/x.git" } },
      }),
    ).toEqual({ website: "https://syllacal.com/", repo: { owner: "cj", repo: "SyllaCal" } });
  });
  it("uses a repo's homepage as the website, ignoring a homepage that points back at GitHub", () => {
    expect(linkedSources({ homepage: "https://github.com/cj/tool" }).website).toBeNull();
    expect(linkedSources({ homepage: "tool.dev" }).website).toBe("https://tool.dev/");
  });
  it("reads package.json repository shorthand and a site's github link", () => {
    expect(linkedSources({ packageJson: { repository: "github:cj/cli" } }).repo).toEqual({ owner: "cj", repo: "cli" });
    expect(linkedSources({ githubUrl: "https://github.com/cj/site-repo" }).repo).toEqual({ owner: "cj", repo: "site-repo" });
  });
  it("slugifies with suffixes", () => {
    expect(slugify("SyllaCal!")).toBe("syllacal");
    expect(slugify("syllacal", new Set(["syllacal", "syllacal-2"]))).toBe("syllacal-3");
  });
});

const artifacts = [
  {
    artifactId: "a1",
    sourceId: "site",
    sourceKind: "website",
    kind: "page",
    title: "SyllaCal pricing",
    url: "https://syllacal.com/pricing",
    path: null,
    visibility: "public_ok" as const,
    text: "SyllaCal turns your syllabus into a calendar in 15 seconds. Plans: Basic $4.99 one-time, Plus $9.99 one-time. No subscription, ever.",
  },
  {
    artifactId: "a2",
    sourceId: "folder",
    sourceKind: "folder_upload",
    kind: "doc",
    title: "docs/scorecard.md",
    url: null,
    path: "docs/scorecard.md",
    visibility: "internal" as const,
    text: "Internal scorecard: the parser gets 94% of syllabi right on the first try. 1,212 paying students so far.",
  },
];

describe("evidence bundle", () => {
  it("is deterministic and lists public sources before internal ones", () => {
    const a = buildEvidenceBundle({ productName: "SyllaCal", artifacts: [...artifacts].reverse(), research: [], assets: [], answers: [] });
    const b = buildEvidenceBundle({ productName: "SyllaCal", artifacts, research: [], assets: [], answers: [] });
    expect(a.markdown).toBe(b.markdown);
    expect(a.sourceMap.S1!.origin).toBe("owned_public");
    expect(a.sourceMap.S2!.origin).toBe("owned_internal");
    expect(a.markdown).toContain("## S2 · INTERNAL");
  });
});

describe("visibility rule", () => {
  const bundle = buildEvidenceBundle({
    productName: "SyllaCal",
    artifacts,
    research: [{ id: "r1", kind: "competitor", text: "Notion templates are free but manual", sourceUrl: "https://example.com" }],
    assets: [],
    answers: [],
  });

  it("an internal-only scorecard fact is never public, even when the model cites the website", () => {
    expect(claimIsPublic({ kind: "stat", text: "Gets 94% of syllabi right on the first try", quote: null, sourceIds: ["S2"] }, bundle)).toBe(false);
    expect(claimIsPublic({ kind: "stat", text: "Gets 94% of syllabi right on the first try", quote: null, sourceIds: ["S1"] }, bundle)).toBe(false);
    expect(claimIsPublic({ kind: "stat", text: "1,212 paying students", quote: "1,212 paying students", sourceIds: ["S1", "S2"] }, bundle)).toBe(false);
  });

  it("a fact stated on the website is public", () => {
    expect(claimIsPublic({ kind: "price", text: "Basic: $4.99 one-time", quote: null, sourceIds: ["S1"] }, bundle)).toBe(true);
    expect(claimIsPublic({ kind: "feature", text: "Syllabus to calendar in 15 seconds", quote: "turns your syllabus into a calendar in 15 seconds", sourceIds: ["S1"] }, bundle)).toBe(true);
  });

  it("a made-up price is not public even when cited", () => {
    expect(claimIsPublic({ kind: "price", text: "Pro: $19.99 one-time", quote: null, sourceIds: ["S1"] }, bundle)).toBe(false);
  });

  it("third-party pages back comparisons only", () => {
    expect(claimIsPublic({ kind: "comparison", text: "Notion templates are free but manual", quote: null, sourceIds: ["S3"] }, bundle)).toBe(true);
    expect(claimIsPublic({ kind: "stat", text: "Notion templates are free but manual", quote: null, sourceIds: ["S3"] }, bundle)).toBe(false);
  });

  it("supportedBy needs the quote verbatim", () => {
    expect(supportedBy("x", "No subscription, ever", artifacts[0]!.text)).toBe(true);
    expect(supportedBy("x", "No subscription, never ever", artifacts[0]!.text)).toBe(false);
  });
});

const dnaFixture = (): ProductDna => ({
  identity: {
    name: "SyllaCal",
    oneLiner: "Syllabus to calendar in 15 seconds",
    category: "Student productivity",
    platforms: ["web"],
    whoItsFor: "College students",
    audiences: [],
    jobs: ["Get every deadline into my calendar"],
    voice: { tone: "friendly", wordsToUse: [], wordsToAvoid: [] },
  },
  offer: {
    features: [{ name: "Upload a syllabus", description: "PDF in, events out" }],
    pricing: { model: "one_time", summary: "One-time plans", tiers: [{ name: "Basic", price: "$4.99", period: "one-time", notes: null }] },
    proof: [
      { kind: "stat", text: "Gets 94% of syllabi right on the first try", sourceIds: ["S2"], quote: "94% of syllabi right" },
      { kind: "feature", text: "Syllabus to calendar in 15 seconds", sourceIds: ["S1"], quote: "into a calendar in 15 seconds" },
    ],
    differentiators: ["No subscription"],
  },
  market: {
    competitors: [],
    pains: [],
    seasonality: { peaks: [{ months: "Aug–Sep", reason: "Fall semester" }], summary: "Back to school" },
    channels: [],
    searchTerms: [],
  },
});

describe("merge-evidence", () => {
  it("maps nested paths to top-level fields and drops unknown source ids", () => {
    expect(fieldPathOf("offer.pricing.tiers[0].price")).toBe("offer.pricing");
    const dna = dnaFixture();
    const merged = mergeEvidence(
      {
        identity: {
          values: dna.identity,
          evidence: [
            { path: "identity.oneLiner", sourceIds: ["S1", "S99"], quote: "15 seconds", confidence: "high" },
            { path: "identity.name", sourceIds: ["S1"], quote: null, confidence: "medium" },
          ],
          unsure: [{ path: "identity.whoItsFor", question: "Only college, or high school too?" }],
        },
        offer: { values: dna.offer, evidence: [{ path: "offer.pricing.tiers", sourceIds: ["S1"], quote: null, confidence: "high" }], unsure: [] },
        market: { values: dna.market, evidence: [], unsure: [] },
      },
      new Set(["S1", "S2"]),
    );
    expect(merged.fields["identity.oneLiner"]).toMatchObject({ sources: ["S1"], confidence: "high", quote: "15 seconds" });
    expect(merged.fields["offer.pricing"]!.sources).toEqual(["S1"]);
    expect(merged.fields["identity.whoItsFor"]).toMatchObject({ sources: [], confidence: "low", unsure: "Only college, or high school too?" });
    expect(merged.coveragePct).toBe(25); // 12 non-empty fields, 3 with sources
    expect(unsureItems(merged.fields).map((u) => u.path)).toContain("identity.whoItsFor");
  });

  it("pins survive a regenerate; edits pin", () => {
    const prevDna = dnaFixture();
    const fields: FieldMetaMap = {
      "identity.oneLiner": { confidence: "high", sources: ["S1"], quote: null, pinned: false, editedBy: "model", unsure: null },
    };
    const edited = editField(prevDna, fields, "identity.oneLiner", "Your whole semester, in your calendar");
    expect(edited.fields["identity.oneLiner"]).toMatchObject({ pinned: true, editedBy: "user" });

    const regenerated = dnaFixture();
    regenerated.identity.oneLiner = "A new model-written line";
    regenerated.identity.category = "Calendars";
    const out = applyPins({ dna: regenerated, fields: { "identity.oneLiner": { ...fields["identity.oneLiner"]! } } }, edited);
    expect(out.dna.identity.oneLiner).toBe("Your whole semester, in your calendar");
    expect(out.fields["identity.oneLiner"]!.editedBy).toBe("user");
    expect(out.dna.identity.category).toBe("Calendars"); // unpinned fields take the new value
    expect(() => editField(prevDna, fields, "identity.voice.tone", "x")).toThrow();
  });
});

describe("claims", () => {
  it("scorecard facts become internal claims; website facts and prices are public", () => {
    const bundle = buildEvidenceBundle({ productName: "SyllaCal", artifacts, research: [], assets: [], answers: [] });
    const fields: FieldMetaMap = {
      "offer.pricing": { confidence: "high", sources: ["S1"], quote: null, pinned: false, editedBy: "model", unsure: null },
    };
    const claims = buildClaims(dnaFixture(), fields, bundle, new Date("2026-10-01T00:00:00Z"));
    expect(claims.map((c) => [c.ref, c.kind, c.publicOk])).toEqual([
      ["C1", "stat", false],
      ["C2", "feature", true],
      ["C3", "price", true],
    ]);
  });

  it("package.json keeps product facts, never scripts", () => {
    const facts = packageFactsForTest(JSON.stringify({ name: "syllacal", description: "d", scripts: { deploy: "secret" }, dependencies: { next: "1" } }));
    expect(facts).toContain("syllacal");
    expect(facts).not.toContain("deploy");
  });
});

describe("launch date (D21)", () => {
  const now = new Date("2026-10-01T12:00:00Z"); // a Thursday
  it("keeps a seasonal date at least 14 days out", () => {
    expect(defaultLaunchDate("2027-01-19", now)).toBe("2027-01-19");
  });
  it("falls back to the first Tuesday 14+ days out", () => {
    expect(defaultLaunchDate(null, now)).toBe("2026-10-20");
    expect(defaultLaunchDate("2026-10-05", now)).toBe("2026-10-20");
    expect(defaultLaunchDate("not a date", now)).toBe("2026-10-20");
  });
});
