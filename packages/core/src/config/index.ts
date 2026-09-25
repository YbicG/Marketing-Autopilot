import { z } from "zod";

const Env = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  DATABASE_URL: z.string().url(),
  REDIS_URL: z.string().url(),
  APP_BASE_URL: z.string().url().default("http://localhost:3000"),
  STORAGE_DRIVER: z.enum(["fs", "r2"]).default("fs"),
  FS_ROOT: z.string().default("./data"),
  PROVIDER_MODE: z.enum(["live", "replay", "fake"]).default("live"),
  REMOTION_CONCURRENCY: z.coerce.number().int().min(1).max(8).default(2),
  WORKER_ROLES: z.string().default("all"),
  SELF_IPS: z
    .string()
    .default("")
    .transform((s) => s.split(",").map((x) => x.trim()).filter(Boolean)),
  MISSED_SLOT_GRACE_MIN: z.coerce.number().int().positive().default(120),
  SSRF_ALLOWLIST: z.string().optional(),
  /** Egress proxy for capture and safe-fetch; unset means direct (dev/tests only). */
  SMOKESCREEN_URL: z.string().url().optional(),
  /** Optional, for a higher GitHub REST rate limit; public repos work without it. */
  GITHUB_TOKEN: z.string().optional(),
  // ── M2 ──
  /** Vault key-encryption keys: MKT_KEK_V1_B64 (32 bytes, base64); MKT_KEK_ACTIVE picks the one new secrets use. */
  MKT_KEK_ACTIVE: z.coerce.number().int().positive().default(1),
  /** HMAC key for UI-minted confirm tokens (Finalize, ad activation, spend over PAT limits). */
  CONFIRM_TOKEN_SECRET: z.string().optional(),
  R2_ACCOUNT_ID: z.string().optional(),
  R2_ACCESS_KEY_ID: z.string().optional(),
  R2_SECRET_ACCESS_KEY: z.string().optional(),
  R2_BUCKET: z.string().default("mkt-private"),
  /** Optional dead-man check (Healthchecks.io) pinged by maint.heartbeat every 5 min. */
  HEALTHCHECK_PING_URL: z.string().url().optional(),
  /** SyllaCal-style first-party aggregate endpoint token, for conversion pulls (M2 PR 1). */
  FIRSTPARTY_ANALYTICS_TOKEN: z.string().optional(),
  // ── M3a ──
  /** Path to ffmpeg/ffprobe inside the worker image. */
  FFMPEG_PATH: z.string().default("ffmpeg"),
  FFPROBE_PATH: z.string().default("ffprobe"),
});
export type Env = z.infer<typeof Env>;

let cached: Env | undefined;

export function env(): Env {
  if (cached) return cached;
  const parsed = Env.parse(process.env);
  if (parsed.NODE_ENV === "production" && parsed.SSRF_ALLOWLIST) {
    throw new Error("SSRF_ALLOWLIST is for tests only and is refused in production");
  }
  cached = parsed;
  return cached;
}

/** Secrets come from env until the vault lands in M2 (D19). Never falls back to a default. */
export function secret(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required secret: ${name}`);
  return value;
}
