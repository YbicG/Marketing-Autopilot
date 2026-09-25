import type { MaintJobs } from "@mkt/core/queue";
import type { AccountHealth, Platform, ProviderCtx, PublisherAdapter } from "@mkt/providers";

/**
 * maint.connections_health: asks each publisher about every connected account and writes back
 * status / token expiry / last check. A `reauth_required` row is what Today shows as
 * "Reconnect your TikTok". One health call per (workspace, publisher, profile).
 *
 * The worker has no drizzle-orm dependency, so the two queries come in through ConnectionStore
 * (see the wiring notes in the M2 report for the drizzle implementation).
 */
export type ConnectionStatus = "active" | "reauth_required" | "revoked" | "error";

export interface ConnectionRow {
  id: string;
  workspaceId: string;
  publisher: string;
  platform: string;
  profileRef: string;
  status: ConnectionStatus;
}

export interface ConnectionPatch {
  status: ConnectionStatus;
  tokenExpiresAt: Date | null;
  lastHealthAt: Date;
  handle?: string;
}

export interface ConnectionStore {
  /** Every connection that isn't revoked (reauth_required ones too, so they can recover). */
  listChecked(): Promise<ConnectionRow[]>;
  /** Workspace-scoped update by id. */
  update(workspaceId: string, id: string, patch: ConnectionPatch): Promise<void>;
}

export interface ConnectionsHealthDeps {
  store: ConnectionStore;
  adapterFor(publisher: string): PublisherAdapter | undefined;
  ctxFor(workspaceId: string): ProviderCtx;
  now?: () => Date;
  log?: (msg: string, extra?: Record<string, unknown>) => void;
}

/** A connection the publisher no longer lists needs the user to reconnect it. */
export function patchFor(conn: ConnectionRow, health: AccountHealth[], now: Date): ConnectionPatch {
  const h = health.find((a) => a.platform === (conn.platform as Platform));
  if (!h) return { status: "reauth_required", tokenExpiresAt: null, lastHealthAt: now };
  const expires = h.tokenExpiresAt ? new Date(h.tokenExpiresAt) : null;
  const expired = expires !== null && !Number.isNaN(expires.getTime()) && expires <= now;
  return {
    status: expired && h.status === "active" ? "reauth_required" : h.status,
    tokenExpiresAt: expires && !Number.isNaN(expires.getTime()) ? expires : null,
    lastHealthAt: now,
    ...(h.handle ? { handle: h.handle } : {}),
  };
}

export async function connectionsHealth(
  deps: ConnectionsHealthDeps,
  _data: MaintJobs["maint.connections_health"],
): Promise<{ checked: number; reauth: number; failedProfiles: number }> {
  const now = deps.now?.() ?? new Date();
  const log = deps.log ?? ((m, e) => console.warn(m, e ?? ""));
  const groups = new Map<string, ConnectionRow[]>();
  for (const c of await deps.store.listChecked()) {
    if (c.status === "revoked") continue;
    const k = `${c.workspaceId}\u0000${c.publisher}\u0000${c.profileRef}`;
    groups.set(k, [...(groups.get(k) ?? []), c]);
  }

  let checked = 0;
  let reauth = 0;
  let failedProfiles = 0;
  for (const conns of groups.values()) {
    const first = conns[0]!;
    const adapter = deps.adapterFor(first.publisher);
    if (!adapter) continue;
    let health: AccountHealth[];
    try {
      health = await adapter.health(deps.ctxFor(first.workspaceId), first.profileRef);
    } catch (err) {
      // A flaky API call must not flip every account to "reconnect": leave rows as they are.
      failedProfiles++;
      log("[worker] connection health check failed", { publisher: first.publisher, workspaceId: first.workspaceId, error: (err as Error).message });
      continue;
    }
    for (const c of conns) {
      const patch = patchFor(c, health, now);
      await deps.store.update(c.workspaceId, c.id, patch);
      checked++;
      if (patch.status === "reauth_required") reauth++;
    }
  }
  return { checked, reauth, failedProfiles };
}
