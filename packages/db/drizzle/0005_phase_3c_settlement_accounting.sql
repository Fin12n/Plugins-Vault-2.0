-- Phase 3C: Canonical Settlement, Revenue Accounting & Reconciliation
-- Migration: 0005_phase_3c_settlement_accounting.sql
-- PLAN: PLAN-Phase-3C-Accounting-Settlement-Reconciliation-v6-2026-10-05

-- ============================================================================
-- A. Add settled_amount column to orders
-- ============================================================================
ALTER TABLE "orders" ADD COLUMN IF NOT EXISTS "settled_amount" integer;
--> statement-breakpoint

-- Non-negative constraint: NULL before settlement, >= 0 after settlement
ALTER TABLE "orders" DROP CONSTRAINT IF EXISTS "chk_orders_settled_amount_non_negative";
--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "chk_orders_settled_amount_non_negative"
  CHECK (settled_amount IS NULL OR settled_amount >= 0);
--> statement-breakpoint

-- Index for revenue reporting queries (paid_at range scans)
CREATE INDEX IF NOT EXISTS "idx_orders_settled_amount" ON "orders" USING btree ("settled_amount");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_orders_paid_at" ON "orders" USING btree ("paid_at");
--> statement-breakpoint

-- ============================================================================
-- B. Create _migration_exceptions table (persistent exception / reconciliation store)
-- ============================================================================
CREATE TABLE IF NOT EXISTS "_migration_exceptions" (
  "id" serial PRIMARY KEY,
  "source" varchar(32) NOT NULL,
  "run_id" varchar(64) NOT NULL,
  "entity_type" varchar(32) NOT NULL,
  "entity_id" integer NOT NULL,
  "reason_code" varchar(64) NOT NULL,
  "evidence" jsonb NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "resolved_at" timestamp with time zone
);
--> statement-breakpoint

CREATE UNIQUE INDEX IF NOT EXISTS "idx_migration_exceptions_uniq"
  ON "_migration_exceptions" ("source", "run_id", "entity_type", "entity_id", "reason_code");
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "idx_migration_exceptions_entity"
  ON "_migration_exceptions" ("entity_type", "entity_id");
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "idx_migration_exceptions_reason"
  ON "_migration_exceptions" ("reason_code");
