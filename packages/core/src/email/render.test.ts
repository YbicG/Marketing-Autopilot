import { describe, expect, it } from "vitest";
import { broadcastBodyText, broadcastParagraphs } from "@mkt/contracts";
import { hashEmail, broadcastHash } from "./hash.ts";
import { broadcastUtm, escapeHtml, fromHeader, renderBroadcast, RESEND_UNSUBSCRIBE } from "./render.ts";
import { SPAM_RATE_LIMIT, subjectIssues, validateBroadcast, type BroadcastCheckInput, type EmailClaimInfo } from "./validate.ts";

const settings = {
  fromName: "CJ at SyllaCal",
  fromEmail: "cj@syllacal.com",
  replyTo: "help@syllacal.com",
  postalAddress: "PO Box 123, Austin, TX 78701",
  consentSource: "you bought SyllaCal and said yes to product news",
  euConsentAck: true,
};
const BID = "0190a5f0-0000-7000-8000-00000000abcd";
const links = { landingUrl: "https://syllacal.com/", utm: broadcastUtm({ productSlug: "syllacal", campaignId: null, broadcastId: BID }) };

describe("renderBroadcast", () => {
  it("escapes everything the model or editor wrote", () => {
    const r = renderBroadcast({ subject: "<b>Hi</b>", preheader: `"quoted" & <x>`, paragraphs: ["<script>alert(1)</script> & 'you'", "line one\nline two"] }, settings, links);
    expect(r.html).not.toContain("<script>");
    expect(r.html).toContain("&lt;script&gt;alert(1)&lt;/script&gt; &amp; &#39;you&#39;");
    expect(r.html).toContain("&quot;quoted&quot; &amp; &lt;x&gt;");
    expect(r.html).toContain("<title>&lt;b&gt;Hi&lt;/b&gt;</title>");
    expect(r.html).toContain("line one<br>line two");
    // The plain-text part is the words as written.
    expect(r.text).toContain("<script>alert(1)</script> & 'you'");
  });

  it("puts the sender, postal address, why-you-get-this and unsubscribe placeholder in the footer", () => {
    const r = renderBroadcast({ subject: "s", preheader: null, paragraphs: ["Hello"] }, settings, links);
    for (const part of [r.html, r.text]) {
      expect(part).toContain(RESEND_UNSUBSCRIBE);
      expect(part).toContain("PO Box 123, Austin, TX 78701");
      expect(part.replaceAll("&#39;", "'")).toContain("You're getting this because you bought SyllaCal and said yes to product news.");
      expect(part).toContain("CJ at SyllaCal");
    }
    expect(r.html).toContain(`<a href="${RESEND_UNSUBSCRIBE}"`);
    expect(r.text.trim().endsWith(`Unsubscribe: ${RESEND_UNSUBSCRIBE}`)).toBe(true);
  });

  it("turns the link token into a tracking link", () => {
    const r = renderBroadcast({ subject: "s", preheader: null, paragraphs: ["Try it: {{link:landing}} today"] }, settings, links);
    const url = `https://syllacal.com/?utm_source=email&utm_medium=email&utm_campaign=syllacal-0000abcd&utm_content=${BID}`;
    expect(r.links).toEqual([{ token: "landing", url }]);
    expect(r.html).toContain(`<a href="${escapeHtml(url)}" style="color:#0969da;">syllacal.com</a> today`);
    expect(r.text).toContain(`Try it: ${url} today`);
    expect(r.problems).toEqual([]);
  });

  it("reports unknown tokens and a missing website", () => {
    expect(renderBroadcast({ subject: "s", preheader: null, paragraphs: ["{{link:pricing}}"] }, settings, links).problems[0]!.code).toBe("unknown_link");
    expect(renderBroadcast({ subject: "s", preheader: null, paragraphs: ["{{link:landing}}"] }, settings, { ...links, landingUrl: null }).problems[0]!.code).toBe("no_website");
  });

  it("quotes a from name that would break the header", () => {
    expect(fromHeader({ fromName: "CJ", fromEmail: "cj@x.co" })).toBe("CJ <cj@x.co>");
    expect(fromHeader({ fromName: "CJ, SyllaCal", fromEmail: "cj@x.co" })).toBe('"CJ, SyllaCal" <cj@x.co>');
    expect(fromHeader({ fromName: 'A "b"\r\nBcc: x', fromEmail: "cj@x.co" })).toBe(`"A 'b' Bcc: x" <cj@x.co>`);
  });
});

describe("body text and hashes", () => {
  it("round-trips paragraphs", () => {
    expect(broadcastParagraphs("a\n\n\n b \r\n\r\nc\nd")).toEqual(["a", "b", "c\nd"]);
    expect(broadcastBodyText([" a ", "", "b"])).toBe("a\n\nb");
  });
  it("hashes addresses case- and space-insensitively", () => {
    expect(hashEmail(" CJ@SyllaCal.com ")).toBe(hashEmail("cj@syllacal.com"));
    expect(hashEmail("cj@syllacal.com")).toMatch(/^[0-9a-f]{64}$/);
  });
  it("the approval hash changes with every sent field", () => {
    const base = { subject: "s", html: "h", text: "t", audienceId: "a", scheduledAt: new Date(0), from: "f", replyTo: null };
    const h = broadcastHash(base);
    for (const k of ["subject", "html", "text", "audienceId", "from"] as const) expect(broadcastHash({ ...base, [k]: "x" })).not.toBe(h);
    expect(broadcastHash({ ...base, scheduledAt: new Date(1000) })).not.toBe(h);
    expect(broadcastHash({ ...base, replyTo: "r" })).not.toBe(h);
  });
});

const now = new Date("2026-12-20T12:00:00Z");
const claims = new Map<string, EmailClaimInfo>([
  ["C1", { ref: "C1", kind: "feature", publicOk: true, status: "sourced", expiresAt: null }],
  ["C2", { ref: "C2", kind: "stat", publicOk: false, status: "sourced", expiresAt: null }],
  ["C3", { ref: "C3", kind: "price", publicOk: true, status: "sourced", expiresAt: new Date("2027-01-01T00:00:00Z") }],
  ["C4", { ref: "C4", kind: "testimonial", publicOk: true, status: "sourced", expiresAt: null }],
  ["C5", { ref: "C5", kind: "feature", publicOk: true, status: "rejected", expiresAt: null }],
]);
const good = (): BroadcastCheckInput => {
  const content = { subject: "Your spring 2027 semester, sorted", preheader: "What's new in SyllaCal", paragraphs: ["Thanks for using SyllaCal.", "Get set up: {{link:landing}}"] };
  const rendered = renderBroadcast(content, settings, links);
  return { ...content, claimRefs: ["C1"], settings, audienceId: "seg_1", scheduledAt: new Date("2027-01-06T15:00:00Z"), now, claims, rendered, previous: null };
};
const codes = (i: BroadcastCheckInput) => validateBroadcast(i).map((x) => `${x.severity}:${x.code}`);

describe("validateBroadcast (§8 email law row)", () => {
  it("a good broadcast passes", () => {
    expect(validateBroadcast(good())).toEqual([]);
  });

  it("blocks without the unsubscribe placeholder or postal address in the footer", () => {
    const g = good();
    expect(codes({ ...g, rendered: { html: g.rendered!.html.replaceAll(RESEND_UNSUBSCRIBE, ""), text: g.rendered!.text } })).toContain("block:missing_unsubscribe");
    expect(codes({ ...g, rendered: { html: g.rendered!.html, text: g.rendered!.text.replace("PO Box 123, Austin, TX 78701", "") } })).toContain("block:missing_postal_address");
    expect(codes({ ...g, settings: { ...settings, postalAddress: "" } })).toContain("block:missing_postal_address");
  });

  it("blocks without a sender identity; a bad reply-to blocks", () => {
    expect(codes({ ...good(), settings: { ...settings, fromName: "" } })).toContain("block:missing_sender");
    expect(codes({ ...good(), settings: { ...settings, fromEmail: "not-an-email" } })).toContain("block:missing_sender");
    expect(codes({ ...good(), settings: { ...settings, replyTo: "nope" } })).toContain("block:bad_reply_to");
    expect(codes({ ...good(), settings: null })).toEqual(expect.arrayContaining(["block:missing_sender", "block:missing_postal_address", "block:missing_consent_source"]));
  });

  it("asks where the contacts came from, and warns without the EU consent tick", () => {
    const noConsent = validateBroadcast({ ...good(), settings: { ...settings, consentSource: " " } }).find((i) => i.code === "missing_consent_source")!;
    expect(noConsent).toMatchObject({ severity: "block", message: expect.stringMatching(/^Where did these contacts come from\?/) });
    expect(codes({ ...good(), settings: { ...settings, euConsentAck: undefined } })).toEqual(["warn:eu_consent_unconfirmed"]);
  });

  it("subjects must be truthful", () => {
    expect(subjectIssues("Re: your order", []).map((i) => i.code)).toEqual(["subject_fake_reply"]);
    expect(subjectIssues("FWD: news", []).map((i) => i.code)).toEqual(["subject_fake_reply"]);
    expect(subjectIssues("Re: your order", [], true)).toEqual([]);
    expect(subjectIssues("URGENT: new semester", []).map((i) => i.code)).toEqual(["subject_urgency"]);
    expect(subjectIssues("Last chance to plan your term", []).map((i) => i.code)).toEqual(["subject_urgency"]);
    expect(subjectIssues("Save 5 hours this semester", []).map((i) => i.code)).toEqual(["subject_number_without_source"]);
    expect(subjectIssues("Save 5 hours this semester", ["C1"])).toEqual([]);
    expect(subjectIssues("Spring 2027 is here", [])).toEqual([]);
    expect(subjectIssues("  ", []).map((i) => i.code)).toEqual(["empty_subject"]);
    expect(subjectIssues("x".repeat(95), []).map((i) => `${i.severity}:${i.code}`)).toEqual(["warn:subject_too_long"]);
  });

  it("checks every fact: public, not rejected, verified testimonials, valid through the send", () => {
    expect(codes({ ...good(), claimRefs: ["C2"] })).toEqual(["block:internal_fact"]);
    expect(codes({ ...good(), claimRefs: ["C3"] })).toEqual(["block:fact_expires"]);
    expect(codes({ ...good(), claimRefs: ["C3"], scheduledAt: new Date("2026-12-28T00:00:00Z") })).toEqual([]);
    expect(codes({ ...good(), claimRefs: ["C4"] })).toEqual(["block:unverified_testimonial"]);
    expect(codes({ ...good(), claimRefs: ["C5"] })).toEqual(["block:rejected_fact"]);
    expect(codes({ ...good(), claimRefs: ["C9"] })).toEqual(["block:unknown_fact"]);
  });

  it("blocks raw links and unknown tokens; warns on jargon and uncited numbers", () => {
    expect(codes({ ...good(), paragraphs: ["See https://syllacal.com/pricing"] })).toContain("block:raw_link");
    expect(codes({ ...good(), paragraphs: ["See www.syllacal.com"] })).toContain("block:raw_link");
    expect(codes({ ...good(), paragraphs: ["{{link:pricing}}"] })).toContain("block:unknown_link");
    expect(codes({ ...good(), paragraphs: ["Our CTA is clear and our funnel is short."] })).toContain("warn:jargon");
    expect(codes({ ...good(), claimRefs: [], paragraphs: ["Students saved 40% of their time."] })).toContain("warn:number_without_source");
    expect(codes({ ...good(), paragraphs: ["<b>bold</b>"] })).toContain("warn:raw_html");
  });

  it("needs an audience and a send time in the future", () => {
    expect(codes({ ...good(), audienceId: null })).toContain("block:missing_audience");
    expect(codes({ ...good(), scheduledAt: null })).toContain("block:missing_schedule");
    expect(codes({ ...good(), scheduledAt: new Date(now.getTime() - 3_600_000) })).toContain("block:schedule_in_past");
  });

  it("blocks the next broadcast when the last one's complaints were over 0.3%", () => {
    expect(SPAM_RATE_LIMIT).toBe(0.003);
    expect(codes({ ...good(), previous: { delivered: 1000, complained: 3 } })).toEqual([]);
    expect(codes({ ...good(), previous: { delivered: 1000, complained: 4 } })).toEqual(["block:spam_rate"]);
    expect(codes({ ...good(), previous: { delivered: 0, complained: 1 } })).toEqual(["block:spam_rate"]);
    expect(codes({ ...good(), previous: { delivered: 0, complained: 0 } })).toEqual([]);
  });
});
