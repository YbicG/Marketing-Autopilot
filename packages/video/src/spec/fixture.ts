import type { VideoSpec } from "@mkt/contracts";

// Test/sample spec builder (not used by compositions).

export const IDS = {
  shot: "0199a0b0-0000-7000-8000-000000000001",
  rec: "0199a0b0-0000-7000-8000-000000000002",
  logo: "0199a0b0-0000-7000-8000-000000000003",
  music: "0199a0b0-0000-7000-8000-000000000004",
} as const;

export function makeSpec(over: Partial<VideoSpec> = {}): VideoSpec {
  return {
    schemaVersion: 1,
    format: "9x16",
    fps: 30,
    targetSeconds: 15,
    brand: { colors: ["#6366f1", "#22d3ee"], font: "Inter", logoAssetId: IDS.logo },
    voice: { voiceId: "v1", model: "draft" },
    music: { mood: "upbeat", duckDb: -12, trackAssetId: IDS.music },
    captions: { enabled: true, style: "tiktok" },
    hookVariants: [
      { style: "pain_callout", onScreen: "Still copying dates by hand?", vo: "Still copying dates by hand?" },
      { style: "question", onScreen: "One click?", vo: "What if it took one click?" },
      { style: "speed_demo", onScreen: "10 seconds", vo: "Watch the whole semester land in ten seconds." },
    ],
    scenes: [
      {
        id: "s1",
        type: "ScreenshotKenBurns",
        vo: "Drop in your syllabus and every deadline shows up.",
        minMs: 2500,
        visual: { kind: "screenshot", assetId: IDS.shot, focusBox: { x: 0.1, y: 0.2, w: 0.5, h: 0.3 } },
      },
      {
        id: "s2",
        type: "RecordingAutoZoom",
        vo: "Then one click puts it all in your calendar.",
        minMs: 3000,
        visual: { kind: "recording", assetId: IDS.rec, trim: { startMs: 1000, endMs: 5000 } },
      },
    ],
    transitions: [],
    sfx: [],
    cta: { onScreen: "Try it free", vo: "Try it free today." },
    disclosures: [],
    ...over,
  };
}

export const ASSETS = {
  [IDS.shot]: { kind: "screenshot", width: 1440, height: 900 },
  [IDS.rec]: { kind: "recording", durationMs: 8000, width: 1440, height: 900 },
  [IDS.logo]: { kind: "image", width: 512, height: 512 },
  [IDS.music]: { kind: "audio", durationMs: 60000 },
};
