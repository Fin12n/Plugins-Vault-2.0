import { eq, desc, and, lt, or, isNull, inArray } from "drizzle-orm";
import type { Database } from "../db/neon.js";
import {
  orders,
  wallets,
  walletLedger,
  deliveryJobs,
  type Order,
  type NewOrder,
} from "@vault/db";
import { applyLedgerEntryTx } from "./neon-wallets.js";
import { revokeDownloadTokensByOrder } from "./neon-download-tokens.js";
import {
  findActiveDeliveryJobByOrderId,
  cancelDeliveryJobsByOrder,
} from "./neon-delivery-jobs.js";

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

export {
  settleOrderPaidTx,
  settleOrderWalletPaidTx,
  type SettleOrderPaidInput,
  type SettleOrderWalletPaidInput,
} from "./neon-settlement.js";

export interface UpdateOrderStatusOptions {
  settlementContext?: boolean;
}

const TERMINAL_ORDER_STATUSES = ["refunded", "cancelled", "expired", "delivered"];

/**
 * Cập nhật trạng thái đơn hàng phi tài chính (delivered, expired, underpaid, cancelled).
 * Áp dụng State Guard:
 * - Generic updateOrderStatus tuyệt đối không được tạo settlement fact.
 * - Caller tùy tiện gọi updateOrderStatus(id, "paid") mà không có settlement context sẽ bị REJECT.
 * - Tuyệt đối không cho phép đơn hàng terminal (refunded, cancelled, expired, delivered) chuyển sang paid/wallet_paid.
 */
export async function updateOrderStatus(
  db: DbOrTx,
  id: number,
  status: "paid" | "delivered" | "expired" | "underpaid" | "wallet_paid" | "refunded" | "cancelled",
  paidAmount?: number,
  options?: UpdateOrderStatusOptions
): Promise<Order | null> {
  // Guard 1: Generic updateOrderStatus cannot create settlement facts or mark orders paid without settlement context
  if ((status === "paid" || status === "wallet_paid") && !options?.settlementContext) {
    throw new Error(
      `Financial settlement via generic updateOrderStatus('${status}') without settlement context is rejected. Use settleOrderPaidTx or settleOrderWalletPaidTx.`
    );
  }

  // Guard 2: Terminal orders cannot reopen
  const [existingOrder] = await db
    .select({ status: orders.status })
    .from(orders)
    .where(eq(orders.id, id))
    .limit(1);

  if (existingOrder && TERMINAL_ORDER_STATUSES.includes(existingOrder.status)) {
    if (status === "paid" || status === "wallet_paid") {
      throw new Error(
        `Cannot reopen terminal order #${id} from '${existingOrder.status}' to '${status}'`
      );
    }
  }

  const now = new Date();
  const patch: Partial<NewOrder> = { status, updatedAt: now };
  if (paidAmount !== undefined) patch.paidAmount = paidAmount;
  if (status === "paid" || status === "wallet_paid") patch.paidAt = now;

  if (status === "delivered") {
    patch.deliveredAt = now;
    const updated = await db
      .update(orders)
      .set(patch)
      .where(and(eq(orders.id, id), inArray(orders.status, ["paid", "wallet_paid"])))
      .returning();
    return updated[0] ?? null;
  }

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
 * Hoàn lại coin đã giữ cho các đơn split-payment (walletPaid > 0).
 */
export async function expireStaleOrders(
  db: Database,
  now = new Date()
): Promise<{ expired: number; refunded: number }> {
  const stale = await db
    .select({ id: orders.id, walletPaid: orders.walletPaid })
    .from(orders)
    .where(and(eq(orders.status, "pending"), lt(orders.expiresAt, now)));

  let expired = 0;
  let refunded = 0;

  for (const row of stale) {
    try {
      const res = await db.transaction(async (tx) => {
        if (row.walletPaid > 0) {
          const [orderRow] = await tx
            .select()
            .from(orders)
            .where(eq(orders.id, row.id))
            .limit(1);

          if (!orderRow || orderRow.status !== "pending") return null;

          // Lock wallets -> Lock orders
          await tx
            .insert(wallets)
            .values({
              discordUserId: orderRow.discordUserId,
              balance: 0,
              updatedAt: new Date(),
            })
            .onConflictDoNothing({ target: wallets.discordUserId });

          const [lockedWallet] = await tx
            .select()
            .from(wallets)
            .where(eq(wallets.discordUserId, orderRow.discordUserId))
            .for("update");

          const [lockedOrder] = await tx
            .select()
            .from(orders)
            .where(eq(orders.id, row.id))
            .for("update");

          if (!lockedOrder || lockedOrder.status !== "pending") return null;

          const coins = lockedOrder.walletPaid;
          const newBalance = (lockedWallet?.balance ?? 0) + coins;

          await tx
            .update(wallets)
            .set({ balance: newBalance, updatedAt: new Date() })
            .where(eq(wallets.discordUserId, orderRow.discordUserId));

          await tx.insert(walletLedger).values({
            discordUserId: orderRow.discordUserId,
            delta: coins,
            balanceAfter: newBalance,
            kind: "order_cancel_credit",
            refType: "order",
            refId: lockedOrder.id,
            note: `Hết hạn đơn hàng #${lockedOrder.code}: Hoàn lại coin đã giữ`,
          });

          await tx
            .update(orders)
            .set({ status: "expired", walletPaid: 0, updatedAt: new Date() })
            .where(eq(orders.id, row.id));

          return { expired: true, refunded: true };
        } else {
          const [lockedOrder] = await tx
            .select()
            .from(orders)
            .where(eq(orders.id, row.id))
            .for("update");

          if (!lockedOrder || lockedOrder.status !== "pending") return null;

          await tx
            .update(orders)
            .set({ status: "expired", updatedAt: new Date() })
            .where(eq(orders.id, row.id));

          return { expired: true, refunded: false };
        }
      });

      if (res?.expired) expired++;
      if (res?.refunded) refunded++;
    } catch {
      // Ignored if raced
    }
  }

  return { expired, refunded };
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
 * 1. discount_codes (none here)
 * 2. wallets (SELECT FOR UPDATE)
 * 3. orders (SELECT FOR UPDATE)
 *
 * Tính toán số tiền hoàn dựa trên thực nhận:
 * refundAmount = walletPaid + (paidAmount ?? (status === 'wallet_paid' ? 0 : bankDue))
 */
export async function refundOrderWallet(
  db: Database,
  orderId: number,
  reason: string
): Promise<{ order: Order; newBalance: number; refundAmount: number }> {
  return await db.transaction(async (tx) => {
    // 1. Pre-read để lấy discordUserId cho lock ordering
    const [pre] = await tx
      .select({ discordUserId: orders.discordUserId })
      .from(orders)
      .where(eq(orders.id, orderId))
      .limit(1);

    if (!pre) {
      throw new Error(`Order #${orderId} không tồn tại`);
    }

    // 2. Canonical Lock Order step 2: Lock wallets FIRST với FOR UPDATE
    await tx
      .insert(wallets)
      .values({
        discordUserId: pre.discordUserId,
        balance: 0,
        updatedAt: new Date(),
      })
      .onConflictDoNothing({ target: wallets.discordUserId });

    const [lockedWallet] = await tx
      .select()
      .from(wallets)
      .where(eq(wallets.discordUserId, pre.discordUserId))
      .for("update");

    if (!lockedWallet) {
      throw new Error(`Ví của user ${pre.discordUserId} không tìm thấy`);
    }

    // 3. Canonical Lock Order step 3: Lock orders NEXT với FOR UPDATE
    const [lockedOrder] = await tx
      .select()
      .from(orders)
      .where(eq(orders.id, orderId))
      .for("update");

    if (!lockedOrder) {
      throw new Error(`Order #${orderId} không tồn tại`);
    }

    if (lockedOrder.status === "refunded") {
      throw new Error(`Order #${orderId} đã được hoàn tiền trước đó`);
    }

    if (
      lockedOrder.status !== "paid" &&
      lockedOrder.status !== "wallet_paid" &&
      lockedOrder.status !== "delivered"
    ) {
      throw new Error(
        `Order #${orderId} đang ở trạng thái '${lockedOrder.status}', không thể hoàn tiền`
      );
    }

    // 3.1. Check Active Delivery Job (Delivery Reservation Protocol v7)
    const activeJob = await findActiveDeliveryJobByOrderId(tx, orderId);

    if (activeJob) {
      if (activeJob.status === "processing") {
        throw new Error(
          `DELIVERY_IN_PROGRESS: Đơn hàng #${orderId} đang trong tiến trình chuyển phát, không thể hoàn tiền`
        );
      }

      if (
        activeJob.status === "queued" ||
        activeJob.status === "retryable" ||
        activeJob.status === "failed"
      ) {
        await cancelDeliveryJobsByOrder(tx, orderId);
      }
    }

    // 3.2. Thu hồi toàn bộ liên kết tải chưa dùng của đơn hàng trên Neon
    await revokeDownloadTokensByOrder(tx, orderId);

    // 4. Calculate actual refund amount
    // Phase 3C: settled_amount is canonical if available
    const bankReceived =
      lockedOrder.paidAmount ??
      (lockedOrder.status === "wallet_paid" ? 0 : lockedOrder.bankDue);
    const refundAmount =
      lockedOrder.settledAmount ??
      ((lockedOrder.walletPaid ?? 0) + (bankReceived ?? 0));

    if (refundAmount <= 0) {
      throw new Error(`Số tiền hoàn lại không hợp lệ (${refundAmount}đ)`);
    }

    // 5. Update wallet
    const newBalance = lockedWallet.balance + refundAmount;
    await tx
      .update(wallets)
      .set({
        balance: newBalance,
        updatedAt: new Date(),
      })
      .where(eq(wallets.discordUserId, pre.discordUserId));

    // 6. Insert wallet_ledger
    await tx.insert(walletLedger).values({
      discordUserId: pre.discordUserId,
      delta: refundAmount,
      balanceAfter: newBalance,
      kind: "order_refund",
      refType: "order",
      refId: lockedOrder.id,
      note: `Refund order #${lockedOrder.code}: ${reason}`,
    });

    // 7. Update order to refunded
    const [finalOrder] = await tx
      .update(orders)
      .set({
        status: "refunded",
        updatedAt: new Date(),
      })
      .where(eq(orders.id, orderId))
      .returning();

    if (!finalOrder) {
      throw new Error(`Không thể cập nhật trạng thái đơn hàng #${orderId} thành refunded`);
    }

    return {
      order: finalOrder,
      newBalance,
      refundAmount,
    };
  });
}

/**
 * Hủy đơn hàng đang chờ thanh toán (chỉ cho phép pending -> cancelled).
 * - Case A (walletPaid === 0): Đơn chuyển khoản thuần, chỉ đổi status -> cancelled. Không chạm ví.
 * - Case B (walletPaid > 0): Đơn có giữ coin trong ví, tuân thủ lock wallets -> lock orders, hoàn lại coin đã giữ với kind 'order_cancel_credit'.
 */
export async function cancelPendingOrder(
  db: Database,
  orderId: number,
  reason = "Người dùng hoặc quản trị viên hủy đơn"
): Promise<{ order: Order; refundedCoins: number }> {
  return await db.transaction(async (tx) => {
    const [pre] = await tx
      .select()
      .from(orders)
      .where(eq(orders.id, orderId))
      .limit(1);

    if (!pre) {
      throw new Error(`Order #${orderId} không tồn tại`);
    }

    if (pre.status !== "pending") {
      throw new Error(
        `Chỉ có thể hủy đơn hàng ở trạng thái 'pending' (hiện tại: '${pre.status}')`
      );
    }

    if (pre.walletPaid > 0) {
      // Case B: Có giữ coin -> Lock wallets -> Lock orders -> Check delivery reservation
      await tx
        .insert(wallets)
        .values({
          discordUserId: pre.discordUserId,
          balance: 0,
          updatedAt: new Date(),
        })
        .onConflictDoNothing({ target: wallets.discordUserId });

      const [lockedWallet] = await tx
        .select()
        .from(wallets)
        .where(eq(wallets.discordUserId, pre.discordUserId))
        .for("update");

      const [lockedOrder] = await tx
        .select()
        .from(orders)
        .where(eq(orders.id, orderId))
        .for("update");

      if (!lockedOrder || lockedOrder.status !== "pending") {
        throw new Error(`Đơn hàng #${orderId} không còn ở trạng thái pending`);
      }

      // Check Active Delivery Job (Delivery Reservation Protocol v7)
      const activeJob = await findActiveDeliveryJobByOrderId(tx, orderId);

      if (activeJob) {
        if (activeJob.status === "processing") {
          throw new Error(
            `DELIVERY_IN_PROGRESS: Đơn hàng #${orderId} đang trong tiến trình chuyển phát, không thể hủy đơn`
          );
        }

        if (
          activeJob.status === "queued" ||
          activeJob.status === "retryable" ||
          activeJob.status === "failed"
        ) {
          await cancelDeliveryJobsByOrder(tx, orderId);
        }
      }

      await revokeDownloadTokensByOrder(tx, orderId);

      const refundCoins = lockedOrder.walletPaid;
      const newBalance = (lockedWallet?.balance ?? 0) + refundCoins;

      await tx
        .update(wallets)
        .set({
          balance: newBalance,
          updatedAt: new Date(),
        })
        .where(eq(wallets.discordUserId, pre.discordUserId));

      await tx.insert(walletLedger).values({
        discordUserId: pre.discordUserId,
        delta: refundCoins,
        balanceAfter: newBalance,
        kind: "order_cancel_credit",
        refType: "order",
        refId: lockedOrder.id,
        note: `Hủy đơn hàng #${lockedOrder.code}: Hoàn lại coin đã giữ (${refundCoins} coin)`,
      });

      const [cancelled] = await tx
        .update(orders)
        .set({
          status: "cancelled",
          walletPaid: 0,
          updatedAt: new Date(),
        })
        .where(eq(orders.id, orderId))
        .returning();

      return { order: cancelled!, refundedCoins: refundCoins };
    } else {
      // Case A: walletPaid === 0 -> Lock orders -> Check delivery reservation -> Cancelled
      const [lockedOrder] = await tx
        .select()
        .from(orders)
        .where(eq(orders.id, orderId))
        .for("update");

      if (!lockedOrder || lockedOrder.status !== "pending") {
        throw new Error(`Đơn hàng #${orderId} không còn ở trạng thái pending`);
      }

      // Check Active Delivery Job (Delivery Reservation Protocol v7)
      const activeJob = await findActiveDeliveryJobByOrderId(tx, orderId);

      if (activeJob) {
        if (activeJob.status === "processing") {
          throw new Error(
            `DELIVERY_IN_PROGRESS: Đơn hàng #${orderId} đang trong tiến trình chuyển phát, không thể hủy đơn`
          );
        }

        if (
          activeJob.status === "queued" ||
          activeJob.status === "retryable" ||
          activeJob.status === "failed"
        ) {
          await cancelDeliveryJobsByOrder(tx, orderId);
        }
      }

      await revokeDownloadTokensByOrder(tx, orderId);

      const [cancelled] = await tx
        .update(orders)
        .set({
          status: "cancelled",
          updatedAt: new Date(),
        })
        .where(eq(orders.id, orderId))
        .returning();

      return { order: cancelled!, refundedCoins: 0 };
    }
  });
}

/**
 * Đưa lại đơn hàng vào hàng đợi giao hàng (Re-enqueue / Release).
 */
export async function requeueDeliveryJob(
  db: Database,
  orderId: number
): Promise<{ ok: boolean; message: string }> {
  const [order] = await db.select().from(orders).where(eq(orders.id, orderId)).limit(1);
  if (!order) throw new Error(`Order #${orderId} không tồn tại`);
  if (order.status !== "paid" && order.status !== "wallet_paid") {
    throw new Error(`Chỉ có thể giao lại đơn hàng đã thanh toán (hiện tại: '${order.status}')`);
  }

  // Cập nhật job cũ nếu có, hoặc tạo mới
  const existingJob = await db
    .select()
    .from(deliveryJobs)
    .where(eq(deliveryJobs.orderId, orderId))
    .limit(1);

  if (existingJob[0]) {
    await db
      .update(deliveryJobs)
      .set({
        status: "queued",
        claimToken: null,
        lockedAt: null,
        retryCount: 0,
        lastError: null,
        updatedAt: new Date(),
      })
      .where(eq(deliveryJobs.id, existingJob[0].id));
  } else if (order.versionId) {
    await db.insert(deliveryJobs).values({
      orderId: order.id,
      discordUserId: order.discordUserId,
      versionId: order.versionId,
      requestedMethod: "attachment",
      status: "queued",
    });
  }

  return { ok: true, message: `Đã đưa đơn hàng #${order.code} vào hàng đợi giao hàng` };
}
