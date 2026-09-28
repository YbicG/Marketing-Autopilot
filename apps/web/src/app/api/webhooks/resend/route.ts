import { resendWorkspaceHint, toStoredResendEvent } from "@mkt/core/email";
import { storeWebhookEvent } from "@mkt/core/publishing";
import { enqueue } from "@mkt/core/queue";
import { resolveSecret } from "@mkt/core/security";
import { resend, RESEND_WEBHOOK_SECRET, WebhookSignatureError, type ResendWebhookEvent } from "@mkt/providers";
import { getDb } from "@/lib/db";
import { getQueue } from "@/lib/queues";
import { json } from "@/lib/session";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const ENV_SECRET = "RESEND_WEBHOOK_SECRET";
const MAX_BODY = 256 * 1024;

/**
 * Resend webhooks (§5.4 Email). No session or Origin check: the Svix signature over the raw body
 * is the authentication. Verify, store once (unique provider + svix-id), hand to the worker
 * (email.webhook), answer 2xx fast. Email addresses are stored only as hashes. A bad signature
 * is 401; a repeat is 200.
 */
export async function POST(req: Request) {
  // Refuse an oversized body before buffering it; the length check after covers chunked bodies.
  if (Number(req.headers.get("content-length") ?? 0) > MAX_BODY) return json(413, { error: "too large" });
  const raw = await req.text();
  if (raw.length > MAX_BODY) return json(413, { error: "too large" });
  const headers: Record<string, string> = {};
  req.headers.forEach((v, k) => {
    headers[k] = v;
  });

  const db = getDb();
  // The body names the broadcast or segment, which names the workspace whose secret to try.
  // Nothing from the body is trusted until the signature checks out.
  const workspaceId = await resendWorkspaceHint(db, raw).catch(() => null);
  const secrets = new Set<string>();
  if (workspaceId) {
    const s = await resolveSecret(db, workspaceId, RESEND_WEBHOOK_SECRET, ENV_SECRET).catch(() => null);
    if (s) secrets.add(s);
  }
  if (process.env[ENV_SECRET]) secrets.add(process.env[ENV_SECRET]!);
  if (!secrets.size) return json(401, { error: "webhook secret not configured" });

  let event: ResendWebhookEvent | null = null;
  let lastErr: unknown = null;
  for (const secret of secrets) {
    try {
      event = resend.parseWebhook(raw, headers, secret);
      break;
    } catch (err) {
      lastErr = err;
    }
  }
  if (!event) {
    if (lastErr instanceof WebhookSignatureError && lastErr.message === "body is not JSON") return json(400, { error: "bad body" });
    return json(401, { error: "bad signature" });
  }

  const stored = await storeWebhookEvent(db, {
    provider: "resend",
    eventId: event.eventId,
    type: event.type,
    // Normalized, with addresses hashed (decodeStoredResendEvent reads it back in the worker).
    body: JSON.stringify(toStoredResendEvent(event)),
    workspaceId,
  });
  if (stored.processed) return json(200, { ok: true, duplicate: true });
  await enqueue<"publish", "email.webhook">(getQueue("publish"), "email.webhook", { webhookEventId: stored.id }, { jobId: `wh-${stored.id}` });
  return json(200, { ok: true, duplicate: stored.duplicate });
}
