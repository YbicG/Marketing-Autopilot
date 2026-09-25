CREATE TABLE "analytics_snapshots" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"post_id" uuid NOT NULL,
	"window" text NOT NULL,
	"age_hours" integer NOT NULL,
	"mature" boolean NOT NULL,
	"metrics" jsonb NOT NULL,
	"unknown_metrics" text[] DEFAULT '{}' NOT NULL,
	"source" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "approvals" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"entity_type" text NOT NULL,
	"entity_id" uuid NOT NULL,
	"content_hash" text NOT NULL,
	"approved_by" text NOT NULL,
	"voided_at" timestamp with time zone,
	"void_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "asset_lineage" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"asset_id" uuid NOT NULL,
	"parent_asset_id" uuid NOT NULL,
	"relation" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "assisted_tasks" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"product_id" uuid NOT NULL,
	"content_item_id" uuid,
	"venue" text NOT NULL,
	"title" text,
	"body" text NOT NULL,
	"due_at" timestamp with time zone,
	"rules_url" text,
	"rules_snapshot" text,
	"rules_fetched_at" timestamp with time zone,
	"rules_checked_by_human_at" timestamp with time zone,
	"deep_link" text,
	"posted_url" text,
	"status" text DEFAULT 'todo' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "bio_links" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"connection_id" uuid NOT NULL,
	"week" text NOT NULL,
	"angle_id" uuid,
	"url" text NOT NULL,
	"utm_content" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "campaign_bundles" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"product_id" uuid NOT NULL,
	"strategy_id" uuid NOT NULL,
	"dna_version_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"text" text NOT NULL,
	"claim_refs" text[] NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "campaigns" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"product_id" uuid NOT NULL,
	"strategy_id" uuid NOT NULL,
	"bundle_id" uuid,
	"run_id" uuid,
	"tier" text NOT NULL,
	"start_date" text NOT NULL,
	"launch_date" text NOT NULL,
	"platforms" text[] NOT NULL,
	"time_budget_min" integer DEFAULT 10 NOT NULL,
	"plan" jsonb,
	"status" text DEFAULT 'planning' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "capture_flows" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"product_id" uuid NOT NULL,
	"name" text NOT NULL,
	"steps" jsonb NOT NULL,
	"needs_login" boolean DEFAULT false NOT NULL,
	"confirmed_at" timestamp with time zone,
	"confirmed_by" text,
	"last_recording_asset_id" uuid,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "content_items" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"campaign_id" uuid NOT NULL,
	"run_id" uuid,
	"angle_id" uuid,
	"deliverable_key" text NOT NULL,
	"kind" text NOT NULL,
	"slot_kind" text DEFAULT 'pre' NOT NULL,
	"day" integer,
	"brief" jsonb,
	"status" text DEFAULT 'planned' NOT NULL,
	"needs_you_reason" text,
	"dna_fields_used" text[] DEFAULT '{}' NOT NULL,
	"claim_ids" text[] DEFAULT '{}' NOT NULL,
	"stale" boolean DEFAULT false NOT NULL,
	"cost_micros" bigint DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "conversion_snapshots" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"product_id" uuid NOT NULL,
	"day" text NOT NULL,
	"utm_source" text DEFAULT '' NOT NULL,
	"utm_content" text DEFAULT '' NOT NULL,
	"utm_term" text DEFAULT '' NOT NULL,
	"visits" integer DEFAULT 0 NOT NULL,
	"signups" integer DEFAULT 0 NOT NULL,
	"purchases" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "post_events" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"post_id" uuid NOT NULL,
	"event" text NOT NULL,
	"from_state" text NOT NULL,
	"to_state" text NOT NULL,
	"actor_type" text NOT NULL,
	"data" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "posting_schedules" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"product_id" uuid NOT NULL,
	"platform" text NOT NULL,
	"slots" jsonb NOT NULL,
	"max_per_day" integer DEFAULT 2 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "posts" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"product_id" uuid NOT NULL,
	"variant_id" uuid NOT NULL,
	"connection_id" uuid,
	"platform" text NOT NULL,
	"scheduled_at" timestamp with time zone NOT NULL,
	"state" text DEFAULT 'draft' NOT NULL,
	"generation" integer DEFAULT 1 NOT NULL,
	"idempotency_key" text NOT NULL,
	"approval_id" uuid,
	"provider_request_id" text,
	"provider_post_id" text,
	"platform_url" text,
	"platform_options" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"ai_disclosure" jsonb,
	"media_snapshot" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"mode" text DEFAULT 'api' NOT NULL,
	"last_error" text,
	"stale_reason" text,
	"next_reconcile_at" timestamp with time zone,
	"missed_at" timestamp with time zone,
	"published_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "renders" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"content_item_id" uuid NOT NULL,
	"spec_hash" text NOT NULL,
	"hook_idx" integer NOT NULL,
	"quality" text NOT NULL,
	"format" text NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"output_asset_id" uuid,
	"variant_assets" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"qa" jsonb,
	"error" text,
	"attempts" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "social_connections" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"product_id" uuid,
	"publisher" text NOT NULL,
	"platform" text NOT NULL,
	"handle" text,
	"profile_ref" text NOT NULL,
	"shared" boolean DEFAULT false NOT NULL,
	"max_per_day" integer DEFAULT 2 NOT NULL,
	"warmup_until" timestamp with time zone,
	"status" text DEFAULT 'active' NOT NULL,
	"token_expires_at" timestamp with time zone,
	"capabilities" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"last_health_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "social_connections_max" CHECK ("social_connections"."max_per_day" BETWEEN 1 AND 3)
);
--> statement-breakpoint
CREATE TABLE "tracked_links" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"product_id" uuid NOT NULL,
	"variant_id" uuid,
	"token" text NOT NULL,
	"url" text NOT NULL,
	"utm" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "tts_segments" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"text_hash" text NOT NULL,
	"voice" text NOT NULL,
	"model" text NOT NULL,
	"text" text NOT NULL,
	"asset_id" uuid NOT NULL,
	"duration_ms" integer NOT NULL,
	"alignment" jsonb,
	"wer_bp" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "variants" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"content_item_id" uuid NOT NULL,
	"platform" text NOT NULL,
	"hook_idx" integer,
	"body" jsonb NOT NULL,
	"asset_ids" uuid[] DEFAULT '{}' NOT NULL,
	"utm" jsonb,
	"qa" jsonb,
	"provenance_tier" text DEFAULT 'A' NOT NULL,
	"prompt_version" text,
	"content_hash" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "vault_secrets" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"purpose" text NOT NULL,
	"kek_version" integer NOT NULL,
	"wrapped_dek" text NOT NULL,
	"iv" text NOT NULL,
	"tag" text NOT NULL,
	"ciphertext" text NOT NULL,
	"hint" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"rotated_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "video_specs" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"content_item_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"script" jsonb NOT NULL,
	"spec" jsonb NOT NULL,
	"spec_hash" text NOT NULL,
	"lint" jsonb,
	"edited_by" text DEFAULT 'model' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "webhook_events" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid,
	"provider" text NOT NULL,
	"event_id" text NOT NULL,
	"type" text,
	"body" text NOT NULL,
	"processed_at" timestamp with time zone,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "assets" ADD COLUMN "duration_ms" integer;--> statement-breakpoint
ALTER TABLE "assets" ADD COLUMN "size_bytes" bigint;--> statement-breakpoint
ALTER TABLE "assets" ADD COLUMN "click_log_key" text;--> statement-breakpoint
ALTER TABLE "assets" ADD COLUMN "ocr_text" text;--> statement-breakpoint
ALTER TABLE "assets" ADD COLUMN "phash" text;--> statement-breakpoint
ALTER TABLE "assets" ADD COLUMN "license_ref" text;--> statement-breakpoint
ALTER TABLE "assets" ADD COLUMN "xmp_written" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "products" ADD COLUMN "trusted_capture_origin" text;--> statement-breakpoint
ALTER TABLE "products" ADD COLUMN "capture_route_denylist" text[] DEFAULT '{}' NOT NULL;--> statement-breakpoint
ALTER TABLE "products" ADD COLUMN "made_for_kids" boolean;--> statement-breakpoint
ALTER TABLE "analytics_snapshots" ADD CONSTRAINT "analytics_snapshots_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "analytics_snapshots" ADD CONSTRAINT "analytics_snapshots_post_id_posts_id_fk" FOREIGN KEY ("post_id") REFERENCES "public"."posts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "approvals" ADD CONSTRAINT "approvals_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "asset_lineage" ADD CONSTRAINT "asset_lineage_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "asset_lineage" ADD CONSTRAINT "asset_lineage_asset_id_assets_id_fk" FOREIGN KEY ("asset_id") REFERENCES "public"."assets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "asset_lineage" ADD CONSTRAINT "asset_lineage_parent_asset_id_assets_id_fk" FOREIGN KEY ("parent_asset_id") REFERENCES "public"."assets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "assisted_tasks" ADD CONSTRAINT "assisted_tasks_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "assisted_tasks" ADD CONSTRAINT "assisted_tasks_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "assisted_tasks" ADD CONSTRAINT "assisted_tasks_content_item_id_content_items_id_fk" FOREIGN KEY ("content_item_id") REFERENCES "public"."content_items"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bio_links" ADD CONSTRAINT "bio_links_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bio_links" ADD CONSTRAINT "bio_links_connection_id_social_connections_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."social_connections"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "campaign_bundles" ADD CONSTRAINT "campaign_bundles_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "campaign_bundles" ADD CONSTRAINT "campaign_bundles_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "campaign_bundles" ADD CONSTRAINT "campaign_bundles_strategy_id_strategies_id_fk" FOREIGN KEY ("strategy_id") REFERENCES "public"."strategies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "campaigns" ADD CONSTRAINT "campaigns_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "campaigns" ADD CONSTRAINT "campaigns_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "campaigns" ADD CONSTRAINT "campaigns_strategy_id_strategies_id_fk" FOREIGN KEY ("strategy_id") REFERENCES "public"."strategies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "campaigns" ADD CONSTRAINT "campaigns_bundle_id_campaign_bundles_id_fk" FOREIGN KEY ("bundle_id") REFERENCES "public"."campaign_bundles"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "capture_flows" ADD CONSTRAINT "capture_flows_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "capture_flows" ADD CONSTRAINT "capture_flows_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "content_items" ADD CONSTRAINT "content_items_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "content_items" ADD CONSTRAINT "content_items_campaign_id_campaigns_id_fk" FOREIGN KEY ("campaign_id") REFERENCES "public"."campaigns"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversion_snapshots" ADD CONSTRAINT "conversion_snapshots_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversion_snapshots" ADD CONSTRAINT "conversion_snapshots_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "post_events" ADD CONSTRAINT "post_events_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "post_events" ADD CONSTRAINT "post_events_post_id_posts_id_fk" FOREIGN KEY ("post_id") REFERENCES "public"."posts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "posting_schedules" ADD CONSTRAINT "posting_schedules_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "posting_schedules" ADD CONSTRAINT "posting_schedules_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "posts" ADD CONSTRAINT "posts_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "posts" ADD CONSTRAINT "posts_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "posts" ADD CONSTRAINT "posts_variant_id_variants_id_fk" FOREIGN KEY ("variant_id") REFERENCES "public"."variants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "posts" ADD CONSTRAINT "posts_connection_id_social_connections_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."social_connections"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "posts" ADD CONSTRAINT "posts_approval_id_approvals_id_fk" FOREIGN KEY ("approval_id") REFERENCES "public"."approvals"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "renders" ADD CONSTRAINT "renders_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "renders" ADD CONSTRAINT "renders_content_item_id_content_items_id_fk" FOREIGN KEY ("content_item_id") REFERENCES "public"."content_items"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "renders" ADD CONSTRAINT "renders_output_asset_id_assets_id_fk" FOREIGN KEY ("output_asset_id") REFERENCES "public"."assets"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "social_connections" ADD CONSTRAINT "social_connections_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "social_connections" ADD CONSTRAINT "social_connections_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tracked_links" ADD CONSTRAINT "tracked_links_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tracked_links" ADD CONSTRAINT "tracked_links_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tracked_links" ADD CONSTRAINT "tracked_links_variant_id_variants_id_fk" FOREIGN KEY ("variant_id") REFERENCES "public"."variants"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tts_segments" ADD CONSTRAINT "tts_segments_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tts_segments" ADD CONSTRAINT "tts_segments_asset_id_assets_id_fk" FOREIGN KEY ("asset_id") REFERENCES "public"."assets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "variants" ADD CONSTRAINT "variants_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "variants" ADD CONSTRAINT "variants_content_item_id_content_items_id_fk" FOREIGN KEY ("content_item_id") REFERENCES "public"."content_items"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vault_secrets" ADD CONSTRAINT "vault_secrets_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "video_specs" ADD CONSTRAINT "video_specs_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "video_specs" ADD CONSTRAINT "video_specs_content_item_id_content_items_id_fk" FOREIGN KEY ("content_item_id") REFERENCES "public"."content_items"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "webhook_events" ADD CONSTRAINT "webhook_events_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "analytics_snapshots_key" ON "analytics_snapshots" USING btree ("post_id","window");--> statement-breakpoint
CREATE INDEX "approvals_entity" ON "approvals" USING btree ("entity_type","entity_id");--> statement-breakpoint
CREATE UNIQUE INDEX "asset_lineage_key" ON "asset_lineage" USING btree ("asset_id","parent_asset_id","relation");--> statement-breakpoint
CREATE INDEX "assisted_tasks_product" ON "assisted_tasks" USING btree ("product_id");--> statement-breakpoint
CREATE UNIQUE INDEX "bio_links_key" ON "bio_links" USING btree ("connection_id","week");--> statement-breakpoint
CREATE UNIQUE INDEX "campaign_bundles_product_version" ON "campaign_bundles" USING btree ("product_id","version");--> statement-breakpoint
CREATE UNIQUE INDEX "content_items_campaign_key" ON "content_items" USING btree ("campaign_id","deliverable_key");--> statement-breakpoint
CREATE INDEX "content_items_run" ON "content_items" USING btree ("run_id");--> statement-breakpoint
CREATE UNIQUE INDEX "conversion_snapshots_key" ON "conversion_snapshots" USING btree ("product_id","day","utm_source","utm_content","utm_term");--> statement-breakpoint
CREATE INDEX "post_events_post" ON "post_events" USING btree ("post_id");--> statement-breakpoint
CREATE UNIQUE INDEX "posting_schedules_key" ON "posting_schedules" USING btree ("product_id","platform");--> statement-breakpoint
CREATE UNIQUE INDEX "posts_idempotency_key" ON "posts" USING btree ("idempotency_key");--> statement-breakpoint
CREATE INDEX "posts_ws_scheduled" ON "posts" USING btree ("workspace_id","scheduled_at");--> statement-breakpoint
CREATE INDEX "posts_state" ON "posts" USING btree ("state");--> statement-breakpoint
CREATE UNIQUE INDEX "renders_key" ON "renders" USING btree ("spec_hash","hook_idx","quality","format");--> statement-breakpoint
CREATE UNIQUE INDEX "social_connections_key" ON "social_connections" USING btree ("workspace_id","publisher","platform","profile_ref");--> statement-breakpoint
CREATE INDEX "tracked_links_product" ON "tracked_links" USING btree ("product_id");--> statement-breakpoint
CREATE UNIQUE INDEX "tts_segments_key" ON "tts_segments" USING btree ("workspace_id","text_hash","voice","model");--> statement-breakpoint
CREATE INDEX "variants_item" ON "variants" USING btree ("content_item_id");--> statement-breakpoint
CREATE UNIQUE INDEX "vault_secrets_ws_purpose" ON "vault_secrets" USING btree ("workspace_id","purpose");--> statement-breakpoint
CREATE UNIQUE INDEX "video_specs_item_version" ON "video_specs" USING btree ("content_item_id","version");--> statement-breakpoint
CREATE UNIQUE INDEX "webhook_events_key" ON "webhook_events" USING btree ("provider","event_id");