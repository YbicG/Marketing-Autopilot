import type { CSSProperties, ReactNode } from "react";
import { AbsoluteFill, Img, useCurrentFrame, useVideoConfig } from "remotion";
import type { ClickEvent, Scene, VideoSpec } from "@mkt/contracts";
import { useAssetUrl } from "../components/AssetUrl.tsx";
import { useBrand } from "../components/BrandProvider.tsx";
import { safeRect, type Rect } from "../layout/safe-zones.ts";

export type AssetMeta = Record<string, { width?: number | null; height?: number | null; durationMs?: number | null }>;

/** Props every spec scene receives from AdComposition. Times are scene-relative. */
export type SceneProps = {
  scene: Scene;
  spec: VideoSpec;
  durationMs: number;
  clickLog?: readonly ClickEvent[];
  assetMeta?: AssetMeta;
};

export function useSceneClock() {
  const frame = useCurrentFrame();
  const cfg = useVideoConfig();
  return { frame, tMs: (frame / cfg.fps) * 1000, ...cfg, vertical: cfg.height > cfg.width, zone: safeRect("all", cfg.width, cfg.height) };
}

/** Brand background: a soft gradient from the background towards the primary. */
export function Backdrop({ children, style }: { children?: ReactNode; style?: CSSProperties }) {
  const b = useBrand();
  return (
    <AbsoluteFill style={{ background: `radial-gradient(120% 90% at 50% 0%, ${b.surface} 0%, ${b.bg} 60%)`, ...style }}>
      {children}
    </AbsoluteFill>
  );
}

/** A full-bleed asset image; `fit` defaults to cover. */
export function AssetImg({ assetId, style, fit = "cover" }: { assetId: string; style?: CSSProperties; fit?: CSSProperties["objectFit"] }) {
  const src = useAssetUrl(assetId);
  return <Img src={src} style={{ width: "100%", height: "100%", objectFit: fit, display: "block", ...style }} />;
}

export const DEFAULT_SCREEN_ASPECT = 1.6;

export function aspectOf(meta: AssetMeta | undefined, assetId: string | undefined, fallback = DEFAULT_SCREEN_ASPECT): number {
  const m = assetId ? meta?.[assetId] : undefined;
  return m?.width && m.height ? m.width / m.height : fallback;
}

/** Largest rect of `aspect` that fits inside `box`, centred. */
export function fitRect(aspect: number, box: Rect): Rect {
  let w = box.w;
  let h = w / aspect;
  if (h > box.h) {
    h = box.h;
    w = h * aspect;
  }
  return { x: box.x + (box.w - w) / 2, y: box.y + (box.h - h) / 2, w, h };
}

/** A focus box in image space (0..1) → frame space (0..1), given where the image sits. */
export function imageBoxToFrame(b: { x: number; y: number; w: number; h: number }, img: Rect, width: number, height: number) {
  return { x: (img.x + b.x * img.w) / width, y: (img.y + b.y * img.h) / height, w: (b.w * img.w) / width, h: (b.h * img.h) / height };
}

export function sceneTitle(scene: Scene): string {
  return scene.copy?.title ?? scene.overlay?.text ?? scene.vo ?? "";
}
