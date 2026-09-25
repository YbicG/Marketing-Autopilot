import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import type { CaptureFlowPlanModel, CaptureStepModel } from "@mkt/contracts";
import { schema, uuidv7, type Db } from "@mkt/db";
import { createTestDb } from "@mkt/db/testing";
import { fakeClient, jsonReply } from "../ai/testing.ts";
import type { RateLookup } from "../ai/usage.ts";
import { loadRateCards, rateLookup, seedPricingRates } from "../cost/rates.ts";
import { getSecret } from "../security/vault.ts";
import { captureLoginPurpose, captureView, estimateFlowPlanMicros, plannerPageText, saveDemoLogin, suggestFlows } from "./setup.ts";

let db: Db;
let close: () => Promise<void>;
let rates: RateLookup;
const ws = uuidv7();
const productId = uuidv7();
const saved: Record<string, string | undefined> = {};

beforeAll(async () => {
  for (const k of ["MKT_KEK_V1_B64", "MKT_KEK_ACTIVE"]) saved[k] = process.env[k];
  process.env.MKT_KEK_V1_B64 = randomBytes(32).toString("base64");
  process.env.MKT_KEK_ACTIVE = "1";
  ({ db, close } = await createTestDb());
  await seedPricingRates(db);
  rates = rateLookup(await loadRateCards(db));
  await db.insert(schema.workspaces).values({ id: ws, name: "t" });
  await db.insert(schema.products).values({ id: productId, workspaceId: ws, slug: "syllacal", name: "SyllaCal", captureRouteDenylist: ["/billing"] });
  const sourceId = uuidv7();
  await db.insert(schema.sources).values({ id: sourceId, workspaceId: ws, productId, kind: "website", url: "https://syllacal.com", visibility: "public_ok" });
  await db.insert(schema.sourceArtifacts).values({ id: uuidv7(), workspaceId: ws, sourceId, kind: "page", title: "Home", url: "https://syllacal.com/features", text: "Upload your syllabus. See your week." });
});
afterAll(async () => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  await close();
});

const step = (s: Partial<CaptureStepModel>): CaptureStepModel => ({ kind: "click", path: null, target: null, text: null, direction: null, amountPx: null, ms: null, key: null, note: "", ...s });

describe("demo capture setup", () => {
  it("saves the demo login as JSON in the vault and only reports that it exists", async () => {
    await expect(saveDemoLogin(db, ws, productId, { username: "demo", password: "" })).rejects.toThrow(/both/);
    await expect(saveDemoLogin(db, ws, productId, { username: "demo", password: "pw", loginPath: "https://x" })).rejects.toThrow(/path/);
    await expect(saveDemoLogin(db, uuidv7(), productId, { username: "demo", password: "pw" })).rejects.toThrow(/not found/);
    expect((await captureView(db, ws, productId))!.hasLogin).toBe(false);
    await saveDemoLogin(db, ws, productId, { username: " demo ", password: "s3cret-pass", loginPath: "/login" });
    expect(JSON.parse((await getSecret(db, ws, captureLoginPurpose(productId)))!)).toEqual({ username: "demo", password: "s3cret-pass", loginPath: "/login" });
    const view = await captureView(db, ws, productId);
    expect(view!.hasLogin).toBe(true);
    expect(JSON.stringify(view)).not.toContain("s3cret-pass");
    expect(await captureView(db, uuidv7(), productId)).toBeNull();
  });

  it("plans from the product's own pages, by path only", async () => {
    const text = await plannerPageText(db, ws, productId);
    expect(text).toContain("(/features)");
    expect(text).not.toContain("syllacal.com");
    expect(estimateFlowPlanMicros(rates)).toBeGreaterThan(0);
  });

  it("suggests flows under a capture run and saves them unconfirmed", async () => {
    const reply: CaptureFlowPlanModel = {
      flows: [
        {
          name: "See the week",
          shows: "The week view",
          needsLogin: true,
          steps: [step({ kind: "goto", path: "/week" }), step({ kind: "goto", path: "/billing" })],
        },
      ],
    };
    const { client } = fakeClient([jsonReply(reply)]);
    const r = await suggestFlows({ db, rates, client }, { workspaceId: ws, productId });
    expect(r.flowIds).toHaveLength(1);
    expect(r.dropped.length).toBeGreaterThan(0);
    const [run] = await db.select().from(schema.generationRuns).where(eq(schema.generationRuns.id, r.runId));
    expect(run).toMatchObject({ kind: "capture", status: "completed" });
    const view = await captureView(db, ws, productId);
    expect(view!.flows[0]).toMatchObject({ name: "See the week", confirmedAt: null, recording: null });

    const bad = fakeClient([jsonReply({ nope: 1 }), jsonReply({ nope: 2 }), jsonReply({ nope: 3 })]);
    await expect(suggestFlows({ db, rates, client: bad.client }, { workspaceId: ws, productId })).rejects.toThrow();
    const runs = await db.select().from(schema.generationRuns).where(eq(schema.generationRuns.kind, "capture"));
    expect(runs.some((x) => x.status === "failed")).toBe(true);
  });
});
