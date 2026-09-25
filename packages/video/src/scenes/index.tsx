import type { SceneType } from "@mkt/contracts";
import type { ComponentType } from "react";
import { Camera } from "../components/Camera.tsx";
import type { SceneProps } from "./common.tsx";
import {
  CtaEndCardScene,
  DeviceMockup,
  FeatureCallout,
  FullPageScroll,
  ProofStrip,
  ScreenshotKenBurns,
  SplitCompare,
} from "./image-scenes.tsx";
import { RecordingAutoZoom } from "./RecordingAutoZoom.tsx";
import { HookTitleScene, KineticText } from "./text-scenes.tsx";

function RecordingScene({ scene, durationMs, clickLog, assetMeta, spec }: SceneProps) {
  const v = scene.visual;
  if (!v.assetId) return null;
  const camera = [...(scene.camera ?? []), ...(spec.camera?.[scene.id] ?? [])];
  return (
    <RecordingAutoZoom
      assetId={v.assetId}
      clickLog={clickLog ?? []}
      durationMs={durationMs}
      {...(v.trim ? { trim: v.trim } : {})}
      {...(camera.length ? { camera } : {})}
      {...(assetMeta ? { assetMeta } : {})}
    />
  );
}

export const SCENE_COMPONENTS: Record<SceneType, ComponentType<SceneProps>> = {
  HookTitle: HookTitleScene,
  KineticText,
  ScreenshotKenBurns,
  FullPageScroll,
  DeviceMockup,
  FeatureCallout,
  SplitCompare,
  ProofStrip,
  CtaEndCard: CtaEndCardScene,
  RecordingAutoZoom: RecordingScene,
};

/** Scene types that draw scene.overlay themselves; for the rest AdComposition draws it on top. */
export const OWNS_OVERLAY: ReadonlySet<SceneType> = new Set(["HookTitle", "KineticText"]);

/** One spec scene with its camera (RecordingAutoZoom runs its own camera in recording space). */
export function SceneView(props: SceneProps) {
  const Component = SCENE_COMPONENTS[props.scene.type];
  const keys = [...(props.scene.camera ?? []), ...(props.spec.camera?.[props.scene.id] ?? [])];
  if (props.scene.type === "RecordingAutoZoom" || keys.length === 0) return <Component {...props} />;
  return (
    <Camera keys={keys}>
      <Component {...props} />
    </Camera>
  );
}
