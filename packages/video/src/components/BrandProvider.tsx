import { createContext, useContext, useMemo, type ReactNode } from "react";
import type { BrandSpec } from "@mkt/contracts";
import { DEFAULT_BRAND, deriveBrandTokens, type BrandTokens } from "../brand/color.ts";

const BrandContext = createContext<BrandTokens>(deriveBrandTokens(DEFAULT_BRAND));

export function BrandProvider({ brand, children }: { brand: BrandSpec; children: ReactNode }) {
  const tokens = useMemo(() => deriveBrandTokens(brand), [brand]);
  return <BrandContext.Provider value={tokens}>{children}</BrandContext.Provider>;
}

export const useBrand = () => useContext(BrandContext);
