// capture_flows CRUD (§5.6 step 1). Every query is workspace-scoped. confirmFlow and setTrustedOrigin
// are UI-only (cookie session): API routes for PATs/agents must not expose them (D9/D26).

import { and, desc, eq } from "drizzle-orm";
import { CaptureFlow, CaptureFlowStep, type CaptureFlow as Flow } from "@mkt/contracts";
import { schema, uuidv7, type Db } from "@mkt/db";
import { flowNeedsConfirm, screenFlow, validateRouteDenylist, validateTrustedOrigin } from "./guard.ts";
import type { PlannedFlow } from "./flow-plan.ts";

const { captureFlows, products } = schema;

export class CaptureFlowError extends Error {
  constructor(
    message: string,
    readonly code: "not_found" | "invalid" | "blocked" | "no_origin" | "needs_confirm" | "bad_origin",
  ) {
    super(message);
    this.name = "CaptureFlowError";
  }
}

export interface StoredFlow extends Flow {
  id: string;
  productId: string;
  needsConfirm: boolean;
  confirmedAt: Date | null;
  confirmedBy: string | null;
  lastRecordingAssetId: string | null;
  lastError: string | null;
  createdAt: Date;
}

type Row = typeof captureFlows.$inferSelect;

function toStored(row: Row): StoredFlow {
  // Rows are written only through this module, but parse anyway: a bad row must never reach the recorder.
  const steps = row.steps.map((s) => CaptureFlowStep.parse(s));
  return {
    id: row.id,
    productId: row.productId,
    name: row.name,
    steps,
    needsLogin: row.needsLogin,
    needsConfirm: flowNeedsConfirm({ steps, needsLogin: row.needsLogin }),
    confirmedAt: row.confirmedAt,
    confirmedBy: row.confirmedBy,
    lastRecordingAssetId: row.lastRecordingAssetId,
    lastError: row.lastError,
    createdAt: row.createdAt,
  };
}

async function productCapture(db: Db, workspaceId: string, productId: string) {
  const [p] = await db
    .select({ id: products.id, origin: products.trustedCaptureOrigin, denylist: products.captureRouteDenylist })
    .from(products)
    .where(and(eq(products.id, productId), eq(products.workspaceId, workspaceId)));
  return p ?? null;
}

/** Validates + screens a flow for saving. Any blocked step rejects the save (the UI shows why). */
function checkFlow(input: unknown, routeDenylist: readonly string[]): Flow {
  const parsed = CaptureFlow.safeParse(input);
  if (!parsed.success) throw new CaptureFlowError("That flow has a step the recorder can't follow.", "invalid");
  const screened = screenFlow(parsed.data, routeDenylist);
  const first = screened.dropped[0];
  if (first) throw new CaptureFlowError(`Step ${first.index + 1} ${first.reason}.`, "blocked");
  return parsed.data;
}

export async function createFlow(db: Db, workspaceId: string, productId: string, input: Flow): Promise<string> {
  const p = await productCapture(db, workspaceId, productId);
  if (!p) throw new CaptureFlowError("Product not found.", "not_found");
  const flow = checkFlow(input, p.denylist);
  const id = uuidv7();
  await db.insert(captureFlows).values({
    id,
    workspaceId,
    productId,
    name: flow.name,
    steps: flow.steps as unknown as Record<string, unknown>[],
    needsLogin: flow.needsLogin,
  });
  return id;
}

/** Saves the planner's screened flows. Nothing is confirmed: flows that need it wait for a UI click. */
export async function savePlannedFlows(db: Db, workspaceId: string, productId: string, flows: readonly PlannedFlow[]): Promise<string[]> {
  const ids: string[] = [];
  for (const f of flows) ids.push(await createFlow(db, workspaceId, productId, { name: f.name, steps: f.steps, needsLogin: f.needsLogin }));
  return ids;
}

export async function getFlow(db: Db, workspaceId: string, flowId: string): Promise<StoredFlow | null> {
  const [row] = await db
    .select()
    .from(captureFlows)
    .where(and(eq(captureFlows.id, flowId), eq(captureFlows.workspaceId, workspaceId)));
  return row ? toStored(row) : null;
}

export async function listFlows(db: Db, workspaceId: string, productId: string): Promise<StoredFlow[]> {
  const rows = await db
    .select()
    .from(captureFlows)
    .where(and(eq(captureFlows.workspaceId, workspaceId), eq(captureFlows.productId, productId)))
    .orderBy(desc(captureFlows.createdAt));
  return rows.map(toStored);
}

/** Any edit voids the confirmation: the owner confirms what will actually run. */
export async function updateFlow(db: Db, workspaceId: string, flowId: string, input: Flow): Promise<boolean> {
  const current = await getFlow(db, workspaceId, flowId);
  if (!current) return false;
  const p = await productCapture(db, workspaceId, current.productId);
  const flow = checkFlow(input, p?.denylist ?? []);
  await db
    .update(captureFlows)
    .set({
      name: flow.name,
      steps: flow.steps as unknown as Record<string, unknown>[],
      needsLogin: flow.needsLogin,
      confirmedAt: null,
      confirmedBy: null,
    })
    .where(and(eq(captureFlows.id, flowId), eq(captureFlows.workspaceId, workspaceId)));
  return true;
}

export async function deleteFlow(db: Db, workspaceId: string, flowId: string): Promise<boolean> {
  const res = await db
    .delete(captureFlows)
    .where(and(eq(captureFlows.id, flowId), eq(captureFlows.workspaceId, workspaceId)))
    .returning({ id: captureFlows.id });
  return res.length > 0;
}

/** UI-only: the one confirm click for flows that log in or submit a form (§5.6). */
export async function confirmFlow(db: Db, workspaceId: string, userId: string, flowId: string): Promise<boolean> {
  const res = await db
    .update(captureFlows)
    .set({ confirmedAt: new Date(), confirmedBy: userId })
    .where(and(eq(captureFlows.id, flowId), eq(captureFlows.workspaceId, workspaceId)))
    .returning({ id: captureFlows.id });
  return res.length > 0;
}

/**
 * UI-only (D26): the internal demo origin capture may reach, plus the paths it must never call.
 * `origin: null` turns recorded demos off for the product.
 */
export async function setTrustedOrigin(
  db: Db,
  workspaceId: string,
  productId: string,
  origin: string | null,
  denylist: readonly string[],
): Promise<{ origin: string | null; denylist: string[] }> {
  let normalized: string | null = null;
  if (origin !== null && origin.trim() !== "") {
    const o = validateTrustedOrigin(origin);
    if (!o.ok) throw new CaptureFlowError(o.reason, "bad_origin");
    normalized = o.origin;
  }
  const d = validateRouteDenylist(denylist);
  if (!d.ok) throw new CaptureFlowError(d.reason, "invalid");
  const res = await db
    .update(products)
    .set({ trustedCaptureOrigin: normalized, captureRouteDenylist: d.entries })
    .where(and(eq(products.id, productId), eq(products.workspaceId, workspaceId)))
    .returning({ id: products.id });
  if (!res.length) throw new CaptureFlowError("Product not found.", "not_found");
  return { origin: normalized, denylist: d.entries };
}

/** Why a flow can't be recorded right now, in plain English, or null when it can. */
export function flowBlocker(flow: StoredFlow, origin: string | null): { code: CaptureFlowError["code"]; message: string } | null {
  if (!origin) return { code: "no_origin", message: "Add the demo site's internal address in Settings first." };
  if (!validateTrustedOrigin(origin).ok) return { code: "bad_origin", message: "The demo site's address isn't an internal service name. Fix it in Settings." };
  if (flow.needsConfirm && !flow.confirmedAt) {
    return { code: "needs_confirm", message: "This flow logs in or fills in a form. Check the steps and confirm it before it's recorded." };
  }
  return null;
}

/** Injected so core doesn't hold a queue: wire it to enqueue(queueFor("render"), "capture.flow", ...). */
export interface CaptureGateway {
  enqueueCaptureFlow(data: { flowId: string; runId?: string }, jobId: string): Promise<void>;
}

/** "Refresh footage" re-runs a saved flow against the demo site. */
export async function refreshFootage(
  deps: { db: Db; gateway: CaptureGateway; now?: () => number },
  workspaceId: string,
  flowId: string,
): Promise<{ jobId: string }> {
  const flow = await getFlow(deps.db, workspaceId, flowId);
  if (!flow) throw new CaptureFlowError("Flow not found.", "not_found");
  const p = await productCapture(deps.db, workspaceId, flow.productId);
  const blocker = flowBlocker(flow, p?.origin ?? null);
  if (blocker) throw new CaptureFlowError(blocker.message, blocker.code);
  await deps.db
    .update(captureFlows)
    .set({ lastError: null })
    .where(and(eq(captureFlows.id, flowId), eq(captureFlows.workspaceId, workspaceId)));
  const jobId = `capture:${flowId}:${(deps.now ?? Date.now)()}`;
  await deps.gateway.enqueueCaptureFlow({ flowId }, jobId);
  return { jobId };
}

/** Worker side: the flow row without a workspace in hand (the job payload carries only flowId). */
export async function loadFlowForCapture(db: Db, flowId: string) {
  const [row] = await db.select().from(captureFlows).where(eq(captureFlows.id, flowId));
  if (!row) return null;
  const p = await productCapture(db, row.workspaceId, row.productId);
  return { workspaceId: row.workspaceId, flow: toStored(row), origin: p?.origin ?? null, routeDenylist: p?.denylist ?? [] };
}

export async function recordFlowResult(
  db: Db,
  workspaceId: string,
  flowId: string,
  result: { assetId: string | null; error: string | null },
): Promise<void> {
  await db
    .update(captureFlows)
    .set({
      ...(result.assetId ? { lastRecordingAssetId: result.assetId } : {}),
      lastError: result.error ? result.error.slice(0, 500) : null,
    })
    .where(and(eq(captureFlows.id, flowId), eq(captureFlows.workspaceId, workspaceId)));
}
