import { AbsoluteFill, useVideoConfig } from "remotion";
import { safeRect, type SafeZonePlatform } from "../layout/safe-zones.ts";

/** Editor only: shades everything outside the platform's safe zone. Never passed to renders. */
export function SafeZoneOverlay({ platform }: { platform: SafeZonePlatform }) {
  const { width, height } = useVideoConfig();
  const z = safeRect(platform, width, height);
  const shade = "rgba(255, 0, 80, 0.18)";
  return (
    <AbsoluteFill style={{ pointerEvents: "none" }}>
      <div style={{ position: "absolute", left: 0, top: 0, width, height: z.y, background: shade }} />
      <div style={{ position: "absolute", left: 0, top: z.y + z.h, width, height: height - z.y - z.h, background: shade }} />
      <div style={{ position: "absolute", left: 0, top: z.y, width: z.x, height: z.h, background: shade }} />
      <div style={{ position: "absolute", left: z.x + z.w, top: z.y, width: width - z.x - z.w, height: z.h, background: shade }} />
      <div style={{ position: "absolute", left: z.x, top: z.y, width: z.w, height: z.h, outline: "3px dashed rgba(255,0,80,0.8)" }} />
    </AbsoluteFill>
  );
}
