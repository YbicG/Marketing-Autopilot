import { storeWebhookEvent, webhookWorkspaceHint } from "@mkt/core/publishing";
import { enqueue } from "@mkt/core/queue";
import { resolveSecret } from "@mkt/core/security";
import { SECRET_WEBHOOK, uploadPost, WebhookSignatureError, type WebhookEvent } from "@mkt/providers";
import { getDb } from "@/lib/db";
import { getQueue } from "@/lib/queues";
import { json } from "@/lib/session";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const ENV_SECRET = "UPLOAD_POST_WEBHOOK_SECRET";
const MAX_BODY = 256 * 1024;

/**
 * Upload-Post webhooks (§5.8 step 4). No session or Origin check: the HMAC over the raw body is
 * the authentication. Verify, store once (unique provider + event id), hand to the worker
 * (publish.webhook), answer 2xx fast. A bad signature is 401; a repeat is 200.
 */
export async function POST(req: Request) {
  const raw = await req.text();
  if (raw.length > MAX_BODY) return json(413, { error: "too large" });
  const headers: Record<string, string> = {};
  req.headers.forEach((v, k) => {
    headers[k] = v;
  });

  const db = getDb();
  // Webhooks aren't workspace-scoped: the body names the post or profile, which names the workspace
  // whose secret to try. Nothing from the body is trusted until the signature checks out.
  const workspaceId = await webhookWorkspaceHint(db, raw).catch(() => null);
  const secrets = new Set<string>();
  if (workspaceId) {
    const s = await resolveSecret(db, workspaceId, SECRET_WEBHOOK, ENV_SECRET).catch(() => null);
    if (s) secrets.add(s);
  }
  if (process.env[ENV_SECRET]) secrets.add(process.env[ENV_SECRET]!);
  if (!secrets.size) return json(401, { error: "webhook secret not configured" });

  let event: WebhookEvent | null = null;
  let lastErr: unknown = null;
  for (const secret of secrets) {
    try {
      event = uploadPost.parseWebhook(raw, headers, secret);
      break;
    } catch (err) {
      lastErr = err;
    }
  }
  if (!event) {
    if (lastErr instanceof WebhookSignatureError && lastErr.message === "body is not JSON") return json(400, { error: "bad body" });
    return json(401, { error: "bad signature" });
  }

  const type = event.kind === "ignored" ? event.type : event.kind;
  const stored = await storeWebhookEvent(db, {
    provider: "upload_post",
    eventId: event.eventId,
    type,
    // The normalized event (decodeStoredWebhook reads it back in the worker).
    body: JSON.stringify(event),
    workspaceId,
  });
  if (stored.processed) return json(200, { ok: true, duplicate: true });
  // A repeat of a row we never managed to enqueue is enqueued again; the jobId dedupes the rest.
  await enqueue<"publish", "publish.webhook">(getQueue("publish"), "publish.webhook", { webhookEventId: stored.id }, { jobId: `wh-${stored.id}` });
  return json(200, { ok: true, duplicate: stored.duplicate });
}
