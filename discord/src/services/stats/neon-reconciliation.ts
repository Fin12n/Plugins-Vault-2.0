/**
 * neon-reconciliation.ts
 * Phase 3C: Multi-Layer Financial Reconciliation Engine (7-Check Automated)
 *
 * Check A: Wallet balance drift (wallets.balance vs SUM(wallet_ledger.delta))
 * Check B: Settled orders missing settled_amount (paid/wallet_paid/delivered/refunded with NULL)
 * Check C: Delivery log amount mismatch vs orders.settled_amount (NULL-safe)
 * Check D: Refunded orders missing valid order_refund ledger entry
 * Check E: Bank cash reconciliation (matched + unmatched = total inbound)
 * Check F: wallet_paid orders with settled_amount IS NULL
 * Check G: Terminal order integrity (no reopening / no settled_amount overwrite detected)
 */

import { sql } from "drizzle-orm";
import type { Database } from "../../db/neon.js";
import { recordMigrationException } from "../../repositories/neon-settlement.js";

// ============================================================================
// Types
// ============================================================================

export type ReconcileViolationType =
  | "WALLET_BALANCE_DRIFT"
  | "SETTLED_ORDER_MISSING_SETTLED_AMOUNT"
  | "DELIVERY_LOG_AMOUNT_MISMATCH"
  | "REFUND_WITHOUT_VALID_LEDGER"
  | "BANK_CASH_UNBALANCED"
  | "WALLET_PAID_MISSING_SETTLED_AMOUNT"
  | "TERMINAL_ORDER_INTEGRITY_VIOLATION";

export interface ReconcileViolation {
  check: string;
  type: ReconcileViolationType;
  entityType: string;
  entityId: number | string;
  detail: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  evidence: Record<string, any>;
}

export interface ReconcileReport {
  runId: string;
  ranAt: Date;
  violations: ReconcileViolation[];
  /** True if all 7 checks passed with zero violations */
  clean: boolean;
  summary: Record<string, number>;
}

// ============================================================================
// Reconciliation Engine
// ============================================================================

/**
 * Runs all 7 automated reconciliation checks against Neon DB.
 * Violations are logged to _migration_exceptions (idempotent) and returned in the report.
 */
export async function runFinancialReconciliation(
  db: Database,
  runId?: string
): Promise<ReconcileReport> {
  const id = runId ?? `reconcile-${new Date().toISOString().slice(0, 10)}-${Date.now()}`;
  const ranAt = new Date();
  const violations: ReconcileViolation[] = [];

  // ────────────────────────────────────────────────────────────────────────────
  // ────────────────────────────────────────────────────────────────────────────
  // CHECK A: Wallet balance drift
  // ────────────────────────────────────────────────────────────────────────────
  const walletDriftResult = await db.execute(sql`
    SELECT w.discord_user_id, w.balance, COALESCE(SUM(l.delta), 0) AS ledger_sum
    FROM wallets w
    LEFT JOIN wallet_ledger l ON w.discord_user_id = l.discord_user_id
    GROUP BY w.discord_user_id, w.balance
    HAVING w.balance != COALESCE(SUM(l.delta), 0)
  `);

  for (const row of (walletDriftResult.rows || []) as unknown as Record<string, unknown>[]) {
    const v: ReconcileViolation = {
      check: "A",
      type: "WALLET_BALANCE_DRIFT",
      entityType: "wallet",
      entityId: String(row["discord_user_id"]),
      detail: `Wallet balance=${row["balance"]} != ledger_sum=${row["ledger_sum"]}`,
      evidence: { discordUserId: row["discord_user_id"], balance: row["balance"], ledgerSum: row["ledger_sum"] },
    };
    violations.push(v);
    await recordMigrationException(db, {
      source: "runtime_reconciliation",
      runId: id,
      entityType: "wallet",
      entityId: 0,
      reasonCode: "WALLET_BALANCE_DRIFT",
      evidence: v.evidence,
    });
  }

  // ────────────────────────────────────────────────────────────────────────────
  // CHECK B: Settled orders with NULL settled_amount
  // ────────────────────────────────────────────────────────────────────────────
  const settledMissingResult = await db.execute(sql`
    SELECT id, status, amount, settled_amount
    FROM orders
    WHERE status IN ('paid', 'wallet_paid', 'delivered', 'refunded')
      AND (settled_amount IS NULL OR settled_amount != amount)
  `);

  for (const row of (settledMissingResult.rows || []) as unknown as Record<string, unknown>[]) {
    const v: ReconcileViolation = {
      check: "B",
      type: "SETTLED_ORDER_MISSING_SETTLED_AMOUNT",
      entityType: "order",
      entityId: Number(row["id"]),
      detail: `Order #${row["id"]} status=${row["status"]} has settled_amount=${row["settled_amount"]} (expected ${row["amount"]})`,
      evidence: { orderId: row["id"], status: row["status"], amount: row["amount"], settledAmount: row["settled_amount"] },
    };
    violations.push(v);
    await recordMigrationException(db, {
      source: "runtime_reconciliation",
      runId: id,
      entityType: "order",
      entityId: Number(row["id"]),
      reasonCode: "MISSING_SETTLEMENT_EVIDENCE",
      evidence: v.evidence,
    });
  }

  // ────────────────────────────────────────────────────────────────────────────
  // CHECK C: Delivery log amount mismatch (NULL-safe IS DISTINCT FROM)
  // ────────────────────────────────────────────────────────────────────────────
  const deliveryMismatchResult = await db.execute(sql`
    SELECT dl.id AS log_id, dl.order_id, dl.amount AS log_amount,
           o.id AS matched_order_id, o.settled_amount, o.status AS order_status
    FROM delivery_logs dl
    LEFT JOIN orders o ON dl.order_id = o.id
    WHERE o.id IS NULL
       OR dl.amount IS DISTINCT FROM o.settled_amount
  `);

  for (const row of (deliveryMismatchResult.rows || []) as unknown as Record<string, unknown>[]) {
    const isOrphan = row["matched_order_id"] === null;
    const reasonCode = isOrphan ? "ORPHAN_DELIVERY_LOG" : "AMBIGUOUS_DELIVERY_LOG_AMOUNT";
    const v: ReconcileViolation = {
      check: "C",
      type: "DELIVERY_LOG_AMOUNT_MISMATCH",
      entityType: "delivery_log",
      entityId: Number(row["log_id"]),
      detail: isOrphan
        ? `Orphan delivery_log #${row["log_id"]} — no matching order found`
        : `delivery_log #${row["log_id"]} amount=${row["log_amount"]} IS DISTINCT FROM order.settled_amount=${row["settled_amount"]}`,
      evidence: row,
    };
    violations.push(v);
    await recordMigrationException(db, {
      source: "runtime_reconciliation",
      runId: id,
      entityType: "delivery_log",
      entityId: Number(row["log_id"]),
      reasonCode,
      evidence: v.evidence as Record<string, unknown>,
    });
  }

  // ────────────────────────────────────────────────────────────────────────────
  // CHECK D: Refunded orders missing valid order_refund ledger entry
  // ────────────────────────────────────────────────────────────────────────────
  const refundsMissingResult = await db.execute(sql`
    SELECT o.id AS order_id, o.amount, o.status
    FROM orders o
    WHERE o.status = 'refunded'
      AND NOT EXISTS (
        SELECT 1 FROM wallet_ledger wl
        WHERE wl.kind = 'order_refund'
          AND wl.ref_type = 'order'
          AND wl.ref_id = o.id
          AND wl.delta > 0
      )
  `);

  for (const row of (refundsMissingResult.rows || []) as unknown as Record<string, unknown>[]) {
    const v: ReconcileViolation = {
      check: "D",
      type: "REFUND_WITHOUT_VALID_LEDGER",
      entityType: "order",
      entityId: Number(row["order_id"]),
      detail: `Refunded order #${row["order_id"]} has no valid order_refund ledger entry`,
      evidence: { orderId: row["order_id"], amount: row["amount"] },
    };
    violations.push(v);
    await recordMigrationException(db, {
      source: "runtime_reconciliation",
      runId: id,
      entityType: "order",
      entityId: Number(row["order_id"]),
      reasonCode: "REFUND_WITHOUT_VALID_LEDGER",
      evidence: v.evidence,
    });
  }

  // ────────────────────────────────────────────────────────────────────────────
  // CHECK E: Bank cash balance (total = matched + unmatched)
  // ────────────────────────────────────────────────────────────────────────────
  const cashResult = await db.execute(sql`
    SELECT
      COALESCE(SUM(amount), 0) AS total_in,
      COALESCE(SUM(CASE WHEN order_id IS NOT NULL OR topup_id IS NOT NULL THEN amount ELSE 0 END), 0) AS matched,
      COALESCE(SUM(CASE WHEN order_id IS NULL AND topup_id IS NULL THEN amount ELSE 0 END), 0) AS unmatched
    FROM sepay_transactions WHERE transfer_type = 'in'
  `);
  const cashRow = (cashResult.rows || [])[0] as Record<string, unknown> | undefined;

  if (cashRow) {
    const total = Number(cashRow["total_in"]);
    const matched = Number(cashRow["matched"]);
    const unmatched = Number(cashRow["unmatched"]);
    if (Math.abs(total - matched - unmatched) > 0) {
      const v: ReconcileViolation = {
        check: "E",
        type: "BANK_CASH_UNBALANCED",
        entityType: "sepay_transactions",
        entityId: 0,
        detail: `Bank cash total=${total} != matched(${matched}) + unmatched(${unmatched})`,
        evidence: { total, matched, unmatched },
      };
      violations.push(v);
    }
  }

  // ────────────────────────────────────────────────────────────────────────────
  // CHECK F: wallet_paid orders with NULL settled_amount
  // ────────────────────────────────────────────────────────────────────────────
  const walletPaidResult = await db.execute(sql`
    SELECT id, amount FROM orders
    WHERE status = 'wallet_paid' AND settled_amount IS NULL
  `);

  for (const row of (walletPaidResult.rows || []) as unknown as Record<string, unknown>[]) {
    const v: ReconcileViolation = {
      check: "F",
      type: "WALLET_PAID_MISSING_SETTLED_AMOUNT",
      entityType: "order",
      entityId: Number(row["id"]),
      detail: `wallet_paid order #${row["id"]} has settled_amount IS NULL`,
      evidence: { orderId: row["id"], amount: row["amount"] },
    };
    violations.push(v);
    await recordMigrationException(db, {
      source: "runtime_reconciliation",
      runId: id,
      entityType: "order",
      entityId: Number(row["id"]),
      reasonCode: "WALLET_PAID_MISSING_SETTLED_AMOUNT",
      evidence: v.evidence,
    });
  }

  // ────────────────────────────────────────────────────────────────────────────
  // CHECK G: Terminal order integrity — no terminal order should have been re-opened
  // Heuristic: terminal order with paid_at IS NOT NULL but status is cancelled/expired
  // (indicates a potential historical anomaly needing attention)
  // ────────────────────────────────────────────────────────────────────────────
  const terminalResult = await db.execute(sql`
    SELECT id, status, settled_amount, paid_at
    FROM orders
    WHERE status IN ('cancelled', 'expired')
      AND settled_amount IS NOT NULL
  `);

  for (const row of (terminalResult.rows || []) as unknown as Record<string, unknown>[]) {
    const v: ReconcileViolation = {
      check: "G",
      type: "TERMINAL_ORDER_INTEGRITY_VIOLATION",
      entityType: "order",
      entityId: Number(row["id"]),
      detail: `Terminal order #${row["id"]} (${row["status"]}) has settled_amount=${row["settled_amount"]} — possible reopening anomaly`,
      evidence: { orderId: row["id"], status: row["status"], settledAmount: row["settled_amount"], paidAt: row["paid_at"] },
    };
    violations.push(v);
    await recordMigrationException(db, {
      source: "runtime_reconciliation",
      runId: id,
      entityType: "order",
      entityId: Number(row["id"]),
      reasonCode: "TERMINAL_ORDER_INTEGRITY_VIOLATION",
      evidence: v.evidence,
    });
  }

  // ────────────────────────────────────────────────────────────────────────────
  // Summary
  // ────────────────────────────────────────────────────────────────────────────
  const summary: Record<string, number> = {
    A_wallet_drift: 0,
    B_missing_settled_amount: 0,
    C_delivery_mismatch: 0,
    D_refund_no_ledger: 0,
    E_cash_unbalanced: 0,
    F_wallet_paid_no_settled: 0,
    G_terminal_anomaly: 0,
  };
  for (const v of violations) {
    const matchedKey = Object.keys(summary).find((k) => k.startsWith(v.check + "_"));
    if (matchedKey && matchedKey in summary) {
      summary[matchedKey] = (summary[matchedKey] ?? 0) + 1;
    }
  }

  return {
    runId: id,
    ranAt,
    violations,
    clean: violations.length === 0,
    summary,
  };
}
