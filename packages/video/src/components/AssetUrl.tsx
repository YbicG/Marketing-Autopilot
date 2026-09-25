import { createContext, useContext } from "react";
import { staticFile } from "remotion";

// D8: props carry asset ids only. In renders the worker stages each file at public/a/<assetId>;
// the web player swaps in a resolver to /api/media/<assetId> through this context.

export type AssetUrlResolver = (assetId: string) => string;

const SAFE_ID = /^[A-Za-z0-9_-]{1,64}$/;

export const staticAssetUrl: AssetUrlResolver = (assetId) => {
  if (!SAFE_ID.test(assetId)) throw new Error(`Not an asset id: ${assetId}`);
  return staticFile(`a/${assetId}`);
};

export const AssetUrlContext = createContext<AssetUrlResolver>(staticAssetUrl);

export function useAssetUrl(assetId: string): string;
export function useAssetUrl(assetId: string | null | undefined): string | null;
export function useAssetUrl(assetId: string | null | undefined): string | null {
  const resolve = useContext(AssetUrlContext);
  return assetId ? resolve(assetId) : null;
}

/** For components that need several ids at once. */
export const useAssetUrlResolver = () => useContext(AssetUrlContext);
