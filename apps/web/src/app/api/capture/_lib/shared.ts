// Shared by the demo capture routes (W4). Not a route: no route.ts here.

import { CaptureFlowError } from "@mkt/core/capture";
import { productBySlug } from "@mkt/core/ingest";
import { getDb } from "@/lib/db";
import { isSameOrigin, json, sessionFromRequest, type SessionWorkspace } from "@/lib/session";
import { requireUiSession } from "@/lib/ui-session";

export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type Product = NonNullable<Awaited<ReturnType<typeof productBySlug>>>;

/**
 * Session + Origin (+ the CSRF header and UI session when `ui`) + the product. setTrustedOrigin,
 * the demo login and confirmFlow are UI-only (D9/D26), so their routes pass `ui: true`.
 */
export async function captureAuth(
  req: Request,
  slug: string,
  opts: { ui?: boolean } = {},
): Promise<{ ok: true; s: SessionWorkspace; product: Product } | { ok: false; res: Response }> {
  let s: SessionWorkspace;
  if (opts.ui) {
    const auth = await requireUiSession(req);
    if (!auth.ok) return auth;
    s = auth.s;
  } else {
    if (!isSameOrigin(req)) return { ok: false, res: json(403, { error: "Cross-origin request refused." }) };
    const got = await sessionFromRequest(req);
    if (!got) return { ok: false, res: json(401, { error: "Please sign in." }) };
    s = got;
  }
  const product = await productBySlug(getDb(), s.workspaceId, slug);
  if (!product) return { ok: false, res: json(404, { error: "Project not found." }) };
  return { ok: true, s, product };
}

/** Where the page's own words differ from core's (the address lives on this page, not Settings). */
const PAGE_WORDS: Partial<Record<CaptureFlowError["code"], string>> = {
  no_origin: "Add the demo site's internal address at the top of this page first.",
  bad_origin: "The demo site's address isn't an internal service name. Fix it at the top of this page.",
};

export function captureError(err: unknown): Response {
  if (err instanceof CaptureFlowError) {
    const status = err.code === "not_found" ? 404 : err.code === "needs_confirm" || err.code === "no_origin" ? 409 : 400;
    return json(status, { error: PAGE_WORDS[err.code] ?? err.message });
  }
  const e = err as { code?: unknown; name?: unknown };
  if (e?.code === "budget_exceeded") return json(402, { error: "You've hit your spending limit. Raise it in Settings → Spending to carry on." });
  if (e?.name === "ClaudeRefused") return json(422, { error: "Claude wouldn't plan those. Try again later, or add a flow yourself." });
  if (e?.name === "StructuredOutputInvalid") return json(502, { error: "The answer came back broken. Try again." });
  console.error("[capture route]", err);
  return json(500, { error: "That didn't work. Try again in a minute." });
}

export async function readJson(req: Request): Promise<Record<string, unknown>> {
  try {
    const b: unknown = await req.json();
    return b && typeof b === "object" && !Array.isArray(b) ? (b as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}
