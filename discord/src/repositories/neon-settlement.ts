/**
 * neon-settlement.ts
 * Phase 3C: Hardened settlement-specific helpers.
 *
 * Architectural rules:
 * - settleOrderPaidTx / settleOrderWalletPaidTx are the ONLY authoritative paths
 *   that may write (settled_amount, paid_at) on an order.
 * - Both functions lock the order row FOR UPDATE before touching any data.
 * - paid_at is sourced authoritatively from the DB, never from the caller.
 * - settled_amount is always = order.amount (canonical). Caller cannot override.
 * - Idempotent: already-settled orders are returned unchanged.
 * - Terminal orders (refunded, cancelled, expired, delivered) are rejected.
 */

import { eq } from "drizzle-orm";
import type { Database } from "../db/neon.js";
import {
  orders,
  walletLedger,
  sepayTransactions,
  migrationExceptions,
  type Order,
  type MigrationException,
} from "@vault/db";

// Transaction-scoped DB type
type Tx = Parameters<Parameters<Database["transaction"]>[0]>[0];

// ============================================================================
// A. recordMigrationException (idempotent upsert)
// ============================================================================

/**
 * Records a reconciliation or data-integrity exception into `_migration_exceptions`.
 * Idempotent: duplicate (source, runId, entityType, entityId, reasonCode) is silently ignored.
 *
 * SECURITY: Never include secrets, passwords, cookies, tokens in `evidence`.
 */
export async function recordMigrationException(
  db: Database | Tx,
  input: {
    source: string;
    runId: string;
    entityType: string;
    entityId: number;
    reasonCode: string;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    evidence: Record<string, any>;
  }
): Promise<MigrationException | null> {
  const [row] = await (db as Database)
    .insert(migrationExceptions)
    .values({
      source: input.source,
      runId: input.runId,
      entityType: input.entityType,
      entityId: input.entityId,
      reasonCode: input.reasonCode,
      evidence: input.evidence,
    })
    .onConflictDoNothing()
    .returning();
  return row ?? null;
}

// ============================================================================
// B. settleOrderPaidTx — Bank or split-payment settlement
// ============================================================================

/** Input for settleOrderPaidTx */
export interface SettleOrderPaidInput {
  orderId: number;
  /** Actual bank transfer amount received (for paidAmount column). */
  paidAmount: number;
  /** FK into sepay_transactions — authoritative source of received_at for paid_at. */
  sepayTransactionId: number;
  /**
   * Optional: caller-asserted amount for cross-check only.
   * If provided and != order.amount, the call is rejected.
   */
  amount?: number;
  /**
   * Optional: caller-asserted paidAt for cross-check only.
   * If provided and != sepay.received_at, the call is rejected.
   */
  paidAt?: Date;
}

/** Terminal statuses — cannot be settled */
const TERMINAL_STATUSES = new Set(["refunded", "cancelled", "expired", "delivered"]);

/**
 * Atomically settles an order as bank-paid within the given Drizzle transaction.
 *
 * Guarantees:
 *   1. settled_amount = order.amount (canonical, immutable after this call).
 *   2. paid_at = sepay_transactions.received_at (authoritative from DB).
 *   3. Idempotent: already-paid orders are returned unchanged.
 *   4. Terminal-order protection: rejects if order is in a terminal state.
 *   5. Caller-tampering protection: rejects if caller-asserted amount or paidAt differs.
 */
export async function settleOrderPaidTx(tx: Tx, input: SettleOrderPaidInput): Promise<Order> {
  // 1. Lock order row FOR UPDATE
  const [lockedOrder] = await tx
    .select()
    .from(orders)
    .where(eq(orders.id, input.orderId))
    .for("update");

  if (!lockedOrder) {
    throw new Error(`settleOrderPaidTx: Order #${input.orderId} not found`);
  }

  // 2. Reject terminal orders
  if (TERMINAL_STATUSES.has(lockedOrder.status)) {
    throw new Error(
      `settleOrderPaidTx: Order #${input.orderId} is in terminal state '${lockedOrder.status}' and cannot be settled`
    );
  }

  // 3. Idempotent: already settled (paid) — return unchanged
  if (lockedOrder.status === "paid" && lockedOrder.settledAmount !== null) {
    // Cross-check caller assertions for safety
    if (input.amount !== undefined && input.amount !== lockedOrder.settledAmount) {
      throw new Error(
        `settleOrderPaidTx: Idempotent call on Order #${input.orderId} but caller asserted amount=${input.amount} != settled_amount=${lockedOrder.settledAmount}`
      );
    }
    return lockedOrder;
  }

  // 4. Canonical amount from DB (reject caller tamper)
  const canonicalAmount = lockedOrder.amount;
  if (input.amount !== undefined && input.amount !== canonicalAmount) {
    throw new Error(
      `settleOrderPaidTx: Caller-asserted amount=${input.amount} != order.amount=${canonicalAmount} for Order #${input.orderId}. Rejected.`
    );
  }

  // 5. Load authoritative paid_at from sepay_transactions.received_at
  const [sepayRow] = await tx
    .select({ receivedAt: sepayTransactions.receivedAt })
    .from(sepayTransactions)
    .where(eq(sepayTransactions.id, input.sepayTransactionId));

  if (!sepayRow) {
    throw new Error(
      `settleOrderPaidTx: SePay transaction #${input.sepayTransactionId} not found — cannot determine authoritative paid_at`
    );
  }

  const authoritativePaidAt = sepayRow.receivedAt;

  // 5a. Cross-check caller-asserted paidAt
  if (input.paidAt !== undefined) {
    const diff = Math.abs(input.paidAt.getTime() - authoritativePaidAt.getTime());
    if (diff > 1000) {
      // Allow <=1s rounding, reject larger deviation
      throw new Error(
        `settleOrderPaidTx: Caller-asserted paidAt=${input.paidAt.toISOString()} deviates from authoritative sepay.received_at=${authoritativePaidAt.toISOString()} for Order #${input.orderId}. Rejected.`
      );
    }
  }

  // 6. Commit settlement atomically (status + settled_amount + paid_at + paid_amount)
  const [settled] = await tx
    .update(orders)
    .set({
      status: "paid",
      settledAmount: canonicalAmount,
      paidAt: authoritativePaidAt,
      paidAmount: input.paidAmount,
      updatedAt: new Date(),
    })
    .where(eq(orders.id, input.orderId))
    .returning();

  if (!settled) {
    throw new Error(`settleOrderPaidTx: Failed to update Order #${input.orderId}`);
  }

  return settled;
}

// ============================================================================
// C. settleOrderWalletPaidTx — Wallet-funded or zero-price settlement
// ============================================================================

/** Input for settleOrderWalletPaidTx */
export interface SettleOrderWalletPaidInput {
  orderId: number;
  /**
   * FK into wallet_ledger for the 'order_hold' entry —
   * authoritative source of created_at for paid_at.
   */
  ledgerHoldId: number;
  /**
   * Optional: caller-asserted amount for cross-check only.
   * If provided and != order.amount, the call is rejected.
   */
  amount?: number;
  /**
   * Optional: caller-asserted paidAt for cross-check only.
   * If provided and != ledger.created_at, the call is rejected.
   */
  paidAt?: Date;
}

/**
 * Atomically settles an order as wallet-paid within the given Drizzle transaction.
 *
 * Guarantees:
 *   1. settled_amount = order.amount (canonical, immutable after this call).
 *   2. paid_at = wallet_ledger.created_at of the 'order_hold' entry (authoritative).
 *   3. Validates ledger entry integrity: kind='order_hold', ref_id=orderId, delta=-order.amount.
 *   4. Idempotent: already wallet_paid orders are returned unchanged.
 *   5. Terminal-order protection.
 *   6. Caller-tampering protection on amount and paidAt.
 */
export async function settleOrderWalletPaidTx(
  tx: Tx,
  input: SettleOrderWalletPaidInput
): Promise<Order> {
  // 1. Lock order row FOR UPDATE
  const [lockedOrder] = await tx
    .select()
    .from(orders)
    .where(eq(orders.id, input.orderId))
    .for("update");

  if (!lockedOrder) {
    throw new Error(`settleOrderWalletPaidTx: Order #${input.orderId} not found`);
  }

  // 2. Reject terminal orders
  if (TERMINAL_STATUSES.has(lockedOrder.status)) {
    throw new Error(
      `settleOrderWalletPaidTx: Order #${input.orderId} is in terminal state '${lockedOrder.status}' and cannot be settled`
    );
  }

  // 3. Idempotent: already settled (wallet_paid) — return unchanged
  if (lockedOrder.status === "wallet_paid" && lockedOrder.settledAmount !== null) {
    if (input.amount !== undefined && input.amount !== lockedOrder.settledAmount) {
      throw new Error(
        `settleOrderWalletPaidTx: Idempotent call on Order #${input.orderId} but caller asserted amount=${input.amount} != settled_amount=${lockedOrder.settledAmount}`
      );
    }
    return lockedOrder;
  }

  // 4. Canonical amount from DB (reject caller tamper)
  const canonicalAmount = lockedOrder.amount;
  if (input.amount !== undefined && input.amount !== canonicalAmount) {
    throw new Error(
      `settleOrderWalletPaidTx: Caller-asserted amount=${input.amount} != order.amount=${canonicalAmount} for Order #${input.orderId}. Rejected.`
    );
  }

  // 5. Load authoritative paid_at from wallet_ledger.created_at (order_hold entry)
  const [ledgerRow] = await tx
    .select({
      id: walletLedger.id,
      kind: walletLedger.kind,
      refId: walletLedger.refId,
      delta: walletLedger.delta,
      createdAt: walletLedger.createdAt,
    })
    .from(walletLedger)
    .where(eq(walletLedger.id, input.ledgerHoldId));

  if (!ledgerRow) {
    throw new Error(
      `settleOrderWalletPaidTx: wallet_ledger #${input.ledgerHoldId} not found — cannot determine authoritative paid_at`
    );
  }

  // 5a. Validate ledger entry integrity
  if (ledgerRow.kind !== "order_hold") {
    throw new Error(
      `settleOrderWalletPaidTx: wallet_ledger #${input.ledgerHoldId} has kind='${ledgerRow.kind}', expected 'order_hold'. Rejected.`
    );
  }
  if (ledgerRow.refId !== input.orderId) {
    throw new Error(
      `settleOrderWalletPaidTx: wallet_ledger #${input.ledgerHoldId} ref_id=${ledgerRow.refId} != orderId=${input.orderId}. Rejected.`
    );
  }
  // Zero-price orders: delta = 0; non-zero: delta = -order.amount
  const expectedDelta = -canonicalAmount;
  if (canonicalAmount > 0 && ledgerRow.delta !== expectedDelta) {
    throw new Error(
      `settleOrderWalletPaidTx: wallet_ledger #${input.ledgerHoldId} delta=${ledgerRow.delta} != expected=${expectedDelta} for Order #${input.orderId}. Rejected.`
    );
  }

  const authoritativePaidAt = ledgerRow.createdAt;

  // 5b. Cross-check caller-asserted paidAt
  if (input.paidAt !== undefined) {
    const diff = Math.abs(input.paidAt.getTime() - authoritativePaidAt.getTime());
    if (diff > 1000) {
      throw new Error(
        `settleOrderWalletPaidTx: Caller-asserted paidAt=${input.paidAt.toISOString()} deviates from authoritative ledger.created_at=${authoritativePaidAt.toISOString()} for Order #${input.orderId}. Rejected.`
      );
    }
  }

  // 6. Commit settlement atomically (status + settled_amount + paid_at)
  const [settled] = await tx
    .update(orders)
    .set({
      status: "wallet_paid",
      settledAmount: canonicalAmount,
      paidAt: authoritativePaidAt,
      updatedAt: new Date(),
    })
    .where(eq(orders.id, input.orderId))
    .returning();

  if (!settled) {
    throw new Error(`settleOrderWalletPaidTx: Failed to update Order #${input.orderId}`);
  }

  return settled;
}
