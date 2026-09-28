import { describe, expect, it } from "vitest";
import { uiSessionFromCookie } from "../publishing/approvals.ts";
import { confirmUrl, decodeConfirmInput, mintToolConfirmToken, verifyToolConfirmToken } from "./confirm.ts";

const SECRET = "test-confirm-secret-at-least-32-characters";
const session = uiSessionFromCookie({ userId: "u", workspaceId: "ws-1", originChecked: true, csrfChecked: true });
const NOW = Date.parse("2026-09-28T12:00:00Z");
const claim = { tool: "run_package", patId: "pat-1", input: { product: "syllacal", tier: "standard" }, estimateMicros: 4_000_000 };
const expected = { workspaceId: "ws-1", patId: "pat-1", tool: "run_package", input: { tier: "standard", product: "syllacal" }, estimateMicros: 4_000_000 };

describe("tool confirm tokens", () => {
  it("verifies for the same workspace, token, tool and input (key order doesn't matter)", () => {
    const t = mintToolConfirmToken(session, claim, SECRET, NOW);
    expect(verifyToolConfirmToken(t, expected, SECRET, NOW + 60_000).ok).toBe(true);
    // A lower price today is fine; a higher one needs a new confirm.
    expect(verifyToolConfirmToken(t, { ...expected, estimateMicros: 3_000_000 }, SECRET, NOW).ok).toBe(true);
    expect(verifyToolConfirmToken(t, { ...expected, estimateMicros: 5_000_000 }, SECRET, NOW)).toEqual({ ok: false, reason: "price_changed" });
  });

  it("expires after 10 minutes", () => {
    const t = mintToolConfirmToken(session, claim, SECRET, NOW);
    expect(verifyToolConfirmToken(t, expected, SECRET, NOW + 10 * 60_000).ok).toBe(true);
    expect(verifyToolConfirmToken(t, expected, SECRET, NOW + 10 * 60_000 + 1)).toEqual({ ok: false, reason: "expired" });
  });

  it("can't be moved to other input, another token, another workspace or another tool", () => {
    const t = mintToolConfirmToken(session, claim, SECRET, NOW);
    expect(verifyToolConfirmToken(t, { ...expected, input: { product: "syllacal", tier: "premium" } }, SECRET, NOW)).toEqual({ ok: false, reason: "wrong_subject" });
    expect(verifyToolConfirmToken(t, { ...expected, patId: "pat-2" }, SECRET, NOW)).toEqual({ ok: false, reason: "wrong_subject" });
    expect(verifyToolConfirmToken(t, { ...expected, workspaceId: "ws-2" }, SECRET, NOW)).toEqual({ ok: false, reason: "wrong_subject" });
    expect(verifyToolConfirmToken(t, { ...expected, tool: "estimate_package" }, SECRET, NOW)).toEqual({ ok: false, reason: "wrong_purpose" });
  });

  it("a tampered token or another secret fails the signature", () => {
    const t = mintToolConfirmToken(session, claim, SECRET, NOW);
    const [body, sig] = t.split(".") as [string, string];
    const payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
    const cheaper = Buffer.from(JSON.stringify({ ...payload, estimateMicros: 99_000_000 })).toString("base64url");
    expect(verifyToolConfirmToken(`${cheaper}.${sig}`, expected, SECRET, NOW)).toEqual({ ok: false, reason: "bad_signature" });
    expect(verifyToolConfirmToken(t, expected, `${SECRET}-other`, NOW)).toEqual({ ok: false, reason: "bad_signature" });
    expect(verifyToolConfirmToken("nope", expected, SECRET, NOW)).toEqual({ ok: false, reason: "malformed" });
  });

  it("the confirm link carries the tool, token and input, and decodes back", () => {
    const u = new URL(confirmUrl("https://mkt.example.com", "run_package", "pat-1", claim.input));
    expect(u.pathname).toBe("/confirm");
    expect(u.searchParams.get("tool")).toBe("run_package");
    expect(u.searchParams.get("pat")).toBe("pat-1");
    expect(decodeConfirmInput(u.searchParams.get("input"))).toEqual({ product: "syllacal", tier: "standard" });
    expect(decodeConfirmInput("!!")).toBeNull();
  });
});
