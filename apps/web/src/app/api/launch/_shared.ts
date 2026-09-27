import { productBySlug } from "@mkt/core/ingest";
import { LaunchPlanError } from "@mkt/core/launch";
import { getDb } from "@/lib/db";
import { isSameOrigin, json, sessionFromRequest, type SessionWorkspace } from "@/lib/session";

// Shared by the Launch tab routes (plan, tasks, tracking, audit, x-links). Not a route. The kits/
// routes belong to the launch kit screen and don't use this.

export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function readBody(req: Request): Promise<Record<string, unknown>> {
  try {
    const b: unknown = await req.json();
    return b && typeof b === "object" && !Array.isArray(b) ? (b as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/** Same-origin + signed in. None of these routes lets anything publish, so no UiSession (D9). */
export async function launchSession(req: Request): Promise<{ ok: true; s: SessionWorkspace } | { ok: false; res: Response }> {
  if (!isSameOrigin(req)) return { ok: false, res: json(403, { error: "Cross-origin request refused." }) };
  const s = await sessionFromRequest(req);
  if (!s) return { ok: false, res: json(401, { error: "Sign in again." }) };
  return { ok: true, s };
}

export async function productFor(workspaceId: string, slug: string) {
  return productBySlug(getDb(), workspaceId, slug);
}

const STATUS_BY_CODE: Record<LaunchPlanError["code"], number> = {
  not_found: 404,
  gate_manual: 409,
  auto_manual: 409,
  blocked: 409,
  not_optional: 409,
  no_website: 409,
  bad_url: 400,
  bad_dates: 409,
  bad_template: 500,
};

/** LaunchPlanError messages are already plain sentences; anything else is logged and hidden. */
export function launchError(err: unknown): Response {
  if (err instanceof LaunchPlanError && err.code !== "bad_template") return json(STATUS_BY_CODE[err.code] ?? 400, { error: err.message, code: err.code });
  console.error("[launch route]", err);
  return json(500, { error: "That didn't work. Try again in a minute." });
}
