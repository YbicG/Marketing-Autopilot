import { AbsoluteFill, interpolate, spring } from "remotion";
import type { HookStyle } from "@mkt/contracts";
import { useBrand } from "../components/BrandProvider.tsx";
import { FitText } from "../components/FitText.tsx";
import { AssetImg, Backdrop, sceneTitle, useSceneClock, type SceneProps } from "./common.tsx";

// Plain-English labels above an opening line; none for styles that speak for themselves.
const KICKERS: Partial<Record<HookStyle, string>> = {
  pov: "POV",
  build_in_public: "Building in public",
  speed_demo: "Watch this",
  before_after_split: "Before → after",
  real_stat: "Real numbers",
  listicle_disclosed: "Our pick",
};

export type HookTitleProps = { text: string; style?: HookStyle; backgroundAssetId?: string };

/** The opening line: big type popping in, over a dimmed screenshot or the brand backdrop. */
export function HookTitle({ text, style, backgroundAssetId }: HookTitleProps) {
  const { frame, fps, zone, width, height } = useSceneClock();
  const b = useBrand();
  const pop = spring({ frame, fps, config: { damping: 14, stiffness: 180 } });
  const kicker = style ? KICKERS[style] : undefined;
  const bubble = style === "reply_to_complaint";
  const big = style === "real_stat" ? 1.25 : 1;
  return (
    <AbsoluteFill>
      {backgroundAssetId ? (
        <AbsoluteFill>
          <AssetImg assetId={backgroundAssetId} style={{ filter: "brightness(0.35) blur(2px)", transform: `scale(${1.08 - 0.04 * pop})` }} />
        </AbsoluteFill>
      ) : (
        <Backdrop />
      )}
      <AbsoluteFill style={{ alignItems: "center", justifyContent: "center" }}>
        <div
          style={{
            width: zone.w,
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            gap: Math.round(height * 0.02),
            transform: `scale(${0.85 + 0.15 * pop})`,
            opacity: pop,
          }}
        >
          {kicker ? (
            <div style={{ padding: "8px 20px", borderRadius: 999, background: b.primary, color: b.onPrimary, fontFamily: b.fontFamily, fontWeight: 700, fontSize: Math.round(width * 0.035) }}>
              {kicker}
            </div>
          ) : null}
          <div style={bubble ? { background: "#ffffff", borderRadius: 28, padding: "28px 32px", boxShadow: "0 20px 40px rgba(0,0,0,0.35)" } : undefined}>
            <FitText
              text={text}
              maxWidth={bubble ? zone.w - 64 : zone.w}
              maxLines={bubble ? 4 : 3}
              maxFontSize={Math.round(width * 0.11 * big)}
              fontFamily={b.fontFamily}
              color={bubble ? "#111111" : b.fg}
              align={bubble ? "left" : "center"}
            />
          </div>
        </div>
      </AbsoluteFill>
    </AbsoluteFill>
  );
}

/** A spec scene of type HookTitle: a title card from the scene's own text. */
export function HookTitleScene({ scene }: SceneProps) {
  return <HookTitle text={sceneTitle(scene)} backgroundAssetId={scene.visual.assetId} />;
}

/** Words land one at a time, line by line. */
export function KineticText({ scene, durationMs }: SceneProps) {
  const { frame, fps, tMs, zone, width } = useSceneClock();
  const b = useBrand();
  const lines = scene.copy?.items?.length ? scene.copy.items : [sceneTitle(scene)];
  const words = lines.flatMap((line, li) => line.split(/\s+/).filter(Boolean).map((w) => ({ w, li })));
  const perWordMs = Math.min(260, (durationMs * 0.6) / Math.max(1, words.length));
  const fontSize = Math.round(width * (words.length > 10 ? 0.075 : 0.095));
  return (
    <Backdrop>
      <AbsoluteFill style={{ alignItems: "center", justifyContent: "center" }}>
        <div style={{ width: zone.w, display: "flex", flexDirection: "column", gap: fontSize * 0.25, alignItems: "center" }}>
          {lines.map((_, li) => (
            <div key={li} style={{ display: "flex", flexWrap: "wrap", justifyContent: "center", gap: `0 ${fontSize * 0.28}px` }}>
              {words
                .map((x, i) => ({ ...x, i }))
                .filter((x) => x.li === li)
                .map(({ w, i }) => {
                  const start = (i * perWordMs * fps) / 1000;
                  const s = spring({ frame: frame - start, fps, config: { damping: 16, stiffness: 220 } });
                  const accent = li === lines.length - 1 && lines.length > 1;
                  return (
                    <span
                      key={i}
                      style={{
                        fontFamily: b.fontFamily,
                        fontWeight: 800,
                        fontSize,
                        lineHeight: 1.1,
                        color: accent ? b.accent : b.fg,
                        opacity: tMs >= (i * perWordMs) ? s : 0,
                        transform: `translateY(${interpolate(s, [0, 1], [fontSize * 0.4, 0])}px)`,
                        display: "inline-block",
                      }}
                    >
                      {w}
                    </span>
                  );
                })}
            </div>
          ))}
        </div>
      </AbsoluteFill>
    </Backdrop>
  );
}
