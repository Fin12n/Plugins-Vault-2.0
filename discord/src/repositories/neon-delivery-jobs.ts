import { eq, and, sql } from "drizzle-orm";
import type { Database } from "../db/neon.js";
import { deliveryJobs, type DeliveryJob, type NewDeliveryJob } from "@vault/db";

export async function createDeliveryJob(
  db: Database,
  input: {
    orderId: number;
    discordUserId: string;
    versionId: number;
    requestedMethod?: string;
    status?: "queued" | "processing" | "delivered" | "failed";
  }
): Promise<DeliveryJob | null> {
  const inserted = await db
    .insert(deliveryJobs)
    .values({
      orderId: input.orderId,
      discordUserId: input.discordUserId,
      versionId: input.versionId,
      requestedMethod: input.requestedMethod ?? "attachment",
      status: input.status ?? "queued",
    })
    .onConflictDoNothing()
    .returning();

  return inserted[0] ?? null;
}

export async function findDeliveryJobByOrderAndMethod(
  db: Database,
  orderId: number,
  requestedMethod = "attachment"
): Promise<DeliveryJob | null> {
  const result = await db
    .select()
    .from(deliveryJobs)
    .where(
      and(
        eq(deliveryJobs.orderId, orderId),
        eq(deliveryJobs.requestedMethod, requestedMethod)
      )
    );
  return result[0] ?? null;
}

/**
 * Claim atomic lock for queued or stale processing jobs (Lease timeout recovery)
 */
export async function claimStaleOrQueuedDeliveryJob(
  db: Database,
  claimToken: string,
  leaseDurationSeconds = 300
): Promise<DeliveryJob | null> {
  const query = sql`
    UPDATE delivery_jobs
    SET status = 'processing',
        claim_token = ${claimToken},
        locked_at = NOW(),
        external_attempt_count = external_attempt_count + 1,
        updated_at = NOW()
    WHERE id = (
      SELECT id FROM delivery_jobs
      WHERE status = 'queued'
         OR (status = 'processing' AND locked_at < NOW() - (${leaseDurationSeconds} || ' seconds')::interval)
      ORDER BY created_at ASC
      FOR UPDATE SKIP LOCKED
      LIMIT 1
    )
    RETURNING id, order_id, discord_user_id, version_id, requested_method, status, external_attempt_count, claim_token, locked_at, retry_count, last_error, created_at, updated_at
  `;

  const result = await db.execute(query);
  const rows = (result.rows ?? result) as unknown as DeliveryJob[];
  return rows[0] ?? null;
}

export async function markDeliveryJobSuccess(
  db: Database,
  jobId: number,
  claimToken: string
): Promise<boolean> {
  const updated = await db
    .update(deliveryJobs)
    .set({
      status: "delivered",
      claimToken: null,
      lockedAt: null,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(deliveryJobs.id, jobId),
        eq(deliveryJobs.claimToken, claimToken)
      )
    )
    .returning({ id: deliveryJobs.id });

  return updated.length === 1;
}

export async function markDeliveryJobRetryable(
  db: Database,
  jobId: number,
  claimToken: string,
  error: string
): Promise<boolean> {
  const updated = await db
    .update(deliveryJobs)
    .set({
      status: "queued",
      claimToken: null,
      lockedAt: null,
      retryCount: sql`${deliveryJobs.retryCount} + 1`,
      lastError: error,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(deliveryJobs.id, jobId),
        eq(deliveryJobs.claimToken, claimToken)
      )
    )
    .returning({ id: deliveryJobs.id });

  return updated.length === 1;
}

export async function markDeliveryJobFailed(
  db: Database,
  jobId: number,
  claimToken: string,
  error: string
): Promise<boolean> {
  const updated = await db
    .update(deliveryJobs)
    .set({
      status: "failed",
      claimToken: null,
      lockedAt: null,
      lastError: error,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(deliveryJobs.id, jobId),
        eq(deliveryJobs.claimToken, claimToken)
      )
    )
    .returning({ id: deliveryJobs.id });

  return updated.length === 1;
}
