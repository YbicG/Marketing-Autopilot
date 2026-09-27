// launch.landing_audit (render queue, §3.3 heavy): capture the landing under sem:heavy, store the
// first-viewport screenshots, probe a tracking link through safe-fetch, optionally ask the judge
// about the phone view, then write the checks and the plan's gates (§5.4, D20).

import type { RenderJobs } from "@mkt/core/queue";
import {
  finishLandingAudit,
  needsSignupJudge,
  probeTracking,
  startLandingAudit,
  storeAuditScreenshot,
  type LandingJudgeResult,
  type LandingSnapshot,
  type ProbeFetch,
} from "@mkt/core/launch";
import type { Storage } from "@mkt/core/media";
import { BlockedUrl } from "@mkt/core/security";
import type { Db } from "@mkt/db";
import type { CaptureLanding, CapturedViewport } from "./audit-capture.ts";

export interface LandingAuditDeps {
  db: Db;
  storage: Storage;
  /** sem:heavy (jobs/render/heavy.ts heavyRunner). */
  withHeavy: <T>(fn: () => Promise<T>) => Promise<T>;
  /** playwrightLandingCapture({ selfIps, proxyUrl }) in production. */
  captureLanding: CaptureLanding;
  /** safeProbeFetch({ selfIps, proxyUrl }) in production. */
  probeFetch: ProbeFetch;
  /** judgeLandingScreenshot bound to ClaudeDeps; null/undefined = DOM heuristic only. */
  judge?: ((input: { workspaceId: string; productId: string; auditId: string; png: Uint8Array }) => Promise<LandingJudgeResult>) | null;
  now?: () => Date;
}

function captureError(err: unknown): string {
  if (err instanceof BlockedUrl) return err.message;
  const msg = err instanceof Error ? err.message : String(err);
  if (/timeout/i.test(msg)) return "That website took too long to load.";
  if (/ERR_NAME_NOT_RESOLVED/.test(msg)) return "We couldn't find that website. Check the address.";
  if (/ERR_BLOCKED_BY_CLIENT|ERR_TUNNEL_CONNECTION_FAILED|ERR_PROXY/.test(msg)) return "That website sent us somewhere we're not allowed to go.";
  return "We couldn't open that page. It will be tried again.";
}

/**
 * BlockedUrl finishes without a retry; anything else records the error and rethrows so BullMQ
 * retries (startLandingAudit re-claims a failed row). Gates keep their last result on failure.
 */
export async function landingAuditJob(deps: LandingAuditDeps, data: RenderJobs["launch.landing_audit"]): Promise<void> {
  const claimed = await startLandingAudit(deps.db, data.auditId);
  if (!claimed) return; // deleted, or already done
  const { workspaceId, productId, url } = claimed;
  const now = () => deps.now?.() ?? new Date();
  try {
    const cap = await deps.withHeavy(() => deps.captureLanding(url));
    const store = async (v: CapturedViewport, viewport: "desktop" | "mobile") =>
      v.png
        ? storeAuditScreenshot(deps.db, deps.storage, { workspaceId, productId, auditId: data.auditId, viewport, png: v.png, width: v.width, height: v.height, pageUrl: cap.finalUrl })
        : null;
    const [desktopShot, mobileShot] = [await store(cap.desktop, "desktop"), await store(cap.mobile, "mobile")];
    const trackingProbe = await probeTracking(url, deps.probeFetch);
    const snapshot: LandingSnapshot = {
      requestedUrl: cap.requestedUrl,
      finalUrl: cap.finalUrl,
      redirectChain: cap.redirectChain,
      status: cap.status,
      loadMs: cap.loadMs,
      html: cap.html,
      desktop: { text: cap.desktop.text, buttons: cap.desktop.buttons, screenshotAssetId: desktopShot },
      mobile: { text: cap.mobile.text, buttons: cap.mobile.buttons, screenshotAssetId: mobileShot },
      links: cap.links,
      scripts: cap.scripts,
      meta: cap.meta,
      trackingProbe,
    };
    // One cheap vision call, only when the DOM heuristic missed a sign-up button on phones.
    const judge =
      deps.judge && cap.mobile.png && needsSignupJudge(snapshot)
        ? await deps.judge({ workspaceId, productId, auditId: data.auditId, png: cap.mobile.png }).catch(() => null)
        : null;
    await finishLandingAudit(deps.db, workspaceId, data.auditId, { snapshot, judge }, now());
  } catch (err) {
    await finishLandingAudit(deps.db, workspaceId, data.auditId, { error: captureError(err) }, now());
    if (err instanceof BlockedUrl) return;
    throw err;
  }
}
