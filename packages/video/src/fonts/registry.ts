// Browser-safe font registry. The font files themselves are imported only by ./load.ts, which the
// Remotion entry pulls in, so the web app never has to handle .woff2 imports (it loads Inter itself).

/** Inter (SIL OFL 1.1, @fontsource/inter). Renders use only bundled fonts, so output is deterministic. */
export const BUNDLED_FONT_FAMILY = "Inter";
export const BUNDLED_FONTS = [BUNDLED_FONT_FAMILY] as const;
export const FONT_LICENSES: Record<string, { license: string; source: string }> = {
  Inter: { license: "OFL-1.1", source: "@fontsource/inter" },
};

export const isBundledFont = (name: string) => BUNDLED_FONTS.some((f) => f.toLowerCase() === name.trim().toLowerCase());

/** CSS font stack for a brand font. Unbundled names fall back to Inter rather than a system font. */
export function fontStack(name: string): string {
  const family = isBundledFont(name) ? (BUNDLED_FONTS.find((f) => f.toLowerCase() === name.trim().toLowerCase()) ?? BUNDLED_FONT_FAMILY) : BUNDLED_FONT_FAMILY;
  return `"${family}", sans-serif`;
}

let loading: Promise<void> = Promise.resolve();
let loaded = true;

/** Called by ./load.ts at bundle start. */
export function registerFontLoading(p: Promise<void>): void {
  loaded = false;
  loading = p.then(() => {
    loaded = true;
  });
}

/** Synchronous check, so components skip delayRender once fonts are in. */
export const fontsLoaded = (): boolean => loaded;

/** Resolves when bundled fonts are ready (immediately outside the Remotion bundle). */
export const fontsReady = (): Promise<void> => loading;
