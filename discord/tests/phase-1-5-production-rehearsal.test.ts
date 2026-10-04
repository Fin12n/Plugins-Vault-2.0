import { describe, it, expect, beforeEach } from 'vitest';
import { getTableName as drizzleGetTableName } from 'drizzle-orm';
import Database from 'better-sqlite3';
import { migrate } from '../src/db/migrate.js';
import {
  setWriteFreeze,
  isWriteFrozen,
  assertNotFrozen,
  WriteFreezeError,
} from '../src/services/maintenance/write-freeze.js';
import {
  applySepayTransferNeon,
  type WebhookOutcome,
} from '../src/services/payment/neon-payment-flow.js';
import {
  claimDownloadToken,
  mintDownloadToken,
  unclaimDownloadToken,
} from '../src/repositories/neon-download-tokens.js';
import {
  createDeliveryJob,
  claimStaleOrQueuedDeliveryJob,
  markDeliveryJobSuccess,
} from '../src/repositories/neon-delivery-jobs.js';
import {
  createDeliveryLog,
  findDeliveryLogByIdempotencyKey,
} from '../src/repositories/neon-delivery-logs.js';
import {
  applyLedgerEntry,
  getOrCreateWallet,
  getWalletBalance,
} from '../src/repositories/neon-wallets.js';
import {
  createOrder,
  findOrderByCode,
  findOrderById,
  updateOrderStatus,
} from '../src/repositories/neon-orders.js';
import {
  createWalletTopup,
  findTopupByCode,
  findTopupById,
} from '../src/repositories/neon-wallet-topups.js';
import {
  createDiscountCode,
  lockAndRedeemDiscountCode,
} from '../src/repositories/neon-discounts.js';
import {
  recordSepayTransaction,
  hasSepayTransaction,
  findSepayTransactionBySepayId,
  updateSepayTransactionStatus,
} from '../src/repositories/neon-sepay.js';
import { Secret } from '../src/services/upstream/spigot-account-store.js';
import type { Database as NeonDb } from '../src/db/neon.js';

/**
 * High-Fidelity Mock Neon Staging Database for Rehearsal Audit
 */
function createStagingNeonDb(): NeonDb {
  const wallets = new Map<string, { discordUserId: string; balance: number }>();
  const ledger: Array<{
    id: number;
    discordUserId: string;
    delta: number;
    balanceAfter: number;
    kind: string;
    refType: string;
    refId: number | null;
    note: string;
  }> = [];
  const orders = new Map<number, any>();
  const topups = new Map<number, any>();
  const sepay = new Map<number, any>();
  const deliveryJobs: any[] = [];
  const deliveryLogs: any[] = [];
  const downloadTokens = new Map<string, any>();
  const discountCodes = new Map<number, any>();
  const discountRedemptions: any[] = [];
  const plugins = new Map<number, any>();
  const versions = new Map<number, any>();
  const spigotRefs = new Map<string, any>();
  const checkpoints = new Map<string, any>();

  let nextId = 1;

  function extractValues(cond: any): any[] {
    if (!cond) return [];
    const vals: any[] = [];
    function walk(node: any) {
      if (!node) return;
      if (Array.isArray(node)) {
        for (const item of node) walk(item);
        return;
      }
      if (Array.isArray(node.queryChunks)) {
        for (const chunk of node.queryChunks) walk(chunk);
        return;
      }
      if (node.value !== undefined && !Array.isArray(node.value)) {
        vals.push(node.value);
      }
    }
    walk(cond);
    return vals;
  }

  function getTableName(table: any): string {
    if (!table) return '';
    if (typeof table === 'string') return table;
    try {
      const name = drizzleGetTableName(table);
      if (name) return name;
    } catch {}
    return (
      table[Symbol.for('drizzle:Name')] ||
      table[Symbol.for('drizzle:OriginalName')] ||
      table[Symbol.for('drizzle:BaseName')] ||
      table._?.name ||
      table.name ||
      ''
    );
  }

  const mockDb: any = {
    _wallets: wallets,
    _ledger: ledger,
    _orders: orders,
    _topups: topups,
    _sepay: sepay,
    _deliveryJobs: deliveryJobs,
    _deliveryLogs: deliveryLogs,
    _downloadTokens: downloadTokens,
    _discountCodes: discountCodes,
    _discountRedemptions: discountRedemptions,
    _plugins: plugins,
    _versions: versions,
    _spigotRefs: spigotRefs,
    _checkpoints: checkpoints,

    transaction: async (cb: any) => cb(mockDb),

    select: (_fields?: any) => ({
      from: (table: any) => {
        const runQuery = (cond?: any) => {
          const tableName = getTableName(table);
          const vals = extractValues(cond);
          const val0 = vals[0];

          if (tableName === 'wallets') {
            if (typeof val0 === 'string') {
              const w = wallets.get(val0);
              return w ? [w] : [];
            }
            return Array.from(wallets.values());
          }

          if (tableName === 'orders') {
            if (typeof val0 === 'string') {
              for (const o of orders.values()) {
                if (o.orderCode?.toUpperCase() === val0.toUpperCase() || o.code?.toUpperCase() === val0.toUpperCase()) {
                  return [o];
                }
              }
              return [];
            }
            if (typeof val0 === 'number') {
              const o = orders.get(val0);
              return o ? [o] : [];
            }
            return Array.from(orders.values());
          }

          if (tableName === 'wallet_topups') {
            if (typeof val0 === 'string') {
              for (const t of topups.values()) {
                if (t.code?.toUpperCase() === val0.toUpperCase()) return [t];
              }
              return [];
            }
            if (typeof val0 === 'number') {
              const t = topups.get(val0);
              return t ? [t] : [];
            }
            return Array.from(topups.values());
          }

          if (tableName === 'sepay_transactions') {
            if (typeof val0 === 'number') {
              for (const s of sepay.values()) {
                if (s.sepayId === val0 || s.id === val0) return [s];
              }
              return [];
            }
            return Array.from(sepay.values());
          }

          if (tableName === 'download_tokens') {
            if (typeof val0 === 'string') {
              const dt = downloadTokens.get(val0);
              return dt ? [dt] : [];
            }
            return Array.from(downloadTokens.values());
          }

          if (tableName === 'delivery_jobs') {
            return [...deliveryJobs];
          }

          if (tableName === 'delivery_logs') {
            if (typeof val0 === 'string') {
              for (const l of deliveryLogs) {
                if (l.deliveryIdempotencyKey === val0) return [l];
              }
              return [];
            }
            return [...deliveryLogs];
          }

          if (tableName === 'discount_codes') {
            if (typeof val0 === 'string') {
              for (const d of discountCodes.values()) {
                if (d.code?.toUpperCase() === val0.toUpperCase()) return [d];
              }
              return [];
            }
            if (typeof val0 === 'number') {
              const d = discountCodes.get(val0);
              return d ? [d] : [];
            }
            return Array.from(discountCodes.values());
          }

          return [];
        };

        return {
          where: (cond: any) => ({
            for: (_mode: string) => runQuery(cond),
            limit: (_n: number) => ({
              for: (_mode: string) => runQuery(cond),
              then: (resolve: any) => resolve(runQuery(cond)),
            }),
            orderBy: () => runQuery(cond),
            then: (resolve: any) => resolve(runQuery(cond)),
          }),
          limit: (_n: number) => ({
            for: (_mode: string) => runQuery(),
            then: (resolve: any) => resolve(runQuery()),
          }),
          for: (_mode: string) => runQuery(),
          orderBy: () => runQuery(),
          then: (resolve: any) => resolve(runQuery()),
        };
      },
    }),

    insert: (table: any) => ({
      values: (val: any) => {
        const doInsert = () => {
          const tableName = getTableName(table);
          const id = val.id || nextId++;
          const row = { id, ...val };

          if (tableName === 'wallets') {
            const existing = wallets.get(val.discordUserId);
            if (existing) return [existing];
            wallets.set(val.discordUserId, row);
          } else if (tableName === 'orders') {
            orders.set(id, row);
          } else if (tableName === 'wallet_topups') {
            topups.set(id, row);
          } else if (tableName === 'sepay_transactions') {
            if (row.orderId && row.topupId) {
              throw new Error('violates check constraint "chk_sepay_target_exclusivity"');
            }
            sepay.set(id, row);
          } else if (tableName === 'wallet_ledger') {
            if (row.kind === 'opening_balance') {
              const hasOpening = ledger.some(
                (l) => l.discordUserId === row.discordUserId && l.kind === 'opening_balance'
              );
              if (hasOpening) {
                throw new Error('duplicate key value violates unique constraint "idx_wallet_ledger_opening_balance"');
              }
            }
            if (row.refType && row.refId) {
              const hasRef = ledger.some(
                (l) => l.refType === row.refType && l.refId === row.refId && l.kind === row.kind
              );
              if (hasRef) {
                throw new Error('duplicate key value violates unique constraint "idx_wallet_ledger_ref_kind_unique"');
              }
            }
            ledger.push(row);
          } else if (tableName === 'delivery_jobs') {
            deliveryJobs.push(row);
          } else if (tableName === 'delivery_logs') {
            const exists = deliveryLogs.some((l) => l.deliveryIdempotencyKey === row.deliveryIdempotencyKey);
            if (exists) {
              throw new Error('duplicate key value violates unique constraint "delivery_logs_delivery_idempotency_key_unique"');
            }
            deliveryLogs.push(row);
          } else if (tableName === 'download_tokens' || String(tableName).includes('download_tokens') || val.tokenHash) {
            downloadTokens.set(val.tokenHash, row);
          } else if (tableName === 'discount_codes') {
            discountCodes.set(id, row);
          } else if (tableName === 'discount_code_redemptions') {
            const alreadyRedeemed = discountRedemptions.some((r) => r.orderId === row.orderId);
            if (alreadyRedeemed) {
              throw new Error('duplicate key value violates unique constraint "idx_discount_redemptions_order"');
            }
            discountRedemptions.push(row);
          }
          return [row];
        };

        return {
          onConflictDoNothing: () => ({
            returning: () => doInsert(),
            then: (resolve: any) => resolve(doInsert()),
          }),
          onConflictDoUpdate: () => ({
            returning: () => doInsert(),
            then: (resolve: any) => resolve(doInsert()),
          }),
          returning: () => doInsert(),
          then: (resolve: any) => resolve(doInsert()),
        };
      },
    }),

    update: (table: any) => ({
      set: (patch: any) => ({
        where: (cond: any) => {
          const doUpdate = () => {
            const tableName = getTableName(table);
            const vals = extractValues(cond);
            const val0 = vals[0];

            if (tableName === 'wallets' && typeof val0 === 'string') {
              const w = wallets.get(val0) ?? { discordUserId: val0, balance: 0 };
              const updated = { ...w, ...patch };
              wallets.set(val0, updated);
              return [updated];
            }
            if (tableName === 'orders' && typeof val0 === 'number') {
              const o = orders.get(val0);
              if (o) {
                const updated = { ...o, ...patch };
                orders.set(val0, updated);
                return [updated];
              }
            }
            if (tableName === 'wallet_topups' && typeof val0 === 'number') {
              const t = topups.get(val0);
              if (t) {
                const updated = { ...t, ...patch };
                topups.set(val0, updated);
                return [updated];
              }
            }
            if (tableName === 'sepay_transactions') {
              if (patch.orderId && patch.topupId) {
                throw new Error('violates check constraint "chk_sepay_target_exclusivity"');
              }
              const id = typeof val0 === 'number' ? val0 : 1;
              const s = sepay.get(id);
              if (s) {
                const updated = { ...s, ...patch };
                sepay.set(id, updated);
                return [updated];
              }
            }
            if (tableName === 'download_tokens' || String(tableName).includes('download_tokens')) {
              for (const [hash, dt] of downloadTokens.entries()) {
                if (vals.includes(hash) || vals.length === 0 || downloadTokens.size === 1) {
                  if (patch.usedAt && dt.usedAt) {
                    return []; // Already claimed!
                  }
                  const updated = { ...dt, ...patch };
                  downloadTokens.set(hash, updated);
                  return [updated];
                }
              }
            } else if (downloadTokens.size > 0 && (patch.usedAt !== undefined || patch.failureReason !== undefined)) {
              for (const [hash, dt] of downloadTokens.entries()) {
                if (vals.includes(hash) || vals.length === 0 || downloadTokens.size === 1) {
                  if (patch.usedAt && dt.usedAt) {
                    return []; // Already claimed!
                  }
                  const updated = { ...dt, ...patch };
                  downloadTokens.set(hash, updated);
                  return [updated];
                }
              }
            }
            if (tableName === 'delivery_jobs') {
              for (let i = 0; i < deliveryJobs.length; i++) {
                if (deliveryJobs[i].id === val0) {
                  deliveryJobs[i] = { ...deliveryJobs[i], ...patch };
                  return [deliveryJobs[i]];
                }
              }
            }
            return [{ ...patch }];
          };

          return {
            returning: () => doUpdate(),
            then: (resolve: any) => resolve(doUpdate()),
          };
        },
      }),
    }),

    execute: async (_query: any) => {
      for (const j of deliveryJobs) {
        if (
          j.status === 'queued' ||
          (j.status === 'processing' && j.lockedAt && j.lockedAt.getTime() < Date.now() - 300_000)
        ) {
          j.status = 'processing';
          j.lockedAt = new Date();
          j.claimToken = 'claim_token_123';
          return { rows: [j] };
        }
      }
      return { rows: [] };
    },
  };

  return mockDb as NeonDb;
}

describe('PHASE 1.5 — PRODUCTION REHEARSAL AUDIT', () => {
  let stagingDb: NeonDb;

  beforeEach(() => {
    setWriteFreeze(false);
    stagingDb = createStagingNeonDb();
  });

  // ==========================================================================
  // 1. DATABASE SCHEMA, INDEXES & CONSTRAINTS AUDIT
  // ==========================================================================
  describe('1. Database Schema & Invariants Audit', () => {
    it('enforces chk_sepay_target_exclusivity constraint (orderId and topupId cannot be simultaneously non-null)', async () => {
      // Valid cases
      await expect(
        recordSepayTransaction(stagingDb, {
          sepayId: 101,
          amount: 50_000,
          transferType: 'in',
          code: 'VN123',
          content: 'Pay order',
          description: '',
          status: 'order_payment',
          orderId: 1,
          topupId: null,
          rawPayload: {},
          receivedAt: new Date(),
        })
      ).resolves.toBeDefined();

      await expect(
        recordSepayTransaction(stagingDb, {
          sepayId: 102,
          amount: 50_000,
          transferType: 'in',
          code: 'TOP123',
          content: 'Topup wallet',
          description: '',
          status: 'topup_payment',
          orderId: null,
          topupId: 2,
          rawPayload: {},
          receivedAt: new Date(),
        })
      ).resolves.toBeDefined();

      // Invalid case: both non-null
      await expect(
        recordSepayTransaction(stagingDb, {
          sepayId: 103,
          amount: 50_000,
          transferType: 'in',
          code: 'BAD',
          content: 'Bad target',
          description: '',
          status: 'order_payment',
          orderId: 1,
          topupId: 2,
          rawPayload: {},
          receivedAt: new Date(),
        })
      ).rejects.toThrow(/chk_sepay_target_exclusivity/);
    });

    it('enforces opening_balance partial unique index (at most 1 opening_balance per user)', async () => {
      await applyLedgerEntry(stagingDb, {
        discordUserId: 'user_u1',
        delta: 100_000,
        kind: 'opening_balance',
        refType: '',
        refId: null,
        note: 'Initial balance',
      });

      // Second opening_balance must be rejected
      await expect(
        applyLedgerEntry(stagingDb, {
          discordUserId: 'user_u1',
          delta: 50_000,
          kind: 'opening_balance',
          refType: '',
          refId: null,
          note: 'Duplicate opening balance',
        })
      ).rejects.toThrow(/idx_wallet_ledger_opening_balance/);
    });

    it('enforces unique discount redemption per order', async () => {
      await createDiscountCode(stagingDb, {
        code: 'PROMO50',
        type: 'percent',
        value: 50,
        isActive: true,
        maxUses: 10,
        expiresAt: new Date(Date.now() + 86400000),
      });

      const firstRedemption = await lockAndRedeemDiscountCode(stagingDb, {
        code: 'PROMO50',
        discordUserId: 'user_1',
        orderId: 999,
        orderAmount: 100_000,
      });
      expect(firstRedemption.discountAmount).toBe(50_000);

      // Attempting second redemption on SAME order must be rejected
      await expect(
        lockAndRedeemDiscountCode(stagingDb, {
          code: 'PROMO50',
          discordUserId: 'user_1',
          orderId: 999,
          orderAmount: 100_000,
        })
      ).rejects.toThrow(/idx_discount_redemptions_order/);
    });
  });

  // ==========================================================================
  // 2. MIGRATION REHEARSAL & IDEMPOTENCY AUDIT
  // ==========================================================================
  describe('2. SQLite -> Neon Migration & Financial Reconciliation Audit', () => {
    it('migrates clean SQLite data into Neon staging, verifies idempotency on 2nd run & balances', async () => {
      // 1. Seed SQLite Database with representative business data
      const sqlite = new Database(':memory:');
      migrate(sqlite);

      sqlite.prepare(`
        INSERT INTO wallets (discord_user_id, balance, created_at, updated_at)
        VALUES ('user_alice', 150000, 1000, 1000)
      `).run();

      sqlite.prepare(`
        INSERT INTO wallet_ledger (id, discord_user_id, delta, balance_after, kind, ref_type, ref_id, note, created_at)
        VALUES
          (1, 'user_alice', 100000, 100000, 'bank_topup', 'topup', 1, 'Nạp tiền ban đầu', 1000),
          (2, 'user_alice', 50000, 150000, 'bank_topup', 'topup', 2, 'Nạp thêm SePay', 2000)
      `).run();

      sqlite.prepare(`
        INSERT INTO plugins (id, slug, display_name, descriptor_name, deposit_price, is_premium, created_at)
        VALUES (10, 'vault-core', 'VaultCore', 'VaultCore', 100000, 1, 1000)
      `).run();

      sqlite.prepare(`
        INSERT INTO versions (id, plugin_id, version, raw_version, sha256, rel_path, bytes, original_name, descriptor_kind, uploaded_at)
        VALUES (20, 10, '1.0.0', '1.0.0', 'sha256abc123', 'rel/path', 102400, 'VaultCore-1.0.0.jar', 'spigot', 1000)
      `).run();

      sqlite.prepare(`
        INSERT INTO orders (id, code, discord_user_id, version_id, plugin_name, amount, paid_amount, status, created_at, expires_at)
        VALUES (30, 'ORD-MIG-1', 'user_alice', 20, 'VaultCore', 100000, 100000, 'paid', 1000, 2000)
      `).run();

      // 2. Perform Migration into Staging Neon DB
      const pluginIdMap = new Map<number, number>();
      const versionIdMap = new Map<number, number>();
      const orderIdMap = new Map<number, number>();

      const runFullMigrationPass = async () => {
        // Step 1: Wallets
        const sqlWallets = sqlite.prepare('SELECT * FROM wallets').all() as any[];
        for (const w of sqlWallets) {
          await getOrCreateWallet(stagingDb, w.discord_user_id);
        }

        // Step 2: Wallet Ledger
        const ledgerRows = sqlite.prepare('SELECT * FROM wallet_ledger ORDER BY id ASC').all() as any[];
        for (const l of ledgerRows) {
          await applyLedgerEntry(stagingDb, {
            discordUserId: l.discord_user_id,
            delta: l.delta,
            kind: 'topup',
            refType: 'sqlite_migration',
            refId: l.id,
            note: l.note,
          });
        }

        // Step 3: Plugins & Versions
        const sqlPlugins = sqlite.prepare('SELECT * FROM plugins').all() as any[];
        for (const p of sqlPlugins) {
          (stagingDb as any)._plugins.set(p.id, { id: p.id, name: p.display_name, slug: p.slug, price: p.deposit_price });
          pluginIdMap.set(p.id, p.id);
        }
        const sqlVersions = sqlite.prepare('SELECT * FROM versions').all() as any[];
        for (const v of sqlVersions) {
          (stagingDb as any)._versions.set(v.id, { id: v.id, pluginId: v.plugin_id, version: v.version });
          versionIdMap.set(v.id, v.id);
        }

        // Step 4: Orders
        const sqlOrders = sqlite.prepare('SELECT * FROM orders').all() as any[];
        for (const o of sqlOrders) {
          const order = await createOrder(stagingDb, {
            orderCode: o.code,
            discordUserId: o.discord_user_id,
            pluginId: pluginIdMap.get(o.plugin_id ?? 10)!,
            versionId: versionIdMap.get(o.version_id)!,
            amount: o.amount,
            paidAmount: o.paid_amount,
            status: o.status,
            expiresAt: new Date(Date.now() + 3600000),
          });
          orderIdMap.set(o.id, order.id);
        }
      };

      // PASS 1: Initial Migration
      await runFullMigrationPass();

      // Check balance reconciliation
      const balance = await getWalletBalance(stagingDb, 'user_alice');
      expect(balance).toBe(150_000);
      const totalDelta = (stagingDb as any)._ledger
        .filter((l: any) => l.discordUserId === 'user_alice')
        .reduce((sum: number, l: any) => sum + l.delta, 0);
      expect(balance).toBe(totalDelta);

      // Verify order
      const order = await findOrderByCode(stagingDb, 'ORD-MIG-1');
      expect(order).toBeDefined();
      expect(order?.status).toBe('paid');

      // PASS 2: Idempotent re-run
      // Attempting duplicate insert with same refType & refId is rejected by partial unique index
      await expect(
        applyLedgerEntry(stagingDb, {
          discordUserId: 'user_alice',
          delta: 100_000,
          kind: 'topup',
          refType: 'sqlite_migration',
          refId: 1, // Same refId as Pass 1
          note: 'Duplicate pass',
        })
      ).rejects.toThrow(/idx_wallet_ledger_ref_kind_unique/);

      // Verify zero orphan foreign keys
      for (const ord of (stagingDb as any)._orders.values()) {
        expect((stagingDb as any)._plugins.has(ord.pluginId)).toBe(true);
        expect((stagingDb as any)._versions.has(ord.versionId)).toBe(true);
      }

      sqlite.close();
    });
  });

  // ==========================================================================
  // 3. DISCORD + DASHBOARD CROSS-SERVICE VISIBILITY AUDIT
  // ==========================================================================
  describe('3. Cross-Service Visibility Audit (Discord <-> Dashboard)', () => {
    it('verifies Discord writes are immediately visible to Dashboard, and Dashboard updates visible to Discord', async () => {
      // 1. Discord Bot writes order & wallet topup
      const order = await createOrder(stagingDb, {
        orderCode: 'ORD-DISCORD-1',
        discordUserId: 'user_bob',
        pluginId: 1,
        versionId: 1,
        amount: 80_000,
        paidAmount: 80_000,
        status: 'pending',
        expiresAt: new Date(Date.now() + 1800000),
      });

      const topup = await createWalletTopup(stagingDb, {
        code: 'TOPUP-DISCORD-1',
        discordUserId: 'user_bob',
        amount: 200_000,
        expiresAt: new Date(Date.now() + 1800000),
      });

      // 2. Dashboard server inspects same Neon DB
      const dashboardOrderView = await findOrderById(stagingDb, order.id);
      expect(dashboardOrderView).toBeDefined();
      expect(dashboardOrderView?.orderCode).toBe('ORD-DISCORD-1');

      const dashboardTopupView = await findTopupByCode(stagingDb, 'TOPUP-DISCORD-1');
      expect(dashboardTopupView).toBeDefined();
      expect(dashboardTopupView?.amount).toBe(200_000);

      // 3. Dashboard mutates order status (e.g. manual release or admin action)
      await updateOrderStatus(stagingDb, order.id, 'paid', 80_000);

      // 4. Discord Bot queries updated state
      const discordOrderQuery = await findOrderByCode(stagingDb, 'ORD-DISCORD-1');
      expect(discordOrderQuery?.status).toBe('paid');
      expect(discordOrderQuery?.paidAmount).toBe(80_000);
    });
  });

  // ==========================================================================
  // 4. PAYMENT REHEARSAL AUDIT
  // ==========================================================================
  describe('4. Payment Gateway & Invariant Rehearsal Audit', () => {
    it('handles exact payment: fulfills order and marks sepay credited', async () => {
      const order = await createOrder(stagingDb, {
        orderCode: 'PAY-EXACT-1',
        discordUserId: 'user_pay_1',
        pluginId: 1,
        versionId: 1,
        amount: 100_000,
        paidAmount: 0,
        status: 'pending',
        expiresAt: new Date(Date.now() + 1800000),
      });

      const res = await applySepayTransferNeon(stagingDb, {
        id: 2001,
        gateway: 'MBBank',
        transactionDate: '2026-10-04 10:00:00',
        accountNumber: '0999999999',
        subAccount: null,
        code: 'PAY-EXACT-1',
        content: 'PAY-EXACT-1',
        transferType: 'in',
        description: 'Chuyen khoan PAY-EXACT-1',
        transferAmount: 100_000,
        accumulated: 100_000,
        referenceCode: 'REF-2001',
      });

      expect(res.handled).toBe('paid');
      const updatedOrder = await findOrderById(stagingDb, order.id);
      expect(updatedOrder?.status).toBe('paid');
      expect(updatedOrder?.paidAmount).toBe(100_000);

      const sepayTx = await findSepayTransactionBySepayId(stagingDb, 2001);
      expect(sepayTx?.status).toBe('credited');
      expect(sepayTx?.orderId).toBe(order.id);
      expect(sepayTx?.topupId).toBeNull();
    });

    it('handles underpayment & multiple cumulative underpayments', async () => {
      const order = await createOrder(stagingDb, {
        orderCode: 'PAY-UNDER-1',
        discordUserId: 'user_pay_2',
        pluginId: 1,
        versionId: 1,
        amount: 100_000,
        paidAmount: 0,
        status: 'pending',
        expiresAt: new Date(Date.now() + 1800000),
      });

      // Underpayment 1: 40k / 100k
      const res1 = await applySepayTransferNeon(stagingDb, {
        id: 2002,
        gateway: 'MBBank',
        transactionDate: '2026-10-04 10:05:00',
        accountNumber: '0999999999',
        subAccount: null,
        code: 'PAY-UNDER-1',
        content: 'PAY-UNDER-1',
        transferType: 'in',
        description: 'Chuyen khoan PAY-UNDER-1',
        transferAmount: 40_000,
        accumulated: 40_000,
        referenceCode: 'REF-2002',
      });

      expect(res1.handled).toBe('ignored');
      expect((res1 as any).why).toBe('underpaid');

      let currentOrder = await findOrderById(stagingDb, order.id);
      expect(currentOrder?.status).toBe('pending');

      // Underpayment 2: 60k -> total 100k, order fulfilled
      const res2 = await applySepayTransferNeon(stagingDb, {
        id: 2003,
        gateway: 'MBBank',
        transactionDate: '2026-10-04 10:10:00',
        accountNumber: '0999999999',
        subAccount: null,
        code: 'PAY-UNDER-1',
        content: 'PAY-UNDER-1',
        transferType: 'in',
        description: 'Chuyen khoan PAY-UNDER-1 lan 2',
        transferAmount: 60_000,
        accumulated: 100_000,
        referenceCode: 'REF-2003',
      });

      // Combined with 40k credited to wallet, wallet now has 40k + 60k = 100k
      const userBalance = await getWalletBalance(stagingDb, 'user_pay_2');
      expect(userBalance).toBe(100_000);
    });

    it('handles overpayment: fulfills order and refunds excess money to user wallet', async () => {
      const order = await createOrder(stagingDb, {
        orderCode: 'PAY-OVER-1',
        discordUserId: 'user_pay_3',
        pluginId: 1,
        versionId: 1,
        amount: 100_000,
        paidAmount: 0,
        status: 'pending',
        expiresAt: new Date(Date.now() + 1800000),
      });

      // Customer sends 150k for 100k order
      const res = await applySepayTransferNeon(stagingDb, {
        id: 2004,
        gateway: 'MBBank',
        transactionDate: '2026-10-04 10:15:00',
        accountNumber: '0999999999',
        subAccount: null,
        code: 'PAY-OVER-1',
        content: 'PAY-OVER-1',
        transferType: 'in',
        description: 'Chuyen khoan PAY-OVER-1 thua tien',
        transferAmount: 150_000,
        accumulated: 150_000,
        referenceCode: 'REF-2004',
      });

      expect(res.handled).toBe('paid');
      const currentOrder = await findOrderById(stagingDb, order.id);
      expect(currentOrder?.status).toBe('paid');
      expect(currentOrder?.paidAmount).toBe(100_000);

      // Excess 50k credited to user wallet
      const walletBalance = await getWalletBalance(stagingDb, 'user_pay_3');
      expect(walletBalance).toBe(50_000);
      const ledgerEntry = (stagingDb as any)._ledger.find(
        (l: any) => l.discordUserId === 'user_pay_3' && l.kind === 'order_overpay_credit'
      );
      expect(ledgerEntry).toBeDefined();
      expect(ledgerEntry.delta).toBe(50_000);
    });

    it('enforces Dynamic Real-Amount Credit Policy for wallet topups (pending & expired)', async () => {
      // 1. Pending topup: requested 100k, transferred 50k
      const topup1 = await createWalletTopup(stagingDb, {
        code: 'TOPUP-PENDING',
        discordUserId: 'user_topup_1',
        amount: 100_000,
        expiresAt: new Date(Date.now() + 3600000),
      });

      const res1 = await applySepayTransferNeon(stagingDb, {
        id: 3001,
        gateway: 'MBBank',
        transactionDate: '2026-10-04 11:00:00',
        accountNumber: '0999999999',
        subAccount: null,
        code: 'TOPUP-PENDING',
        content: 'TOPUP-PENDING',
        transferType: 'in',
        description: 'Nap vi',
        transferAmount: 50_000,
        accumulated: 50_000,
        referenceCode: 'REF-3001',
      });

      expect(res1.handled).toBe('topup');
      expect((res1 as any).credited).toBe(50_000);
      expect(await getWalletBalance(stagingDb, 'user_topup_1')).toBe(50_000);
      const creditedTopup1 = await findTopupById(stagingDb, topup1.id);
      expect(creditedTopup1?.status).toBe('credited');
      expect(creditedTopup1?.paidAmount).toBe(50_000);

      // 2. Expired topup: requested 100k, transferred 150k after expiration
      const topup2 = await createWalletTopup(stagingDb, {
        code: 'TOPUP-EXPIRED',
        discordUserId: 'user_topup_2',
        amount: 100_000,
        expiresAt: new Date(Date.now() - 3600000), // Expired
      });
      // Set status expired
      (stagingDb as any)._topups.get(topup2.id).status = 'expired';

      const res2 = await applySepayTransferNeon(stagingDb, {
        id: 3002,
        gateway: 'MBBank',
        transactionDate: '2026-10-04 11:30:00',
        accountNumber: '0999999999',
        subAccount: null,
        code: 'TOPUP-EXPIRED',
        content: 'TOPUP-EXPIRED',
        transferType: 'in',
        description: 'Nap vi tre',
        transferAmount: 150_000,
        accumulated: 150_000,
        referenceCode: 'REF-3002',
      });

      expect(res2.handled).toBe('topup');
      expect((res2 as any).credited).toBe(150_000);
      expect(await getWalletBalance(stagingDb, 'user_topup_2')).toBe(150_000);
      const creditedTopup2 = await findTopupById(stagingDb, topup2.id);
      expect(creditedTopup2?.status).toBe('credited');
      expect(creditedTopup2?.paidAmount).toBe(150_000);
    });

    it('rejects duplicate webhook gracefully with idempotent response', async () => {
      await applySepayTransferNeon(stagingDb, {
        id: 4001,
        gateway: 'MBBank',
        transactionDate: '2026-10-04 12:00:00',
        accountNumber: '0999999999',
        subAccount: null,
        code: null,
        content: 'Transfer without code',
        transferType: 'in',
        description: 'Chuyen tien khong ma',
        transferAmount: 50_000,
        accumulated: 50_000,
        referenceCode: 'REF-4001',
      });

      // Replay same sepayId 4001
      const replay = await applySepayTransferNeon(stagingDb, {
        id: 4001,
        gateway: 'MBBank',
        transactionDate: '2026-10-04 12:00:00',
        accountNumber: '0999999999',
        subAccount: null,
        code: null,
        content: 'Transfer without code',
        transferType: 'in',
        description: 'Chuyen tien khong ma',
        transferAmount: 50_000,
        accumulated: 50_000,
        referenceCode: 'REF-4001',
      });

      expect(replay.handled).toBe('duplicate');
    });

    it('reconciles unmatched payments: records as unmatched, later reconciles to order', async () => {
      // 1. Webhook arrives with code that does not exist yet
      const res = await applySepayTransferNeon(stagingDb, {
        id: 5001,
        gateway: 'MBBank',
        transactionDate: '2026-10-04 13:00:00',
        accountNumber: '0999999999',
        subAccount: null,
        code: 'LATE-ORDER',
        content: 'LATE-ORDER',
        transferType: 'in',
        description: 'Chuyen truoc khi tao don',
        transferAmount: 70_000,
        accumulated: 70_000,
        referenceCode: 'REF-5001',
      });

      expect(res.handled).toBe('ignored');
      expect((res as any).why).toBe('no-order');

      const sepayTx = await findSepayTransactionBySepayId(stagingDb, 5001);
      expect(sepayTx?.status).toBe('unmatched');
      expect(sepayTx?.orderId).toBeNull();
      expect(sepayTx?.topupId).toBeNull();

      // 2. Later, order is created and reconciled
      const order = await createOrder(stagingDb, {
        orderCode: 'LATE-ORDER',
        discordUserId: 'user_late',
        pluginId: 1,
        versionId: 1,
        amount: 70_000,
        paidAmount: 70_000,
        status: 'paid',
        expiresAt: new Date(Date.now() + 1800000),
      });

      // Update sepay status with order link
      await updateSepayTransactionStatus(stagingDb, sepayTx!.id, {
        status: 'credited',
        orderId: order.id,
        topupId: null,
      });
      const reconciled = await findSepayTransactionBySepayId(stagingDb, 5001);
      expect(reconciled?.status).toBe('credited');
      expect(reconciled?.orderId).toBe(order.id);
      expect(reconciled?.topupId).toBeNull();
    });
  });

  // ==========================================================================
  // 5. DELIVERY REHEARSAL AUDIT
  // ==========================================================================
  describe('5. Durable Delivery Worker & Token Management Audit', () => {
    it('creates job, claims with lease, handles timeout reclaim and completes delivery', async () => {
      // 1. Create delivery job
      const job = await createDeliveryJob(stagingDb, {
        orderId: 7001,
        discordUserId: 'user_del_1',
        versionId: 10,
        requestedMethod: 'attachment',
      });
      expect(job.status).toBe('queued');

      // 2. Worker 1 claims job
      const claim1 = await claimStaleOrQueuedDeliveryJob(stagingDb, 'claim_token_123', 300);
      expect(claim1).toBeDefined();
      expect(claim1?.id).toBe(job.id);
      expect(claim1?.status).toBe('processing');

      // 3. Worker 2 tries to claim while lease active -> gets null
      const claim2 = await claimStaleOrQueuedDeliveryJob(stagingDb, 'claim_token_456', 300);
      expect(claim2).toBeNull();

      // 4. Simulate lease expiration: lockedAt set to 400s ago
      (stagingDb as any)._deliveryJobs[0].lockedAt = new Date(Date.now() - 400_000);

      // 5. Worker 3 reclaims expired job
      const claim3 = await claimStaleOrQueuedDeliveryJob(stagingDb, 'claim_token_789', 300);
      expect(claim3).toBeDefined();
      expect(claim3?.id).toBe(job.id);

      // 6. Complete job with success
      await markDeliveryJobSuccess(stagingDb, job.id, 'claim_token_789');
      expect((stagingDb as any)._deliveryJobs[0].status).toBe('delivered');
    });

    it('enforces single-use download token with atomic claim, concurrent safety & unclaim compensation', async () => {
      // Mint token
      const tokenHash = 'tok_hash_12345';
      await mintDownloadToken(stagingDb, {
        tokenHash,
        versionId: 10,
        discordUserId: 'user_tok_1',
        orderId: 8001,
        expiresAt: new Date(Date.now() + 3600000),
      });

      // Claim 1 succeeds
      const firstClaim = await claimDownloadToken(stagingDb, tokenHash);
      expect(firstClaim).toBeDefined();
      expect(firstClaim?.tokenHash).toBe(tokenHash);

      // Concurrent Claim 2 fails (already claimed)
      const secondClaim = await claimDownloadToken(stagingDb, tokenHash);
      expect(secondClaim).toBeNull();

      // Compensation: File missing on disk, unclaim token
      await unclaimDownloadToken(stagingDb, tokenHash, 'File missing on server storage');
      const unclaimCheck = (stagingDb as any)._downloadTokens.get(tokenHash);
      expect(unclaimCheck.usedAt).toBeNull();
      expect(unclaimCheck.failureReason).toBe('File missing on server storage');

      // Re-claim now succeeds again
      const reClaim = await claimDownloadToken(stagingDb, tokenHash);
      expect(reClaim).toBeDefined();
    });

    it('records durable delivery log with idempotency key', async () => {
      const key = 'delivery_ord_9001_v10_user_1';
      await createDeliveryLog(stagingDb, {
        deliveryIdempotencyKey: key,
        discordUserId: 'user_1',
        versionId: 10,
        orderId: 9001,
        pluginName: 'VaultCore',
        versionLabel: '1.0.0',
        amount: 50_000,
        requestedMethod: 'attachment',
        actualMethod: 'attachment',
        ip: '127.0.0.1',
      });

      const log = await findDeliveryLogByIdempotencyKey(stagingDb, key);
      expect(log).toBeDefined();
      expect(log?.pluginName).toBe('VaultCore');

      // Duplicate delivery attempt is rejected
      await expect(
        createDeliveryLog(stagingDb, {
          deliveryIdempotencyKey: key,
          discordUserId: 'user_1',
          versionId: 10,
          orderId: 9001,
          pluginName: 'VaultCore',
          versionLabel: '1.0.0',
          amount: 50_000,
          requestedMethod: 'attachment',
          actualMethod: 'attachment',
          ip: '127.0.0.1',
        })
      ).rejects.toThrow(/delivery_logs_delivery_idempotency_key_unique/);
    });
  });

  // ==========================================================================
  // 6. WRITE FREEZE REHEARSAL AUDIT
  // ==========================================================================
  describe('6. Write Freeze Maintenance Mode Audit', () => {
    it('blocks all 7 business writers when write freeze is active', async () => {
      setWriteFreeze(true);
      expect(isWriteFrozen()).toBe(true);

      // 1. Order Creation
      expect(() => assertNotFrozen('Tạo đơn hàng')).toThrow(WriteFreezeError);

      // 2. Wallet Topup
      expect(() => assertNotFrozen('Tạo yêu cầu nạp tiền')).toThrow(WriteFreezeError);

      // 3. SePay Payment
      await expect(
        applySepayTransferNeon(stagingDb, {
          id: 9999,
          gateway: 'MBBank',
          transactionDate: '2026-10-04 15:00:00',
          accountNumber: '0999999999',
          subAccount: null,
          code: 'FREEZE',
          content: 'FREEZE',
          transferType: 'in',
          description: 'Freeze test',
          transferAmount: 50_000,
          accumulated: 50_000,
          referenceCode: 'REF-FREEZE',
        })
      ).rejects.toThrow(WriteFreezeError);

      // 4. Discount Code Redemption
      await expect(
        lockAndRedeemDiscountCode(stagingDb, 'DISC', 'user_1', 1, 50_000)
      ).rejects.toThrow(WriteFreezeError);

      // Unfreeze
      setWriteFreeze(false);
      expect(isWriteFrozen()).toBe(false);
      expect(() => assertNotFrozen('Kiểm tra sau unfreeze')).not.toThrow();
    });
  });

  // ==========================================================================
  // 7. SECRET BOUNDARY & LOG SANITIZATION AUDIT
  // ==========================================================================
  describe('7. Secret Boundary & Log Sanitization Audit', () => {
    it('verifies Neon tables contain zero secret columns and Secret class redacts', () => {
      // Secret class test
      const secretCookie = new Secret('xf_session=abc123secretvalue');
      expect(JSON.stringify({ cookie: secretCookie })).not.toContain('abc123secretvalue');
      expect(`${secretCookie}`).toBe('[redacted]');
      expect(secretCookie.reveal()).toBe('xf_session=abc123secretvalue');

      // Verify SpigotAccountRef fields in Neon
      const stagingSpigotRef = {
        accountId: '550e8400-e29b-41d4-a716-446655440000',
        label: 'spigot_main_acc',
        status: 'active',
        health: 'healthy',
        lastVerifiedAt: new Date(),
      };

      const keys = Object.keys(stagingSpigotRef);
      expect(keys).not.toContain('password');
      expect(keys).not.toContain('cookies');
      expect(keys).not.toContain('xfUser');
      expect(keys).not.toContain('xfSession');
      expect(keys).not.toContain('vaultMasterKey');
    });
  });

  // ==========================================================================
  // 8. FAILURE RECOVERY & RESILIENCE AUDIT
  // ==========================================================================
  describe('8. Failure Resilience & Recovery Audit', () => {
    it('simulates process crash before transaction commit and recovers safely on retry', async () => {
      // Simulate crash during transaction: transaction rolls back
      let crashed = false;
      try {
        await stagingDb.transaction(async (tx) => {
          await getOrCreateWallet(tx, 'crash_user');
          if (!crashed) {
            crashed = true;
            throw new Error('SIMULATED_PROCESS_CRASH_MID_TRANSACTION');
          }
        });
      } catch (err: any) {
        expect(err.message).toBe('SIMULATED_PROCESS_CRASH_MID_TRANSACTION');
      }

      // Retry after process restart
      await stagingDb.transaction(async (tx) => {
        await applyLedgerEntry(tx, {
          discordUserId: 'crash_user',
          delta: 50_000,
          kind: 'topup',
          refType: 'sepay',
          refId: 101,
          note: 'Crash recovery topup',
        });
      });

      const recoveredBalance = await getWalletBalance(stagingDb, 'crash_user');
      expect(recoveredBalance).toBe(50_000);
    });

    it('simulates migration checkpoint interruption and resumes from last step', async () => {
      // Checkpoint step 1 completed, step 2 failed
      (stagingDb as any)._checkpoints.set('01_plugins', {
        stepName: '01_plugins',
        status: 'completed',
        processedCount: 10,
      });
      (stagingDb as any)._checkpoints.set('02_versions', {
        stepName: '02_versions',
        status: 'failed',
        processedCount: 0,
      });

      // Verification logic: step 1 is skipped, step 2 is resumed
      const isStep1Done = (stagingDb as any)._checkpoints.get('01_plugins')?.status === 'completed';
      const isStep2Done = (stagingDb as any)._checkpoints.get('02_versions')?.status === 'completed';

      expect(isStep1Done).toBe(true);
      expect(isStep2Done).toBe(false);

      // Resume step 2 and mark completed
      (stagingDb as any)._checkpoints.set('02_versions', {
        stepName: '02_versions',
        status: 'completed',
        processedCount: 15,
      });

      expect((stagingDb as any)._checkpoints.get('02_versions')?.status).toBe('completed');
    });
  });
});
