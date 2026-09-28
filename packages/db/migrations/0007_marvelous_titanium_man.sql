CREATE TABLE "dna_change_requests" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"product_id" uuid NOT NULL,
	"dna_version_id" uuid NOT NULL,
	"path" text NOT NULL,
	"value" jsonb NOT NULL,
	"reason" text,
	"status" text DEFAULT 'pending' NOT NULL,
	"pat_id" uuid,
	"decided_by" text,
	"decided_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "personal_access_tokens" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"name" text NOT NULL,
	"prefix" text NOT NULL,
	"token_hash" text NOT NULL,
	"scopes" text[] NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_used_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"expires_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "dna_change_requests" ADD CONSTRAINT "dna_change_requests_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dna_change_requests" ADD CONSTRAINT "dna_change_requests_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dna_change_requests" ADD CONSTRAINT "dna_change_requests_dna_version_id_product_dna_versions_id_fk" FOREIGN KEY ("dna_version_id") REFERENCES "public"."product_dna_versions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dna_change_requests" ADD CONSTRAINT "dna_change_requests_pat_id_personal_access_tokens_id_fk" FOREIGN KEY ("pat_id") REFERENCES "public"."personal_access_tokens"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "personal_access_tokens" ADD CONSTRAINT "personal_access_tokens_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "dna_change_requests_product" ON "dna_change_requests" USING btree ("product_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "personal_access_tokens_prefix" ON "personal_access_tokens" USING btree ("prefix");--> statement-breakpoint
CREATE INDEX "personal_access_tokens_ws" ON "personal_access_tokens" USING btree ("workspace_id");