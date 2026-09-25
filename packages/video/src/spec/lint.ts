import { findUnsafeStrings, type CameraKey, type FocusBox, type Scene, type SpecIssue, type VideoSpec } from "@mkt/contracts";
import { isBundledFont } from "../fonts/registry.ts";
import { CTA_MIN_MS, CTA_SEGMENT, HOOK_MIN_MS, HOOK_SEGMENT, VO_PAD_MS } from "../timeline/resolve.ts";

// §5.6 step 3 lintSpec + the free parts of §5.7 stage 0 that only need the spec.

export type LintAsset = { kind: string; durationMs?: number | null; width?: number | null; height?: number | null };

export type LintContext = {
  assets: Record<string, LintAsset>;
  /** Claim ids marked public_ok. */
  publicClaimRefs: Set<string>;
  /** Claim ids the developer verified in the UI. */
  verifiedClaimRefs: Set<string>;
  /** Measured voice lengths (after TTS), keyed like resolveTimeline's input. */
  voDurationsMs?: Record<string, number>;
};

/** Speaking-rate bands in words per second. Inside [low, high] is fine. */
export const WPS = { low: 1.8, high: 3.6, block: 4.4 } as const;
/** Typical TTS pace, used to estimate length before any voice exists. */
export const ESTIMATED_WPS = 2.6;
export const OVERLAY_LIMITS = { warnChars: 70, warnWords: 12, blockChars: 120 } as const;
export const HOOK_ONSCREEN_MAX_CHARS = 60;

export const countWords = (text: string) => text.trim().split(/\s+/).filter(Boolean).length;

/** Words per second of `text` spoken or shown over `ms`. */
export function wordsPerSecond(text: string, ms: number): number {
  const words = countWords(text);
  if (words === 0) return 0;
  if (ms <= 0) return Number.POSITIVE_INFINITY;
  return words / (ms / 1000);
}

/** Band for a words-per-second value: ok, slow (warn), fast (warn) or too_fast (block). */
export function wpsBand(wps: number): "ok" | "slow" | "fast" | "too_fast" {
  if (wps > WPS.block) return "too_fast";
  if (wps > WPS.high) return "fast";
  if (wps > 0 && wps < WPS.low) return "slow";
  return "ok";
}

// Other editors' and platforms' marks; Instagram and YouTube down-rank reposted TikToks.
const WATERMARK = /\b(?:watermark|capcut|inshot|kinemaster|splice app|made with|shot on)\b|tiktok\.com|@tiktok\b/i;

const IMAGE_KINDS = new Set(["screenshot", "image", "still"]);
const MOTION_KINDS = new Set(["recording", "video"]);

const EPS = 1e-6;
export function focusBoxProblem(b: FocusBox): string | null {
  const vals = [b.x, b.y, b.w, b.h];
  if (vals.some((v) => !Number.isFinite(v))) return "has a non-number";
  if (b.x < -EPS || b.y < -EPS) return "starts outside the frame";
  if (b.w <= 0 || b.h <= 0) return "has no size";
  if (b.x + b.w > 1 + EPS || b.y + b.h > 1 + EPS) return "runs past the frame edge";
  return null;
}

function sceneTexts(s: Scene): string[] {
  return [s.overlay?.text, s.copy?.title, s.copy?.subtitle, ...(s.copy?.items ?? []), s.compare?.left.label, s.compare?.right.label].filter(
    (t): t is string => typeof t === "string",
  );
}

export function lintSpec(spec: VideoSpec, ctx: LintContext): SpecIssue[] {
  const issues: SpecIssue[] = [];
  const add = (severity: SpecIssue["severity"], code: string, message: string, sceneId?: string) =>
    issues.push(sceneId ? { code, message, severity, sceneId } : { code, message, severity });
  const vo = ctx.voDurationsMs;

  // D8, again: specs edited in the UI can reach lint without passing through zod.
  for (const hit of findUnsafeStrings(spec)) {
    add("block", "unsafe_string", `${hit.reason === "url" ? "A link" : "HTML"} at ${hit.path.join(".")}: use an asset id instead`);
  }

  const needAsset = (id: string | null | undefined, what: string, sceneId?: string, kinds?: Set<string>) => {
    if (!id) return undefined;
    const a = ctx.assets[id];
    if (!a) {
      add("block", "asset_missing", `${what} uses a file that doesn't exist (${id})`, sceneId);
      return undefined;
    }
    if (kinds && !kinds.has(a.kind)) add("block", "asset_kind_mismatch", `${what} needs ${[...kinds].join(" or ")}, got ${a.kind}`, sceneId);
    return a;
  };

  needAsset(spec.brand.logoAssetId, "The logo");
  needAsset(spec.music.trackAssetId, "The music track", undefined, new Set(["audio"]));
  if (!isBundledFont(spec.brand.font)) add("warn", "font_not_bundled", `Font "${spec.brand.font}" isn't bundled; Inter is used instead`);

  const sceneIds = new Set(spec.scenes.map((s) => s.id));
  const checkCamera = (keys: CameraKey[], sceneId: string, sceneMs: number) => {
    for (const k of keys) {
      const p = k.focusBox && focusBoxProblem(k.focusBox);
      if (p) add("block", "focus_box_out_of_range", `A camera focus box ${p}`, sceneId);
      if (k.atMs > sceneMs) add("warn", "camera_after_scene_end", `A camera move at ${k.atMs} ms starts after the scene ends (${sceneMs} ms)`, sceneId);
    }
  };

  let estimatedMs = 0;
  const segment = (minMs: number, text: string | undefined, measured: number | undefined) => {
    const est = text ? (countWords(text) / ESTIMATED_WPS) * 1000 : 0;
    const voMs = measured ?? est;
    return Math.max(minMs, voMs > 0 ? voMs + VO_PAD_MS : 0);
  };

  for (const s of spec.scenes) {
    const v = s.visual;
    const kinds = v.kind === "recording" || v.kind === "broll" ? MOTION_KINDS : v.kind === "kineticText" ? undefined : IMAGE_KINDS;
    const asset = needAsset(v.assetId, `Scene "${s.id}"`, s.id, kinds);
    if (s.compare) {
      needAsset(s.compare.left.assetId, `Scene "${s.id}" (left side)`, s.id, IMAGE_KINDS);
      needAsset(s.compare.right.assetId, `Scene "${s.id}" (right side)`, s.id, IMAGE_KINDS);
    }

    if (s.type === "RecordingAutoZoom" && v.kind !== "recording") add("block", "scene_visual_mismatch", "RecordingAutoZoom needs a recording", s.id);
    if (s.type === "FullPageScroll" && v.kind !== "fullpageScroll" && v.kind !== "screenshot") add("block", "scene_visual_mismatch", "FullPageScroll needs a page screenshot", s.id);
    if (s.type === "DeviceMockup" && !v.device) add("warn", "device_default", "No device picked; a phone frame is used", s.id);
    if (s.type === "SplitCompare" && !s.compare) add("warn", "compare_default", 'No labels given; "Manual" vs "1-click" is used', s.id);

    if (v.trim) {
      if (v.trim.endMs <= v.trim.startMs) add("block", "trim_invalid", "The clip ends before it starts", s.id);
      if (v.kind !== "recording" && v.kind !== "broll") add("warn", "trim_ignored", "Trim only applies to recordings", s.id);
      else if (asset) {
        if (asset.durationMs == null) add("warn", "trim_unchecked", "The recording's length is unknown, so the trim can't be checked", s.id);
        else if (v.trim.endMs > asset.durationMs) {
          add("block", "trim_outside_recording", `The trim ends at ${v.trim.endMs} ms but the recording is ${asset.durationMs} ms long`, s.id);
        }
      }
    }
    if (v.focusBox) {
      const p = focusBoxProblem(v.focusBox);
      if (p) add("block", "focus_box_out_of_range", `The focus box ${p}`, s.id);
    }

    const sceneMs = segment(s.minMs, s.vo, s.vo ? vo?.[s.id] : undefined);
    estimatedMs += sceneMs;
    checkCamera([...(s.camera ?? []), ...(spec.camera?.[s.id] ?? [])], s.id, sceneMs);

    if (s.vo && vo?.[s.id] !== undefined) {
      const wps = wordsPerSecond(s.vo, vo[s.id] ?? 0);
      const band = wpsBand(wps);
      if (band === "too_fast") add("block", "wps_too_high", `The voice runs at ${wps.toFixed(1)} words a second; cut some words`, s.id);
      else if (band === "fast") add("warn", "wps_high", `The voice runs at ${wps.toFixed(1)} words a second; it may feel rushed`, s.id);
      else if (band === "slow") add("warn", "wps_low", `The voice runs at ${wps.toFixed(1)} words a second; it may drag`, s.id);
    }

    if (s.overlay) {
      const chars = s.overlay.text.length;
      const words = countWords(s.overlay.text);
      if (chars > OVERLAY_LIMITS.blockChars) add("block", "overlay_too_long", `On-screen text is ${chars} characters; keep it under ${OVERLAY_LIMITS.warnChars}`, s.id);
      else if (chars > OVERLAY_LIMITS.warnChars || words > OVERLAY_LIMITS.warnWords) {
        add("warn", "overlay_long", `On-screen text is ${words} words; shorter reads better`, s.id);
      }
      const readWps = wordsPerSecond(s.overlay.text, sceneMs);
      if (readWps > WPS.high) add("warn", "overlay_fast", `On-screen text needs ${readWps.toFixed(1)} words a second to read`, s.id);
    }

    for (const ref of s.claimRefs ?? []) {
      if (!ctx.publicClaimRefs.has(ref)) add("block", "claim_not_public", `Claim ${ref} isn't marked OK to use publicly`, s.id);
    }
    if (s.type === "ProofStrip") {
      const refs = s.claimRefs ?? [];
      if (refs.length === 0) add("block", "proof_without_claims", "Proof needs at least one verified claim", s.id);
      for (const ref of refs) {
        if (!ctx.verifiedClaimRefs.has(ref)) add("block", "proof_unverified_claim", `Claim ${ref} hasn't been verified, so it can't be shown as proof`, s.id);
      }
    }

    for (const t of sceneTexts(s)) {
      if (WATERMARK.test(t)) add("block", "watermark", `"${t}" looks like another app's watermark`, s.id);
    }
  }

  for (const id of Object.keys(spec.camera ?? {})) {
    if (!sceneIds.has(id)) add("warn", "camera_unknown_scene", `Camera moves for a scene that doesn't exist (${id})`);
  }
  for (const t of spec.transitions) {
    if (!sceneIds.has(t.sceneId)) add("warn", "transition_unknown_scene", `A transition points at a scene that doesn't exist (${t.sceneId})`);
  }

  spec.hookVariants.forEach((h, i) => {
    if (h.onScreen.length > HOOK_ONSCREEN_MAX_CHARS) add("warn", "hook_long", `Opening line ${i + 1} is ${h.onScreen.length} characters on screen; aim for under ${HOOK_ONSCREEN_MAX_CHARS}`);
    if (WATERMARK.test(h.onScreen)) add("block", "watermark", `Opening line ${i + 1} looks like another app's watermark`);
  });
  if (WATERMARK.test(spec.cta.onScreen)) add("block", "watermark", "The closing card looks like another app's watermark");

  // Opening line and closing card, with the measured voice when there is one.
  for (const [key, text, minMs] of [
    [HOOK_SEGMENT, spec.hookVariants.map((h) => h.vo).sort((a, b) => countWords(b) - countWords(a))[0] ?? "", HOOK_MIN_MS],
    [CTA_SEGMENT, spec.cta.vo, CTA_MIN_MS],
  ] as const) {
    estimatedMs += segment(minMs, text, vo?.[key]);
    const measured = vo?.[key];
    if (measured !== undefined && key === CTA_SEGMENT) {
      const band = wpsBand(wordsPerSecond(text, measured));
      if (band === "too_fast") add("block", "wps_too_high", "The closing line is spoken too fast; cut some words");
      else if (band === "fast") add("warn", "wps_high", "The closing line may feel rushed");
    }
  }

  const target = spec.targetSeconds * 1000;
  if (estimatedMs > target * 1.25) {
    add("warn", "over_target_length", `About ${Math.round(estimatedMs / 1000)} s long; the target is ${spec.targetSeconds} s`);
  } else if (estimatedMs < target * 0.6) {
    add("warn", "under_target_length", `About ${Math.round(estimatedMs / 1000)} s long; the target is ${spec.targetSeconds} s`);
  }

  return issues;
}

export const hasBlockingIssue = (issues: SpecIssue[]) => issues.some((i) => i.severity === "block");
