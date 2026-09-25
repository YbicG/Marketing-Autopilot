import { describe, expect, it } from "vitest";
import type { Scene, VideoSpec } from "@mkt/contracts";
import { ASSETS, IDS, makeSpec } from "./fixture.ts";
import { focusBoxProblem, hasBlockingIssue, lintSpec, wordsPerSecond, wpsBand, type LintContext } from "./lint.ts";

const ctx = (over: Partial<LintContext> = {}): LintContext => ({
  assets: { ...ASSETS },
  publicClaimRefs: new Set(["C1", "C2"]),
  verifiedClaimRefs: new Set(["C1"]),
  ...over,
});

const withScene = (patch: Partial<Scene>, i = 0): VideoSpec => {
  const s = makeSpec();
  const scenes = s.scenes.map((sc, j) => (j === i ? { ...sc, ...patch } : sc));
  return { ...s, scenes };
};

const codes = (spec: VideoSpec, c = ctx()) => lintSpec(spec, c).map((i) => `${i.severity}:${i.code}`);

describe("wordsPerSecond", () => {
  it("counts words over seconds", () => {
    expect(wordsPerSecond("one two three four", 2000)).toBe(2);
    expect(wordsPerSecond("  spaced   out  ", 1000)).toBe(2);
    expect(wordsPerSecond("", 1000)).toBe(0);
    expect(wordsPerSecond("word", 0)).toBe(Number.POSITIVE_INFINITY);
  });
  it("bands", () => {
    expect(wpsBand(1.5)).toBe("slow");
    expect(wpsBand(1.8)).toBe("ok");
    expect(wpsBand(3.6)).toBe("ok");
    expect(wpsBand(4)).toBe("fast");
    expect(wpsBand(5)).toBe("too_fast");
    expect(wpsBand(0)).toBe("ok");
  });
});

describe("lintSpec", () => {
  it("passes the fixture cleanly", () => {
    expect(lintSpec(makeSpec(), ctx())).toEqual([]);
  });

  it("blocks a missing asset", () => {
    const { [IDS.shot]: _gone, ...assets } = ASSETS;
    expect(codes(makeSpec(), ctx({ assets }))).toContain("block:asset_missing");
  });

  it("blocks the wrong kind of asset", () => {
    expect(codes(withScene({ visual: { kind: "screenshot", assetId: IDS.rec } }))).toContain("block:asset_kind_mismatch");
  });

  it("blocks a trim outside the recording, and a backwards trim", () => {
    expect(codes(withScene({ visual: { kind: "recording", assetId: IDS.rec, trim: { startMs: 6000, endMs: 9000 } } }, 1))).toContain(
      "block:trim_outside_recording",
    );
    expect(codes(withScene({ visual: { kind: "recording", assetId: IDS.rec, trim: { startMs: 3000, endMs: 2000 } } }, 1))).toContain("block:trim_invalid");
  });

  it("warns when a recording's length is unknown", () => {
    const assets = { ...ASSETS, [IDS.rec]: { kind: "recording" } };
    expect(codes(makeSpec(), ctx({ assets }))).toContain("warn:trim_unchecked");
  });

  it("blocks focus boxes outside 0..1 (visual and camera)", () => {
    expect(codes(withScene({ visual: { kind: "screenshot", assetId: IDS.shot, focusBox: { x: 0.7, y: 0.2, w: 0.5, h: 0.3 } } }))).toContain(
      "block:focus_box_out_of_range",
    );
    expect(codes(withScene({ camera: [{ atMs: 0, zoom: 2, focusBox: { x: -0.1, y: 0, w: 0.2, h: 0.2 } }] }))).toContain("block:focus_box_out_of_range");
    expect(focusBoxProblem({ x: 0, y: 0, w: 1, h: 1 })).toBeNull();
    expect(focusBoxProblem({ x: 0.5, y: 0.5, w: 0, h: 0.1 })).toBe("has no size");
  });

  it("warns or blocks on speaking rate from measured voice", () => {
    // s1 vo is 9 words.
    expect(codes(makeSpec(), ctx({ voDurationsMs: { s1: 3500 } }))).toEqual([]);
    expect(codes(makeSpec(), ctx({ voDurationsMs: { s1: 2300 } }))).toContain("warn:wps_high");
    expect(codes(makeSpec(), ctx({ voDurationsMs: { s1: 1500 } }))).toContain("block:wps_too_high");
    expect(codes(makeSpec(), ctx({ voDurationsMs: { s1: 8000 } }))).toContain("warn:wps_low");
  });

  it("limits on-screen text", () => {
    expect(codes(withScene({ overlay: { text: "a ".repeat(15).trim(), position: "top" } }))).toContain("warn:overlay_long");
    expect(codes(withScene({ overlay: { text: "x".repeat(130), position: "top" } }))).toContain("block:overlay_too_long");
  });

  it("only lets ProofStrip show verified, public claims", () => {
    const proof = (claimRefs: string[]) => withScene({ type: "ProofStrip", claimRefs, copy: { items: ["Saves 3 hours"] } });
    expect(codes(proof(["C1"]))).toEqual([]);
    expect(codes(proof(["C2"]))).toContain("block:proof_unverified_claim");
    expect(codes(proof(["C9"]))).toEqual(expect.arrayContaining(["block:claim_not_public", "block:proof_unverified_claim"]));
    expect(codes(proof([]))).toContain("block:proof_without_claims");
  });

  it("blocks non-public claims in any scene", () => {
    expect(codes(withScene({ claimRefs: ["C3"] }))).toContain("block:claim_not_public");
  });

  it("blocks watermark text", () => {
    expect(codes(withScene({ overlay: { text: "Made with CapCut", position: "bottom" } }))).toContain("block:watermark");
    const s = makeSpec();
    expect(codes({ ...s, cta: { onScreen: "Follow tiktok.com/@us", vo: "x" } })).toContain("block:watermark");
    expect(codes({ ...s, hookVariants: [{ ...s.hookVariants[0]!, onScreen: "no watermark here" }, s.hookVariants[1]!, s.hookVariants[2]!] })).toContain(
      "block:watermark",
    );
  });

  it("blocks URLs and HTML that bypassed zod", () => {
    expect(codes(withScene({ vo: "go to https://x.io" }))).toContain("block:unsafe_string");
  });

  it("checks scene/visual pairing", () => {
    expect(codes(withScene({ type: "RecordingAutoZoom" }))).toContain("block:scene_visual_mismatch");
    expect(codes(withScene({ type: "DeviceMockup", visual: { kind: "deviceMockup", assetId: IDS.shot } }))).toContain("warn:device_default");
  });

  it("warns about unknown references and length", () => {
    const s = makeSpec();
    expect(codes({ ...s, camera: { nope: [{ atMs: 0, zoom: 1.5 }] } })).toContain("warn:camera_unknown_scene");
    expect(codes({ ...s, transitions: [{ sceneId: "nope", kind: "fade", durationMs: 200 }] })).toContain("warn:transition_unknown_scene");
    const long = { ...s, scenes: Array.from({ length: 8 }, (_, i) => ({ ...s.scenes[0]!, id: `x${i}`, minMs: 4000 })) };
    expect(codes(long)).toContain("warn:over_target_length");
    expect(codes({ ...s, brand: { ...s.brand, font: "Comic Sans" } })).toContain("warn:font_not_bundled");
  });

  it("hasBlockingIssue", () => {
    expect(hasBlockingIssue([{ code: "x", message: "", severity: "warn" }])).toBe(false);
    expect(hasBlockingIssue([{ code: "x", message: "", severity: "block" }])).toBe(true);
  });
});
