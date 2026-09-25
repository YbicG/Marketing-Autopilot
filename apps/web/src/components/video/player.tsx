"use client";
import { Player } from "@remotion/player";
import { useCallback, type ComponentType } from "react";
import { AdComposition, AssetUrlContext, durationInFrames, FORMAT_SIZES, type AdProps } from "@mkt/video";
// Inter for the player; renders load the same family inside the Remotion bundle (packages/video/src/fonts/load.ts).
import "@fontsource/inter/latin-400.css";
import "@fontsource/inter/latin-500.css";
import "@fontsource/inter/latin-600.css";
import "@fontsource/inter/latin-700.css";
import "@fontsource/inter/latin-800.css";
import "@fontsource/inter/latin-900.css";

const SAFE_ID = /^[A-Za-z0-9_-]{1,64}$/;

/** The "Ad" composition in the browser: asset ids resolve to /api/media (workspace-checked). */
export function AdPlayer({ props, className }: { props: AdProps; className?: string }) {
  const resolve = useCallback((assetId: string) => {
    if (!SAFE_ID.test(assetId)) throw new Error(`Not an asset id: ${assetId}`);
    return `/api/media/${assetId}`;
  }, []);
  const size = FORMAT_SIZES[props.spec.format];
  const frames = Math.max(1, durationInFrames(props.timeline.totalMs, props.spec.fps));
  const aspect = `${size.width} / ${size.height}`;
  return (
    <AssetUrlContext.Provider value={resolve}>
      <Player
        component={AdComposition as unknown as ComponentType<Record<string, unknown>>}
        inputProps={props as unknown as Record<string, unknown>}
        durationInFrames={frames}
        fps={props.spec.fps}
        compositionWidth={size.width}
        compositionHeight={size.height}
        controls
        acknowledgeRemotionLicense
        className={className}
        style={{ width: "100%", aspectRatio: aspect, background: "#000", borderRadius: 8 }}
      />
    </AssetUrlContext.Provider>
  );
}
