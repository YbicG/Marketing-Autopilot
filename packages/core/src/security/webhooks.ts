/**
 * Webhook signatures (§3.5, §5.8 step 4): HMAC-SHA256 over the raw body, compared in constant
 * time; "sha256=<hex>", bare hex and base64 are accepted. One implementation, shared with the
 * provider adapters that verify their own webhooks.
 */
export { verifyHmacSha256, hmacSha256Hex } from "@mkt/providers";
