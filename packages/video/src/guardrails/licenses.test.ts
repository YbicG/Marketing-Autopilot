// §8 "Licenses": every font, music track, sound effect and device frame used in a render has a
// license on file. Fonts: only bundled, licensed fonts render. Music: a chosen track needs a
// licenseRef (lint blocks it here; prepareAudio refuses it in core, see
// packages/core/src/guardrails/licenses.test.ts, which also covers generated tracks).
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

  it("a music track with no license on file is blocked", () => {
    const unlicensed: LintContext = { ...ctx, assets: { ...ASSETS, [IDS.music]: { kind: "audio", durationMs: 60_000 } } };
    const issues = lintSpec(makeSpec(), unlicensed);
    expect(issues.find((i) => i.code === "music_unlicensed")?.severity).toBe("block");
    expect(lintSpec(makeSpec(), ctx).some((i) => i.code === "music_unlicensed")).toBe(false);
  });

  it.todo("device frames carry a license — the DeviceMockup frame is drawn in code today (no third-party frame art bundled)");
});
