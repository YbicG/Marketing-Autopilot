import { describe, expect, it } from "vitest";
import {
  Caption,
  ClickEvent,
  VideoScript,
  VideoSpec,
  findUnsafeStrings,
  unsafeStringReason,
  videoScriptFromModel,
  videoSpecFromModel,
  type VideoSpecModel,
} from "@mkt/contracts";
import type { Caption as RemotionCaption } from "@remotion/captions";
import { makeSpec } from "./fixture.ts";

describe("unsafeStringReason (D8)", () => {
  const cases: [string, "url" | "html" | null][] = [
    ["https://evil.example/x.png", "url"],
    ["see http://x.io", "url"],
    ["HTTPS://X.IO", "url"],
    ["//cdn.example.com/a.js", "url"],
    ["load (//cdn.example.com)", "url"],
    ["data:image/png;base64,AAAA", "url"],
    ["javascript:alert(1)", "url"],
    ["blob:https://x", "url"],
    ["file:///etc/passwd", "url"],
    ["<script>alert(1)</script>", "html"],
    ["hi <b>there</b>", "html"],
    ["<img src=x onerror=y>", "html"],
    ["<!-- x -->", "html"],
    ["</div>", "html"],
    // allowed
    ["Try syllacal.com free", null],
    ["The data: 40% faster", null],
    ["3 < 5 and 5 > 3", null],
    ["I <3 this", null],
    ["and/or", null],
    ["Before → after", null],
    ["", null],
  ];
  it.each(cases)("%s → %s", (s, want) => expect(unsafeStringReason(s)).toBe(want));
});

describe("VideoSpec", () => {
  it("accepts a clean spec and fills defaults", () => {
    const { transitions: _t, sfx: _s, disclosures: _d, ...rest } = makeSpec();
    const parsed = VideoSpec.parse({ ...rest, music: { mood: "calm", trackAssetId: null } });
    expect(parsed.music.duckDb).toBe(-12);
    expect(parsed.transitions).toEqual([]);
    expect(parsed.disclosures).toEqual([]);
  });

  const mutations: [string, (s: ReturnType<typeof makeSpec>) => unknown][] = [
    ["hook text", (s) => ({ ...s, hookVariants: [{ ...s.hookVariants[0], onScreen: "go to https://x.io" }, s.hookVariants[1], s.hookVariants[2]] })],
    ["scene vo", (s) => ({ ...s, scenes: [{ ...s.scenes[0], vo: "<b>hi</b>" }, s.scenes[1]] })],
    ["overlay", (s) => ({ ...s, scenes: [{ ...s.scenes[0], overlay: { text: "//evil.io", position: "top" } }, s.scenes[1]] })],
    ["copy items", (s) => ({ ...s, scenes: [{ ...s.scenes[0], copy: { items: ["ok", "javascript:x"] } }, s.scenes[1]] })],
    ["disclosure", (s) => ({ ...s, disclosures: ["<iframe>"] })],
    ["cta", (s) => ({ ...s, cta: { onScreen: "data:text/html,hi", vo: "x" } })],
    ["voice id", (s) => ({ ...s, voice: { voiceId: "https://tts", model: "draft" } })],
    ["music mood", (s) => ({ ...s, music: { ...s.music, mood: "<x>" } })],
    ["font", (s) => ({ ...s, brand: { ...s.brand, font: "url(https://fonts.x/a.woff)" } })],
  ];
  it.each(mutations)("rejects a URL/HTML in %s", (_name, mutate) => {
    const r = VideoSpec.safeParse(mutate(makeSpec()));
    expect(r.success).toBe(false);
  });

  it("rejects an asset reference that is a URL or a path", () => {
    for (const assetId of ["https://x/y.png", "../../etc/passwd", "a/b", "x.png"]) {
      const s = makeSpec();
      const r = VideoSpec.safeParse({ ...s, scenes: [{ ...s.scenes[0], visual: { kind: "screenshot", assetId } }] });
      expect(r.success, assetId).toBe(false);
    }
  });

  it("rejects duplicate scene ids, wrong hook count and bad colours", () => {
    const s = makeSpec();
    expect(VideoSpec.safeParse({ ...s, scenes: [s.scenes[0], s.scenes[0]] }).success).toBe(false);
    expect(VideoSpec.safeParse({ ...s, hookVariants: s.hookVariants.slice(0, 2) }).success).toBe(false);
    expect(VideoSpec.safeParse({ ...s, brand: { ...s.brand, colors: ["red"] } }).success).toBe(false);
  });

  it("requires an asset for asset-backed visuals but not for kinetic text", () => {
    const s = makeSpec();
    expect(VideoSpec.safeParse({ ...s, scenes: [{ ...s.scenes[0], visual: { kind: "screenshot" } }] }).success).toBe(false);
    expect(VideoSpec.safeParse({ ...s, scenes: [{ ...s.scenes[0], type: "KineticText", visual: { kind: "kineticText" } }] }).success).toBe(true);
  });

  it("reports the path of every unsafe string", () => {
    const hits = findUnsafeStrings({ a: ["ok", { b: "http://x" }], "<k>": 1 });
    expect(hits).toEqual([
      { path: ["a", 1, "b"], reason: "url" },
      { path: ["<k>"], reason: "html" },
    ]);
  });
});

describe("model-facing schemas", () => {
  it("VideoScriptModel → VideoScript drops null onScreen and still rejects URLs", () => {
    const m = {
      hooks: makeSpec().hookVariants,
      beats: [{ vo: "one", onScreen: null, assetRefs: [] }],
      cta: { onScreen: "Go", vo: "Go" },
      claimRefs: [],
      assetRefs: [],
    };
    expect(videoScriptFromModel(m).beats[0]).toEqual({ vo: "one", assetRefs: [] });
    expect(() => videoScriptFromModel({ ...m, cta: { onScreen: "https://x", vo: "x" } })).toThrow();
    expect(VideoScript.safeParse({ ...m, hooks: m.hooks.slice(0, 1) }).success).toBe(false);
  });

  it("VideoSpecModel → VideoSpec with pipeline-owned brand and music", () => {
    const s = makeSpec();
    const m: VideoSpecModel = {
      format: "9x16",
      targetSeconds: 15,
      voice: s.voice,
      music: { mood: "calm", duckDb: -10 },
      captions: s.captions,
      hookVariants: s.hookVariants,
      scenes: [
        {
          id: "s1",
          type: "KineticText",
          vo: null,
          overlay: null,
          minMs: 2000,
          visual: { kind: "kineticText", assetId: null, trim: null, focusBox: null, device: null },
          camera: null,
          claimRefs: null,
          copy: { title: "Hi", subtitle: null, items: null },
          compare: null,
        },
      ],
      transitions: [],
      sfx: [],
      cta: s.cta,
      disclosures: [],
    };
    const spec = videoSpecFromModel(m, { brand: s.brand, musicTrackAssetId: null });
    expect(spec.schemaVersion).toBe(1);
    expect(spec.music).toEqual({ mood: "calm", duckDb: -10, trackAssetId: null });
    expect(spec.scenes[0]!.copy).toEqual({ title: "Hi" });
    expect(() => videoSpecFromModel({ ...m, targetSeconds: 20 }, { brand: s.brand, musicTrackAssetId: null })).toThrow();
  });
});

describe("Caption / ClickEvent", () => {
  it("Caption matches @remotion/captions' shape", () => {
    const c: RemotionCaption = { text: " hi", startMs: 0, endMs: 200, timestampMs: 100, confidence: null };
    const parsed: RemotionCaption = Caption.parse(c);
    expect(parsed).toEqual(c);
  });
  it("ClickEvent coordinates are 0..1", () => {
    expect(ClickEvent.safeParse({ tMs: 0, x: 1.2, y: 0, type: "click" }).success).toBe(false);
  });
});
