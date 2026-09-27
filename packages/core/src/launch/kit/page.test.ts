import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { schema, uuidv7, type Db } from "@mkt/db";
import { createTestDb } from "@mkt/db/testing";
import { resolveKitLinks } from "./export.ts";
import { kitFileCtxFor, kitPlanForProduct, lastKitInputs } from "./page.ts";

let db: Db;
let close: () => Promise<void>;
let ws: string;
let productId: string;

beforeAll(async () => {
  ({ db, close } = await createTestDb());
  ws = uuidv7();
  productId = uuidv7();
  await db.insert(schema.workspaces).values({ id: ws, name: "t" });
  await db.insert(schema.products).values({ id: productId, workspaceId: ws, slug: "syllacal", name: "SyllaCal", kind: "web_b2c", urls: {} });
});
afterAll(async () => close());

const plan = async (status: "draft" | "active" | "done", launchDate: string) => {
  const id = uuidv7();
  await db.insert(schema.launchPlans).values({ id, workspaceId: ws, productId, startDate: "2026-12-20", launchDate, status, templateVersion: "v1" });
  return id;
};

describe("kit page reads", () => {
  it("finds the active plan first, else the newest draft, never a finished one or another workspace's", async () => {
    expect(await kitPlanForProduct(db, ws, productId)).toBeNull();
    await plan("done", "2026-01-19");
    expect(await kitPlanForProduct(db, ws, productId)).toBeNull();
    const draft = await plan("draft", "2027-01-19");
    expect((await kitPlanForProduct(db, ws, productId))?.id).toBe(draft);
    const active = await plan("active", "2027-01-20");
    await plan("draft", "2027-01-21");
    expect(await kitPlanForProduct(db, ws, productId)).toEqual({ id: active, launchDate: "2027-01-20", status: "active" });
    expect(await kitPlanForProduct(db, uuidv7(), productId)).toBeNull();
  });

  it("merges each kit's inputs from its own run and drops invalid ones", async () => {
    const planId = await plan("draft", "2027-02-01");
    expect(await lastKitInputs(db, ws, planId)).toEqual({});
    const runA = uuidv7();
    const runB = uuidv7();
    const run = (id: string, inputs: unknown) =>
      db.insert(schema.generationRuns).values({ id, workspaceId: ws, productId, kind: "launch_kit", status: "completed", input: { inputs }, capMicros: 1_000_000 });
    // Run A wrote the subreddit and reply bank kits; run B later rewrote the reply bank alone.
    await run(runA, { subreddit: { communities: ["college"], dueDate: null }, reply_bank: { extraQuestions: ["old"] }, creator: { offer: 5 } });
    await run(runB, { reply_bank: { extraQuestions: ["Is it free?"] } });
    const kit = (kind: "subreddit" | "reply_bank" | "creator", runId: string) =>
      db.insert(schema.launchKits).values({ id: uuidv7(), workspaceId: ws, productId, launchPlanId: planId, kind, runId });
    await kit("subreddit", runA);
    await kit("reply_bank", runB);
    await kit("creator", runA);
    expect(await lastKitInputs(db, ws, planId)).toEqual({
      subreddit: { communities: ["college"], dueDate: null },
      reply_bank: { extraQuestions: ["Is it free?"] },
    });
    expect(await lastKitInputs(db, uuidv7(), planId)).toEqual({});
    await db.delete(schema.launchKits).where(eq(schema.launchKits.launchPlanId, planId));
  });

  it("resolves {{link:landing}} on screen the way the download does", () => {
    const ctx = kitFileCtxFor({ name: "SyllaCal", slug: "syllacal", urls: { website: "https://syllacal.com" } }, "2027-01-19");
    const out = resolveKitLinks("Get it: {{link:landing}}", ctx, "reply_bank");
    expect(out).toContain("https://syllacal.com");
    expect(out).toContain("utm_campaign=syllacal-launch");
    expect(resolveKitLinks("{{link:landing}}", kitFileCtxFor({ name: "X", slug: "x", urls: {} }, "2027-01-19"), "press")).toBe("[your website]");
  });
});
