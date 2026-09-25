import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Constant-time HMAC-SHA256 check over the raw request body (§5.8 step 4). Accepts the header as
 * "sha256=<hex>", bare hex, or base64/base64url. Any parse problem is simply "not valid".
 * Re-exported by @mkt/core/security for Resend/GitHub webhooks.
 */
export function verifyHmacSha256(rawBody: string | Uint8Array, signatureHeader: string | null | undefined, secret: string): boolean {
  if (!signatureHeader || !secret) return false;
  const expected = createHmac("sha256", secret).update(rawBody).digest();
  let sig = signatureHeader.trim();
  const eq = sig.indexOf("=");
  if (eq > 0 && /^sha256$/i.test(sig.slice(0, eq))) sig = sig.slice(eq + 1).trim();
  for (const given of candidates(sig)) {
    if (given.length === expected.length && timingSafeEqual(given, expected)) return true;
  }
  return false;
}

function candidates(sig: string): Buffer[] {
  const out: Buffer[] = [];
  if (/^[0-9a-f]{64}$/i.test(sig)) out.push(Buffer.from(sig, "hex"));
  if (/^[A-Za-z0-9+/_-]{43}={0,1}$/.test(sig)) out.push(Buffer.from(sig.replace(/-/g, "+").replace(/_/g, "/"), "base64"));
  return out;
}

export function hmacSha256Hex(secret: string, data: string | Uint8Array): string {
  return createHmac("sha256", secret).update(data).digest("hex");
}
