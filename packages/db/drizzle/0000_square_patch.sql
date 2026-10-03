CREATE TABLE "card_topups" (
	"id" serial PRIMARY KEY NOT NULL,
	"request_id" varchar(64) NOT NULL,
	"discord_user_id" varchar(32) NOT NULL,
	"telco" varchar(32) NOT NULL,
	"serial" varchar(64) NOT NULL,
	"code" varchar(64) DEFAULT '' NOT NULL,
	"declared_value" integer NOT NULL,
	"actual_value" integer,
	"net_amount" integer,
	"status" varchar(20) DEFAULT 'pending' NOT NULL,
	"provider_status" integer,
	"provider_message" text DEFAULT '' NOT NULL,
	"trans_id" varchar(64),
	"attempts" integer DEFAULT 0 NOT NULL,
	"next_poll_at" timestamp,
	"credited_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "card_topups_request_id_unique" UNIQUE("request_id")
);
--> statement-breakpoint
CREATE TABLE "config" (
	"key" varchar(64) PRIMARY KEY NOT NULL,
	"value" text NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "dashboard_staff" (
	"discord_user_id" varchar(32) PRIMARY KEY NOT NULL,
	"username" varchar(64) DEFAULT '' NOT NULL,
	"display_name" varchar(100) DEFAULT '' NOT NULL,
	"avatar" text,
	"added_by" varchar(32) NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "discount_codes" (
	"id" serial PRIMARY KEY NOT NULL,
	"code" varchar(32) NOT NULL,
	"type" varchar(10) NOT NULL,
	"value" integer NOT NULL,
	"min_order" integer DEFAULT 0 NOT NULL,
	"max_discount" integer,
	"max_uses" integer,
	"used_count" integer DEFAULT 0 NOT NULL,
	"expires_at" timestamp,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "discount_codes_code_unique" UNIQUE("code")
);
--> statement-breakpoint
CREATE TABLE "manual_uploads" (
	"id" serial PRIMARY KEY NOT NULL,
	"version_id" integer NOT NULL,
	"plugin_id" integer NOT NULL,
	"uploaded_by" varchar(32) NOT NULL,
	"original_name" varchar(255) NOT NULL,
	"admin_note" text DEFAULT '' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "orders" (
	"id" serial PRIMARY KEY NOT NULL,
	"code" varchar(32) NOT NULL,
	"discord_user_id" varchar(32) NOT NULL,
	"version_id" integer,
	"plugin_name" varchar(255) NOT NULL,
	"version_label" varchar(64) DEFAULT '' NOT NULL,
	"amount" integer NOT NULL,
	"wallet_paid" integer DEFAULT 0 NOT NULL,
	"bank_due" integer DEFAULT 0 NOT NULL,
	"paid_amount" integer,
	"status" varchar(20) DEFAULT 'pending' NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"expires_at" timestamp NOT NULL,
	"paid_at" timestamp,
	"delivered_at" timestamp,
	CONSTRAINT "orders_code_unique" UNIQUE("code")
);
--> statement-breakpoint
CREATE TABLE "pending_download" (
	"id" serial PRIMARY KEY NOT NULL,
	"plugin_id" integer NOT NULL,
	"version_uuid" varchar(64) NOT NULL,
	"version_name" varchar(64) NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"last_error" text DEFAULT '' NOT NULL,
	"next_attempt_at" timestamp NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "pending_ingest" (
	"id" serial PRIMARY KEY NOT NULL,
	"uploaded_by" varchar(32) NOT NULL,
	"original_filename" varchar(255) NOT NULL,
	"sha256" varchar(64) NOT NULL,
	"tmp_path" text NOT NULL,
	"file_size" bigint NOT NULL,
	"detected_plugin_name" varchar(128),
	"detected_version" varchar(64),
	"detected_platform" varchar(32),
	"status" varchar(32) DEFAULT 'needs_review' NOT NULL,
	"error_reason" varchar(64) NOT NULL,
	"error_detail" text DEFAULT '' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"resolved_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "plugin_aliases" (
	"id" serial PRIMARY KEY NOT NULL,
	"plugin_id" integer NOT NULL,
	"alias" varchar(128) NOT NULL,
	CONSTRAINT "plugin_aliases_alias_unique" UNIQUE("alias")
);
--> statement-breakpoint
CREATE TABLE "plugins" (
	"id" serial PRIMARY KEY NOT NULL,
	"plugin_id" varchar(64) NOT NULL,
	"slug" varchar(128) NOT NULL,
	"display_name" varchar(255) NOT NULL,
	"descriptor_name" varchar(128) NOT NULL,
	"aliases" text[] DEFAULT '{}' NOT NULL,
	"platform" varchar(32) DEFAULT 'spigot' NOT NULL,
	"resource_id" integer,
	"deposit_price" bigint DEFAULT 0 NOT NULL,
	"is_premium" boolean DEFAULT false NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"spigot_link" text DEFAULT '' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "plugins_plugin_id_unique" UNIQUE("plugin_id"),
	CONSTRAINT "plugins_slug_unique" UNIQUE("slug")
);
--> statement-breakpoint
CREATE TABLE "resource_ownership" (
	"id" serial PRIMARY KEY NOT NULL,
	"resource_id" integer NOT NULL,
	"account_label" varchar(64) NOT NULL,
	"state" varchar(20) NOT NULL,
	"checked_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sepay_transactions" (
	"id" serial PRIMARY KEY NOT NULL,
	"sepay_id" integer NOT NULL,
	"order_id" integer,
	"amount" integer NOT NULL,
	"transfer_type" varchar(10) NOT NULL,
	"code" varchar(64),
	"content" text DEFAULT '' NOT NULL,
	"raw_payload" jsonb NOT NULL,
	"received_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "sepay_transactions_sepay_id_unique" UNIQUE("sepay_id")
);
--> statement-breakpoint
CREATE TABLE "spigot_accounts" (
	"id" serial PRIMARY KEY NOT NULL,
	"label" varchar(64) NOT NULL,
	"username" varchar(128) NOT NULL,
	"password_encrypted" text NOT NULL,
	"xf_user_encrypted" text DEFAULT '' NOT NULL,
	"xf_session_encrypted" text DEFAULT '' NOT NULL,
	"status" varchar(20) DEFAULT 'ok' NOT NULL,
	"is_enabled" boolean DEFAULT true NOT NULL,
	"last_verified_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "spigot_accounts_label_unique" UNIQUE("label")
);
--> statement-breakpoint
CREATE TABLE "upstream_state" (
	"plugin_id" integer PRIMARY KEY NOT NULL,
	"version_uuid" varchar(64) NOT NULL,
	"version_name" varchar(64) NOT NULL,
	"release_date_ms" text NOT NULL,
	"checked_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "versions" (
	"id" serial PRIMARY KEY NOT NULL,
	"plugin_id" integer NOT NULL,
	"version" varchar(64),
	"raw_version" varchar(128),
	"sha256" varchar(64) NOT NULL,
	"rel_path" text NOT NULL,
	"bytes" bigint NOT NULL,
	"original_name" varchar(255) NOT NULL,
	"descriptor_kind" varchar(32) DEFAULT 'spigot' NOT NULL,
	"is_stable" boolean DEFAULT true NOT NULL,
	"version_flag" varchar(32) DEFAULT 'ok' NOT NULL,
	"change_logs" text DEFAULT '' NOT NULL,
	"source" varchar(20) DEFAULT 'spigot_auto' NOT NULL,
	"uploaded_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "versions_sha256_unique" UNIQUE("sha256")
);
--> statement-breakpoint
CREATE TABLE "wallet_ledger" (
	"id" serial PRIMARY KEY NOT NULL,
	"discord_user_id" varchar(32) NOT NULL,
	"delta" integer NOT NULL,
	"balance_after" integer NOT NULL,
	"kind" varchar(30) NOT NULL,
	"ref_type" varchar(20) DEFAULT '' NOT NULL,
	"ref_id" integer,
	"note" text DEFAULT '' NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "wallets" (
	"discord_user_id" varchar(32) PRIMARY KEY NOT NULL,
	"balance" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "manual_uploads" ADD CONSTRAINT "manual_uploads_version_id_versions_id_fk" FOREIGN KEY ("version_id") REFERENCES "public"."versions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "manual_uploads" ADD CONSTRAINT "manual_uploads_plugin_id_plugins_id_fk" FOREIGN KEY ("plugin_id") REFERENCES "public"."plugins"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_version_id_versions_id_fk" FOREIGN KEY ("version_id") REFERENCES "public"."versions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pending_download" ADD CONSTRAINT "pending_download_plugin_id_plugins_id_fk" FOREIGN KEY ("plugin_id") REFERENCES "public"."plugins"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "plugin_aliases" ADD CONSTRAINT "plugin_aliases_plugin_id_plugins_id_fk" FOREIGN KEY ("plugin_id") REFERENCES "public"."plugins"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sepay_transactions" ADD CONSTRAINT "sepay_transactions_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "upstream_state" ADD CONSTRAINT "upstream_state_plugin_id_plugins_id_fk" FOREIGN KEY ("plugin_id") REFERENCES "public"."plugins"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "versions" ADD CONSTRAINT "versions_plugin_id_plugins_id_fk" FOREIGN KEY ("plugin_id") REFERENCES "public"."plugins"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_card_topups_poll" ON "card_topups" USING btree ("status","next_poll_at");--> statement-breakpoint
CREATE INDEX "idx_card_topups_user" ON "card_topups" USING btree ("discord_user_id","created_at");--> statement-breakpoint
CREATE INDEX "idx_card_topups_serial" ON "card_topups" USING btree ("serial");--> statement-breakpoint
CREATE INDEX "idx_discount_codes_code" ON "discount_codes" USING btree ("code");--> statement-breakpoint
CREATE INDEX "idx_discount_codes_active" ON "discount_codes" USING btree ("is_active");--> statement-breakpoint
CREATE INDEX "idx_manual_uploads_plugin" ON "manual_uploads" USING btree ("plugin_id");--> statement-breakpoint
CREATE INDEX "idx_manual_uploads_uploader" ON "manual_uploads" USING btree ("uploaded_by");--> statement-breakpoint
CREATE INDEX "idx_orders_status" ON "orders" USING btree ("status");--> statement-breakpoint
CREATE INDEX "idx_orders_user" ON "orders" USING btree ("discord_user_id");--> statement-breakpoint
CREATE INDEX "idx_orders_version_id" ON "orders" USING btree ("version_id");--> statement-breakpoint
CREATE INDEX "idx_orders_code" ON "orders" USING btree ("code");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_pending_download_pair" ON "pending_download" USING btree ("plugin_id","version_uuid");--> statement-breakpoint
CREATE INDEX "idx_pending_download_due" ON "pending_download" USING btree ("next_attempt_at");--> statement-breakpoint
CREATE INDEX "idx_pending_ingest_status" ON "pending_ingest" USING btree ("status");--> statement-breakpoint
CREATE INDEX "idx_pending_ingest_sha256" ON "pending_ingest" USING btree ("sha256");--> statement-breakpoint
CREATE INDEX "idx_plugin_aliases_plugin_id" ON "plugin_aliases" USING btree ("plugin_id");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_plugins_plugin_id" ON "plugins" USING btree ("plugin_id");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_plugins_slug" ON "plugins" USING btree ("slug");--> statement-breakpoint
CREATE INDEX "idx_plugins_resource_id" ON "plugins" USING btree ("resource_id");--> statement-breakpoint
CREATE INDEX "idx_plugins_descriptor_name" ON "plugins" USING btree ("descriptor_name");--> statement-breakpoint
CREATE INDEX "idx_plugins_aliases" ON "plugins" USING gin ("aliases");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_resource_ownership_pair" ON "resource_ownership" USING btree ("resource_id","account_label");--> statement-breakpoint
CREATE INDEX "idx_resource_ownership_state" ON "resource_ownership" USING btree ("resource_id","state");--> statement-breakpoint
CREATE INDEX "idx_sepay_tx_sepay_id" ON "sepay_transactions" USING btree ("sepay_id");--> statement-breakpoint
CREATE INDEX "idx_sepay_tx_code" ON "sepay_transactions" USING btree ("code");--> statement-breakpoint
CREATE INDEX "idx_spigot_accounts_status" ON "spigot_accounts" USING btree ("status");--> statement-breakpoint
CREATE INDEX "idx_spigot_accounts_enabled" ON "spigot_accounts" USING btree ("is_enabled");--> statement-breakpoint
CREATE INDEX "idx_versions_plugin_id" ON "versions" USING btree ("plugin_id");--> statement-breakpoint
CREATE INDEX "idx_versions_plugin_uploaded" ON "versions" USING btree ("plugin_id","uploaded_at");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_versions_sha256" ON "versions" USING btree ("sha256");--> statement-breakpoint
CREATE INDEX "idx_versions_is_stable" ON "versions" USING btree ("is_stable");--> statement-breakpoint
CREATE INDEX "idx_wallet_ledger_user" ON "wallet_ledger" USING btree ("discord_user_id","created_at");