// Preview props for the editor's <Player>, built the way the worker builds AdProps
// (core/video/audio.ts: voDurationsFor, captionsFor, adAudioFor; video-item.ts previewProps).
// Pure and browser-safe: client components can't import @mkt/core. ad-props.test.ts checks parity.
//
// One difference, on purpose: while you edit, a spoken line whose text no longer matches its voiced
// take is timed at the no-voice pace and plays silent, so the preview never speaks stale words.

import type { Caption, VideoSpec } from "@mkt/contracts";
import { ESTIMATED_WPS, resolveTimeline, type AdAudio, type AdProps, type SafeZonePlatform, type Timeline } from "@mkt/video";

/** Serializable VoicedLine (core/video/audio.ts). */
export interface EditorLine {
  text: string;
  assetId: string | null;
  segmentId?: string | null;
  durationMs: number;
  words: { text: string; startMs: number; endMs: number }[];
}

export const HOOK_KEY = (i: number) => `hook:${i}`;
export const CTA_KEY = "cta";

export const normalizeLine = (t: string) => t.replace(/\s+/g, " ").trim();

/** evenWords + noVoiceLine from core (NO_VOICE_WPS = ESTIMATED_WPS = 2.6). */
export function estimatedLine(text: string): EditorLine {
  const norm = normalizeLine(text);
  const ws = norm.split(" ").filter(Boolean);
  const durationMs = Math.max(600, Math.round((ws.length / ESTIMATED_WPS) * 1000));
  const step = ws.length ? durationMs / ws.length : 0;
  return {
    text: norm,
    assetId: null,
    segmentId: null,
    durationMs,
    words: ws.map((w, i) => ({ text: w, startMs: Math.round(i * step), endMs: Math.round((i + 1) * step - Math.min(50, step / 4)) })),
  };
}

/** The spoken text each line key should carry for this spec. */
export function spokenTexts(spec: VideoSpec): Record<string, string> {
  const out: Record<string, string> = {};
  spec.hookVariants.forEach((h, i) => {
    out[HOOK_KEY(i)] = normalizeLine(h.vo);
  });
  for (const s of spec.scenes) if (s.vo && normalizeLine(s.vo)) out[s.id] = normalizeLine(s.vo);
  out[CTA_KEY] = normalizeLine(spec.cta.vo);
  return out;
}

/** Saved lines that still match the spec; changed or new lines get the no-voice estimate. */
export function linesForSpec(spec: VideoSpec, saved: Record<string, EditorLine>): { lines: Record<string, EditorLine>; stale: string[] } {
  const lines: Record<string, EditorLine> = {};
  const stale: string[] = [];
  for (const [key, text] of Object.entries(spokenTexts(spec))) {
    if (!text) continue;
    const got = saved[key];
    if (got && normalizeLine(got.text) === text) lines[key] = got;
    else {
      lines[key] = estimatedLine(text);
      stale.push(key);
    }
  }
  return { lines, stale };
}

export function voDurationsFor(lines: Record<string, EditorLine>, hookIdx: number): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [key, line] of Object.entries(lines)) {
    if (key.startsWith("hook:")) {
      if (key === HOOK_KEY(hookIdx)) out.hook = line.durationMs;
    } else out[key] = line.durationMs;
  }
  return out;
}

export function captionsFor(lines: Record<string, EditorLine>, timeline: Pick<Timeline, "scenes" | "ctaStartMs">, hookIdx: number): Caption[] {
  const out: Caption[] = [];
  const push = (line: EditorLine | undefined, startMs: number) => {
    if (!line) return;
    for (const w of line.words) {
      out.push({ text: `${out.length ? " " : ""}${w.text}`, startMs: startMs + w.startMs, endMs: startMs + w.endMs, timestampMs: startMs + Math.round((w.startMs + w.endMs) / 2), confidence: null });
    }
  };
  push(lines[HOOK_KEY(hookIdx)], 0);
  for (const s of timeline.scenes) push(lines[s.id], s.startMs);
  push(lines[CTA_KEY], timeline.ctaStartMs);
  return out;
}

export function adAudioFor(lines: Record<string, EditorLine>, musicAssetId: string | null, hookIdx: number): AdAudio {
  const voSegments: AdAudio["voSegments"] = [];
  for (const [key, line] of Object.entries(lines)) {
    if (!line.assetId) continue;
    if (key.startsWith("hook:")) {
      if (key === HOOK_KEY(hookIdx)) voSegments.push({ sceneId: "hook", assetId: line.assetId, durationMs: line.durationMs });
    } else voSegments.push({ sceneId: key, assetId: line.assetId, durationMs: line.durationMs });
  }
  return { voSegments, musicAssetId };
}

export interface PreviewInput {
  spec: VideoSpec;
  /** AudioPlan.lines as saved with the spec (empty before the first draft voice). */
  lines: Record<string, EditorLine>;
  musicAssetId: string | null;
  noVoice: boolean;
  hookIdx: number;
  assetMeta?: AdProps["assetMeta"];
  showSafeZones?: SafeZonePlatform | null;
}

/** previewProps (core/video/video-item.ts) for a spec that may have unsaved edits. */
export function buildPreviewProps(input: PreviewInput): AdProps {
  const { spec } = input;
  const idx = Math.min(Math.max(0, input.hookIdx), spec.hookVariants.length - 1);
  const { lines } = linesForSpec(spec, input.lines);
  const timeline = resolveTimeline(spec, voDurationsFor(lines, idx), idx);
  return {
    spec,
    hookIdx: idx,
    timeline,
    audio: adAudioFor(lines, input.musicAssetId, idx),
    captions: spec.captions.enabled || input.noVoice ? captionsFor(lines, timeline, idx) : null,
    aiLabel: !input.noVoice,
    ...(input.assetMeta ? { assetMeta: input.assetMeta } : {}),
    ...(input.showSafeZones ? { showSafeZones: input.showSafeZones } : {}),
  };
}

/**
 * The words-per-second meter: measured from the voiced take while the text still matches it, else
 * only an estimated spoken length (a fresh take sets its own pace).
 */
export function lineMeter(text: string, saved: EditorLine | undefined): { words: number; wps: number | null; seconds: number } {
  const norm = normalizeLine(text);
  const words = norm ? norm.split(" ").length : 0;
  if (!words) return { words: 0, wps: null, seconds: 0 };
  if (saved && normalizeLine(saved.text) === norm && saved.assetId && saved.durationMs > 0) {
    return { words, wps: Math.round((words / (saved.durationMs / 1000)) * 10) / 10, seconds: Math.round(saved.durationMs / 100) / 10 };
  }
  return { words, wps: null, seconds: Math.round((words / ESTIMATED_WPS) * 10) / 10 };
}
