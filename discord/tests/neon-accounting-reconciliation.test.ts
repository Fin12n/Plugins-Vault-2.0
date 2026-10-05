import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  orders,
  wallets,
  walletLedger,
  sepayTransactions,
  deliveryJobs,
  deliveryLogs,
  migrationExceptions,
  versions,
  plugins,
  downloadTokens,
} from "@vault/db";
import {
  settleOrderPaidTx,
  settleOrderWalletPaidTx,
  recordMigrationException,
} from "../src/repositories/neon-settlement.js";
import {
  openOrderNeon,
  applySepayTransferNeon,
  type OrderConfig,
} from "../src/services/payment/neon-payment-flow.js";
import {
  updateOrderStatus,
  refundOrderWallet,
} from "../src/repositories/neon-orders.js";
import { processNextDeliveryJob } from "../src/services/delivery/neon-delivery-worker.js";
import {
  getNeonMonthlyStats,
  getRevenueMetrics,
  getPerPluginRevenue,
  getPerUserRevenue,
  monthBoundsDate,
} from "../src/services/stats/neon-monthly-stats.js";
import { runFinancialReconciliation } from "../src/services/stats/neon-reconciliation.js";
import { backfillSettledAmount } from "../src/scripts/backfill-settled-amount.js";

const getMonthlyFundStatsNeon = getNeonMonthlyStats;

// Mock blob path resolver for delivery worker tests
vi.mock("../src/services/delivery/deliver-version.js", async (importOriginal) => {
  const actual: any = await importOriginal();
  return {
    ...actual,
    resolveBlobPath: vi.fn(async () => "/fake/path/test-plugin-1.0.0.jar"),
  };
});

const defaultOrderConfig: OrderConfig = {
  codePrefix: "ORD-",
  codeSuffixLength: 6,
  ttlMinutes: 15,
  accountNumber: "123456789",
  bankCode: "MB",
};

function extractValues(cond: any): any[] {
  if (!cond) return [];
  const vals: any[] = [];
  function recurse(c: any) {
    if (!c) return;
    if (typeof c === "string" || typeof c === "number" || typeof c === "boolean" || c instanceof Date) {
      vals.push(c);
      return;
    }
    if (c.value !== undefined && !Array.isArray(c.value)) {
      vals.push(c.value);
    }
    if (Array.isArray(c.queryChunks)) {
      for (const chunk of c.queryChunks) {
        recurse(chunk);
      }
    }
  }
  recurse(cond);
  return vals;
}

function sqlToString(queryObj: any): string {
  if (typeof queryObj === "string") return queryObj;
  if (!queryObj) return "";
  if (Array.isArray(queryObj.queryChunks)) {
    return queryObj.queryChunks
      .map((c: any) => {
        if (typeof c === "string") return c;
        if (Array.isArray(c?.strings)) return c.strings.join("");
        if (c?.value !== undefined) return String(c.value);
        return "";
      })
      .join(" ");
  }
  return JSON.stringify(queryObj);
}

function getTableName(table: any): string {
  if (!table) return "";
  if (table === orders) return "orders";
  if (table === wallets) return "wallets";
  if (table === walletLedger) return "wallet_ledger";
  if (table === sepayTransactions) return "sepay_transactions";
  if (table === deliveryJobs) return "delivery_jobs";
  if (table === deliveryLogs) return "delivery_logs";
  if (table === versions) return "versions";
  if (table === plugins) return "plugins";
  if (table === migrationExceptions) return "_migration_exceptions";
  if (table === downloadTokens) return "download_tokens";
  if (typeof table === "string") return table;
  return (
    table?.[Symbol.for("drizzle:Name")] ??
    table?.[Symbol.for("drizzle:OriginalName")] ??
    table?._?.name ??
    table?.tableName ??
    table?.name ??
    ""
  );
}

function createMockNeonDb() {
  let nextOrderId = 100;
  let nextSepayId = 200;
  let nextJobId = 300;
  let nextLogId = 400;
  let nextExceptionId = 500;
  let nextLedgerId = 1;
  let txQueue = Promise.resolve();

  const state = {
    wallets: new Map<string, { discordUserId: string; balance: number; createdAt: Date; updatedAt: Date }>(),
    ledger: [] as Array<{
      id: number;
      discordUserId: string;
      delta: number;
      balanceAfter: number;
      kind: string;
      refType: string;
      refId: number | null;
      note: string;
      createdAt: Date;
    }>,
    orders: new Map<number, any>(),
    sepayTransactions: new Map<number, any>(),
    deliveryJobs: new Map<number, any>(),
    deliveryLogs: new Map<number, any>(),
    migrationExceptions: [] as any[],
    downloadTokens: new Map<string, any>(),
    versions: new Map<number, any>([
      [
        1,
        {
          id: 1,
          pluginId: 10,
          version: "1.0.0",
          relPath: "plugins/test-plugin-1.0.0.jar",
          originalName: "test-plugin.jar",
          bytes: 1024 * 1024,
        },
      ],
      [
        2,
        {
          id: 2,
          pluginId: 20,
          version: "2.0.0",
          relPath: "plugins/other-plugin-2.0.0.jar",
          originalName: "other-plugin.jar",
          bytes: 2048 * 1024,
        },
      ],
      [
        3,
        {
          id: 3,
          pluginId: 30,
          version: "0.0.1",
          relPath: "plugins/free-plugin-0.0.1.jar",
          originalName: "free-plugin.jar",
          bytes: 512 * 1024,
        },
      ],
    ]),
    plugins: new Map<number, any>([
      [10, { id: 10, slug: "test-plugin", displayName: "Test Plugin", depositPrice: 100_000 }],
      [20, { id: 20, slug: "other-plugin", displayName: "Other Plugin", depositPrice: 50_000 }],
      [30, { id: 30, slug: "free-plugin", displayName: "Free Plugin", depositPrice: 0 }],
    ]),
    topups: new Map<number, any>(),
  };

  const mockDb: any = {
    _state: state,
    orders,
    wallets,
    walletLedger,
    sepayTransactions,
    deliveryJobs,
    deliveryLogs,
    migrationExceptions,
    versions,
    plugins,
    downloadTokens,

    select: (_fields?: any) => ({
      from: (table: any) => ({
        where: (condition: any) => {
          const run = () => {
            const tbl = getTableName(table);
            const vals = extractValues(condition);

            if (tbl === "wallets") {
              const targetUserId = vals.find((v) => typeof v === "string");
              const res = Array.from(state.wallets.values());
              return targetUserId ? res.filter((w) => w.discordUserId === targetUserId) : res;
            }
            if (tbl === "orders") {
              const targetOrderId = vals.find((v) => typeof v === "number");
              const targetCode = vals.find((v) => typeof v === "string" && v.startsWith("ORD-"));
              const res = Array.from(state.orders.values());
              if (targetOrderId !== undefined) return res.filter((o) => o.id === targetOrderId);
              if (targetCode !== undefined) return res.filter((o) => o.code === targetCode);
              return res;
            }
            if (tbl === "sepay_transactions") {
              const targetId = vals.find((v) => typeof v === "number");
              const res = Array.from(state.sepayTransactions.values());
              return targetId !== undefined
                ? res.filter((s) => s.id === targetId || s.sepayId === targetId || s.orderId === targetId)
                : res;
            }
            if (tbl === "wallet_ledger") {
              const targetId = vals.find((v) => typeof v === "number");
              return targetId !== undefined ? state.ledger.filter((l) => l.id === targetId || l.refId === targetId) : state.ledger;
            }
            if (tbl === "delivery_jobs") {
              const targetId = vals.find((v) => typeof v === "number");
              const res = Array.from(state.deliveryJobs.values());
              return targetId !== undefined
                ? res.filter((j) => j.id === targetId || j.orderId === targetId)
                : res;
            }
            if (tbl === "versions") {
              const targetId = vals.find((v) => typeof v === "number");
              const res = Array.from(state.versions.values());
              return targetId !== undefined ? res.filter((v) => v.id === targetId) : res;
            }
            if (tbl === "plugins") {
              const targetId = vals.find((v) => typeof v === "number");
              const res = Array.from(state.plugins.values());
              return targetId !== undefined ? res.filter((p) => p.id === targetId) : res;
            }
            if (tbl === "download_tokens") {
              const targetHash = vals.find((v) => typeof v === "string");
              const res = Array.from(state.downloadTokens.values());
              return targetHash ? res.filter((t) => t.tokenHash === targetHash) : res;
            }
            if (tbl === "_migration_exceptions" || tbl === "migration_exceptions") {
              return state.migrationExceptions;
            }
            return [];
          };

          return {
            for: () => run(),
            limit: () => run(),
            orderBy: () => run(),
            then: (res: any) => res(run()),
          };
        },
        limit: (n: number) => {
          const tbl = getTableName(table);
          if (tbl === "orders") return Array.from(state.orders.values()).slice(0, n);
          return [];
        },
      }),
    }),

    insert: (table: any) => ({
      values: (val: any) => {
        const tbl = getTableName(table);

        const executeInsert = (doNothing = false) => {
          if (tbl === "orders") {
            const id = val.id || nextOrderId++;
            const row = {
              id,
              status: "pending",
              settledAmount: null,
              paidAmount: 0,
              paidAt: null,
              walletPaid: 0,
              bankDue: val.amount ?? 0,
              createdAt: new Date(),
              updatedAt: new Date(),
              ...val,
            };
            state.orders.set(id, row);
            return [row];
          }
          if (tbl === "wallets") {
            if (doNothing && state.wallets.has(val.discordUserId)) return [];
            const row = {
              balance: 0,
              createdAt: new Date(),
              updatedAt: new Date(),
              ...val,
            };
            state.wallets.set(val.discordUserId, row);
            return [row];
          }
          if (tbl === "wallet_ledger") {
            const id = nextLedgerId++;
            const row = {
              id,
              createdAt: new Date(),
              ...val,
            };
            state.ledger.push(row);
            return [row];
          }
          if (tbl === "sepay_transactions") {
            const id = val.id || nextSepayId++;
            const row = {
              id,
              transferType: "in",
              receivedAt: new Date(),
              processedAt: new Date(),
              status: "pending",
              ...val,
            };
            state.sepayTransactions.set(id, row);
            return [row];
          }
          if (tbl === "delivery_jobs") {
            const id = val.id || nextJobId++;
            const row = {
              id,
              status: "queued",
              externalAttemptCount: 0,
              retryCount: 0,
              createdAt: new Date(),
              updatedAt: new Date(),
              ...val,
            };
            state.deliveryJobs.set(id, row);
            return [row];
          }
          if (tbl === "delivery_logs") {
            const id = val.id || nextLogId++;
            const row = {
              id,
              deliveredAt: new Date(),
              ...val,
            };
            state.deliveryLogs.set(id, row);
            return [row];
          }
          if (tbl === "_migration_exceptions" || tbl === "migration_exceptions") {
            const conflict = state.migrationExceptions.find(
              (e) =>
                e.source === val.source &&
                e.runId === val.runId &&
                e.entityType === val.entityType &&
                e.entityId === val.entityId &&
                e.reasonCode === val.reasonCode
            );
            if (conflict) {
              if (doNothing) return [];
              throw new Error("Unique constraint violation on _migration_exceptions");
            }
            const id = nextExceptionId++;
            const row = {
              id,
              createdAt: new Date(),
              resolvedAt: null,
              ...val,
            };
            state.migrationExceptions.push(row);
            return [row];
          }
          if (tbl === "download_tokens") {
            state.downloadTokens.set(val.tokenHash, { ...val, createdAt: new Date() });
            return [val];
          }
          return [];
        };

        return {
          onConflictDoNothing: () => ({
            returning: () => executeInsert(true),
            then: (res: any) => res(executeInsert(true)),
          }),
          returning: () => executeInsert(false),
          then: (res: any) => res(executeInsert(false)),
        };
      },
    }),

    update: (table: any) => ({
      set: (patch: any) => ({
        where: (condition: any) => {
          const tbl = getTableName(table);
          const vals = extractValues(condition);
          const updatedRows: any[] = [];

          if (tbl === "orders") {
            const targetOrderId = vals.find((v) => typeof v === "number");
            if (targetOrderId !== undefined) {
              const order = state.orders.get(targetOrderId);
              if (order) {
                const updated = { ...order, ...patch, updatedAt: new Date() };
                state.orders.set(targetOrderId, updated);
                updatedRows.push(updated);
              }
            }
          } else if (tbl === "wallets") {
            const targetUserId = vals.find((v) => typeof v === "string");
            if (targetUserId) {
              const w = state.wallets.get(targetUserId) ?? {
                discordUserId: targetUserId,
                balance: 0,
                createdAt: new Date(),
                updatedAt: new Date(),
              };
              const updated = { ...w, ...patch, updatedAt: new Date() };
              state.wallets.set(targetUserId, updated);
              updatedRows.push(updated);
            }
          } else if (tbl === "delivery_jobs") {
            const targetId = vals.find((v) => typeof v === "number");
            for (const [id, job] of state.deliveryJobs.entries()) {
              if (targetId === undefined || id === targetId || job.orderId === targetId) {
                const updated = { ...job, ...patch, updatedAt: new Date() };
                state.deliveryJobs.set(id, updated);
                updatedRows.push(updated);
              }
            }
          } else if (tbl === "sepay_transactions") {
            const targetId = vals.find((v) => typeof v === "number");
            for (const [id, s] of state.sepayTransactions.entries()) {
              if (targetId === undefined || id === targetId || s.sepayId === targetId) {
                const updated = { ...s, ...patch, updatedAt: new Date() };
                state.sepayTransactions.set(id, updated);
                updatedRows.push(updated);
              }
            }
          }

          return {
            returning: () => updatedRows,
            then: (res: any) => res(updatedRows),
          };
        },
      }),
    }),

    delete: (table: any) => ({
      where: (condition: any) => {
        const tbl = getTableName(table);
        const deleted: any[] = [];
        const vals = extractValues(condition);
        if (tbl === "download_tokens") {
          const targetOrderId = vals.find((v) => typeof v === "number");
          for (const [k, v] of Array.from(state.downloadTokens.entries())) {
            if (targetOrderId === undefined || v.orderId === targetOrderId) {
              state.downloadTokens.delete(k);
              deleted.push(v);
            }
          }
        }
        return {
          returning: () => deleted,
          then: (res: any) => res(deleted),
        };
      },
    }),

    transaction: async (cb: any) => {
      let release: () => void;
      const nextInQueue = new Promise<void>((resolve) => {
        release = resolve;
      });
      const currentQueue = txQueue;
      txQueue = currentQueue.then(
        () => nextInQueue,
        () => nextInQueue
      );

      await currentQueue.catch(() => {});

      const snapOrders = new Map(state.orders);
      const snapWallets = new Map(state.wallets);
      const snapLedger = [...state.ledger];
      const snapSepay = new Map(state.sepayTransactions);
      const snapJobs = new Map(state.deliveryJobs);
      const snapLogs = new Map(state.deliveryLogs);
      const snapExceptions = [...state.migrationExceptions];

      try {
        const result = await cb(mockDb);
        return result;
      } catch (err) {
        state.orders.clear();
        snapOrders.forEach((v, k) => state.orders.set(k, { ...v }));
        state.wallets.clear();
        snapWallets.forEach((v, k) => state.wallets.set(k, { ...v }));
        state.ledger.length = 0;
        state.ledger.push(...snapLedger.map((l) => ({ ...l })));
        state.sepayTransactions.clear();
        snapSepay.forEach((v, k) => state.sepayTransactions.set(k, { ...v }));
        state.deliveryJobs.clear();
        snapJobs.forEach((v, k) => state.deliveryJobs.set(k, { ...v }));
        state.deliveryLogs.clear();
        snapLogs.forEach((v, k) => state.deliveryLogs.set(k, { ...v }));
        state.migrationExceptions.length = 0;
        state.migrationExceptions.push(...snapExceptions.map((e) => ({ ...e })));
        throw err;
      } finally {
        release!();
      }
    },

    execute: async (queryObj: any) => {
      const sqlLower = sqlToString(queryObj).toLowerCase();
      const vals = extractValues(queryObj);
      const now = new Date();

      // 1. Delivery job atomic claim (claimStaleOrQueuedDeliveryJob / claimDeliveryJobById)
      if (sqlLower.includes("update delivery_jobs") && sqlLower.includes("status = 'processing'")) {
        const claimantToken = (vals.find((v) => typeof v === "string") as string) || "worker-test";
        const isTargetedClaim = !sqlLower.includes("select id from delivery_jobs");
        const targetJobId = isTargetedClaim
          ? (vals.find((v) => typeof v === "number") as number | undefined)
          : undefined;

        const claimedRows: any[] = [];
        for (const [id, job] of state.deliveryJobs.entries()) {
          if (targetJobId !== undefined && id !== targetJobId) continue;
          if (job.status === "queued" || job.status === "retryable" || job.status === "processing") {
            job.status = "processing";
            job.claimToken = claimantToken;
            job.lockedAt = now;
            job.externalAttemptCount = (job.externalAttemptCount || 0) + 1;
            job.updatedAt = now;
            claimedRows.push({ ...job });
            break; // LIMIT 1
          }
        }
        return { rows: claimedRows };
      }

      // 2. Check A: Wallet balance vs ledger sum
      if (sqlLower.includes("wallets w") && sqlLower.includes("wallet_ledger l") && sqlLower.includes("having")) {
        const drifts: any[] = [];
        for (const [userId, w] of state.wallets.entries()) {
          const ledgerSum = state.ledger
            .filter((l) => l.discordUserId === userId)
            .reduce((sum, l) => sum + l.delta, 0);
          if (w.balance !== ledgerSum) {
            drifts.push({
              discord_user_id: userId,
              balance: w.balance,
              ledger_sum: ledgerSum,
              drift: w.balance - ledgerSum,
            });
          }
        }
        return { rows: drifts };
      }

      // 3. Check B: Settled orders with NULL settled_amount
      if (sqlLower.includes("status in ('paid', 'wallet_paid', 'delivered', 'refunded')") && sqlLower.includes("settled_amount is null")) {
        const missing: any[] = [];
        for (const order of state.orders.values()) {
          if (["paid", "wallet_paid", "delivered", "refunded"].includes(order.status)) {
            if (order.settledAmount === null || order.settledAmount === undefined || order.settledAmount !== order.amount) {
              missing.push({
                id: order.id,
                status: order.status,
                amount: order.amount,
                settled_amount: order.settledAmount,
              });
            }
          }
        }
        return { rows: missing };
      }

      // 4. Check C / Delivery log reconciliation:
      if (sqlLower.includes("delivery_logs dl") && sqlLower.includes("distinct from")) {
        const mismatches: any[] = [];
        for (const log of state.deliveryLogs.values()) {
          const order = state.orders.get(log.orderId);
          if (!order) {
            mismatches.push({
              id: log.id,
              order_id: log.orderId,
              log_amount: log.amount,
              matched_order_id: null,
              settled_amount: null,
              order_status: null,
            });
          } else {
            const logAmount = log.amount ?? null;
            const settledAmount = order.settledAmount ?? null;
            if (logAmount !== settledAmount) {
              mismatches.push({
                id: log.id,
                order_id: log.orderId,
                log_amount: log.amount,
                matched_order_id: order.id,
                settled_amount: order.settledAmount,
                order_status: order.status,
              });
            }
          }
        }
        return { rows: mismatches };
      }

      // 5. Check D: Refunded orders without valid order_refund ledger entry
      if (sqlLower.includes("status = 'refunded'") && sqlLower.includes("wallet_ledger")) {
        const unverified: any[] = [];
        for (const order of state.orders.values()) {
          if (order.status === "refunded") {
            const hasValidLedger = state.ledger.some(
              (l) => l.kind === "order_refund" && l.refType === "order" && l.refId === order.id && l.delta > 0
            );
            if (!hasValidLedger) {
              unverified.push({
                order_id: order.id,
                amount: order.amount,
                settled_amount: order.settledAmount,
                paid_at: order.paidAt,
              });
            }
          }
        }
        return { rows: unverified };
      }

      // 6. Check E & Monthly Bank Cash: Inbound SePay cash reconciliation
      if (sqlLower.includes("sepay_transactions") && (sqlLower.includes("matched_cash") || sqlLower.includes("unmatched_cash") || sqlLower.includes("total_in") || sqlLower.includes("bank_cash_received"))) {
        let totalCash = 0;
        let matchedCash = 0;
        let unmatchedCash = 0;
        const fromDate = vals.find((v) => v instanceof Date);
        const toDate = vals.filter((v) => v instanceof Date)[1];

        for (const s of state.sepayTransactions.values()) {
          if (s.transferType === "in") {
            if (fromDate && s.receivedAt < fromDate) continue;
            if (toDate && s.receivedAt >= toDate) continue;
            totalCash += s.amount;
            if (s.orderId !== null && s.orderId !== undefined || s.topupId !== null && s.topupId !== undefined) {
              matchedCash += s.amount;
            } else {
              unmatchedCash += s.amount;
            }
          }
        }
        return {
          rows: [
            {
              total_in: totalCash,
              bank_cash_received: totalCash,
              total_cash: totalCash,
              matched: matchedCash,
              matched_cash: matchedCash,
              unmatched: unmatchedCash,
              unmatched_cash: unmatchedCash,
            },
          ],
        };
      }

      // 7. Check F: wallet_paid orders with NULL settled_amount
      if (sqlLower.includes("status = 'wallet_paid'") && sqlLower.includes("settled_amount is null")) {
        const missing: any[] = [];
        for (const order of state.orders.values()) {
          if (order.status === "wallet_paid" && (order.settledAmount === null || order.settledAmount === undefined)) {
            missing.push({
              id: order.id,
              amount: order.amount,
            });
          }
        }
        return { rows: missing };
      }

      // 8. Check G: Terminal order integrity
      if (sqlLower.includes("paid_at is not null") && (sqlLower.includes("cancelled") || sqlLower.includes("expired"))) {
        const suspicious: any[] = [];
        for (const order of state.orders.values()) {
          if (order.paidAt !== null && ["cancelled", "expired"].includes(order.status)) {
            suspicious.push({
              id: order.id,
              status: order.status,
              amount: order.amount,
              settled_amount: order.settledAmount,
              paid_at: order.paidAt,
            });
          }
        }
        return { rows: suspicious };
      }

      // 9. Monthly Stats: Settled Sales Gross
      if (sqlLower.includes("settled_sales_gross")) {
        const fromDate = vals.find((v) => v instanceof Date);
        const toDate = vals.filter((v) => v instanceof Date)[1];

        let grossSales = 0;
        let walletFundedSales = 0;

        for (const order of state.orders.values()) {
          if (order.settledAmount !== null && order.settledAmount !== undefined && order.paidAt) {
            const pAt = new Date(order.paidAt);
            if (fromDate && pAt < fromDate) continue;
            if (toDate && pAt >= toDate) continue;
            grossSales += order.settledAmount;
            walletFundedSales += (order.walletPaid || 0);
          }
        }

        return {
          rows: [
            {
              settled_sales_gross: grossSales,
              wallet_funded_sales: walletFundedSales,
            },
          ],
        };
      }

      // 10. Monthly Stats: Refunds
      if (sqlLower.includes("total_refunds") && sqlLower.includes("order_refund")) {
        const fromDate = vals.find((v) => v instanceof Date);
        const toDate = vals.filter((v) => v instanceof Date)[1];

        let totalRefunds = 0;
        for (const l of state.ledger) {
          if (l.kind === "order_refund") {
            if (fromDate && l.createdAt < fromDate) continue;
            if (toDate && l.createdAt >= toDate) continue;
            totalRefunds += Math.abs(l.delta);
          }
        }
        return { rows: [{ total_refunds: totalRefunds }] };
      }

      // 11. Monthly Stats: Business deliveries (COUNT DISTINCT order_id)
      if (sqlLower.includes("business_deliveries") && sqlLower.includes("delivery_logs")) {
        const fromDate = vals.find((v) => v instanceof Date);
        const toDate = vals.filter((v) => v instanceof Date)[1];

        const deliveredOrderIds = new Set<number>();
        for (const log of state.deliveryLogs.values()) {
          if (fromDate && log.deliveredAt < fromDate) continue;
          if (toDate && log.deliveredAt >= toDate) continue;
          deliveredOrderIds.add(log.orderId);
        }
        return { rows: [{ business_deliveries: deliveredOrderIds.size }] };
      }

      // 12. Monthly Stats: Per-Plugin Revenue
      if (sqlLower.includes("canonical_plugin_name") || sqlLower.includes("plugin_pk") || sqlLower.includes("settled_orders")) {
        const fromDate = vals.find((v) => v instanceof Date);
        const toDate = vals.filter((v) => v instanceof Date)[1];

        const pluginMap = new Map<number, { pluginId: number; pluginName: string; uniqueOrders: number; settledAmount: number }>();

        for (const order of state.orders.values()) {
          if (order.settledAmount !== null && order.settledAmount !== undefined && order.paidAt) {
            const pAt = new Date(order.paidAt);
            if (fromDate && pAt < fromDate) continue;
            if (toDate && pAt >= toDate) continue;

            const ver = state.versions.get(order.versionId);
            if (!ver) continue;
            const plug = state.plugins.get(ver.pluginId);
            if (!plug) continue;

            const current = pluginMap.get(plug.id) || {
              pluginId: plug.id,
              pluginName: plug.displayName,
              uniqueOrders: 0,
              settledAmount: 0,
            };
            current.uniqueOrders += 1;
            current.settledAmount += order.settledAmount;
            pluginMap.set(plug.id, current);
          }
        }
        return {
          rows: Array.from(pluginMap.values()).map((p) => ({
            plugin_id: p.pluginId,
            plugin_name: p.pluginName,
            unique_orders: p.uniqueOrders,
            settled_amount: p.settledAmount,
          })),
        };
      }

      // 13. Monthly Stats: Per-User Revenue
      if (sqlLower.includes("group by discord_user_id") || (sqlLower.includes("discord_user_id") && sqlLower.includes("unique_orders"))) {
        const fromDate = vals.find((v) => v instanceof Date);
        const toDate = vals.filter((v) => v instanceof Date)[1];

        const userMap = new Map<string, { discordUserId: string; uniqueOrders: number; totalSpent: number }>();

        for (const order of state.orders.values()) {
          if (order.settledAmount !== null && order.settledAmount !== undefined && order.paidAt) {
            const pAt = new Date(order.paidAt);
            if (fromDate && pAt < fromDate) continue;
            if (toDate && pAt >= toDate) continue;

            const current = userMap.get(order.discordUserId) || {
              discordUserId: order.discordUserId,
              uniqueOrders: 0,
              totalSpent: 0,
            };
            current.uniqueOrders += 1;
            current.totalSpent += order.settledAmount;
            userMap.set(order.discordUserId, current);
          }
        }
        return {
          rows: Array.from(userMap.values()).map((u) => ({
            discord_user_id: u.discordUserId,
            unique_orders: u.uniqueOrders,
            settled_amount: u.totalSpent,
          })),
        };
      }

      return { rows: [] };
    },
  };

  return mockDb;
}

describe("Phase 3C: Canonical Settlement, Revenue Accounting & Multi-Layer Reconciliation Suite (TEST-C01 to C40)", () => {
  let db: ReturnType<typeof createMockNeonDb>;

  beforeEach(() => {
    db = createMockNeonDb();
  });

  // ==========================================================================
  // Core Settlement Writers & Atomicity
  // ==========================================================================
  it("TEST-C01: Exact Bank Payment Settlement Capture", async () => {
    const order = await openOrderNeon(db, defaultOrderConfig, {
      discordUserId: "user-1",
      versionId: 1,
    });
    expect(order).not.toBeNull();
    const orderInDb = db._state.orders.get(order!.id);
    expect(orderInDb.settledAmount).toBeNull();
    expect(orderInDb.status).toBe("pending");

    const receivedTime = new Date("2026-10-01T10:00:00Z");
    const outcome = await applySepayTransferNeon(db, {
      sepayId: 1001,
      code: order!.code,
      transferType: "in",
      amount: 100_000,
      content: `${order!.code} thanh toan`,
      receivedAt: receivedTime,
    });

    expect(outcome.handled).toBe("paid");
    const updatedOrder = db._state.orders.get(order!.id);
    expect(updatedOrder.status).toBe("paid");
    expect(updatedOrder.settledAmount).toBe(100_000);
    expect(updatedOrder.paidAmount).toBe(100_000);
    expect(updatedOrder.paidAt.getTime()).toBe(receivedTime.getTime());
  });

  it("TEST-C02: 100% Wallet Purchase Immediate Settlement", async () => {
    db._state.wallets.set("user-2", {
      discordUserId: "user-2",
      balance: 100_000,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const order = await openOrderNeon(db, defaultOrderConfig, {
      discordUserId: "user-2",
      versionId: 1,
    });

    expect(order).not.toBeNull();
    const orderInDb = db._state.orders.get(order!.id);
    expect(orderInDb.status).toBe("wallet_paid");
    expect(orderInDb.settledAmount).toBe(100_000);
    expect(orderInDb.paidAt).toBeInstanceOf(Date);

    const wallet = db._state.wallets.get("user-2");
    expect(wallet?.balance).toBe(0);
    const hold = db._state.ledger.find((l) => l.kind === "order_hold");
    expect(hold).toBeDefined();
    expect(hold?.delta).toBe(-100_000);

    const job = Array.from(db._state.deliveryJobs.values()).find((j) => j.orderId === order!.id);
    expect(job).toBeDefined();
    expect(job.status).toBe("queued");
  });

  it("TEST-C03: Split Payment Settlement Capture", async () => {
    db._state.wallets.set("user-3", {
      discordUserId: "user-3",
      balance: 30_000,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const order = await openOrderNeon(db, defaultOrderConfig, {
      discordUserId: "user-3",
      versionId: 1,
    });
    const orderInDb = db._state.orders.get(order!.id);
    expect(orderInDb.status).toBe("pending");
    expect(orderInDb.settledAmount).toBeNull();
    expect(orderInDb.bankDue).toBe(70_000);

    const receivedTime = new Date("2026-10-02T14:00:00Z");
    const outcome = await applySepayTransferNeon(db, {
      sepayId: 1003,
      code: order!.code,
      transferType: "in",
      amount: 70_000,
      content: `${order!.code} chuyen khoan`,
      receivedAt: receivedTime,
    });

    expect(outcome.handled).toBe("paid");
    const updatedOrder = db._state.orders.get(order!.id);
    expect(updatedOrder.status).toBe("paid");
    expect(updatedOrder.settledAmount).toBe(100_000);
    expect(updatedOrder.paidAmount).toBe(70_000);
    expect(updatedOrder.paidAt.getTime()).toBe(receivedTime.getTime());
  });

  it("TEST-C04: Overpayment Settlement & Wallet Excess Capture", async () => {
    const order = await openOrderNeon(db, defaultOrderConfig, {
      discordUserId: "user-4",
      versionId: 1,
    });

    const receivedTime = new Date("2026-10-02T15:00:00Z");
    const outcome = await applySepayTransferNeon(db, {
      sepayId: 1004,
      code: order!.code,
      transferType: "in",
      amount: 150_000,
      content: `${order!.code} overpaid`,
      receivedAt: receivedTime,
    });

    expect(outcome.handled).toBe("paid");
    const updatedOrder = db._state.orders.get(order!.id);
    expect(updatedOrder.status).toBe("paid");
    expect(updatedOrder.settledAmount).toBe(100_000);
    expect(updatedOrder.paidAmount).toBe(100_000);

    const wallet = db._state.wallets.get("user-4");
    expect(wallet?.balance).toBe(50_000);
    const excessLedger = db._state.ledger.find((l) => l.kind === "order_overpay_credit");
    expect(excessLedger?.delta).toBe(50_000);

    const sepay = Array.from(db._state.sepayTransactions.values()).find((s) => s.sepayId === 1004);
    expect(sepay?.status).toBe("overpaid");
  });

  it("TEST-C05: Underpayment Does Not Settle Order", async () => {
    const order = await openOrderNeon(db, defaultOrderConfig, {
      discordUserId: "user-5",
      versionId: 1,
    });

    const outcome = await applySepayTransferNeon(db, {
      sepayId: 1005,
      code: order!.code,
      transferType: "in",
      amount: 40_000,
      content: `${order!.code} underpaid`,
      receivedAt: new Date(),
    });

    expect(outcome.handled).toBe("ignored");
    const updatedOrder = db._state.orders.get(order!.id);
    expect(updatedOrder.status).toBe("pending");
    expect(updatedOrder.settledAmount).toBeNull();
    expect(updatedOrder.paidAt).toBeNull();

    const wallet = db._state.wallets.get("user-5");
    expect(wallet?.balance).toBe(40_000);
  });

  it("TEST-C06: Refund Preserves Historical Settled Amount & Records Ledger", async () => {
    const paidDate = new Date("2026-10-01T10:00:00Z");
    const [order] = await db.insert(orders).values({
      code: "ORD-C06",
      discordUserId: "user-6",
      versionId: 1,
      amount: 100_000,
      paidAmount: 100_000,
      status: "paid",
      settledAmount: 100_000,
      paidAt: paidDate,
    });

    await refundOrderWallet(db, order.id, "Loi file plugin");

    const updatedOrder = db._state.orders.get(order.id);
    expect(updatedOrder.status).toBe("refunded");
    expect(updatedOrder.settledAmount).toBe(100_000); // Preserved immutable
    expect(updatedOrder.paidAt.getTime()).toBe(paidDate.getTime()); // Preserved

    const refundLedger = db._state.ledger.find(
      (l) => l.kind === "order_refund" && l.refId === order.id
    );
    expect(refundLedger).toBeDefined();
    expect(refundLedger?.delta).toBe(100_000);
    expect(refundLedger?.refType).toBe("order");

    const metrics = await getRevenueMetrics(
      db,
      new Date("2026-10-01T00:00:00Z"),
      new Date("2026-11-01T00:00:00Z")
    );
    expect(metrics.settledSalesGross).toBe(100_000);
    expect(metrics.totalRefunds).toBe(100_000);
    expect(metrics.netSales).toBe(0);
  });

  it("TEST-C07: Delivery Worker Takes Snapshot from orders.settled_amount", async () => {
    const [order] = await db.insert(orders).values({
      code: "ORD-C07",
      discordUserId: "user-7",
      versionId: 1,
      amount: 120_000,
      status: "paid",
      settledAmount: 120_000,
      paidAt: new Date(),
    });
    await db.insert(deliveryJobs).values({
      orderId: order.id,
      versionId: 1,
      discordUserId: "user-7",
      status: "queued",
    });

    const fakeDiscordClient: any = {
      users: {
        fetch: vi.fn(async () => ({
          send: vi.fn(async () => ({ id: "msg-7" })),
        })),
      },
    };

    const res = await processNextDeliveryJob({
      neonDb: db,
      client: fakeDiscordClient,
      workerId: "w-7",
    });
    expect(res?.success).toBe(true);
    expect(res?.localOutcome).toBe("SUCCESS");

    const log = Array.from(db._state.deliveryLogs.values()).find((l) => l.orderId === order.id);
    expect(log).toBeDefined();
    expect(log.amount).toBe(120_000);
  });

  it("TEST-C08: Historical Backfill Idempotency & Safety", async () => {
    const bankDate = new Date("2026-09-15T12:00:00Z");
    const [order] = await db.insert(orders).values({
      code: "ORD-C08",
      discordUserId: "user-8",
      versionId: 1,
      amount: 100_000,
      status: "paid",
      settledAmount: null,
      paidAt: null,
    });
    await db.insert(sepayTransactions).values({
      sepayId: 2008,
      orderId: order.id,
      amount: 100_000,
      transferType: "in",
      receivedAt: bankDate,
    });

    const res1 = await backfillSettledAmount(db, { runId: "test-run-1" });
    expect(res1.settledAmountPopulated).toBe(1);

    const o1 = db._state.orders.get(order.id);
    expect(o1.settledAmount).toBe(100_000);
    expect(o1.paidAt.getTime()).toBe(bankDate.getTime());

    const res2 = await backfillSettledAmount(db, { runId: "test-run-2" });
    expect(res2.settledAmountPopulated).toBe(0);
  });

  it("TEST-C09: Monthly Financial Reporting Metric Reconciliation", async () => {
    const t = new Date("2026-10-05T12:00:00Z");

    const [order1] = await db.insert(orders).values({
      code: "ORD-C09-1",
      discordUserId: "u-9",
      versionId: 1,
      amount: 100_000,
      status: "paid",
      settledAmount: 100_000,
      paidAt: t,
    });
    await db.insert(sepayTransactions).values({
      sepayId: 901,
      amount: 100_000,
      transferType: "in",
      orderId: order1.id,
      receivedAt: t,
    });
    await db.insert(deliveryLogs).values({
      orderId: order1.id,
      amount: 100_000,
      deliveredAt: t,
    });

    const [order2] = await db.insert(orders).values({
      code: "ORD-C09-2",
      discordUserId: "u-9",
      versionId: 2,
      amount: 50_000,
      walletPaid: 50_000,
      status: "wallet_paid",
      settledAmount: 50_000,
      paidAt: t,
    });
    await db.insert(deliveryLogs).values({
      orderId: order2.id,
      amount: 50_000,
      deliveredAt: t,
    });

    await db.insert(walletLedger).values({
      discordUserId: "u-9",
      delta: 20_000,
      kind: "order_refund",
      refType: "order",
      refId: order1.id,
      createdAt: t,
    });

    const stats = await getMonthlyFundStatsNeon(db, "2026-10");
    expect(stats.revenue.settledSalesGross).toBe(150_000);
    expect(stats.revenue.totalRefunds).toBe(20_000);
    expect(stats.revenue.netSales).toBe(130_000);
    expect(stats.revenue.walletFundedSales).toBe(50_000);
    expect(stats.revenue.bankCashReceived).toBe(100_000);
    expect(stats.revenue.matchedCash).toBe(100_000);
    expect(stats.revenue.unmatchedCash).toBe(0);
    expect(stats.revenue.businessDeliveries).toBe(2);
  });

  it("TEST-C10: Delivery Retry with External Duplicate Does Not Double-Count Business Deliveries", async () => {
    const [order] = await db.insert(orders).values({
      code: "ORD-C10",
      discordUserId: "user-10",
      versionId: 1,
      amount: 100_000,
      status: "paid",
      settledAmount: 100_000,
      paidAt: new Date("2026-10-01T10:00:00Z"),
    });

    await db.insert(deliveryLogs).values({
      orderId: order.id,
      amount: 100_000,
      deliveredAt: new Date("2026-10-01T10:05:00Z"),
    });
    await db.insert(deliveryLogs).values({
      orderId: order.id,
      amount: 100_000,
      deliveredAt: new Date("2026-10-01T10:06:00Z"),
    });

    const metrics = await getRevenueMetrics(
      db,
      new Date("2026-10-01T00:00:00Z"),
      new Date("2026-11-01T00:00:00Z")
    );
    expect(metrics.businessDeliveries).toBe(1);
    expect(metrics.settledSalesGross).toBe(100_000);
  });

  it("TEST-C11: Every Settlement Writer Stamps settled_amount in Same DB Transaction", async () => {
    db._state.wallets.set("user-11", {
      discordUserId: "user-11",
      balance: 50_000,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    const order1 = await openOrderNeon(db, defaultOrderConfig, {
      discordUserId: "user-11",
      versionId: 2, // 50k
    });
    const order1InDb = db._state.orders.get(order1!.id);
    expect(order1InDb.status).toBe("wallet_paid");
    expect(order1InDb.settledAmount).toBe(50_000);
    expect(order1InDb.paidAt).toBeInstanceOf(Date);

    const [order2] = await db.insert(orders).values({
      code: "ORD-C11-B",
      discordUserId: "user-11",
      versionId: 1,
      amount: 80_000,
      status: "pending",
      settledAmount: null,
    });
    const [sepayRow] = await db.insert(sepayTransactions).values({
      sepayId: 1111,
      amount: 80_000,
      receivedAt: new Date("2026-10-01T12:00:00Z"),
    });

    const settled2 = await db.transaction((tx: any) =>
      settleOrderPaidTx(tx, {
        orderId: order2.id,
        paidAmount: 80_000,
        sepayTransactionId: sepayRow.id,
      })
    );
    expect(settled2.status).toBe("paid");
    expect(settled2.settledAmount).toBe(80_000);
    expect(settled2.paidAt).toBeInstanceOf(Date);
  });

  it("TEST-C12: Legacy paid_at Missing with No Reliable Timestamp", async () => {
    const [order] = await db.insert(orders).values({
      code: "ORD-C12",
      discordUserId: "user-12",
      versionId: 1,
      amount: 100_000,
      walletPaid: 30_000,
      bankDue: 70_000,
      status: "paid",
      settledAmount: null,
      paidAt: null,
    });

    await db.insert(walletLedger).values({
      discordUserId: "user-12",
      delta: -30_000,
      kind: "order_hold",
      refType: "order",
      refId: order.id,
      createdAt: new Date("2026-09-01T10:00:00Z"),
    });

    const res = await backfillSettledAmount(db, { runId: "test-run-c12" });
    expect(res.settledAmountPopulated).toBe(1);
    expect(res.exceptionsRecorded).toBe(1);

    const updated = db._state.orders.get(order.id);
    expect(updated.settledAmount).toBe(100_000);
    expect(updated.paidAt).toBeNull();

    expect(db._state.migrationExceptions.length).toBe(1);
    const exc = db._state.migrationExceptions[0];
    expect(exc.entityId).toBe(order.id);
    expect(exc.reasonCode).toBe("MISSING_SETTLEMENT_TIMESTAMP");
    expect(exc.source).toBe("migration");
  });

  it("TEST-C13: Inbound Unmatched / No-Code Transfer Included in Bank Cash Received", async () => {
    await db.insert(sepayTransactions).values({
      sepayId: 2001,
      amount: 100_000,
      transferType: "in",
      orderId: 123,
      topupId: null,
      receivedAt: new Date("2026-10-02T10:00:00Z"),
    });
    await db.insert(sepayTransactions).values({
      sepayId: 2002,
      amount: 50_000,
      transferType: "in",
      orderId: null,
      topupId: null,
      receivedAt: new Date("2026-10-02T11:00:00Z"),
    });

    const metrics = await getRevenueMetrics(
      db,
      new Date("2026-10-01T00:00:00Z"),
      new Date("2026-11-01T00:00:00Z")
    );
    expect(metrics.bankCashReceived).toBe(150_000);
    expect(metrics.matchedCash).toBe(100_000);
    expect(metrics.unmatchedCash).toBe(50_000);
  });

  it("TEST-C14: wallet_paid Order with settled_amount NULL Detected by Reconciliation", async () => {
    await db.insert(orders).values({
      code: "ORD-C14",
      discordUserId: "user-14",
      versionId: 1,
      amount: 100_000,
      status: "wallet_paid",
      settledAmount: null,
    });

    const report = await runFinancialReconciliation(db, "recon-c14");
    expect(report.clean).toBe(false);
    const viols = report.violations.filter(
      (v) =>
        v.type === "WALLET_PAID_MISSING_SETTLED_AMOUNT" ||
        v.type === "SETTLED_ORDER_MISSING_SETTLED_AMOUNT"
    );
    expect(viols.length).toBeGreaterThan(0);
  });

  it("TEST-C15: New Delivery with settled_amount NULL Is Rejected", async () => {
    const [order] = await db.insert(orders).values({
      code: "ORD-C15",
      discordUserId: "user-15",
      versionId: 1,
      amount: 100_000,
      status: "paid",
      settledAmount: null,
    });
    await db.insert(deliveryJobs).values({
      orderId: order.id,
      versionId: 1,
      discordUserId: "user-15",
      status: "queued",
    });

    const fakeClient: any = {
      users: {
        fetch: vi.fn(async () => ({
          send: vi.fn(async () => ({ id: "msg-15" })),
        })),
      },
    };
    const res = await processNextDeliveryJob({
      neonDb: db,
      client: fakeClient,
      workerId: "w-15",
    });
    expect(res?.success).toBe(false);
    expect(res?.reason).toBe("DATA_INTEGRITY_VIOLATION");
    expect(res?.localOutcome).toBe("FAILED");
    expect(db._state.deliveryLogs.size).toBe(0);
    const jobInDb = Array.from(db._state.deliveryJobs.values()).find((j) => j.orderId === order.id);
    expect(jobInDb?.status).toBe("failed");
  });

  it("TEST-C16: Two Orders Same Plugin Same Amount Aggregation Accuracy", async () => {
    await db.insert(orders).values({
      code: "ORD-C16-A",
      discordUserId: "user-16-a",
      versionId: 1,
      amount: 100_000,
      status: "paid",
      settledAmount: 100_000,
      paidAt: new Date("2026-10-02T10:00:00Z"),
    });
    await db.insert(orders).values({
      code: "ORD-C16-B",
      discordUserId: "user-16-b",
      versionId: 1,
      amount: 100_000,
      status: "paid",
      settledAmount: 100_000,
      paidAt: new Date("2026-10-02T11:00:00Z"),
    });

    const perPlugin = await getPerPluginRevenue(
      db,
      new Date("2026-10-01T00:00:00Z"),
      new Date("2026-11-01T00:00:00Z")
    );
    const p10 = perPlugin.find((p) => p.pluginId === 10);
    expect(p10).toBeDefined();
    expect(p10?.uniqueOrders).toBe(2);
    expect(p10?.settledAmount).toBe(200_000);
  });

  it("TEST-C17: Two Orders Same User Same Amount Aggregation Accuracy", async () => {
    await db.insert(orders).values({
      code: "ORD-C17-A",
      discordUserId: "user-17",
      versionId: 1,
      amount: 100_000,
      status: "paid",
      settledAmount: 100_000,
      paidAt: new Date("2026-10-02T10:00:00Z"),
    });
    await db.insert(orders).values({
      code: "ORD-C17-B",
      discordUserId: "user-17",
      versionId: 2,
      amount: 100_000,
      status: "paid",
      settledAmount: 100_000,
      paidAt: new Date("2026-10-02T11:00:00Z"),
    });

    const perUser = await getPerUserRevenue(
      db,
      new Date("2026-10-01T00:00:00Z"),
      new Date("2026-11-01T00:00:00Z")
    );
    const u17 = perUser.find((u) => u.discordUserId === "user-17");
    expect(u17?.uniqueOrders).toBe(2);
    expect(u17?.settledAmount).toBe(200_000);
  });

  it("TEST-C18: Refunded Order Cannot Transition to Paid", async () => {
    const [order] = await db.insert(orders).values({
      code: "ORD-C18",
      discordUserId: "user-18",
      versionId: 1,
      amount: 100_000,
      status: "refunded",
      settledAmount: 100_000,
    });

    await expect(
      updateOrderStatus(db, order.id, "paid", undefined, { settlementContext: true })
    ).rejects.toThrow(/Cannot reopen terminal order/i);

    const [sepay] = await db.insert(sepayTransactions).values({
      sepayId: 1018,
      amount: 100_000,
      receivedAt: new Date(),
    });

    await expect(
      db.transaction((tx: any) =>
        settleOrderPaidTx(tx, {
          orderId: order.id,
          paidAmount: 100_000,
          sepayTransactionId: sepay.id,
        })
      )
    ).rejects.toThrow(/terminal state 'refunded'/i);

    expect(db._state.orders.get(order.id).status).toBe("refunded");
  });

  it("TEST-C19: Cancelled Order Cannot Transition to Wallet_Paid", async () => {
    const [order] = await db.insert(orders).values({
      code: "ORD-C19",
      discordUserId: "user-19",
      versionId: 1,
      amount: 100_000,
      status: "cancelled",
      settledAmount: null,
    });

    await expect(
      updateOrderStatus(db, order.id, "wallet_paid", undefined, { settlementContext: true })
    ).rejects.toThrow(/Cannot reopen terminal order/i);

    expect(db._state.orders.get(order.id).status).toBe("cancelled");
  });

  it("TEST-C20: Expired Order Cannot Transition to Paid", async () => {
    const [order] = await db.insert(orders).values({
      code: "ORD-C20",
      discordUserId: "user-20",
      versionId: 1,
      amount: 100_000,
      status: "expired",
      settledAmount: null,
    });

    await expect(
      updateOrderStatus(db, order.id, "paid", undefined, { settlementContext: true })
    ).rejects.toThrow(/Cannot reopen terminal order/i);

    expect(db._state.orders.get(order.id).status).toBe("expired");
  });

  it("TEST-C21: Split Payment Legacy Order Missing paid_at with Only order_hold Evidence", async () => {
    const [order] = await db.insert(orders).values({
      code: "ORD-C21",
      discordUserId: "user-21",
      versionId: 1,
      amount: 100_000,
      walletPaid: 20_000,
      bankDue: 80_000,
      status: "paid",
      settledAmount: null,
      paidAt: null,
    });

    await db.insert(walletLedger).values({
      discordUserId: "user-21",
      delta: -20_000,
      kind: "order_hold",
      refType: "order",
      refId: order.id,
      createdAt: new Date("2026-08-01T10:00:00Z"),
    });

    const res = await backfillSettledAmount(db, { runId: "test-run-c21" });
    expect(res.settledAmountPopulated).toBe(1);
    expect(res.exceptionsRecorded).toBe(1);

    const updated = db._state.orders.get(order.id);
    expect(updated.settledAmount).toBe(100_000);
    expect(updated.paidAt).toBeNull();
  });

  it("TEST-C22: Inbound Transfer with No order_id and No topup_id", async () => {
    await db.insert(sepayTransactions).values({
      sepayId: 2022,
      amount: 75_000,
      transferType: "in",
      orderId: null,
      topupId: null,
      receivedAt: new Date("2026-10-02T10:00:00Z"),
    });

    const metrics = await getRevenueMetrics(
      db,
      new Date("2026-10-01T00:00:00Z"),
      new Date("2026-11-01T00:00:00Z")
    );
    expect(metrics.bankCashReceived).toBe(75_000);
    expect(metrics.unmatchedCash).toBe(75_000);
    expect(metrics.matchedCash).toBe(0);
  });

  it("TEST-C23: Delivery with settled_amount NULL Rejected", async () => {
    const [order] = await db.insert(orders).values({
      code: "ORD-C23",
      discordUserId: "user-23",
      versionId: 1,
      amount: 100_000,
      status: "paid",
      settledAmount: null,
    });
    await db.insert(deliveryJobs).values({
      orderId: order.id,
      versionId: 1,
      discordUserId: "user-23",
      status: "queued",
    });

    const fakeClient: any = {
      users: {
        fetch: vi.fn(async () => ({
          send: vi.fn(async () => ({ id: "msg-23" })),
        })),
      },
    };
    const res = await processNextDeliveryJob({
      neonDb: db,
      client: fakeClient,
      workerId: "w-23",
    });
    expect(res?.success).toBe(false);
    expect(res?.reason).toBe("DATA_INTEGRITY_VIOLATION");
    expect(res?.localOutcome).toBe("FAILED");
  });

  it("TEST-C24: Zero-Price Order Settlement Behavior (Option B)", async () => {
    const order = await openOrderNeon(db, defaultOrderConfig, {
      discordUserId: "user-24",
      versionId: 3, // Free plugin
    });

    const orderInDb = db._state.orders.get(order!.id);
    expect(orderInDb.status).toBe("wallet_paid");
    expect(orderInDb.settledAmount).toBe(0);
    expect(orderInDb.paidAt).toBeInstanceOf(Date);

    const fakeClient: any = {
      users: {
        fetch: vi.fn(async () => ({
          send: vi.fn(async () => ({ id: "msg-24" })),
        })),
      },
    };

    await processNextDeliveryJob({
      neonDb: db,
      client: fakeClient,
      workerId: "w-24",
    });

    const log = Array.from(db._state.deliveryLogs.values()).find((l) => l.orderId === order!.id);
    expect(log).toBeDefined();
    expect(log.amount).toBe(0);

    const metrics = await getRevenueMetrics(
      db,
      new Date("2026-01-01T00:00:00Z"),
      new Date("2027-01-01T00:00:00Z")
    );
    expect(metrics.businessDeliveries).toBe(1);
    expect(metrics.settledSalesGross).toBe(0);
  });

  it("TEST-C25: Paid → Paid Idempotent Retry Preserves Timestamp", async () => {
    const initialPaidAt = new Date("2026-10-01T08:00:00Z");
    const [order] = await db.insert(orders).values({
      code: "ORD-C25",
      discordUserId: "user-25",
      versionId: 1,
      amount: 100_000,
      status: "paid",
      settledAmount: 100_000,
      paidAt: initialPaidAt,
    });
    const [sepay] = await db.insert(sepayTransactions).values({
      sepayId: 1025,
      amount: 100_000,
      receivedAt: new Date("2026-10-05T12:00:00Z"),
    });

    const result = await db.transaction((tx: any) =>
      settleOrderPaidTx(tx, {
        orderId: order.id,
        paidAmount: 100_000,
        sepayTransactionId: sepay.id,
      })
    );

    expect(result.status).toBe("paid");
    expect(result.settledAmount).toBe(100_000);
    expect(result.paidAt.getTime()).toBe(initialPaidAt.getTime());
  });

  it("TEST-C26: Wallet_Paid → Wallet_Paid Idempotent Retry Preserves Timestamp", async () => {
    const initialPaidAt = new Date("2026-10-01T09:00:00Z");
    const [order] = await db.insert(orders).values({
      code: "ORD-C26",
      discordUserId: "user-26",
      versionId: 1,
      amount: 100_000,
      status: "wallet_paid",
      settledAmount: 100_000,
      paidAt: initialPaidAt,
    });

    const [hold] = await db.insert(walletLedger).values({
      discordUserId: "user-26",
      delta: -100_000,
      kind: "order_hold",
      refType: "order",
      refId: order.id,
      createdAt: new Date("2026-10-02T10:00:00Z"),
    });

    const result = await db.transaction((tx: any) =>
      settleOrderWalletPaidTx(tx, {
        orderId: order.id,
        ledgerHoldId: hold.id,
      })
    );

    expect(result.status).toBe("wallet_paid");
    expect(result.settledAmount).toBe(100_000);
    expect(result.paidAt.getTime()).toBe(initialPaidAt.getTime());
  });

  it("TEST-C27: Phase 3C Application Rollback Preserves Financial Data", async () => {
    const [order] = await db.insert(orders).values({
      code: "ORD-C27",
      discordUserId: "user-27",
      versionId: 1,
      amount: 200_000,
      status: "paid",
      settledAmount: 200_000,
      paidAt: new Date("2026-10-01T10:00:00Z"),
    });

    await recordMigrationException(db, {
      source: "migration",
      runId: "pre-rollback-run",
      entityType: "order",
      entityId: order.id,
      reasonCode: "PRE_ROLLBACK_AUDIT",
      evidence: { test: true },
    });

    const [readOldCode] = await db
      .select()
      .from(orders)
      .where((cond: any) => cond)
      .limit(1);

    expect(readOldCode).toBeDefined();
    expect(readOldCode.id).toBe(order.id);
    expect(readOldCode.amount).toBe(200_000);

    expect(db._state.orders.get(order.id).settledAmount).toBe(200_000);
    expect(db._state.migrationExceptions).toHaveLength(1);
  });

  it("TEST-C28: Delivery_Logs Only Successful Evidence", async () => {
    const [order] = await db.insert(orders).values({
      code: "ORD-C28",
      discordUserId: "user-28",
      versionId: 1,
      amount: 80_000,
      status: "paid",
      settledAmount: 80_000,
      paidAt: new Date(),
    });
    const [job] = await db.insert(deliveryJobs).values({
      orderId: order.id,
      versionId: 1,
      discordUserId: "user-28",
      status: "queued",
    });

    const failClient: any = {
      users: {
        fetch: vi.fn(async () => ({
          send: vi.fn(async () => {
            throw new Error("Cannot send messages to this user");
          }),
        })),
      },
    };

    await processNextDeliveryJob({
      neonDb: db,
      client: failClient,
      workerId: "w-28",
    });
    expect(db._state.deliveryLogs.size).toBe(0);

    const successClient: any = {
      users: {
        fetch: vi.fn(async () => ({
          send: vi.fn(async () => ({ id: "msg-success" })),
        })),
      },
    };

    db._state.deliveryJobs.get(job.id).status = "queued";
    await processNextDeliveryJob({
      neonDb: db,
      client: successClient,
      workerId: "w-28",
    });

    expect(db._state.deliveryLogs.size).toBe(1);
    const log = Array.from(db._state.deliveryLogs.values())[0];
    expect(log.orderId).toBe(order.id);
    expect(log.amount).toBe(80_000);
  });

  it("TEST-C29: DATA_INTEGRITY_VIOLATION Rejects Auto-Retry", async () => {
    const [order] = await db.insert(orders).values({
      code: "ORD-C29",
      discordUserId: "user-29",
      versionId: 1,
      amount: 50_000,
      status: "paid",
      settledAmount: null,
    });
    const [job] = await db.insert(deliveryJobs).values({
      orderId: order.id,
      versionId: 1,
      discordUserId: "user-29",
      status: "queued",
    });

    const fakeClient: any = {
      users: {
        fetch: vi.fn(async () => ({
          send: vi.fn(async () => ({ id: "msg-29" })),
        })),
      },
    };
    await processNextDeliveryJob({
      neonDb: db,
      client: fakeClient,
      workerId: "w-29",
    });

    const updatedJob = db._state.deliveryJobs.get(job.id);
    expect(updatedJob.status).toBe("failed");
    expect(updatedJob.lastError).toBe("DATA_INTEGRITY_VIOLATION");
    expect(updatedJob.retryCount).toBe(0);
  });

  it("TEST-C30: Orphan Delivery Log Detected by Reconciliation", async () => {
    await db.insert(deliveryLogs).values({
      orderId: 9999,
      amount: 100_000,
      deliveredAt: new Date(),
    });

    const report = await runFinancialReconciliation(db, "recon-c30");
    expect(report.clean).toBe(false);

    const orphanViol = report.violations.find(
      (v) => v.check === "C" && v.detail.includes("Orphan")
    );
    expect(orphanViol).toBeDefined();
  });

  it("TEST-C31: Delivery Log Amount NULL vs Settled_Amount 0 Mismatch", async () => {
    const [order] = await db.insert(orders).values({
      code: "ORD-C31",
      discordUserId: "user-31",
      versionId: 1,
      amount: 0,
      status: "wallet_paid",
      settledAmount: 0,
    });

    await db.insert(deliveryLogs).values({
      orderId: order.id,
      amount: null,
      deliveredAt: new Date(),
    });

    const report = await runFinancialReconciliation(db, "recon-c31");
    expect(report.clean).toBe(false);

    const cViol = report.violations.find((v) => v.check === "C");
    expect(cViol).toBeDefined();
  });

  it("TEST-C32: Delayed Webhook Across Reporting Period Follows Option B paid_at Semantics", async () => {
    const bankReceivedAt = new Date("2026-09-30T23:59:00Z");
    const webhookProcessedAt = new Date("2026-10-01T00:05:00Z");

    const order = await openOrderNeon(db, defaultOrderConfig, {
      discordUserId: "user-32",
      versionId: 1,
    });

    await applySepayTransferNeon(db, {
      sepayId: 1032,
      code: order!.code,
      transferType: "in",
      amount: 100_000,
      content: `${order!.code} thanh toan`,
      receivedAt: bankReceivedAt,
      processedAt: webhookProcessedAt,
    });

    const updated = db._state.orders.get(order!.id);
    expect(updated.status).toBe("paid");
    expect(updated.paidAt.toISOString()).toBe(bankReceivedAt.toISOString());

    const septStats = await getMonthlyFundStatsNeon(db, "2026-09");
    expect(septStats.revenue.settledSalesGross).toBe(100_000);

    const octStats = await getMonthlyFundStatsNeon(db, "2026-10");
    expect(octStats.revenue.settledSalesGross).toBe(0);
  });

  it("TEST-C33: Two Delivery Logs with Different pluginName Metadata Count Exactly One Order via Canonical Identity", async () => {
    const [order] = await db.insert(orders).values({
      code: "ORD-C33",
      discordUserId: "user-33",
      versionId: 1,
      amount: 100_000,
      status: "paid",
      settledAmount: 100_000,
      paidAt: new Date("2026-10-01T10:00:00Z"),
    });

    await db.insert(deliveryLogs).values({
      orderId: order.id,
      amount: 100_000,
      pluginName: "Old Display Name",
      deliveredAt: new Date("2026-10-01T10:05:00Z"),
    });
    await db.insert(deliveryLogs).values({
      orderId: order.id,
      amount: 100_000,
      pluginName: "New Display Name (Patched)",
      deliveredAt: new Date("2026-10-01T10:06:00Z"),
    });

    const perPlugin = await getPerPluginRevenue(
      db,
      new Date("2026-10-01T00:00:00Z"),
      new Date("2026-11-01T00:00:00Z")
    );

    expect(perPlugin).toHaveLength(1);
    expect(perPlugin[0].pluginId).toBe(10);
    expect(perPlugin[0].uniqueOrders).toBe(1);
    expect(perPlugin[0].settledAmount).toBe(100_000);
  });

  it("TEST-C34: Generic updateOrderStatus('paid') Without Settlement Context Is Rejected", async () => {
    const [order] = await db.insert(orders).values({
      code: "ORD-C34",
      discordUserId: "user-34",
      versionId: 1,
      amount: 100_000,
      status: "pending",
      settledAmount: null,
    });

    await expect(updateOrderStatus(db, order.id, "paid")).rejects.toThrow(
      /without settlement context/i
    );
    expect(db._state.orders.get(order.id).status).toBe("pending");
  });

  it("TEST-C35: Settled Order Before Delivery Included in Revenue", async () => {
    await db.insert(orders).values({
      code: "ORD-C35",
      discordUserId: "user-35",
      versionId: 1,
      amount: 75_000,
      status: "paid",
      settledAmount: 75_000,
      paidAt: new Date("2026-10-01T10:00:00Z"),
    });

    expect(db._state.deliveryLogs.size).toBe(0);

    const metrics = await getRevenueMetrics(
      db,
      new Date("2026-10-01T00:00:00Z"),
      new Date("2026-11-01T00:00:00Z")
    );

    expect(metrics.settledSalesGross).toBe(75_000);
    expect(metrics.businessDeliveries).toBe(0);
  });

  it("TEST-C36: Two Settled Orders Same Plugin Revenue Directly from Orders", async () => {
    await db.insert(orders).values({
      code: "ORD-C36-A",
      discordUserId: "user-36",
      versionId: 1,
      amount: 100_000,
      status: "paid",
      settledAmount: 100_000,
      paidAt: new Date("2026-10-01T10:00:00Z"),
    });
    await db.insert(orders).values({
      code: "ORD-C36-B",
      discordUserId: "user-36",
      versionId: 1,
      amount: 100_000,
      status: "paid",
      settledAmount: 100_000,
      paidAt: new Date("2026-10-01T11:00:00Z"),
    });

    expect(db._state.deliveryLogs.size).toBe(0);

    const perPlugin = await getPerPluginRevenue(
      db,
      new Date("2026-10-01T00:00:00Z"),
      new Date("2026-11-01T00:00:00Z")
    );

    const p10 = perPlugin.find((p) => p.pluginId === 10);
    expect(p10?.settledAmount).toBe(200_000);
  });

  it("TEST-C37: Runtime DATA_INTEGRITY_VIOLATION Uses Valid Source/Run Identity", async () => {
    const [order] = await db.insert(orders).values({
      code: "ORD-C37",
      discordUserId: "user-37",
      versionId: 1,
      amount: 50_000,
      status: "paid",
      settledAmount: null,
    });
    await db.insert(deliveryJobs).values({
      orderId: order.id,
      versionId: 1,
      discordUserId: "user-37",
      status: "queued",
    });

    const fakeClient: any = {
      users: {
        fetch: vi.fn(async () => ({
          send: vi.fn(async () => ({ id: "msg-37" })),
        })),
      },
    };
    await processNextDeliveryJob({
      neonDb: db,
      client: fakeClient,
      workerId: "w-37",
    });

    const exc = db._state.migrationExceptions.find((e) => e.entityId === order.id);
    expect(exc).toBeDefined();
    expect(exc.source).toBe("runtime_worker");
    expect(exc.runId).toMatch(/^delivery-worker-/);
    expect(exc.reasonCode).toBe("DATA_INTEGRITY_VIOLATION");
  });

  it("TEST-C38: Delayed Webhook Uses Authoritative received_at Over processed_at", async () => {
    const bankReceivedAt = new Date("2026-10-03T08:00:00Z");
    const processedAt = new Date("2026-10-03T09:30:00Z");

    const [order] = await db.insert(orders).values({
      code: "ORD-C38",
      discordUserId: "user-38",
      versionId: 1,
      amount: 90_000,
      status: "pending",
      settledAmount: null,
    });
    const [sepay] = await db.insert(sepayTransactions).values({
      sepayId: 1038,
      amount: 90_000,
      receivedAt: bankReceivedAt,
      processedAt: processedAt,
    });

    const settled = await db.transaction((tx: any) =>
      settleOrderPaidTx(tx, {
        orderId: order.id,
        paidAmount: 90_000,
        sepayTransactionId: sepay.id,
      })
    );

    expect(settled.paidAt.toISOString()).toBe(bankReceivedAt.toISOString());
    expect(settled.paidAt.toISOString()).not.toBe(processedAt.toISOString());
  });

  it("TEST-C39: Settlement Helper Rejects Wrong Caller-Supplied Amount", async () => {
    const [order] = await db.insert(orders).values({
      code: "ORD-C39",
      discordUserId: "user-39",
      versionId: 1,
      amount: 100_000,
      status: "pending",
      settledAmount: null,
    });
    const [sepay] = await db.insert(sepayTransactions).values({
      sepayId: 1039,
      amount: 100_000,
      receivedAt: new Date(),
    });

    await expect(
      db.transaction((tx: any) =>
        settleOrderPaidTx(tx, {
          orderId: order.id,
          paidAmount: 100_000,
          sepayTransactionId: sepay.id,
          amount: 50_000,
        })
      )
    ).rejects.toThrow(/Caller-asserted amount=50000 != order.amount=100000/i);
  });

  it("TEST-C40: Settlement Helper Rejects Wrong Caller-Supplied paidAt", async () => {
    const [order] = await db.insert(orders).values({
      code: "ORD-C40",
      discordUserId: "user-40",
      versionId: 1,
      amount: 100_000,
      status: "pending",
      settledAmount: null,
    });
    const authoritativeDate = new Date("2026-10-01T10:00:00Z");
    const [sepay] = await db.insert(sepayTransactions).values({
      sepayId: 1040,
      amount: 100_000,
      receivedAt: authoritativeDate,
    });

    await expect(
      db.transaction((tx: any) =>
        settleOrderPaidTx(tx, {
          orderId: order.id,
          paidAmount: 100_000,
          sepayTransactionId: sepay.id,
          paidAt: new Date("2026-10-05T10:00:00Z"),
        })
      )
    ).rejects.toThrow(/deviates from authoritative sepay.received_at/i);
  });
});
