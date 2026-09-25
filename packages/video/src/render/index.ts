// Node-only entry: bundling, rendering and ffmpeg post-processing. The worker imports this; the web app never does.
import { ensureBrowser } from "@remotion/renderer";

export { ensureBrowser };

export { ENTRY, bundleCacheRoot, currentSourceHash, ensureBundle, getBundle, isBundleSource, sourceHash, stageBundle } from "./bundle.ts";
export {
  QUALITY,
  adRenderProps,
  renderStillImage,
  renderVideo,
  type RenderAdInput,
  type RenderStillInput,
  type RenderVideoInput,
  type RenderVideoResult,
} from "./render.ts";
export * from "./ffmpeg/index.ts";
export { PLATFORM_SPECS, checkAgainstPlatform, type PlatformVideoSpec, type VideoPlatform } from "./platform-specs.ts";
export { XMP_UUID, bufferReader, isFaststart, moovBeforeMdat, scanTopLevelBoxes, withFileReader, type Box, type ReadAt } from "./mp4.ts";
export {
  DIGITAL_SOURCE_TYPES,
  DIGITAL_SOURCE_TYPE_BASE,
  buildXmpPacket,
  digitalSourceTypeForTier,
  digitalSourceTypeUri,
  injectJpegXmp,
  mp4XmpBox,
  planMp4Xmp,
  writeXmp,
  type DigitalSourceTypeCode,
  type XmpResult,
} from "./xmp.ts";
export { buildLinkedInPdf, buildLinkedInPdfFromImages } from "./pdf.ts";
