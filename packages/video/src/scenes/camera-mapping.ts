import type { CameraKey } from "@mkt/contracts";
import type { Rect } from "../layout/safe-zones.ts";

/** Camera keys whose focus boxes are in image/recording space → frame space, given where it sits. */
export function imageBoxToFrameKeys(keys: readonly CameraKey[], img: Rect, width: number, height: number): CameraKey[] {
  return keys.map((k) =>
    k.focusBox
      ? {
          ...k,
          focusBox: {
            x: (img.x + k.focusBox.x * img.w) / width,
            y: (img.y + k.focusBox.y * img.h) / height,
            w: (k.focusBox.w * img.w) / width,
            h: (k.focusBox.h * img.h) / height,
          },
        }
      : { ...k },
  );
}
