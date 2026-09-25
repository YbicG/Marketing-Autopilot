import type { VideoSpec } from "@mkt/contracts";
import { BUNDLED_FONT_FAMILY } from "../fonts/registry.ts";
import { resolveTimeline } from "../timeline/resolve.ts";
import type { AdProps, StillProps } from "./props.ts";

// Default props so the compositions open in Studio and the player without real data.

export const SAMPLE_SPEC: VideoSpec = {
  schemaVersion: 1,
  format: "9x16",
  fps: 30,
  targetSeconds: 15,
  brand: { colors: ["#6366f1", "#22d3ee"], font: BUNDLED_FONT_FAMILY, logoAssetId: null },
  voice: { voiceId: "sample", model: "draft" },
  music: { mood: "upbeat", duckDb: -12, trackAssetId: null },
  captions: { enabled: false, style: "tiktok" },
  hookVariants: [
    { style: "pain_callout", onScreen: "Still copying dates by hand?", vo: "Still copying dates by hand?" },
    { style: "question", onScreen: "What if setup took one click?", vo: "What if setup took one click?" },
    { style: "speed_demo", onScreen: "Whole semester in 10 seconds", vo: "Whole semester in ten seconds." },
  ],
  scenes: [
    { id: "s1", type: "KineticText", minMs: 2500, overlay: { text: "Drop in your syllabus", position: "center" }, visual: { kind: "kineticText" } },
    { id: "s2", type: "ProofStrip", minMs: 2500, visual: { kind: "kineticText" }, copy: { items: ["Every deadline, found", "Straight into your calendar"] } },
  ],
  transitions: [],
  sfx: [],
  cta: { onScreen: "Try it free", vo: "Try it free." },
  disclosures: [],
};

export const SAMPLE_AD_PROPS: AdProps = {
  spec: SAMPLE_SPEC,
  hookIdx: 0,
  timeline: resolveTimeline(SAMPLE_SPEC, {}, 0),
  audio: { voSegments: [], musicAssetId: null },
  captions: null,
  aiLabel: false,
};

export const SAMPLE_STILL_PROPS: StillProps = {
  template: "hero",
  width: 1080,
  height: 1350,
  brand: SAMPLE_SPEC.brand,
  slide: { headline: "Your whole semester, in one calendar", body: "Drop in a syllabus. Get every deadline.", index: 1, total: 5 },
};
