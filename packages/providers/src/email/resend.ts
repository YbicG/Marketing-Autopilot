import { httpRequest, type FetchLike, type HttpResult } from "../core/http.ts";
import type { ProviderCtx, ProviderMeta } from "../core/types.ts";
import { WebhookSignatureError } from "../publish/upload-post.ts";
import { verifySvix } from "./svix.ts";

/**
 * Resend over plain HTTPS (§5.4 Email "LC"): the seasonal broadcast to past buyers through SyllaCal's
 * existing Resend domain. Endpoints checked against resend.com/docs on 2026-09-27:
 * - POST   /broadcasts               { segment_id, from, subject, reply_to?, html?, text?, name? } → { id }
 * - POST   /broadcasts/{id}/send     { scheduled_at? (ISO 8601) } → { id }. Only API-created broadcasts.
 * - GET    /broadcasts/{id}          → { id, name, status: draft|scheduled|queued|sending|sent|canceled, scheduled_at, sent_at, … }
 * - DELETE /broadcasts/{id}          only draft or scheduled; deleting a scheduled one cancels delivery
 * - GET    /segments?limit&after     → { data[{id,name}], has_more }   (Resend renamed audiences → segments)
 * - GET    /contacts?limit&after     → { data[{id,email,unsubscribed}], has_more }, filterable by segment_id
 * - PATCH  /contacts/{id|email}      { unsubscribed: true } unsubscribes from all broadcasts
 * Auth: `Authorization: Bearer re_…`.
 * UNVERIFIED (see the report / check on the server):
 * - that segment_id on GET /contacts is a query parameter (the docs call it a "path parameter" but
 *   show no path). If it's ignored we page every contact, which is still correct for suppression.
 * - the legacy /audiences and /audiences/{id}/contacts fallbacks, used only when /segments 404s.
 * - that an old audience id works as segment_id.
 * - Resend's limit on how far ahead scheduled_at may be.
 */

export const RESEND_BASE = "https://api.resend.com";
export const RESEND_API_KEY = "resend.api_key";
export const RESEND_WEBHOOK_SECRET = "resend.webhook_secret";
export const RESEND_TIMEOUT_MS = 30_000;
/** Resend's documented default rate limit is 2 requests/second; 429s wait and retry this many times. */
const MAX_429_RETRIES = 3;
const PAGE = 100;

export class ResendKeyMissing extends Error {
  readonly code = "resend_key_missing" as const;
  constructor() {
    super("Add your Resend API key in Settings → Keys to send email.");
    this.name = "ResendKeyMissing";
  }
}

export class ResendError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly body: unknown,
  ) {
    super(message);
    this.name = "ResendError";
  }
}

export interface EmailAudience {
  id: string;
  name: string;
  kind: "segment" | "audience";
}

export interface EmailContact {
  id: string;
  email: string;
  unsubscribed: boolean;
}

export interface ContactPage {
  contacts: EmailContact[];
  hasMore: boolean;
  /** Cursor for the next page (the last contact id), or null. */
  next: string | null;
}

export interface CreateBroadcastRequest {
  audienceId: string;
  /** "Name <email@domain>" */
  from: string;
  replyTo?: string | null;
  subject: string;
  html: string;
  text: string;
  /** Internal name shown in the Resend dashboard. */
  name: string;
}

export type ResendBroadcastState = "draft" | "scheduled" | "queued" | "sending" | "sent" | "canceled";

export interface ResendBroadcast {
  id: string;
  name: string | null;
  /** Unknown values are passed through as-is. */
  status: ResendBroadcastState | (string & {});
  scheduledAt: string | null;
  sentAt: string | null;
}

export type DeleteResult = { deleted: true } | { deleted: false; reason: "not_found" | "not_deletable"; message: string };

export const RESEND_EVENT_TYPES = [
  "email.sent",
  "email.delivered",
  "email.delivery_delayed",
  "email.bounced",
  "email.complained",
  "email.failed",
  "email.suppressed",
  "email.opened",
  "email.clicked",
  "email.scheduled",
  "contact.created",
  "contact.updated",
  "contact.unsubscribed",
  "contact.deleted",
  "ignored",
] as const;
export type ResendEventType = (typeof RESEND_EVENT_TYPES)[number];

/** A verified, normalized Resend webhook. `type` "contact.unsubscribed" = contact.updated with unsubscribed true. */
export interface ResendWebhookEvent {
  /** svix-id: unique per delivery attempt group; the dedupe key in webhook_events. */
  eventId: string;
  type: ResendEventType;
  rawType: string;
  createdAt: string | null;
  broadcastId: string | null;
  emailId: string | null;
  /** Recipient addresses (email events). Never stored as-is: core hashes them first. */
  to: string[];
  /** "Permanent" | "Temporary" for email.bounced. */
  bounceType: string | null;
  contactId: string | null;
  contactEmail: string | null;
  unsubscribed: boolean | null;
  audienceIds: string[];
}

export interface ResendProvider {
  meta: ProviderMeta & { kind: "email" };
  listAudiences(ctx: ProviderCtx): Promise<EmailAudience[]>;
  createBroadcast(ctx: ProviderCtx, req: CreateBroadcastRequest): Promise<{ id: string }>;
  /** Schedules (scheduledAt in the future) or sends now (null). */
  sendBroadcast(ctx: ProviderCtx, id: string, opts: { scheduledAt: Date | null }): Promise<void>;
  /** null when Resend has no such broadcast. */
  getBroadcast(ctx: ProviderCtx, id: string): Promise<ResendBroadcast | null>;
  /** Cancel a scheduled (or draft) broadcast by deleting it. Sent ones can't be deleted. */
  deleteBroadcast(ctx: ProviderCtx, id: string): Promise<DeleteResult>;
  listContacts(ctx: ProviderCtx, audienceId: string, opts?: { after?: string | null; limit?: number }): Promise<ContactPage>;
  updateContact(ctx: ProviderCtx, idOrEmail: string, patch: { unsubscribed: boolean }): Promise<void>;
  /** Verifies the Svix signature over the raw body and normalizes it. Throws WebhookSignatureError. */
  parseWebhook(rawBody: string, headers: Record<string, string>, secret: string): ResendWebhookEvent;
}

export interface ResendOptions {
  fetch?: FetchLike;
  baseUrl?: string;
  now?: () => Date;
  sleep?: (ms: number) => Promise<void>;
}

const str = (v: unknown): string | null => (typeof v === "string" && v ? v : null);

function plainError(status: number, json: unknown, what: string): ResendError {
  const msg = str((json as { message?: unknown } | null)?.message);
  if (status === 401 || status === 403) return new ResendError(status, "Resend didn't accept the API key. Check it in Settings → Keys.", json);
  if (status === 404) return new ResendError(status, `Resend couldn't find that ${what}.`, json);
  if (status === 429) return new ResendError(status, "Resend is rate limiting us. Try again in a minute.", json);
  if (status >= 500) return new ResendError(status, "Resend had a problem on its side. Try again in a few minutes.", json);
  return new ResendError(status, msg ? `Resend said: ${msg}` : `Resend refused the ${what} (${status}).`, json);
}

export function mapBroadcast(json: unknown): ResendBroadcast | null {
  const o = json as Record<string, unknown> | null;
  const id = str(o?.id);
  if (!o || !id) return null;
  return { id, name: str(o.name), status: str(o.status) ?? "draft", scheduledAt: str(o.scheduled_at), sentAt: str(o.sent_at) };
}

function mapContacts(json: unknown): ContactPage {
  const o = json as { data?: unknown; has_more?: unknown } | null;
  const rows = Array.isArray(o?.data) ? (o.data as Record<string, unknown>[]) : [];
  const contacts: EmailContact[] = [];
  for (const r of rows) {
    const id = str(r?.id);
    const email = str(r?.email);
    if (id && email) contacts.push({ id, email, unsubscribed: r.unsubscribed === true });
  }
  const hasMore = o?.has_more === true && contacts.length > 0;
  return { contacts, hasMore, next: hasMore ? contacts[contacts.length - 1]!.id : null };
}

const EMAIL_TYPES = new Set<string>(RESEND_EVENT_TYPES.filter((t) => t.startsWith("email.")));

/** Pure: raw (already verified) body → normalized event. */
export function normalizeResendEvent(eventId: string, body: unknown): ResendWebhookEvent {
  const o = (body && typeof body === "object" ? body : {}) as Record<string, unknown>;
  const rawType = str(o.type) ?? "unknown";
  const data = (o.data && typeof o.data === "object" ? o.data : {}) as Record<string, unknown>;
  const toList = Array.isArray(data.to) ? data.to : typeof data.to === "string" ? [data.to] : [];
  const bounce = (data.bounce && typeof data.bounce === "object" ? data.bounce : {}) as Record<string, unknown>;
  const segs = Array.isArray(data.segment_ids) ? data.segment_ids.filter((x): x is string => typeof x === "string") : [];
  const base: ResendWebhookEvent = {
    eventId,
    type: "ignored",
    rawType,
    createdAt: str(o.created_at),
    broadcastId: str(data.broadcast_id),
    emailId: rawType.startsWith("email.") ? (str(data.email_id) ?? str(data.id)) : null,
    to: toList.filter((x): x is string => typeof x === "string" && x.includes("@")),
    bounceType: str(bounce.type),
    contactId: null,
    contactEmail: null,
    unsubscribed: null,
    audienceIds: [...new Set([...(str(data.audience_id) ? [str(data.audience_id)!] : []), ...segs])],
  };
  if (EMAIL_TYPES.has(rawType)) return { ...base, type: rawType as ResendEventType };
  if (rawType.startsWith("contact.")) {
    const unsub = typeof data.unsubscribed === "boolean" ? data.unsubscribed : null;
    const contact = { ...base, contactId: str(data.id), contactEmail: str(data.email), unsubscribed: unsub };
    if (rawType === "contact.updated") return { ...contact, type: unsub ? "contact.unsubscribed" : "contact.updated" };
    if (rawType === "contact.created" || rawType === "contact.deleted") return { ...contact, type: rawType };
  }
  return base;
}

export function parseResendWebhook(rawBody: string, headers: Record<string, string>, secret: string, now: Date): ResendWebhookEvent {
  const v = verifySvix(rawBody, headers, secret, now);
  if (!v.ok) throw new WebhookSignatureError(`bad signature (${v.reason})`);
  let body: unknown;
  try {
    body = JSON.parse(rawBody);
  } catch {
    throw new WebhookSignatureError("body is not JSON");
  }
  return normalizeResendEvent(v.id, body);
}

export function createResend(opts: ResendOptions = {}): ResendProvider {
  const base = opts.baseUrl ?? RESEND_BASE;
  const now = opts.now ?? (() => new Date());
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));

  async function call(ctx: ProviderCtx, method: string, path: string, body?: unknown): Promise<HttpResult> {
    const key = await ctx.secret(RESEND_API_KEY);
    if (!key) throw new ResendKeyMissing();
    for (let attempt = 0; ; attempt++) {
      const res = await httpRequest(`${base}${path}`, {
        method,
        headers: { authorization: `Bearer ${key}`, accept: "application/json", ...(body === undefined ? {} : { "content-type": "application/json" }) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        timeoutMs: RESEND_TIMEOUT_MS,
        ...(ctx.signal ? { signal: ctx.signal } : {}),
        ...(opts.fetch ? { fetch: opts.fetch } : {}),
      });
      if (res.status !== 429 || attempt >= MAX_429_RETRIES) return res;
      const after = Number(res.headers.get("retry-after"));
      await sleep(Number.isFinite(after) && after > 0 ? Math.min(after, 10) * 1000 : 1000 * (attempt + 1));
    }
  }

  const ok = (res: HttpResult) => res.status >= 200 && res.status < 300;

  async function pagedList(ctx: ProviderCtx, path: string): Promise<Record<string, unknown>[] | null> {
    const out: Record<string, unknown>[] = [];
    let after: string | null = null;
    for (let i = 0; i < 50; i++) {
      const q = new URLSearchParams({ limit: String(PAGE) });
      if (after) q.set("after", after);
      const res = await call(ctx, "GET", `${path}?${q}`);
      if (res.status === 404 && i === 0) return null;
      if (!ok(res)) throw plainError(res.status, res.json, "list");
      const o = res.json as { data?: unknown; has_more?: unknown } | null;
      const rows = Array.isArray(o?.data) ? (o.data as Record<string, unknown>[]) : [];
      out.push(...rows);
      const last = str(rows[rows.length - 1]?.id);
      if (o?.has_more !== true || !last) break;
      after = last;
    }
    return out;
  }

  return {
    meta: { id: "resend", kind: "email", requiredSecrets: [RESEND_API_KEY, RESEND_WEBHOOK_SECRET] },

    async listAudiences(ctx) {
      const segments = await pagedList(ctx, "/segments");
      if (segments) {
        return segments.flatMap((s) => (str(s.id) ? [{ id: str(s.id)!, name: str(s.name) ?? "Untitled", kind: "segment" as const }] : []));
      }
      // UNVERIFIED legacy fallback for accounts still on audiences.
      const audiences = (await pagedList(ctx, "/audiences")) ?? [];
      return audiences.flatMap((s) => (str(s.id) ? [{ id: str(s.id)!, name: str(s.name) ?? "Untitled", kind: "audience" as const }] : []));
    },

    async createBroadcast(ctx, req) {
      const res = await call(ctx, "POST", "/broadcasts", {
        segment_id: req.audienceId,
        from: req.from,
        subject: req.subject,
        ...(req.replyTo ? { reply_to: req.replyTo } : {}),
        html: req.html,
        text: req.text,
        name: req.name,
      });
      if (!ok(res)) throw plainError(res.status, res.json, "broadcast");
      const id = str((res.json as { id?: unknown } | null)?.id);
      if (!id) throw new ResendError(res.status, "Resend didn't return an id for the broadcast.", res.json);
      return { id };
    },

    async sendBroadcast(ctx, id, o) {
      const res = await call(ctx, "POST", `/broadcasts/${encodeURIComponent(id)}/send`, o.scheduledAt ? { scheduled_at: o.scheduledAt.toISOString() } : {});
      if (!ok(res)) throw plainError(res.status, res.json, "broadcast");
    },

    async getBroadcast(ctx, id) {
      const res = await call(ctx, "GET", `/broadcasts/${encodeURIComponent(id)}`);
      if (res.status === 404) return null;
      if (!ok(res)) throw plainError(res.status, res.json, "broadcast");
      return mapBroadcast(res.json);
    },

    async deleteBroadcast(ctx, id) {
      const res = await call(ctx, "DELETE", `/broadcasts/${encodeURIComponent(id)}`);
      if (ok(res)) return { deleted: true };
      if (res.status === 404) return { deleted: false, reason: "not_found", message: "Resend has no such broadcast." };
      // Resend refuses to delete anything past draft/scheduled (queued, sending, sent).
      if (res.status === 400 || res.status === 403 || res.status === 409 || res.status === 422) {
        return { deleted: false, reason: "not_deletable", message: plainError(res.status, res.json, "broadcast").message };
      }
      throw plainError(res.status, res.json, "broadcast");
    },

    async listContacts(ctx, audienceId, o = {}) {
      const q = new URLSearchParams({ segment_id: audienceId, limit: String(Math.min(o.limit ?? PAGE, PAGE)) });
      if (o.after) q.set("after", o.after);
      const res = await call(ctx, "GET", `/contacts?${q}`);
      if (ok(res)) return mapContacts(res.json);
      if (res.status === 404 || res.status === 422) {
        // UNVERIFIED legacy path for accounts still on audiences.
        const legacy = await call(ctx, "GET", `/audiences/${encodeURIComponent(audienceId)}/contacts${o.after ? `?after=${encodeURIComponent(o.after)}` : ""}`);
        if (ok(legacy)) return mapContacts(legacy.json);
        throw plainError(legacy.status, legacy.json, "contact list");
      }
      throw plainError(res.status, res.json, "contact list");
    },

    async updateContact(ctx, idOrEmail, patch) {
      const res = await call(ctx, "PATCH", `/contacts/${encodeURIComponent(idOrEmail)}`, { unsubscribed: patch.unsubscribed });
      if (!ok(res)) throw plainError(res.status, res.json, "contact");
    },

    parseWebhook: (rawBody, headers, secret) => parseResendWebhook(rawBody, headers, secret, now()),
  };
}

export const resend = createResend();
