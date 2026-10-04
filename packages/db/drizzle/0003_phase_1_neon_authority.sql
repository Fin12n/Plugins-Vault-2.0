CREATE TABLE IF NOT EXISTS "wallet_topups" (
	"id" serial PRIMARY KEY NOT NULL,
	"code" varchar(32) NOT NULL,
	"discord_user_id" varchar(32) NOT NULL,
	"amount" integer NOT NULL,
	"paid_amount" integer,
	"status" varchar(20) DEFAULT 'pending' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"credited_at" timestamp with time zone,
	CONSTRAINT "wallet_topups_code_unique" UNIQUE("code")
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "idx_wallet_topups_code" ON "wallet_topups" USING btree ("code");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_wallet_topups_status" ON "wallet_topups" USING btree ("status");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_wallet_topups_user" ON "wallet_topups" USING btree ("discord_user_id","created_at");
--> statement-breakpoint
ALTER TABLE "sepay_transactions" ADD COLUMN IF NOT EXISTS "description" text DEFAULT '' NOT NULL;
--> statement-breakpoint
ALTER TABLE "sepay_transactions" ADD COLUMN IF NOT EXISTS "status" varchar(32) DEFAULT 'received' NOT NULL;
--> statement-breakpoint
ALTER TABLE "sepay_transactions" ADD COLUMN IF NOT EXISTS "topup_id" integer;
--> statement-breakpoint
ALTER TABLE "sepay_transactions" ADD COLUMN IF NOT EXISTS "processed_at" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "sepay_transactions" DROP CONSTRAINT IF EXISTS "sepay_transactions_topup_id_wallet_topups_id_fk";
--> statement-breakpoint
ALTER TABLE "sepay_transactions" ADD CONSTRAINT "sepay_transactions_topup_id_wallet_topups_id_fk" FOREIGN KEY ("topup_id") REFERENCES "public"."wallet_topups"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "sepay_transactions" DROP CONSTRAINT IF EXISTS "chk_sepay_target_exclusivity";
--> statement-breakpoint
ALTER TABLE "sepay_transactions" ADD CONSTRAINT "chk_sepay_target_exclusivity" CHECK (
  (order_id IS NULL AND topup_id IS NULL) OR
  (order_id IS NOT NULL AND topup_id IS NULL) OR
  (order_id IS NULL AND topup_id IS NOT NULL)
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_sepay_tx_status" ON "sepay_transactions" USING btree ("status");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_sepay_tx_order_id" ON "sepay_transactions" USING btree ("order_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_sepay_tx_topup_id" ON "sepay_transactions" USING btree ("topup_id");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "idx_wallet_ledger_ref_kind_unique" ON "wallet_ledger" ("ref_type", "ref_id", "kind") WHERE ("ref_type" != '' AND "ref_id" IS NOT NULL);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "idx_wallet_ledger_opening_balance" ON "wallet_ledger" ("discord_user_id") WHERE ("kind" = 'opening_balance');
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "idx_versions_plugin_version" ON "versions" USING btree ("plugin_id", "version");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "discount_code_redemptions" (
	"id" serial PRIMARY KEY NOT NULL,
	"discount_id" integer NOT NULL,
	"discord_user_id" varchar(32) NOT NULL,
	"order_id" integer,
	"discount_amount" integer NOT NULL,
	"redeemed_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "discount_code_redemptions" DROP CONSTRAINT IF EXISTS "discount_code_redemptions_discount_id_discount_codes_id_fk";
--> statement-breakpoint
ALTER TABLE "discount_code_redemptions" ADD CONSTRAINT "discount_code_redemptions_discount_id_discount_codes_id_fk" FOREIGN KEY ("discount_id") REFERENCES "public"."discount_codes"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "discount_code_redemptions" DROP CONSTRAINT IF EXISTS "discount_code_redemptions_order_id_orders_id_fk";
--> statement-breakpoint
ALTER TABLE "discount_code_redemptions" ADD CONSTRAINT "discount_code_redemptions_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "idx_discount_redemptions_order" ON "discount_code_redemptions" USING btree ("order_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_discount_redemptions_discount_user" ON "discount_code_redemptions" USING btree ("discount_id", "discord_user_id");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "download_tokens" (
	"token_hash" varchar(64) PRIMARY KEY NOT NULL,
	"version_id" integer NOT NULL,
	"discord_user_id" varchar(32) NOT NULL,
	"order_id" integer,
	"expires_at" timestamp with time zone NOT NULL,
	"used_at" timestamp with time zone,
	"failure_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "download_tokens" DROP CONSTRAINT IF EXISTS "download_tokens_version_id_versions_id_fk";
--> statement-breakpoint
ALTER TABLE "download_tokens" ADD CONSTRAINT "download_tokens_version_id_versions_id_fk" FOREIGN KEY ("version_id") REFERENCES "public"."versions"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "download_tokens" DROP CONSTRAINT IF EXISTS "download_tokens_order_id_orders_id_fk";
--> statement-breakpoint
ALTER TABLE "download_tokens" ADD CONSTRAINT "download_tokens_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_download_tokens_expires" ON "download_tokens" USING btree ("expires_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_download_tokens_version" ON "download_tokens" USING btree ("version_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_download_tokens_user" ON "download_tokens" USING btree ("discord_user_id");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "delivery_jobs" (
	"id" serial PRIMARY KEY NOT NULL,
	"order_id" integer NOT NULL,
	"discord_user_id" varchar(32) NOT NULL,
	"version_id" integer NOT NULL,
	"requested_method" varchar(32) DEFAULT 'attachment' NOT NULL,
	"status" varchar(20) DEFAULT 'queued' NOT NULL,
	"external_attempt_count" integer DEFAULT 0 NOT NULL,
	"claim_token" varchar(64),
	"locked_at" timestamp with time zone,
	"retry_count" integer DEFAULT 0 NOT NULL,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "delivery_jobs" DROP CONSTRAINT IF EXISTS "delivery_jobs_order_id_orders_id_fk";
--> statement-breakpoint
ALTER TABLE "delivery_jobs" ADD CONSTRAINT "delivery_jobs_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "delivery_jobs" DROP CONSTRAINT IF EXISTS "delivery_jobs_version_id_versions_id_fk";
--> statement-breakpoint
ALTER TABLE "delivery_jobs" ADD CONSTRAINT "delivery_jobs_version_id_versions_id_fk" FOREIGN KEY ("version_id") REFERENCES "public"."versions"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "idx_delivery_jobs_order_method" ON "delivery_jobs" USING btree ("order_id", "requested_method");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_delivery_jobs_status_locked" ON "delivery_jobs" USING btree ("status", "locked_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_delivery_jobs_created" ON "delivery_jobs" USING btree ("created_at");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "delivery_logs" (
	"id" serial PRIMARY KEY NOT NULL,
	"delivery_idempotency_key" varchar(128) NOT NULL,
	"discord_user_id" varchar(32) NOT NULL,
	"version_id" integer NOT NULL,
	"order_id" integer,
	"plugin_name" varchar(255) NOT NULL,
	"version_label" varchar(64) DEFAULT '' NOT NULL,
	"amount" integer DEFAULT 0 NOT NULL,
	"requested_method" varchar(32) NOT NULL,
	"actual_method" varchar(32) NOT NULL,
	"ip" varchar(45),
	"delivered_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "delivery_logs_delivery_idempotency_key_unique" UNIQUE("delivery_idempotency_key")
);
--> statement-breakpoint
ALTER TABLE "delivery_logs" DROP CONSTRAINT IF EXISTS "delivery_logs_version_id_versions_id_fk";
--> statement-breakpoint
ALTER TABLE "delivery_logs" ADD CONSTRAINT "delivery_logs_version_id_versions_id_fk" FOREIGN KEY ("version_id") REFERENCES "public"."versions"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "delivery_logs" DROP CONSTRAINT IF EXISTS "delivery_logs_order_id_orders_id_fk";
--> statement-breakpoint
ALTER TABLE "delivery_logs" ADD CONSTRAINT "delivery_logs_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "idx_delivery_logs_idempotency" ON "delivery_logs" USING btree ("delivery_idempotency_key");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_delivery_logs_user" ON "delivery_logs" USING btree ("discord_user_id", "delivered_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_delivery_logs_order" ON "delivery_logs" USING btree ("order_id");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "spigot_account_refs" (
	"account_id" uuid PRIMARY KEY NOT NULL,
	"label" varchar(64) NOT NULL,
	"status" varchar(20) DEFAULT 'active' NOT NULL,
	"health" varchar(20) DEFAULT 'healthy' NOT NULL,
	"last_verified_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "spigot_account_refs_label_unique" UNIQUE("label")
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "idx_spigot_refs_label" ON "spigot_account_refs" USING btree ("label");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_spigot_refs_status" ON "spigot_account_refs" USING btree ("status");
--> statement-breakpoint
ALTER TABLE "resource_ownership" ADD COLUMN IF NOT EXISTS "account_id" uuid;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_resource_ownership_account_id" ON "resource_ownership" USING btree ("account_id");
--> statement-breakpoint
DROP TABLE IF EXISTS "spigot_accounts" CASCADE;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "migration_checkpoints" (
	"step_name" varchar(64) PRIMARY KEY NOT NULL,
	"status" varchar(20) NOT NULL,
	"last_processed_key" varchar(128),
	"processed_count" integer DEFAULT 0 NOT NULL,
	"checksum" varchar(64),
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone
);