CREATE TABLE "efficiency_scores" (
	"user_id" uuid NOT NULL,
	"org_id" uuid NOT NULL,
	"as_of_day" date NOT NULL,
	"window_days" integer NOT NULL,
	"requests" integer NOT NULL,
	"retry_rate" numeric(6, 5),
	"model_fit" numeric(6, 5),
	"cache_hit_rate" numeric(6, 5),
	"acceptance_rate" numeric(6, 5),
	"weight_retry" numeric(4, 3) NOT NULL,
	"weight_model_fit" numeric(4, 3) NOT NULL,
	"weight_cache" numeric(4, 3) NOT NULL,
	"weight_acceptance" numeric(4, 3) NOT NULL,
	"score" numeric(5, 2),
	"computed_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "efficiency_scores_user_id_as_of_day_pk" PRIMARY KEY("user_id","as_of_day")
);
--> statement-breakpoint
CREATE TABLE "lint_findings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"rule" text NOT NULL,
	"group_key" text NOT NULL,
	"model" text NOT NULL,
	"requests_7d" integer NOT NULL,
	"monthly_at_stake_usd" numeric(14, 4) NOT NULL,
	"monthly_savings_usd" numeric(14, 4),
	"detail" jsonb NOT NULL,
	"first_seen" timestamp with time zone NOT NULL,
	"last_seen" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "prompt_features" (
	"provider" text NOT NULL,
	"provider_request_id" text NOT NULL,
	"occurred_at" timestamp with time zone NOT NULL,
	"org_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"virtual_key_id" uuid NOT NULL,
	"session_key" text NOT NULL,
	"model" text NOT NULL,
	"fingerprint" text NOT NULL,
	"last_user_simhash" text NOT NULL,
	"last_user_chars" integer NOT NULL,
	"last_user_numbers" text NOT NULL,
	"message_count" integer NOT NULL,
	"prefix_hash" text,
	"prefix_tokens_est" integer NOT NULL,
	"has_system" boolean NOT NULL,
	"has_format_spec" boolean NOT NULL,
	"uses_cache_control" boolean NOT NULL,
	"input_tokens" integer NOT NULL,
	"output_tokens" integer NOT NULL,
	"cache_read_tokens" integer NOT NULL,
	"cache_write_tokens" integer NOT NULL,
	"cost_usd" numeric(24, 12) NOT NULL,
	"flags" text[] DEFAULT '{}'::text[] NOT NULL,
	CONSTRAINT "prompt_features_provider_provider_request_id_pk" PRIMARY KEY("provider","provider_request_id")
);
--> statement-breakpoint
CREATE TABLE "retries" (
	"provider" text NOT NULL,
	"discarded_request_id" text NOT NULL,
	"retry_request_id" text NOT NULL,
	"org_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"discarded_at" timestamp with time zone NOT NULL,
	"wasted_cost_usd" numeric(24, 12) NOT NULL,
	"wasted_tokens" bigint NOT NULL,
	CONSTRAINT "retries_provider_discarded_request_id_pk" PRIMARY KEY("provider","discarded_request_id")
);
--> statement-breakpoint
ALTER TABLE "models" ADD COLUMN "tier" text DEFAULT 'balanced' NOT NULL;--> statement-breakpoint
ALTER TABLE "usage_rollup_hourly" ADD COLUMN "retried_requests" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "usage_rollup_hourly" ADD COLUMN "wasted_cost_usd" numeric(24, 12) DEFAULT '0' NOT NULL;--> statement-breakpoint
ALTER TABLE "efficiency_scores" ADD CONSTRAINT "efficiency_scores_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "efficiency_scores" ADD CONSTRAINT "efficiency_scores_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lint_findings" ADD CONSTRAINT "lint_findings_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lint_findings" ADD CONSTRAINT "lint_findings_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "prompt_features" ADD CONSTRAINT "prompt_features_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "prompt_features" ADD CONSTRAINT "prompt_features_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "prompt_features" ADD CONSTRAINT "prompt_features_virtual_key_id_virtual_keys_id_fk" FOREIGN KEY ("virtual_key_id") REFERENCES "public"."virtual_keys"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "retries" ADD CONSTRAINT "retries_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "retries" ADD CONSTRAINT "retries_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "lint_findings_uq" ON "lint_findings" USING btree ("user_id","rule","group_key");--> statement-breakpoint
CREATE INDEX "prompt_features_session_idx" ON "prompt_features" USING btree ("session_key","occurred_at");--> statement-breakpoint
CREATE INDEX "prompt_features_user_fp_idx" ON "prompt_features" USING btree ("user_id","fingerprint","occurred_at");--> statement-breakpoint
CREATE INDEX "prompt_features_user_prefix_idx" ON "prompt_features" USING btree ("user_id","prefix_hash","occurred_at");--> statement-breakpoint
CREATE INDEX "prompt_features_user_time_idx" ON "prompt_features" USING btree ("user_id","occurred_at");--> statement-breakpoint
CREATE INDEX "retries_user_time_idx" ON "retries" USING btree ("user_id","discarded_at");--> statement-breakpoint
ALTER TABLE "models" ADD CONSTRAINT "models_tier_ck" CHECK ("tier" IN ('frontier', 'balanced', 'fast'));--> statement-breakpoint
ALTER TABLE "retries" ADD CONSTRAINT "retries_distinct_ck" CHECK ("discarded_request_id" <> "retry_request_id");
