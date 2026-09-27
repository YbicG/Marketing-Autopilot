import { randomBytes } from "node:crypto";
import { and, eq, inArray } from "drizzle-orm";
import type { LandingAuditCheck, LaunchGateResult } from "@mkt/contracts";
import { schema, uuidv7, type Db } from "@mkt/db";
import { fetchFirstPartyAggregate, type FetchLike } from "@mkt/providers";
import { shortId, withUtm } from "../../publishing/links.ts";
import { resolveSecret } from "../../security/vault.ts";
import { analyzeLanding, landingAuditPassed, type LandingJudgeResult, type LandingSnapshot } from "./audit.ts";
import { activeLaunchPlan, launchGateRow, writeGateResult } from "./plan.ts";
import { LaunchPlanError } from "./schedule.ts";

const { landingAudits, products, trackedLinks } = schema;

type ProductRow = typeof products.$inferSelect;

async function productOf(db: Db, workspaceId: string, productId: string): Promise<ProductRow> {
  const [p] = await db.select().from(products).where(and(eq(products.id, productId), eq(products.workspaceId, workspaceId)));
  if (!p) throw new LaunchPlanError("Product not found.", "not_found");
  return p;
}

async function planGate(db: Db, workspaceId: string, productId: string, key: string) {
  const plan = await activeLaunchPlan(db, workspaceId, productId);
  if (!plan) throw new LaunchPlanError("Start the launch plan first.", "not_found");
  const task = await launchGateRow(db, workspaceId, plan.id, key);
  if (!task) throw new LaunchPlanError("This launch plan has no such check.", "not_found");
  return { plan, task };
}

// ── tracking test gate (gate.tracking_test) ──

export const TRACKING_TEST_KEY = "gate.tracking_test";
const OPEN_ON_PHONE = "Open the test link on your phone while logged out, then check again.";
const CONNECT_FIRST = "Connect your site's tracking numbers first.";

/**
 * Makes a tracked test link (§5.8 link shape; utm_source=test, utm_content=mkt-test-<nonce>) and
 * stores it on the gate's ref. The person opens it logged out on their phone. A gate that already
 * passed keeps its link and result.
 */
export async function startTrackingTest(
  db: Db,
  workspaceId: string,
  productId: string,
  opts: { now?: Date; nonce?: string } = {},
): Promise<{ taskId: string; url: string; utmContent: string; alreadyPassed: boolean }> {
  const now = opts.now ?? new Date();
  const product = await productOf(db, workspaceId, productId);
  const { plan, task } = await planGate(db, workspaceId, productId, TRACKING_TEST_KEY);
  if (task.status === "done" && task.ref?.testUrl && task.ref.utmContent) {
    return { taskId: task.id, url: task.ref.testUrl, utmContent: task.ref.utmContent, alreadyPassed: true };
  }
  const website = product.urls.website;
  if (!website) throw new LaunchPlanError("Add your website address to this product first.", "no_website");
  const utmContent = `mkt-test-${opts.nonce ?? randomBytes(5).toString("hex")}`;
  const utm = { utm_source: "test", utm_medium: "organic", utm_campaign: `${product.slug}-${shortId(plan.id)}`, utm_content: utmContent };
  const url = withUtm(website, utm);
  await db.insert(trackedLinks).values({ id: uuidv7(), workspaceId, productId, variantId: null, token: "tracking_test", url, utm });
  await writeGateResult(
    db,
    workspaceId,
    task,
    { passed: false, checkedAt: now.toISOString(), reasons: [OPEN_ON_PHONE] },
    { ref: { testUrl: url, utmContent, startedAt: now.toISOString() }, now },
  );
  return { taskId: task.id, url, utmContent, alreadyPassed: false };
}

/** The first-party aggregate (SyllaCal's endpoint, rows keyed by utm_content). */
export interface TrackingAggregateClient {
  rows(from: string, to: string): Promise<{ utm_content: string; visits: number }[]>;
}

export interface TrackingCheckDeps {
  db: Db;
  /** null = no aggregate endpoint configured for this product. */
  aggregateFor: (product: ProductRow) => Promise<TrackingAggregateClient | null>;
  now?: () => Date;
}

export const FIRSTPARTY_TOKEN_PURPOSE = "firstparty.analytics_token";
export const FIRSTPARTY_TOKEN_ENV = "FIRSTPARTY_ANALYTICS_TOKEN";

/** Default aggregateFor: base URL = product.urls.website, token from the vault or env. */
export function firstPartyAggregateFor(db: Db, opts: { fetch?: FetchLike; env?: NodeJS.ProcessEnv } = {}): TrackingCheckDeps["aggregateFor"] {
  return async (product) => {
    if (!product.urls.website) return null;
    const token = await resolveSecret(db, product.workspaceId, FIRSTPARTY_TOKEN_PURPOSE, FIRSTPARTY_TOKEN_ENV, { env: opts.env });
    if (!token) return null;
    const baseUrl = product.urls.website;
    return { rows: (from, to) => fetchFirstPartyAggregate({ baseUrl, token, fetch: opts.fetch }, from, to) };
  };
}

const utcDay = (d: Date) => d.toISOString().slice(0, 10);

/**
 * Asks the aggregate for the test link's utm_content; ≥1 visit passes the gate. With no aggregate
 * configured the gate stays open with a plain reason.
 */
export async function checkTrackingTest(deps: TrackingCheckDeps, workspaceId: string, productId: string): Promise<LaunchGateResult> {
  const now = deps.now?.() ?? new Date();
  const product = await productOf(deps.db, workspaceId, productId);
  const { task } = await planGate(deps.db, workspaceId, productId, TRACKING_TEST_KEY);
  const utmContent = task.ref?.utmContent;
  const at = now.toISOString();
  let result: LaunchGateResult;
  if (!utmContent) {
    result = { passed: false, checkedAt: at, reasons: ["Make a test link first."] };
  } else {
    const client = await deps.aggregateFor(product);
    if (!client) {
      result = { passed: false, checkedAt: at, reasons: [CONNECT_FIRST] };
    } else {
      const started = task.ref?.startedAt ? new Date(task.ref.startedAt) : now;
      // Aggregate days are UTC; a day either side covers a test opened near midnight.
      const from = utcDay(new Date(Math.min(started.getTime(), now.getTime()) - 86_400_000));
      const to = utcDay(now);
      try {
        const rows = await client.rows(from, to);
        const visits = rows.filter((r) => r.utm_content === utmContent).reduce((s, r) => s + r.visits, 0);
        result = visits >= 1 ? { passed: true, checkedAt: at, reasons: [] } : { passed: false, checkedAt: at, reasons: [`No visit from the test link yet. ${OPEN_ON_PHONE}`] };
      } catch {
        result = { passed: false, checkedAt: at, reasons: ["We couldn't reach your site's tracking numbers. Check the address and the token, then try again."] };
      }
    }
  }
  // Only write when something changed, so an hourly re-check doesn't churn a passed gate.
  if (!(task.status === "done" && result.passed)) await writeGateResult(deps.db, workspaceId, task, result, { now });
  return result;
}

// ── landing audit (gate.pricing_visible, gate.no_signup_wall, gate.landing_audit) ──

export const LANDING_GATE_CHECKS: Record<string, LandingAuditCheck["id"] | "all"> = {
  "gate.pricing_visible": "pricing_visible",
  "gate.no_signup_wall": "no_signup_wall",
  "gate.landing_audit": "all",
};

/** Queues an audit row; the web route enqueues `launch.landing_audit` with jobId `audit-${auditId}`. */
export async function createLandingAudit(db: Db, workspaceId: string, productId: string, url?: string): Promise<{ auditId: string; jobId: string; url: string }> {
  const product = await productOf(db, workspaceId, productId);
  const raw = url ?? product.urls.website;
  if (!raw) throw new LaunchPlanError("Add your website address to this product first.", "no_website");
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new LaunchPlanError("That isn't a web address.", "bad_url");
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") throw new LaunchPlanError("That isn't a web address.", "bad_url");
  const auditId = uuidv7();
  await db.insert(landingAudits).values({ id: auditId, workspaceId, productId, url: parsed.href, status: "queued" });
  return { auditId, jobId: `audit-${auditId}`, url: parsed.href };
}

/** Worker: claim the audit (queued, or failed/running on a retry). null = gone or already done. */
export async function startLandingAudit(db: Db, auditId: string): Promise<{ workspaceId: string; productId: string; url: string } | null> {
  const [row] = await db
    .update(landingAudits)
    .set({ status: "running", error: null })
    .where(and(eq(landingAudits.id, auditId), inArray(landingAudits.status, ["queued", "running", "failed"])))
    .returning({ workspaceId: landingAudits.workspaceId, productId: landingAudits.productId, url: landingAudits.url });
  return row ?? null;
}

export type LandingAuditOutcome = { snapshot: LandingSnapshot; judge?: LandingJudgeResult | null } | { error: string };

/**
 * Writes the checks and updates the gates of the product's active plan. A failed capture records
 * the error and leaves the gates as they were (the previous result still stands).
 */
export async function finishLandingAudit(
  db: Db,
  workspaceId: string,
  auditId: string,
  outcome: LandingAuditOutcome,
  now = new Date(),
): Promise<{ passed: boolean | null; checks: LandingAuditCheck[] }> {
  const [row] = await db.select().from(landingAudits).where(and(eq(landingAudits.id, auditId), eq(landingAudits.workspaceId, workspaceId)));
  if (!row) throw new LaunchPlanError("Audit not found.", "not_found");
  if ("error" in outcome) {
    await db.update(landingAudits).set({ status: "failed", error: outcome.error.slice(0, 500), finishedAt: now }).where(eq(landingAudits.id, auditId));
    return { passed: null, checks: [] };
  }
  const s = outcome.snapshot;
  const checks = analyzeLanding(s, { judge: outcome.judge });
  const passed = landingAuditPassed(checks);
  const shots = [s.desktop.screenshotAssetId, s.mobile.screenshotAssetId].filter((x): x is string => !!x);
  await db
    .update(landingAudits)
    .set({ status: "done", checks, passed, screenshotAssetIds: shots, error: null, finishedAt: now })
    .where(eq(landingAudits.id, auditId));

  const plan = await activeLaunchPlan(db, workspaceId, row.productId);
  if (plan) {
    for (const [key, check] of Object.entries(LANDING_GATE_CHECKS)) {
      const task = await launchGateRow(db, workspaceId, plan.id, key);
      if (!task) continue;
      const failing = check === "all" ? checks.filter((c) => c.severity === "gate" && !c.passed) : checks.filter((c) => c.id === check && !c.passed);
      const result: LaunchGateResult = {
        passed: failing.length === 0,
        checkedAt: now.toISOString(),
        reasons: failing.map((c) => c.detail ?? c.label),
      };
      await writeGateResult(db, workspaceId, task, result, { ref: { auditId }, now });
    }
  }
  return { passed, checks };
}
