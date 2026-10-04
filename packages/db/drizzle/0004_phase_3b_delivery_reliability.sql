ALTER TABLE "delivery_jobs" ADD COLUMN IF NOT EXISTS "next_retry_at" timestamp with time zone;
--> statement-breakpoint
DROP INDEX IF EXISTS "idx_delivery_jobs_status_locked";
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_delivery_jobs_status_locked" ON "delivery_jobs" USING btree ("status", "next_retry_at", "locked_at");
