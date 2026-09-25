import type { ComponentType, ReactNode } from "react";
import { AbsoluteFill, Img } from "remotion";
import type { StillTemplateId } from "@mkt/contracts";
import { useAssetUrl } from "../components/AssetUrl.tsx";
import { useBrand } from "../components/BrandProvider.tsx";
import { DeviceFrame } from "../components/DeviceFrame.tsx";
import { FitText } from "../components/FitText.tsx";
import { safeRect, type Rect } from "../layout/safe-zones.ts";
import type { StillSlide } from "../compositions/props.ts";

// Swipe-post and static templates (D25, §5.5). Every word is real text from the slide; real
// screenshots only ever go inside generic device frames.

export type StillTemplateProps = { slide: StillSlide; width: number; height: number };

function Shot({ assetId, device, width }: { assetId: string; device: "phone" | "laptop"; width: number }) {
  const src = useAssetUrl(assetId);
  return (
    <DeviceFrame device={device} width={width}>
      <Img src={src} style={{ width: "100%", height: "100%", objectFit: "cover", objectPosition: "50% 0%", display: "block" }} />
    </DeviceFrame>
  );
}

function Frame({ children, zone, slide }: { children: ReactNode; zone: Rect; slide: StillSlide }) {
  const b = useBrand();
  const unit = Math.min(zone.w, zone.h);
  return (
    <AbsoluteFill style={{ background: `linear-gradient(160deg, ${b.surface} 0%, ${b.bg} 70%)`, fontFamily: b.fontFamily }}>
      {children}
      {slide.total > 1 ? (
        <div style={{ position: "absolute", right: zone.x, top: zone.y, color: b.muted, fontWeight: 700, fontSize: Math.round(unit * 0.04) }}>
          {slide.index}/{slide.total}
        </div>
      ) : null}
    </AbsoluteFill>
  );
}

function Body({ text, size, color }: { text?: string; size: number; color: string }) {
  return text ? <div style={{ fontSize: size, fontWeight: 500, lineHeight: 1.35, color }}>{text}</div> : null;
}

const layout = (width: number, height: number) => {
  const zone = safeRect("all", width, height);
  return { zone, wide: width > height * 1.2, unit: Math.min(width, height) };
};

export function HeroStill({ slide, width, height }: StillTemplateProps) {
  const b = useBrand();
  const { zone, wide, unit } = layout(width, height);
  const textW = wide ? zone.w * 0.55 : zone.w;
  const device = slide.device ?? (wide ? "laptop" : "phone");
  return (
    <Frame zone={zone} slide={slide}>
      <div style={{ position: "absolute", left: zone.x, top: zone.y + unit * 0.06, width: textW, display: "flex", flexDirection: "column", gap: unit * 0.03 }}>
        <FitText text={slide.headline} maxWidth={textW} maxLines={3} maxFontSize={Math.round(unit * 0.11)} fontFamily={b.fontFamily} color={b.fg} align="left" />
        <Body text={slide.body} size={Math.round(unit * 0.042)} color={b.muted} />
      </div>
      {slide.assetId ? (
        <div style={wide ? { position: "absolute", right: zone.x, top: zone.y + zone.h * 0.12 } : { position: "absolute", left: 0, right: 0, bottom: -unit * 0.25, display: "flex", justifyContent: "center" }}>
          <Shot assetId={slide.assetId} device={device} width={Math.round(device === "phone" ? unit * 0.55 : wide ? zone.w * 0.42 : zone.w)} />
        </div>
      ) : null}
    </Frame>
  );
}

export function ProblemStill({ slide, width, height }: StillTemplateProps) {
  const b = useBrand();
  const { zone, unit } = layout(width, height);
  return (
    <Frame zone={zone} slide={slide}>
      <AbsoluteFill style={{ justifyContent: "center", paddingLeft: zone.x, paddingRight: zone.x }}>
        <div style={{ width: unit * 0.12, height: unit * 0.018, background: b.accent, borderRadius: 99, marginBottom: unit * 0.04 }} />
        <FitText text={slide.headline} maxWidth={zone.w} maxLines={4} maxFontSize={Math.round(unit * 0.1)} fontFamily={b.fontFamily} color={b.fg} align="left" />
        <div style={{ height: unit * 0.03 }} />
        <Body text={slide.body} size={Math.round(unit * 0.045)} color={b.muted} />
      </AbsoluteFill>
    </Frame>
  );
}

export function FeatureStill({ slide, width, height }: StillTemplateProps) {
  const b = useBrand();
  const { zone, wide, unit } = layout(width, height);
  const device = slide.device ?? "laptop";
  const textW = wide ? zone.w * 0.4 : zone.w;
  return (
    <Frame zone={zone} slide={slide}>
      <div style={{ position: "absolute", left: zone.x, top: zone.y + unit * 0.05, width: textW, display: "flex", flexDirection: "column", gap: unit * 0.025 }}>
        <FitText text={slide.headline} maxWidth={textW} maxLines={3} maxFontSize={Math.round(unit * 0.085)} fontFamily={b.fontFamily} color={b.fg} align="left" />
        <Body text={slide.body} size={Math.round(unit * 0.038)} color={b.muted} />
      </div>
      {slide.assetId ? (
        <div style={wide ? { position: "absolute", right: zone.x, top: zone.y + zone.h * 0.1 } : { position: "absolute", left: 0, right: 0, bottom: zone.y, display: "flex", justifyContent: "center" }}>
          <Shot assetId={slide.assetId} device={device} width={Math.round(device === "phone" ? unit * 0.5 : wide ? zone.w * 0.56 : zone.w)} />
        </div>
      ) : null}
    </Frame>
  );
}

export function StepsStill({ slide, width, height }: StillTemplateProps) {
  const b = useBrand();
  const { zone, unit } = layout(width, height);
  const badge = Math.round(unit * 0.16);
  return (
    <Frame zone={zone} slide={slide}>
      <div style={{ position: "absolute", left: zone.x, top: zone.y + unit * 0.05, width: zone.w, display: "flex", flexDirection: "column", gap: unit * 0.035 }}>
        <div
          style={{
            width: badge,
            height: badge,
            borderRadius: badge,
            background: b.primary,
            color: b.onPrimary,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            fontWeight: 900,
            fontSize: Math.round(badge * 0.5),
          }}
        >
          {slide.index}
        </div>
        <FitText text={slide.headline} maxWidth={zone.w} maxLines={3} maxFontSize={Math.round(unit * 0.09)} fontFamily={b.fontFamily} color={b.fg} align="left" />
        <Body text={slide.body} size={Math.round(unit * 0.042)} color={b.muted} />
      </div>
      {slide.assetId ? (
        <div style={{ position: "absolute", left: 0, right: 0, bottom: -unit * 0.15, display: "flex", justifyContent: "center" }}>
          <Shot assetId={slide.assetId} device={slide.device ?? "phone"} width={Math.round(slide.device === "laptop" ? zone.w : unit * 0.5)} />
        </div>
      ) : null}
    </Frame>
  );
}

export function ProofStill({ slide, width, height }: StillTemplateProps) {
  const b = useBrand();
  const { zone, unit } = layout(width, height);
  return (
    <Frame zone={zone} slide={slide}>
      <AbsoluteFill style={{ alignItems: "center", justifyContent: "center" }}>
        <div style={{ width: zone.w, padding: unit * 0.06, boxSizing: "border-box", borderRadius: unit * 0.04, background: b.surface, borderLeft: `${Math.round(unit * 0.02)}px solid ${b.accent}` }}>
          <FitText text={slide.headline} maxWidth={zone.w - unit * 0.14} maxLines={4} maxFontSize={Math.round(unit * 0.08)} fontFamily={b.fontFamily} color={b.fg} align="left" />
          <div style={{ height: unit * 0.03 }} />
          <Body text={slide.body} size={Math.round(unit * 0.036)} color={b.muted} />
        </div>
      </AbsoluteFill>
    </Frame>
  );
}

export function CtaStill({ slide, width, height }: StillTemplateProps) {
  const b = useBrand();
  const { zone, unit } = layout(width, height);
  const logo = useAssetUrl(b.logoAssetId);
  return (
    <Frame zone={zone} slide={slide}>
      <AbsoluteFill style={{ alignItems: "center", justifyContent: "center", gap: unit * 0.05 }}>
        {logo ? <Img src={logo} style={{ width: unit * 0.2, height: unit * 0.2, objectFit: "contain", borderRadius: unit * 0.04, background: "#fff" }} /> : null}
        <FitText text={slide.headline} maxWidth={zone.w} maxLines={3} maxFontSize={Math.round(unit * 0.095)} fontFamily={b.fontFamily} color={b.fg} />
        {slide.body ? (
          <div style={{ padding: `${unit * 0.025}px ${unit * 0.05}px`, borderRadius: 999, background: b.primary, color: b.onPrimary, fontWeight: 800, fontSize: Math.round(unit * 0.045) }}>
            {slide.body}
          </div>
        ) : null}
      </AbsoluteFill>
    </Frame>
  );
}

export const STILL_TEMPLATE_COMPONENTS: Record<StillTemplateId, ComponentType<StillTemplateProps>> = {
  hero: HeroStill,
  problem: ProblemStill,
  feature: FeatureStill,
  steps: StepsStill,
  proof: ProofStill,
  cta: CtaStill,
};
