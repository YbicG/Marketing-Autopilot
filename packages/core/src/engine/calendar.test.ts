import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { CampaignPlan, GENERATORS, type SocialPlatform } from "@mkt/contracts";
import { defaultLaunchDate } from "../ingest/strategy.ts";
import {
  CONNECTION_HARD_MAX,
  MASTER_SPACING_DAYS,
  PRODUCT_CAP_PER_DAY,
  addDays,
  planCalendar,
  weekday,
  zonedToUtc,
  type PlatformPlanInput,
} from "./calendar.ts";
import { buildRecipe, slotsPerPlatform } from "./recipe.ts";

const ALL = [...GENERATORS];
const TZ = "America/New_York";

function counts(plan: CampaignPlan) {
  const m = new Map<string, number>();
  for (const s of plan.slots) m.set(`${s.platform}|${s.date}`, (m.get(`${s.platform}|${s.date}`) ?? 0) + 1);
  return m;
}

describe("zonedToUtc", () => {
  it("handles DST on both sides", () => {
    expect(zonedToUtc("2026-07-01", "19:30", TZ)).toBe("2026-07-01T23:30:00.000Z");
    expect(zonedToUtc("2026-12-01", "19:30", TZ)).toBe("2026-12-02T00:30:00.000Z");
    expect(zonedToUtc("2026-11-01", "21:00", TZ)).toBe("2026-11-02T02:00:00.000Z");
    expect(zonedToUtc("2026-10-20", "08:30", "America/Los_Angeles")).toBe("2026-10-20T15:30:00.000Z");
  });
});

describe("planCalendar", () => {
  const launch = "2026-10-20"; // a Tuesday

  it("puts the launch on D14, a Tuesday, and every platform posts that day", () => {
    const plan = planCalendar({ recipe: buildRecipe("web_b2c", "standard", { generators: ALL }), launchDate: launch, timezone: TZ });
    expect(CampaignPlan.parse(plan)).toBeTruthy();
    expect(plan.launchDay).toBe(14);
    expect(plan.startDate).toBe("2026-10-07");
    expect(weekday(addDays(plan.startDate, 13))).toBe(2);
    const launchSlots = plan.slots.filter((s) => s.launch);
    expect(new Set(launchSlots.map((s) => s.platform))).toEqual(new Set(["tiktok", "instagram", "youtube", "threads", "x"]));
    expect(launchSlots.every((s) => s.day === 14)).toBe(true);
    // Launch items lead with angle #1.
    const launchItems = plan.items.filter((i) => i.launch);
    expect(launchItems.length).toBeGreaterThan(0);
    expect(launchItems.every((i) => i.angleIdx === 0)).toBe(true);
    expect(plan.warnings).toEqual([]);
  });

  it("fills the Standard cadence with no overflow and keeps the 60/20/20 mix", () => {
    const plan = planCalendar({ recipe: buildRecipe("web_b2c", "standard", { generators: ALL }), launchDate: launch, timezone: TZ });
    expect(plan.overflow).toEqual([]);
    const perPlatform: Record<string, number> = {};
    for (const s of plan.slots) perPlatform[s.platform] = (perPlatform[s.platform] ?? 0) + 1;
    expect(perPlatform).toEqual({ tiktok: 14, instagram: 14, youtube: 6, threads: 20, x: 22 });
    const sched = plan.items.filter((i) => i.day !== null);
    const share = (a: number) => sched.filter((i) => i.angleIdx === a).length / sched.length;
    expect(share(0)).toBeGreaterThan(0.5);
    expect(share(0)).toBeLessThan(0.7);
    expect(share(1)).toBeGreaterThan(0.12);
    expect(share(2)).toBeGreaterThan(0.12);
    // Students: 7–10 pm local.
    expect(plan.slots.every((s) => s.time >= "19:00" && s.time <= "22:00")).toBe(true);
  });

  it("shows video slots as Open when the generator is off (never padded)", () => {
    const plan = planCalendar({ recipe: buildRecipe("web_b2c", "standard"), launchDate: launch, timezone: TZ });
    const video = plan.slots.filter((s) => s.kind === "video");
    expect(video).toHaveLength(18);
    expect(video.every((s) => s.status === "open" && s.openReason === "coming_soon" && s.deliverableKey === null)).toBe(true);
    expect(plan.items.some((i) => i.kind === "video")).toBe(false);
    // The launch slot goes to something that will actually be written.
    // (YouTube only has videos in this recipe, so its launch slot stays Open.)
    const launchSlots = plan.slots.filter((s) => s.launch);
    expect(launchSlots.filter((s) => s.platform !== "youtube").every((s) => s.status === "filled")).toBe(true);
    expect(launchSlots.find((s) => s.platform === "youtube")!.status).toBe("open");
  });

  it("gives each account one opening line per master, all three lines used across accounts", () => {
    const plan = planCalendar({ recipe: buildRecipe("web_b2c", "standard", { generators: ALL }), launchDate: launch, timezone: TZ });
    const perMaster = new Map<number, number[]>();
    for (const s of plan.slots.filter((x) => x.kind === "video")) perMaster.set(s.masterIdx!, [...(perMaster.get(s.masterIdx!) ?? []), s.hookIdx!]);
    for (const hooks of perMaster.values()) expect(new Set(hooks).size).toBe(hooks.length);
    const seen = new Set<string>();
    for (const s of plan.slots.filter((x) => x.kind === "video")) {
      const k = `${s.platform}|${s.masterIdx}`;
      expect(seen.has(k)).toBe(false);
      seen.add(k);
    }
  });

  it("varies opening styles per platform", () => {
    const plan = planCalendar({ recipe: buildRecipe("web_b2c", "standard"), launchDate: launch, timezone: TZ });
    for (const p of ["x", "threads", "instagram"] as SocialPlatform[]) {
      const styles = plan.slots.filter((s) => s.platform === p && s.status === "filled").map((s) => s.openingStyle);
      for (let i = 1; i < styles.length; i++) expect(styles[i]).not.toBe(styles[i - 1]);
    }
  });

  it("reports overflow instead of breaking caps", () => {
    const x: PlatformPlanInput = { platform: "x", connectionId: "c1", shared: true, maxPerDay: 1, warmupUntil: null, usedByOthers: {}, schedule: null };
    const plan = planCalendar({ recipe: buildRecipe("web_b2c", "premium"), launchDate: launch, timezone: TZ, platforms: [x] });
    const xs = plan.slots.filter((s) => s.platform === "x");
    expect(xs.length).toBe(30);
    expect(plan.overflow.find((o) => o.platform === "x")!.count).toBe(34 - 30);
    expect(plan.warnings.some((w) => w.includes("didn't fit"))).toBe(true);
    expect(xs.every((s) => s.connectionId === "c1")).toBe(true);
  });

  it("uses D21's default launch (a Tuesday ≥14 days out)", () => {
    const d = defaultLaunchDate(null, new Date("2026-09-24T12:00:00Z"));
    const plan = planCalendar({ recipe: buildRecipe("web_b2c", "quick"), launchDate: d, timezone: TZ });
    expect(weekday(d)).toBe(2);
    expect(plan.launchDay).toBe(14);
  });
});

// ── properties ──

const platformArb = (p: SocialPlatform, start: string) =>
  fc.record({
    platform: fc.constant(p),
    connectionId: fc.option(fc.constant(`conn-${p}`), { nil: null }),
    shared: fc.boolean(),
    maxPerDay: fc.integer({ min: 1, max: 5 }),
    warmupUntil: fc.option(fc.integer({ min: 0, max: 12 }).map((n) => addDays(start, n)), { nil: null }),
    usedByOthers: fc.dictionary(
      fc.integer({ min: 0, max: 29 }).map((n) => addDays(start, n)),
      fc.integer({ min: 0, max: 3 }),
      { maxKeys: 10 },
    ),
    schedule: fc.option(
      fc.array(fc.record({ weekday: fc.integer({ min: 0, max: 6 }), time: fc.constantFrom("08:00", "12:30", "19:30", "21:00") }), { minLength: 1, maxLength: 14 }),
      { nil: null },
    ),
  });

describe("planner properties", () => {
  const launch = "2026-10-20";
  const start = addDays(launch, -13);
  const B2C: SocialPlatform[] = ["tiktok", "instagram", "youtube", "threads", "x"];

  it("never exceeds product, connection, shared-account or warm-up caps; accounts for every deliverable", () => {
    fc.assert(
      fc.property(
        fc.constantFrom("quick", "standard", "premium" as const),
        fc.boolean(),
        fc.tuple(...B2C.map((p) => platformArb(p, start))),
        fc.array(fc.tuple(fc.integer({ min: 0, max: 11 }), fc.integer({ min: 0, max: 11 })), { maxLength: 4 }),
        (tier, videosOn, inputs, overlaps) => {
          const recipe = buildRecipe("web_b2c", tier, { generators: videosOn ? ALL : undefined });
          const plan = planCalendar({ recipe, launchDate: launch, timezone: TZ, platforms: inputs, masterOverlaps: overlaps.filter(([a, b]) => a !== b) });
          const byP = new Map(inputs.map((i) => [i.platform, i]));
          for (const [k, n] of counts(plan)) {
            const [p, date] = k.split("|") as [SocialPlatform, string];
            const inp = byP.get(p)!;
            expect(n).toBeLessThanOrEqual(PRODUCT_CAP_PER_DAY);
            expect(n + (inp.usedByOthers[date] ?? 0)).toBeLessThanOrEqual(Math.max(Math.min(inp.maxPerDay, CONNECTION_HARD_MAX), inp.usedByOthers[date] ?? 0));
            if (inp.warmupUntil && date < inp.warmupUntil) expect(n).toBeLessThanOrEqual(1);
          }
          // Every scheduled deliverable is either a slot or reported overflow.
          const demand = slotsPerPlatform(recipe);
          for (const p of B2C) {
            const placed = plan.slots.filter((s) => s.platform === p).length;
            const over = plan.overflow.filter((o) => o.platform === p).reduce((a, o) => a + o.count, 0);
            expect(placed + over).toBe(demand[p] ?? 0);
          }
          // Open slots are exactly the switched-off generators'.
          for (const s of plan.slots) {
            const line = recipe.lines.find((l) => l.key === s.lineKey)!;
            expect(s.status === "open").toBe(!line.enabled);
            if (s.status === "filled") expect(plan.items.some((i) => i.deliverableKey === s.deliverableKey)).toBe(true);
          }
          // Overlapping masters stay ≥7 days apart on each account.
          for (const [a, b] of overlaps) {
            if (a === b) continue;
            for (const p of B2C) {
              const da = plan.slots.find((s) => s.platform === p && s.kind === "video" && s.masterIdx === a)?.day;
              const db = plan.slots.find((s) => s.platform === p && s.kind === "video" && s.masterIdx === b)?.day;
              if (da !== undefined && db !== undefined) expect(Math.abs(da - db)).toBeGreaterThanOrEqual(MASTER_SPACING_DAYS);
            }
          }
          expect(plan.launchDay).toBe(14);
          expect(CampaignPlan.safeParse(plan).success).toBe(true);
        },
      ),
      { numRuns: 60 },
    );
  });

  it("launch is D14 on a Tuesday for any default launch date", () => {
    fc.assert(
      fc.property(fc.date({ min: new Date("2026-01-01"), max: new Date("2028-12-31"), noInvalidDate: true }), (now) => {
        const d = defaultLaunchDate(null, now);
        const plan = planCalendar({ recipe: buildRecipe("web_b2c", "quick"), launchDate: d, timezone: TZ });
        expect(plan.launchDay).toBe(14);
        expect(weekday(addDays(plan.startDate, 13))).toBe(2);
      }),
      { numRuns: 50 },
    );
  });
});
