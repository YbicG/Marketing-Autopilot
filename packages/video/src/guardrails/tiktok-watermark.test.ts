// §8 "TikTok composer UX", no-watermark part: TikTok (and Instagram/YouTube, which down-rank
// reposts) reject videos carrying another app's mark. lintSpec blocks on-screen text that looks
// like one. The rest of the row is in packages/core/src/guardrails/tiktok-composer.test.ts.
import { describe, expect, it } from "vitest";
import type { VideoSpec } from "@mkt/contracts";
import { ASSETS, makeSpec } from "../spec/fixture.ts";
import { lintSpec } from "../spec/lint.ts";

const watermark = (spec: VideoSpec) =>
  lintSpec(spec, { assets: ASSETS, publicClaimRefs: new Set(), verifiedClaimRefs: new Set() }).filter((i) => i.code === "watermark" && i.severity === "block");

describe("§8 No watermarks", () => {
  it("the sample spec has none", () => {
    expect(watermark(makeSpec())).toEqual([]);
  });

  it("another app's mark in the closing card, an opening line or a scene overlay is blocked", () => {
    expect(watermark(makeSpec({ cta: { onScreen: "Made with CapCut", vo: "Try it." } }))).toHaveLength(1);
    const hooks = makeSpec().hookVariants.map((h, i) => (i === 0 ? { ...h, onScreen: "Follow @tiktok for more" } : h));
    expect(watermark(makeSpec({ hookVariants: hooks }))).toHaveLength(1);
    const base = makeSpec();
    const scenes = base.scenes.map((s, i) => (i === 0 ? { ...s, overlay: { text: "tiktok.com/@syllacal", position: "top" } } : s));
    expect(watermark({ ...base, scenes } as VideoSpec).length).toBeGreaterThan(0);
  });
});
