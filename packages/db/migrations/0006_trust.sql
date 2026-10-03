CREATE TABLE "alerts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"dedupe_key" text NOT NULL,
	"message" text NOT NULL,
	"detail" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"acknowledged_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "reconciliations" (
	"org_id" uuid NOT NULL,
	"provider" text NOT NULL,
	"day" date NOT NULL,
	"model" text NOT NULL,
	"provider_usd" numeric(16, 6) NOT NULL,
	"metered_usd" numeric(16, 6) NOT NULL,
	"drift_ratio" numeric(10, 6),
	"status" text NOT NULL,
	"checked_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "reconciliations_org_id_provider_day_model_pk" PRIMARY KEY("org_id","provider","day","model")
);
--> statement-breakpoint
DROP INDEX "provider_credentials_live_uq";--> statement-breakpoint
ALTER TABLE "organizations" ADD COLUMN "retention_days" integer DEFAULT 395 NOT NULL;--> statement-breakpoint
ALTER TABLE "provider_credentials" ADD COLUMN "kind" text DEFAULT 'api' NOT NULL;--> statement-breakpoint
ALTER TABLE "provider_credentials" ADD COLUMN "reconcile_scope" text;--> statement-breakpoint
ALTER TABLE "alerts" ADD CONSTRAINT "alerts_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reconciliations" ADD CONSTRAINT "reconciliations_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "alerts_dedupe_uq" ON "alerts" USING btree ("org_id","dedupe_key");--> statement-breakpoint
CREATE INDEX "alerts_org_time_idx" ON "alerts" USING btree ("org_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "provider_credentials_live_uq" ON "provider_credentials" USING btree ("org_id","provider","kind") WHERE "provider_credentials"."revoked_at" is null;--> statement-breakpoint
ALTER TABLE "provider_credentials" ADD CONSTRAINT "provider_credentials_kind_ck" CHECK ("kind" IN ('api', 'admin'));--> statement-breakpoint
ALTER TABLE "organizations" ADD CONSTRAINT "organizations_retention_ck" CHECK ("retention_days" BETWEEN 30 AND 3650);--> statement-breakpoint
ALTER TABLE "reconciliations" ADD CONSTRAINT "reconciliations_status_ck" CHECK ("status" IN ('ok', 'drift'));
