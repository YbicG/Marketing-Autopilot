// Browser-safe entry: compositions and components only. Never import @remotion/renderer here (§3.1).
export { Root, SMOKE_COMPOSITION } from "./Root.tsx";
export { SmokeTest, type SmokeTestProps } from "./compositions/SmokeTest.tsx";

// Compositions and their props
export { AdComposition, calculateAdMetadata } from "./compositions/AdComposition.tsx";
export { StillComposition, calculateStillMetadata } from "./compositions/StillComposition.tsx";
export {
  AD_COMPOSITION,
  FORMAT_SIZES,
  STILL_COMPOSITION,
  STILL_SIZES,
  type AdAudio,
  type AdProps,
  type StillProps,
  type StillSlide,
  type StillTarget,
  type VoSegment,
} from "./compositions/props.ts";
export { SAMPLE_AD_PROPS, SAMPLE_SPEC, SAMPLE_STILL_PROPS } from "./compositions/defaults.ts";
export { DUCK_RAMP_MS, MUSIC_BASE_VOLUME, dbToGain, duckAmount, musicVolumeAt } from "./compositions/audio.ts";

// Timeline and lint
export {
  CTA_MIN_MS,
  CTA_SEGMENT,
  HOOK_MIN_MS,
  HOOK_SEGMENT,
  VO_PAD_MS,
  durationInFrames,
  msToFrames,
  resolveTimeline,
  segmentStartMs,
  type Timeline,
  type TimelineScene,
} from "./timeline/resolve.ts";
export {
  ESTIMATED_WPS,
  HOOK_ONSCREEN_MAX_CHARS,
  OVERLAY_LIMITS,
  WPS,
  countWords,
  focusBoxProblem,
  hasBlockingIssue,
  lintSpec,
  wordsPerSecond,
  wpsBand,
  type LintAsset,
  type LintContext,
} from "./spec/lint.ts";

// Layout, brand, fonts
export { RIGHT_RAIL_PX, SAFE_FRAME, SAFE_ZONES, inSafeZone, intersect, outsideFraction, safeRect, type Rect, type SafeZonePlatform } from "./layout/safe-zones.ts";
export { DEFAULT_BRAND, contrastRatio, deriveBrandTokens, luminance, meetsContrast, mix, parseHex, readableOn, type BrandTokens } from "./brand/color.ts";
export { BUNDLED_FONTS, BUNDLED_FONT_FAMILY, FONT_LICENSES, fontStack, isBundledFont } from "./fonts/registry.ts";
export { DENSITY_LIMITS, textDensity, type DensitySlide, type TextDensity } from "./stills/density.ts";
export { STILL_TEMPLATE_COMPONENTS, type StillTemplateProps } from "./stills/templates.tsx";

// Components
export { AiLabel } from "./components/AiLabel.tsx";
export { AssetUrlContext, staticAssetUrl, useAssetUrl, useAssetUrlResolver, type AssetUrlResolver } from "./components/AssetUrl.tsx";
export { BrandProvider, useBrand } from "./components/BrandProvider.tsx";
export { Camera } from "./components/Camera.tsx";
export { MOVE_MS, cameraAt, cameraTransform, easeInOutCubic, zoomForBox, type CameraState } from "./components/camera-math.ts";
export { Captions } from "./components/Captions.tsx";
export { COMBINE_WITHIN_MS, captionCoverage, captionPages, pageAt } from "./components/captions-math.ts";
export { DeviceFrame, LaptopFrame, PhoneFrame } from "./components/DeviceFrame.tsx";
export { FitText } from "./components/FitText.tsx";
export { SafeZoneOverlay } from "./components/SafeZoneOverlay.tsx";

// Scenes
export { OWNS_OVERLAY, SCENE_COMPONENTS, SceneView } from "./scenes/index.tsx";
export type { SceneProps } from "./scenes/common.tsx";
export { HookTitle, KineticText, type HookTitleProps } from "./scenes/text-scenes.tsx";
export {
  CtaEndCard,
  DeviceMockup,
  FeatureCallout,
  FullPageScroll,
  ProofStrip,
  ScreenshotKenBurns,
  SplitCompare,
  type CtaEndCardProps,
} from "./scenes/image-scenes.tsx";
export { RecordingAutoZoom, type RecordingAutoZoomProps } from "./scenes/RecordingAutoZoom.tsx";
export { AUTO_ZOOM, RIPPLE_MS, activeRipples, autoCameraFromClicks, catmullRom, cursorAt, cursorPoints } from "./scenes/cursor.ts";
