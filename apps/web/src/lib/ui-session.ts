import { uiSessionFromCookie, type UiSession } from "@mkt/core/publishing";
import { isSameOrigin, json, sessionFromRequest, type SessionWorkspace } from "./session";

export const CSRF_HEADER = "x-mkt-csrf";

/**
 * D9: approvals (and anything else that must only come from a person in the web UI) need the
 * better-auth cookie session, our Origin, and the custom CSRF header that postJson sends. A
 * cross-site form can't set a custom header, and a cross-origin fetch with one needs a preflight
 * we never answer. Returns the UiSession brand, or the Response to send back.
 */
export async function requireUiSession(req: Request): Promise<{ ok: true; s: SessionWorkspace; ui: UiSession } | { ok: false; res: Response }> {
  const s = await sessionFromRequest(req);
  if (!s) return { ok: false, res: json(401, { error: "Sign in again." }) };
  if (!isSameOrigin(req)) return { ok: false, res: json(403, { error: "Cross-origin request refused." }) };
  if (req.headers.get(CSRF_HEADER) !== "1") return { ok: false, res: json(403, { error: "Refresh the page and try again." }) };
  return { ok: true, s, ui: uiSessionFromCookie({ userId: s.userId, workspaceId: s.workspaceId, originChecked: true, csrfChecked: true }) };
}
