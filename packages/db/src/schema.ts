import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  check,
  index,
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
