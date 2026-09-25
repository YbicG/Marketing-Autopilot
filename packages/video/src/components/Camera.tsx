import type { ReactNode } from "react";
import { AbsoluteFill, useCurrentFrame, useVideoConfig } from "remotion";
import type { CameraKey } from "@mkt/contracts";
import { cameraAt, cameraTransform } from "./camera-math.ts";

/** Eased zoom/pan over its children. Keys are relative to the enclosing Sequence. */
export function Camera({ keys, children }: { keys: readonly CameraKey[]; children: ReactNode }) {
  const frame = useCurrentFrame();
  const { fps, width, height } = useVideoConfig();
  const t = cameraTransform(cameraAt(keys, (frame / fps) * 1000), width, height);
  return (
    <AbsoluteFill style={{ overflow: "hidden" }}>
      <AbsoluteFill style={{ transformOrigin: "0 0", transform: t.css }}>{children}</AbsoluteFill>
    </AbsoluteFill>
  );
}
