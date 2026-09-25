// capture.flow (render queue, §3.3): record a saved demo flow under the heavy semaphore, store the
// recording + click log, run the personal-data scan and update the flow row.

import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RenderJobs } from "@mkt/core/queue";
import type { ClaudeDeps } from "@mkt/core/ai";
import { flowBlocker, loadFlowForCapture, recordFlowResult, sampleEverySecond, scanRecordingPii, screenFlow, storeRecording } from "@mkt/core/capture";
import type { Storage } from "@mkt/core/media";
import { uuidv7 } from "@mkt/db";
import { CaptureBlocked, recordFlow, type FramesToCfr, type SecretResolver } from "../../capture/demo/recorder.ts";

export interface CaptureFlowDeps extends ClaudeDeps {
  storage: Storage;
  /** sem:heavy (packages/core/src/video/semaphore.ts): one heavy job at a time per worker. */
  withHeavy: <T>(fn: () => Promise<T>) => Promise<T>;
  framesToCfr: FramesToCfr;
  resolveSecret: SecretResolver;
  proxyUrl: string | undefined;
  /** qa.pii_frames vision pass on frames sampled every second (default on). */
  piiVision?: boolean;
  /** Seam for tests. */
  record?: typeof recordFlow;
  tmpRoot?: string;
}

export const loginPurpose = (productId: string) => `capture.login.${productId}`;

/**
 * Blocked flows (denylist, not confirmed, no origin, bad login) record lastError and finish without
 * a retry; anything else records lastError and rethrows so BullMQ's retry applies.
 */
export async function captureFlow(deps: CaptureFlowDeps, data: RenderJobs["capture.flow"]): Promise<void> {
  const loaded = await loadFlowForCapture(deps.db, data.flowId);
  if (!loaded) return; // deleted since it was queued
  const { workspaceId, flow, origin, routeDenylist } = loaded;
  const fail = (error: string) => recordFlowResult(deps.db, workspaceId, flow.id, { assetId: null, error });

  const blocker = flowBlocker(flow, origin);
  if (blocker) return fail(blocker.message);
  const screened = screenFlow(flow, routeDenylist);
  const firstDrop = screened.dropped[0];
  if (firstDrop) return fail(`Step ${firstDrop.index + 1} ${firstDrop.reason}. Edit the flow and try again.`);

  const login = flow.needsLogin ? await deps.resolveSecret(workspaceId, loginPurpose(flow.productId)) : null;
  if (flow.needsLogin && !login) return fail("This flow needs the demo's test login. Add it in Settings.");

  const workDir = await mkdtemp(join(deps.tmpRoot ?? tmpdir(), "mkt-demo-"));
  try {
    const rec = await deps.withHeavy(() =>
      (deps.record ?? recordFlow)({
        origin: origin!,
        routeDenylist,
        flow,
        viewport: "desktop",
        proxyUrl: deps.proxyUrl ?? "",
        login,
        framesToCfr: deps.framesToCfr,
        workDir,
      }),
    );

    const samples = sampleEverySecond(rec.frames);
    const frames = await Promise.all(samples.map(async (f) => ({ tMs: f.tMs, jpeg: new Uint8Array(await readFile(f.path)) })));
    const pii = await scanRecordingPii(deps, {
      workspaceId,
      runId: data.runId ?? uuidv7(),
      screenTexts: rec.screenTexts,
      frames,
      vision: deps.piiVision ?? true,
    });

    const mp4 = new Uint8Array(await readFile(rec.mp4Path));
    const saved = await storeRecording(deps.db, deps.storage, {
      workspaceId,
      productId: flow.productId,
      flowId: flow.id,
      origin: origin!,
      viewport: "desktop",
      width: rec.width,
      height: rec.height,
      mp4,
      durationMs: rec.durationMs,
      clickLog: rec.clickLog,
      pii,
      stepCount: flow.steps.length,
      blocked: rec.blocked,
    });
    const error = saved.piiHits
      ? pii.visionError
        ? "Needs you: the personal-data check couldn't finish. Watch the recording before using it."
        : "Needs you: personal info showed up in the recording. Check it (and blur or re-seed the demo) before using it."
      : null;
    await recordFlowResult(deps.db, workspaceId, flow.id, { assetId: saved.assetId, error });
  } catch (err) {
    if (err instanceof CaptureBlocked) return fail(err.message);
    await fail("The recording failed. It will be retried; if it keeps failing, check that the demo site is running.");
    throw err;
  } finally {
    await rm(workDir, { recursive: true, force: true }).catch(() => undefined);
  }
}
