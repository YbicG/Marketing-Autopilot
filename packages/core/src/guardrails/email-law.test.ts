// §8 "Email law" (CAN-SPAM / GDPR, §5.4): sender identity, postal address, consent source,
// unsubscribe link, truthful subjects, suppression list checked before every send, and the
// 0.3% spam-rate stop. EU consent is a warning, not a block (DECISIONS.md:146).
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type Db } from "@mkt/db";
import { createTestDb } from "@mkt/db/testing";
import { createResend, fakeResend, type ProviderCtx } from "@mkt/providers";
import { RESEND_UNSUBSCRIBE, renderBroadcast, type EmailSettingsLike } from "../email/render.ts";
import { enforceSuppressions, isSuppressed, recordSuppression } from "../email/suppression.ts";
import { SPAM_RATE_LIMIT, validateBroadcast, type BroadcastCheckInput } from "../email/validate.ts";
import { seedWorkspace } from "../publishing/test-fixtures.ts";

let db: Db;
let close: () => Promise<void>;
beforeAll(async () => {
  ({ db, close } = await createTestDb());
});
afterAll(() => close());

const NOW = new Date("2026-10-01T12:00:00Z");
const settings: EmailSettingsLike = {
  fromName: "CJ at SyllaCal",
  fromEmail: "cj@mail.syllacal.com",
  postalAddress: "PO Box 123, Austin TX 78701",
  consentSource: "you bought SyllaCal and agreed to product news",
  euConsentAck: true,
};
const input = (over: Partial<BroadcastCheckInput> = {}): BroadcastCheckInput => ({
  subject: "SyllaCal now reads Canvas exports",
  preheader: null,
  paragraphs: ["We added Canvas support. {{link:landing}}"],
  claimRefs: [],
  settings,
  audienceId: "seg_buyers",
  scheduledAt: new Date("2026-10-02T15:00:00Z"),
  now: NOW,
  claims: new Map(),
  ...over,
});
const blocks = (i: BroadcastCheckInput) => validateBroadcast(i).filter((x) => x.severity === "block").map((x) => x.code);
const links = { landingUrl: "https://syllacal.com", utm: {} };

describe("§8 Email law: what every broadcast must carry", () => {
  it("a complete broadcast has no blocks", () => {
    expect(blocks(input())).toEqual([]);
  });

  it("sender name and address, postal address and consent source are required", () => {
    expect(blocks(input({ settings: { ...settings, fromName: "" } }))).toContain("missing_sender");
    expect(blocks(input({ settings: { ...settings, fromEmail: "not-an-address" } }))).toContain("missing_sender");
    expect(blocks(input({ settings: { ...settings, postalAddress: undefined } }))).toContain("missing_postal_address");
    expect(blocks(input({ settings: { ...settings, consentSource: " " } }))).toContain("missing_consent_source");
    expect(blocks(input({ settings: null }))).toEqual(expect.arrayContaining(["missing_sender", "missing_postal_address", "missing_consent_source"]));
  });

  it("EU consent unconfirmed is a warning only (documented deviation, DECISIONS.md:146)", () => {
    const issues = validateBroadcast(input({ settings: { ...settings, euConsentAck: false } }));
    expect(issues.find((i) => i.code === "eu_consent_unconfirmed")?.severity).toBe("warn");
    expect(blocks(input({ settings: { ...settings, euConsentAck: false } }))).toEqual([]);
  });

  it("the rendered email has the unsubscribe link and the postal address in its footer", () => {
    const r = renderBroadcast({ subject: "Hi", preheader: null, paragraphs: ["Hello {{link:landing}}"] }, settings, links);
    expect(r.html).toContain(RESEND_UNSUBSCRIBE);
    expect(r.text).toContain(RESEND_UNSUBSCRIBE);
    expect(r.text).toContain(settings.postalAddress);
    expect(blocks(input({ rendered: r }))).toEqual([]);
    // A footer that lost either one is blocked at approval.
    expect(blocks(input({ rendered: { html: "<p>hi</p>", text: `hi ${settings.postalAddress}` } }))).toContain("missing_unsubscribe");
    expect(blocks(input({ rendered: { html: RESEND_UNSUBSCRIBE, text: RESEND_UNSUBSCRIBE } }))).toContain("missing_postal_address");
  });

  it("subjects must be truthful: no fake Re:/Fwd:, no pressure words, no unsourced numbers", () => {
    expect(blocks(input({ subject: "Re: your syllabus" }))).toContain("subject_fake_reply");
    expect(blocks(input({ subject: "Fwd: new feature" }))).toContain("subject_fake_reply");
    expect(blocks(input({ subject: "Act now: Canvas support" }))).toContain("subject_urgency");
    expect(blocks(input({ subject: "Save 5 hours a week" }))).toContain("subject_number_without_source");
  });

  it("the next broadcast is stopped when the last one's spam rate was over 0.3%", () => {
    expect(SPAM_RATE_LIMIT).toBe(0.003);
    expect(blocks(input({ previous: { delivered: 1000, complained: 3 } }))).not.toContain("spam_rate");
    expect(blocks(input({ previous: { delivered: 1000, complained: 4 } }))).toContain("spam_rate");
    expect(blocks(input({ previous: { delivered: 0, complained: 1 } }))).toContain("spam_rate");
  });

  it("text from the model or the person is escaped in the HTML", () => {
    const r = renderBroadcast({ subject: "<b>x</b>", preheader: null, paragraphs: ['<img src=x onerror="alert(1)"> & more'] }, settings, links);
    expect(r.html).not.toContain("<img");
    expect(r.html).toContain("&lt;img src=x onerror=&quot;alert(1)&quot;&gt; &amp; more");
    expect(r.html).toContain("<title>&lt;b&gt;x&lt;/b&gt;</title>");
  });
});

describe("§8 Email law: the suppression list is checked before every send", () => {
  const ctx: ProviderCtx = { secret: async (p) => (p === "resend.api_key" ? "re_test_key" : null) };

  it("anyone on our list is unsubscribed at Resend first; Resend's unsubscribes join our list", async () => {
    const ws = (await seedWorkspace(db)).workspaceId;
    const fake = fakeResend();
    fake.addContacts("seg_buyers", ["ok@example.com", "Left@Example.com", "gone@example.com"]);
    fake.contacts.find((c) => c.email === "gone@example.com")!.unsubscribed = true;
    // Stored as a hash only; case and spaces don't matter.
    await recordSuppression(db, ws, " left@example.com ", "unsubscribed", "test");

    const r = await enforceSuppressions(createResend({ fetch: fake.fetch, sleep: async () => {} }), ctx, "seg_buyers", db, ws);
    expect(r).toEqual({ checked: 3, unsubscribed: 1, learned: 1 });
    expect(fake.contacts.find((c) => c.email === "Left@Example.com")!.unsubscribed).toBe(true);
    expect(fake.contacts.find((c) => c.email === "ok@example.com")!.unsubscribed).toBe(false);
    expect(await isSuppressed(db, ws, "gone@example.com")).toBe(true);
    // Only the suppressed contact was changed at Resend.
    expect(fake.calls.filter((c) => c.method === "PATCH")).toHaveLength(1);
  });
});
