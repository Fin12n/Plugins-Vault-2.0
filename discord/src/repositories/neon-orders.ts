import { eq, desc, and, lt, or, isNull } from "drizzle-orm";
import type { Database } from "../db/neon.js";
import { orders, type Order, type NewOrder } from "@vault/db";
import { applyLedgerEntryTx } from "./neon-wallets.js";

type DbOrTx = Parameters<Parameters<Database["transaction"]>[0]>[0] | Database;

/**
 * Tạo đơn hàng mới cho thanh toán SePay hoặc mua qua ví.
 */
export async function createOrder(
  db: DbOrTx,
  input: NewOrder
): Promise<Order> {
  const inserted = await db.insert(orders).values(input).returning();
  const created = inserted[0];
  if (!created) {
    throw new Error("Không thể tạo đơn hàng");
  }
  return created;
}

/**
 * Tìm đơn hàng theo mã code SePay (ví dụ: VN12345678).
 */
export async function findOrderByCode(
  db: DbOrTx,
  code: string
): Promise<Order | null> {
  const result = await db
    .select()
    .from(orders)
    .where(eq(orders.code, code.toUpperCase()));
  return result[0] ?? null;
}

/**
 * Tìm đơn hàng theo ID.
 */
export async function findOrderById(
  db: DbOrTx,
  id: number
): Promise<Order | null> {
  const result = await db.select().from(orders).where(eq(orders.id, id));
  return result[0] ?? null;
}

/**
 * Cập nhật trạng thái đơn hàng khi SePay báo đã thanh toán hoặc giao hàng.
 */
export async function updateOrderStatus(
  db: DbOrTx,
  id: number,
  status: "paid" | "delivered" | "expired" | "underpaid" | "wallet_paid" | "refunded",
  paidAmount?: number
): Promise<Order | null> {
  const now = new Date();
  const patch: Partial<NewOrder> = { status };
  if (paidAmount !== undefined) patch.paidAmount = paidAmount;
  if (status === "paid" || status === "wallet_paid") patch.paidAt = now;
  if (status === "delivered") patch.deliveredAt = now;

  const updated = await db
    .update(orders)
    .set(patch)
    .where(eq(orders.id, id))
    .returning();
  return updated[0] ?? null;
}

/**
 * Lấy lịch sử đơn hàng của một người dùng Discord.
 */
export async function listOrdersByUser(
  db: DbOrTx,
  discordUserId: string,
  limit = 20
): Promise<Order[]> {
  return db
    .select()
    .from(orders)
    .where(eq(orders.discordUserId, discordUserId))
    .orderBy(desc(orders.createdAt))
    .limit(limit);
}

/**
 * Lấy danh sách đơn hàng đang chờ thanh toán chưa hết hạn.
 */
export async function listPendingOrders(
  db: DbOrTx,
  discordUserId: string
): Promise<Order[]> {
  return db
    .select()
    .from(orders)
    .where(
      and(
        eq(orders.discordUserId, discordUserId),
        eq(orders.status, "pending")
      )
    )
    .orderBy(desc(orders.createdAt));
}

/**
 * Hết hạn các đơn hàng pending đã quá thời gian expires_at.
 */
export async function expireStaleOrders(
  db: Database,
  now = new Date()
): Promise<number> {
  const res = await db
    .update(orders)
    .set({ status: "expired" })
    .where(
      and(
        eq(orders.status, "pending"),
        lt(orders.expiresAt, now)
      )
    )
    .returning();
  return res.length;
}

/**
 * Danh sách đơn hàng đã thanh toán nhưng chưa hoàn tất giao hàng.
 */
export async function listUndeliveredPaidOrders(
  db: Database
): Promise<Order[]> {
  return db
    .select()
    .from(orders)
    .where(
      and(
        or(eq(orders.status, "paid"), eq(orders.status, "wallet_paid")),
        isNull(orders.deliveredAt)
      )
    )
    .orderBy(orders.createdAt);
}

/**
 * Hoàn tiền đơn hàng vào ví người dùng tuân thủ Canonical Lock Order:
 * Lock wallets (2) -> Lock orders (3).
 */
export async function refundOrderWallet(
  db: Database,
  orderId: number,
  reason: string
): Promise<{ order: Order; newBalance: number }> {
  return await db.transaction(async (tx) => {
    // 1. Pre-read đơn hàng để lấy discordUserId và amount
    const preOrder = await tx
      .select()
      .from(orders)
      .where(eq(orders.id, orderId))
      .limit(1);

    const orderRow = preOrder[0];
    if (!orderRow) {
      throw new Error(`Order #${orderId} không tồn tại`);
    }

    if (orderRow.status === "refunded") {
      throw new Error(`Order #${orderId} đã được hoàn tiền trước đó`);
    }

    if (orderRow.status !== "paid" && orderRow.status !== "wallet_paid") {
      throw new Error(`Order #${orderId} đang ở trạng thái '${orderRow.status}', không thể hoàn tiền`);
    }

    const refundAmount = orderRow.paidAmount && orderRow.paidAmount > 0
      ? orderRow.paidAmount
      : orderRow.amount;

    // 2. Canonical Lock Order step 2: Lock wallets FIRST
    const walletRes = await applyLedgerEntryTx(tx, {
      discordUserId: orderRow.discordUserId,
      delta: refundAmount,
      kind: "order_refund",
      refType: "orders",
      refId: orderRow.id,
      note: `Refund order #${orderRow.code}: ${reason}`,
    });

    // 3. Canonical Lock Order step 3: Lock orders NEXT with FOR UPDATE
    const lockedOrders = await tx
      .select()
      .from(orders)
      .where(eq(orders.id, orderId))
      .for("update");

    const lockedOrder = lockedOrders[0];
    if (!lockedOrder || lockedOrder.status === "refunded") {
      throw new Error(`Xung đột giao dịch khi hoàn tiền đơn hàng #${orderId}`);
    }

    // 4. Update order to refunded
    const updatedOrders = await tx
      .update(orders)
      .set({
        status: "refunded",
      })
      .where(eq(orders.id, orderId))
      .returning();

    const finalOrder = updatedOrders[0];
    if (!finalOrder) {
      throw new Error(`Không thể cập nhật trạng thái đơn hàng #${orderId} thành refunded`);
    }

    return {
      order: finalOrder,
      newBalance: walletRes.wallet.balance,
    };
  });
}
