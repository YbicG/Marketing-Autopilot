// Stores a finished demo recording (§5.6 step 1): the CFR mp4 as an assets row of kind "recording",
// its click log beside it, and the personal-data scan result (D26).

import { and, eq } from "drizzle-orm";
import type { CaptureViewport, ClickLogEntry } from "@mkt/contracts";
import { schema, uuidv7, type Db } from "@mkt/db";
import type { ClaudeDeps } from "../ai/call.ts";
import { sha256, workspacePrefix, type Storage } from "../media/storage.ts";
import { budgetScopesForRun } from "../runs/summary.ts";
import { piiReport, sampleEverySecond, scanTextForPii, visionPiiFrames, type FrameSample, type PiiReport, type PiiTextOptions } from "./pii.ts";

const { assets } = schema;

/** The vision pass is at most ~45 frames of Sonnet; this cap keeps a runaway recording cheap. */
export const PII_VISION_CAP_MICROS = 1_000_000;

export interface PiiScanInput extends PiiTextOptions {
  workspaceId: string;
  runId: string;
  /** Visible page text captured after each step. */
  screenTexts: readonly string[];
  /** Screencast frames with their time from the first frame. */
  frames: readonly FrameSample[];
  vision: boolean;
}

/**
 * Regexes always; the vision pass when enabled. A failed vision call doesn't lose the recording:
 * it's reported as `visionError` and the asset is flagged for a human look (fail closed).
 */
export async function scanRecordingPii(deps: ClaudeDeps, input: PiiScanInput): Promise<PiiReport & { visionError: string | null }> {
  const textHits = input.screenTexts.flatMap((t) => scanTextForPii(t, input));
  if (!input.vision || input.frames.length === 0) return { ...piiReport(textHits, []), visionError: null };
  try {
    const budgetPeriodIds = await budgetScopesForRun(deps.db, input.workspaceId, input.runId, PII_VISION_CAP_MICROS);
    const boxes = await visionPiiFrames(deps, {
      workspaceId: input.workspaceId,
      budgetPeriodIds,
      runId: input.runId,
      frames: sampleEverySecond(input.frames),
    });
    return { ...piiReport(textHits, boxes), visionError: null };
  } catch (err) {
    const report = piiReport(textHits, []);
    return { ...report, piiHits: true, visionError: err instanceof Error ? err.message.slice(0, 300) : "vision check failed" };
  }
}

export interface StoreRecordingInput {
  workspaceId: string;
  productId: string;
  flowId: string;
  origin: string;
  viewport: CaptureViewport;
  width: number;
  height: number;
  mp4: Uint8Array;
  durationMs: number;
  clickLog: readonly ClickLogEntry[];
  pii: PiiReport & { visionError?: string | null };
  stepCount: number;
  /** Requests the route guard aborted (reason + detail), summarized into origination. */
  blocked?: readonly { reason: string; detail?: string }[];
}

/** Aborted requests by reason; `off_origin_write` is the M3b done-when count (it must stay aborted, never sent). */
export function blockedSummary(blocked: readonly { reason: string }[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const b of blocked) out[b.reason] = (out[b.reason] ?? 0) + 1;
  return out;
}

export function recordingKeys(workspaceId: string, sha: string) {
  const base = `${workspacePrefix(workspaceId)}/assets/${sha}`;
  return { video: `${base}.mp4`, clicks: `${base}-clicks.json` };
}

export async function storeRecording(
  db: Db,
  storage: Storage,
  input: StoreRecordingInput,
): Promise<{ assetId: string; storageKey: string; clickLogKey: string; piiHits: boolean }> {
  const sha = sha256(input.mp4);
  const keys = recordingKeys(input.workspaceId, sha);
  await storage.put(keys.video, input.mp4);
  await storage.put(keys.clicks, new TextEncoder().encode(JSON.stringify(input.clickLog)));
  const labels = {
    pii: {
      hits: input.pii.textHits.map((h) => ({ kind: h.kind, sample: h.sample })),
      boxes: input.pii.boxes,
      visionError: input.pii.visionError ?? null,
    },
  };
  const values = {
    id: uuidv7(),
    workspaceId: input.workspaceId,
    productId: input.productId,
    kind: "recording" as const,
    origin: "captured" as const,
    provenanceTier: "A" as const,
    mime: "video/mp4",
    width: input.width,
    height: input.height,
    sha256: sha,
    storageKey: keys.video,
    origination: {
      flowId: input.flowId,
      origin: input.origin,
      viewport: input.viewport,
      steps: input.stepCount,
      blockedRequests: blockedSummary(input.blocked ?? []),
    },
    labels,
    piiHits: input.pii.piiHits,
    durationMs: Math.round(input.durationMs),
    sizeBytes: input.mp4.byteLength,
    clickLogKey: keys.clicks,
  };
  const [row] = await db
    .insert(assets)
    .values(values)
    .onConflictDoUpdate({
      target: [assets.workspaceId, assets.sha256, assets.kind],
      set: { piiHits: values.piiHits, labels, clickLogKey: keys.clicks, durationMs: values.durationMs },
    })
    .returning({ id: assets.id });
  const assetId = row?.id ?? values.id;
  return { assetId, storageKey: keys.video, clickLogKey: keys.clicks, piiHits: values.piiHits };
}

/** Clears the flag after a human checked (or blurred) the footage in the UI. */
export async function clearPiiFlag(db: Db, workspaceId: string, assetId: string): Promise<boolean> {
  const res = await db
    .update(assets)
    .set({ piiHits: false })
    .where(and(eq(assets.id, assetId), eq(assets.workspaceId, workspaceId), eq(assets.kind, "recording")))
    .returning({ id: assets.id });
  return res.length > 0;
}
