import { purposeEnvName } from "@mkt/core/cost";
import type { EmailActionResult } from "@mkt/core/email";
import { productBySlug } from "@mkt/core/ingest";
import type { Actor } from "@mkt/core/publishing";
import { resolveSecret, VaultKeyError } from "@mkt/core/security";
import { ProviderHttpError, ResendError, ResendKeyMissing, type ProviderCtx } from "@mkt/providers";
import { VAULT_KEY_MISSING } from "@/components/settings/vault";
import { getDb } from "@/lib/db";
import { applyBroadcastEffects } from "@/lib/queues";
import { isSameOrigin, json, sessionFromRequest, type SessionWorkspace } from "@/lib/session";

// Shared by the /api/email/* routes (M4-LC broadcast). Not a route: no route.ts here.

export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const userActor = (userId: string): Actor => ({ type: "user", id: userId });

/** Session + Origin for every state-changing email route (approve uses requireUiSession instead). */
export async function writeSession(req: Request): Promise<{ ok: true; s: SessionWorkspace } | { ok: false; res: Response }> {
  if (!isSameOrigin(req)) return { ok: false, res: json(403, { error: "Cross-origin request refused." }) };
  const s = await sessionFromRequest(req);
  if (!s) return { ok: false, res: json(401, { error: "Please sign in." }) };
  return { ok: true, s };
}

export async function readSession(req: Request): Promise<{ ok: true; s: SessionWorkspace } | { ok: false; res: Response }> {
  const s = await sessionFromRequest(req);
  if (!s) return { ok: false, res: json(401, { error: "Please sign in." }) };
  return { ok: true, s };
}

export async function readBody(req: Request): Promise<Record<string, unknown>> {
  try {
    const b: unknown = await req.json();
    return b && typeof b === "object" && !Array.isArray(b) ? (b as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

export async function productFor(workspaceId: string, slug: unknown) {
  if (typeof slug !== "string" || !slug || slug.length > 200) return null;
  return productBySlug(getDb(), workspaceId, slug);
}

/**
 * Answer a core email action: queue its effects (email.submit / email.cancel) only after the DB
 * write committed, then return the plain sentence or 200.
 */
export async function answer<T extends object>(r: EmailActionResult<T>, extra: (r: T) => object = () => ({})): Promise<Response> {
  if (!r.ok) return json(409, { error: r.reason, ...(r.issues ? { issues: r.issues } : {}) });
  await applyBroadcastEffects(r.effects);
  return json(200, { ok: true, ...extra(r as unknown as T) });
}

/** D19: vault first, then the env var named after the purpose (resend.api_key → RESEND_API_KEY). */
export function resendCtx(workspaceId: string): ProviderCtx {
  return { secret: (p) => resolveSecret(getDb(), workspaceId, p, purposeEnvName(p)) };
}

/** A plain sentence for anything Resend (or the vault) threw. */
export function resendErrorMessage(err: unknown): string {
  if (err instanceof VaultKeyError) return VAULT_KEY_MISSING;
  if (err instanceof ResendKeyMissing) return err.message;
  const status = err instanceof ResendError || err instanceof ProviderHttpError ? err.status : null;
  if (status === 401 || status === 403) return "Resend didn't accept the API key. Check it in Settings → Keys (it needs full access, not sending only).";
  if (status === 429) return "Resend is busy right now. Wait a minute and try again.";
  if (status !== null && status >= 500) return "Resend had a problem on their side. Try again in a few minutes.";
  return "Couldn't reach Resend. Try again in a minute.";
}
