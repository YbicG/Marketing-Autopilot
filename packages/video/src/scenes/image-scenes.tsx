import { AbsoluteFill, Easing, interpolate, spring } from "remotion";
import { useBrand } from "../components/BrandProvider.tsx";
import { boxCenter, zoomForBox } from "../components/camera-math.ts";
import { DeviceFrame, LAPTOP_SCREEN_ASPECT } from "../components/DeviceFrame.tsx";
import { FitText } from "../components/FitText.tsx";
import { AssetImg, aspectOf, Backdrop, fitRect, useSceneClock, type SceneProps } from "./common.tsx";

/** Slow push-in on a screenshot, towards the focus box when there is one. */
export function ScreenshotKenBurns({ scene, durationMs }: SceneProps) {
  const { tMs } = useSceneClock();
  const box = scene.visual.focusBox;
  const end = box ? Math.min(1.35, zoomForBox(box, 1.35)) : 1.12;
  const u = interpolate(tMs, [0, durationMs], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp", easing: Easing.inOut(Easing.quad) });
  const scale = 1 + (end - 1) * u;
  const c = box ? boxCenter(box) : { cx: 0.5, cy: 0.5 };
  if (!scene.visual.assetId) return <Backdrop />;
  return (
    <AbsoluteFill style={{ overflow: "hidden", background: "#000" }}>
      <AbsoluteFill style={{ transform: `scale(${scale})`, transformOrigin: `${c.cx * 100}% ${c.cy * 100}%` }}>
        <AssetImg assetId={scene.visual.assetId} />
      </AbsoluteFill>
    </AbsoluteFill>
  );
}

/** A full-page screenshot scrolled top to bottom, pausing briefly at each end. */
export function FullPageScroll({ scene, durationMs }: SceneProps) {
  const { tMs } = useSceneClock();
  const y = interpolate(tMs, [durationMs * 0.12, durationMs * 0.88], [0, 100], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
    easing: Easing.inOut(Easing.cubic),
  });
  if (!scene.visual.assetId) return <Backdrop />;
  return (
    <AbsoluteFill style={{ background: "#000" }}>
      <AssetImg assetId={scene.visual.assetId} style={{ objectPosition: `50% ${y}%` }} />
    </AbsoluteFill>
  );
}

/** A real screenshot in a generic phone or laptop frame, floating in. */
export function DeviceMockup({ scene }: SceneProps) {
  const { frame, fps, width, height, vertical } = useSceneClock();
  const device = scene.visual.device ?? "phone";
  const s = spring({ frame, fps, config: { damping: 18, stiffness: 120 } });
  const frameW =
    device === "phone" ? Math.round(vertical ? width * 0.62 : height * 0.42) : Math.round(vertical ? width * 0.92 : width * 0.62);
  const bob = Math.sin((frame / fps) * 1.6) * height * 0.004;
  return (
    <Backdrop>
      <AbsoluteFill style={{ alignItems: "center", justifyContent: "center" }}>
        <div style={{ transform: `translateY(${(1 - s) * height * 0.25 + bob}px) rotate(${(1 - s) * -4}deg)`, opacity: s }}>
          <DeviceFrame device={device} width={frameW}>
            {scene.visual.assetId ? <AssetImg assetId={scene.visual.assetId} style={{ objectPosition: "50% 0%" }} /> : null}
          </DeviceFrame>
        </div>
      </AbsoluteFill>
    </Backdrop>
  );
}

/** A screenshot with one area ringed and named: "this is the button". */
export function FeatureCallout({ scene, assetMeta }: SceneProps) {
  const { frame, fps, width, height, zone, vertical } = useSceneClock();
  const b = useBrand();
  const assetId = scene.visual.assetId;
  const aspect = aspectOf(assetMeta, assetId, LAPTOP_SCREEN_ASPECT);
  const imgArea = vertical
    ? { x: zone.x, y: zone.y + zone.h * 0.3, w: zone.w, h: zone.h * 0.7 }
    : { x: zone.x + zone.w * 0.38, y: zone.y, w: zone.w * 0.62, h: zone.h };
  const img = fitRect(aspect, imgArea);
  const ring = spring({ frame: frame - fps * 0.4, fps, config: { damping: 12 } });
  const box = scene.visual.focusBox;
  const title = scene.copy?.title ?? "";
  const titleW = vertical ? zone.w : zone.w * 0.34;
  const unit = Math.min(width, height);
  return (
    <Backdrop>
      <div style={{ position: "absolute", left: zone.x, top: zone.y, width: titleW }}>
        {title ? (
          <FitText text={title} maxWidth={titleW} maxLines={3} maxFontSize={Math.round(unit * 0.085)} fontFamily={b.fontFamily} color={b.fg} align="left" />
        ) : null}
        {scene.copy?.subtitle ? (
          <div style={{ marginTop: 16, color: b.muted, fontFamily: b.fontFamily, fontWeight: 500, fontSize: Math.round(unit * 0.04) }}>{scene.copy.subtitle}</div>
        ) : null}
      </div>
      <div
        style={{
          position: "absolute",
          left: img.x,
          top: img.y,
          width: img.w,
          height: img.h,
          borderRadius: 18,
          overflow: "hidden",
          boxShadow: "0 30px 60px rgba(0,0,0,0.4)",
        }}
      >
        {assetId ? <AssetImg assetId={assetId} /> : null}
      </div>
      {box ? (
        <div
          style={{
            position: "absolute",
            left: img.x + box.x * img.w - 8,
            top: img.y + box.y * img.h - 8,
            width: box.w * img.w + 16,
            height: box.h * img.h + 16,
            borderRadius: 16,
            border: `6px solid ${b.accent}`,
            // A huge spread shadow dims everything outside the ring.
            boxShadow: `0 0 0 9999px rgba(0,0,0,${0.45 * ring})`,
            transform: `scale(${1.15 - 0.15 * ring})`,
            opacity: ring,
          }}
        />
      ) : null}
    </Backdrop>
  );
}

/** "Manual vs 1-click": the slow way greyed out beside the product's way. */
export function SplitCompare({ scene, durationMs }: SceneProps) {
  const { frame, fps, tMs, width, height, vertical, zone } = useSceneClock();
  const b = useBrand();
  const left = scene.compare?.left ?? { label: "Manual" };
  const right = scene.compare?.right ?? { label: "1-click" };
  const rightAsset = right.assetId ?? scene.visual.assetId;
  const reveal = spring({ frame: frame - fps * 0.5, fps, config: { damping: 16 } });
  // A stopwatch racing on the manual side: 45 minutes compressed into the scene.
  const seconds = Math.floor(interpolate(tMs, [0, durationMs], [0, 45 * 60], { extrapolateLeft: "clamp", extrapolateRight: "clamp" }));
  const clock = `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
  const labelSize = Math.round(Math.min(width, height) * 0.055);
  const half = (isLeft: boolean) => {
    const label = isLeft ? left.label : right.label;
    const asset = isLeft ? left.assetId : rightAsset;
    return (
      <div style={{ flex: 1, position: "relative", overflow: "hidden", opacity: isLeft ? 1 : reveal }}>
        {asset ? <AssetImg assetId={asset} style={isLeft ? { filter: "grayscale(1) brightness(0.6)" } : undefined} /> : <Backdrop />}
        <div
          style={{
            position: "absolute",
            left: vertical ? zone.x : 40,
            top: vertical ? (isLeft ? zone.y : 40) : zone.y,
            padding: "10px 22px",
            borderRadius: 14,
            background: isLeft ? "rgba(0,0,0,0.65)" : b.primary,
            color: isLeft ? "#ffffff" : b.onPrimary,
            fontFamily: b.fontFamily,
            fontWeight: 800,
            fontSize: labelSize,
          }}
        >
          {isLeft ? `${label} · ${clock}` : `${label} ✓`}
        </div>
      </div>
    );
  };
  return (
    <AbsoluteFill style={{ flexDirection: vertical ? "column" : "row", gap: 6, background: b.bg }}>
      {half(true)}
      {half(false)}
    </AbsoluteFill>
  );
}

/** Verified claims as cards sliding in one by one. */
export function ProofStrip({ scene }: SceneProps) {
  const { frame, fps, width, height, zone } = useSceneClock();
  const b = useBrand();
  const items = scene.copy?.items ?? [];
  const size = Math.round(Math.min(width, height) * 0.05);
  return (
    <Backdrop>
      <AbsoluteFill style={{ alignItems: "center", justifyContent: "center" }}>
        <div style={{ width: zone.w, display: "flex", flexDirection: "column", gap: size * 0.6 }}>
          {items.map((text, i) => {
            const s = spring({ frame: frame - i * fps * 0.35, fps, config: { damping: 15 } });
            return (
              <div
                key={i}
                style={{
                  padding: `${size * 0.6}px ${size * 0.8}px`,
                  borderRadius: size * 0.5,
                  background: b.surface,
                  borderLeft: `${Math.round(size * 0.18)}px solid ${b.accent}`,
                  color: b.fg,
                  fontFamily: b.fontFamily,
                  fontWeight: 700,
                  fontSize: size,
                  lineHeight: 1.2,
                  opacity: s,
                  transform: `translateX(${(1 - s) * width * 0.3}px)`,
                }}
              >
                {text}
              </div>
            );
          })}
        </div>
      </AbsoluteFill>
    </Backdrop>
  );
}

export type CtaEndCardProps = { onScreen: string; logoAssetId: string | null; disclosures: readonly string[] };

/** Closing card: logo, the ask, and any disclosures. */
export function CtaEndCard({ onScreen, logoAssetId, disclosures }: CtaEndCardProps) {
  const { frame, fps, width, height, zone } = useSceneClock();
  const b = useBrand();
  const s = spring({ frame, fps, config: { damping: 14 } });
  const unit = Math.min(width, height);
  return (
    <Backdrop>
      <AbsoluteFill style={{ alignItems: "center", justifyContent: "center" }}>
        <div
          style={{
            width: zone.w,
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            gap: unit * 0.05,
            transform: `scale(${0.9 + 0.1 * s})`,
            opacity: s,
          }}
        >
          {logoAssetId ? (
            <div style={{ width: unit * 0.22, height: unit * 0.22, borderRadius: unit * 0.05, overflow: "hidden", background: "#ffffff" }}>
              <AssetImg assetId={logoAssetId} fit="contain" />
            </div>
          ) : null}
          <div style={{ padding: `${unit * 0.03}px ${unit * 0.05}px`, borderRadius: unit * 0.04, background: b.primary }}>
            <FitText
              text={onScreen}
              maxWidth={zone.w - unit * 0.1}
              maxLines={2}
              maxFontSize={Math.round(unit * 0.085)}
              fontFamily={b.fontFamily}
              color={b.onPrimary}
            />
          </div>
        </div>
      </AbsoluteFill>
      {disclosures.length ? (
        <div
          style={{
            position: "absolute",
            left: zone.x,
            width: zone.w,
            top: zone.y + zone.h - unit * 0.08,
            textAlign: "center",
            color: b.muted,
            fontFamily: b.fontFamily,
            fontSize: Math.round(unit * 0.028),
          }}
        >
          {disclosures.join(" · ")}
        </div>
      ) : null}
    </Backdrop>
  );
}

/** A spec scene of type CtaEndCard (mid-video); the closing card itself is rendered by AdComposition. */
export function CtaEndCardScene({ scene, spec }: SceneProps) {
  return <CtaEndCard onScreen={scene.copy?.title ?? spec.cta.onScreen} logoAssetId={spec.brand.logoAssetId} disclosures={[]} />;
}
