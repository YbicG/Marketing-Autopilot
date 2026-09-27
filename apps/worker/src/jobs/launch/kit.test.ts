// launch.kit: the ads export is handed to the injected ads module; Reddit rules are parsed to text.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createKitRun, type AdsKitCtx } from "@mkt/core/launch";
import { schema, uuidv7, type Db } from "@mkt/db";
import { createTestDb } from "@mkt/db/testing";
import { launchKitJob, redditRulesFetcher, redditRulesText, type LaunchKitWorkerDeps } from "./kit.ts";

let db: Db;
let close: () => Promise<void>;
let ws: string;
let planId: string;

const noRates = async () => () => {
  throw new Error("no Claude call expected here");
};

beforeAll(async () => {
  ({ db, close } = await createTestDb());
  ws = uuidv7();
  const productId = uuidv7();
  planId = uuidv7();
  await db.insert(schema.workspaces).values({ id: ws, name: "t" });
  await db.insert(schema.products).values({ id: productId, workspaceId: ws, slug: "syllacal", name: "SyllaCal", urls: { website: "https://syllacal.com/" } });
  await db.insert(schema.launchPlans).values({ id: planId, workspaceId: ws, productId, startDate: "2027-01-06", launchDate: "2027-01-19", status: "active", templateVersion: "lc-v1" });
});
afterAll(() => close());

const kitRow = async (id: string) => (await db.select().from(schema.launchKits)).find((k) => k.id === id)!;

describe("launchKitJob", () => {
  it("hands an ads_export kit to deps.adsKit with its own run", async () => {
    const r = (await createKitRun(db, ws, { launchPlanId: planId, kinds: ["ads_export"], inputs: {}, userId: "cj" }))!;
    const calls: AdsKitCtx[] = [];
    const deps: LaunchKitWorkerDeps = { db, rates: noRates, adsKit: async (c) => void calls.push(c) };
    await launchKitJob(deps, { runId: r.runId, kitId: r.kitIds[0]! });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ runId: r.runId, kitId: r.kitIds[0], workspaceId: ws, launchPlanId: planId });
  });

  it("does nothing for a run or kit that doesn't exist", async () => {
    const calls: AdsKitCtx[] = [];
    await launchKitJob({ db, rates: noRates, adsKit: async (c) => void calls.push(c) }, { runId: uuidv7(), kitId: uuidv7() });
    expect(calls).toHaveLength(0);
  });

  it("without the ads module the kit is Needs you", async () => {
    const r = (await createKitRun(db, ws, { launchPlanId: planId, kinds: ["ads_export"], inputs: {}, userId: "cj" }))!;
    await launchKitJob({ db, rates: noRates }, { runId: r.runId, kitId: r.kitIds[0]! });
    expect((await kitRow(r.kitIds[0]!)).status).toBe("needs_you");
  });
});

describe("reddit rules", () => {
  const json = { rules: [{ short_name: "No spam", description: "Self-promotion only\nin the weekly thread." }, { short_name: "Be kind" }, { foo: 1 }] };

  it("turns rules.json into numbered plain text", () => {
    expect(redditRulesText(json)).toBe("1. No spam: Self-promotion only in the weekly thread.\n2. Be kind");
    expect(redditRulesText({})).toBe("");
    expect(redditRulesText(null)).toBe("");
  });

  it("fetches r/<sub>/about/rules.json and refuses empty answers", async () => {
    const urls: string[] = [];
    const at = new Date("2027-01-10T00:00:00Z");
    const ok = redditRulesFetcher(async (url) => (urls.push(url), { status: 200, text: JSON.stringify(json) }), () => at);
    const rules = await ok("reddit", "r/UIUC");
    expect(urls).toEqual(["https://www.reddit.com/r/UIUC/about/rules.json"]);
    expect(rules).toEqual({ url: "https://www.reddit.com/r/UIUC/about/rules", text: expect.stringContaining("No spam"), fetchedAt: at });

    await expect(redditRulesFetcher(async () => ({ status: 404, text: "" }))("reddit", "gone")).rejects.toThrow(/404/);
    await expect(redditRulesFetcher(async () => ({ status: 200, text: "<html>" }))("reddit", "x")).rejects.toThrow(/No rules/);
    await expect(ok("x" as never, "UIUC")).rejects.toThrow();
  });
});
