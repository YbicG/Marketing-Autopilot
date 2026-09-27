// §8 "Licenses": every font, music track, sound effect and device frame used in a render has a
// license on file. Fonts: only bundled, licensed fonts render. Music: see the GAP below, and
// packages/core/src/guardrails/licenses.test.ts for generated tracks.
import { describe, expect, it } from "vitest";
import { ASSETS, IDS, makeSpec } from "../spec/fixture.ts";
import { BUNDLED_FONTS, FONT_LICENSES, fontStack, isBundledFont } from "../fonts/registry.ts";
import { lintSpec, type LintContext } from "../spec/lint.ts";

const ctx: LintContext = { assets: ASSETS, publicClaimRefs: new Set(), verifiedClaimRefs: new Set() };

describe("§8 Licenses", () => {
  it("every bundled font has a license on file", () => {
    for (const f of BUNDLED_FONTS) expect(FONT_LICENSES[f]).toBeDefined();
    expect(FONT_LICENSES.Inter).toEqual({ license: "OFL-1.1", source: "@fontsource/inter" });
  });

  it("a font that isn't bundled is never used: it falls back to Inter, with a warning", () => {
    expect(isBundledFont("Comic Sans MS")).toBe(false);
    expect(fontStack("Comic Sans MS")).toBe('"Inter", sans-serif');
    expect(fontStack("inter")).toBe('"Inter", sans-serif');
    const issues = lintSpec(makeSpec({ brand: { ...makeSpec().brand, font: "Comic Sans MS" } }), ctx);
    expect(issues.find((i) => i.code === "font_not_bundled")?.severity).toBe("warn");
  });

  // GAP: lintSpec only checks that the music track exists and is audio (packages/video/src/spec/lint.ts:89);
  // LintAsset has no license field (lint.ts:7), and core uses spec.music.trackAssetId as-is
  // (packages/core/src/video/audio.ts:262). Fix: add licenseRef to LintAsset and block a track without one.
  it.fails("GAP: a music track with no license on file is blocked", () => {
    const unlicensed: LintContext = { ...ctx, assets: { ...ASSETS, [IDS.music]: { kind: "audio", durationMs: 60_000 } } };
    const issues = lintSpec(makeSpec(), unlicensed);
    expect(issues.some((i) => i.severity === "block" && /music|license/i.test(`${i.code} ${i.message}`))).toBe(true);
  });

  it.todo("device frames carry a license — the DeviceMockup frame is drawn in code today (no third-party frame art bundled)");
});
