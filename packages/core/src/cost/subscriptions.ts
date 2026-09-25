import { ELEVENLABS_SECRET, SECRET_API_KEY, SECRET_WEBHOOK } from "@mkt/providers";
import type { Db } from "@mkt/db";
import { listSecrets } from "../security/vault.ts";
import { USD } from "./pricing.ts";

/**
 * §2.1 principle 1: the capability ladder. Each service is added just in time from a card that says
 * what it unlocks and what it costs a month; a missing key is never an error, only a fallback.
 * Prices are the §13 setup-checklist ranges.
 */

export interface CapabilitySecret {
  purpose: string;
  label: string;
  /** D19 env fallback name, when the service may also be configured in Dokploy. */
  envName?: string;
}

export interface Capability {
  id: string;
  name: string;
  /** Monthly subscription range in micros; null = pay per use or free. */
  monthly: { lowMicros: number; highMicros: number } | null;
  priceLabel: string;
  unlocks: string;
  without: string;
  secrets: CapabilitySecret[];
  /** true: any one secret is enough (Exa or Brave). */
  anyOf?: boolean;
  optional?: boolean;
  signupUrl: string;
}

/** D19 env name for a vault purpose: "upload_post.api_key" → "UPLOAD_POST_API_KEY" (same rule as the worker). */
export function purposeEnvName(purpose: string): string {
  return purpose.toUpperCase().replace(/[^A-Z0-9]+/g, "_");
}

const sec = (purpose: string, label: string, env = true): CapabilitySecret => ({
  purpose,
  label,
  ...(env ? { envName: purposeEnvName(purpose) } : {}),
});

export const GITHUB_TOKEN_SECRET = "github.token";
export const EXA_SECRET = "exa.api_key";
export const BRAVE_SECRET = "brave.api_key";

/** Demo test login for capture (D26), stored as JSON { username, password, loginPath? }. Vault only. */
export const captureLoginPurpose = (productId: string) => `capture.login.${productId}`;
export const CAPTURE_LOGIN_RE = /^capture\.login\.([0-9a-f-]{36})$/;

export const CAPABILITIES: Capability[] = [
  {
    id: "upload_post",
    name: "Upload-Post",
    monthly: { lowMicros: 16 * USD, highMicros: 24 * USD },
    priceLabel: "$16–24/mo",
    unlocks: "Automatic posting to TikTok, Instagram, YouTube, Threads, X, LinkedIn and Bluesky at the times you approve.",
    without: "You post yourself: download the ready files and copy the caption.",
    secrets: [sec(SECRET_API_KEY, "API key"), sec(SECRET_WEBHOOK, "Webhook secret")],
    signupUrl: "https://www.upload-post.com/",
  },
  {
    id: "elevenlabs",
    name: "ElevenLabs",
    monthly: { lowMicros: 6 * USD, highMicros: 22 * USD },
    priceLabel: "$6–22/mo",
    unlocks: "Voiceovers and music made for each video.",
    without: "Videos use on-screen captions only, with a bundled music track.",
    secrets: [sec(ELEVENLABS_SECRET, "API key")],
    signupUrl: "https://elevenlabs.io/",
  },
  {
    id: "research",
    name: "Exa or Brave search",
    monthly: null,
    priceLabel: "pay per use",
    unlocks: "Extra web research when reading your product and similar ones.",
    without: "Research uses Claude's own web search only.",
    secrets: [sec(EXA_SECRET, "Exa API key"), sec(BRAVE_SECRET, "Brave API key")],
    anyOf: true,
    optional: true,
    signupUrl: "https://exa.ai/",
  },
  {
    id: "github",
    name: "GitHub read token",
    monthly: null,
    priceLabel: "free",
    unlocks: "More GitHub requests per hour when reading your repo (a fine-grained, read-only token).",
    without: "Public repos still work at GitHub's lower limit.",
    secrets: [sec(GITHUB_TOKEN_SECRET, "Fine-grained read token")],
    optional: true,
    signupUrl: "https://github.com/settings/personal-access-tokens/new",
  },
];

export const KNOWN_PURPOSES: ReadonlyMap<string, { capability: Capability; secret: CapabilitySecret }> = new Map(
  CAPABILITIES.flatMap((capability) => capability.secrets.map((secret) => [secret.purpose, { capability, secret }] as const)),
);

export function isConnected(c: Capability, configured: ReadonlySet<string>): boolean {
  const has = c.secrets.map((s) => configured.has(s.purpose));
  return c.anyOf ? has.some(Boolean) : has.every(Boolean);
}

export interface SubscriptionSummary {
  connected: Capability[];
  lowMicros: number;
  highMicros: number;
}

/** The "Subscriptions: $X/mo" line: connected services with a monthly plan. */
export function subscriptionSummary(configured: ReadonlySet<string>): SubscriptionSummary {
  const connected = CAPABILITIES.filter((c) => c.monthly && isConnected(c, configured));
  return {
    connected,
    lowMicros: connected.reduce((n, c) => n + (c.monthly?.lowMicros ?? 0), 0),
    highMicros: connected.reduce((n, c) => n + (c.monthly?.highMicros ?? 0), 0),
  };
}

/** "$0/mo", "$16/mo", "$22–46/mo". */
export function formatMonthlyRange(s: Pick<SubscriptionSummary, "lowMicros" | "highMicros">): string {
  const d = (m: number) => `${Math.round(m / USD)}`;
  return s.lowMicros === s.highMicros ? `$${d(s.lowMicros)}/mo` : `$${d(s.lowMicros)}–${d(s.highMicros)}/mo`;
}

/**
 * Purposes that resolve to something: in the vault, or (for known purposes) the env fallback is
 * set. Only presence is checked; no value is read or decrypted.
 */
export async function configuredPurposes(db: Db, workspaceId: string, env: NodeJS.ProcessEnv = process.env): Promise<Set<string>> {
  const out = new Set((await listSecrets(db, workspaceId)).map((s) => s.purpose));
  for (const [purpose, { secret }] of KNOWN_PURPOSES) if (secret.envName && env[secret.envName]) out.add(purpose);
  return out;
}
