import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { env } from "@mkt/core/config";
import { workspaceIdForUser } from "@mkt/core/tenancy";
import { getAuth } from "./auth";
import { getDb } from "./db";

export interface SessionWorkspace {
  userId: string;
  name: string;
  workspaceId: string;
}

async function load(h: Headers): Promise<SessionWorkspace | null> {
  const session = await getAuth().api.getSession({ headers: h });
  if (!session) return null;
  const workspaceId = await workspaceIdForUser(getDb(), session.user.id);
  if (!workspaceId) return null;
  return { userId: session.user.id, name: session.user.name, workspaceId };
}

/** Pages: redirect to sign-in when there's no session. */
export async function requireWorkspace(): Promise<SessionWorkspace> {
  const s = await load(await headers());
  if (!s) redirect("/signin");
  return s;
}

/** API routes: null means 401. */
export function sessionFromRequest(req: Request): Promise<SessionWorkspace | null> {
  return load(req.headers);
}

/**
 * D9: state-changing requests must come from our own origin, as well as carrying the session cookie.
 * better-auth's SameSite=Lax cookie already blocks most cross-site POSTs; this closes the rest.
 */
export function isSameOrigin(req: Request): boolean {
  const origin = req.headers.get("origin");
  const base = env().APP_BASE_URL;
  if (!origin) return false;
  try {
    return new URL(origin).origin === new URL(base).origin;
  } catch {
    return false;
  }
}

export function json(status: number, body: unknown): Response {
  return Response.json(body, { status });
}
