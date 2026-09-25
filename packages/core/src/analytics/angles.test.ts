import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import type { CampaignPlan, PlanSlot } from "@mkt/contracts";
import { schema, uuidv7, type Db } from "@mkt/db";
import { createTestDb } from "@mkt/db/testing";
import { seedVideoWorld, type VideoWorld } from "../video/testing.ts";
import { makeMoreEstimate, makeMoreForAngle, setAngleStatus, slotsForMore } from "./angles.ts";

const NOW = new Date("2026-10-02T12:00:00Z");

const slot = (id: string, day: number, over: Partial<PlanSlot> = {}): PlanSlot =>
  ({
    id,
    day,
    kind: "post",
    platform: "x",
    format: "text",
    lineKey: "text",
    scheduledAt: new Date(Date.UTC(2026, 9, day, 15)).toISOString(),
    status: "open",
    openReason: "make_more",
    deliverableKey: null,
    masterIdx: null,
    launch: false,
    angleIdx: 0,
    ...over,
  }) as unknown as PlanSlot;

describe("slotsForMore", () => {
  it("takes open future slots, soonest first, skipping past, coming-soon and filled ones", () => {
    const plan = {
      slots: [
        slot("past", 1),
        slot("late", 20),
        slot("soon", 5),
        slot("soonvid", 4, { kind: "video", openReason: "coming_soon" } as Partial<PlanSlot>),
        slot("filled", 6, { status: "filled", deliverableKey: "post:a" } as Partial<PlanSlot>),
        slot("freed", 7, { status: "filled", deliverableKey: "post:b" } as Partial<PlanSlot>),
        slot("email", 8, { kind: "email" } as Partial<PlanSlot>),
      ],
    } as Pick<CampaignPlan, "slots">;
    const items = [
      { deliverableKey: "post:a", status: "ready" },
      { deliverableKey: "post:b", status: "skipped" },
    ];
    expect(slotsForMore(plan, items, NOW).map((s) => s.id)).toEqual(["soon", "freed", "late"]);
    expect(slotsForMore(plan, items, NOW, 1).map((s) => s.id)).toEqual(["soon"]);
  });
});

describe("angle actions", () => {
  let db: Db;
  let close: () => Promise<void>;
  let w: VideoWorld;
  let angleId: string;
  beforeAll(async () => {
    ({ db, close } = await createTestDb());
    w = await seedVideoWorld(db);
    const [strategy] = await db.select().from(schema.strategies).where(eq(schema.strategies.productId, w.productId));
    angleId = uuidv7();
    await db.insert(schema.angles).values([
      { id: uuidv7(), workspaceId: w.ws, strategyId: strategy!.id, idx: 0, card: {}, sharePct: 60 },
      { id: angleId, workspaceId: w.ws, strategyId: strategy!.id, idx: 1, card: {}, sharePct: 40 },
    ]);
    await db
      .update(schema.campaigns)
      .set({ plan: { slots: [slot("a", 5), slot("b", 9), slot("old", 1)], items: [] } })
      .where(eq(schema.campaigns.id, w.campaignId));
  });
  afterAll(async () => close());

  it("prices Make more from the open slots", async () => {
    const e = await makeMoreEstimate(db, w.ws, w.productId, NOW);
    expect(e.count).toBe(2);
    expect(e.estimateMicros).toBeGreaterThan(0);
  });

  it("points the refill's new items at the chosen angle", async () => {
    const r = await makeMoreForAngle(db, w.ws, w.productId, angleId, NOW);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.count).toBe(2);
    const items = await db.select().from(schema.contentItems).where(eq(schema.contentItems.runId, r.runId));
    expect(items.every((i) => i.angleId === angleId && (i.brief as { angleIdx?: number }).angleIdx === 1)).toBe(true);
    const [c] = await db.select().from(schema.campaigns).where(eq(schema.campaigns.id, w.campaignId));
    const plan = c!.plan as unknown as CampaignPlan;
    expect(plan.items.every((i) => i.angleIdx === 1)).toBe(true);
    const again = await makeMoreForAngle(db, w.ws, w.productId, angleId, NOW);
    expect(again).toEqual({ ok: false, reason: expect.stringMatching(/no open days/) });
  });

  it("stops an angle, scoped to the workspace, and refuses Make more for it", async () => {
    expect(await setAngleStatus(db, uuidv7(), w.productId, angleId, "stopped")).toBe(false);
    expect(await setAngleStatus(db, w.ws, w.productId, angleId, "stopped")).toBe(true);
    const [a] = await db.select().from(schema.angles).where(eq(schema.angles.id, angleId));
    expect(a!.status).toBe("stopped");
    const r = await makeMoreForAngle(db, w.ws, w.productId, angleId, NOW);
    expect(r.ok).toBe(false);
  });
});
