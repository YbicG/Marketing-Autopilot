import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Svix-style webhook signatures, which Resend uses (resend.com/docs "Verify webhook requests",
 * checked 2026-09-27: headers svix-id / svix-timestamp / svix-signature, signature "v1,<base64>").
 * The secret is "whsec_<base64 key>"; the signed content is `${id}.${timestamp}.${rawBody}` and the
 * signature is base64(HMAC-SHA256(key, content)). The header may list several space-separated
 * signatures (key rotation). Timestamps outside ±5 minutes are refused (replay guard). Pure.
 */

export const SVIX_TOLERANCE_MS = 5 * 60_000;

export type SvixResult = { ok: true; id: string; timestamp: number } | { ok: false; reason: "missing_headers" | "bad_timestamp" | "too_old" | "bad_secret" | "bad_signature" };

function header(headers: Record<string, string>, name: string): string | undefined {
  const want = name.toLowerCase();
  for (const [k, v] of Object.entries(headers)) if (k.toLowerCase() === want) return v;
  return undefined;
}

/** The raw HMAC key from "whsec_<base64>" (a bare base64 secret is accepted too). */
export function svixKey(secret: string): Buffer | null {
  const s = secret.trim().replace(/^whsec_/, "");
  if (!s || !/^[A-Za-z0-9+/=_-]+$/.test(s)) return null;
  const key = Buffer.from(s.replace(/-/g, "+").replace(/_/g, "/"), "base64");
  return key.length ? key : null;
}

export function svixSign(secret: string, id: string, timestampSec: number, rawBody: string): string {
  const key = svixKey(secret);
  if (!key) throw new Error("bad webhook secret");
  return `v1,${createHmac("sha256", key).update(`${id}.${timestampSec}.${rawBody}`).digest("base64")}`;
}

export function verifySvix(rawBody: string, headers: Record<string, string>, secret: string, now: Date = new Date()): SvixResult {
  const id = header(headers, "svix-id") ?? header(headers, "webhook-id");
  const ts = header(headers, "svix-timestamp") ?? header(headers, "webhook-timestamp");
  const sigs = header(headers, "svix-signature") ?? header(headers, "webhook-signature");
  if (!id || !ts || !sigs) return { ok: false, reason: "missing_headers" };
  if (!/^\d{1,12}$/.test(ts.trim())) return { ok: false, reason: "bad_timestamp" };
  const timestamp = Number(ts.trim());
  if (Math.abs(now.getTime() - timestamp * 1000) > SVIX_TOLERANCE_MS) return { ok: false, reason: "too_old" };
  const key = svixKey(secret);
  if (!key) return { ok: false, reason: "bad_secret" };
  const expected = createHmac("sha256", key).update(`${id}.${ts.trim()}.${rawBody}`).digest();
  for (const part of sigs.split(" ")) {
    const comma = part.indexOf(",");
    if (comma < 0 || part.slice(0, comma) !== "v1") continue;
    const given = Buffer.from(part.slice(comma + 1), "base64");
    if (given.length === expected.length && timingSafeEqual(given, expected)) return { ok: true, id, timestamp };
  }
  return { ok: false, reason: "bad_signature" };
}
