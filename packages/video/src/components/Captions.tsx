import { useMemo } from "react";
import { AbsoluteFill, useCurrentFrame, useVideoConfig } from "remotion";
import type { Caption } from "@mkt/contracts";
import { safeRect } from "../layout/safe-zones.ts";
import { useBrand } from "./BrandProvider.tsx";
import { captionPages, pageAt } from "./captions-math.ts";

/**
 * Burned-in captions from word timings. "tiktok" highlights the word being spoken; "clean" shows
 * the line plainly. Sits in the lower part of the shared safe zone, clear of the TikTok rail.
 */
export function Captions({ captions, style }: { captions: readonly Caption[]; style: "tiktok" | "clean" }) {
  const frame = useCurrentFrame();
  const { fps, width, height } = useVideoConfig();
  const brand = useBrand();
  const pages = useMemo(() => captionPages(captions), [captions]);
  const tMs = (frame / fps) * 1000;
  const page = pageAt(pages, tMs);
  if (!page) return null;
  const zone = safeRect("all", width, height);
  const fontSize = Math.round(Math.min(width, height) * (style === "tiktok" ? 0.064 : 0.05));
  return (
    <AbsoluteFill style={{ pointerEvents: "none" }}>
      <div
        style={{
          position: "absolute",
          left: zone.x,
          width: zone.w,
          top: zone.y + zone.h * 0.72,
          display: "flex",
          justifyContent: "center",
          textAlign: "center",
          fontFamily: brand.fontFamily,
          fontWeight: 800,
          fontSize,
          lineHeight: 1.15,
          color: "#ffffff",
          textShadow: "0 3px 12px rgba(0,0,0,0.65)",
          whiteSpace: "pre-wrap",
        }}
      >
        <span style={style === "clean" ? { background: "rgba(0,0,0,0.55)", padding: "6px 16px", borderRadius: 12, fontWeight: 600 } : undefined}>
          {page.tokens.map((tok, i) => {
            const active = style === "tiktok" && tMs >= tok.fromMs && tMs < tok.toMs;
            return (
              <span key={`${tok.fromMs}-${i}`} style={active ? { color: brand.accent } : undefined}>
                {tok.text}
              </span>
            );
          })}
        </span>
      </div>
    </AbsoluteFill>
  );
}
