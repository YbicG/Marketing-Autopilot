import path from "node:path";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";

const url = process.env.DATABASE_URL;
if (!url) throw new Error("DATABASE_URL is required");

const sql = postgres(url, { max: 1 });
await migrate(drizzle(sql), { migrationsFolder: path.join(import.meta.dirname, "../migrations") });
await sql.end();
console.log("[migrate] done");
