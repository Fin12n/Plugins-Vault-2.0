import { eq } from "drizzle-orm";
import type { Database } from "../db/neon.js";
import { sepayTransactions, type SepayTransaction, type NewSepayTransaction } from "@vault/db";

/**
 * Kiểm tra xem giao dịch SePay đã từng được xử lý chưa (Idempotency Guard).
 * Chống triệt để việc webhook gửi đúp dẫn đến cộng tiền 2 lần.
 */
export async function hasSepayTransaction(
  db: Database,
  sepayId: number
): Promise<boolean> {
  const result = await db
    .select({ id: sepayTransactions.id })
    .from(sepayTransactions)
    .where(eq(sepayTransactions.sepayId, sepayId))
    .limit(1);
  return result.length > 0;
}

/**
 * Ghi nhận giao dịch SePay thành công vào cơ sở dữ liệu.
 */
export async function recordSepayTransaction(
  db: Database,
  input: NewSepayTransaction
): Promise<SepayTransaction> {
  const inserted = await db.insert(sepayTransactions).values(input).returning();
  const created = inserted[0];
  if (!created) {
    throw new Error("Không thể ghi nhận giao dịch SePay vào database");
  }
  return created;
}

/**
 * Tìm giao dịch SePay theo mã chuyển khoản.
 */
export async function findSepayTransactionByCode(
  db: Database,
  code: string
): Promise<SepayTransaction | null> {
  const result = await db
    .select()
    .from(sepayTransactions)
    .where(eq(sepayTransactions.code, code))
    .limit(1);
  return result[0] ?? null;
}
