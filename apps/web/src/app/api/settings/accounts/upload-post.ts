import { env } from "@mkt/core/config";
import { purposeEnvName } from "@mkt/core/cost";
import { resolveSecret, VaultKeyError } from "@mkt/core/security";
import { createUploadPost, ProviderHttpError, type ProviderCtx, type PublisherAdapter } from "@mkt/providers";
import { VAULT_KEY_MISSING } from "@/components/settings/vault";
import { getDb } from "@/lib/db";

/** Server only: the Upload-Post adapter for Settings → Where to post, with D19 secret lookup. */
export function uploadPostFor(workspaceId: string): { adapter: PublisherAdapter; ctx: ProviderCtx } {
  const db = getDb();
  return {
    // ?connected=1 tells the page it came back from a hosted connect link, so it syncs accounts.
    adapter: createUploadPost({ redirectUrl: `${env().APP_BASE_URL}/settings/accounts?connected=1` }),
    ctx: { secret: (p) => resolveSecret(db, workspaceId, p, purposeEnvName(p)) },
  };
}

/** A plain sentence for anything Upload-Post (or the vault) threw. */
export function uploadPostError(err: unknown): string {
  if (err instanceof VaultKeyError) return VAULT_KEY_MISSING;
  if (err instanceof ProviderHttpError) {
    if (err.status === 401 || err.status === 403) return "Upload-Post didn't accept the API key. Check it in Settings → Keys.";
    if (err.status === 429) return "Upload-Post is busy right now. Wait a minute and try again.";
    if (err.status >= 500) return "Upload-Post had a problem on their side. Try again in a few minutes.";
  }
  const msg = err instanceof Error ? err.message : "";
  if (msg.startsWith("Add your Upload-Post API key")) return msg;
  return "Couldn't reach Upload-Post. Try again in a minute.";
}
