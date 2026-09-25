import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  check,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

const ts = (name: string) => timestamp(name, { withTimezone: true });
const micros = (name: string) => bigint(name, { mode: "number" });
const createdAt = () => ts("created_at").notNull().defaultNow();

// ── better-auth core tables (plural names; the adapter runs with usePlural) ──
// better-auth owns these ids (text). Tenant tables below use app-generated UUIDv7.

export const users = pgTable("users", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  email: text("email").notNull().unique(),
  emailVerified: boolean("email_verified").notNull().default(false),
  image: text("image"),
  githubLogin: text("github_login"), // better-auth additional field; the allowlist checks it
  createdAt: createdAt(),
  updatedAt: ts("updated_at").notNull().defaultNow(),
});

export const sessions = pgTable("sessions", {
  id: text("id").primaryKey(),
  expiresAt: ts("expires_at").notNull(),
  token: text("token").notNull().unique(),
  ipAddress: text("ip_address"),
  userAgent: text("user_agent"),
  userId: text("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  createdAt: createdAt(),
  updatedAt: ts("updated_at").notNull().defaultNow(),
});

export const accounts = pgTable("accounts", {
  id: text("id").primaryKey(),
  accountId: text("account_id").notNull(),
  providerId: text("provider_id").notNull(),
  userId: text("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  accessToken: text("access_token"),
  refreshToken: text("refresh_token"),
  idToken: text("id_token"),
  accessTokenExpiresAt: ts("access_token_expires_at"),
  refreshTokenExpiresAt: ts("refresh_token_expires_at"),
  scope: text("scope"),
  password: text("password"),
  createdAt: createdAt(),
  updatedAt: ts("updated_at").notNull().defaultNow(),
});

export const verifications = pgTable("verifications", {
  id: text("id").primaryKey(),
  identifier: text("identifier").notNull(),
  value: text("value").notNull(),
  expiresAt: ts("expires_at").notNull(),
  createdAt: createdAt(),
  updatedAt: ts("updated_at").notNull().defaultNow(),
});

// ── tenancy ──

export const workspaces = pgTable("workspaces", {
  id: uuid("id").primaryKey(),
  name: text("name").notNull(),
  timezone: text("timezone").notNull().default("America/New_York"),
  /** First-run setting (§2.3). Hard stop at 100%. */
  monthlyLimitMicros: micros("monthly_limit_micros").notNull().default(60_000_000),
  onboardedAt: ts("onboarded_at"),
  createdAt: createdAt(),
});

export const workspaceMembers = pgTable(
  "workspace_members",
  {
    id: uuid("id").primaryKey(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    role: text("role", { enum: ["owner"] }).notNull().default("owner"),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("workspace_members_ws_user").on(t.workspaceId, t.userId)],
);

export const auditLog = pgTable(
  "audit_log",
  {
    id: uuid("id").primaryKey(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    actorType: text("actor_type", { enum: ["user", "pat", "worker", "webhook"] }).notNull(),
    actorId: text("actor_id"),
    action: text("action").notNull(),
    entity: text("entity"),
    data: jsonb("data").$type<Record<string, unknown>>(),
    createdAt: createdAt(),
  },
  (t) => [index("audit_log_ws_created").on(t.workspaceId, t.createdAt)],
);

// ── cost (§7) ──

/** Global rate card, not tenant-scoped. Rates are micro-dollars per unit (per MTok for tokens). */
export const pricingRates = pgTable(
  "pricing_rates",
  {
    id: uuid("id").primaryKey(),
    provider: text("provider").notNull(),
    model: text("model").notNull(),
    unit: text("unit", {
      enum: ["input_mtok", "output_mtok", "cache_read_mtok", "cache_write_5m_mtok", "cache_write_1h_mtok", "web_search_request"],
    }).notNull(),
    microsPerUnit: micros("micros_per_unit").notNull(),
    verified: boolean("verified").notNull().default(false),
    source: text("source"),
    effectiveFrom: ts("effective_from").notNull().defaultNow(),
  },
  (t) => [uniqueIndex("pricing_rates_key").on(t.provider, t.model, t.unit, t.effectiveFrom)],
);

export const budgetPeriods = pgTable(
  "budget_periods",
  {
    id: uuid("id").primaryKey(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    scope: text("scope", { enum: ["global_month", "run", "pat", "ads"] }).notNull(),
    scopeRef: text("scope_ref").notNull().default(""),
    periodMonth: text("period_month").notNull(), // "2026-10"; runs use their start month
    capMicros: micros("cap_micros").notNull(),
    spentMicros: micros("spent_micros").notNull().default(0),
    reservedMicros: micros("reserved_micros").notNull().default(0),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex("budget_periods_key").on(t.workspaceId, t.scope, t.scopeRef, t.periodMonth),
    check("budget_periods_nonneg", sql`${t.spentMicros} >= 0 AND ${t.reservedMicros} >= 0`),
  ],
);

export const providerCalls = pgTable(
  "provider_calls",
  {
    id: uuid("id").primaryKey(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    runId: uuid("run_id"),
    feature: text("feature").notNull(),
    provider: text("provider").notNull(),
    requestedModel: text("requested_model"),
    servedModel: text("served_model"),
    status: text("status", { enum: ["reserved", "settled", "released"] }).notNull(),
    budgetPeriodIds: uuid("budget_period_ids").array().notNull(),
    estMicros: micros("est_micros").notNull(),
    actualMicros: micros("actual_micros"),
    serverToolFeesMicros: micros("server_tool_fees_micros").notNull().default(0),
    usage: jsonb("usage").$type<Record<string, unknown>>(),
    providerRequestId: text("provider_request_id"),
    batchId: text("batch_id"),
    error: text("error"),
    createdAt: createdAt(),
    settledAt: ts("settled_at"),
  },
  (t) => [index("provider_calls_ws_created").on(t.workspaceId, t.createdAt)],
);

/** Append-only. reserve (+est) · release (−est) · settle (+actual) · adjust · external (subscriptions). */
export const spendLedger = pgTable(
  "spend_ledger",
  {
    id: uuid("id").primaryKey(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    providerCallId: uuid("provider_call_id").references(() => providerCalls.id, { onDelete: "cascade" }),
    kind: text("kind", { enum: ["reserve", "release", "settle", "adjust", "external"] }).notNull(),
    micros: micros("micros").notNull(),
    periodMonth: text("period_month").notNull(),
    note: text("note"),
    createdAt: createdAt(),
  },
  (t) => [index("spend_ledger_ws_month").on(t.workspaceId, t.periodMonth)],
);

// ── runs ──

export const generationRuns = pgTable(
  "generation_runs",
  {
    id: uuid("id").primaryKey(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    productId: uuid("product_id"),
    kind: text("kind", { enum: ["m0_summary", "ingest", "strategy", "dna_regenerate", "package", "refill", "finalize"] }).notNull(),
    status: text("status", { enum: ["queued", "running", "needs_review", "completed", "failed", "canceled", "paused_budget"] }).notNull(),
    input: jsonb("input").$type<Record<string, unknown>>().notNull(),
    result: jsonb("result").$type<Record<string, unknown>>(),
    capMicros: micros("cap_micros").notNull(),
    error: text("error"),
    createdAt: createdAt(),
    startedAt: ts("started_at"),
    finishedAt: ts("finished_at"),
  },
  (t) => [index("generation_runs_ws_created").on(t.workspaceId, t.createdAt)],
);

/** In-app spend alerts (§7.1 step 7): one row per scope period per threshold crossed. */
export const budgetAlerts = pgTable(
  "budget_alerts",
  {
    id: uuid("id").primaryKey(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    budgetPeriodId: uuid("budget_period_id")
      .notNull()
      .references(() => budgetPeriods.id, { onDelete: "cascade" }),
    thresholdPct: integer("threshold_pct").notNull(),
    spentMicros: micros("spent_micros").notNull(),
    capMicros: micros("cap_micros").notNull(),
    dismissedAt: ts("dismissed_at"),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("budget_alerts_key").on(t.budgetPeriodId, t.thresholdPct)],
);

// ── products and sources (§4.2, M1) ──

export const products = pgTable(
  "products",
  {
    id: uuid("id").primaryKey(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    slug: text("slug").notNull(),
    name: text("name").notNull(),
    kind: text("kind", { enum: ["web_b2c", "web_b2b", "mobile", "devtool", "unknown"] }).notNull().default("unknown"),
    status: text("status", { enum: ["active", "parked"] }).notNull().default("active"),
    urls: jsonb("urls").$type<{ website?: string; repo?: string }>().notNull().default({}),
    currentDnaVersionId: uuid("current_dna_version_id"),
    /** D26: the internal demo origin capture may reach (e.g. http://syllacal-demo:3000), set in the UI only. */
    trustedCaptureOrigin: text("trusted_capture_origin"),
    captureRouteDenylist: text("capture_route_denylist").array().notNull().default([]),
    /** YouTube madeForKids, asked once per project (§2.3 TikTok composer row). */
    madeForKids: boolean("made_for_kids"),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("products_ws_slug").on(t.workspaceId, t.slug)],
);

/** A project folder the browser uploaded (allowlisted files only), before a run picks it up. */
export const folderUploads = pgTable("folder_uploads", {
  id: uuid("id").primaryKey(),
  workspaceId: uuid("workspace_id")
    .notNull()
    .references(() => workspaces.id, { onDelete: "cascade" }),
  rootName: text("root_name").notNull(),
  files: jsonb("files")
    .$type<{ path: string; kind: string; size: number; storageKey: string; secretHits: number }[]>()
    .notNull(),
  gitRemote: text("git_remote"),
  secretHits: integer("secret_hits").notNull().default(0),
  createdAt: createdAt(),
});

export const sources = pgTable(
  "sources",
  {
    id: uuid("id").primaryKey(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    productId: uuid("product_id")
      .notNull()
      .references(() => products.id, { onDelete: "cascade" }),
    runId: uuid("run_id"),
    kind: text("kind", { enum: ["website", "github", "folder_upload", "text"] }).notNull(),
    url: text("url"),
    visibility: text("visibility", { enum: ["public_ok", "internal"] }).notNull(),
    parentSourceId: uuid("parent_source_id"),
    status: text("status", { enum: ["pending", "fetched", "failed", "skipped"] }).notNull().default("pending"),
    contentHash: text("content_hash"),
    secretScanHits: integer("secret_scan_hits").notNull().default(0),
    meta: jsonb("meta").$type<Record<string, unknown>>().notNull().default({}),
    error: text("error"),
    createdAt: createdAt(),
  },
  (t) => [index("sources_product").on(t.productId)],
);

/** Text pulled from a source: a page as markdown, a README, a doc, package.json facts, notes. */
export const sourceArtifacts = pgTable(
  "source_artifacts",
  {
    id: uuid("id").primaryKey(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    sourceId: uuid("source_id")
      .notNull()
      .references(() => sources.id, { onDelete: "cascade" }),
    kind: text("kind", { enum: ["page", "readme", "doc", "package_json", "repo_meta", "notes", "brand"] }).notNull(),
    title: text("title"),
    url: text("url"),
    path: text("path"),
    text: text("text").notNull(),
    meta: jsonb("meta").$type<Record<string, unknown>>().notNull().default({}),
    createdAt: createdAt(),
  },
  (t) => [index("source_artifacts_source").on(t.sourceId)],
);

export const assets = pgTable(
  "assets",
  {
    id: uuid("id").primaryKey(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    productId: uuid("product_id").references(() => products.id, { onDelete: "cascade" }),
    sourceId: uuid("source_id").references(() => sources.id, { onDelete: "set null" }),
    kind: text("kind", { enum: ["screenshot", "image", "recording", "video", "audio", "still", "pdf"] }).notNull(),
    origin: text("origin", { enum: ["captured", "uploaded", "generated", "licensed", "template"] }).notNull(),
    provenanceTier: text("provenance_tier", { enum: ["A", "B", "C"] }).notNull().default("A"),
    mime: text("mime").notNull(),
    width: integer("width"),
    height: integer("height"),
    sha256: text("sha256").notNull(),
    storageKey: text("storage_key").notNull(),
    /** Page URL + viewport for captures; the file path for uploads. */
    origination: jsonb("origination").$type<Record<string, unknown>>().notNull().default({}),
    labels: jsonb("labels").$type<Record<string, unknown>>(),
    piiHits: boolean("pii_hits").notNull().default(false),
    durationMs: integer("duration_ms"),
    sizeBytes: bigint("size_bytes", { mode: "number" }),
    /** Recordings (M3b): storage key of the click log JSON. */
    clickLogKey: text("click_log_key"),
    ocrText: text("ocr_text"),
    phash: text("phash"),
    licenseRef: text("license_ref"),
    xmpWritten: boolean("xmp_written").notNull().default(false),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex("assets_ws_sha_kind").on(t.workspaceId, t.sha256, t.kind),
    index("assets_product").on(t.productId),
  ],
);

/** Findings from the research loop's client tools (record_finding / record_competitor / record_pain). */
export const researchItems = pgTable(
  "research_items",
  {
    id: uuid("id").primaryKey(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    productId: uuid("product_id")
      .notNull()
      .references(() => products.id, { onDelete: "cascade" }),
    runId: uuid("run_id").notNull(),
    kind: text("kind", { enum: ["finding", "competitor", "pain"] }).notNull(),
    data: jsonb("data").$type<Record<string, unknown>>().notNull(),
    sourceUrl: text("source_url"),
    createdAt: createdAt(),
  },
  (t) => [index("research_items_run").on(t.runId)],
);

// ── DNA (§4.2) ──

export const productDnaVersions = pgTable(
  "product_dna_versions",
  {
    id: uuid("id").primaryKey(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    productId: uuid("product_id")
      .notNull()
      .references(() => products.id, { onDelete: "cascade" }),
    runId: uuid("run_id"),
    version: integer("version").notNull(),
    status: text("status", { enum: ["draft", "confirmed", "superseded"] }).notNull().default("draft"),
    dna: jsonb("dna").$type<Record<string, unknown>>().notNull(),
    fields: jsonb("fields").$type<Record<string, unknown>>().notNull(),
    /** Evidence-bundle ids: "S1" -> { sourceId, url, title, visibility }. */
    sourceMap: jsonb("source_map").$type<Record<string, unknown>>().notNull(),
    evidenceKey: text("evidence_key"),
    /** Percent of fields with at least one source (M1 done-when: 90 or more). */
    coveragePct: integer("coverage_pct").notNull().default(0),
    createdAt: createdAt(),
    confirmedAt: ts("confirmed_at"),
  },
  (t) => [uniqueIndex("dna_versions_product_version").on(t.productId, t.version)],
);

export const dnaGapQuestions = pgTable(
  "dna_gap_questions",
  {
    id: uuid("id").primaryKey(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    productId: uuid("product_id")
      .notNull()
      .references(() => products.id, { onDelete: "cascade" }),
    runId: uuid("run_id").notNull(),
    path: text("path").notNull(),
    question: text("question").notNull(),
    why: text("why"),
    options: jsonb("options").$type<string[]>().notNull().default([]),
    answer: text("answer"),
    skipped: boolean("skipped").notNull().default(false),
    answeredAt: ts("answered_at"),
    createdAt: createdAt(),
  },
  (t) => [index("dna_gap_questions_run").on(t.runId)],
);

export const claims = pgTable(
  "claims",
  {
    id: uuid("id").primaryKey(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    productId: uuid("product_id")
      .notNull()
      .references(() => products.id, { onDelete: "cascade" }),
    dnaVersionId: uuid("dna_version_id")
      .notNull()
      .references(() => productDnaVersions.id, { onDelete: "cascade" }),
    /** Short id the model uses (C1, C2...), unique per DNA version. */
    ref: text("ref").notNull(),
    kind: text("kind", { enum: ["stat", "feature", "testimonial", "comparison", "price"] }).notNull(),
    text: text("text").notNull(),
    quote: text("quote"),
    sourceRefs: text("source_refs").array().notNull(),
    publicOk: boolean("public_ok").notNull(),
    status: text("status", { enum: ["sourced", "verified", "rejected"] }).notNull().default("sourced"),
    verifiedBy: text("verified_by"),
    expiresAt: ts("expires_at"),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("claims_version_ref").on(t.dnaVersionId, t.ref)],
);

// ── strategy (§4.2) ──

export const strategies = pgTable("strategies", {
  id: uuid("id").primaryKey(),
  workspaceId: uuid("workspace_id")
    .notNull()
    .references(() => workspaces.id, { onDelete: "cascade" }),
  productId: uuid("product_id")
    .notNull()
    .references(() => products.id, { onDelete: "cascade" }),
  dnaVersionId: uuid("dna_version_id")
    .notNull()
    .references(() => productDnaVersions.id, { onDelete: "cascade" }),
  runId: uuid("run_id"),
  output: jsonb("output").$type<Record<string, unknown>>().notNull(),
  servedModel: text("served_model"),
  launchDate: text("launch_date"),
  createdAt: createdAt(),
});

export const angles = pgTable(
  "angles",
  {
    id: uuid("id").primaryKey(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    strategyId: uuid("strategy_id")
      .notNull()
      .references(() => strategies.id, { onDelete: "cascade" }),
    idx: integer("idx").notNull(),
    card: jsonb("card").$type<Record<string, unknown>>().notNull(),
    /** Test all 3, mostly #1: 60/20/20 by default (§2.5). */
    sharePct: integer("share_pct").notNull(),
    status: text("status", { enum: ["active", "stopped"] }).notNull().default("active"),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("angles_strategy_idx").on(t.strategyId, t.idx)],
);

// ── keys (§8 vault.ts, M2) ──

/** Envelope-encrypted secrets: a random DEK per row (AES-256-GCM) wrapped by MKT_KEK_V{n}. */
export const vaultSecrets = pgTable(
  "vault_secrets",
  {
    id: uuid("id").primaryKey(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    /** e.g. "upload_post.api_key", "upload_post.webhook_secret", "elevenlabs.api_key". */
    purpose: text("purpose").notNull(),
    kekVersion: integer("kek_version").notNull(),
    wrappedDek: text("wrapped_dek").notNull(),
    iv: text("iv").notNull(),
    tag: text("tag").notNull(),
    ciphertext: text("ciphertext").notNull(),
    /** Last 4 characters, for the Keys page. */
    hint: text("hint"),
    createdAt: createdAt(),
    rotatedAt: ts("rotated_at"),
  },
  (t) => [uniqueIndex("vault_secrets_ws_purpose").on(t.workspaceId, t.purpose)],
);

// ── publishing targets (§4.2, M2) ──

export const socialConnections = pgTable(
  "social_connections",
  {
    id: uuid("id").primaryKey(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    productId: uuid("product_id").references(() => products.id, { onDelete: "cascade" }),
    publisher: text("publisher", { enum: ["upload_post", "zernio", "direct"] }).notNull(),
    platform: text("platform").notNull(),
    handle: text("handle"),
    /** The publisher's profile id (one Upload-Post profile per product). */
    profileRef: text("profile_ref").notNull(),
    /** Personal X/Bluesky/LinkedIn accounts are shared across products: the per-account cap applies across them. */
    shared: boolean("shared").notNull().default(false),
    maxPerDay: integer("max_per_day").notNull().default(2),
    warmupUntil: ts("warmup_until"),
    status: text("status", { enum: ["active", "reauth_required", "revoked", "error"] }).notNull().default("active"),
    tokenExpiresAt: ts("token_expires_at"),
    capabilities: jsonb("capabilities").$type<Record<string, unknown>>().notNull().default({}),
    lastHealthAt: ts("last_health_at"),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex("social_connections_key").on(t.workspaceId, t.publisher, t.platform, t.profileRef),
    check("social_connections_max", sql`${t.maxPerDay} BETWEEN 1 AND 3`),
  ],
);

/** Posting slots per product and platform: local times in the workspace timezone. */
export const postingSchedules = pgTable(
  "posting_schedules",
  {
    id: uuid("id").primaryKey(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    productId: uuid("product_id")
      .notNull()
      .references(() => products.id, { onDelete: "cascade" }),
    platform: text("platform").notNull(),
    slots: jsonb("slots").$type<{ weekday: number; time: string }[]>().notNull(),
    maxPerDay: integer("max_per_day").notNull().default(2),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("posting_schedules_key").on(t.productId, t.platform)],
);

// ── campaigns and content (§4.2, M2) ──

/** Frozen cached prefix (§5.0 cache layout): compact DNA, public claims, angles, messaging, voice, platform rules. */
export const campaignBundles = pgTable(
  "campaign_bundles",
  {
    id: uuid("id").primaryKey(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    productId: uuid("product_id")
      .notNull()
      .references(() => products.id, { onDelete: "cascade" }),
    strategyId: uuid("strategy_id")
      .notNull()
      .references(() => strategies.id, { onDelete: "cascade" }),
    dnaVersionId: uuid("dna_version_id").notNull(),
    version: integer("version").notNull(),
    text: text("text").notNull(),
    claimRefs: text("claim_refs").array().notNull(),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("campaign_bundles_product_version").on(t.productId, t.version)],
);

export const campaigns = pgTable("campaigns", {
  id: uuid("id").primaryKey(),
  workspaceId: uuid("workspace_id")
    .notNull()
    .references(() => workspaces.id, { onDelete: "cascade" }),
  productId: uuid("product_id")
    .notNull()
    .references(() => products.id, { onDelete: "cascade" }),
  strategyId: uuid("strategy_id")
    .notNull()
    .references(() => strategies.id, { onDelete: "cascade" }),
  bundleId: uuid("bundle_id").references(() => campaignBundles.id, { onDelete: "set null" }),
  runId: uuid("run_id"),
  tier: text("tier", { enum: ["quick", "standard", "premium"] }).notNull(),
  /** D1 of the 30-day plan (ISO date) and the launch day (D14 by default). */
  startDate: text("start_date").notNull(),
  launchDate: text("launch_date").notNull(),
  platforms: text("platforms").array().notNull(),
  timeBudgetMin: integer("time_budget_min").notNull().default(10),
  plan: jsonb("plan").$type<Record<string, unknown>>(),
  status: text("status", { enum: ["planning", "active", "paused", "ended"] }).notNull().default("planning"),
  createdAt: createdAt(),
});

export const contentItems = pgTable(
  "content_items",
  {
    id: uuid("id").primaryKey(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    campaignId: uuid("campaign_id")
      .notNull()
      .references(() => campaigns.id, { onDelete: "cascade" }),
    runId: uuid("run_id"),
    angleId: uuid("angle_id"),
    /** Stable key inside a campaign, e.g. "post:threads:d03:1" (the orchestrator's jobId suffix). */
    deliverableKey: text("deliverable_key").notNull(),
    kind: text("kind", { enum: ["post", "thread", "carousel", "video", "email", "bio", "pinned"] }).notNull(),
    slotKind: text("slot_kind", { enum: ["pre", "open", "refill"] }).notNull().default("pre"),
    day: integer("day"),
    brief: jsonb("brief").$type<Record<string, unknown>>(),
    status: text("status", {
      enum: ["planned", "generating", "ready", "needs_you", "finalizing", "final_ready", "approved", "failed", "skipped"],
    })
      .notNull()
      .default("planned"),
    needsYouReason: text("needs_you_reason"),
    dnaFieldsUsed: text("dna_fields_used").array().notNull().default([]),
    claimIds: text("claim_ids").array().notNull().default([]),
    stale: boolean("stale").notNull().default(false),
    costMicros: micros("cost_micros").notNull().default(0),
    createdAt: createdAt(),
    updatedAt: ts("updated_at").notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("content_items_campaign_key").on(t.campaignId, t.deliverableKey),
    index("content_items_run").on(t.runId),
  ],
);

/** One platform rendition of a content item (the text, media and options that get approved). */
export const variants = pgTable(
  "variants",
  {
    id: uuid("id").primaryKey(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    contentItemId: uuid("content_item_id")
      .notNull()
      .references(() => contentItems.id, { onDelete: "cascade" }),
    platform: text("platform").notNull(),
    hookIdx: integer("hook_idx"),
    body: jsonb("body").$type<Record<string, unknown>>().notNull(),
    assetIds: uuid("asset_ids").array().notNull().default([]),
    utm: jsonb("utm").$type<Record<string, string>>(),
    qa: jsonb("qa").$type<Record<string, unknown>>(),
    provenanceTier: text("provenance_tier", { enum: ["A", "B", "C"] }).notNull().default("A"),
    promptVersion: text("prompt_version"),
    contentHash: text("content_hash").notNull(),
    createdAt: createdAt(),
    updatedAt: ts("updated_at").notNull().defaultNow(),
  },
  (t) => [index("variants_item").on(t.contentItemId)],
);

// ── approvals (D9) ──

export const approvals = pgTable(
  "approvals",
  {
    id: uuid("id").primaryKey(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    entityType: text("entity_type", { enum: ["post", "broadcast", "automation_version", "ad", "video_finalize"] }).notNull(),
    entityId: uuid("entity_id").notNull(),
    /** hash(text + final media sha256s + platform options): re-checked at publish.prepare. */
    contentHash: text("content_hash").notNull(),
    /** Always a UI session user; PATs and agents can never approve. */
    approvedBy: text("approved_by").notNull(),
    voidedAt: ts("voided_at"),
    voidReason: text("void_reason"),
    createdAt: createdAt(),
  },
  (t) => [index("approvals_entity").on(t.entityType, t.entityId)],
);

// ── posts (§4.3) ──

export const POST_STATES = [
  "draft",
  "pending_approval",
  "approved",
  "queued",
  "preparing",
  "submitting",
  "submitted",
  "unknown",
  "awaiting_user",
  "published",
  "failed",
  "missed",
  "paused",
  "canceled",
] as const;

export const posts = pgTable(
  "posts",
  {
    id: uuid("id").primaryKey(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    productId: uuid("product_id")
      .notNull()
      .references(() => products.id, { onDelete: "cascade" }),
    variantId: uuid("variant_id")
      .notNull()
      .references(() => variants.id, { onDelete: "cascade" }),
    connectionId: uuid("connection_id").references(() => socialConnections.id, { onDelete: "set null" }),
    platform: text("platform").notNull(),
    scheduledAt: ts("scheduled_at").notNull(),
    state: text("state", { enum: POST_STATES }).notNull().default("draft"),
    generation: integer("generation").notNull().default(1),
    /** pst_{id}_g{n} = the delayed publish.due jobId = the publisher's external_id. */
    idempotencyKey: text("idempotency_key").notNull(),
    approvalId: uuid("approval_id").references(() => approvals.id, { onDelete: "set null" }),
    providerRequestId: text("provider_request_id"),
    providerPostId: text("provider_post_id"),
    platformUrl: text("platform_url"),
    platformOptions: jsonb("platform_options").$type<Record<string, unknown>>().notNull().default({}),
    aiDisclosure: jsonb("ai_disclosure").$type<Record<string, unknown>>(),
    mediaSnapshot: jsonb("media_snapshot").$type<{ assetId: string; sha256: string }[]>().notNull().default([]),
    /** api = through the publisher; assisted = Copy & open; manual = Download & post yourself. */
    mode: text("mode", { enum: ["api", "assisted", "manual", "tiktok_drafts"] }).notNull().default("api"),
    lastError: text("last_error"),
    staleReason: text("stale_reason"),
    nextReconcileAt: ts("next_reconcile_at"),
    missedAt: ts("missed_at"),
    publishedAt: ts("published_at"),
    createdAt: createdAt(),
    updatedAt: ts("updated_at").notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("posts_idempotency_key").on(t.idempotencyKey),
    index("posts_ws_scheduled").on(t.workspaceId, t.scheduledAt),
    index("posts_state").on(t.state),
  ],
);

export const postEvents = pgTable(
  "post_events",
  {
    id: uuid("id").primaryKey(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    postId: uuid("post_id")
      .notNull()
      .references(() => posts.id, { onDelete: "cascade" }),
    event: text("event").notNull(),
    fromState: text("from_state").notNull(),
    toState: text("to_state").notNull(),
    actorType: text("actor_type", { enum: ["user", "pat", "worker", "webhook"] }).notNull(),
    data: jsonb("data").$type<Record<string, unknown>>(),
    createdAt: createdAt(),
  },
  (t) => [index("post_events_post").on(t.postId)],
);

/** Raw webhook bodies, deduped by provider event id. workspace_id is set once matched to a post. */
export const webhookEvents = pgTable(
  "webhook_events",
  {
    id: uuid("id").primaryKey(),
    workspaceId: uuid("workspace_id").references(() => workspaces.id, { onDelete: "cascade" }),
    provider: text("provider").notNull(),
    eventId: text("event_id").notNull(),
    type: text("type"),
    body: text("body").notNull(),
    processedAt: ts("processed_at"),
    error: text("error"),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("webhook_events_key").on(t.provider, t.eventId)],
);

/** Copy & open venues (Reddit, HN, PH…): the app drafts, the human posts (§5.8 step 9). */
export const assistedTasks = pgTable(
  "assisted_tasks",
  {
    id: uuid("id").primaryKey(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    productId: uuid("product_id")
      .notNull()
      .references(() => products.id, { onDelete: "cascade" }),
    contentItemId: uuid("content_item_id").references(() => contentItems.id, { onDelete: "set null" }),
    venue: text("venue").notNull(),
    title: text("title"),
    body: text("body").notNull(),
    dueAt: ts("due_at"),
    rulesUrl: text("rules_url"),
    rulesSnapshot: text("rules_snapshot"),
    rulesFetchedAt: ts("rules_fetched_at"),
    rulesCheckedByHumanAt: ts("rules_checked_by_human_at"),
    deepLink: text("deep_link"),
    postedUrl: text("posted_url"),
    status: text("status", { enum: ["todo", "done", "skipped"] }).notNull().default("todo"),
    createdAt: createdAt(),
  },
  (t) => [index("assisted_tasks_product").on(t.productId)],
);

// ── links and analytics (§5.9) ──

export const trackedLinks = pgTable(
  "tracked_links",
  {
    id: uuid("id").primaryKey(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    productId: uuid("product_id")
      .notNull()
      .references(() => products.id, { onDelete: "cascade" }),
    variantId: uuid("variant_id").references(() => variants.id, { onDelete: "set null" }),
    token: text("token").notNull(),
    url: text("url").notNull(),
    utm: jsonb("utm").$type<Record<string, string>>().notNull(),
    createdAt: createdAt(),
  },
  (t) => [index("tracked_links_product").on(t.productId)],
);

/** D11: one bio link per account whose utm_content rotates weekly to the lead angle. */
export const bioLinks = pgTable(
  "bio_links",
  {
    id: uuid("id").primaryKey(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    connectionId: uuid("connection_id")
      .notNull()
      .references(() => socialConnections.id, { onDelete: "cascade" }),
    week: text("week").notNull(),
    angleId: uuid("angle_id"),
    url: text("url").notNull(),
    utmContent: text("utm_content").notNull(),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("bio_links_key").on(t.connectionId, t.week)],
);

export const analyticsSnapshots = pgTable(
  "analytics_snapshots",
  {
    id: uuid("id").primaryKey(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    postId: uuid("post_id")
      .notNull()
      .references(() => posts.id, { onDelete: "cascade" }),
    window: text("window", { enum: ["h24", "h72", "d7"] }).notNull(),
    ageHours: integer("age_hours").notNull(),
    mature: boolean("mature").notNull(),
    metrics: jsonb("metrics").$type<Record<string, number | null>>().notNull(),
    unknownMetrics: text("unknown_metrics").array().notNull().default([]),
    source: text("source").notNull(),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("analytics_snapshots_key").on(t.postId, t.window)],
);

/** Daily first-party conversions pulled from the product (SyllaCal aggregate endpoint), keyed by UTM. */
export const conversionSnapshots = pgTable(
  "conversion_snapshots",
  {
    id: uuid("id").primaryKey(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    productId: uuid("product_id")
      .notNull()
      .references(() => products.id, { onDelete: "cascade" }),
    day: text("day").notNull(),
    utmSource: text("utm_source").notNull().default(""),
    utmContent: text("utm_content").notNull().default(""),
    utmTerm: text("utm_term").notNull().default(""),
    visits: integer("visits").notNull().default(0),
    signups: integer("signups").notNull().default(0),
    purchases: integer("purchases").notNull().default(0),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("conversion_snapshots_key").on(t.productId, t.day, t.utmSource, t.utmContent, t.utmTerm)],
);

// ── video (§5.6, M3a/M3b) ──

export const videoSpecs = pgTable(
  "video_specs",
  {
    id: uuid("id").primaryKey(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    contentItemId: uuid("content_item_id")
      .notNull()
      .references(() => contentItems.id, { onDelete: "cascade" }),
    version: integer("version").notNull(),
    script: jsonb("script").$type<Record<string, unknown>>().notNull(),
    spec: jsonb("spec").$type<Record<string, unknown>>().notNull(),
    specHash: text("spec_hash").notNull(),
    lint: jsonb("lint").$type<Record<string, unknown>>(),
    editedBy: text("edited_by", { enum: ["model", "user"] }).notNull().default("model"),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("video_specs_item_version").on(t.contentItemId, t.version)],
);

/** Voice lines cached by text hash, so editing one line re-voices only that line. */
export const ttsSegments = pgTable(
  "tts_segments",
  {
    id: uuid("id").primaryKey(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    textHash: text("text_hash").notNull(),
    voice: text("voice").notNull(),
    model: text("model").notNull(),
    text: text("text").notNull(),
    assetId: uuid("asset_id")
      .notNull()
      .references(() => assets.id, { onDelete: "cascade" }),
    durationMs: integer("duration_ms").notNull(),
    alignment: jsonb("alignment").$type<{ text: string; startMs: number; endMs: number }[]>(),
    /** Word error rate in basis points (500 = 5%). */
    werBp: integer("wer_bp"),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("tts_segments_key").on(t.workspaceId, t.textHash, t.voice, t.model)],
);

export const renders = pgTable(
  "renders",
  {
    id: uuid("id").primaryKey(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    contentItemId: uuid("content_item_id")
      .notNull()
      .references(() => contentItems.id, { onDelete: "cascade" }),
    specHash: text("spec_hash").notNull(),
    hookIdx: integer("hook_idx").notNull(),
    quality: text("quality", { enum: ["draft", "final"] }).notNull(),
    format: text("format", { enum: ["9x16", "1x1", "16x9"] }).notNull(),
    status: text("status", { enum: ["queued", "rendering", "postprocess", "qa", "succeeded", "failed"] })
      .notNull()
      .default("queued"),
    outputAssetId: uuid("output_asset_id").references(() => assets.id, { onDelete: "set null" }),
    /** Platform transcodes: { tiktok, ig_reel, yt_short, x, thumb, contact } -> asset id. */
    variantAssets: jsonb("variant_assets").$type<Record<string, string>>().notNull().default({}),
    qa: jsonb("qa").$type<Record<string, unknown>>(),
    error: text("error"),
    attempts: integer("attempts").notNull().default(0),
    createdAt: createdAt(),
    finishedAt: ts("finished_at"),
  },
  (t) => [uniqueIndex("renders_key").on(t.specHash, t.hookIdx, t.quality, t.format)],
);

/** Which assets an output was built from (provenance tier = the highest of its ingredients). */
export const assetLineage = pgTable(
  "asset_lineage",
  {
    id: uuid("id").primaryKey(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    assetId: uuid("asset_id")
      .notNull()
      .references(() => assets.id, { onDelete: "cascade" }),
    parentAssetId: uuid("parent_asset_id")
      .notNull()
      .references(() => assets.id, { onDelete: "cascade" }),
    relation: text("relation").notNull(),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("asset_lineage_key").on(t.assetId, t.parentAssetId, t.relation)],
);

/** Saved capture flows (M3b): replayed by "Refresh footage". */
export const captureFlows = pgTable("capture_flows", {
  id: uuid("id").primaryKey(),
  workspaceId: uuid("workspace_id")
    .notNull()
    .references(() => workspaces.id, { onDelete: "cascade" }),
  productId: uuid("product_id")
    .notNull()
    .references(() => products.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  steps: jsonb("steps").$type<Record<string, unknown>[]>().notNull(),
  needsLogin: boolean("needs_login").notNull().default(false),
  confirmedAt: ts("confirmed_at"),
  confirmedBy: text("confirmed_by"),
  lastRecordingAssetId: uuid("last_recording_asset_id"),
  lastError: text("last_error"),
  createdAt: createdAt(),
});
