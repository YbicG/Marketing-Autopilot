import type { ListingStorage, StoredObject } from "@mkt/core/media";
import type { MaintJobs } from "@mkt/core/queue";

/** maint.storage_gc (weekly): scratch files under ws/<id>/tmp/ older than 7 days. Nothing else is touched. */
export const TMP_RETENTION_DAYS = 7;
const TMP_KEY = /^ws\/[a-z0-9-]+\/tmp\//;

export interface StorageGcDeps {
  storage: ListingStorage;
  now?: () => Date;
  log?: (msg: string, extra?: Record<string, unknown>) => void;
}

export function gcCandidates(objects: StoredObject[], now: Date, days = TMP_RETENTION_DAYS): string[] {
  const cutoff = now.getTime() - days * 86_400_000;
  return objects.filter((o) => TMP_KEY.test(o.key) && o.lastModified.getTime() < cutoff).map((o) => o.key);
}

export async function storageGc(deps: StorageGcDeps, _data: MaintJobs["maint.storage_gc"]): Promise<{ deleted: number }> {
  const now = deps.now?.() ?? new Date();
  const keys = gcCandidates(await deps.storage.list("ws/"), now);
  for (const k of keys) await deps.storage.delete(k);
  (deps.log ?? ((m, e) => console.log(m, e ?? "")))("[worker] storage gc", { deleted: keys.length });
  return { deleted: keys.length };
}
