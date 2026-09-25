// The demo capture page's server side (§5.6 step 1, D26): what the page shows, the demo login in
// the vault, and "Suggest flows" run inline (one short Sonnet call). UI-only callers.

import { and, desc, eq, inArray } from "drizzle-orm";
import { schema, uuidv7, type Db } from "@mkt/db";
import type { ClaudeDeps } from "../ai/call.ts";
import { feature } from "../ai/features.ts";
import type { RateLookup } from "../ai/usage.ts";
import { estimateClaudeMicros } from "../cost/pricing.ts";
import { runSpentMicros } from "../runs/summary.ts";
import { listSecrets, putSecret } from "../security/vault.ts";
import { FLOW_PLAN_CAP_MICROS, planCaptureFlows, type DroppedStep } from "./flow-plan.ts";
import { CaptureFlowError, listFlows, savePlannedFlows, type StoredFlow } from "./flows.ts";

const { assets, generationRuns, productDnaVersions, products, sourceArtifacts, sources } = schema;

/** Vault purpose of a product's demo test login (vault only, never env; the worker reads the same). */
export const captureLoginPurpose = (productId: string) => `capture.login.${productId}`;

export interface DemoLogin {
  username: string;
  password: string;
  loginPath?: string;
}

/** Stores the demo login as JSON. It is never read back to the page, only "saved" or not. */
export async function saveDemoLogin(db: Db, workspaceId: string, productId: string, input: { username: unknown; password: unknown; loginPath?: unknown }): Promise<void> {
  const username = typeof input.username === "string" ? input.username.trim() : "";
  const password = typeof input.password === "string" ? input.password : "";
  const loginPath = typeof input.loginPath === "string" ? input.loginPath.trim() : "";
  if (!username || !password) throw new CaptureFlowError("Enter both the demo username and password.", "invalid");
  if (username.length > 200 || password.length > 500) throw new CaptureFlowError("That username or password is too long.", "invalid");
  if (loginPath && !/^\/(?!\/)[^\s\\]*$/.test(loginPath)) throw new CaptureFlowError("The login page must be a path on the demo site, like /login.", "invalid");
  const [p] = await db.select({ id: products.id }).from(products).where(and(eq(products.id, productId), eq(products.workspaceId, workspaceId)));
  if (!p) throw new CaptureFlowError("Product not found.", "not_found");
  const value: DemoLogin = { username, password, ...(loginPath ? { loginPath } : {}) };
  await putSecret(db, workspaceId, captureLoginPurpose(productId), JSON.stringify(value));
}

export interface CaptureRecording {
  assetId: string;
  durationMs: number | null;
  piiHits: boolean;
  /** Kinds of personal data found by the text scan, and how many areas the frame check boxed. */
  piiKinds: string[];
  piiBoxes: number;
  piiCheckError: string | null;
  blockedRequests: Record<string, number>;
  createdAt: string;
}

export interface CaptureView {
  origin: string | null;
  denylist: string[];
  hasLogin: boolean;
  flows: (Omit<StoredFlow, "confirmedAt" | "createdAt"> & { confirmedAt: string | null; createdAt: string; recording: CaptureRecording | null })[];
}

export async function captureView(db: Db, workspaceId: string, productId: string): Promise<CaptureView | null> {
  const [p] = await db
    .select({ origin: products.trustedCaptureOrigin, denylist: products.captureRouteDenylist })
    .from(products)
    .where(and(eq(products.id, productId), eq(products.workspaceId, workspaceId)));
  if (!p) return null;
  // Only whether a login exists (never decrypted here).
  const purpose = captureLoginPurpose(productId);
  const hasLogin = (await listSecrets(db, workspaceId)).some((x) => x.purpose === purpose);
  const flows = await listFlows(db, workspaceId, productId);
  const ids = flows.flatMap((f) => (f.lastRecordingAssetId ? [f.lastRecordingAssetId] : []));
  const recs = ids.length
    ? await db
        .select({ id: assets.id, durationMs: assets.durationMs, piiHits: assets.piiHits, labels: assets.labels, origination: assets.origination, createdAt: assets.createdAt })
        .from(assets)
        .where(and(eq(assets.workspaceId, workspaceId), inArray(assets.id, ids)))
    : [];
  const byId = new Map(recs.map((r) => [r.id, r]));
  return {
    origin: p.origin,
    denylist: p.denylist,
    hasLogin,
    flows: flows.map((f) => {
      const r = f.lastRecordingAssetId ? byId.get(f.lastRecordingAssetId) : undefined;
      const pii = (r?.labels as { pii?: { hits?: { kind: string }[]; boxes?: unknown[]; visionError?: string | null } } | null)?.pii;
      return {
        ...f,
        confirmedAt: f.confirmedAt?.toISOString() ?? null,
        createdAt: f.createdAt.toISOString(),
        recording: r
          ? {
              assetId: r.id,
              durationMs: r.durationMs,
              piiHits: r.piiHits,
              piiKinds: [...new Set((pii?.hits ?? []).map((h) => h.kind))],
              piiBoxes: pii?.boxes?.length ?? 0,
              piiCheckError: pii?.visionError ?? null,
              blockedRequests: ((r.origination as { blockedRequests?: Record<string, number> }).blockedRequests ?? {}) as Record<string, number>,
              createdAt: r.createdAt.toISOString(),
            }
          : null,
      };
    }),
  };
}

/** Price on the "Suggest flows" button: one Sonnet call with the page text, a short answer. */
export function estimateFlowPlanMicros(rates: RateLookup, inputChars = 12_000): number {
  const cfg = feature("capture.flow_plan");
  return estimateClaudeMicros(inputChars, Math.round(cfg.maxTokens / 3), rates(cfg.model));
}

const MAX_PAGE_TEXT = 30_000;

/**
 * The planner's page text. The web app can't reach the internal demo origin (only the worker is on
 * the capture network), so it plans from the product's own pages and docs read at ingest: the demo
 * is the same app, and the recorder checks every step against the live demo anyway.
 */
export async function plannerPageText(db: Db, workspaceId: string, productId: string): Promise<string> {
  const rows = await db
    .select({ kind: sourceArtifacts.kind, title: sourceArtifacts.title, url: sourceArtifacts.url, text: sourceArtifacts.text })
    .from(sourceArtifacts)
    .innerJoin(sources, eq(sources.id, sourceArtifacts.sourceId))
    .where(and(eq(sources.productId, productId), eq(sourceArtifacts.workspaceId, workspaceId), inArray(sourceArtifacts.kind, ["page", "readme", "doc"])))
    .orderBy(desc(sourceArtifacts.createdAt))
    .limit(20);
  let out = "";
  for (const r of rows) {
    const path = r.url ? safePath(r.url) : null;
    const block = `\n# ${r.title ?? r.kind}${path ? ` (${path})` : ""}\n${r.text}\n`;
    if (out.length + block.length > MAX_PAGE_TEXT) {
      out += block.slice(0, MAX_PAGE_TEXT - out.length);
      break;
    }
    out += block;
  }
  return out.trim();
}

/** Just the path of a page URL: the demo site has the same paths, not the same host. */
function safePath(url: string): string | null {
  try {
    return new URL(url).pathname;
  } catch {
    return null;
  }
}

async function productFeatures(db: Db, workspaceId: string, productId: string): Promise<{ name: string; features: { name: string; description: string }[] }> {
  const [p] = await db.select().from(products).where(and(eq(products.id, productId), eq(products.workspaceId, workspaceId)));
  if (!p) throw new CaptureFlowError("Product not found.", "not_found");
  if (!p.currentDnaVersionId) return { name: p.name, features: [] };
  const [dna] = await db.select({ dna: productDnaVersions.dna }).from(productDnaVersions).where(and(eq(productDnaVersions.id, p.currentDnaVersionId), eq(productDnaVersions.workspaceId, workspaceId)));
  const raw = ((dna?.dna as { offer?: { features?: unknown } } | undefined)?.offer?.features ?? []) as unknown[];
  const features = raw.flatMap((f) => {
    const o = f as { name?: unknown; description?: unknown };
    return typeof o?.name === "string" ? [{ name: o.name, description: typeof o.description === "string" ? o.description : "" }] : [];
  });
  return { name: p.name, features };
}

/**
 * "Suggest flows": a capture run (its own cap), one capture.flow_plan call, the screened flows
 * saved unconfirmed. Flows that log in or submit a form still need the one confirm click.
 */
export async function suggestFlows(deps: ClaudeDeps, input: { workspaceId: string; productId: string }): Promise<{ runId: string; flowIds: string[]; dropped: DroppedStep[]; spentMicros: number }> {
  const [p] = await deps.db
    .select({ denylist: products.captureRouteDenylist })
    .from(products)
    .where(and(eq(products.id, input.productId), eq(products.workspaceId, input.workspaceId)));
  if (!p) throw new CaptureFlowError("Product not found.", "not_found");
  const { name, features } = await productFeatures(deps.db, input.workspaceId, input.productId);
  const pageText = await plannerPageText(deps.db, input.workspaceId, input.productId);

  const runId = uuidv7();
  await deps.db.insert(generationRuns).values({
    id: runId,
    workspaceId: input.workspaceId,
    productId: input.productId,
    kind: "capture",
    status: "running",
    input: { action: "flow_plan" },
    capMicros: FLOW_PLAN_CAP_MICROS,
    startedAt: new Date(),
  });
  const finish = async (ok: boolean, message: string) => {
    const spentMicros = await runSpentMicros(deps.db, runId);
    await deps.db
      .update(generationRuns)
      .set({ status: ok ? "completed" : "failed", result: { message, spentMicros }, ...(ok ? {} : { error: message.slice(0, 500) }), finishedAt: new Date() })
      .where(eq(generationRuns.id, runId));
    return spentMicros;
  };
  try {
    const plan = await planCaptureFlows(deps, { workspaceId: input.workspaceId, runId, productName: name, features, pageText, routeDenylist: p.denylist });
    const flowIds = await savePlannedFlows(deps.db, input.workspaceId, input.productId, plan.flows);
    const spentMicros = await finish(true, `${flowIds.length} flow${flowIds.length === 1 ? "" : "s"} suggested.`);
    return { runId, flowIds, dropped: plan.dropped, spentMicros };
  } catch (err) {
    await finish(false, err instanceof Error ? err.message : String(err));
    throw err;
  }
}
