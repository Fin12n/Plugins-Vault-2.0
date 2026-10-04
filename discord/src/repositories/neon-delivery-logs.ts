import { eq, desc } from "drizzle-orm";
import type { Database } from "../db/neon.js";
import { deliveryLogs, type DeliveryLog, type NewDeliveryLog } from "@vault/db";

type DbOrTx = Parameters<Parameters<Database["transaction"]>[0]>[0] | Database;

/**
 * Ghi nhận log giao hàng thành công (Idempotent theo delivery_idempotency_key).
 */
export async function createDeliveryLog(
  db: DbOrTx,
  input: NewDeliveryLog
): Promise<DeliveryLog | null> {
  const rows = await db
    .insert(deliveryLogs)
    .values(input)
    .onConflictDoNothing({ target: deliveryLogs.deliveryIdempotencyKey })
    .returning();

  return rows[0] ?? null;
}

/**
 * Tìm delivery log theo delivery_idempotency_key.
 */
export async function findDeliveryLogByIdempotencyKey(
  db: DbOrTx,
  deliveryIdempotencyKey: string
): Promise<DeliveryLog | null> {
  const rows = await db
    .select()
    .from(deliveryLogs)
    .where(eq(deliveryLogs.deliveryIdempotencyKey, deliveryIdempotencyKey))
    .limit(1);

  return rows[0] ?? null;
}

/**
 * Danh sách delivery log theo user.
 */
export async function listDeliveryLogsByUser(
  db: Database,
  discordUserId: string,
  limit = 50
): Promise<DeliveryLog[]> {
  return db
    .select()
    .from(deliveryLogs)
    .where(eq(deliveryLogs.discordUserId, discordUserId))
    .orderBy(desc(deliveryLogs.deliveredAt))
    .limit(limit);
}

/**
 * Danh sách delivery log theo order ID.
 */
export async function listDeliveryLogsByOrder(
  db: Database,
  orderId: number
): Promise<DeliveryLog[]> {
  return db
    .select()
    .from(deliveryLogs)
    .where(eq(deliveryLogs.orderId, orderId))
    .orderBy(desc(deliveryLogs.deliveredAt));
}
