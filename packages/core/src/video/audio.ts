import { and, eq } from "drizzle-orm";
import type { Caption, VideoSpec } from "@mkt/contracts";
import { schema, uuidv7 } from "@mkt/db";
import type { PaidOp } from "@mkt/providers";
import { runPaidCall } from "../cost/run-paid-call.ts";
import { type AudioOps, type TimedWordLike, type VideoDeps } from "./deps.ts";
import { normalizeLine, ttsTextHash } from "./hash.ts";
import type { AdPropsLike, TimelineLike } from "./renderer.ts";
import { storeAsset } from "./store.ts";

const { ttsSegments } = schema;

/** tts_segments.model values: the ElevenLabs model each quality maps to (§7.2 draft→final ladder). */
export const TTS_MODEL_KEYS = { draft: "eleven_flash_v2_5", final: "eleven_v3" } as const;
/** §7.2 retry budgets. */
export const MAX_TTS_TAKES = 2;
export const MAX_MUSIC_ATTEMPTS = 2;
/** Pace assumed for the captions-only cut (no voice to measure). */
export const NO_VOICE_WPS = 2.6;

export const HOOK_KEY = (i: number) => `hook:${i}`;
export const CTA_KEY = "cta";

export interface PaidScope {
  workspaceId: string;
  budgetPeriodIds: string[];
  runId: string;
}

export interface VoiceLine {
  key: string;
  text: string;
}

/** Every spoken line of a spec: the 3 opening lines, each scene with a voice line, the last line. */
export function voiceLines(spec: VideoSpec): VoiceLine[] {
  const out: VoiceLine[] = spec.hookVariants.map((h, i) => ({ key: HOOK_KEY(i), text: normalizeLine(h.vo) }));
  for (const s of spec.scenes) if (s.vo?.trim()) out.push({ key: s.id, text: normalizeLine(s.vo) });
  if (spec.cta.vo.trim()) out.push({ key: CTA_KEY, text: normalizeLine(spec.cta.vo) });
  return out.filter((l) => l.text);
}

export interface VoicedLine {
  text: string;
  /** null in the captions-only cut. */
  assetId: string | null;
  segmentId: string | null;
  durationMs: number;
  words: TimedWordLike[];
}

export interface AudioPlan {
  quality: "draft" | "final";
  voiceId: string;
  lines: Record<string, VoicedLine>;
  musicAssetId: string | null;
  /** No ElevenLabs key: captions-only kinetic cut (§6). The UI shows "Add a voice key to hear it". */
  noVoice: boolean;
  /** The bundled licensed track is used instead of generated music. */
  musicFallback: boolean;
}

/** One PaidOp through the ledger (§7.1): reserve the estimate, call, settle what ElevenLabs billed. */
export async function paidAudio<Req, Res>(deps: VideoDeps, scope: PaidScope, feature: string, op: PaidOp<Req, Res>, req: Req): Promise<Res> {
  const audio = deps.audio!;
  return runPaidCall(
    deps.db,
    { workspaceId: scope.workspaceId, budgetPeriodIds: scope.budgetPeriodIds, estMicros: op.estimate(req), feature, provider: audio.meta.id, runId: scope.runId },
    async () => {
      const out = await op.execute(req, deps.providerCtx);
      return {
        result: out.result,
        actualMicros: out.usage.actualMicros,
        usage: out.usage.units ?? {},
        ...(out.providerRequestId ? { providerRequestId: out.providerRequestId } : {}),
        ...(out.servedModel ? { servedModel: out.servedModel } : {}),
      };
    },
  );
}

type SegmentRow = typeof ttsSegments.$inferSelect;

async function findSegment(deps: VideoDeps, workspaceId: string, text: string, voiceId: string, model: string): Promise<SegmentRow | null> {
  const [row] = await deps.db
    .select()
    .from(ttsSegments)
    .where(and(eq(ttsSegments.workspaceId, workspaceId), eq(ttsSegments.textHash, ttsTextHash(text)), eq(ttsSegments.voice, voiceId), eq(ttsSegments.model, model)));
  return row ?? null;
}

/**
 * One voice line through the tts_segments cache (text hash + voice + model): an unchanged line is
 * never voiced twice, so editing one line re-voices only that line. `retake` voices it again and
 * replaces the cached take (QA stage 1 re-voice).
 */
export async function ensureVoiceLine(
  deps: VideoDeps,
  scope: PaidScope,
  input: { productId: string | null; text: string; voiceId: string; quality: "draft" | "final"; retake?: boolean },
): Promise<VoicedLine> {
  const audio: AudioOps = deps.audio!;
  const model = TTS_MODEL_KEYS[input.quality];
  const text = normalizeLine(input.text);
  const cached = await findSegment(deps, scope.workspaceId, text, input.voiceId, model);
  if (cached && !input.retake) {
    return { text, assetId: cached.assetId, segmentId: cached.id, durationMs: cached.durationMs, words: cached.alignment ?? [] };
  }

  const tts = await paidAudio(deps, scope, "audio.tts", audio.tts, { text, voiceId: input.voiceId, quality: input.quality });
  const stored = await storeAsset(deps.db, deps.storage, {
    workspaceId: scope.workspaceId,
    productId: input.productId,
    kind: "audio",
    origin: "generated",
    tier: "B", // TTS (D18)
    mime: tts.mime,
    ext: tts.ext,
    bytes: tts.bytes,
    durationMs: tts.durationMs,
    origination: { provider: audio.meta.id, model: tts.model, voiceId: input.voiceId, textHash: ttsTextHash(text) },
  });
  // Forced alignment gives word timings for captions; a failure here isn't worth losing the take.
  let words: TimedWordLike[] = [];
  try {
    const aligned = await paidAudio(deps, scope, "audio.align", audio.align, { audio: tts.bytes, mime: tts.mime, text, durationMs: tts.durationMs });
    words = aligned.words;
  } catch (err) {
    if (!isRecoverableAudioError(err)) throw err;
    words = evenWords(text, tts.durationMs);
  }

  const values = { assetId: stored.id, durationMs: tts.durationMs, alignment: words, werBp: null, text };
  if (cached) {
    await deps.db.update(ttsSegments).set(values).where(eq(ttsSegments.id, cached.id));
    return { text, assetId: stored.id, segmentId: cached.id, durationMs: tts.durationMs, words };
  }
  const [row] = await deps.db
    .insert(ttsSegments)
    .values({ id: uuidv7(), workspaceId: scope.workspaceId, textHash: ttsTextHash(text), voice: input.voiceId, model, ...values })
    .onConflictDoNothing()
    .returning({ id: ttsSegments.id });
  const segmentId = row?.id ?? (await findSegment(deps, scope.workspaceId, text, input.voiceId, model))!.id;
  return { text, assetId: stored.id, segmentId, durationMs: tts.durationMs, words };
}

function isRecoverableAudioError(err: unknown): boolean {
  const code = (err as { code?: string } | null)?.code;
  return code === "audio_provider_error";
}

/** Words spread evenly over a duration (the no-voice cut, or when alignment failed). */
export function evenWords(text: string, durationMs: number): TimedWordLike[] {
  const ws = normalizeLine(text).split(" ").filter(Boolean);
  if (!ws.length) return [];
  const step = durationMs / ws.length;
  return ws.map((w, i) => ({ text: w, startMs: Math.round(i * step), endMs: Math.round((i + 1) * step - Math.min(50, step / 4)) }));
}

export function noVoiceLine(text: string): VoicedLine {
  const words = normalizeLine(text).split(" ").filter(Boolean).length;
  const durationMs = Math.max(600, Math.round((words / NO_VOICE_WPS) * 1000));
  return { text: normalizeLine(text), assetId: null, segmentId: null, durationMs, words: evenWords(text, durationMs) };
}

/** Voice durations keyed the way resolveTimeline wants them: scene ids, "hook" (the chosen line), "cta". */
export function voDurationsFor(plan: Pick<AudioPlan, "lines">, hookIdx: number): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [key, line] of Object.entries(plan.lines)) {
    if (key.startsWith("hook:")) {
      if (key === HOOK_KEY(hookIdx)) out.hook = line.durationMs;
    } else out[key] = line.durationMs;
  }
  return out;
}

/** Word timings on the composition clock: each line's alignment offset by where its segment starts. */
export function captionsFor(plan: Pick<AudioPlan, "lines">, timeline: TimelineLike, hookIdx: number): Caption[] {
  const out: Caption[] = [];
  const push = (line: VoicedLine | undefined, startMs: number) => {
    if (!line) return;
    for (const w of line.words) {
      out.push({ text: `${out.length ? " " : ""}${w.text}`, startMs: startMs + w.startMs, endMs: startMs + w.endMs, timestampMs: startMs + Math.round((w.startMs + w.endMs) / 2), confidence: null });
    }
  };
  push(plan.lines[HOOK_KEY(hookIdx)], 0);
  for (const s of timeline.scenes) push(plan.lines[s.id], s.startMs);
  push(plan.lines[CTA_KEY], timeline.ctaStartMs);
  return out;
}

/** The render/preview props' audio block for one opening line. */
export function adAudioFor(plan: AudioPlan, hookIdx: number): AdPropsLike["audio"] {
  const voSegments: AdPropsLike["audio"]["voSegments"] = [];
  for (const [key, line] of Object.entries(plan.lines)) {
    if (!line.assetId) continue;
    if (key.startsWith("hook:")) {
      if (key === HOOK_KEY(hookIdx)) voSegments.push({ sceneId: "hook", assetId: line.assetId, durationMs: line.durationMs });
    } else voSegments.push({ sceneId: key, assetId: line.assetId, durationMs: line.durationMs });
  }
  return { voSegments, musicAssetId: plan.musicAssetId };
}

/**
 * Music at the exact length (ElevenLabs Music, instrumental), license receipt stored on the asset.
 * Two attempts (§7.2), then the bundled licensed track.
 */
export async function ensureMusic(
  deps: VideoDeps,
  scope: PaidScope,
  input: { productId: string | null; mood: string; lengthMs: number },
): Promise<{ assetId: string | null; fallback: boolean }> {
  if (!deps.audio) return { assetId: deps.bundledTrackAssetId ?? null, fallback: true };
  const lengthMs = Math.max(3_000, Math.ceil(input.lengthMs / 1000) * 1000);
  const prompt = `Instrumental background music for a short product video: ${input.mood}. No vocals. Steady, not distracting under a voice.`;
  for (let attempt = 1; attempt <= MAX_MUSIC_ATTEMPTS; attempt++) {
    try {
      const m = await paidAudio(deps, scope, "audio.music", deps.audio.music, { prompt, lengthMs });
      const stored = await storeAsset(deps.db, deps.storage, {
        workspaceId: scope.workspaceId,
        productId: input.productId,
        kind: "audio",
        origin: "generated",
        tier: "B",
        mime: m.mime,
        ext: m.ext,
        bytes: m.bytes,
        durationMs: m.durationMs,
        origination: { provider: deps.audio.meta.id, purpose: "music", mood: input.mood },
        licenseRef: JSON.stringify(m.license),
      });
      return { assetId: stored.id, fallback: false };
    } catch (err) {
      if (!isRecoverableAudioError(err)) throw err;
    }
  }
  return { assetId: deps.bundledTrackAssetId ?? null, fallback: true };
}

/**
 * All voice lines (cached per line) + music for a spec. Without a key: the captions-only cut with
 * the bundled track, flagged so the editor can say why there's no voice.
 */
export async function prepareAudio(
  deps: VideoDeps,
  scope: PaidScope,
  input: { productId: string | null; spec: VideoSpec; quality: "draft" | "final"; withMusic: boolean; timelineMs?: (plan: AudioPlan) => number },
): Promise<AudioPlan> {
  const voiceId = input.spec.voice.voiceId || deps.defaultVoiceId || "default";
  const lines = voiceLines(input.spec);
  const plan: AudioPlan = { quality: input.quality, voiceId, lines: {}, musicAssetId: null, noVoice: !deps.audio, musicFallback: false };

  if (!deps.audio) {
    for (const l of lines) plan.lines[l.key] = noVoiceLine(l.text);
    await deps.publish?.({ type: "stage_warning", stage: "voice", message: "No voice yet: this cut uses big captions and a stock track. Add an ElevenLabs key in Settings → Keys to hear it voiced." });
  } else {
    for (const l of lines) {
      plan.lines[l.key] = await ensureVoiceLine(deps, scope, { productId: input.productId, text: l.text, voiceId, quality: input.quality });
    }
  }

  if (input.spec.music.trackAssetId) {
    plan.musicAssetId = input.spec.music.trackAssetId;
  } else if (input.withMusic && deps.audio) {
    const lengthMs = input.timelineMs ? input.timelineMs(plan) : input.spec.targetSeconds * 1000;
    const m = await ensureMusic(deps, scope, { productId: input.productId, mood: input.spec.music.mood, lengthMs });
    plan.musicAssetId = m.assetId;
    plan.musicFallback = m.fallback;
  } else {
    // Drafts and the no-key cut use the bundled licensed track (music is a final-only spend).
    plan.musicAssetId = deps.bundledTrackAssetId ?? null;
    plan.musicFallback = true;
  }
  return plan;
}
