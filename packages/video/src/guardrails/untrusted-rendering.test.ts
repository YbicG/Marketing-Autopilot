// §8 "Untrusted rendering" (D8): Claude writes JSON, never code, and render props carry asset ids
// only. Any string in a video or swipe-post spec that looks like a link or HTML is refused by the
// schema and again by lintSpec, and the scene library has no raw-HTML sink.
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { CarouselSlide, findUnsafeStrings, VideoSpec } from "@mkt/contracts";
import { ASSETS, makeSpec } from "../spec/fixture.ts";
import { lintSpec, type LintContext } from "../spec/lint.ts";

const ctx: LintContext = { assets: ASSETS, publicClaimRefs: new Set(), verifiedClaimRefs: new Set() };
const codes = (spec: VideoSpec) =>
  lintSpec(spec, ctx)
    .filter((i) => i.severity === "block")
    .map((i) => i.code);

describe("§8 Untrusted rendering", () => {
  it("the sample spec is clean", () => {
    expect(VideoSpec.safeParse(makeSpec()).success).toBe(true);
    expect(codes(makeSpec())).not.toContain("unsafe_string");
  });

  it("links and HTML anywhere in a video spec are found, keys included", () => {
    const bad = { a: "Visit https://evil.example", b: ["<img src=x onerror=alert(1)>"], c: { "javascript:alert(1)": 1 }, d: "see //evil.example/x" };
    expect(findUnsafeStrings(bad).map((h) => `${h.path.join(".")}:${h.reason}`)).toEqual(["a:url", "b.0:html", "c.javascript:alert(1):url", "d:url"]);
    // Bare domains are ordinary prose.
    expect(findUnsafeStrings({ t: "syllacal.com" })).toEqual([]);
  });

  it("the schema refuses a spec with a link or HTML in it", () => {
    expect(VideoSpec.safeParse(makeSpec({ cta: { onScreen: "Go to https://evil.example", vo: "Try it." } })).success).toBe(false);
    expect(VideoSpec.safeParse(makeSpec({ cta: { onScreen: "<script>alert(1)</script>", vo: "Try it." } })).success).toBe(false);
  });

  it("lintSpec blocks it again for specs edited in the UI that skipped the schema", () => {
    expect(codes(makeSpec({ cta: { onScreen: "Go to https://evil.example", vo: "Try it." } }))).toContain("unsafe_string");
    expect(codes(makeSpec({ disclosures: ["<b>ad</b>"] }))).toContain("unsafe_string");
  });

  it("swipe-post slides refuse links and HTML", () => {
    const slide = { template: "hero", headline: "Syllabus to calendar", body: null, assetId: null };
    expect(CarouselSlide.safeParse(slide).success).toBe(true);
    expect(CarouselSlide.safeParse({ ...slide, headline: "https://evil.example" }).success).toBe(false);
    expect(CarouselSlide.safeParse({ ...slide, body: "<img src=x>" }).success).toBe(false);
    expect(CarouselSlide.safeParse({ ...slide, assetId: "https://evil.example/x.png" }).success).toBe(false);
  });

  it("no component in the scene library renders raw HTML", async () => {
    const root = fileURLToPath(new URL("..", import.meta.url));
    const files: string[] = [];
    const walk = async (dir: string) => {
      for (const e of await readdir(dir, { withFileTypes: true })) {
        const p = join(dir, e.name);
        if (e.isDirectory()) await walk(p);
        else if (/\.tsx?$/.test(e.name) && !/\.test\.tsx?$/.test(e.name)) files.push(p);
      }
    };
    await walk(root);
    expect(files.length).toBeGreaterThan(10);
    for (const f of files) expect(await readFile(f, "utf8"), f).not.toMatch(/dangerouslySetInnerHTML|\.innerHTML\s*=/);
  });
});
