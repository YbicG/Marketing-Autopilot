import type { CalculateMetadataFunction } from "remotion";
import { BrandProvider } from "../components/BrandProvider.tsx";
import { SafeZoneOverlay } from "../components/SafeZoneOverlay.tsx";
import { STILL_TEMPLATE_COMPONENTS } from "../stills/templates.tsx";
import type { StillProps } from "./props.ts";

/** Size comes from the props, so one registered Still serves every platform size. */
export const calculateStillMetadata: CalculateMetadataFunction<StillProps> = ({ props }) => ({ width: props.width, height: props.height });

export function StillComposition({ template, width, height, brand, slide, showSafeZones }: StillProps) {
  const Template = STILL_TEMPLATE_COMPONENTS[template];
  return (
    <BrandProvider brand={brand}>
      <Template slide={slide} width={width} height={height} />
      {showSafeZones ? <SafeZoneOverlay platform={showSafeZones} /> : null}
    </BrandProvider>
  );
}
