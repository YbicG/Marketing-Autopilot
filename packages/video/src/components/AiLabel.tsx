import { useVideoConfig } from "remotion";
import { safeRect } from "../layout/safe-zones.ts";
import { useBrand } from "./BrandProvider.tsx";

/** Small, always-visible disclosure chip, top-left inside the safe zone (§8). */
export function AiLabel({ text = "Made with AI" }: { text?: string }) {
  const { width, height } = useVideoConfig();
  const brand = useBrand();
  const z = safeRect("all", width, height);
  const size = Math.round(Math.min(width, height) * 0.026);
  return (
    <div
      style={{
        position: "absolute",
        left: z.x,
        top: z.y,
        padding: `${size * 0.35}px ${size * 0.7}px`,
        borderRadius: size,
        background: "rgba(0,0,0,0.55)",
        color: "#ffffff",
        fontFamily: brand.fontFamily,
        fontWeight: 600,
        fontSize: size,
        letterSpacing: 0.2,
      }}
    >
      {text}
    </div>
  );
}
