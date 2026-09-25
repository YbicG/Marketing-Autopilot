import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import type { RunEvent } from "@mkt/contracts";
import { schema, uuidv7, type Db } from "@mkt/db";
import { createTestDb } from "@mkt/db/testing";
import { fakeClient, jsonReply, text } from "../ai/testing.ts";
import type { RateLookup } from "../ai/usage.ts";
import { loadRateCards, rateLookup, seedPricingRates } from "../cost/rates.ts";
import { fsStorage, type Storage } from "../media/storage.ts";
import { briefMarkdown, confirmDna, createRegenerateRun, currentDna, editDnaField, executeRegenerateRun, publicClaimsFor } from "./dna.ts";
import { processFolderUpload } from "./folder.ts";
import { createIngestRun, executeIngestRun } from "./run.ts";
import { executeStrategyRun, latestStrategy } from "./strategy.ts";
import type { SiteCapture } from "./types.ts";

let db: Db;
let close: () => Promise<void>;
let rates: RateLookup;
let dir: string;
let store: Storage;
let ws: string;

beforeAll(async () => {
  ({ db, close } = await createTestDb());
  await seedPricingRates(db);
  rates = rateLookup(await loadRateCards(db));
  dir = await mkdtemp(join(tmpdir(), "mkt-ingest-"));
  store = fsStorage(dir);
  ws = uuidv7();
  await db.insert(schema.workspaces).values({ id: ws, name: "t" });
});
afterAll(async () => {
  await close();
  await rm(dir, { recursive: true, force: true });
});

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4, 5]);
const site: SiteCapture = {
  finalUrl: "https://syllacal.com/",
  pages: [
    { url: "https://syllacal.com/", title: "SyllaCal", rank: 0, markdown: "# SyllaCal\nTurn your syllabus into a calendar in 15 seconds. No subscription, ever." },
    { url: "https://syllacal.com/pricing", title: "Pricing", rank: 1, markdown: "Basic $4.99 one-time. Plus $9.99 one-time. Pro $19.99 one-time." },
  ],
  screenshots: [{ pageUrl: "https://syllacal.com/", viewport: "desktop", png: PNG, preview: new Uint8Array([0xff, 0xd8, 0xff, 1]), width: 2880, height: 1800 }],
  brand: { colors: ["#4f46e5"], fonts: ["Inter"], logoUrl: null, themeColor: null },
  meta: { description: null, ogImage: null, githubUrl: null },
};

const section = (s: string) => {
  if (s === "identity") {
    return {
      values: {
        name: "SyllaCal",
        oneLiner: "Syllabus to calendar in 15 seconds",
        category: "Student productivity",
        platforms: ["web"],
        whoItsFor: "College students",
        audiences: [{ name: "Students", description: "Undergrads", painPoints: ["Missed deadlines"] }],
        jobs: ["Get every deadline into my calendar"],
        voice: { tone: "friendly", wordsToUse: ["semester"], wordsToAvoid: ["synergy"] },
      },
      evidence: [
        { path: "identity.name", sourceIds: ["S1"], quote: null, confidence: "high" },
        { path: "identity.oneLiner", sourceIds: ["S1"], quote: "into a calendar in 15 seconds", confidence: "high" },
      ],
      unsure: [{ path: "identity.whoItsFor", question: "High school students too?" }],
    };
  }
  if (s === "offer") {
    return {
      values: {
        features: [{ name: "Upload", description: "PDF in, events out" }],
        pricing: {
          model: "one_time",
          summary: "Three one-time plans",
          tiers: [
            { name: "Basic", price: "$4.99", period: "one-time", notes: null },
            { name: "Plus", price: "$9.99", period: "one-time", notes: null },
          ],
        },
        proof: [
          { kind: "stat", text: "Gets 94% of syllabi right on the first try", sourceIds: ["S3"], quote: null },
          { kind: "feature", text: "No subscription, ever", sourceIds: ["S1"], quote: "No subscription, ever" },
        ],
        differentiators: ["One-time price"],
      },
      evidence: [{ path: "offer.pricing.tiers", sourceIds: ["S2"], quote: null, confidence: "high" }],
      unsure: [],
    };
  }
  return {
    values: {
      competitors: [{ name: "Notion templates", url: null, howTheyDiffer: "Manual" }],
      pains: [{ text: "Typing deadlines in by hand takes hours", sourceUrl: null }],
      seasonality: { peaks: [{ months: "Aug–Sep", reason: "Fall semester" }], summary: "Back to school" },
      channels: [{ platform: "TikTok", why: "Students" }],
      searchTerms: ["syllabus to calendar"],
    },
    evidence: [{ path: "market.seasonality", sourceIds: ["S1"], quote: null, confidence: "medium" }],
    unsure: [],
  };
};

let strategyCalls = 0;
function router(params: Record<string, unknown>) {
  const sys = String(params.system);
  if (sys.includes("You label product screenshots")) {
    return jsonReply({ kind: "hero", caption: "Home page hero", visibleText: "SyllaCal", uiRegions: [], hasPeople: false, hasPersonalData: false, usefulForMarketing: true });
  }
  if (sys.includes("Ask the developer at most")) {
    return jsonReply({ questions: [{ path: "identity.whoItsFor", question: "Who is it for?", why: "audience", options: ["College", "High school"] }] });
  }
  if (sys.includes("You research the market")) return { stop_reason: "end_turn" as const, content: [text("Done researching.")] };
  if (sys.includes("Turn research notes")) {
    return jsonReply({
      findings: [],
      competitors: [{ name: "Notion templates", url: "https://notion.so", summary: "Free, manual", pricing: null, sourceUrl: "https://notion.so" }],
      pains: [{ text: "Typing deadlines in by hand takes hours", audience: "students", sourceUrl: "https://reddit.com/r/college" }],
    });
  }
  const m = /Section: (identity|offer|market)/.exec(sys);
  if (m) return jsonReply(section(m[1]!));
  if (sys.includes("marketing lead")) {
    strategyCalls++;
    const angle = (title: string) => ({
      title,
      forWho: "Students",
      insteadOf: "Typing dates by hand",
      promise: "Every deadline in your calendar",
      sampleOpeningLine: "Your syllabus, done in 15 seconds",
      bestOn: ["TikTok"],
      whyWeSuggest: "It's the core job",
      claimIds: ["C1", "C2", "C9"],
      screenshotAssetIds: ["not-an-asset"],
    });
    return jsonReply({
      angles: [angle("Syllabus week, done in 15 seconds"), angle("See your hell week before it hits"), angle("No subscription, ever"), angle("extra")],
      messaging: { oneLiners: ["a"], elevatorPitch: "p", objections: [], wordsToUse: [], wordsToAvoid: [] },
      channelPlan: [{ platform: "TikTok", role: "reach", cadence: "daily" }],
      launchWindow: { suggestedDate: "2027-01-19", reason: "Spring semester" },
    });
  }
  throw new Error(`unrouted call: ${sys.slice(0, 80)}`);
}

describe("ingest → strategy (fakes)", () => {
  it("reads the product, writes a DNA version with claims, then 3 angles", async () => {
    // A body that wasn't in the manifest is refused outright.
    await expect(
      processFolderUpload(db, store, ws, { rootName: "x", files: [] }, new Map([[".env", new Uint8Array([1])]])),
    ).rejects.toThrow(/wasn't in the list/);

    const readme = new TextEncoder().encode("# SyllaCal\nAWS key AKIAIOSFODNN7EXAMPLE lives here.\n");
    const scorecard = new TextEncoder().encode("Internal scorecard: the parser gets 94% of syllabi right on the first try.\n");
    const gitConfig = new TextEncoder().encode('[remote "origin"]\n\turl = git@github.com:cj/SyllaCal.git\n');
    const folder = await processFolderUpload(
      db,
      store,
      ws,
      {
        rootName: "SyllaCal",
        files: [
          { path: "README.md", size: readme.byteLength, kind: "readme" },
          { path: "docs/scorecard.md", size: scorecard.byteLength, kind: "doc" },
          { path: ".git/config", size: gitConfig.byteLength, kind: "git_config" },
        ],
      },
      new Map([
        ["README.md", readme],
        ["docs/scorecard.md", scorecard],
        [".git/config", gitConfig],
      ]),
    );
    expect(folder.gitRemote).toBe("https://github.com/cj/SyllaCal");
    expect(folder.secretHits).toBeGreaterThan(0);
    const storedReadme = (await store.get(folder.files.find((f) => f.path === "README.md")!.storageKey)).toString();
    expect(storedReadme).not.toContain("AKIAIOSFODNN7EXAMPLE");

    const { runId, productId, slug } = await createIngestRun(db, ws, {
      links: ["syllacal.com"],
      notes: "Launching for spring semester.",
      folderUploadId: folder.id,
    });
    expect(slug).toBe("syllacal");

    const events: RunEvent[] = [];
    const enqueued: string[] = [];
    const { client, calls } = fakeClient(Array.from({ length: 30 }, () => router));
    const deps = {
      db,
      rates,
      storage: store,
      client,
      publish: async (e: RunEvent) => void events.push(e),
      captureSite: async () => site,
      // GitHub is unreachable in this test: the repo step warns and the run continues.
      fetchText: async (url: string) => ({ url, status: 404, contentType: "application/json", text: "{}" }),
      answerWaitMs: 0,
      enqueueStrategy: async (id: string) => void enqueued.push(id),
    };
    await executeIngestRun(deps, runId);

    const types = events.map((e) => e.type);
    expect(types.at(-1)).toBe("run_completed");
    expect(types).toContain("question_ready");
    expect(types).toContain("stage_warning"); // private/missing repo
    expect(events.filter((e) => e.type === "competitor_found")).toHaveLength(0); // sink only fires on tool calls
    expect(calls.some((c) => JSON.stringify(c.tools ?? []).includes("web_search_20260209"))).toBe(true);

    const [run] = await db.select().from(schema.generationRuns).where(eq(schema.generationRuns.id, runId));
    expect(run!.status).toBe("completed");
    const dna = await currentDna(db, productId);
    expect(dna!.version).toBe(1);
    expect(dna!.dna.identity.name).toBe("SyllaCal");
    expect(dna!.coveragePct).toBeGreaterThan(0);

    // The scorecard stat cited an internal source → never public. Website facts and prices are.
    const claims = await db.select().from(schema.claims).where(eq(schema.claims.dnaVersionId, dna!.id));
    const byText = Object.fromEntries(claims.map((c) => [c.text, c.publicOk]));
    expect(byText["Gets 94% of syllabi right on the first try"]).toBe(false);
    expect(byText["No subscription, ever"]).toBe(true);
    expect(byText["Basic: $4.99 one-time"]).toBe(true);

    // Screenshot stored and labeled.
    const shots = await db.select().from(schema.assets).where(eq(schema.assets.productId, productId));
    expect(shots.find((a) => a.kind === "screenshot")!.labels).toMatchObject({ caption: "Home page hero" });

    // Strategy run.
    expect(enqueued).toHaveLength(1);
    await executeStrategyRun({ ...deps, publish: async () => undefined }, enqueued[0]!);
    const strategy = await latestStrategy(db, productId);
    expect(strategy!.angles.map((a) => a.sharePct)).toEqual([60, 20, 20]);
    const publicRefs = new Set(claims.filter((c) => c.publicOk).map((c) => c.ref));
    for (const a of strategy!.output.angles) {
      expect(a.claimIds.every((id) => publicRefs.has(id))).toBe(true);
      expect(a.screenshotAssetIds).toEqual([]);
    }
    expect(strategy!.launchDate).toBe("2027-01-19");
    expect(strategyCalls).toBe(1);

    // Edit pins; regenerate keeps the pin and makes version 2.
    await editDnaField(db, ws, dna!.id, "identity.oneLiner", "Your whole semester, in your calendar");
    expect(await confirmDna(db, ws, dna!.id)).toBe(true);
    const regen = await createRegenerateRun(db, ws, productId);
    await executeRegenerateRun({ ...deps, publish: async () => undefined }, regen!);
    const v2 = await currentDna(db, productId);
    expect(v2!.version).toBe(2);
    expect(v2!.dna.identity.oneLiner).toBe("Your whole semester, in your calendar");
    expect(v2!.fields["identity.oneLiner"]!.pinned).toBe(true);

    const md = briefMarkdown({
      productName: "SyllaCal",
      dna: v2!.dna,
      strategy: strategy!.output,
      launchDate: strategy!.launchDate,
      publicClaims: await publicClaimsFor(db, v2!.id),
    });
    expect(md).toContain("# SyllaCal: marketing brief");
    expect(md).not.toContain("94%");
  });

  it("refuses an empty intake and another workspace's folder", async () => {
    await expect(createIngestRun(db, ws, { links: [], notes: null, folderUploadId: null })).rejects.toThrow(/Add a link/);
    await expect(createIngestRun(db, uuidv7(), { links: [], notes: null, folderUploadId: uuidv7() })).rejects.toThrow(/wasn't found/);
  });
});
