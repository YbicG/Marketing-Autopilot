import { envKeyring, VaultKeyError } from "@mkt/core/security";

/** Server only. The plain sentence shown when the vault key isn't set up in Dokploy yet. */
export const VAULT_KEY_MISSING =
  "The key vault isn't set up yet. Add MKT_KEK_V1_B64 (32 random bytes, base64) in Dokploy's Environment tab, redeploy, then come back.";

/** Whether new secrets can be sealed: the active KEK exists and is 32 bytes. Never reads a secret. */
export function vaultStatus(): { ready: true } | { ready: false; message: string } {
  try {
    const k = envKeyring();
    k.kek(k.active);
    return { ready: true };
  } catch (err) {
    if (err instanceof VaultKeyError) return { ready: false, message: `${VAULT_KEY_MISSING} (${err.message}.)` };
    throw err;
  }
}

/** "Oct 3, 2026" in the server's locale-free format. */
export function shortDate(d: Date | null | undefined): string {
  if (!d) return "—";
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });
}
