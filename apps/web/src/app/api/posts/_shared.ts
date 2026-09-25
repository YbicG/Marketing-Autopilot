import { env } from "@mkt/core/config";
import { PostActionError, PostConflict, TransitionError, type Actor } from "@mkt/core/publishing";
import { resolveSecret } from "@mkt/core/security";
import type { ProviderCtx } from "@mkt/providers";
import { getDb } from "@/lib/db";
import { publishEffects } from "@/lib/queues";
import { json } from "@/lib/session";

// Shared by the approvals, posts, pause and assisted routes (W2). Not a route: no route.ts here.

export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const graceMin = () => env().MISSED_SLOT_GRACE_MIN;

export const userActor = (userId: string): Actor => ({ type: "user", id: userId });

/** PublishDeps subset for pause/resume/manual: they run their own queue effects through the gateway. */
export function publishDeps() {
  return { db: getDb(), graceMin: graceMin(), ...publishEffects() };
}

/** D19: vault first, then the env var named after the purpose ("upload_post.api_key" → UPLOAD_POST_API_KEY). */
export function providerCtx(workspaceId: string): ProviderCtx {
  return {
    secret: (purpose) => resolveSecret(getDb(), workspaceId, purpose, purpose.toUpperCase().replace(/[^A-Z0-9]+/g, "_")),
  };
}

export async function readBody(req: Request): Promise<Record<string, unknown>> {
  try {
    const b: unknown = await req.json();
    return b && typeof b === "object" && !Array.isArray(b) ? (b as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/** Plain-sentence errors from core become 400/409; anything else is logged and hidden. */
export function errorResponse(err: unknown): Response {
  if (err instanceof PostActionError) return json(400, { error: err.message });
  if (err instanceof TransitionError) return json(409, { error: `${err.message}. Refresh the page.` });
  if (err instanceof PostConflict) return json(409, { error: "This post just changed. Refresh the page and try again." });
  if (err instanceof Error && /^(Post not found|Task not found|Paste the link|Open the community|A post that is)/.test(err.message)) {
    return json(400, { error: err.message.endsWith(".") ? err.message : `${err.message}.` });
  }
  console.error("[publishing route]", err);
  return json(500, { error: "That didn't work. Try again in a minute." });
}
