import { useEffect, useState, type CSSProperties } from "react";
import { useDelayRender } from "remotion";
import { fitTextOnNLines } from "@remotion/layout-utils";
import { fontsLoaded, fontsReady } from "../fonts/registry.ts";

type Props = {
  text: string;
  maxWidth: number;
  maxLines?: number;
  maxFontSize: number;
  minFontSize?: number;
  fontFamily: string;
  fontWeight?: number;
  color: string;
  align?: "left" | "center";
  lineHeight?: number;
  style?: CSSProperties;
};

/** Measure only once the bundled fonts are in, or the fit is computed against a fallback font. */
function useFontsLoaded(): boolean {
  const [ready, setReady] = useState(fontsLoaded);
  const { delayRender, continueRender } = useDelayRender();
  const [handle] = useState(() => (fontsLoaded() ? null : delayRender("FitText waiting for fonts")));
  useEffect(() => {
    if (handle === null) return;
    let live = true;
    void fontsReady().then(() => {
      if (live) setReady(true);
      continueRender(handle);
    });
    return () => {
      live = false;
    };
  }, [handle, continueRender]);
  return ready;
}

/** Largest font size that fits `text` in maxLines lines of maxWidth (via @remotion/layout-utils). */
export function FitText({ text, maxWidth, maxLines = 3, maxFontSize, minFontSize = 28, fontFamily, fontWeight = 800, color, align = "center", lineHeight = 1.1, style }: Props) {
  const ready = useFontsLoaded();
  let fontSize = maxFontSize;
  if (ready && typeof document !== "undefined" && text.trim()) {
    try {
      // The measuring helper wants a plain family name.
      const family = fontFamily.split(",")[0]?.replace(/["']/g, "").trim() ?? fontFamily;
      fontSize = fitTextOnNLines({ text, maxLines, maxBoxWidth: maxWidth, fontFamily: family, fontWeight, maxFontSize, validateFontIsLoaded: false }).fontSize;
    } catch {
      fontSize = maxFontSize;
    }
  }
  fontSize = Math.max(minFontSize, Math.min(maxFontSize, Math.floor(fontSize)));
  return (
    <div style={{ width: maxWidth, fontFamily, fontWeight, fontSize, lineHeight, color, textAlign: align, wordBreak: "break-word", opacity: ready ? 1 : 0, ...style }}>
      {text}
    </div>
  );
}
