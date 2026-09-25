import { createDb, type Db } from "@mkt/db";
import { env } from "@mkt/core/config";

let db: Db | undefined;

/** Lazy, so `next build` (which has no env) never opens a connection. */
export function getDb(): Db {
  db ??= createDb(env().DATABASE_URL).db;
  return db;
}
