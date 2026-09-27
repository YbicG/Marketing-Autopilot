import { describe, expect, it } from "vitest";
import type { ProviderCtx } from "../core/types.ts";
import { WebhookSignatureError } from "../publish/upload-post.ts";
import { fakeResend } from "./fake.ts";
import { createResend, normalizeResendEvent, parseResendWebhook, ResendKeyMissing } from "./resend.ts";
import { svixSign, verifySvix } from "./svix.ts";

const ctx: ProviderCtx = { secret: async (p) => (p === "resend.api_key" ? "re_test_key" : null) };

describe("svix signatures", () => {
  // The published Svix example (the same signature appears in Resend's verify-webhooks page).
  const secret = "whsec_MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw";
  const body = '{"test": 2432232314}';
  const headers = { "svix-id": "msg_p5jXN8AQM9LWM0D4loKWxJek", "svix-timestamp": "1614265330", "svix-signature": "v1,g0hM9SsE+OTPJTGt/tmIKtSyZlE3uFJELVlNIOLJ1OE=" };
  const at = new Date(1614265330 * 1000 + 60_000);

  it("accepts the known vector", () => {
    expect(verifySvix(body, headers, secret, at)).toEqual({ ok: true, id: "msg_p5jXN8AQM9LWM0D4loKWxJek", timestamp: 1614265330 });
    expect(svixSign(secret, "msg_p5jXN8AQM9LWM0D4loKWxJek", 1614265330, body)).toBe(headers["svix-signature"]);
  });

  it("accepts any of several signatures and mixed-case header names", () => {
    const h = { "Svix-Id": headers["svix-id"], "SVIX-TIMESTAMP": headers["svix-timestamp"], "svix-signature": `v1,AAAA v1a,xyz ${headers["svix-signature"]}` };
    expect(verifySvix(body, h, secret, at).ok).toBe(true);
  });

  it("refuses a changed body, wrong secret, old timestamp, missing headers", () => {
    expect(verifySvix(body + " ", headers, secret, at)).toEqual({ ok: false, reason: "bad_signature" });
    expect(verifySvix(body, headers, "whsec_" + Buffer.from("other").toString("base64"), at)).toEqual({ ok: false, reason: "bad_signature" });
    expect(verifySvix(body, headers, secret, new Date(1614265330 * 1000 + 6 * 60_000))).toEqual({ ok: false, reason: "too_old" });
    expect(verifySvix(body, headers, secret, new Date(1614265330 * 1000 - 6 * 60_000))).toEqual({ ok: false, reason: "too_old" });
    expect(verifySvix(body, { "svix-id": "x" }, secret, at)).toEqual({ ok: false, reason: "missing_headers" });
    expect(verifySvix(body, { ...headers, "svix-timestamp": "abc" }, secret, at)).toEqual({ ok: false, reason: "bad_timestamp" });
    expect(verifySvix(body, headers, "whsec_", at)).toEqual({ ok: false, reason: "bad_secret" });
  });

  it("a vector computed for a Resend delivered event", () => {
    const raw = JSON.stringify({ type: "email.delivered", created_at: "2026-12-01T10:00:00.000Z", data: { email_id: "em_1", broadcast_id: "bc_1", to: ["a@example.com"] } });
    const h = { "svix-id": "msg_2Kx", "svix-timestamp": "1764583200", "svix-signature": "v1,3gSUccFN72TB6yez08lrGgqqu26JF0y2S/9wAdCLewE=" };
    const e = parseResendWebhook(raw, h, secret, new Date(1764583200 * 1000));
    expect(e).toMatchObject({ eventId: "msg_2Kx", type: "email.delivered", broadcastId: "bc_1", emailId: "em_1", to: ["a@example.com"] });
    expect(() => parseResendWebhook(raw.replace("bc_1", "bc_2"), h, secret, new Date(1764583200 * 1000))).toThrow(WebhookSignatureError);
  });
});

describe("normalizeResendEvent", () => {
  it("maps bounce, complaint and contact updates, keeping the raw type", () => {
    expect(normalizeResendEvent("e1", { type: "email.bounced", data: { email_id: "m", to: ["x@y.com"], broadcast_id: "b", bounce: { type: "Permanent", subType: "General" } } })).toMatchObject({
      type: "email.bounced",
      bounceType: "Permanent",
      to: ["x@y.com"],
    });
    expect(normalizeResendEvent("e2", { type: "email.complained", data: { to: "x@y.com" } }).to).toEqual(["x@y.com"]);
    expect(normalizeResendEvent("e3", { type: "contact.updated", data: { id: "c1", email: "x@y.com", unsubscribed: true, segment_ids: ["s1"] } })).toMatchObject({
      type: "contact.unsubscribed",
      rawType: "contact.updated",
      contactEmail: "x@y.com",
      audienceIds: ["s1"],
    });
    expect(normalizeResendEvent("e4", { type: "contact.updated", data: { id: "c1", email: "x@y.com", unsubscribed: false } }).type).toBe("contact.updated");
    expect(normalizeResendEvent("e5", { type: "domain.updated", data: {} })).toMatchObject({ type: "ignored", rawType: "domain.updated" });
  });
});

describe("resend client", () => {
  it("creates, schedules, reads and deletes a broadcast", async () => {
    const fake = fakeResend();
    const r = createResend({ fetch: fake.fetch });
    const { id } = await r.createBroadcast(ctx, { audienceId: "seg_buyers", from: "SyllaCal <hi@syllacal.com>", replyTo: "cj@syllacal.com", subject: "New semester", html: "<p>x</p>", text: "x", name: "Jan" });
    expect(fake.calls[0]).toMatchObject({ method: "POST", path: "/broadcasts", body: { segment_id: "seg_buyers", reply_to: "cj@syllacal.com" } });
    await r.sendBroadcast(ctx, id, { scheduledAt: new Date("2027-01-06T15:00:00Z") });
    expect(fake.calls[1]!.body).toEqual({ scheduled_at: "2027-01-06T15:00:00.000Z" });
    expect(await r.getBroadcast(ctx, id)).toMatchObject({ id, status: "scheduled", scheduledAt: "2027-01-06T15:00:00.000Z", name: "Jan" });
    expect(await r.deleteBroadcast(ctx, id)).toEqual({ deleted: true });
    expect(await r.getBroadcast(ctx, id)).toBeNull();
    expect(await r.deleteBroadcast(ctx, id)).toMatchObject({ deleted: false, reason: "not_found" });
  });

  it("won't delete a sent broadcast", async () => {
    const fake = fakeResend();
    const r = createResend({ fetch: fake.fetch });
    const { id } = await r.createBroadcast(ctx, { audienceId: "seg_buyers", from: "a <a@b.co>", subject: "s", html: "h", text: "t", name: "n" });
    fake.broadcasts.get(id)!.status = "sent";
    expect(await r.deleteBroadcast(ctx, id)).toMatchObject({ deleted: false, reason: "not_deletable" });
  });

  it("pages contacts and unsubscribes one", async () => {
    const fake = fakeResend({ pageSize: 2 });
    fake.addContacts("seg_buyers", ["a@x.com", "b@x.com", "c@x.com"]);
    const r = createResend({ fetch: fake.fetch });
    const p1 = await r.listContacts(ctx, "seg_buyers");
    expect(p1.contacts.map((c) => c.email)).toEqual(["a@x.com", "b@x.com"]);
    expect(p1.hasMore).toBe(true);
    const p2 = await r.listContacts(ctx, "seg_buyers", { after: p1.next });
    expect(p2).toMatchObject({ hasMore: false, next: null });
    expect(p2.contacts.map((c) => c.email)).toEqual(["c@x.com"]);
    await r.updateContact(ctx, p2.contacts[0]!.id, { unsubscribed: true });
    expect(fake.contacts[2]!.unsubscribed).toBe(true);
  });

  it("lists segments", async () => {
    const r = createResend({ fetch: fakeResend().fetch });
    expect(await r.listAudiences(ctx)).toEqual([{ id: "seg_buyers", name: "Past buyers", kind: "segment" }]);
  });

  it("retries a 429 and says plainly when the key is missing or wrong", async () => {
    const fake = fakeResend();
    let n = 0;
    fake.intercept = () => (n++ === 0 ? new Response("{}", { status: 429, headers: { "retry-after": "1" } }) : undefined);
    const waits: number[] = [];
    const r = createResend({ fetch: fake.fetch, sleep: async (ms) => void waits.push(ms) });
    expect(await r.listAudiences(ctx)).toHaveLength(1);
    expect(waits).toEqual([1000]);
    await expect(r.listAudiences({ secret: async () => null })).rejects.toBeInstanceOf(ResendKeyMissing);
    await expect(createResend({ fetch: fakeResend().fetch }).getBroadcast({ secret: async () => "bad" }, "x")).rejects.toThrow(/API key/);
  });
});
