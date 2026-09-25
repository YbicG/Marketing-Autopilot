import { describe, expect, it } from "vitest";
import type { VideoSpec } from "@mkt/contracts";
import { adAudioFor as coreAudio, captionsFor as coreCaptions, noVoiceLine, voDurationsFor as coreDurations, type AudioPlan } from "@mkt/core/video";
import { resolveTimeline, SAMPLE_SPEC } from "@mkt/video";
import { adAudioFor, buildPreviewProps, captionsFor, estimatedLine, lineMeter, linesForSpec, voDurationsFor, type EditorLine } from "./ad-props";

const spec: VideoSpec = {
  ...SAMPLE_SPEC,
  captions: { enabled: true, style: "tiktok" },
  scenes: [{ ...SAMPLE_SPEC.scenes[0]!, vo: "Drop in your syllabus and relax." }, SAMPLE_SPEC.scenes[1]!],
};

const voiced = (text: string, assetId: string, durationMs: number): EditorLine => ({
  text,
  assetId,
  segmentId: `seg-${assetId}`,
  durationMs,
  words: text.split(" ").map((w, i) => ({ text: w, startMs: i * 300, endMs: i * 300 + 250 })),
});

const lines: Record<string, EditorLine> = {
  "hook:0": voiced("Still copying dates by hand?", "a0", 1800),
  "hook:1": voiced("What if setup took one click?", "a1", 2100),
  "hook:2": voiced("Whole semester in ten seconds.", "a2", 1900),
  s1: voiced("Drop in your syllabus and relax.", "a3", 2400),
  cta: voiced("Try it free.", "a4", 1000),
};
const plan: AudioPlan = { quality: "draft", voiceId: "v", lines: lines as AudioPlan["lines"], musicAssetId: "m1", noVoice: false, musicFallback: false };

describe("editor preview props match the worker's", () => {
  it("durations, audio and captions are the same as core's for a saved spec", () => {
    for (const hookIdx of [0, 1, 2]) {
      expect(voDurationsFor(lines, hookIdx)).toEqual(coreDurations(plan, hookIdx));
      expect(adAudioFor(lines, "m1", hookIdx)).toEqual(coreAudio(plan, hookIdx));
      const timeline = resolveTimeline(spec, coreDurations(plan, hookIdx), hookIdx);
      expect(captionsFor(lines, timeline, hookIdx)).toEqual(coreCaptions(plan, timeline, hookIdx));
      const props = buildPreviewProps({ spec, lines, musicAssetId: "m1", noVoice: false, hookIdx });
      expect(props.timeline).toEqual(timeline);
      expect(props.aiLabel).toBe(true);
    }
  });

  it("times an edited line at the no-voice pace, silent, like core's noVoiceLine", () => {
    const edited: VideoSpec = { ...spec, scenes: [{ ...spec.scenes[0]!, vo: "Drop in your syllabus. That's it, really." }, spec.scenes[1]!] };
    const { lines: out, stale } = linesForSpec(edited, lines);
    expect(stale).toEqual(["s1"]);
    expect(out.s1).toEqual({ ...noVoiceLine("Drop in your syllabus. That's it, really."), segmentId: null });
    expect(estimatedLine("a b c").durationMs).toBe(noVoiceLine("a b c").durationMs);
    const props = buildPreviewProps({ spec: edited, lines, musicAssetId: null, noVoice: false, hookIdx: 0 });
    expect(props.audio.voSegments.map((s) => s.sceneId)).not.toContain("s1");
  });

  it("measures words per second only from a matching voiced take", () => {
    expect(lineMeter("Try it free.", lines.cta)).toEqual({ words: 3, wps: 3, seconds: 1 });
    expect(lineMeter("Try it for free today.", lines.cta).wps).toBeNull();
    expect(lineMeter("", undefined)).toEqual({ words: 0, wps: null, seconds: 0 });
  });
});
