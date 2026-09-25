import { AbsoluteFill, interpolate, useCurrentFrame, useVideoConfig } from "remotion";

export type SmokeTestProps = {
  label: string;
};

/** M0 render smoke test: 3 s of animated text, no network, no assets. */
export function SmokeTest({ label }: SmokeTestProps) {
  const frame = useCurrentFrame();
  const { durationInFrames } = useVideoConfig();
  const opacity = interpolate(frame, [0, 15, durationInFrames - 15, durationInFrames], [0, 1, 1, 0]);
  return (
    <AbsoluteFill style={{ backgroundColor: "#0a0a0a", alignItems: "center", justifyContent: "center" }}>
      <div style={{ color: "white", fontSize: 96, fontFamily: "sans-serif", fontWeight: 700, opacity }}>{label}</div>
      <div style={{ color: "#a1a1aa", fontSize: 40, fontFamily: "sans-serif", marginTop: 24 }}>frame {frame}</div>
    </AbsoluteFill>
  );
}
