import { Composition, Still } from "remotion";
import { AdComposition, calculateAdMetadata } from "./compositions/AdComposition.tsx";
import { SAMPLE_AD_PROPS, SAMPLE_STILL_PROPS } from "./compositions/defaults.ts";
import { AD_COMPOSITION, STILL_COMPOSITION } from "./compositions/props.ts";
import { SmokeTest } from "./compositions/SmokeTest.tsx";
import { calculateStillMetadata, StillComposition } from "./compositions/StillComposition.tsx";

export const SMOKE_COMPOSITION = "SmokeTest";

export function Root() {
  return (
    <>
      <Composition
        id={SMOKE_COMPOSITION}
        component={SmokeTest}
        durationInFrames={90}
        fps={30}
        width={1080}
        height={1920}
        defaultProps={{ label: "Render OK" }}
      />
      {/* Duration and size come from calculateMetadata; these are placeholders. */}
      <Composition
        id={AD_COMPOSITION}
        component={AdComposition}
        durationInFrames={30}
        fps={30}
        width={1080}
        height={1920}
        defaultProps={SAMPLE_AD_PROPS}
        calculateMetadata={calculateAdMetadata}
      />
      <Still
        id={STILL_COMPOSITION}
        component={StillComposition}
        width={1080}
        height={1350}
        defaultProps={SAMPLE_STILL_PROPS}
        calculateMetadata={calculateStillMetadata}
      />
    </>
  );
}
