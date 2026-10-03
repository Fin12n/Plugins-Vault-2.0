CREATE TABLE "audit_logs" (
	"id" serial PRIMARY KEY NOT NULL,
	"staff_id" integer,
	"discord_user_id" varchar(32),
	"action" varchar(64) NOT NULL,
	"target_type" varchar(32),
	"target_id" varchar(64),
	"details" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"ip_address" varchar(45),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "discord_channels" (
	"id" serial PRIMARY KEY NOT NULL,
	"purpose" varchar(32) NOT NULL,
	"channel_id" varchar(32) NOT NULL,
	"channel_name" varchar(100),
	"guild_id" varchar(32),
	"is_enabled" boolean DEFAULT true NOT NULL,
	"updated_by" varchar(32),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "discord_channels_purpose_unique" UNIQUE("purpose")
);
--> statement-breakpoint
CREATE TABLE "staffs" (
	"id" serial PRIMARY KEY NOT NULL,
	"email" varchar(255),
	"dashboard_user_id" varchar(64),
	"discord_user_id" varchar(32),
	"username" varchar(64) NOT NULL,
	"display_name" varchar(100),
	"avatar_url" text,
	"role" varchar(32) DEFAULT 'staff' NOT NULL,
	"permissions" text[] DEFAULT '{}' NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"added_by" varchar(32),
	"last_login_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "staffs_email_unique" UNIQUE("email"),
	CONSTRAINT "staffs_dashboard_user_id_unique" UNIQUE("dashboard_user_id"),
	CONSTRAINT "staffs_discord_user_id_unique" UNIQUE("discord_user_id")
);
--> statement-breakpoint
DROP TABLE IF EXISTS "dashboard_staff" CASCADE;--> statement-breakpoint
ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_staff_id_staffs_id_fk" FOREIGN KEY ("staff_id") REFERENCES "public"."staffs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_audit_logs_staff_id" ON "audit_logs" USING btree ("staff_id");--> statement-breakpoint
CREATE INDEX "idx_audit_logs_action" ON "audit_logs" USING btree ("action");--> statement-breakpoint
CREATE INDEX "idx_audit_logs_created_at" ON "audit_logs" USING btree ("created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_discord_channels_purpose" ON "discord_channels" USING btree ("purpose");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_staffs_email" ON "staffs" USING btree ("email");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_staffs_dashboard_user_id" ON "staffs" USING btree ("dashboard_user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_staffs_discord_user_id" ON "staffs" USING btree ("discord_user_id");--> statement-breakpoint
CREATE INDEX "idx_staffs_role" ON "staffs" USING btree ("role");--> statement-breakpoint
CREATE INDEX "idx_staffs_is_active" ON "staffs" USING btree ("is_active");