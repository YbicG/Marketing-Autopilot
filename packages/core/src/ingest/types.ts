import type Anthropic from "@anthropic-ai/sdk";
import type { RunEvent } from "@mkt/contracts";
import type { Db } from "@mkt/db";
import type { RateLookup } from "../ai/usage.ts";
import type { Storage } from "../media/storage.ts";

// ── Website capture: the worker's Playwright pool fills this in (apps/worker/src/capture/site.ts). ──

export interface CapturedPage {
  url: string;
  title: string;
  /** DOM → markdown of the main content; scripts, nav chrome and cookie text removed. */
  markdown: string;
  /** Lower is more important (home 0, pricing/features next, blog last). */
  rank: number;
}

export interface CapturedScreenshot {
  pageUrl: string;
  viewport: "desktop" | "mobile";
  /** PNG bytes, DPR 2, full page (pixel height capped at 7800). */
  png: Uint8Array;
  /** JPEG of the first viewport at DPR 1, for vision labeling (full pages can exceed the image limits). */
  preview: Uint8Array;
  width: number;
  height: number;
}

export interface BrandTokens {
  /** Hex colors, most used first. */
  colors: string[];
  fonts: string[];
  logoUrl: string | null;
  themeColor: string | null;
}

export interface SiteCapture {
  finalUrl: string;
  pages: CapturedPage[];
  screenshots: CapturedScreenshot[];
  brand: BrandTokens;
  /** package.json-style homepage links etc. are not here; only what the site says about itself. */
  meta: { description: string | null; ogImage: string | null; githubUrl: string | null };
}

export type CaptureSite = (url: string) => Promise<SiteCapture>;

/** Fetches a public URL as text through safe-fetch (and Smokescreen in production). */
export type FetchText = (
  url: string,
  init?: { headers?: Record<string, string>; timeoutMs?: number; maxBytes?: number },
) => Promise<{ url: string; status: number; contentType: string; text: string }>;

export interface IngestDeps {
  db: Db;
  rates: RateLookup;
  storage: Storage;
  publish: (event: RunEvent) => Promise<unknown>;
  captureSite: CaptureSite;
  fetchText: FetchText;
  client?: Anthropic;
  /** Optional GITHUB_TOKEN for a higher REST rate limit; public repos work without it. */
  githubToken?: string;
  /** How long synthesis waits for gap answers that are still open (ms). Default 45 s. */
  answerWaitMs?: number;
  now?: () => Date;
}
