import { eq, desc } from "drizzle-orm";
import type { Database } from "../db/neon.js";
import { sepayTransactions, type SepayTransaction, type NewSepayTransaction } from "@vault/db";

type DbOrTx = Parameters<Parameters<Database["transaction"]>[0]>[0] | Database;

export type SepayStatus =
  | "unmatched"
  | "credited"
  | "underpaid"
  | "overpaid"
  | "refunded"
  | "duplicate_transfer"
  | "ignored_outgoing"
  | "ignored_no_code";

/**
 * Kiểm tra xem trạng thái SePay có phải là Terminal (kết thúc, không được retry/resume) hay không.
 */
export function isTerminalSepayStatus(status: string): boolean {
  return [
    "credited",
    "overpaid",
    "underpaid",
    "duplicate_transfer",
    "refunded",
    "ignored_outgoing",
    "ignored_no_code",
  ].includes(status);
}

/**
 * Kiểm tra xem giao dịch SePay đã từng được xử lý chưa (Idempotency Guard).
 */
export async function hasSepayTransaction(
  db: DbOrTx,
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
 * Tìm giao dịch SePay theo sepayId (có hỗ trợ khóa hàng FOR UPDATE).
 */
export async function findSepayTransactionBySepayId(
  db: DbOrTx,
  sepayId: number,
  options?: { forUpdate?: boolean }
): Promise<SepayTransaction | null> {
  let query = db
    .select()
    .from(sepayTransactions)
    .where(eq(sepayTransactions.sepayId, sepayId))
    .limit(1);

  if (options?.forUpdate && "for" in query) {
    query = (query as any).for("update");
  }

  const rows = await query;
  return rows[0] ?? null;
}

/**
 * Ghi nhận giao dịch SePay vào cơ sở dữ liệu.
 */
export async function recordSepayTransaction(
  db: DbOrTx,
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
  db: DbOrTx,
  code: string
): Promise<SepayTransaction | null> {
  const result = await db
    .select()
    .from(sepayTransactions)
    .where(eq(sepayTransactions.code, code))
    .limit(1);
  return result[0] ?? null;
}

/**
 * Cập nhật trạng thái và liên kết đơn hàng hoặc topup cho SePay Transaction.
 * Tuân thủ invariant chk_sepay_target_exclusivity.
 */
export async function updateSepayTransactionStatus(
  db: DbOrTx,
  id: number,
  patch: {
    status?: SepayStatus;
    orderId?: number | null;
    topupId?: number | null;
    description?: string;
    processedAt?: Date | null;
  }
): Promise<SepayTransaction | null> {
  // Invariant target exclusivity check
  if (patch.orderId !== undefined && patch.topupId !== undefined) {
    if (patch.orderId !== null && patch.topupId !== null) {
      throw new Error("INVARIANT_VIOLATION: SePay transaction cannot link to both order_id and topup_id simultaneously");
    }
  }

  const rows = await db
    .update(sepayTransactions)
    .set({
      ...(patch.status !== undefined ? { status: patch.status } : {}),
      ...(patch.orderId !== undefined ? { orderId: patch.orderId } : {}),
      ...(patch.topupId !== undefined ? { topupId: patch.topupId } : {}),
      ...(patch.description !== undefined ? { description: patch.description } : {}),
      ...(patch.processedAt !== undefined ? { processedAt: patch.processedAt } : {}),
    })
    .where(eq(sepayTransactions.id, id))
    .returning();

  return rows[0] ?? null;
}

/**
 * Lấy danh sách giao dịch SePay gần đây.
 */
export async function listRecentSepayTransactions(
  db: DbOrTx,
  limit = 50
): Promise<SepayTransaction[]> {
  return db
    .select()
    .from(sepayTransactions)
    .orderBy(desc(sepayTransactions.receivedAt))
    .limit(limit);
}
