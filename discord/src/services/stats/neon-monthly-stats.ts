/**
 * neon-monthly-stats.ts
 * Phase 3C: Canonical Revenue Accounting & Monthly Reporting on Neon PostgreSQL.
 *
 * Replaces the legacy monthly-fund-stats.ts which queried SQLite audit_log.
 *
 * Canonical Timestamp Conventions:
 *   Settled Sales / Wallet Sales : orders.paid_at
 *   Bank Cash Inbound            : sepay_transactions.received_at
 *   Refunds & Wallet Funding     : wallet_ledger.created_at
 *   Deliveries (business count)  : delivery_logs.delivered_at
 *
 * Revenue Domain (Financial):
 *   Source: orders -> version_id -> plugin_id -> SUM(settled_amount)
 *   NEVER requires delivery_logs to compute revenue.
 *
 * Delivery Domain (Fulfillment):
 *   Source: delivery_logs -> COUNT(DISTINCT order_id)
 *   These are SEPARATE accounting domains.
 */

import { sql } from "drizzle-orm";
import type { Database } from "../../db/neon.js";

// ============================================================================
// Types
// ============================================================================

export interface MonthBounds {
  from: Date;
  to: Date;
}

export interface RevenueMetrics {
  /** Gross settled sales: SUM(settled_amount) for all settled orders in period */
  settledSalesGross: number;
  /** Total refunds in period (Contra-Revenue) */
  totalRefunds: number;
  /** Net sales = settledSalesGross - totalRefunds */
  netSales: number;
  /** Wallet-funded portion of settled sales */
  walletFundedSales: number;
  /** Total inbound bank cash in period (includes unmatched) */
  bankCashReceived: number;
  /** Inbound cash matched to orders or topups */
  matchedCash: number;
  /** Inbound cash with no order/topup reference */
  unmatchedCash: number;
  /** Total business deliveries (COUNT DISTINCT order_id from delivery_logs) */
  businessDeliveries: number;
}

export interface PerPluginRevenue {
  pluginId: number;
  pluginName: string;
  /** Count of unique settled orders */
  uniqueOrders: number;
  /** SUM(settled_amount) — revenue settled from this plugin in period */
  settledAmount: number;
}

export interface PerUserRevenue {
  discordUserId: string;
  uniqueOrders: number;
  settledAmount: number;
}

export interface NeonMonthlyStats {
  month: string;
  bounds: MonthBounds;
  revenue: RevenueMetrics;
  perPlugin: PerPluginRevenue[];
  perUser: PerUserRevenue[];
}

// ============================================================================
// Month boundary helper (UTC, [from, to) half-open interval)
// ============================================================================

/**
 * Computes UTC Date boundaries for a "YYYY-MM" month string.
 * Half-open interval: [from, to) — from is the first ms of the month,
 * to is the first ms of the following month.
 */
export function monthBoundsDate(month: string): MonthBounds {
  const match = /^(\d{4})-(\d{2})$/.exec(month);
  if (!match) throw new Error(`Invalid month format: ${month} (expected YYYY-MM)`);

  const year = Number(match[1]);
  const monthIndex = Number(match[2]) - 1;
  if (monthIndex < 0 || monthIndex > 11) throw new Error(`Invalid month: ${month}`);

  const from = new Date(Date.UTC(year, monthIndex, 1));
  const to = new Date(Date.UTC(monthIndex === 11 ? year + 1 : year, (monthIndex + 1) % 12, 1));
  return { from, to };
}

// ============================================================================
// Core Revenue Metrics
// ============================================================================

/**
 * Computes all canonical revenue and cash metrics for a given period.
 *
 * Phase 3C Rules:
 * - Revenue is from orders.settled_amount (NOT from delivery_logs).
 * - Delivery count is from delivery_logs (separate domain).
 * - paid_at is the authoritative settlement timestamp.
 * - SUM(settled_amount) NOT SUM(DISTINCT settled_amount) to avoid losing revenue on same-price orders.
 */
export async function getRevenueMetrics(
  db: Database,
  from: Date,
  to: Date
): Promise<RevenueMetrics> {
  // A. Settled Sales (Gross) — ALL settled orders in period, including later-refunded
  const settledSalesResult = await db.execute(sql`
    SELECT COALESCE(SUM(settled_amount), 0) AS settled_sales_gross,
           COALESCE(SUM(wallet_paid), 0)    AS wallet_funded_sales
    FROM orders
    WHERE paid_at >= ${from} AND paid_at < ${to}
      AND settled_amount IS NOT NULL
  `);
  const settledSalesRow = (settledSalesResult.rows || [])[0] as Record<string, unknown> | undefined;

  // B. Refunds (Contra-Revenue) — order_refund ledger entries in period
  const refundsResult = await db.execute(sql`
    SELECT COALESCE(SUM(delta), 0) AS total_refunds
    FROM wallet_ledger
    WHERE kind = 'order_refund'
      AND created_at >= ${from} AND created_at < ${to}
  `);
  const refundsRow = (refundsResult.rows || [])[0] as Record<string, unknown> | undefined;

  // C. Bank Cash Reconciliation
  const bankResult = await db.execute(sql`
    SELECT
      COALESCE(SUM(amount), 0) AS bank_cash_received,
      COALESCE(SUM(CASE WHEN order_id IS NOT NULL OR topup_id IS NOT NULL THEN amount ELSE 0 END), 0) AS matched_cash,
      COALESCE(SUM(CASE WHEN order_id IS NULL AND topup_id IS NULL THEN amount ELSE 0 END), 0) AS unmatched_cash
    FROM sepay_transactions
    WHERE transfer_type = 'in'
      AND received_at >= ${from} AND received_at < ${to}
  `);
  const bankRow = (bankResult.rows || [])[0] as Record<string, unknown> | undefined;

  // D. Business Deliveries (COUNT DISTINCT — resilient to at-least-once delivery duplicates)
  const deliveryResult = await db.execute(sql`
    SELECT COUNT(DISTINCT order_id) AS business_deliveries
    FROM delivery_logs
    WHERE delivered_at >= ${from} AND delivered_at < ${to}
  `);
  const deliveryRow = (deliveryResult.rows || [])[0] as Record<string, unknown> | undefined;

  const settledSalesGross = Number(settledSalesRow?.["settled_sales_gross"] ?? 0);
  const walletFundedSales = Number(settledSalesRow?.["wallet_funded_sales"] ?? 0);
  const totalRefunds = Math.abs(Number(refundsRow?.["total_refunds"] ?? 0));
  const bankCashReceived = Number(bankRow?.["bank_cash_received"] ?? 0);
  const matchedCash = Number(bankRow?.["matched_cash"] ?? 0);
  const unmatchedCash = Number(bankRow?.["unmatched_cash"] ?? 0);
  const businessDeliveries = Number(deliveryRow?.["business_deliveries"] ?? 0);

  return {
    settledSalesGross,
    totalRefunds,
    netSales: settledSalesGross - totalRefunds,
    walletFundedSales,
    bankCashReceived,
    matchedCash,
    unmatchedCash,
    businessDeliveries,
  };
}

// ============================================================================
// Per-Plugin Revenue (canonical: orders -> version_id -> plugin_id)
// ============================================================================

/**
 * Revenue breakdown per plugin.
 * Source: orders -> versions.plugin_id -> plugins.name -> SUM(settled_amount)
 * DOES NOT use delivery_logs — revenue can exist before delivery.
 */
export async function getPerPluginRevenue(
  db: Database,
  from: Date,
  to: Date
): Promise<PerPluginRevenue[]> {
  const result = await db.execute(sql`
    WITH settled_orders AS (
      SELECT
        o.id    AS order_id,
        v.plugin_id,
        p.id    AS plugin_pk,
        p.display_name AS canonical_plugin_name,
        o.settled_amount
      FROM orders o
      JOIN versions v ON o.version_id = v.id
      JOIN plugins p ON v.plugin_id = p.id
      WHERE o.settled_amount IS NOT NULL
        AND o.paid_at >= ${from} AND o.paid_at < ${to}
    )
    SELECT
      plugin_pk            AS plugin_id,
      canonical_plugin_name AS plugin_name,
      COUNT(order_id)      AS unique_orders,
      SUM(settled_amount)  AS settled_amount
    FROM settled_orders
    GROUP BY plugin_pk, canonical_plugin_name
    ORDER BY settled_amount DESC, unique_orders DESC
  `);

  const rows = (result.rows || []) as unknown as Record<string, unknown>[];
  return rows.map((r) => ({
    pluginId: Number(r["plugin_id"]),
    pluginName: String(r["plugin_name"]),
    uniqueOrders: Number(r["unique_orders"]),
    settledAmount: Number(r["settled_amount"]),
  }));
}

// ============================================================================
// Per-User Revenue
// ============================================================================

/**
 * Revenue breakdown per Discord user.
 * Source: orders -> SUM(settled_amount) grouped by discord_user_id.
 * DOES NOT use delivery_logs.
 */
export async function getPerUserRevenue(
  db: Database,
  from: Date,
  to: Date
): Promise<PerUserRevenue[]> {
  const result = await db.execute(sql`
    SELECT
      discord_user_id AS discord_user_id,
      COUNT(id)       AS unique_orders,
      SUM(settled_amount) AS settled_amount
    FROM orders
    WHERE settled_amount IS NOT NULL
      AND paid_at >= ${from} AND paid_at < ${to}
    GROUP BY discord_user_id
    ORDER BY settled_amount DESC, unique_orders DESC
  `);

  const rows = (result.rows || []) as unknown as Record<string, unknown>[];
  return rows.map((r) => ({
    discordUserId: String(r["discord_user_id"]),
    uniqueOrders: Number(r["unique_orders"]),
    settledAmount: Number(r["settled_amount"]),
  }));
}

// ============================================================================
// Full Monthly Report
// ============================================================================

/**
 * Full canonical monthly financial report for the given "YYYY-MM" month.
 * Replaces legacy monthlyFundStats() that queried SQLite audit_log.
 */
export async function getNeonMonthlyStats(
  db: Database,
  month: string
): Promise<NeonMonthlyStats> {
  const bounds = monthBoundsDate(month);

  const [revenue, perPlugin, perUser] = await Promise.all([
    getRevenueMetrics(db, bounds.from, bounds.to),
    getPerPluginRevenue(db, bounds.from, bounds.to),
    getPerUserRevenue(db, bounds.from, bounds.to),
  ]);

  return {
    month,
    bounds,
    revenue,
    perPlugin,
    perUser,
  };
}
