import { eq, sql } from "drizzle-orm";
import type { Database } from "../../db/neon.js";
import type { SepayWebhookPayload, CreatedOrder } from "../../domain/order.js";
import {
  orders,
  wallets,
  walletLedger,
  walletTopups,
  sepayTransactions,
  deliveryJobs,
  type Order,
  type WalletTopup,
  type SepayTransaction,
} from "@vault/db";
import { applyLedgerEntryTx } from "../../repositories/neon-wallets.js";
import { findOrderByCode } from "../../repositories/neon-orders.js";
import { findTopupByCode } from "../../repositories/neon-wallet-topups.js";
import { recordSepayTransaction, hasSepayTransaction } from "../../repositories/neon-sepay.js";
import { assertNotFrozen } from "../maintenance/write-freeze.js";
import { generatePaymentCode, buildVietQrUrl } from "./build-vietqr-url.js";
import { isCodeAvailableNeon } from "./open-wallet-topup.js";
import { findVersionById } from "../../repositories/neon-versions.js";
import { findPluginById } from "../../repositories/neon-plugins.js";
import type { OrderConfig } from "./match-and-fulfil-order.js";

export type WebhookOutcome =
  | { handled: "duplicate" }
  | { handled: "ignored"; why: "outgoing" | "no-code" | "no-order" | "underpaid" | "not-pending" }
  | { handled: "paid"; orderId: number }
  | { handled: "topup"; topupId: number; discordUserId: string; credited: number };

/**
 * Xử lý giao dịch SePay Webhook trực tiếp trên Neon PostgreSQL authority.
 * Tuân thủ nghiêm ngặt:
 * 1. Canonical Lock Order (wallets -> orders -> wallet_topups -> delivery_jobs)
 * 2. Invariant chk_sepay_target_exclusivity
 * 3. Dynamic Real-Amount Credit Policy cho Wallet Topup
 * 4. Append-only ledger với mọi biến động số dư ví
 */
export async function applySepayTransferNeon(
  db: Database,
  payload: SepayWebhookPayload
): Promise<WebhookOutcome> {
  assertNotFrozen("Xử lý thanh toán SePay");

  // 1. Idempotency Guard (Deduplication trước tiên)
  const alreadyProcessed = await hasSepayTransaction(db, payload.id);
  if (alreadyProcessed) {
    return { handled: "duplicate" };
  }

  // 2. Ghi nhận sepay_transactions ban đầu (status: unmatched, orderId: null, topupId: null)
  let sepayRow: SepayTransaction;
  try {
    sepayRow = await recordSepayTransaction(db, {
      sepayId: payload.id,
      amount: payload.transferAmount,
      transferType: payload.transferType,
      code: payload.code,
      content: payload.content || "",
      description: payload.description || "",
      status: "unmatched",
      orderId: null,
      topupId: null,
      rawPayload: payload as unknown as Record<string, unknown>,
      receivedAt: new Date(),
    });
  } catch (err) {
    // Nếu bị trùng unique sepay_id do concurrent request
    return { handled: "duplicate" };
  }

  // 3. Kiểm tra loại giao dịch (Chỉ nhận tiền vào - 'in')
  if (payload.transferType !== "in") {
    await db
      .update(sepayTransactions)
      .set({ description: "Giao dịch chuyển tiền đi (outgoing), bỏ qua" })
      .where(eq(sepayTransactions.id, sepayRow.id));
    return { handled: "ignored", why: "outgoing" };
  }

  // 4. Kiểm tra mã chuyển khoản (code)
  if (!payload.code || payload.code.trim() === "") {
    await db
      .update(sepayTransactions)
      .set({ description: "Không nhận dạng được mã thanh toán (no-code)" })
      .where(eq(sepayTransactions.id, sepayRow.id));
    return { handled: "ignored", why: "no-code" };
  }

  const cleanCode = payload.code.trim().toUpperCase();

  // 5. Tìm kiếm đơn hàng trước (Precedence: Orders -> Topups)
  const order = await findOrderByCode(db, cleanCode);

  if (order) {
    return await handleOrderPaymentNeon(db, payload, sepayRow, order);
  }

  // 6. Nếu không khớp Order, tìm Topup
  const topup = await findTopupByCode(db, cleanCode);
  if (topup) {
    return await handleTopupPaymentNeon(db, payload, sepayRow, topup);
  }

  // 7. Không tìm thấy cả Order lẫn Topup
  await db
    .update(sepayTransactions)
    .set({
      description: `Không tìm thấy đơn hàng hoặc yêu cầu nạp ví cho mã: ${cleanCode}`,
    })
    .where(eq(sepayTransactions.id, sepayRow.id));

  return { handled: "ignored", why: "no-order" };
}

/**
 * Xử lý thanh toán cho Order trên Neon PostgreSQL.
 */
async function handleOrderPaymentNeon(
  db: Database,
  payload: SepayWebhookPayload,
  sepayRow: SepayTransaction,
  order: Order
): Promise<WebhookOutcome> {
  const transferAmount = payload.transferAmount;

  return await db.transaction(async (tx) => {
    // Trường hợp A: Đơn hàng không còn ở trạng thái pending
    if (order.status !== "pending") {
      if (order.status === "paid" || order.status === "wallet_paid" || order.status === "delivered") {
        // Đơn đã thanh toán từ trước -> hoàn toàn bộ số tiền vừa nhận vào ví
        // Canonical Lock: Lock wallets (2) -> Lock orders (3)
        await applyLedgerEntryTx(tx, {
          discordUserId: order.discordUserId,
          delta: transferAmount,
          kind: "order_overpay_credit",
          refType: "sepay_transactions",
          refId: sepayRow.id,
          note: `Chuyển khoản cho đơn hàng #${order.code} đã thanh toán`,
        });

        await tx.select().from(orders).where(eq(orders.id, order.id)).for("update");

        await tx
          .update(sepayTransactions)
          .set({
            status: "overpaid",
            orderId: order.id,
            topupId: null,
            processedAt: new Date(),
            description: "Chuyển khoản cho đơn đã thanh toán - đã nạp toàn bộ vào ví",
          })
          .where(eq(sepayTransactions.id, sepayRow.id));
      } else if (order.status === "expired") {
        // Đơn đã hết hạn -> nạp toàn bộ số tiền vào ví
        await applyLedgerEntryTx(tx, {
          discordUserId: order.discordUserId,
          delta: transferAmount,
          kind: "order_overpay_credit",
          refType: "sepay_transactions",
          refId: sepayRow.id,
          note: `Chuyển khoản cho đơn hàng #${order.code} đã hết hạn`,
        });

        await tx.select().from(orders).where(eq(orders.id, order.id)).for("update");

        await tx
          .update(sepayTransactions)
          .set({
            status: "overpaid",
            orderId: order.id,
            topupId: null,
            processedAt: new Date(),
            description: "Chuyển khoản cho đơn đã hết hạn - đã nạp vào ví",
          })
          .where(eq(sepayTransactions.id, sepayRow.id));
      }

      return { handled: "ignored", why: "not-pending" };
    }

    // Trường hợp B: Đơn hàng đang pending
    const bankDue = order.amount; // hoặc phần tiền cần thanh toán

    if (transferAmount < bankDue) {
      // B1: Thiếu tiền (Underpayment)
      // Step 2: Lock wallets -> nạp phần tiền thiếu vào ví
      await applyLedgerEntryTx(tx, {
        discordUserId: order.discordUserId,
        delta: transferAmount,
        kind: "order_partial_credit",
        refType: "sepay_transactions",
        refId: sepayRow.id,
        note: `Chuyển khoản thiếu cho đơn hàng #${order.code} (cần: ${bankDue}đ, nhận: ${transferAmount}đ)`,
      });

      // Step 3: Lock orders -> order giữ nguyên status pending
      await tx.select().from(orders).where(eq(orders.id, order.id)).for("update");

      // Cập nhật sepay_transactions
      await tx
        .update(sepayTransactions)
        .set({
          status: "underpaid",
          orderId: order.id,
          topupId: null,
          processedAt: new Date(),
          description: `Thanh toán thiếu: nhận ${transferAmount}đ / ${bankDue}đ`,
        })
        .where(eq(sepayTransactions.id, sepayRow.id));

      return { handled: "ignored", why: "underpaid" };
    }

    if (transferAmount === bankDue) {
      // B2: Khớp đúng số tiền (Exact Payment)
      // Không cần lock ví vì không có biến động ví
      // Step 3: Lock orders -> đánh dấu paid
      const lockedOrders = await tx
        .select()
        .from(orders)
        .where(eq(orders.id, order.id))
        .for("update");

      const lockedOrder = lockedOrders[0];
      if (!lockedOrder || lockedOrder.status !== "pending") {
        return { handled: "ignored", why: "not-pending" };
      }

      await tx
        .update(orders)
        .set({
          status: "paid",
          paidAmount: transferAmount,
          paidAt: new Date(),
        })
        .where(eq(orders.id, order.id));

      // Step 5: Enqueue delivery_job
      if (order.versionId) {
        await tx
          .insert(deliveryJobs)
          .values({
            orderId: order.id,
            discordUserId: order.discordUserId,
            versionId: order.versionId,
            requestedMethod: "dm",
            status: "queued",
          })
          .onConflictDoNothing();
      }

      // Cập nhật sepay_transactions
      await tx
        .update(sepayTransactions)
        .set({
          status: "credited",
          orderId: order.id,
          topupId: null,
          processedAt: new Date(),
          description: `Thanh toán thành công đơn hàng #${order.code}`,
        })
        .where(eq(sepayTransactions.id, sepayRow.id));

      return { handled: "paid", orderId: order.id };
    }

    // B3: Chuyển thừa tiền (Overpayment)
    const surplus = transferAmount - bankDue;

    // Step 2: Lock wallets -> nạp phần dư vào ví
    await applyLedgerEntryTx(tx, {
      discordUserId: order.discordUserId,
      delta: surplus,
      kind: "order_overpay_credit",
      refType: "sepay_transactions",
      refId: sepayRow.id,
      note: `Chuyển khoản thừa đơn hàng #${order.code} (dư ${surplus}đ)`,
    });

    // Step 3: Lock orders -> cập nhật status paid
    const lockedOrders = await tx
      .select()
      .from(orders)
      .where(eq(orders.id, order.id))
      .for("update");

    const lockedOrder = lockedOrders[0];
    if (!lockedOrder || lockedOrder.status !== "pending") {
      return { handled: "ignored", why: "not-pending" };
    }

    await tx
      .update(orders)
      .set({
        status: "paid",
        paidAmount: bankDue,
        paidAt: new Date(),
      })
      .where(eq(orders.id, order.id));

    // Step 5: Enqueue delivery_job
    if (order.versionId) {
      await tx
        .insert(deliveryJobs)
        .values({
          orderId: order.id,
          discordUserId: order.discordUserId,
          versionId: order.versionId,
          requestedMethod: "dm",
          status: "queued",
        })
        .onConflictDoNothing();
    }

    // Cập nhật sepay_transactions
    await tx
      .update(sepayTransactions)
      .set({
        status: "overpaid",
        orderId: order.id,
        topupId: null,
        processedAt: new Date(),
        description: `Thanh toán đơn hàng #${order.code} thành công kèm nạp thừa ${surplus}đ vào ví`,
      })
      .where(eq(sepayTransactions.id, sepayRow.id));

    return { handled: "paid", orderId: order.id };
  });
}

/**
 * Xử lý nạp tiền ví qua SePay trên Neon PostgreSQL (Dynamic Real-Amount Credit Policy).
 * Áp dụng giống nhau cho cả topup đang 'pending' và 'expired'.
 */
async function handleTopupPaymentNeon(
  db: Database,
  payload: SepayWebhookPayload,
  sepayRow: SepayTransaction,
  topup: WalletTopup
): Promise<WebhookOutcome> {
  const receivedAmount = payload.transferAmount;

  if (topup.status === "credited") {
    // Đã được xử lý trước đó
    await db
      .update(sepayTransactions)
      .set({
        status: "duplicate_transfer",
        topupId: topup.id,
        orderId: null,
        description: "Yêu cầu nạp ví này đã được hoàn tất trước đó",
      })
      .where(eq(sepayTransactions.id, sepayRow.id));
    return { handled: "ignored", why: "not-pending" };
  }

  return await db.transaction(async (tx) => {
    // Step 2: Lock wallets FIRST -> cộng đúng số tiền thực nhận
    await applyLedgerEntryTx(tx, {
      discordUserId: topup.discordUserId,
      delta: receivedAmount,
      kind: "topup_credit",
      refType: "wallet_topups",
      refId: topup.id,
      note: `Nạp tiền ví qua SePay #${payload.id} (Yêu cầu: ${topup.amount}đ, Thực nhận: ${receivedAmount}đ)`,
    });

    // Step 4: Lock wallet_topups NEXT -> chuyển status thành credited
    const lockedTopups = await tx
      .select()
      .from(walletTopups)
      .where(eq(walletTopups.id, topup.id))
      .for("update");

    const lockedTopup = lockedTopups[0];
    if (!lockedTopup || lockedTopup.status === "credited") {
      throw new Error(`Topup #${topup.id} đã được xử lý bởi giao dịch khác`);
    }

    await tx
      .update(walletTopups)
      .set({
        status: "credited",
        paidAmount: receivedAmount,
        creditedAt: new Date(),
      })
      .where(eq(walletTopups.id, topup.id));

    // Cập nhật sepay_transactions (orderId: null, topupId: topup.id)
    await tx
      .update(sepayTransactions)
      .set({
        status: "credited",
        orderId: null,
        topupId: topup.id,
        processedAt: new Date(),
        description: `Nạp ví thành công số tiền ${receivedAmount}đ`,
      })
      .where(eq(sepayTransactions.id, sepayRow.id));

    return {
      handled: "topup",
      topupId: topup.id,
      discordUserId: topup.discordUserId,
      credited: receivedAmount,
    };
  });
}

/**
 * Mở đơn hàng mới trực tiếp trên Neon PostgreSQL Authority.
 * Tuân thủ nghiêm ngặt:
 * 1. Canonical Lock Order: wallets (SELECT FOR UPDATE) -> orders (INSERT) -> delivery_jobs (INSERT nếu bankDue === 0).
 * 2. Khấu trừ coin trước (order_hold) nếu người dùng có số dư.
 * 3. Hỗ trợ đơn thanh toán 100% bằng ví (status = 'wallet_paid') hoặc thanh toán kết hợp / chuyển khoản.
 */
export async function openOrderNeon(
  db: Database,
  config: OrderConfig,
  input: { discordUserId: string; versionId: number }
): Promise<CreatedOrder | null> {
  assertNotFrozen("Mở đơn hàng mới");
  const version = await findVersionById(db, input.versionId);
  if (!version) return null;
  const plugin = await findPluginById(db, version.pluginId);
  const pluginName = plugin?.displayName ?? String(version.pluginId);
  const price = plugin?.depositPrice ?? 0;

  for (let attempt = 0; attempt < 5; attempt++) {
    const code = generatePaymentCode(config.codePrefix, config.codeSuffixLength);
    if (!(await isCodeAvailableNeon(db, code))) continue;

    try {
      const opened = await db.transaction(async (tx) => {
        // Step 2: Lock wallets FIRST với FOR UPDATE
        await tx
          .insert(wallets)
          .values({
            discordUserId: input.discordUserId,
            balance: 0,
            updatedAt: new Date(),
          })
          .onConflictDoNothing({ target: wallets.discordUserId });

        const [lockedWallet] = await tx
          .select()
          .from(wallets)
          .where(eq(wallets.discordUserId, input.discordUserId))
          .for("update");

        const currentBalance = lockedWallet?.balance ?? 0;
        const walletPaid = Math.min(currentBalance, price);
        const bankDue = price - walletPaid;
        const now = new Date();
        const expiresAt = new Date(now.getTime() + config.ttlMinutes * 60_000);
        const status = bankDue === 0 ? "wallet_paid" : "pending";

        // Step 3: Insert orders
        const [created] = await tx
          .insert(orders)
          .values({
            code,
            discordUserId: input.discordUserId,
            versionId: version.id,
            pluginName,
            versionLabel: version.version ?? "",
            amount: price,
            walletPaid,
            bankDue,
            status,
            createdAt: now,
            expiresAt,
            paidAt: bankDue === 0 ? now : null,
          })
          .returning();

        if (!created) {
          throw new Error("Không thể tạo đơn hàng");
        }

        // Khấu trừ số dư ví nếu có coin thanh toán
        if (walletPaid > 0) {
          const newBalance = currentBalance - walletPaid;
          await tx
            .update(wallets)
            .set({
              balance: newBalance,
              updatedAt: now,
            })
            .where(eq(wallets.discordUserId, input.discordUserId));

          await tx.insert(walletLedger).values({
            discordUserId: input.discordUserId,
            delta: -walletPaid,
            balanceAfter: newBalance,
            kind: "order_hold",
            refType: "order",
            refId: created.id,
            note: `Giữ coin cho đơn hàng #${code}`,
          });
        }

        // Step 5: Nếu thanh toán đủ bằng ví -> Tạo delivery_job
        if (bankDue === 0) {
          await tx.insert(deliveryJobs).values({
            orderId: created.id,
            discordUserId: input.discordUserId,
            versionId: version.id,
            requestedMethod: "attachment",
            status: "queued",
          });
        }

        return created;
      });

      return {
        id: opened.id,
        code: opened.code,
        amount: opened.amount,
        walletPaid: opened.walletPaid,
        bankDue: opened.bankDue,
        qrUrl:
          opened.bankDue > 0
            ? buildVietQrUrl({
                accountNumber: config.accountNumber,
                bankCode: config.bankCode,
                amount: opened.bankDue,
                code: opened.code,
              })
            : null,
        expiresAt: Math.floor(opened.expiresAt.getTime() / 1000),
      };
    } catch {
      // Retry nếu có xung đột mã hoặc giao dịch
      continue;
    }
  }

  return null;
}
