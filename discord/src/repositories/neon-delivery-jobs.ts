import { eq, and, sql, inArray } from "drizzle-orm";
import type { Database } from "../db/neon.js";
import type { DbOrTx } from "./neon-wallets.js";
import { deliveryJobs, type DeliveryJob, type NewDeliveryJob } from "@vault/db";

export async function createDeliveryJob(
  db: DbOrTx,
  input: {
    orderId: number;
    discordUserId: string;
    versionId: number;
    requestedMethod?: string;
    status?: "queued" | "processing" | "delivered" | "failed" | "retryable";
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
  db: DbOrTx,
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
 * Tìm job giao hàng hoạt động gần nhất của một đơn hàng (để kiểm tra Reservation trong Refund / Cancel)
 */
export async function findActiveDeliveryJobByOrderId(
  db: DbOrTx,
  orderId: number
): Promise<DeliveryJob | null> {
  const result = await db
    .select()
    .from(deliveryJobs)
    .where(eq(deliveryJobs.orderId, orderId))
    .limit(1);
  return result[0] ?? null;
}

/**
 * Claim atomic lock for queued or stale processing jobs (Lease timeout recovery)
 * Tuân thủ nghiêm ngặt Invariant v7:
 * - Cho phép: 'queued', 'retryable' (đến hạn next_retry_at), 'processing' (quá hạn lease)
 * - Tuyệt đối cấm: 'delivered', 'failed', 'cancelled', 'processing' còn hạn lease.
 */
export async function claimStaleOrQueuedDeliveryJob(
  db: DbOrTx,
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
         OR (status = 'retryable' AND (next_retry_at IS NULL OR next_retry_at <= NOW()))
         OR (status = 'processing' AND locked_at <= NOW() - (${leaseDurationSeconds} || ' seconds')::interval)
      ORDER BY created_at ASC
      FOR UPDATE SKIP LOCKED
      LIMIT 1
    )
    RETURNING id, order_id, discord_user_id, version_id, requested_method, status, external_attempt_count, claim_token, locked_at, retry_count, last_error, next_retry_at, created_at, updated_at
  `;

  const result = await db.execute(query);
  const rows = (result.rows ?? result) as unknown as DeliveryJob[];
  return rows[0] ?? null;
}

/**
 * Claim trực tiếp một job cụ thể theo ID với đầy đủ điều kiện bảo vệ (Conditional UPDATE)
 */
export async function claimDeliveryJobById(
  db: DbOrTx,
  jobId: number,
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
    WHERE id = ${jobId}
      AND (
        status = 'queued'
        OR (status = 'retryable' AND (next_retry_at IS NULL OR next_retry_at <= NOW()))
        OR (status = 'processing' AND locked_at <= NOW() - (${leaseDurationSeconds} || ' seconds')::interval)
      )
    RETURNING id, order_id, discord_user_id, version_id, requested_method, status, external_attempt_count, claim_token, locked_at, retry_count, last_error, next_retry_at, created_at, updated_at
  `;

  const result = await db.execute(query);
  const rows = (result.rows ?? result) as unknown as DeliveryJob[];
  return rows[0] ?? null;
}

export async function markDeliveryJobSuccess(
  db: DbOrTx,
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

/**
 * Đánh dấu job lỗi tạm thời với Exponential Backoff và trần MAX_RETRIES = 5.
 */
export async function markDeliveryJobRetryable(
  db: DbOrTx,
  jobId: number,
  claimToken: string,
  error: string,
  currentRetryCount = 0,
  maxRetries = 5
): Promise<boolean> {
  const nextRetryCount = currentRetryCount + 1;

  if (nextRetryCount >= maxRetries) {
    // Vượt quá số lần thử tối đa -> Chuyển thành lỗi vĩnh viễn (failed)
    const updated = await db
      .update(deliveryJobs)
      .set({
        status: "failed",
        claimToken: null,
        lockedAt: null,
        retryCount: nextRetryCount,
        lastError: `Quá số lần thử lại tối đa (${maxRetries}): ${error}`,
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

  // Tính thời gian giãn cách theo lũy thừa 2: 30s, 60s, 120s, 240s... tối đa 600s
  const delaySeconds = Math.min(30 * Math.pow(2, currentRetryCount), 600);

  const query = sql`
    UPDATE delivery_jobs
    SET status = 'retryable',
        claim_token = NULL,
        locked_at = NULL,
        retry_count = ${nextRetryCount},
        last_error = ${error},
        next_retry_at = NOW() + (${delaySeconds} || ' seconds')::interval,
        updated_at = NOW()
    WHERE id = ${jobId}
      AND claim_token = ${claimToken}
    RETURNING id
  `;

  const result = await db.execute(query);
  const rows = (result.rows ?? result) as unknown as { id: number }[];
  return rows.length === 1;
}

export async function markDeliveryJobFailed(
  db: DbOrTx,
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

/**
 * Gia hạn thời hạn Lease (Heartbeat) cho tiến trình I/O ngoại vi kéo dài
 */
export async function refreshDeliveryJobHeartbeat(
  db: DbOrTx,
  jobId: number,
  claimToken: string
): Promise<boolean> {
  const updated = await db
    .update(deliveryJobs)
    .set({
      lockedAt: new Date(),
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(deliveryJobs.id, jobId),
        eq(deliveryJobs.claimToken, claimToken),
        eq(deliveryJobs.status, "processing")
      )
    )
    .returning({ id: deliveryJobs.id });

  return updated.length === 1;
}

/**
 * Hủy các job giao hàng chưa chạy (queued, retryable) của một đơn hàng khi đơn bị Hoàn tiền / Hủy
 */
export async function cancelDeliveryJobsByOrder(
  db: DbOrTx,
  orderId: number,
  reason = "order_cancelled"
): Promise<number> {
  const updated = await db
    .update(deliveryJobs)
    .set({
      status: "failed",
      claimToken: null,
      lockedAt: null,
      lastError: reason,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(deliveryJobs.orderId, orderId),
        inArray(deliveryJobs.status, ["queued", "retryable"])
      )
    )
    .returning({ id: deliveryJobs.id });

  return updated.length;
}
