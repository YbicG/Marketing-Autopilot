import type { Db } from "@mkt/db";
import { resolveSecret } from "@mkt/core/security";
import type { ProviderCtx } from "@mkt/providers";
import type { LoginSecret } from "../capture/demo/recorder.ts";

/** D19 env fallback name for a vault purpose: "upload_post.api_key" → "UPLOAD_POST_API_KEY". */
export function envNameFor(purpose: string): string {
  return purpose.toUpperCase().replace(/[^A-Z0-9]+/g, "_");
}

/** Provider calls resolve secrets vault-first, then env (D19). */
export function providerCtxFor(db: Db, workspaceId: string): ProviderCtx {
  return { secret: (purpose) => resolveSecret(db, workspaceId, purpose, envNameFor(purpose)) };
}

/** Demo test logins live only in the vault (never env), stored as JSON { username, password, loginPath? }. */
export function parseLoginSecret(raw: string | null): LoginSecret | null {
  if (!raw) return null;
  try {
    const v = JSON.parse(raw) as Partial<LoginSecret>;
    if (typeof v.username !== "string" || typeof v.password !== "string" || !v.username || !v.password) return null;
    return { username: v.username, password: v.password, ...(typeof v.loginPath === "string" && v.loginPath.startsWith("/") ? { loginPath: v.loginPath } : {}) };
  } catch {
    return null;
  }
}

export function loginResolver(db: Db) {
  return async (workspaceId: string, purpose: string) => parseLoginSecret(await resolveSecret(db, workspaceId, purpose));
}
