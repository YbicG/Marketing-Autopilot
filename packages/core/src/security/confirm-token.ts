import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

/**
 * Confirm tokens (D10, §9): the UI mints one when it shows a price ("Finalize for $1.20"), and the
 * spending action only runs with a valid token for the same purpose, subject and no higher price.
 * Format: base64url(JSON payload) "." base64url(HMAC-SHA256). Stateless; the ≤10 min expiry and
 * the subject hash (e.g. of the render inputs) stop replay onto something else.
 */

export interface ConfirmClaims {
  purpose: string;
  subjectHash: string;
  estimateMicros: number;
}

export interface ConfirmPayload extends ConfirmClaims {
  expiresAt: number;
  nonce: string;
}

export type ConfirmResult =
  | { ok: true; payload: ConfirmPayload }
  | { ok: false; reason: "malformed" | "bad_signature" | "expired" | "wrong_purpose" | "wrong_subject" | "price_changed" };

export const CONFIRM_TTL_MS = 10 * 60_000;

function key(secret: string): string {
  if (!secret || secret.length < 32) throw new Error("CONFIRM_TOKEN_SECRET must be set (at least 32 characters)");
  return secret;
}

const b64url = (b: Buffer | string) => Buffer.from(b).toString("base64url");
const mac = (secret: string, body: string) => createHmac("sha256", key(secret)).update(`mkt-confirm.v1.${body}`).digest();

export function mintConfirmToken(claims: ConfirmClaims, secret: string, ttlMs = CONFIRM_TTL_MS, now = Date.now()): string {
  if (!Number.isInteger(claims.estimateMicros) || claims.estimateMicros < 0) throw new Error("estimateMicros must be a whole number ≥ 0");
  const payload: ConfirmPayload = { ...claims, expiresAt: now + ttlMs, nonce: randomBytes(9).toString("base64url") };
  const body = b64url(JSON.stringify(payload));
  return `${body}.${b64url(mac(secret, body))}`;
}

/**
 * `expected.estimateMicros` is today's estimate: if it went up since the token was minted, the
 * user has to confirm the new price. A lower estimate is fine.
 */
export function verifyConfirmToken(
  token: string,
  expected: { purpose: string; subjectHash: string; estimateMicros?: number },
  secret: string,
  now = Date.now(),
): ConfirmResult {
  const parts = typeof token === "string" ? token.split(".") : [];
  if (parts.length !== 2 || !parts[0] || !parts[1]) return { ok: false, reason: "malformed" };
  const [body, sig] = parts as [string, string];
  const want = mac(secret, body);
  const given = Buffer.from(sig, "base64url");
  if (given.length !== want.length || !timingSafeEqual(given, want)) return { ok: false, reason: "bad_signature" };
  let payload: ConfirmPayload;
  try {
    payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as ConfirmPayload;
  } catch {
    return { ok: false, reason: "malformed" };
  }
  if (typeof payload.expiresAt !== "number" || now > payload.expiresAt) return { ok: false, reason: "expired" };
  if (payload.purpose !== expected.purpose) return { ok: false, reason: "wrong_purpose" };
  if (payload.subjectHash !== expected.subjectHash) return { ok: false, reason: "wrong_subject" };
  if (expected.estimateMicros !== undefined && expected.estimateMicros > payload.estimateMicros) return { ok: false, reason: "price_changed" };
  return { ok: true, payload };
}
