/**
 * backfill-settled-amount.ts
 * Phase 3C: Safe Historical Backfill & Delivery Log Reconciliation
 *
 * Rules:
 * - Backfill orders.settled_amount only when reliable settlement evidence exists.
 * - Settle amount is set to order.amount for financially settled orders.
 * - paid_at evidence hierarchy:
 *     Bank payment: sepay_transactions.received_at
 *     Split payment: sepay_transactions.received_at of completing transfer
 *     Wallet-only: wallet_ledger.created_at for order_hold
 *     Zero-price: order settlement timestamp
 *     No evidence: paid_at remains NULL -> record in _migration_exceptions
 * - Never fabricate order.created_at as paid_at (except zero-price).
 * - Never use webhook arrival time or unsupported processed_at.
 * - Delivery log reconciliation:
 *     Safe deterministic fix: dl.amount === 0 and o.settled_amount > 0 -> dl.amount = o.settled_amount
 *     Ambiguous cases: record in _migration_exceptions, no silent overwrite.
 * - Idempotent, resumable, and safe on rerun.
 */

import { eq, and, sql, isNull, inArray } from "drizzle-orm";
import type { Database } from "../db/neon.js";
import {
  orders,
  sepayTransactions,
  walletLedger,
  deliveryLogs,
} from "@vault/db";
import { recordMigrationException } from "../repositories/neon-settlement.js";

export interface BackfillOptions {
  runId?: string;
  dryRun?: boolean;
}

export interface BackfillSummary {
  runId: string;
  settledAmountPopulated: number;
  paidAtPopulated: number;
  exceptionsRecorded: number;
  deliveryLogsRepaired: number;
  deliveryLogExceptions: number;
}

export async function backfillSettledAmount(
  db: Database,
  options: BackfillOptions = {}
): Promise<BackfillSummary> {
  const runId = options.runId ?? `migration-backfill-${Date.now()}`;
  const dryRun = options.dryRun ?? false;

  let settledAmountPopulated = 0;
  let paidAtPopulated = 0;
  let exceptionsRecorded = 0;
  let deliveryLogsRepaired = 0;
  let deliveryLogExceptions = 0;

  // 1. Fetch all settled orders (paid, wallet_paid, delivered, refunded)
  const settledOrders = await db
    .select()
    .from(orders)
    .where(inArray(orders.status, ["paid", "wallet_paid", "delivered", "refunded"]));

  for (const order of settledOrders) {
    const needsSettledAmount = order.settledAmount === null;
    const needsPaidAt = order.paidAt === null;

    let targetSettledAmount: number | null = order.settledAmount;
    let targetPaidAt: Date | null = order.paidAt;

    if (needsSettledAmount) {
      targetSettledAmount = order.amount;
    }

    if (needsPaidAt) {
      if (order.amount === 0 && order.bankDue === 0) {
        // Zero-price order: creation is settlement
        targetPaidAt = order.createdAt;
      } else if (order.bankDue === 0 && order.walletPaid > 0) {
        // Wallet-only order: look for order_hold ledger entry
        const [hold] = await db
          .select({ createdAt: walletLedger.createdAt })
          .from(walletLedger)
          .where(
            and(
              eq(walletLedger.kind, "order_hold"),
              eq(walletLedger.refId, order.id)
            )
          )
          .limit(1);

        if (hold) {
          targetPaidAt = hold.createdAt;
        } else {
          // No reliable ledger evidence -> record exception, keep paid_at NULL
          exceptionsRecorded++;
          await recordMigrationException(db, {
            source: "migration",
            runId,
            entityType: "order",
            entityId: order.id,
            reasonCode: "MISSING_SETTLEMENT_TIMESTAMP",
            evidence: { orderId: order.id, status: order.status, reason: "No order_hold ledger entry found" },
          });
        }
      } else if (order.bankDue > 0) {
        // Bank or split payment: look for SePay transaction
        const [sepay] = await db
          .select({ receivedAt: sepayTransactions.receivedAt })
          .from(sepayTransactions)
          .where(
            and(
              eq(sepayTransactions.orderId, order.id),
              eq(sepayTransactions.transferType, "in")
            )
          )
          .limit(1);

        if (sepay && sepay.receivedAt) {
          targetPaidAt = sepay.receivedAt;
        } else {
          // No reliable SePay evidence -> record exception, keep paid_at NULL
          exceptionsRecorded++;
          await recordMigrationException(db, {
            source: "migration",
            runId,
            entityType: "order",
            entityId: order.id,
            reasonCode: "MISSING_SETTLEMENT_TIMESTAMP",
            evidence: { orderId: order.id, status: order.status, reason: "No matching sepay_transaction received_at found" },
          });
        }
      }
    }

    // Apply updates if not dryRun
    if (!dryRun) {
      const patch: { settledAmount?: number; paidAt?: Date; updatedAt: Date } = {
        updatedAt: new Date(),
      };
      if (needsSettledAmount && targetSettledAmount !== null) {
        patch.settledAmount = targetSettledAmount;
        settledAmountPopulated++;
      }
      if (needsPaidAt && targetPaidAt !== null) {
        patch.paidAt = targetPaidAt;
        paidAtPopulated++;
      }

      if (patch.settledAmount !== undefined || patch.paidAt !== undefined) {
        await db
          .update(orders)
          .set(patch)
          .where(eq(orders.id, order.id));
      }
    } else {
      if (needsSettledAmount && targetSettledAmount !== null) settledAmountPopulated++;
      if (needsPaidAt && targetPaidAt !== null) paidAtPopulated++;
    }
  }

  // 2. Reconcile delivery logs
  const mismatchResult = await db.execute(sql`
    SELECT dl.id AS log_id, dl.order_id, dl.amount AS log_amount,
           o.id AS matched_order_id, o.settled_amount
    FROM delivery_logs dl
    LEFT JOIN orders o ON dl.order_id = o.id
    WHERE o.id IS NULL
       OR dl.amount IS DISTINCT FROM o.settled_amount
  `);

  const rows = (mismatchResult.rows || []) as unknown as Record<string, unknown>[];

  for (const row of rows) {
    const logId = Number(row["log_id"]);
    const matchedOrderId = row["matched_order_id"];
    const logAmount = row["log_amount"] !== null ? Number(row["log_amount"]) : null;
    const settledAmount = row["settled_amount"] !== null ? Number(row["settled_amount"]) : null;

    if (matchedOrderId === null) {
      // Orphan log
      deliveryLogExceptions++;
      await recordMigrationException(db, {
        source: "migration",
        runId,
        entityType: "delivery_log",
        entityId: logId,
        reasonCode: "ORPHAN_DELIVERY_LOG",
        evidence: { logId, orderId: row["order_id"] },
      });
      continue;
    }

    if (settledAmount === null) {
      // Delivered order has NULL settled amount
      deliveryLogExceptions++;
      await recordMigrationException(db, {
        source: "migration",
        runId,
        entityType: "delivery_log",
        entityId: logId,
        reasonCode: "DATA_INTEGRITY_VIOLATION",
        evidence: { logId, orderId: matchedOrderId, logAmount, settledAmount: null },
      });
      continue;
    }

    // Deterministic safe repair: log has 0 but order was settled with > 0
    if (logAmount === 0 && settledAmount > 0) {
      if (!dryRun) {
        await db
          .update(deliveryLogs)
          .set({ amount: settledAmount })
          .where(eq(deliveryLogs.id, logId));
      }
      deliveryLogsRepaired++;
    } else {
      // Ambiguous / conflicting amount
      deliveryLogExceptions++;
      await recordMigrationException(db, {
        source: "migration",
        runId,
        entityType: "delivery_log",
        entityId: logId,
        reasonCode: "AMBIGUOUS_DELIVERY_LOG_AMOUNT",
        evidence: { logId, orderId: matchedOrderId, logAmount, settledAmount },
      });
    }
  }

  return {
    runId,
    settledAmountPopulated,
    paidAtPopulated,
    exceptionsRecorded,
    deliveryLogsRepaired,
    deliveryLogExceptions,
  };
}
