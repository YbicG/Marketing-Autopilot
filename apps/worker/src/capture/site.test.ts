import { describe, expect, it } from "vitest";
import {
  brandColors,
  cssColorToHex,
  githubRepoFromLinks,
  isGray,
  isLikelyHtmlUrl,
  normalizeUrl,
  parseFontFamilies,
  parseSitemap,
  pngSize,
  rankPaths,
} from "./site.ts";

describe("normalizeUrl", () => {
  it("strips hash, tracking params and trailing slash", () => {
    expect(normalizeUrl("https://Example.com/pricing/?utm_source=x&plan=pro&gclid=1#top")).toBe(
      "https://example.com/pricing?plan=pro",
    );
    expect(normalizeUrl("https://example.com/?utm_medium=a")).toBe("https://example.com/");
    expect(normalizeUrl("/about/", "https://example.com/x")).toBe("https://example.com/about");
  });
  it("rejects non-http links", () => {
    expect(normalizeUrl("mailto:a@b.com")).toBeNull();
    expect(normalizeUrl("javascript:void(0)")).toBeNull();
    expect(normalizeUrl("::nope")).toBeNull();
  });
});

describe("isLikelyHtmlUrl", () => {
  it("skips files", () => {
    expect(isLikelyHtmlUrl("https://x.com/docs")).toBe(true);
    expect(isLikelyHtmlUrl("https://x.com/index.html")).toBe(true);
    expect(isLikelyHtmlUrl("https://x.com/brochure.pdf")).toBe(false);
    expect(isLikelyHtmlUrl("https://x.com/app.dmg")).toBe(false);
    expect(isLikelyHtmlUrl("https://x.com/img/hero.webp")).toBe(false);
  });
});

describe("rankPaths", () => {
  const origin = "https://www.example.com";
  it("orders home, product pages, others, then blog/legal/auth", () => {
    const ranked = rankPaths(
      [
        "https://www.example.com/blog/launch",
        "https://www.example.com/privacy",
        "https://www.example.com/customers",
        "https://example.com/pricing/",
        "https://www.example.com/features",
        "https://www.example.com/",
        "https://www.example.com/login",
        "https://www.example.com/docs/getting-started",
        "https://www.example.com/about",
      ],
      origin,
    ).map((r) => new URL(r.url).pathname);
    expect(ranked).toEqual([
      "/",
      "/pricing",
      "/features",
      "/about",
      "/docs/getting-started",
      "/customers",
      "/login",
      "/privacy",
      "/blog/launch",
    ]);
  });
  it("gives home rank 0 and dedupes variants onto the site origin", () => {
    const ranked = rankPaths(
      ["http://example.com/pricing", "https://www.example.com/pricing/#x", "https://www.example.com/pricing?utm_source=t", "https://www.example.com"],
      origin,
    );
    expect(ranked).toEqual([
      { url: "https://www.example.com/", rank: 0 },
      { url: "https://www.example.com/pricing", rank: 10 },
    ]);
  });
  it("drops other sites and files, and sees through locale prefixes", () => {
    const ranked = rankPaths(
      ["https://other.com/pricing", "https://www.example.com/whitepaper.pdf", "https://www.example.com/de/pricing", "https://cdn.example.com/x"],
      origin,
    );
    expect(ranked).toEqual([{ url: "https://www.example.com/de/pricing", rank: 10 }]);
  });
});

describe("parseSitemap", () => {
  it("reads urlsets and indexes", () => {
    expect(
      parseSitemap(`<?xml version="1.0"?><urlset><url><loc>https://a.com/</loc></url><url><loc> https://a.com/p?x=1&amp;y=2 </loc></url></urlset>`),
    ).toEqual({ urls: ["https://a.com/", "https://a.com/p?x=1&y=2"], sitemaps: [] });
    expect(parseSitemap(`<sitemapindex><sitemap><loc><![CDATA[https://a.com/pages.xml]]></loc></sitemap></sitemapindex>`)).toEqual({
      urls: [],
      sitemaps: ["https://a.com/pages.xml"],
    });
  });
});

describe("colors", () => {
  it("converts css colors to hex", () => {
    expect(cssColorToHex("rgb(255, 99, 71)")).toBe("#ff6347");
    expect(cssColorToHex("rgba(0, 0, 255, 0.90)")).toBe("#0000ff");
    expect(cssColorToHex("rgb(10 20 30 / 80%)")).toBe("#0a141e");
    expect(cssColorToHex("#AbC")).toBe("#aabbcc");
    expect(cssColorToHex("rgba(0, 0, 0, 0)")).toBeNull();
    expect(cssColorToHex("#ff000010")).toBeNull();
    expect(cssColorToHex("transparent")).toBeNull();
  });
  it("detects grays", () => {
    expect(isGray("#ffffff")).toBe(true);
    expect(isGray("#1f2937")).toBe(true);
    expect(isGray("#0f172a")).toBe(false);
    expect(isGray("#6366f1")).toBe(false);
  });
  it("ranks non-gray colors, buttons weighted up", () => {
    const colors = brandColors({
      background: [
        ["rgba(255, 255, 255, 1)", 5000],
        ["rgba(224, 231, 255, 1)", 900],
        ["rgba(99, 102, 241, 1)", 100],
      ],
      text: [
        ["rgba(17, 24, 39, 1)", 4000],
        ["rgba(79, 70, 229, 1)", 50],
      ],
      button: [
        ["rgba(79, 70, 229, 1)", 1],
        ["rgba(79, 70, 229, 1)", 1],
        ["rgba(0, 0, 0, 0)", 1],
      ],
    });
    expect(colors[0]).toBe("#4f46e5");
    expect(colors).toContain("#e0e7ff");
    expect(colors).not.toContain("#ffffff");
    expect(colors).not.toContain("#111827");
  });
});

describe("parseFontFamilies", () => {
  it("takes the first real family of each stack", () => {
    expect(
      parseFontFamilies([
        `"__Inter_d65c78", "__Inter_Fallback_d65c78", system-ui, sans-serif`,
        `"Cal Sans", Inter, sans-serif`,
        `-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif`,
        `Inter, sans-serif`,
        `system-ui, sans-serif`,
      ]),
    ).toEqual(["Inter", "Cal Sans", "Segoe UI"]);
  });
});

describe("githubRepoFromLinks", () => {
  it("picks the most-linked repo and ignores github's own pages", () => {
    expect(
      githubRepoFromLinks([
        "https://github.com/sponsors/someone",
        "https://github.com/acme/widget/issues",
        "https://github.com/acme/other",
        "https://www.github.com/acme/widget.git",
        "https://github.com/acme",
      ]),
    ).toBe("https://github.com/acme/widget");
    expect(githubRepoFromLinks(["https://gitlab.com/a/b"])).toBeNull();
  });
});

describe("pngSize", () => {
  it("reads IHDR", () => {
    const png = new Uint8Array(33);
    png.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);
    const view = new DataView(png.buffer);
    view.setUint32(16, 2880);
    view.setUint32(20, 7800);
    expect(pngSize(png)).toEqual({ width: 2880, height: 7800 });
    expect(() => pngSize(new Uint8Array(30))).toThrow();
  });
});
