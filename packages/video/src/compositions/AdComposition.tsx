import { useMemo, type ReactNode } from "react";
import { AbsoluteFill, Html5Audio, interpolate, Sequence, useCurrentFrame, useVideoConfig, type CalculateMetadataFunction } from "remotion";
import type { Scene, TransitionKind } from "@mkt/contracts";
import { AiLabel } from "../components/AiLabel.tsx";
import { useAssetUrlResolver } from "../components/AssetUrl.tsx";
import { BrandProvider, useBrand } from "../components/BrandProvider.tsx";
import { Captions } from "../components/Captions.tsx";
import { FitText } from "../components/FitText.tsx";
import { SafeZoneOverlay } from "../components/SafeZoneOverlay.tsx";
import { safeRect } from "../layout/safe-zones.ts";
import { CtaEndCard } from "../scenes/image-scenes.tsx";
import { OWNS_OVERLAY, SceneView } from "../scenes/index.tsx";
import { HookTitle } from "../scenes/text-scenes.tsx";
import { durationInFrames, msToFrames, segmentStartMs } from "../timeline/resolve.ts";
import { musicVolumeAt, type Window } from "./audio.ts";
import { FORMAT_SIZES, type AdProps } from "./props.ts";

/** Duration from the resolved timeline, size from the format (§5.6 step 4). */
export const calculateAdMetadata: CalculateMetadataFunction<AdProps> = ({ props }) => {
  const size = FORMAT_SIZES[props.spec.format];
  return { durationInFrames: durationInFrames(props.timeline.totalMs, props.spec.fps), fps: props.spec.fps, width: size.width, height: size.height };
};

function Overlay({ scene }: { scene: Scene }) {
  const { width, height } = useVideoConfig();
  const b = useBrand();
  if (!scene.overlay) return null;
  const z = safeRect("all", width, height);
  const top = scene.overlay.position === "top" ? z.y : scene.overlay.position === "center" ? z.y + z.h * 0.4 : z.y + z.h * 0.55;
  return (
    <div style={{ position: "absolute", left: z.x, top, width: z.w, display: "flex", justifyContent: "center" }}>
      <div style={{ background: "rgba(0,0,0,0.6)", borderRadius: 18, padding: "14px 22px" }}>
        <FitText text={scene.overlay.text} maxWidth={z.w - 44} maxLines={3} maxFontSize={Math.round(Math.min(width, height) * 0.065)} fontFamily={b.fontFamily} color="#ffffff" />
      </div>
    </div>
  );
}

/** Fade/slide/zoom into a scene over its first durationMs. */
function TransitionIn({ kind, durationMs, children }: { kind: TransitionKind; durationMs: number; children: ReactNode }) {
  const frame = useCurrentFrame();
  const { fps, width } = useVideoConfig();
  if (kind === "cut" || durationMs <= 0) return <>{children}</>;
  const u = interpolate(frame, [0, msToFrames(durationMs, fps)], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });
  const style =
    kind === "fade" ? { opacity: u } : kind === "slide" ? { transform: `translateX(${(1 - u) * width}px)` } : { transform: `scale(${1.2 - 0.2 * u})`, opacity: u };
  return <AbsoluteFill style={style}>{children}</AbsoluteFill>;
}

export function AdComposition(props: AdProps) {
  const { spec, timeline, audio, captions, aiLabel, hookIdx, clickLogs, assetMeta, showSafeZones } = props;
  const { fps } = useVideoConfig();
  const resolve = useAssetUrlResolver();
  const hook = spec.hookVariants[hookIdx] ?? spec.hookVariants[0];
  const f = (ms: number) => msToFrames(ms, fps);
  const scenesById = useMemo(() => new Map(spec.scenes.map((s) => [s.id, s])), [spec.scenes]);
  const firstVisual = spec.scenes.find((s) => s.visual.kind === "screenshot" || s.visual.kind === "deviceMockup")?.visual.assetId;

  const voPlacements = audio.voSegments
    .map((seg) => ({ seg, startMs: segmentStartMs(timeline, seg.sceneId) }))
    .filter((p): p is { seg: (typeof audio.voSegments)[number]; startMs: number } => p.startMs !== null);
  const voWindows: Window[] = voPlacements.map((p) => ({ startMs: p.startMs, endMs: p.startMs + p.seg.durationMs }));
  const musicId = audio.musicAssetId ?? spec.music.trackAssetId;

  return (
    <BrandProvider brand={spec.brand}>
      <AbsoluteFill style={{ backgroundColor: "#000" }}>
        <Sequence durationInFrames={Math.max(1, f(timeline.hookMs))} name="Opening line">
          {hook ? <HookTitle text={hook.onScreen} style={hook.style} {...(firstVisual ? { backgroundAssetId: firstVisual } : {})} /> : null}
        </Sequence>

        {timeline.scenes.map((ts) => {
          const scene = scenesById.get(ts.id);
          if (!scene) return null;
          const tr = spec.transitions.find((t) => t.sceneId === scene.id);
          const clickLog = scene.visual.assetId ? clickLogs?.[scene.visual.assetId] : undefined;
          return (
            <Sequence key={ts.id} from={f(ts.startMs)} durationInFrames={Math.max(1, f(ts.durationMs))} name={`${scene.type} ${scene.id}`}>
              <TransitionIn kind={tr?.kind ?? "cut"} durationMs={tr?.durationMs ?? 0}>
                <SceneView
                  scene={scene}
                  spec={spec}
                  durationMs={ts.durationMs}
                  {...(clickLog ? { clickLog } : {})}
                  {...(assetMeta ? { assetMeta } : {})}
                />
                {OWNS_OVERLAY.has(scene.type) ? null : <Overlay scene={scene} />}
              </TransitionIn>
            </Sequence>
          );
        })}

        <Sequence from={f(timeline.ctaStartMs)} durationInFrames={Math.max(1, f(timeline.ctaMs))} name="Closing card">
          <CtaEndCard onScreen={spec.cta.onScreen} logoAssetId={spec.brand.logoAssetId} disclosures={spec.disclosures} />
        </Sequence>

        {spec.captions.enabled && captions?.length ? <Captions captions={captions} style={spec.captions.style} /> : null}
        {aiLabel ? <AiLabel /> : null}

        {voPlacements.map(({ seg, startMs }) => (
          <Sequence key={`vo-${seg.sceneId}`} from={f(startMs)} durationInFrames={Math.max(1, f(seg.durationMs) + 1)} layout="none" name={`Voice ${seg.sceneId}`}>
            <Html5Audio src={resolve(seg.assetId)} />
          </Sequence>
        ))}
        {musicId ? (
          <Html5Audio
            src={resolve(musicId)}
            loop
            volume={(frame) => musicVolumeAt(voWindows, (frame / fps) * 1000, spec.music.duckDb)}
          />
        ) : null}
        {spec.sfx.map((s, i) => {
          const id = audio.sfx?.[s.kind];
          return id ? (
            <Sequence key={`sfx-${i}`} from={f(s.atMs)} layout="none" name={`Sound ${s.kind}`}>
              <Html5Audio src={resolve(id)} volume={0.6} />
            </Sequence>
          ) : null;
        })}

        {showSafeZones ? <SafeZoneOverlay platform={showSafeZones} /> : null}
      </AbsoluteFill>
    </BrandProvider>
  );
}
