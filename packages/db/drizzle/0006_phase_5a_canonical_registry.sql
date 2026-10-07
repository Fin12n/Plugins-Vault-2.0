-- Phase 5A: Canonical Plugin, Version, Artifact & Entitlement Registry
-- Migration: 0006_phase_5a_canonical_registry.sql

-- ============================================================================
-- A. Extend plugins table with canonical scan scheduling metadata
-- ============================================================================
ALTER TABLE "plugins" ADD COLUMN IF NOT EXISTS "enabled" boolean DEFAULT true NOT NULL;
--> statement-breakpoint
ALTER TABLE "plugins" ADD COLUMN IF NOT EXISTS "scan_interval_seconds" integer DEFAULT 3600 NOT NULL;
--> statement-breakpoint
ALTER TABLE "plugins" ADD COLUMN IF NOT EXISTS "next_scan_at" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "plugins" ADD COLUMN IF NOT EXISTS "last_scan_at" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "plugins" ADD COLUMN IF NOT EXISTS "last_scan_status" varchar(32) DEFAULT 'idle' NOT NULL;
--> statement-breakpoint
ALTER TABLE "plugins" ADD COLUMN IF NOT EXISTS "last_scan_error" text;
--> statement-breakpoint

-- Compound unique constraint for external source identity (e.g. spigot resource_id)
CREATE UNIQUE INDEX IF NOT EXISTS "idx_plugins_source_resource"
  ON "plugins" USING btree ("platform", "resource_id")
  WHERE (resource_id IS NOT NULL);
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "idx_plugins_scan_schedule"
  ON "plugins" USING btree ("enabled", "next_scan_at");
--> statement-breakpoint

-- ============================================================================
-- B. Extend versions table with canonical release identity & lifecycle
-- ============================================================================
ALTER TABLE "versions" ADD COLUMN IF NOT EXISTS "version_normalized" varchar(64);
--> statement-breakpoint
ALTER TABLE "versions" ADD COLUMN IF NOT EXISTS "source_version_id" varchar(64);
--> statement-breakpoint
ALTER TABLE "versions" ADD COLUMN IF NOT EXISTS "source_release_id" varchar(64);
--> statement-breakpoint
ALTER TABLE "versions" ADD COLUMN IF NOT EXISTS "released_at" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "versions" ADD COLUMN IF NOT EXISTS "metadata" jsonb DEFAULT '{}'::jsonb NOT NULL;
--> statement-breakpoint
ALTER TABLE "versions" ADD COLUMN IF NOT EXISTS "status" varchar(32) DEFAULT 'active' NOT NULL;
--> statement-breakpoint
ALTER TABLE "versions" ADD COLUMN IF NOT EXISTS "first_seen_at" timestamp with time zone DEFAULT now() NOT NULL;
--> statement-breakpoint
ALTER TABLE "versions" ADD COLUMN IF NOT EXISTS "last_seen_at" timestamp with time zone DEFAULT now() NOT NULL;
--> statement-breakpoint
ALTER TABLE "versions" ADD COLUMN IF NOT EXISTS "created_at" timestamp with time zone DEFAULT now() NOT NULL;
--> statement-breakpoint
ALTER TABLE "versions" ADD COLUMN IF NOT EXISTS "updated_at" timestamp with time zone DEFAULT now() NOT NULL;
--> statement-breakpoint

-- Backfill normalized version for existing rows
UPDATE "versions"
SET "version_normalized" = regexp_replace(trim("version"), '^[vV]', '')
WHERE "version_normalized" IS NULL AND "version" IS NOT NULL;
--> statement-breakpoint

CREATE UNIQUE INDEX IF NOT EXISTS "idx_versions_plugin_version_normalized"
  ON "versions" USING btree ("plugin_id", "version_normalized")
  WHERE (version_normalized IS NOT NULL);
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "idx_versions_released_at"
  ON "versions" USING btree ("plugin_id", "released_at");
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "idx_versions_status"
  ON "versions" USING btree ("status");
--> statement-breakpoint

-- ============================================================================
-- C. Create plugin_artifacts table (Physical File Lifecycle Separation)
-- ============================================================================
CREATE TABLE IF NOT EXISTS "plugin_artifacts" (
  "id" serial PRIMARY KEY,
  "plugin_version_id" integer NOT NULL REFERENCES "versions"("id") ON DELETE CASCADE,
  "storage_key" text NOT NULL,
  "filename" varchar(255) NOT NULL,
  "size_bytes" bigint NOT NULL,
  "sha256" varchar(64) NOT NULL,
  "mime_type" varchar(64) DEFAULT 'application/java-archive' NOT NULL,
  "jar_valid" boolean DEFAULT false NOT NULL,
  "status" varchar(32) DEFAULT 'PENDING' NOT NULL,
  "downloaded_at" timestamp with time zone,
  "verified_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint

CREATE UNIQUE INDEX IF NOT EXISTS "idx_plugin_artifacts_version"
  ON "plugin_artifacts" USING btree ("plugin_version_id");
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "idx_plugin_artifacts_sha256"
  ON "plugin_artifacts" USING btree ("sha256");
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "idx_plugin_artifacts_status"
  ON "plugin_artifacts" USING btree ("status");
--> statement-breakpoint

-- Backfill existing versions with existing file information into canonical artifacts
INSERT INTO "plugin_artifacts" (
  "plugin_version_id",
  "storage_key",
  "filename",
  "size_bytes",
  "sha256",
  "mime_type",
  "jar_valid",
  "status",
  "downloaded_at",
  "verified_at"
)
SELECT
  v.id,
  v.rel_path,
  v.original_name,
  v.bytes,
  v.sha256,
  'application/java-archive',
  true,
  'READY',
  v.uploaded_at,
  v.uploaded_at
FROM "versions" v
ON CONFLICT ("plugin_version_id") DO NOTHING;
--> statement-breakpoint

-- ============================================================================
-- D. Create plugin_entitlements table (Version-Specific Authorization Foundation)
-- ============================================================================
CREATE TABLE IF NOT EXISTS "plugin_entitlements" (
  "id" serial PRIMARY KEY,
  "user_id" varchar(32) NOT NULL,
  "plugin_version_id" integer NOT NULL REFERENCES "versions"("id") ON DELETE CASCADE,
  "order_id" integer REFERENCES "orders"("id") ON DELETE SET NULL,
  "status" varchar(20) DEFAULT 'ACTIVE' NOT NULL,
  "granted_at" timestamp with time zone DEFAULT now() NOT NULL,
  "revoked_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint

CREATE UNIQUE INDEX IF NOT EXISTS "idx_plugin_entitlements_user_version"
  ON "plugin_entitlements" USING btree ("user_id", "plugin_version_id");
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "idx_plugin_entitlements_user"
  ON "plugin_entitlements" USING btree ("user_id");
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "idx_plugin_entitlements_version"
  ON "plugin_entitlements" USING btree ("plugin_version_id");
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "idx_plugin_entitlements_status"
  ON "plugin_entitlements" USING btree ("status");
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "idx_plugin_entitlements_order"
  ON "plugin_entitlements" USING btree ("order_id");
