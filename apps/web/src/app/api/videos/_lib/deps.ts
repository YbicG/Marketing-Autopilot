// Shared by the video editor routes (W4). Not a route: no route.ts here.
// The web app runs the editor's small paid calls inline (edit re-voice, 3 more opening lines, Ask
// for changes); Finalize and renders stay on the worker. It has no ffmpeg or Remotion renderer, so
// the Renderer here only probes uploads from their headers.

import { readFile } from "node:fs/promises";
import { env } from "@mkt/core/config";
import { loadRateCards, rateLookup } from "@mkt/core/cost";
import { storage } from "@mkt/core/media";
import { voidApprovalsForVariants } from "@mkt/core/publishing";
import { enqueue } from "@mkt/core/queue";
import { resolveSecret } from "@mkt/core/security";
import { estimateFinalizeMicros, probeUploadedRecording, voDurationsFor, type AudioOps, type Renderer, type SpecTools, type VideoDeps, type VoicedLine } from "@mkt/core/video";
import type { VideoSpec } from "@mkt/contracts";
import { ELEVENLABS_SECRET, createElevenLabsAudio, type ProviderCtx } from "@mkt/providers";
import { inSafeZone, lintSpec, resolveTimeline } from "@mkt/video/pure";
import { getDb } from "@/lib/db";
import { getQueue, publishEffects } from "@/lib/queues";
import { json } from "@/lib/session";

export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** D19: the vault first, then the env var named after the purpose ("elevenlabs.api_key" → ELEVENLABS_API_KEY). */
export const envNameFor = (purpose: string) => purpose.toUpperCase().replace(/[^A-Z0-9]+/g, "_");

export function providerCtx(workspaceId: string): ProviderCtx {
  return { secret: (purpose) => resolveSecret(getDb(), workspaceId, purpose, envNameFor(purpose)) };
}

export const specTools: SpecTools = {
  resolveTimeline: (spec, vo, hookIdx) => resolveTimeline(spec, vo, hookIdx),
  lintSpec: (spec, ctx) => lintSpec(spec, ctx),
  inSafeZone: (box, platform, w, h) => inSafeZone(box, platform, w, h),
};

const noRender = (what: string) => () => Promise.reject(new Error(`${what} runs on the worker, not the web app`));

/** Header-only probe for uploads; everything heavy throws (renders only run on the worker). */
export const webRenderer: Renderer = {
  ffprobe: async (path) => probeUploadedRecording(new Uint8Array(await readFile(path))),
  renderVideo: noRender("renderVideo"),
  renderStillImage: noRender("renderStillImage"),
  loudnormTwoPass: noRender("loudnormTwoPass"),
  measureLoudness: noRender("measureLoudness"),
  transcodeVariants: noRender("transcodeVariants"),
  contactSheet: noRender("contactSheet"),
  extractFrame: noRender("extractFrame"),
  writeXmp: noRender("writeXmp"),
  checkAgainstPlatform: () => [],
  buildLinkedInPdf: noRender("buildLinkedInPdf"),
};

export async function hasVoiceKey(workspaceId: string): Promise<boolean> {
  return !!(await resolveSecret(getDb(), workspaceId, ELEVENLABS_SECRET, envNameFor(ELEVENLABS_SECRET)));
}

/** VideoDeps for one workspace, built the way the worker builds them (apps/worker/src/index.ts). */
export async function videoDeps(workspaceId: string): Promise<VideoDeps> {
  const db = getDb();
  return {
    db,
    rates: rateLookup(await loadRateCards(db)),
    storage: storage(env()),
    audio: (await hasVoiceKey(workspaceId)) ? createElevenLabsAudio() : null,
    providerCtx: providerCtx(workspaceId),
    renderer: webRenderer,
    tools: specTools,
    voidApprovalsFor: voidApprovalsForVariants(db, publishEffects(), { graceMin: env().MISSED_SLOT_GRACE_MIN }),
    enqueueRender: async (renderId, opts) => {
      await enqueue<"render", "render.video">(getQueue("render"), "render.video", { renderId }, { jobId: `rv-${renderId}-${Date.now().toString(36)}`, ...(opts?.delayMs ? { delayMs: opts.delayMs } : {}) });
    },
  };
}

/** Plain-sentence errors from the video pipeline; anything else is logged and hidden. */
export function videoError(err: unknown): Response {
  const e = err as { code?: unknown; message?: unknown; name?: unknown };
  const msg = typeof e?.message === "string" ? e.message : "";
  if (e?.code === "not_found") return json(404, { error: "That video isn't there any more." });
  if (e?.code === "budget_exceeded") return json(402, { error: "You've hit your spending limit. Raise it in Settings → Spending to carry on." });
  if (e?.code === "finalize_not_confirmed") return json(409, { error: msg });
  if (e?.code === "needs_you") return json(422, { error: "We couldn't turn that into a working video. Say it another way, or edit the scenes yourself." });
  if (e?.code === "upload_rejected" || e?.code === "tier_blocked") return json(400, { error: msg });
  if (e?.name === "ClaudeRefused") return json(422, { error: "Claude wouldn't write that. Say it another way and try again." });
  if (e?.name === "StructuredOutputInvalid") return json(502, { error: "The answer came back broken. Try again." });
  if (e?.code === "bad_transition") return json(409, { error: `${msg} Wait for it to finish, then try again.` });
  console.error("[video route]", err);
  return json(500, { error: "That didn't work. Try again in a minute." });
}

export async function readJson(req: Request): Promise<Record<string, unknown>> {
  try {
    const b: unknown = await req.json();
    return b && typeof b === "object" && !Array.isArray(b) ? (b as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/**
 * Without a voice key estimateFinalizeMicros is 0, but finalize still runs the Sonnet vision + text
 * checks (§5.7): a few cents per video, so the button never says free.
 */
const QA_ONLY_MICROS = 75_000;

/** "Finalize 3 versions · ~$0.70": final voice, transcript check, music and QA for the longest cut. */
export function finalizeEstimate(audio: AudioOps | null, spec: VideoSpec, lines: Record<string, VoicedLine>): number {
  const totalMs = Math.max(...spec.hookVariants.map((_, i) => resolveTimeline(spec, voDurationsFor({ lines }, i), i).totalMs));
  return Math.max(QA_ONLY_MICROS, estimateFinalizeMicros({ audio }, spec, totalMs));
}
