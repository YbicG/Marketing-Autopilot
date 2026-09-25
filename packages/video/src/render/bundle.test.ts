import { describe, expect, it } from "vitest";
import { isBundleSource, sourceHash } from "./bundle.ts";
import { adRenderProps } from "./render.ts";
import { SAMPLE_AD_PROPS } from "../compositions/defaults.ts";
import { makeSpec } from "../spec/fixture.ts";

describe("bundle cache key", () => {
  it("is stable under file order and changes with content or path", () => {
    const a = sourceHash([
      { path: "a.ts", content: "1" },
      { path: "b.ts", content: "2" },
    ]);
    expect(sourceHash([{ path: "b.ts", content: "2" }, { path: "a.ts", content: "1" }])).toBe(a);
    expect(sourceHash([{ path: "a.ts", content: "1" }, { path: "b.ts", content: "3" }])).not.toBe(a);
    expect(sourceHash([{ path: "a.ts", content: "1" }, { path: "c.ts", content: "2" }])).not.toBe(a);
    // Boundaries matter: "ab"+"c" isn't "a"+"bc".
    expect(sourceHash([{ path: "x", content: "ab" }, { path: "y", content: "c" }])).not.toBe(sourceHash([{ path: "x", content: "a" }, { path: "y", content: "bc" }]));
  });
  it("leaves the renderer and tests out", () => {
    expect(isBundleSource("scenes/index.tsx")).toBe(true);
    expect(isBundleSource("render/render.ts")).toBe(false);
    expect(isBundleSource("spec/lint.test.ts")).toBe(false);
  });
});

describe("adRenderProps", () => {
  it("re-validates the spec and turns editor flags off", () => {
    const spec = makeSpec();
    const p = adRenderProps({ spec, hookIdx: 2, format: "9x16", props: { ...SAMPLE_AD_PROPS, showSafeZones: "meta" } });
    expect(p.hookIdx).toBe(2);
    expect(p.showSafeZones).toBeNull();
    expect(p.spec.scenes).toHaveLength(2);
  });
  it("rejects URLs, a mismatched format and a missing opening line", () => {
    const spec = makeSpec();
    expect(() => adRenderProps({ spec: { ...spec, cta: { onScreen: "https://x", vo: "" } }, hookIdx: 0, format: "9x16", props: SAMPLE_AD_PROPS })).toThrow();
    expect(() => adRenderProps({ spec, hookIdx: 0, format: "1x1", props: SAMPLE_AD_PROPS })).toThrow();
    expect(() => adRenderProps({ spec, hookIdx: 3, format: "9x16", props: SAMPLE_AD_PROPS })).toThrow();
  });
});
