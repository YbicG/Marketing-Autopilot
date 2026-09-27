// launch.landing_audit and launch.tick with the browser, network and Claude faked.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createLandingAudit, startTrackingTest } from "@mkt/core/launch";
import type { Storage } from "@mkt/core/media";
import { BlockedUrl } from "@mkt/core/security";
import { schema, uuidv7, type Db } from "@mkt/db";
import { createTestDb } from "@mkt/db/testing";
import type { CaptureLanding, LandingCapture } from "./audit-capture.ts";
import { landingAuditJob, type LandingAuditDeps } from "./audit.ts";
import { launchTickJob } from "./tick.ts";

let db: Db;
let close: () => Promise<void>;
let ws: string;
let productId: string;
let planId: string;
const objects = new Map<string, Uint8Array>();
const storage: Storage = {
  put: async (k, b) => void objects.set(k, b),
  get: async (k) => Buffer.from(objects.get(k) ?? new Uint8Array()),
  delete: async (k) => void objects.delete(k),
};

// A 1×1 PNG header is enough for the asset row (pngSize isn't called on the fake path).
const png = (n: number) => new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, n]);

function capture(over: Partial<LandingCapture> = {}): LandingCapture {
  return {
    requestedUrl: "https://syllacal.com/",
    finalUrl: "https://syllacal.com/",
    redirectChain: [],
    status: 200,
    loadMs: 1_200,
    html: `<meta name="description" content="x"><h1>Syllabus to calendar</h1><p>$9.99 once</p><script>navigator.sendBeacon("/api/marketing/pv")</script>`,
    links: [{ href: "https://syllacal.com/start", text: "Try it free" }],
    scripts: [],
    meta: { "og:title": "SyllaCal", "og:image": "https://syllacal.com/og.png", description: "x" },
    desktop: { text: "Try it free", buttons: [{ text: "Try it free" }], png: png(1), width: 2880, height: 1800 },
    mobile: { text: "Try it free", buttons: [{ text: "Try it free" }], png: png(2), width: 780, height: 1688 },
    ...over,
  };
}

const keepParams = (url: string) => ({ url, redirects: [], status: 200 });

function deps(over: Partial<LandingAuditDeps> = {}): LandingAuditDeps & { heavy: number } {
  const d = {
    heavy: 0,
    db,
    storage,
    withHeavy: async <T>(fn: () => Promise<T>) => {
      d.heavy++;
      return fn();
    },
    captureLanding: (async () => capture()) as CaptureLanding,
    probeFetch: async (url: string) => keepParams(url),
    ...over,
  };
  return d;
}

const gates = async () => (await db.select().from(schema.launchTasks)).filter((t) => t.launchPlanId === planId);
const auditRow = async (id: string) => (await db.select().from(schema.landingAudits)).find((a) => a.id === id)!;

beforeAll(async () => {
  ({ db, close } = await createTestDb());
  ws = uuidv7();
  productId = uuidv7();
  planId = uuidv7();
  await db.insert(schema.workspaces).values({ id: ws, name: "t" });
  await db.insert(schema.products).values({ id: productId, workspaceId: ws, slug: "syllacal", name: "SyllaCal", urls: { website: "https://syllacal.com/" } });
  await db.insert(schema.launchPlans).values({ id: planId, workspaceId: ws, productId, startDate: "2027-01-06", launchDate: "2027-01-19", status: "active", templateVersion: "lc-v1" });
  for (const key of ["gate.tracking_test", "gate.pricing_visible", "gate.no_signup_wall", "gate.landing_audit"]) {
    await db.insert(schema.launchTasks).values({ id: uuidv7(), workspaceId: ws, launchPlanId: planId, key, title: key, mode: "gate", dayOffset: -3, dueDate: "2027-01-16" });
  }
});
afterAll(() => close());

describe("landingAuditJob", () => {
  it("captures under sem:heavy, stores both screenshots and passes the page gates", async () => {
    const { auditId } = await createLandingAudit(db, ws, productId);
    const d = deps();
    await landingAuditJob(d, { auditId });
    expect(d.heavy).toBe(1);
    const a = await auditRow(auditId);
    expect(a).toMatchObject({ status: "done", passed: true });
    expect(a.screenshotAssetIds).toHaveLength(2);
    expect(objects.size).toBe(2);
    const g = await gates();
    for (const key of ["gate.pricing_visible", "gate.no_signup_wall", "gate.landing_audit"]) expect(g.find((t) => t.key === key)!.status).toBe("done");
    expect(g.find((t) => t.key === "gate.tracking_test")!.status).not.toBe("done");
  });

  it("a redirect that drops the tracking params fails gate.landing_audit", async () => {
    const { auditId } = await createLandingAudit(db, ws, productId);
    await landingAuditJob(deps({ probeFetch: async () => ({ url: "https://www.syllacal.com/", redirects: ["https://www.syllacal.com/"], status: 200 }) }), { auditId });
    const a = await auditRow(auditId);
    expect(a.passed).toBe(false);
    expect(a.checks.find((c) => c.id === "tracking_survives")!.passed).toBe(false);
    const g = await gates();
    expect(g.find((t) => t.key === "gate.landing_audit")!.status).not.toBe("done");
    expect(g.find((t) => t.key === "gate.pricing_visible")!.status).toBe("done");
  });

  it("asks the judge only when the phone view shows no sign-up button", async () => {
    const calls: string[] = [];
    const judge = async (i: { auditId: string }) => {
      calls.push(i.auditId);
      return { signupButtonVisible: true, buttonText: "Upload syllabus", reason: "big button" };
    };
    const first = await createLandingAudit(db, ws, productId);
    await landingAuditJob(deps({ judge }), { auditId: first.auditId });
    expect(calls).toEqual([]);
    const second = await createLandingAudit(db, ws, productId);
    const noButton = capture({ mobile: { text: "Syllabus", buttons: [{ text: "Menu" }], png: png(3), width: 780, height: 1688 } });
    await landingAuditJob(deps({ judge, captureLanding: async () => noButton }), { auditId: second.auditId });
    expect(calls).toEqual([second.auditId]);
    expect((await auditRow(second.auditId)).checks.find((c) => c.id === "signup_button")!.passed).toBe(true);
  });

  it("a blocked URL fails the audit without a retry; other errors rethrow", async () => {
    const blocked = await createLandingAudit(db, ws, productId);
    await landingAuditJob(
      deps({
        captureLanding: async () => {
          throw new BlockedUrl("That website sent us somewhere we're not allowed to go.", "blocked_redirect");
        },
      }),
      { auditId: blocked.auditId },
    );
    expect(await auditRow(blocked.auditId)).toMatchObject({ status: "failed", error: "That website sent us somewhere we're not allowed to go." });

    const flaky = await createLandingAudit(db, ws, productId);
    await expect(
      landingAuditJob(
        deps({
          captureLanding: async () => {
            throw new Error("page.goto: Timeout 30000ms exceeded");
          },
        }),
        { auditId: flaky.auditId },
      ),
    ).rejects.toThrow();
    expect(await auditRow(flaky.auditId)).toMatchObject({ status: "failed", error: "That website took too long to load." });
    // The retry re-claims it.
    await landingAuditJob(deps(), { auditId: flaky.auditId });
    expect((await auditRow(flaky.auditId)).status).toBe("done");
  });
});

describe("launchTickJob", () => {
  it("passes the tracking gate once the aggregate counts the test visit", async () => {
    const { utmContent } = await startTrackingTest(db, ws, productId, { nonce: "tick" });
    const r = await launchTickJob({ db, aggregateFor: async () => ({ rows: async () => [{ utm_content: utmContent, visits: 1 }] }) });
    expect(r.errors).toEqual([]);
    expect(r.trackingChecks).toBe(1);
    expect((await gates()).find((t) => t.key === "gate.tracking_test")!.status).toBe("done");
  });
});
