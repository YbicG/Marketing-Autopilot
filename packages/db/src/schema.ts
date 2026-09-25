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
    kind: text("kind", { enum: ["m0_summary", "ingest", "strategy", "dna_regenerate"] }).notNull(),
    status: text("status", { enum: ["queued", "running", "needs_review", "completed", "failed", "canceled"] }).notNull(),
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
    kind: text("kind", { enum: ["screenshot", "image"] }).notNull(),
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
