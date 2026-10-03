import { eq, desc, and } from "drizzle-orm";
import type { Database } from "../db/neon.js";
import { orders, type Order, type NewOrder } from "@vault/db";

/**
 * Tạo đơn hàng mới cho thanh toán SePay hoặc mua qua ví.
 */
export async function createOrder(
  db: Database,
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
  db: Database,
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
  db: Database,
  id: number
): Promise<Order | null> {
  const result = await db.select().from(orders).where(eq(orders.id, id));
  return result[0] ?? null;
}

/**
 * Cập nhật trạng thái đơn hàng khi SePay báo đã thanh toán.
 */
export async function updateOrderStatus(
  db: Database,
  id: number,
  status: "paid" | "delivered" | "expired" | "underpaid" | "wallet_paid",
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
  db: Database,
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
  db: Database,
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
