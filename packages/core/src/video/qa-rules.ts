import type { ProbeInfo, SpecIssue, VideoFormat, VideoScript, VideoSpec } from "@mkt/contracts";
import { isUsableClaim, type ClaimRow } from "./context.ts";
import type { ProbePlatform, Rect, Renderer, SafeZonePlatform, SpecTools, TimelineLike } from "./renderer.ts";

// §5.7 stage 0: deterministic, free checks. Pure functions; qa.ts runs them.

export const LOUDNESS_TARGET = -14;
export const LOUDNESS_TOLERANCE = 1;
/** Stage 1: re-voice lines whose transcript differs by more than 5% (§5.7). */
export const WER_LIMIT_BP = 500;
/** More than half the runtime being text-only cards reads as a slideshow on Reels/TikTok. */
export const TEXT_COVERAGE_WARN = 0.5;
/** Masters sharing more than half their scenes go ≥7 days apart on an account (§2.5). */
export const SCENE_OVERLAP_WARN = 0.5;
export const DHASH_MATCH_BITS = 10;

const issue = (severity: SpecIssue["severity"], code: string, message: string, sceneId?: string): SpecIssue =>
  sceneId ? { severity, code, message, sceneId } : { severity, code, message };

export const FORMAT_SIZE: Record<VideoFormat, { width: number; height: number }> = {
  "9x16": { width: 1080, height: 1920 },
  "1x1": { width: 1080, height: 1080 },
  "16x9": { width: 1920, height: 1080 },
};

// ── loudness ──

export function loudnessIssues(m: { lufs: number; truePeak: number }): SpecIssue[] {
  const out: SpecIssue[] = [];
  if (!Number.isFinite(m.lufs) || Math.abs(m.lufs - LOUDNESS_TARGET) > LOUDNESS_TOLERANCE) {
    out.push(issue("block", "loudness", `The sound level is ${Number.isFinite(m.lufs) ? m.lufs.toFixed(1) : "unknown"} LUFS; it should be ${LOUDNESS_TARGET} ±${LOUDNESS_TOLERANCE}.`));
  }
  if (m.truePeak > -1) out.push(issue("warn", "true_peak", `Peaks reach ${m.truePeak.toFixed(1)} dBTP and may clip on some phones.`));
  return out;
}

// ── safe zones ──

/**
 * Where the scene library draws overlay text and captions on 1080×1920 (mirrors the templates,
 * which lay text out inside the intersection of every platform's zone). SpecTools.layoutBoxes
 * replaces this when the video package provides it.
 */
export const LAYOUT_DEFAULTS: Record<"top" | "center" | "bottom" | "captions", Rect> = {
  top: { x: 90, y: 300, w: 820, h: 240 },
  center: { x: 90, y: 800, w: 820, h: 320 },
  bottom: { x: 90, y: 980, w: 820, h: 240 },
  captions: { x: 90, y: 1020, w: 820, h: 200 },
};

export const SAFE_ZONE_PLATFORMS: SafeZonePlatform[] = ["meta", "tiktok", "yt_short"];

export function layoutBoxes(tools: SpecTools, spec: VideoSpec): { label: string; sceneId?: string; rect: Rect }[] {
  const { width, height } = FORMAT_SIZE[spec.format];
  if (tools.layoutBoxes) return tools.layoutBoxes(spec, width, height);
  const sx = width / 1080;
  const sy = height / 1920;
  const scale = (r: Rect): Rect => ({ x: r.x * sx, y: r.y * sy, w: r.w * sx, h: r.h * sy });
  const out: { label: string; sceneId?: string; rect: Rect }[] = [];
  for (const s of spec.scenes) if (s.overlay) out.push({ label: "on-screen text", sceneId: s.id, rect: scale(LAYOUT_DEFAULTS[s.overlay.position]) });
  if (spec.captions.enabled) out.push({ label: "captions", rect: scale(LAYOUT_DEFAULTS.captions) });
  return out;
}

export function safeZoneIssues(tools: SpecTools, spec: VideoSpec): SpecIssue[] {
  const { width, height } = FORMAT_SIZE[spec.format];
  const out: SpecIssue[] = [];
  for (const box of layoutBoxes(tools, spec)) {
    const bad = SAFE_ZONE_PLATFORMS.filter((p) => !tools.inSafeZone(box.rect, p, width, height));
    if (bad.length) {
      const names = bad.map((p) => (p === "meta" ? "Reels" : p === "tiktok" ? "TikTok" : "Shorts")).join(", ");
      out.push(issue("block", "safe_zone", `The ${box.label} sits under the ${names} buttons or captions.`, box.sceneId));
    }
  }
  return out;
}

// ── text coverage ──

const TEXT_ONLY = new Set(["HookTitle", "KineticText", "CtaEndCard"]);

/** Share of the runtime with no product footage on screen (opening line and last card count as text). */
export function textCoverage(spec: VideoSpec, timeline: TimelineLike): number {
  if (timeline.totalMs <= 0) return 0;
  let textMs = timeline.hookMs + timeline.ctaMs;
  for (const t of timeline.scenes) {
    const s = spec.scenes.find((x) => x.id === t.id);
    if (s && (TEXT_ONLY.has(s.type) || s.visual.kind === "kineticText")) textMs += t.durationMs;
  }
  return textMs / timeline.totalMs;
}

export function textCoverageIssues(spec: VideoSpec, timeline: TimelineLike): SpecIssue[] {
  const c = textCoverage(spec, timeline);
  return c > TEXT_COVERAGE_WARN
    ? [issue("warn", "text_coverage", `${Math.round(c * 100)}% of this video is text on a plain background. Reels and TikTok favour showing the product.`)]
    : [];
}

// ── links and claims ──

const LINKISH = /\b(?:https?:\/\/|www\.)\S+|\b[a-z0-9-]+\.(?:com|io|app|dev|co|net|org|ai|so|xyz)\b/i;
const LINK_TOKEN = /\{\{link:[a-z0-9_-]+\}\}/gi;

function allText(spec: VideoSpec): { where: string; sceneId?: string; text: string }[] {
  const out: { where: string; sceneId?: string; text: string }[] = [];
  spec.hookVariants.forEach((h, i) => out.push({ where: `opening line ${i + 1}`, text: `${h.onScreen} ${h.vo}` }));
  for (const s of spec.scenes) {
    const t = [s.vo, s.overlay?.text, s.copy?.title, s.copy?.subtitle, ...(s.copy?.items ?? []), s.compare?.left.label, s.compare?.right.label].filter(Boolean).join(" ");
    if (t) out.push({ where: "scene", sceneId: s.id, text: t });
  }
  out.push({ where: "last line", text: `${spec.cta.onScreen} ${spec.cta.vo}` });
  spec.disclosures.forEach((d) => out.push({ where: "disclosure", text: d }));
  return out;
}

/** Links only as tokens (§5.0); in a video a web address is spoken/shown text, so it's a warning. */
export function linkIssues(spec: VideoSpec): SpecIssue[] {
  const out: SpecIssue[] = [];
  for (const t of allText(spec)) {
    if (LINKISH.test(t.text.replace(LINK_TOKEN, ""))) {
      out.push(issue("warn", "link_text", `The ${t.where} shows a web address. Say "link in bio" instead: the tracking link lives in the bio.`, t.sceneId));
    }
  }
  return out;
}

/** Every claim the video leans on must still be public, not rejected and not expired. */
export function claimIssues(spec: VideoSpec, script: Pick<VideoScript, "claimRefs"> | null, claims: ClaimRow[], now: Date): SpecIssue[] {
  const byRef = new Map(claims.map((c) => [c.ref, c]));
  const refs = new Set<string>([...(script?.claimRefs ?? []), ...spec.scenes.flatMap((s) => s.claimRefs ?? [])]);
  const out: SpecIssue[] = [];
  for (const ref of refs) {
    const c = byRef.get(ref);
    if (!c) out.push(issue("block", "claim_missing", `The video uses a fact (${ref}) that's no longer in your profile.`));
    else if (!isUsableClaim(c, now)) {
      const why = !c.publicOk ? "isn't public" : c.status === "rejected" ? "was marked wrong" : "has expired";
      out.push(issue("block", "claim_invalid", `The fact "${c.text.slice(0, 80)}" ${why}, so it can't be in a post.`));
    }
  }
  return out;
}

// ── probe ──

export function probeIssues(renderer: Pick<Renderer, "checkAgainstPlatform">, probe: ProbeInfo, platform: ProbePlatform): SpecIssue[] {
  return renderer.checkAgainstPlatform(probe, platform);
}

// ── stage 1: word error rate ──

export function normalizeWords(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[’']/g, "")
    .replace(/[^\p{L}\p{N}%$.]+/gu, " ")
    .replace(/(?<!\d)\.|\.(?!\d)/g, " ")
    .split(/\s+/)
    .filter(Boolean);
}

/** Word error rate in basis points (500 = 5%): word-level edit distance ÷ reference length. */
export function werBp(reference: string, hypothesis: string): number {
  const r = normalizeWords(reference);
  const h = normalizeWords(hypothesis);
  if (!r.length) return h.length ? 10_000 : 0;
  let prev = Array.from({ length: h.length + 1 }, (_, j) => j);
  for (let i = 1; i <= r.length; i++) {
    const cur = [i];
    for (let j = 1; j <= h.length; j++) {
      cur[j] = Math.min(prev[j]! + 1, cur[j - 1]! + 1, prev[j - 1]! + (r[i - 1] === h[j - 1] ? 0 : 1));
    }
    prev = cur;
  }
  return Math.round((prev[h.length]! / r.length) * 10_000);
}

// ── dHash on the contact sheet ──

/** Difference hash of a 9×8 grayscale block → 16 hex chars. */
export function dHash(gray: Uint8Array, width = 9, height = 8, x0 = 0, y0 = 0, stride = width): string {
  let bits = "";
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width - 1; x++) {
      const a = gray[(y0 + y) * stride + x0 + x]!;
      const b = gray[(y0 + y) * stride + x0 + x + 1]!;
      bits += a > b ? "1" : "0";
    }
  }
  let hex = "";
  for (let i = 0; i < bits.length; i += 4) hex += parseInt(bits.slice(i, i + 4), 2).toString(16);
  return hex;
}

/** The 3×3 contact sheet decoded to 27×24 gray → one dHash per tile (row-major). */
export const SHEET_GRID = 3;
export const SHEET_GRAY = { width: 9 * SHEET_GRID, height: 8 * SHEET_GRID } as const;

export function contactSheetHashes(gray: Uint8Array): string[] {
  const out: string[] = [];
  for (let ty = 0; ty < SHEET_GRID; ty++) {
    for (let tx = 0; tx < SHEET_GRID; tx++) out.push(dHash(gray, 9, 8, tx * 9, ty * 8, SHEET_GRAY.width));
  }
  return out;
}

export function hamming(a: string, b: string): number {
  let d = 0;
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const x = parseInt(a[i] ?? "0", 16) ^ parseInt(b[i] ?? "0", 16);
    d += ((x >> 3) & 1) + ((x >> 2) & 1) + ((x >> 1) & 1) + (x & 1);
  }
  return d;
}

/** Share of `a`'s tiles that closely match some tile of `b`. */
export function sceneOverlap(a: string[], b: string[]): number {
  if (!a.length || !b.length) return 0;
  return a.filter((x) => b.some((y) => hamming(x, y) <= DHASH_MATCH_BITS)).length / a.length;
}

/** "phash" column value: the 9 tile hashes joined. */
export const encodeSheetHash = (hashes: string[]) => hashes.join(".");
export const decodeSheetHash = (s: string | null | undefined) => (s ? s.split(".").filter((h) => /^[0-9a-f]{16}$/.test(h)) : []);

export function overlapIssues(mine: string[], recent: { label: string; hashes: string[] }[]): SpecIssue[] {
  const hits = recent.filter((r) => sceneOverlap(mine, r.hashes) > SCENE_OVERLAP_WARN);
  return hits.length
    ? [issue("warn", "scene_overlap", `This video shares most of its scenes with ${hits.map((h) => h.label).join(", ")} from the last 7 days. Post them at least 7 days apart on the same account.`)]
    : [];
}

export const hasBlock = (issues: SpecIssue[]) => issues.some((i) => i.severity === "block");
