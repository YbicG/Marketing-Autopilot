import { Composition } from "remotion";
import { SmokeTest } from "./compositions/SmokeTest.tsx";

export const SMOKE_COMPOSITION = "SmokeTest";

export function Root() {
  return (
    <Composition
      id={SMOKE_COMPOSITION}
      component={SmokeTest}
      durationInFrames={90}
      fps={30}
      width={1080}
      height={1920}
      defaultProps={{ label: "Render OK" }}
    />
  );
}
