CREATE TABLE "email_broadcasts" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"product_id" uuid NOT NULL,
	"launch_plan_id" uuid,
	"name" text NOT NULL,
	"subject" text DEFAULT '' NOT NULL,
	"preheader" text,
	"body" text DEFAULT '' NOT NULL,
	"html" text,
	"text" text,
	"audience_id" text,
	"audience_label" text,
	"status" text DEFAULT 'draft' NOT NULL,
	"scheduled_at" timestamp with time zone,
	"content_hash" text,
	"approval_id" uuid,
	"resend_broadcast_id" text,
	"claim_ids" text[] DEFAULT '{}' NOT NULL,
	"issues" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"run_id" uuid,
	"last_error" text,
	"sent_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "email_suppressions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"email_hash" text NOT NULL,
	"reason" text NOT NULL,
	"source" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "landing_audits" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"product_id" uuid NOT NULL,
	"url" text NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"checks" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"passed" boolean,
	"screenshot_asset_ids" text[] DEFAULT '{}' NOT NULL,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "launch_kits" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"product_id" uuid NOT NULL,
	"launch_plan_id" uuid,
	"kind" text NOT NULL,
	"status" text DEFAULT 'planned' NOT NULL,
	"body" jsonb,
	"disclosures_ok" boolean DEFAULT false NOT NULL,
	"issues" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"claim_ids" text[] DEFAULT '{}' NOT NULL,
	"export_asset_id" uuid,
	"run_id" uuid,
	"needs_you_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "launch_plans" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"product_id" uuid NOT NULL,
	"campaign_id" uuid,
	"start_date" text NOT NULL,
	"launch_date" text NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"template_version" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "launch_tasks" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"launch_plan_id" uuid NOT NULL,
	"key" text NOT NULL,
	"title" text NOT NULL,
	"detail" text,
	"mode" text NOT NULL,
	"day_offset" integer NOT NULL,
	"due_date" text NOT NULL,
	"depends_on" text[] DEFAULT '{}' NOT NULL,
	"status" text DEFAULT 'todo' NOT NULL,
	"ref" jsonb,
	"gate" jsonb,
	"done_at" timestamp with time zone,
	"done_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "products" ADD COLUMN "x_links_from" text;--> statement-breakpoint
ALTER TABLE "products" ADD COLUMN "x_links_until" text;--> statement-breakpoint
ALTER TABLE "products" ADD COLUMN "email_settings" jsonb;--> statement-breakpoint
ALTER TABLE "email_broadcasts" ADD CONSTRAINT "email_broadcasts_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "email_broadcasts" ADD CONSTRAINT "email_broadcasts_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "email_broadcasts" ADD CONSTRAINT "email_broadcasts_launch_plan_id_launch_plans_id_fk" FOREIGN KEY ("launch_plan_id") REFERENCES "public"."launch_plans"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "email_suppressions" ADD CONSTRAINT "email_suppressions_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "landing_audits" ADD CONSTRAINT "landing_audits_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "landing_audits" ADD CONSTRAINT "landing_audits_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "launch_kits" ADD CONSTRAINT "launch_kits_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "launch_kits" ADD CONSTRAINT "launch_kits_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "launch_kits" ADD CONSTRAINT "launch_kits_launch_plan_id_launch_plans_id_fk" FOREIGN KEY ("launch_plan_id") REFERENCES "public"."launch_plans"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "launch_plans" ADD CONSTRAINT "launch_plans_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "launch_plans" ADD CONSTRAINT "launch_plans_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "launch_plans" ADD CONSTRAINT "launch_plans_campaign_id_campaigns_id_fk" FOREIGN KEY ("campaign_id") REFERENCES "public"."campaigns"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "launch_tasks" ADD CONSTRAINT "launch_tasks_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "launch_tasks" ADD CONSTRAINT "launch_tasks_launch_plan_id_launch_plans_id_fk" FOREIGN KEY ("launch_plan_id") REFERENCES "public"."launch_plans"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "email_broadcasts_product" ON "email_broadcasts" USING btree ("product_id");--> statement-breakpoint
CREATE UNIQUE INDEX "email_broadcasts_resend" ON "email_broadcasts" USING btree ("resend_broadcast_id");--> statement-breakpoint
CREATE UNIQUE INDEX "email_suppressions_key" ON "email_suppressions" USING btree ("workspace_id","email_hash");--> statement-breakpoint
CREATE INDEX "landing_audits_product" ON "landing_audits" USING btree ("product_id");--> statement-breakpoint
CREATE UNIQUE INDEX "launch_kits_plan_kind" ON "launch_kits" USING btree ("launch_plan_id","kind");--> statement-breakpoint
CREATE INDEX "launch_plans_product" ON "launch_plans" USING btree ("product_id");--> statement-breakpoint
CREATE UNIQUE INDEX "launch_tasks_plan_key" ON "launch_tasks" USING btree ("launch_plan_id","key");--> statement-breakpoint
CREATE INDEX "launch_tasks_due" ON "launch_tasks" USING btree ("workspace_id","due_date");