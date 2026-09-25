import type { ReactNode } from "react";

// Generic device frames (no brand hardware): plain rounded bezels drawn in CSS/SVG.

export const PHONE_SCREEN_ASPECT = 9 / 19.5;
export const LAPTOP_SCREEN_ASPECT = 16 / 10;

export function PhoneFrame({ width, children }: { width: number; children: ReactNode }) {
  const bezel = Math.round(width * 0.035);
  const radius = Math.round(width * 0.13);
  const screenW = width - 2 * bezel;
  const screenH = Math.round(screenW / PHONE_SCREEN_ASPECT);
  return (
    <div
      style={{
        width,
        height: screenH + 2 * bezel,
        padding: bezel,
        borderRadius: radius,
        background: "linear-gradient(145deg, #2a2a30, #0d0d10)",
        boxShadow: "0 40px 80px rgba(0,0,0,0.45), inset 0 0 0 2px rgba(255,255,255,0.08)",
        boxSizing: "border-box",
        position: "relative",
      }}
    >
      <div style={{ width: screenW, height: screenH, borderRadius: radius - bezel, overflow: "hidden", background: "#000", position: "relative" }}>
        {children}
        <div
          style={{
            position: "absolute",
            top: Math.round(screenW * 0.03),
            left: "50%",
            width: Math.round(screenW * 0.28),
            height: Math.round(screenW * 0.075),
            transform: "translateX(-50%)",
            borderRadius: 999,
            background: "#000",
          }}
        />
      </div>
    </div>
  );
}

export function LaptopFrame({ width, children }: { width: number; children: ReactNode }) {
  const bezel = Math.round(width * 0.025);
  const screenW = Math.round(width * 0.86);
  const screenH = Math.round(screenW / LAPTOP_SCREEN_ASPECT);
  const baseH = Math.round(width * 0.035);
  return (
    <div style={{ width, display: "flex", flexDirection: "column", alignItems: "center", filter: "drop-shadow(0 30px 50px rgba(0,0,0,0.45))" }}>
      <div style={{ width: screenW + 2 * bezel, padding: bezel, borderRadius: bezel * 1.6, background: "#16161a", boxSizing: "border-box" }}>
        <div style={{ width: screenW, height: screenH, overflow: "hidden", borderRadius: bezel * 0.4, background: "#000", position: "relative" }}>{children}</div>
      </div>
      <svg width={width} height={baseH} viewBox={`0 0 ${width} ${baseH}`} style={{ display: "block" }}>
        <path d={`M0 0 H${width} L${width * 0.97} ${baseH} H${width * 0.03} Z`} fill="#2a2a30" />
        <rect x={width * 0.42} y={0} width={width * 0.16} height={baseH * 0.35} rx={baseH * 0.15} fill="#1c1c20" />
      </svg>
    </div>
  );
}

export function DeviceFrame({ device, width, children }: { device: "phone" | "laptop"; width: number; children: ReactNode }) {
  return device === "laptop" ? <LaptopFrame width={width}>{children}</LaptopFrame> : <PhoneFrame width={width}>{children}</PhoneFrame>;
}
