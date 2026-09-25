// Loads the bundled fonts inside the Remotion bundle (imported from entry.ts only). Remotion's
// bundler turns .woff2 imports into local asset URLs, so nothing is fetched from the network.
import { cancelRender, continueRender, delayRender } from "remotion";
import inter400 from "@fontsource/inter/files/inter-latin-400-normal.woff2";
import inter500 from "@fontsource/inter/files/inter-latin-500-normal.woff2";
import inter600 from "@fontsource/inter/files/inter-latin-600-normal.woff2";
import inter700 from "@fontsource/inter/files/inter-latin-700-normal.woff2";
import inter800 from "@fontsource/inter/files/inter-latin-800-normal.woff2";
import inter900 from "@fontsource/inter/files/inter-latin-900-normal.woff2";
import { BUNDLED_FONT_FAMILY, registerFontLoading } from "./registry.ts";

const FACES: [string, string][] = [
  ["400", inter400],
  ["500", inter500],
  ["600", inter600],
  ["700", inter700],
  ["800", inter800],
  ["900", inter900],
];

if (typeof document !== "undefined" && typeof FontFace !== "undefined") {
  const handle = delayRender("Loading bundled fonts");
  const p = Promise.all(
    FACES.map(async ([weight, url]) => {
      const face = new FontFace(BUNDLED_FONT_FAMILY, `url(${url}) format("woff2")`, { weight, style: "normal" });
      await face.load();
      document.fonts.add(face);
    }),
  ).then(
    () => continueRender(handle),
    // A missing font must fail the render, not silently fall back to a system font.
    (err: unknown) => cancelRender(err instanceof Error ? err : new Error(String(err))),
  );
  registerFontLoading(p.then(() => undefined));
}
