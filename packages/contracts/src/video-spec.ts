import { z } from "zod";

// ── Video script and spec (§5.6 steps 2–3) ──
// Claude writes JSON, never code; the scene library renders it. Render props carry asset ids only:
// every string anywhere in a script or spec is rejected if it looks like a URL or HTML (D8).

// ── Untrusted-string guard (D8) ──

// "data:" alone is ordinary prose ("the data: 40%"), so only a data URI with a mime type counts.
const URL_LIKE = /\b(?:https?:|javascript:|vbscript:|(?:file|ftp|blob|ws|wss):\/\/|data:\s*[a-z]+\/[a-z0-9.+-]+)/i;
const PROTOCOL_RELATIVE = /(?:^|[\s("'=])\/\/[^\s/]/;
const HTML_LIKE = /<\s*[a-z!/?]/i;

/** Why a string is unsafe for render props, or null when it is fine. Bare domains ("syllacal.com") are allowed. */
export function unsafeStringReason(s: string): "url" | "html" | null {
  if (URL_LIKE.test(s) || PROTOCOL_RELATIVE.test(s)) return "url";
  if (HTML_LIKE.test(s)) return "html";
  return null;
}

/** Every string (keys included) under `value` that looks like a URL or HTML, with its dotted path. */
export function findUnsafeStrings(value: unknown, path: (string | number)[] = []): { path: (string | number)[]; reason: "url" | "html" }[] {
  const out: { path: (string | number)[]; reason: "url" | "html" }[] = [];
  const walk = (v: unknown, p: (string | number)[]) => {
    if (typeof v === "string") {
      const reason = unsafeStringReason(v);
      if (reason) out.push({ path: p, reason });
    } else if (Array.isArray(v)) {
      v.forEach((item, i) => walk(item, [...p, i]));
    } else if (v && typeof v === "object") {
      for (const [k, item] of Object.entries(v)) {
        const reason = unsafeStringReason(k);
        if (reason) out.push({ path: [...p, k], reason });
        walk(item, [...p, k]);
      }
    }
  };
  walk(value, path);
  return out;
}

const rejectUnsafeStrings = (value: unknown, ctx: z.RefinementCtx) => {
  for (const hit of findUnsafeStrings(value)) {
    ctx.addIssue({
      code: "custom",
      path: hit.path,
      message: hit.reason === "url" ? "Links aren't allowed here: use an asset id" : "HTML isn't allowed here",
    });
  }
};

/**
 * Asset and scene ids. Uuids in practice; the character set is what matters, because the renderer
 * builds `a/<assetId>` paths from them (no dots, no slashes, no traversal).
 */
export const AssetId = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/, "Must be an asset id");
export type AssetId = z.infer<typeof AssetId>;
export const SceneId = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/, "Must be a scene id");

// ── Script (video.script, Opus) ──

export const HOOK_STYLES = [
  "pain_callout",
  "speed_demo",
  "before_after_split",
  "pov",
  "contrarian",
  "question",
  "real_stat",
  "listicle_disclosed",
  "build_in_public",
  "reply_to_complaint",
] as const;
export const HookStyle = z.enum(HOOK_STYLES);
export type HookStyle = z.infer<typeof HookStyle>;

/** One opening line: the first 1–3 s, on screen and spoken. */
export const HookVariant = z.object({ style: HookStyle, onScreen: z.string(), vo: z.string() });
export type HookVariant = z.infer<typeof HookVariant>;

export const CtaLine = z.object({ onScreen: z.string(), vo: z.string() });
export type CtaLine = z.infer<typeof CtaLine>;

export const HOOK_COUNT = 3;

const scriptShape = {
  hooks: z.array(HookVariant).length(HOOK_COUNT),
  beats: z
    .array(z.object({ vo: z.string(), onScreen: z.string().optional(), assetRefs: z.array(AssetId) }))
    .min(1)
    .max(12),
  cta: CtaLine,
  claimRefs: z.array(z.string()),
  assetRefs: z.array(AssetId),
};

export const VideoScript = z.object(scriptShape).superRefine(rejectUnsafeStrings);
export type VideoScript = z.infer<typeof VideoScript>;

/** Model-facing script: plain (no length keywords, nullable instead of optional). Re-validate with VideoScript. */
export const VideoScriptModel = z.object({
  hooks: z.array(HookVariant),
  beats: z.array(z.object({ vo: z.string(), onScreen: z.string().nullable(), assetRefs: z.array(z.string()) })),
  cta: CtaLine,
  claimRefs: z.array(z.string()),
  assetRefs: z.array(z.string()),
});
export type VideoScriptModel = z.infer<typeof VideoScriptModel>;

/** VideoScriptModel output → VideoScript (throws a ZodError on anything the full schema rejects). */
export function videoScriptFromModel(m: VideoScriptModel): VideoScript {
  return VideoScript.parse({
    ...m,
    beats: m.beats.map((b) => ({ vo: b.vo, assetRefs: b.assetRefs, ...(b.onScreen ? { onScreen: b.onScreen } : {}) })),
  });
}

// ── Spec (video.spec, Sonnet) ──

export const VideoFormat = z.enum(["9x16", "1x1", "16x9"]);
export type VideoFormat = z.infer<typeof VideoFormat>;

export const SCENE_TYPES = [
  "HookTitle",
  "KineticText",
  "ScreenshotKenBurns",
  "FullPageScroll",
  "DeviceMockup",
  "FeatureCallout",
  "SplitCompare",
  "ProofStrip",
  "CtaEndCard",
  "RecordingAutoZoom",
] as const;
export const SceneType = z.enum(SCENE_TYPES);
export type SceneType = z.infer<typeof SceneType>;

/** Normalised 0..1 box within the visual. Range is checked by lintSpec (so the editor can show it), not here. */
export const FocusBox = z.object({ x: z.number(), y: z.number(), w: z.number(), h: z.number() });
export type FocusBox = z.infer<typeof FocusBox>;

export const Trim = z.object({ startMs: z.number().int().nonnegative(), endMs: z.number().int().positive() });
export type Trim = z.infer<typeof Trim>;

export const DeviceKind = z.enum(["phone", "laptop"]);
export type DeviceKind = z.infer<typeof DeviceKind>;

// Every member carries the same optional fields so `visual.assetId` etc. read cleanly on the union.
const visualCommon = {
  trim: Trim.optional(),
  focusBox: FocusBox.optional(),
  device: DeviceKind.optional(),
};
export const Visual = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("screenshot"), assetId: AssetId, ...visualCommon }),
  z.object({ kind: z.literal("fullpageScroll"), assetId: AssetId, ...visualCommon }),
  z.object({ kind: z.literal("recording"), assetId: AssetId, ...visualCommon }),
  z.object({ kind: z.literal("deviceMockup"), assetId: AssetId, ...visualCommon }),
  z.object({ kind: z.literal("kineticText"), assetId: AssetId.optional(), ...visualCommon }),
  z.object({ kind: z.literal("broll"), assetId: AssetId, ...visualCommon }),
]);
export type Visual = z.infer<typeof Visual>;
export type VisualKind = Visual["kind"];

/** Camera keyframe; atMs is relative to the scene start. zoom 1 = whole frame. */
export const CameraKey = z.object({ atMs: z.number().nonnegative(), zoom: z.number().min(1).max(4), focusBox: FocusBox.optional() });
export type CameraKey = z.infer<typeof CameraKey>;

export const OverlayPosition = z.enum(["top", "center", "bottom"]);
export const Overlay = z.object({ text: z.string(), position: OverlayPosition });
export type Overlay = z.infer<typeof Overlay>;

export const Scene = z.object({
  id: SceneId,
  type: SceneType,
  vo: z.string().optional(),
  overlay: Overlay.optional(),
  minMs: z.number().int().min(300).max(20_000),
  visual: Visual,
  camera: z.array(CameraKey).optional(),
  claimRefs: z.array(z.string()).optional(),
  /** Scene copy: FeatureCallout title/subtitle, KineticText lines, ProofStrip claim texts (items). */
  copy: z
    .object({ title: z.string().optional(), subtitle: z.string().optional(), items: z.array(z.string()).max(6).optional() })
    .optional(),
  /** SplitCompare halves ("manual vs 1-click"); the right side defaults to the scene visual. */
  compare: z
    .object({
      left: z.object({ label: z.string(), assetId: AssetId.optional() }),
      right: z.object({ label: z.string(), assetId: AssetId.optional() }),
    })
    .optional(),
});
export type Scene = z.infer<typeof Scene>;

export const HexColor = z.string().regex(/^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/, "Must be a hex colour like #1a2b3c");

export const BrandSpec = z.object({
  colors: z.array(HexColor).min(1).max(6),
  font: z.string(),
  logoAssetId: AssetId.nullable(),
});
export type BrandSpec = z.infer<typeof BrandSpec>;

export const SFX_KINDS = ["whoosh", "click", "pop", "ding", "riser"] as const;
export const SfxKind = z.enum(SFX_KINDS);
export type SfxKind = z.infer<typeof SfxKind>;

export const TransitionKind = z.enum(["cut", "fade", "slide", "zoom"]);
export type TransitionKind = z.infer<typeof TransitionKind>;

export const VideoSpec = z
  .object({
    schemaVersion: z.literal(1),
    format: VideoFormat,
    fps: z.literal(30),
    targetSeconds: z.union([z.literal(15), z.literal(30), z.literal(45)]),
    brand: BrandSpec,
    voice: z.object({ voiceId: z.string(), model: z.enum(["draft", "final"]) }),
    music: z.object({ mood: z.string(), duckDb: z.number().min(-40).max(0).default(-12), trackAssetId: AssetId.nullable() }),
    captions: z.object({ enabled: z.boolean(), style: z.enum(["tiktok", "clean"]) }),
    hookVariants: z.array(HookVariant).length(HOOK_COUNT),
    scenes: z.array(Scene).min(1).max(20),
    /** Extra camera keys by scene id, merged after the scene's own `camera`. */
    camera: z.record(SceneId, z.array(CameraKey)).optional(),
    /** Transition into the named scene. */
    transitions: z
      .array(z.object({ sceneId: SceneId, kind: TransitionKind, durationMs: z.number().int().min(0).max(1000) }))
      .default([]),
    sfx: z.array(z.object({ atMs: z.number().nonnegative(), kind: SfxKind })).default([]),
    cta: CtaLine,
    disclosures: z.array(z.string()).default([]),
  })
  .superRefine((spec, ctx) => {
    rejectUnsafeStrings(spec, ctx);
    const seen = new Set<string>();
    spec.scenes.forEach((s, i) => {
      if (seen.has(s.id)) ctx.addIssue({ code: "custom", path: ["scenes", i, "id"], message: `Duplicate scene id ${s.id}` });
      seen.add(s.id);
    });
  });
export type VideoSpec = z.infer<typeof VideoSpec>;
export type VideoSpecInput = z.input<typeof VideoSpec>;

/** Model-facing spec: no defaults, no length/range keywords, nullable instead of optional. Convert with videoSpecFromModel. */
const ModelVisual = z.object({
  kind: z.enum(["screenshot", "fullpageScroll", "recording", "deviceMockup", "kineticText", "broll"]),
  assetId: z.string().nullable(),
  trim: z.object({ startMs: z.number(), endMs: z.number() }).nullable(),
  focusBox: FocusBox.nullable(),
  device: DeviceKind.nullable(),
});
export const VideoSpecModel = z.object({
  format: VideoFormat,
  targetSeconds: z.number(),
  voice: z.object({ voiceId: z.string(), model: z.enum(["draft", "final"]) }),
  music: z.object({ mood: z.string(), duckDb: z.number() }),
  captions: z.object({ enabled: z.boolean(), style: z.enum(["tiktok", "clean"]) }),
  hookVariants: z.array(HookVariant),
  scenes: z.array(
    z.object({
      id: z.string(),
      type: SceneType,
      vo: z.string().nullable(),
      overlay: Overlay.nullable(),
      minMs: z.number(),
      visual: ModelVisual,
      camera: z.array(z.object({ atMs: z.number(), zoom: z.number(), focusBox: FocusBox.nullable() })).nullable(),
      claimRefs: z.array(z.string()).nullable(),
      copy: z
        .object({ title: z.string().nullable(), subtitle: z.string().nullable(), items: z.array(z.string()).nullable() })
        .nullable(),
      compare: z
        .object({
          left: z.object({ label: z.string(), assetId: z.string().nullable() }),
          right: z.object({ label: z.string(), assetId: z.string().nullable() }),
        })
        .nullable(),
    }),
  ),
  transitions: z.array(z.object({ sceneId: z.string(), kind: TransitionKind, durationMs: z.number() })),
  sfx: z.array(z.object({ atMs: z.number(), kind: SfxKind })),
  cta: CtaLine,
  disclosures: z.array(z.string()),
});
export type VideoSpecModel = z.infer<typeof VideoSpecModel>;

/** Drop nulls recursively so optional fields validate. */
function stripNulls(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(stripNulls);
  if (v && typeof v === "object") {
    return Object.fromEntries(
      Object.entries(v)
        .filter(([, x]) => x !== null)
        .map(([k, x]) => [k, stripNulls(x)]),
    );
  }
  return v;
}

/**
 * VideoSpecModel output + the parts the pipeline owns (brand, music track) → VideoSpec.
 * Throws a ZodError on anything the full schema rejects (URLs, HTML, bad ids, wrong counts).
 */
export function videoSpecFromModel(
  m: VideoSpecModel,
  fixed: { brand: BrandSpec; musicTrackAssetId: string | null },
): VideoSpec {
  const body = stripNulls(m) as Record<string, unknown>;
  return VideoSpec.parse({
    ...body,
    schemaVersion: 1,
    fps: 30,
    brand: fixed.brand,
    music: { mood: m.music.mood, duckDb: m.music.duckDb, trackAssetId: fixed.musicTrackAssetId },
  });
}

// ── Lint / QA issues ──

export const SpecIssue = z.object({
  code: z.string(),
  message: z.string(),
  severity: z.enum(["block", "warn"]),
  sceneId: z.string().optional(),
});
export type SpecIssue = z.infer<typeof SpecIssue>;

// ── Captions (shape-compatible with @remotion/captions `Caption`) ──

export const Caption = z.object({
  text: z.string(),
  startMs: z.number(),
  endMs: z.number(),
  timestampMs: z.number().nullable(),
  confidence: z.number().nullable(),
  pageBreakAfter: z.boolean().optional(),
});
export type Caption = z.infer<typeof Caption>;

// ── Recording click log (M3b, capture → RecordingAutoZoom) ──

/** tMs from the start of the recording (before trim); x/y normalised 0..1 within the recorded viewport. */
export const ClickEvent = z.object({
  tMs: z.number().nonnegative(),
  x: z.number().min(0).max(1),
  y: z.number().min(0).max(1),
  type: z.enum(["move", "click", "scroll", "type"]),
});
export type ClickEvent = z.infer<typeof ClickEvent>;

// ── Stills (D25) ──

export const STILL_TEMPLATES = ["hero", "problem", "feature", "steps", "proof", "cta"] as const;
export const StillTemplateId = z.enum(STILL_TEMPLATES);
export type StillTemplateId = z.infer<typeof StillTemplateId>;

// ── ffprobe (§5.7 stage 0) ──

export const ProbeInfo = z.object({
  formatName: z.string(),
  durationMs: z.number(),
  sizeBytes: z.number(),
  bitRate: z.number().nullable(),
  /** moov atom before mdat (MP4/MOV only; null when not checked or not MP4). */
  faststart: z.boolean().nullable(),
  video: z
    .object({
      codec: z.string(),
      profile: z.string().nullable(),
      width: z.number(),
      height: z.number(),
      pixFmt: z.string().nullable(),
      fps: z.number(),
      /** r_frame_rate equals avg_frame_rate. */
      cfr: z.boolean(),
      bitRate: z.number().nullable(),
      frames: z.number().nullable(),
    })
    .nullable(),
  audio: z
    .object({
      codec: z.string(),
      profile: z.string().nullable(),
      sampleRate: z.number(),
      channels: z.number(),
      bitRate: z.number().nullable(),
    })
    .nullable(),
});
export type ProbeInfo = z.infer<typeof ProbeInfo>;
