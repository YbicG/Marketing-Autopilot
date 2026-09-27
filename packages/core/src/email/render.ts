import type { BroadcastSettings, EmailIssue } from "@mkt/contracts";
import { LINK_TOKEN, shortId, withUtm } from "../publishing/links.ts";

/**
 * Broadcast → { html, text } (§5.4 Email). Every word from the model or the editor is escaped: the
 * body is plain paragraphs, so no HTML from anyone reaches the email. The footer carries the sender,
 * postal address, why the reader gets this (consent source) and Resend's unsubscribe placeholder.
 * Resend swaps {{{RESEND_UNSUBSCRIBE_URL}}} for a per-contact link and adds the List-Unsubscribe /
 * one-click headers itself for broadcasts (resend.com docs; UNVERIFIED on a real send: check the
 * headers of a test broadcast on the server).
 */

export const RESEND_UNSUBSCRIBE = "{{{RESEND_UNSUBSCRIBE_URL}}}";

export type EmailSettingsLike = Partial<BroadcastSettings>;

export interface RenderContent {
  subject: string;
  preheader: string | null;
  paragraphs: readonly string[];
}

export interface RenderLinks {
  landingUrl: string | null;
  utm: Record<string, string>;
}

export interface RenderedBroadcast {
  html: string;
  text: string;
  links: { token: string; url: string }[];
  problems: EmailIssue[];
}

export function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

const oneLine = (s: string) => s.replace(/[\r\n]+/g, " ").trim();

/** "Name <email>", quoted when the name has characters that would break the header. */
export function fromHeader(s: EmailSettingsLike): string {
  const email = oneLine(s.fromEmail ?? "");
  const name = oneLine(s.fromName ?? "").replace(/"/g, "'");
  if (!name) return email;
  return /[(),.:;<>@[\]\\]/.test(name) ? `"${name}" <${email}>` : `${name} <${email}>`;
}

export function replyToHeader(s: EmailSettingsLike): string | null {
  return s.replyTo ? oneLine(s.replyTo) : null;
}

/** utm for a broadcast (§5.8 step 2 adapted): utm_source=email, utm_medium=email, utm_content=broadcast id. */
export function broadcastUtm(i: { productSlug: string; campaignId: string | null; broadcastId: string }): Record<string, string> {
  return {
    utm_source: "email",
    utm_medium: "email",
    utm_campaign: `${i.productSlug}-${shortId(i.campaignId ?? i.broadcastId)}`,
    utm_content: i.broadcastId,
  };
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}

type Piece = { kind: "text"; value: string } | { kind: "link"; url: string; label: string };

function pieces(paragraph: string, links: RenderLinks, found: RenderedBroadcast["links"], problems: EmailIssue[]): Piece[] {
  const out: Piece[] = [];
  let last = 0;
  for (const m of paragraph.matchAll(new RegExp(LINK_TOKEN.source, "gi"))) {
    const at = m.index ?? 0;
    if (at > last) out.push({ kind: "text", value: paragraph.slice(last, at) });
    last = at + m[0].length;
    const token = (m[1] ?? "").toLowerCase();
    if (token !== "landing") {
      problems.push({ code: "unknown_link", severity: "block", message: `Unknown link "${m[1]}". Only your website link can go in an email.` });
      continue;
    }
    if (!links.landingUrl) {
      problems.push({ code: "no_website", severity: "block", message: "Add your website address to this product so the email's link has somewhere to go." });
      continue;
    }
    const url = withUtm(links.landingUrl, links.utm);
    if (!found.some((f) => f.url === url)) found.push({ token, url });
    out.push({ kind: "link", url, label: hostOf(links.landingUrl) });
  }
  if (last < paragraph.length) out.push({ kind: "text", value: paragraph.slice(last) });
  return out;
}

const P = 'style="margin:0 0 16px 0;font-size:16px;line-height:1.5;color:#1f2328;"';
const FOOT = 'style="margin:0 0 8px 0;font-size:12px;line-height:1.5;color:#6e7781;"';

export function renderBroadcast(content: RenderContent, settings: EmailSettingsLike, links: RenderLinks): RenderedBroadcast {
  const found: RenderedBroadcast["links"] = [];
  const problems: EmailIssue[] = [];
  const paras = content.paragraphs.map((p) => p.trim()).filter(Boolean);
  const parsed = paras.map((p) => pieces(p, links, found, problems));

  const htmlParas = parsed.map(
    (ps) =>
      `<p ${P}>${ps
        .map((x) => (x.kind === "text" ? escapeHtml(x.value).replace(/\n/g, "<br>") : `<a href="${escapeHtml(x.url)}" style="color:#0969da;">${escapeHtml(x.label)}</a>`))
        .join("")}</p>`,
  );
  const textParas = parsed.map((ps) => ps.map((x) => (x.kind === "text" ? x.value : x.url)).join(""));

  const name = oneLine(settings.fromName ?? "");
  const postal = oneLine(settings.postalAddress ?? "");
  const consent = oneLine(settings.consentSource ?? "").replace(/\.$/, "");
  const why = consent ? `You're getting this because ${consent}.` : "";
  const sender = [name, postal].filter(Boolean).join(" · ");
  const replyLine = name ? `Reply to this email to reach ${name}.` : "";

  const preheader = content.preheader?.trim()
    ? `<div style="display:none;max-height:0;overflow:hidden;opacity:0;color:transparent;">${escapeHtml(oneLine(content.preheader))}</div>`
    : "";
  const footer = [
    replyLine && `<p ${FOOT}>${escapeHtml(replyLine)}</p>`,
    why && `<p ${FOOT}>${escapeHtml(why)}</p>`,
    sender && `<p ${FOOT}>${escapeHtml(sender)}</p>`,
    `<p ${FOOT}><a href="${RESEND_UNSUBSCRIBE}" style="color:#6e7781;">Unsubscribe</a></p>`,
  ]
    .filter(Boolean)
    .join("\n");

  const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(oneLine(content.subject))}</title></head>
<body style="margin:0;padding:0;background:#ffffff;">
${preheader}
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr><td align="center" style="padding:24px 16px;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:560px;"><tr><td style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;text-align:left;">
${htmlParas.join("\n")}
<hr style="border:none;border-top:1px solid #d0d7de;margin:24px 0 16px 0;">
${footer}
</td></tr></table>
</td></tr></table>
</body></html>`;

  const text = [
    ...textParas,
    "--",
    ...[replyLine, why, sender].filter(Boolean),
    `Unsubscribe: ${RESEND_UNSUBSCRIBE}`,
  ].join("\n\n");

  return { html, text, links: found, problems };
}
