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
import { isTerminalSepayStatus } from "../../repositories/neon-sepay.js";
import { assertNotFrozen } from "../maintenance/write-freeze.js";
import type { WebhookOutcome, OrderConfig } from "./match-and-fulfil-order.js";
import { findVersionById } from "../../repositories/neon-versions.js";
import { findPluginById } from "../../repositories/neon-plugins.js";
import { generatePaymentCode, buildVietQrUrl } from "./build-vietqr-url.js";
import { isCodeAvailableNeon } from "./open-wallet-topup.js";

type Tx = Parameters<Parameters<Database["transaction"]>[0]>[0];
export type { WebhookOutcome };

/**
 * Xử lý giao dịch SePay Webhook trực tiếp trên Neon PostgreSQL authority.
 * Tuân thủ nghiêm ngặt:
 * 1. Single Transaction Boundary: Toàn bộ quá trình ingestion, row lock, wallet mutation, order mutation và job enqueue nằm trong đúng một transaction.
 * 2. First-Insert Race Guard: INSERT ... ON CONFLICT DO NOTHING + SELECT ... FOR UPDATE.
 * 3. Canonical Lock Order: sepay_transactions -> wallets -> orders -> wallet_topups -> delivery_jobs.
 * 4. State-Lock Before Financial Mutation: Khóa ví và đối tượng nghiệp vụ, reload fresh state trước khi phân nhánh hoặc ghi ledger.
 * 5. Dynamic Real-Amount Credit Policy cho Wallet Topup.
 */
export async function applySepayTransferNeon(
  db: Database,
  payload: SepayWebhookPayload
): Promise<WebhookOutcome> {
  assertNotFrozen("Xử lý thanh toán SePay");

  return await db.transaction(async (tx) => {
    // 1. First-Insert Race Guard & Row Lock Ownership
    const inserted = await tx
      .insert(sepayTransactions)
      .values({
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
      })
      .onConflictDoNothing({ target: sepayTransactions.sepayId })
      .returning();

    let sepayRow: SepayTransaction;

    if (inserted.length > 0 && inserted[0]) {
      // Winner: Transaction hiện tại sở hữu bản ghi vừa tạo
      sepayRow = inserted[0];
    } else {
      // Loser hoặc Retry: Bị xung đột unique constraint -> Lock hàng đang có để kiểm tra trạng thái
      const [existing] = await tx
        .select()
        .from(sepayTransactions)
        .where(eq(sepayTransactions.sepayId, payload.id))
        .for("update");

      if (!existing) {
        throw new Error(`CRITICAL: Không tìm thấy sepay_id #${payload.id} sau khi conflict`);
      }

      if (isTerminalSepayStatus(existing.status)) {
        return { handled: "duplicate" };
      }

      // Non-terminal ('unmatched', 'received') -> Tiếp tục Resume đối soát trong cùng transaction
      sepayRow = existing;
    }

    // 2. Lifecycle Phân loại Terminal cho giao dịch chuyển đi (outgoing)
    if (payload.transferType !== "in") {
      await tx
        .update(sepayTransactions)
        .set({
          status: "ignored_outgoing",
          description: "Giao dịch chuyển tiền đi (outgoing), bỏ qua",
        })
        .where(eq(sepayTransactions.id, sepayRow.id));
      return { handled: "ignored", why: "outgoing" };
    }

    // 3. Lifecycle Phân loại Terminal cho giao dịch không có mã chuyển khoản (no-code)
    if (!payload.code || payload.code.trim() === "") {
      await tx
        .update(sepayTransactions)
        .set({
          status: "ignored_no_code",
          description: "Không nhận dạng được mã thanh toán (no-code)",
        })
        .where(eq(sepayTransactions.id, sepayRow.id));
      return { handled: "ignored", why: "no-code" };
    }

    const cleanCode = payload.code.trim().toUpperCase();

    // 4. Pre-read để xác định đối tượng liên kết (Precedence: Orders -> Topups)
    const orderPre = await findOrderByCode(tx, cleanCode);
    if (orderPre) {
      return await handleOrderPaymentNeonTx(tx, payload, sepayRow, orderPre);
    }

    const topupPre = await findTopupByCode(tx, cleanCode);
    if (topupPre) {
      return await handleTopupPaymentNeonTx(tx, payload, sepayRow, topupPre);
    }

    // 5. Non-terminal: Không tìm thấy Order hay Topup tương ứng -> lưu unmatched chờ đối soát
    await tx
      .update(sepayTransactions)
      .set({
        status: "unmatched",
        description: `Không tìm thấy đơn hàng hoặc yêu cầu nạp ví cho mã: ${cleanCode}`,
      })
      .where(eq(sepayTransactions.id, sepayRow.id));

    return { handled: "ignored", why: "no-order" };
  });
}

/**
 * Xử lý thanh toán Order trong SAME transaction với SePay lock.
 * Tuân thủ Invariant B: State-Lock Before Financial Mutation.
 */
async function handleOrderPaymentNeonTx(
  tx: Tx,
  payload: SepayWebhookPayload,
  sepayRow: SepayTransaction,
  orderPre: Order
): Promise<WebhookOutcome> {
  const transferAmount = payload.transferAmount;

  // Step 2: Lock wallets FIRST với FOR UPDATE
  await tx
    .insert(wallets)
    .values({
      discordUserId: orderPre.discordUserId,
      balance: 0,
      updatedAt: new Date(),
    })
    .onConflictDoNothing({ target: wallets.discordUserId });

  const [lockedWallet] = await tx
    .select()
    .from(wallets)
    .where(eq(wallets.discordUserId, orderPre.discordUserId))
    .for("update");

  if (!lockedWallet) {
    throw new Error(`Ví của user ${orderPre.discordUserId} không tìm thấy`);
  }

  // Step 3: Lock orders NEXT với FOR UPDATE & RELOAD FRESH STATE
  const [freshOrder] = await tx
    .select()
    .from(orders)
    .where(eq(orders.id, orderPre.id))
    .for("update");

  if (!freshOrder) {
    throw new Error(`Order #${orderPre.id} không tìm thấy khi lock`);
  }

  // Step 4: Business State Decision & Financial Mutation
  // Trường hợp A: Đơn hàng không còn ở trạng thái pending (paid, wallet_paid, delivered, expired, cancelled, refunded)
  if (freshOrder.status !== "pending") {
    // Không reopen order. Nạp toàn bộ 100% số tiền thực nhận vào ví người dùng
    const newBalance = lockedWallet.balance + transferAmount;
    await tx
      .update(wallets)
      .set({
        balance: newBalance,
        updatedAt: new Date(),
      })
      .where(eq(wallets.discordUserId, freshOrder.discordUserId));

    await tx.insert(walletLedger).values({
      discordUserId: freshOrder.discordUserId,
      delta: transferAmount,
      balanceAfter: newBalance,
      kind: "order_overpay_credit",
      refType: "sepay_transactions",
      refId: sepayRow.id,
      note: `Chuyển khoản cho đơn hàng #${freshOrder.code} ở trạng thái '${freshOrder.status}' - đã nạp 100% vào ví`,
    });

    await tx
      .update(sepayTransactions)
      .set({
        status: "overpaid",
        orderId: freshOrder.id,
        topupId: null,
        processedAt: new Date(),
        description: `Chuyển khoản cho đơn '${freshOrder.status}' - đã nạp vào ví`,
      })
      .where(eq(sepayTransactions.id, sepayRow.id));

    return { handled: "ignored", why: "not-pending" };
  }

  // Trường hợp B: Đơn hàng đang pending
  const bankDue =
    freshOrder.bankDue ?? (freshOrder.amount - (freshOrder.walletPaid ?? 0));

  if (transferAmount < bankDue) {
    // B1: Thiếu tiền (Underpayment)
    // Nạp phần tiền thiếu vào ví khách, đơn giữ nguyên pending
    const newBalance = lockedWallet.balance + transferAmount;
    await tx
      .update(wallets)
      .set({
        balance: newBalance,
        updatedAt: new Date(),
      })
      .where(eq(wallets.discordUserId, freshOrder.discordUserId));

    await tx.insert(walletLedger).values({
      discordUserId: freshOrder.discordUserId,
      delta: transferAmount,
      balanceAfter: newBalance,
      kind: "order_partial_credit",
      refType: "sepay_transactions",
      refId: sepayRow.id,
      note: `Chuyển khoản thiếu cho đơn hàng #${freshOrder.code} (cần: ${bankDue}đ, nhận: ${transferAmount}đ)`,
    });

    await tx
      .update(sepayTransactions)
      .set({
        status: "underpaid",
        orderId: freshOrder.id,
        topupId: null,
        processedAt: new Date(),
        description: `Thanh toán thiếu: nhận ${transferAmount}đ / ${bankDue}đ`,
      })
      .where(eq(sepayTransactions.id, sepayRow.id));

    return { handled: "ignored", why: "underpaid" };
  }

  if (transferAmount === bankDue) {
    // B2: Khớp đúng số tiền (Exact Payment)
    // Không biến động ví vì không thừa/thiếu
    await tx
      .update(orders)
      .set({
        status: "paid",
        paidAmount: transferAmount,
        paidAt: new Date(),
      })
      .where(eq(orders.id, freshOrder.id));

    // Step 5: Enqueue delivery_job
    if (freshOrder.versionId) {
      await tx
        .insert(deliveryJobs)
        .values({
          orderId: freshOrder.id,
          discordUserId: freshOrder.discordUserId,
          versionId: freshOrder.versionId,
          requestedMethod: "dm",
          status: "queued",
        })
        .onConflictDoNothing();
    }

    await tx
      .update(sepayTransactions)
      .set({
        status: "credited",
        orderId: freshOrder.id,
        topupId: null,
        processedAt: new Date(),
        description: `Thanh toán thành công đơn hàng #${freshOrder.code}`,
      })
      .where(eq(sepayTransactions.id, sepayRow.id));

    return { handled: "paid", orderId: freshOrder.id };
  }

  // B3: Chuyển thừa tiền (Overpayment)
  const surplus = transferAmount - bankDue;
  const newBalance = lockedWallet.balance + surplus;

  await tx
    .update(wallets)
    .set({
      balance: newBalance,
      updatedAt: new Date(),
    })
    .where(eq(wallets.discordUserId, freshOrder.discordUserId));

  await tx.insert(walletLedger).values({
    discordUserId: freshOrder.discordUserId,
    delta: surplus,
    balanceAfter: newBalance,
    kind: "order_overpay_credit",
    refType: "sepay_transactions",
    refId: sepayRow.id,
    note: `Chuyển khoản thừa đơn hàng #${freshOrder.code} (dư ${surplus}đ)`,
  });

  await tx
    .update(orders)
    .set({
      status: "paid",
      paidAmount: bankDue,
      paidAt: new Date(),
    })
    .where(eq(orders.id, freshOrder.id));

  // Step 5: Enqueue delivery_job
  if (freshOrder.versionId) {
    await tx
      .insert(deliveryJobs)
      .values({
        orderId: freshOrder.id,
        discordUserId: freshOrder.discordUserId,
        versionId: freshOrder.versionId,
        requestedMethod: "dm",
        status: "queued",
      })
      .onConflictDoNothing();
  }

  await tx
    .update(sepayTransactions)
    .set({
      status: "overpaid",
      orderId: freshOrder.id,
      topupId: null,
      processedAt: new Date(),
      description: `Thanh toán đơn hàng #${freshOrder.code} thành công kèm nạp thừa ${surplus}đ vào ví`,
    })
    .where(eq(sepayTransactions.id, sepayRow.id));

  return { handled: "paid", orderId: freshOrder.id };
}

/**
 * Xử lý nạp tiền ví qua SePay trong SAME transaction với SePay lock.
 * Tuân thủ Invariant B: State-Lock Before Financial Mutation.
 */
async function handleTopupPaymentNeonTx(
  tx: Tx,
  payload: SepayWebhookPayload,
  sepayRow: SepayTransaction,
  topupPre: WalletTopup
): Promise<WebhookOutcome> {
  const receivedAmount = payload.transferAmount;

  // Step 2: Lock wallets FIRST
  await tx
    .insert(wallets)
    .values({
      discordUserId: topupPre.discordUserId,
      balance: 0,
      updatedAt: new Date(),
    })
    .onConflictDoNothing({ target: wallets.discordUserId });

  const [lockedWallet] = await tx
    .select()
    .from(wallets)
    .where(eq(wallets.discordUserId, topupPre.discordUserId))
    .for("update");

  if (!lockedWallet) {
    throw new Error(`Ví của user ${topupPre.discordUserId} không tìm thấy`);
  }

  // Step 4: Lock wallet_topups NEXT & RELOAD FRESH STATE
  const [freshTopup] = await tx
    .select()
    .from(walletTopups)
    .where(eq(walletTopups.id, topupPre.id))
    .for("update");

  if (!freshTopup) {
    throw new Error(`Topup #${topupPre.id} không tìm thấy khi lock`);
  }

  // Kiểm tra trạng thái hiện tại sau khi đã chiếm được Lock
  if (freshTopup.status === "credited") {
    // Phiếu nạp đã được giải ngân bởi giao dịch khác -> TUYỆT ĐỐI KHÔNG CỘNG TIỀN LẦN 2
    await tx
      .update(sepayTransactions)
      .set({
        status: "duplicate_transfer",
        topupId: freshTopup.id,
        orderId: null,
        description: "Yêu cầu nạp ví này đã được hoàn tất trước đó",
      })
      .where(eq(sepayTransactions.id, sepayRow.id));
    return { handled: "duplicate" };
  }

  // Trạng thái 'pending' hoặc 'expired': Nạp đúng số tiền thực nhận (Dynamic Real-Amount Credit Policy)
  const newBalance = lockedWallet.balance + receivedAmount;

  await tx
    .update(wallets)
    .set({
      balance: newBalance,
      updatedAt: new Date(),
    })
    .where(eq(wallets.discordUserId, freshTopup.discordUserId));

  await tx.insert(walletLedger).values({
    discordUserId: freshTopup.discordUserId,
    delta: receivedAmount,
    balanceAfter: newBalance,
    kind: "topup_credit",
    refType: "wallet_topups",
    refId: freshTopup.id,
    note: `Nạp tiền ví qua SePay #${payload.id} (Yêu cầu: ${freshTopup.amount}đ, Thực nhận: ${receivedAmount}đ)`,
  });

  await tx
    .update(walletTopups)
    .set({
      status: "credited",
      paidAmount: receivedAmount,
      creditedAt: new Date(),
    })
    .where(eq(walletTopups.id, freshTopup.id));

  await tx
    .update(sepayTransactions)
    .set({
      status: "credited",
      orderId: null,
      topupId: freshTopup.id,
      processedAt: new Date(),
      description: `Nạp ví thành công số tiền ${receivedAmount}đ`,
    })
    .where(eq(sepayTransactions.id, sepayRow.id));

  return {
    handled: "topup",
    topupId: freshTopup.id,
    discordUserId: freshTopup.discordUserId,
    credited: receivedAmount,
  };
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
