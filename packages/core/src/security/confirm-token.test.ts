import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { mintConfirmToken, verifyConfirmToken } from "./confirm-token.ts";
import { verifyHmacSha256 } from "./webhooks.ts";

const secret = "x".repeat(40);
const claims = { purpose: "video.finalize", subjectHash: "abc123", estimateMicros: 1_200_000 };
const now = 1_790_000_000_000;

describe("confirm tokens", () => {
  it("verifies within the TTL and not after", () => {
    const t = mintConfirmToken(claims, secret, undefined, now);
    const ok = verifyConfirmToken(t, { purpose: "video.finalize", subjectHash: "abc123", estimateMicros: 1_200_000 }, secret, now + 9 * 60_000);
    expect(ok.ok).toBe(true);
    expect(verifyConfirmToken(t, claims, secret, now + 10 * 60_000 + 1)).toEqual({ ok: false, reason: "expired" });
  });

  it("refuses tampering, another secret, another purpose/subject and a higher price", () => {
    const t = mintConfirmToken(claims, secret, 60_000, now);
    const [body, sig] = t.split(".") as [string, string];
    const forged = Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(body, "base64url").toString()), estimateMicros: 99_000_000 })).toString("base64url");
    expect(verifyConfirmToken(`${forged}.${sig}`, claims, secret, now)).toEqual({ ok: false, reason: "bad_signature" });
    expect(verifyConfirmToken(t, claims, "y".repeat(40), now)).toEqual({ ok: false, reason: "bad_signature" });
    expect(verifyConfirmToken(t, { ...claims, purpose: "ads.activate" }, secret, now)).toEqual({ ok: false, reason: "wrong_purpose" });
    expect(verifyConfirmToken(t, { ...claims, subjectHash: "other" }, secret, now)).toEqual({ ok: false, reason: "wrong_subject" });
    expect(verifyConfirmToken(t, { ...claims, estimateMicros: 1_300_000 }, secret, now)).toEqual({ ok: false, reason: "price_changed" });
    expect(verifyConfirmToken(t, { ...claims, estimateMicros: 1_000_000 }, secret, now).ok).toBe(true);
    expect(verifyConfirmToken("garbage", claims, secret, now)).toEqual({ ok: false, reason: "malformed" });
  });

  it("needs a real secret", () => {
    expect(() => mintConfirmToken(claims, "short")).toThrow(/CONFIRM_TOKEN_SECRET/);
  });
});

describe("webhook HMAC", () => {
  it("accepts sha256=hex, bare hex and base64; rejects a changed body", () => {
    const raw = '{"event":"email.delivered"}';
    const mac = createHmac("sha256", "whsec").update(raw).digest();
    expect(verifyHmacSha256(raw, `sha256=${mac.toString("hex")}`, "whsec")).toBe(true);
    expect(verifyHmacSha256(raw, mac.toString("hex"), "whsec")).toBe(true);
    expect(verifyHmacSha256(raw, mac.toString("base64"), "whsec")).toBe(true);
    expect(verifyHmacSha256(`${raw} `, mac.toString("hex"), "whsec")).toBe(false);
    expect(verifyHmacSha256(raw, mac.toString("hex"), "")).toBe(false);
  });
});
