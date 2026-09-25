import { Freeze, OffthreadVideo, Sequence } from "remotion";
import type { CameraKey, ClickEvent } from "@mkt/contracts";
import { useAssetUrl } from "../components/AssetUrl.tsx";
import { useBrand } from "../components/BrandProvider.tsx";
import { Camera } from "../components/Camera.tsx";
import { imageBoxToFrameKeys } from "./camera-mapping.ts";
import { activeRipples, autoCameraFromClicks, cursorAt, cursorPoints } from "./cursor.ts";
import { aspectOf, Backdrop, fitRect, useSceneClock, type AssetMeta } from "./common.tsx";

export type RecordingAutoZoomProps = {
  assetId: string;
  /** Click log as data: tMs from the recording start, x/y 0..1 in the recorded viewport. */
  clickLog: readonly ClickEvent[];
  durationMs: number;
  trim?: { startMs: number; endMs: number };
  /** Explicit camera keys in recording space (0..1 of the recording); auto-zoom on clicks when absent. */
  camera?: readonly CameraKey[];
  assetMeta?: AssetMeta;
};

/**
 * M3b: a screen recording with a drawn cursor gliding between click points, a ripple on each
 * click, and the camera easing in on where the action is. Holds the last frame if the scene
 * outlasts the clip.
 */
export function RecordingAutoZoom({ assetId, clickLog, durationMs, trim, camera, assetMeta }: RecordingAutoZoomProps) {
  const { tMs, fps, width, height, vertical } = useSceneClock();
  const b = useBrand();
  const src = useAssetUrl(assetId);
  const startMs = trim?.startMs ?? 0;
  const knownMs = assetMeta?.[assetId]?.durationMs ?? null;
  const clipMs = trim ? trim.endMs - trim.startMs : knownMs !== null ? knownMs - startMs : durationMs;
  const sceneFrames = Math.max(1, Math.round((durationMs * fps) / 1000));
  const clipFrames = Math.max(1, Math.min(sceneFrames, Math.floor((clipMs * fps) / 1000)));

  // The recording sits letterboxed in the frame; the cursor and camera use the same rect.
  const rect = fitRect(aspectOf(assetMeta, assetId, 16 / 10), { x: 0, y: vertical ? height * 0.22 : 0, w: width, h: vertical ? height * 0.56 : height });
  const recKeys = camera?.length ? camera : autoCameraFromClicks(clickLog, startMs, durationMs);
  const keys = imageBoxToFrameKeys(recKeys, rect, width, height);

  const recT = startMs + Math.min(tMs, clipMs);
  const cur = cursorAt(cursorPoints(clickLog), recT);
  const ripples = activeRipples(clickLog, recT);
  const cursorSize = Math.round(Math.min(width, height) * 0.045);
  const trimBefore = Math.round((startMs * fps) / 1000);

  const video = <OffthreadVideo src={src} trimBefore={trimBefore} muted style={{ width: "100%", height: "100%", objectFit: "fill" }} />;
  return (
    <Backdrop>
      <Camera keys={keys}>
        <div style={{ position: "absolute", left: rect.x, top: rect.y, width: rect.w, height: rect.h, overflow: "hidden", borderRadius: vertical ? 12 : 0 }}>
          <Sequence durationInFrames={clipFrames} layout="none">
            {video}
          </Sequence>
          {sceneFrames > clipFrames ? (
            <Sequence from={clipFrames} layout="none">
              <Freeze frame={Math.max(0, clipFrames - 1)}>{video}</Freeze>
            </Sequence>
          ) : null}
          {ripples.map((r, i) => (
            <div
              key={i}
              style={{
                position: "absolute",
                left: r.x * rect.w - cursorSize * 1.5 * r.progress,
                top: r.y * rect.h - cursorSize * 1.5 * r.progress,
                width: cursorSize * 3 * r.progress,
                height: cursorSize * 3 * r.progress,
                borderRadius: "50%",
                border: `4px solid ${b.accent}`,
                opacity: 1 - r.progress,
              }}
            />
          ))}
          {cur ? (
            <svg
              width={cursorSize}
              height={cursorSize}
              viewBox="0 0 24 24"
              style={{ position: "absolute", left: cur.x * rect.w - cursorSize * 0.12, top: cur.y * rect.h - cursorSize * 0.08, filter: "drop-shadow(0 2px 3px rgba(0,0,0,0.5))" }}
            >
              <path d="M3 2 L3 20 L8 15 L11.5 22 L14.5 20.5 L11 14 L18 14 Z" fill="#ffffff" stroke="#111111" strokeWidth={1.4} strokeLinejoin="round" />
            </svg>
          ) : null}
        </div>
      </Camera>
    </Backdrop>
  );
}
