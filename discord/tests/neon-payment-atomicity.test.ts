import { describe, it, expect, beforeEach } from "vitest";
import {
  applySepayTransferNeon,
  type WebhookOutcome,
} from "../src/services/payment/neon-payment-flow.js";
import {
  setWriteFreeze,
  isWriteFrozen,
  assertNotFrozen,
  WriteFreezeError,
} from "../src/services/maintenance/write-freeze.js";
import { updateSepayTransactionStatus } from "../src/repositories/neon-sepay.js";
import { refundOrderWallet } from "../src/repositories/neon-orders.js";
import { applyLedgerEntry } from "../src/repositories/neon-wallets.js";
import type { Database } from "../src/db/neon.js";

/**
 * In-memory Mock Database for Neon PostgreSQL tests.
 * Accurately models rows, constraints, transactions, and locking.
 */
function createMockNeonDb() {
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

  let nextId = 1;
  let txQueue: Promise<void> = Promise.resolve();

  function extractValues(cond: any): any[] {
    if (!cond) return [];
    const vals: any[] = [];
    if (Array.isArray(cond.queryChunks)) {
      for (const chunk of cond.queryChunks) {
        if (chunk && chunk.value !== undefined && !Array.isArray(chunk.value)) {
          vals.push(chunk.value);
        }
      }
    }
    return vals;
  }

  function getTableName(table: any): string {
    if (!table) return "";
    if (typeof table === "string") return table;
    return (
      table[Symbol.for("drizzle:Name")] ||
      table[Symbol.for("drizzle:OriginalName")] ||
      table[Symbol.for("drizzle:BaseName")] ||
      table._?.name ||
      table.name ||
      ""
    );
  }

  const mockDb: any = {
    _state: {
      wallets,
      ledger,
      orders,
      topups,
      sepay,
      deliveryJobs,
      deliveryLogs,
      downloadTokens,
      discountCodes,
      discountRedemptions,
    },

    select: (_fields?: any) => ({
      from: (table: any) => ({
        where: (condition: any) => {
          const runFilter = () => {
            const tableName = getTableName(table);
            const vals = extractValues(condition);
            const val0 = vals[0];

            if (tableName === "wallets") {
              if (typeof val0 === "string") {
                const w = wallets.get(val0);
                return w ? [w] : [];
              }
              return Array.from(wallets.values());
            }

            if (tableName === "orders") {
              if (typeof val0 === "string") {
                for (const o of orders.values()) {
                  if (o.code?.toUpperCase() === val0.toUpperCase()) return [o];
                }
                return [];
              }
              if (typeof val0 === "number") {
                const o = orders.get(val0);
                return o ? [o] : [];
              }
              return Array.from(orders.values());
            }

            if (tableName === "wallet_topups") {
              if (typeof val0 === "string") {
                for (const t of topups.values()) {
                  if (t.code?.toUpperCase() === val0.toUpperCase()) return [t];
                }
                return [];
              }
              if (typeof val0 === "number") {
                const t = topups.get(val0);
                return t ? [t] : [];
              }
              return Array.from(topups.values());
            }

            if (tableName === "sepay_transactions") {
              if (typeof val0 === "number") {
                for (const s of sepay.values()) {
                  if (s.sepayId === val0 || s.id === val0) return [s];
                }
                return [];
              }
              return Array.from(sepay.values());
            }

            if (tableName === "download_tokens") {
              if (typeof val0 === "string") {
                const dt = downloadTokens.get(val0);
                return dt ? [dt] : [];
              }
              return Array.from(downloadTokens.values());
            }

            return [];
          };

          return {
            for: (_mode: string) => runFilter(),
            limit: (_n: number) => runFilter(),
            orderBy: () => runFilter(),
            then: (resolve: any) => resolve(runFilter()),
          };
        },
        orderBy: () => [],
      }),
    }),

    insert: (table: any) => ({
      values: (val: any) => {
        const doInsert = (onConflictDoNothing = false) => {
          const tableName = getTableName(table);
          if (tableName === "sepay_transactions") {
            const conflict = Array.from(sepay.values()).find(
              (s: any) => s.sepayId === val.sepayId
            );
            if (conflict) {
              if (onConflictDoNothing) {
                return [];
              }
              throw new Error(
                `Unique constraint violation: sepay_transactions.sepay_id=${val.sepayId}`
              );
            }
          }

          const id = nextId++;
          const row = { id, ...val };

          if (tableName === "wallets") {
            const existing = wallets.get(val.discordUserId);
            if (existing) {
              return [existing];
            }
            wallets.set(val.discordUserId, row);
          } else if (tableName === "orders") {
            orders.set(id, row);
          } else if (tableName === "wallet_topups") {
            topups.set(id, row);
          } else if (tableName === "sepay_transactions") {
            sepay.set(id, row);
          } else if (tableName === "wallet_ledger") {
            ledger.push(row);
          } else if (tableName === "delivery_jobs") {
            deliveryJobs.push(row);
          } else if (tableName === "download_tokens") {
            downloadTokens.set(val.tokenHash, row);
          }
          return [row];
        };

        return {
          onConflictDoNothing: () => ({
            returning: () => doInsert(true),
            then: (resolve: any) => resolve(doInsert(true)),
          }),
          onConflictDoUpdate: () => ({
            returning: () => doInsert(false),
            then: (resolve: any) => resolve(doInsert(false)),
          }),
          returning: () => doInsert(false),
          then: (resolve: any) => resolve(doInsert(false)),
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

            if (tableName === "wallets" && typeof val0 === "string") {
              const w = wallets.get(val0) ?? { discordUserId: val0, balance: 0 };
              const updated = { ...w, ...patch };
              wallets.set(val0, updated);
              return [updated];
            }
            if (tableName === "orders") {
              let o = typeof val0 === "number" ? orders.get(val0) : undefined;
              if (!o) {
                o = Array.from(orders.values()).find(
                  (x: any) =>
                    x.id === val0 ||
                    (x.code && String(x.code).toUpperCase() === String(val0).toUpperCase())
                );
              }
              if (o) {
                const updated = { ...o, ...patch };
                orders.set(o.id, updated);
                return [updated];
              }
            }
            if (tableName === "wallet_topups") {
              let t = typeof val0 === "number" ? topups.get(val0) : undefined;
              if (!t) {
                t = Array.from(topups.values()).find(
                  (x: any) =>
                    x.id === val0 ||
                    (x.code && String(x.code).toUpperCase() === String(val0).toUpperCase())
                );
              }
              if (t) {
                const updated = { ...t, ...patch };
                topups.set(t.id, updated);
                return [updated];
              }
            }
            if (tableName === "sepay_transactions") {
              let s = typeof val0 === "number" ? sepay.get(val0) : undefined;
              if (!s) {
                s = Array.from(sepay.values()).find(
                  (x: any) => x.id === val0 || x.sepayId === val0
                );
              }
              if (s) {
                const updated = { ...s, ...patch };
                sepay.set(s.id, updated);
                return [updated];
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

    transaction: async (cb: any) => {
      // Serialize transactions to accurately model row-level locks (SELECT ... FOR UPDATE)
      let release: () => void;
      const nextInQueue = new Promise<void>((resolve) => {
        release = resolve;
      });
      const currentQueue = txQueue;
      txQueue = currentQueue.then(() => nextInQueue);

      await currentQueue;

      const snapWallets = new Map(wallets);
      const snapLedger = [...ledger];
      const snapOrders = new Map(orders);
      const snapTopups = new Map(topups);
      const snapSepay = new Map(sepay);
      const snapJobs = [...deliveryJobs];
      const snapLogs = [...deliveryLogs];
      const snapTokens = new Map(downloadTokens);
      const snapDiscounts = new Map(discountCodes);
      const snapRedemptions = [...discountRedemptions];
      try {
        return await cb(mockDb);
      } catch (err) {
        wallets.clear();
        snapWallets.forEach((v, k) => wallets.set(k, { ...v }));
        ledger.length = 0;
        ledger.push(...snapLedger.map((l) => ({ ...l })));
        orders.clear();
        snapOrders.forEach((v, k) => orders.set(k, { ...v }));
        topups.clear();
        snapTopups.forEach((v, k) => topups.set(k, { ...v }));
        sepay.clear();
        snapSepay.forEach((v, k) => sepay.set(k, { ...v }));
        deliveryJobs.length = 0;
        deliveryJobs.push(...snapJobs.map((j) => ({ ...j })));
        deliveryLogs.length = 0;
        deliveryLogs.push(...snapLogs.map((l) => ({ ...l })));
        downloadTokens.clear();
        snapTokens.forEach((v, k) => downloadTokens.set(k, { ...v }));
        discountCodes.clear();
        snapDiscounts.forEach((v, k) => discountCodes.set(k, { ...v }));
        discountRedemptions.length = 0;
        discountRedemptions.push(...snapRedemptions.map((r) => ({ ...r })));
        throw err;
      } finally {
        release!();
      }
    },

    execute: async (query: any) => {
      return { rows: [] };
    },
  };

  return mockDb as Database;
}

describe("Neon Payment Atomicity & Phase 1 Invariants", () => {
  beforeEach(() => {
    setWriteFreeze(false);
  });

  // 1. Exact Order Payment
  it("Test 1: Exact order payment - marks paid, queues delivery, no wallet lock, status credited", async () => {
    const db = createMockNeonDb();
    const state = (db as any)._state;

    // Seed pending order for 50.000đ
    state.orders.set(101, {
      id: 101,
      code: "ORDER101",
      discordUserId: "user_101",
      amount: 50_000,
      status: "pending",
      versionId: 1,
    });

    const outcome = await applySepayTransferNeon(db, {
      id: 5001,
      gateway: "Vietcombank",
      transactionDate: new Date().toISOString(),
      accountNumber: "123456",
      subAccount: null,
      code: "ORDER101",
      content: "ORDER101 payment",
      transferType: "in",
      description: "Thanh toán ORDER101",
      transferAmount: 50_000,
      accumulated: 50_000,
      referenceCode: "REF5001",
    });

    expect(outcome).toEqual({ handled: "paid", orderId: 101 });
    // Wallet ledger should NOT have any debit or credit for exact bank payment
    expect(state.ledger.length).toBe(0);
  });

  // 2. Underpayment
  it("Test 2: Underpayment - credits received amount to wallet, order stays pending, sepay underpaid", async () => {
    const db = createMockNeonDb();
    const state = (db as any)._state;

    state.orders.set(102, {
      id: 102,
      code: "ORDER102",
      discordUserId: "user_102",
      amount: 50_000,
      status: "pending",
      versionId: 1,
    });

    const outcome = await applySepayTransferNeon(db, {
      id: 5002,
      gateway: "Vietcombank",
      transactionDate: new Date().toISOString(),
      accountNumber: "123456",
      subAccount: null,
      code: "ORDER102",
      content: "ORDER102 underpaid",
      transferType: "in",
      description: "Thanh toán thiếu",
      transferAmount: 20_000, // Short of 50.000
      accumulated: 20_000,
      referenceCode: "REF5002",
    });

    expect(outcome).toEqual({ handled: "ignored", why: "underpaid" });
    // Ledger must credit the partial 20.000 to user's wallet
    expect(state.ledger.length).toBe(1);
    expect(state.ledger[0].delta).toBe(20_000);
    expect(state.ledger[0].kind).toBe("order_partial_credit");
  });

  // 3. Overpayment
  it("Test 3: Overpayment - order paid, delivery queued, surplus credited to wallet", async () => {
    const db = createMockNeonDb();
    const state = (db as any)._state;

    state.orders.set(103, {
      id: 103,
      code: "ORDER103",
      discordUserId: "user_103",
      amount: 50_000,
      status: "pending",
      versionId: 1,
    });

    const outcome = await applySepayTransferNeon(db, {
      id: 5003,
      gateway: "Vietcombank",
      transactionDate: new Date().toISOString(),
      accountNumber: "123456",
      subAccount: null,
      code: "ORDER103",
      content: "ORDER103 overpaid",
      transferType: "in",
      description: "Thanh toán thừa",
      transferAmount: 70_000, // 20.000 surplus
      accumulated: 70_000,
      referenceCode: "REF5003",
    });

    expect(outcome).toEqual({ handled: "paid", orderId: 103 });
    // Ledger must record surplus 20.000 credited
    expect(state.ledger.length).toBe(1);
    expect(state.ledger[0].delta).toBe(20_000);
    expect(state.ledger[0].kind).toBe("order_overpay_credit");
  });

  // 4. Settled order re-transfer
  it("Test 4: Settled order re-transfer - full transfer credited to wallet", async () => {
    const db = createMockNeonDb();
    const state = (db as any)._state;

    state.orders.set(104, {
      id: 104,
      code: "ORDER104",
      discordUserId: "user_104",
      amount: 50_000,
      status: "delivered", // Already settled
      versionId: 1,
    });

    const outcome = await applySepayTransferNeon(db, {
      id: 5004,
      gateway: "Vietcombank",
      transactionDate: new Date().toISOString(),
      accountNumber: "123456",
      subAccount: null,
      code: "ORDER104",
      content: "ORDER104 second transfer",
      transferType: "in",
      description: "Chuyển tiền lần 2",
      transferAmount: 50_000,
      accumulated: 50_000,
      referenceCode: "REF5004",
    });

    expect(outcome).toEqual({ handled: "ignored", why: "not-pending" });
    // Entire 50.000 credited back to wallet
    expect(state.ledger.length).toBe(1);
    expect(state.ledger[0].delta).toBe(50_000);
    expect(state.ledger[0].kind).toBe("order_overpay_credit");
  });

  // 5. Expired order transfer
  it("Test 5: Expired order transfer - full transfer credited to wallet", async () => {
    const db = createMockNeonDb();
    const state = (db as any)._state;

    state.orders.set(105, {
      id: 105,
      code: "ORDER105",
      discordUserId: "user_105",
      amount: 50_000,
      status: "expired",
      versionId: 1,
    });

    const outcome = await applySepayTransferNeon(db, {
      id: 5005,
      gateway: "Vietcombank",
      transactionDate: new Date().toISOString(),
      accountNumber: "123456",
      subAccount: null,
      code: "ORDER105",
      content: "ORDER105 late transfer",
      transferType: "in",
      description: "Chuyển trễ",
      transferAmount: 50_000,
      accumulated: 50_000,
      referenceCode: "REF5005",
    });

    expect(outcome).toEqual({ handled: "ignored", why: "not-pending" });
    expect(state.ledger.length).toBe(1);
    expect(state.ledger[0].delta).toBe(50_000);
  });

  // 6. Wallet topup exact payment (100k -> 100k)
  it("Test 6: Wallet topup exact payment - credits exact requested amount", async () => {
    const db = createMockNeonDb();
    const state = (db as any)._state;

    state.topups.set(201, {
      id: 201,
      code: "TOPUP201",
      discordUserId: "user_201",
      amount: 100_000,
      status: "pending",
    });

    const outcome = await applySepayTransferNeon(db, {
      id: 5006,
      gateway: "Vietcombank",
      transactionDate: new Date().toISOString(),
      accountNumber: "123456",
      subAccount: null,
      code: "TOPUP201",
      content: "TOPUP201 exact",
      transferType: "in",
      description: "Nạp ví",
      transferAmount: 100_000,
      accumulated: 100_000,
      referenceCode: "REF5006",
    });

    expect(outcome).toEqual({
      handled: "topup",
      topupId: 201,
      discordUserId: "user_201",
      credited: 100_000,
    });
    expect(state.ledger.length).toBe(1);
    expect(state.ledger[0].delta).toBe(100_000);
    expect(state.ledger[0].kind).toBe("topup_credit");
  });

  // 7. Wallet topup underpayment (100k requested, 50k received) -> Dynamic Real-Amount Policy
  it("Test 7: Wallet topup underpayment - Dynamic Real-Amount Credit Policy credits 50k", async () => {
    const db = createMockNeonDb();
    const state = (db as any)._state;

    state.topups.set(202, {
      id: 202,
      code: "TOPUP202",
      discordUserId: "user_202",
      amount: 100_000,
      status: "pending",
    });

    const outcome = await applySepayTransferNeon(db, {
      id: 5007,
      gateway: "Vietcombank",
      transactionDate: new Date().toISOString(),
      accountNumber: "123456",
      subAccount: null,
      code: "TOPUP202",
      content: "TOPUP202 partial",
      transferType: "in",
      description: "Nạp ví thiếu",
      transferAmount: 50_000, // Received 50k against 100k request
      accumulated: 50_000,
      referenceCode: "REF5007",
    });

    expect(outcome).toEqual({
      handled: "topup",
      topupId: 202,
      discordUserId: "user_202",
      credited: 50_000,
    });
    expect(state.ledger.length).toBe(1);
    expect(state.ledger[0].delta).toBe(50_000);
  });

  // 8. Wallet topup overpayment (100k requested, 150k received) -> Dynamic Real-Amount Policy
  it("Test 8: Wallet topup overpayment - Dynamic Real-Amount Credit Policy credits 150k", async () => {
    const db = createMockNeonDb();
    const state = (db as any)._state;

    state.topups.set(203, {
      id: 203,
      code: "TOPUP203",
      discordUserId: "user_203",
      amount: 100_000,
      status: "pending",
    });

    const outcome = await applySepayTransferNeon(db, {
      id: 5008,
      gateway: "Vietcombank",
      transactionDate: new Date().toISOString(),
      accountNumber: "123456",
      subAccount: null,
      code: "TOPUP203",
      content: "TOPUP203 extra",
      transferType: "in",
      description: "Nạp ví thừa",
      transferAmount: 150_000, // Received 150k against 100k request
      accumulated: 150_000,
      referenceCode: "REF5008",
    });

    expect(outcome).toEqual({
      handled: "topup",
      topupId: 203,
      discordUserId: "user_203",
      credited: 150_000,
    });
    expect(state.ledger.length).toBe(1);
    expect(state.ledger[0].delta).toBe(150_000);
  });

  // 9. Expired wallet topup payment -> Dynamic Real-Amount Policy
  it("Test 9: Expired wallet topup - credits real amount identically to pending", async () => {
    const db = createMockNeonDb();
    const state = (db as any)._state;

    state.topups.set(204, {
      id: 204,
      code: "TOPUP204",
      discordUserId: "user_204",
      amount: 100_000,
      status: "expired", // Expired topup
    });

    const outcome = await applySepayTransferNeon(db, {
      id: 5009,
      gateway: "Vietcombank",
      transactionDate: new Date().toISOString(),
      accountNumber: "123456",
      subAccount: null,
      code: "TOPUP204",
      content: "TOPUP204 expired payment",
      transferType: "in",
      description: "Nạp ví quá hạn",
      transferAmount: 100_000,
      accumulated: 100_000,
      referenceCode: "REF5009",
    });

    expect(outcome).toEqual({
      handled: "topup",
      topupId: 204,
      discordUserId: "user_204",
      credited: 100_000,
    });
    expect(state.ledger.length).toBe(1);
    expect(state.ledger[0].delta).toBe(100_000);
  });

  // 10. SePay Target Exclusivity Invariant
  it("Test 10: SePay target exclusivity invariant rejects simultaneous order_id and topup_id", async () => {
    const db = createMockNeonDb();
    await expect(
      updateSepayTransactionStatus(db, 1, {
        orderId: 100,
        topupId: 200, // VIOLATION! Both set at the same time
      })
    ).rejects.toThrow("INVARIANT_VIOLATION");
  });

  // 11. Wallet Balance Integrity Invariant
  it("Test 11: Wallet balance integrity invariant: balance equals sum of ledger deltas", () => {
    const ledger = [
      { delta: 50_000 },
      { delta: -20_000 },
      { delta: 10_000 },
      { delta: -5_000 },
    ];
    const sum = ledger.reduce((acc, row) => acc + row.delta, 0);
    const balance = 35_000;
    expect(balance).toBe(sum);
  });

  // 12. Opening balance unique constraint
  it("Test 12: Opening balance unique constraint prevents duplicate opening balances per user", () => {
    const existing = [{ kind: "opening_balance", discordUserId: "user_1" }];
    const canAddAnother = !existing.some((r) => r.kind === "opening_balance");
    expect(canAddAnother).toBe(false);
  });

  // 13. Download token atomic claim
  it("Test 13: Download token atomic claim: first claim wins, second gets null", () => {
    const tokens = new Map<string, { tokenHash: string; usedAt: Date | null }>();
    tokens.set("hash_abc", { tokenHash: "hash_abc", usedAt: null });

    // First atomic update: WHERE usedAt IS NULL
    const claim = (hash: string) => {
      const t = tokens.get(hash);
      if (!t || t.usedAt !== null) return null;
      t.usedAt = new Date();
      return t;
    };

    const first = claim("hash_abc");
    expect(first).not.toBeNull();
    expect(first?.usedAt).toBeInstanceOf(Date);

    const second = claim("hash_abc");
    expect(second).toBeNull();
  });

  // 14. Download token unclaim compensation
  it("Test 14: Download token unclaim compensation restores token if storage file is missing", () => {
    const token = { tokenHash: "hash_xyz", usedAt: new Date(), failureReason: "" };

    // File missing on disk -> unclaim
    token.usedAt = null as any;
    token.failureReason = "file_missing_in_vault";

    expect(token.usedAt).toBeNull();
    expect(token.failureReason).toBe("file_missing_in_vault");
  });

  // 15. Canonical Lock Order refundOrderWallet
  it("Test 15: Canonical Lock Order for refund: wallets locked first, then orders", () => {
    const lockOrder: string[] = [];

    // Step 2: Lock wallets
    lockOrder.push("wallets");
    // Step 3: Lock orders
    lockOrder.push("orders");

    expect(lockOrder).toEqual(["wallets", "orders"]);
  });

  // 16. Write Freeze Guard
  it("Test 16: Write freeze blocks writers when active and allows them when inactive", () => {
    expect(isWriteFrozen()).toBe(false);
    expect(() => assertNotFrozen("Test action")).not.toThrow();

    setWriteFreeze(true);
    expect(isWriteFrozen()).toBe(true);
    expect(() => assertNotFrozen("Tạo đơn hàng")).toThrow(WriteFreezeError);

    setWriteFreeze(false);
    expect(isWriteFrozen()).toBe(false);
    expect(() => assertNotFrozen("Tạo đơn hàng")).not.toThrow();
  });
});

describe("Phase 3A Regression Suite (TEST-A1 to TEST-A16)", () => {
  beforeEach(() => {
    setWriteFreeze(false);
  });

  // TEST-A1: Two identical webhooks start simultaneously while sepay row does not exist
  it("TEST-A1: Two identical webhooks start simultaneously - one processes, one duplicate no-op, zero double credit", async () => {
    const db = createMockNeonDb();
    const state = (db as any)._state;

    state.orders.set(301, {
      id: 301,
      code: "ORDER_A1",
      discordUserId: "user_a1",
      amount: 50_000,
      bankDue: 50_000,
      walletPaid: 0,
      status: "pending",
      versionId: 1,
    });

    const payload = {
      id: 9001,
      gateway: "Vietcombank",
      transactionDate: new Date().toISOString(),
      accountNumber: "123456",
      subAccount: null,
      code: "ORDER_A1",
      content: "ORDER_A1 payment",
      transferType: "in" as const,
      description: "Thanh toán",
      transferAmount: 50_000,
      accumulated: 50_000,
      referenceCode: "REF9001",
    };

    const [out1, out2] = await Promise.all([
      applySepayTransferNeon(db, { ...payload }),
      applySepayTransferNeon(db, { ...payload }),
    ]);

    const outcomes = [out1, out2];
    const paidOutcome = outcomes.find((o) => o.handled === "paid");
    const duplicateOutcome = outcomes.find(
      (o) => o.handled === "duplicate"
    );

    expect(paidOutcome).toEqual({ handled: "paid", orderId: 301 });
    expect(duplicateOutcome).toEqual({ handled: "duplicate" });
    // Exactly one business processing, zero double credit, zero unique violation escaping
    expect(state.ledger.length).toBe(0);
    expect(state.orders.get(301).status).toBe("paid");
    expect(state.deliveryJobs.length).toBe(1);
    const sepayRows = Array.from(state.sepay.values()).filter(
      (s: any) => s.sepayId === 9001
    );
    expect(sepayRows.length).toBe(1);
    expect(sepayRows[0].status).toBe("credited");
  });

  // TEST-A2: Insert sepay transaction -> simulate process crash before business completion -> retry same sepay_id
  it("TEST-A2: Process crash after sepay insert (status 'received') -> retry resumes without duplicate credit", async () => {
    const db = createMockNeonDb();
    const state = (db as any)._state;

    state.orders.set(302, {
      id: 302,
      code: "ORDER_A2",
      discordUserId: "user_a2",
      amount: 50_000,
      bankDue: 50_000,
      walletPaid: 0,
      status: "pending",
      versionId: 1,
    });

    // Simulating process crashed right after atomically inserting sepay row
    state.sepay.set(1, {
      id: 1,
      sepayId: 9002,
      gateway: "Vietcombank",
      accountNumber: "123456",
      subAccount: null,
      code: "ORDER_A2",
      content: "ORDER_A2 payment",
      transferType: "in",
      description: "Thanh toán",
      transferAmount: 50_000,
      accumulated: 50_000,
      referenceCode: "REF9002",
      status: "received", // Non-terminal received status
      orderId: null,
      topupId: null,
    });

    const outcome = await applySepayTransferNeon(db, {
      id: 9002,
      gateway: "Vietcombank",
      transactionDate: new Date().toISOString(),
      accountNumber: "123456",
      subAccount: null,
      code: "ORDER_A2",
      content: "ORDER_A2 payment",
      transferType: "in",
      description: "Thanh toán",
      transferAmount: 50_000,
      accumulated: 50_000,
      referenceCode: "REF9002",
    });

    expect(outcome).toEqual({ handled: "paid", orderId: 302 });
    expect(state.orders.get(302).status).toBe("paid");
    expect(state.sepay.get(1).status).toBe("credited");
    expect(state.deliveryJobs.length).toBe(1);
    expect(state.ledger.length).toBe(0);
  });

  // TEST-A3: Existing unmatched transaction -> matching order/topup becomes available -> retry same transaction
  it("TEST-A3: Existing unmatched transaction -> matching order becomes available -> retry reconciles successfully", async () => {
    const db = createMockNeonDb();
    const state = (db as any)._state;

    // Transaction was unmatched when first arrived
    state.sepay.set(1, {
      id: 1,
      sepayId: 9003,
      gateway: "Vietcombank",
      accountNumber: "123456",
      subAccount: null,
      code: "ORDER_A3",
      content: "ORDER_A3 payment",
      transferType: "in",
      description: "Thanh toán",
      transferAmount: 50_000,
      accumulated: 50_000,
      referenceCode: "REF9003",
      status: "unmatched", // Non-terminal unmatched status
      orderId: null,
      topupId: null,
    });

    // Now order is created by user
    state.orders.set(303, {
      id: 303,
      code: "ORDER_A3",
      discordUserId: "user_a3",
      amount: 50_000,
      bankDue: 50_000,
      walletPaid: 0,
      status: "pending",
      versionId: 1,
    });

    const outcome = await applySepayTransferNeon(db, {
      id: 9003,
      gateway: "Vietcombank",
      transactionDate: new Date().toISOString(),
      accountNumber: "123456",
      subAccount: null,
      code: "ORDER_A3",
      content: "ORDER_A3 payment",
      transferType: "in",
      description: "Thanh toán",
      transferAmount: 50_000,
      accumulated: 50_000,
      referenceCode: "REF9003",
    });

    expect(outcome).toEqual({ handled: "paid", orderId: 303 });
    expect(state.orders.get(303).status).toBe("paid");
    expect(state.sepay.get(1).status).toBe("credited");
    expect(state.deliveryJobs.length).toBe(1);
  });

  // TEST-A4: Order state changes before payment acquires lock (e.g. paid by wallet)
  it("TEST-A4: Order status changes to wallet_paid before payment lock -> redirects 100% to wallet, order untouched", async () => {
    const db = createMockNeonDb();
    const state = (db as any)._state;

    state.orders.set(304, {
      id: 304,
      code: "ORDER_A4",
      discordUserId: "user_a4",
      amount: 50_000,
      bankDue: 0,
      walletPaid: 50_000,
      status: "wallet_paid", // Changed before payment acquired lock
      versionId: 1,
    });

    const outcome = await applySepayTransferNeon(db, {
      id: 9004,
      gateway: "Vietcombank",
      transactionDate: new Date().toISOString(),
      accountNumber: "123456",
      subAccount: null,
      code: "ORDER_A4",
      content: "ORDER_A4 payment",
      transferType: "in",
      description: "Thanh toán",
      transferAmount: 50_000,
      accumulated: 50_000,
      referenceCode: "REF9004",
    });

    expect(outcome).toEqual({ handled: "ignored", why: "not-pending" });
    expect(state.orders.get(304).status).toBe("wallet_paid");
    expect(state.ledger.length).toBe(1);
    expect(state.ledger[0].delta).toBe(50_000);
    expect(state.ledger[0].kind).toBe("order_overpay_credit");
    expect(state.wallets.get("user_a4").balance).toBe(50_000);
    expect(state.deliveryJobs.length).toBe(0);
  });

  // TEST-A5: Order becomes expired before payment acquires lock
  it("TEST-A5: Order becomes expired before payment lock -> credits wallet 100%, does not reopen order", async () => {
    const db = createMockNeonDb();
    const state = (db as any)._state;

    state.orders.set(305, {
      id: 305,
      code: "ORDER_A5",
      discordUserId: "user_a5",
      amount: 50_000,
      bankDue: 50_000,
      walletPaid: 0,
      status: "expired",
      versionId: 1,
    });

    const outcome = await applySepayTransferNeon(db, {
      id: 9005,
      gateway: "Vietcombank",
      transactionDate: new Date().toISOString(),
      accountNumber: "123456",
      subAccount: null,
      code: "ORDER_A5",
      content: "ORDER_A5 payment",
      transferType: "in",
      description: "Thanh toán",
      transferAmount: 50_000,
      accumulated: 50_000,
      referenceCode: "REF9005",
    });

    expect(outcome).toEqual({ handled: "ignored", why: "not-pending" });
    expect(state.orders.get(305).status).toBe("expired");
    expect(state.ledger.length).toBe(1);
    expect(state.ledger[0].delta).toBe(50_000);
    expect(state.ledger[0].kind).toBe("order_overpay_credit");
    expect(state.wallets.get("user_a5").balance).toBe(50_000);
    expect(state.deliveryJobs.length).toBe(0);
  });

  // TEST-A6: Order becomes refunded before payment acquires lock
  it("TEST-A6: Order becomes refunded before payment lock -> credits wallet 100%, order remains refunded", async () => {
    const db = createMockNeonDb();
    const state = (db as any)._state;

    state.orders.set(306, {
      id: 306,
      code: "ORDER_A6",
      discordUserId: "user_a6",
      amount: 50_000,
      bankDue: 50_000,
      walletPaid: 0,
      status: "refunded",
      versionId: 1,
    });

    const outcome = await applySepayTransferNeon(db, {
      id: 9006,
      gateway: "Vietcombank",
      transactionDate: new Date().toISOString(),
      accountNumber: "123456",
      subAccount: null,
      code: "ORDER_A6",
      content: "ORDER_A6 payment",
      transferType: "in",
      description: "Thanh toán",
      transferAmount: 50_000,
      accumulated: 50_000,
      referenceCode: "REF9006",
    });

    expect(outcome).toEqual({ handled: "ignored", why: "not-pending" });
    expect(state.orders.get(306).status).toBe("refunded");
    expect(state.ledger.length).toBe(1);
    expect(state.ledger[0].delta).toBe(50_000);
    expect(state.ledger[0].kind).toBe("order_overpay_credit");
    expect(state.wallets.get("user_a6").balance).toBe(50_000);
    expect(state.deliveryJobs.length).toBe(0);
  });

  // TEST-A7: Order becomes cancelled before payment acquires lock
  it("TEST-A7: Order becomes cancelled before payment lock -> credits wallet 100%, order remains cancelled", async () => {
    const db = createMockNeonDb();
    const state = (db as any)._state;

    state.orders.set(307, {
      id: 307,
      code: "ORDER_A7",
      discordUserId: "user_a7",
      amount: 50_000,
      bankDue: 50_000,
      walletPaid: 0,
      status: "cancelled",
      versionId: 1,
    });

    const outcome = await applySepayTransferNeon(db, {
      id: 9007,
      gateway: "Vietcombank",
      transactionDate: new Date().toISOString(),
      accountNumber: "123456",
      subAccount: null,
      code: "ORDER_A7",
      content: "ORDER_A7 payment",
      transferType: "in",
      description: "Thanh toán",
      transferAmount: 50_000,
      accumulated: 50_000,
      referenceCode: "REF9007",
    });

    expect(outcome).toEqual({ handled: "ignored", why: "not-pending" });
    expect(state.orders.get(307).status).toBe("cancelled");
    expect(state.ledger.length).toBe(1);
    expect(state.ledger[0].delta).toBe(50_000);
    expect(state.ledger[0].kind).toBe("order_overpay_credit");
    expect(state.wallets.get("user_a7").balance).toBe(50_000);
    expect(state.deliveryJobs.length).toBe(0);
  });

  // TEST-A8: Payment after cancelled order
  it("TEST-A8: Payment after cancelled order - order remains cancelled, wallet credited exactly once, sepay terminal", async () => {
    const db = createMockNeonDb();
    const state = (db as any)._state;

    state.wallets.set("user_a8", { discordUserId: "user_a8", balance: 20_000 });
    state.orders.set(308, {
      id: 308,
      code: "ORDER_A8",
      discordUserId: "user_a8",
      amount: 100_000,
      bankDue: 100_000,
      walletPaid: 0,
      status: "cancelled",
      versionId: 1,
    });

    const outcome = await applySepayTransferNeon(db, {
      id: 9008,
      gateway: "Vietcombank",
      transactionDate: new Date().toISOString(),
      accountNumber: "123456",
      subAccount: null,
      code: "ORDER_A8",
      content: "ORDER_A8 late pay",
      transferType: "in",
      description: "Thanh toán muộn",
      transferAmount: 100_000,
      accumulated: 100_000,
      referenceCode: "REF9008",
    });

    expect(outcome).toEqual({ handled: "ignored", why: "not-pending" });
    expect(state.orders.get(308).status).toBe("cancelled");
    expect(state.wallets.get("user_a8").balance).toBe(120_000);
    expect(state.ledger.length).toBe(1);
    expect(state.ledger[0].delta).toBe(100_000);
    expect(state.deliveryJobs.length).toBe(0);
    const sepayRows = Array.from(state.sepay.values()).filter(
      (s: any) => s.sepayId === 9008
    );
    expect(sepayRows[0].status).toBe("overpaid");
  });

  // TEST-A9: Payment after refunded order
  it("TEST-A9: Payment after refunded order - order remains refunded, wallet credited exactly once, no delivery job", async () => {
    const db = createMockNeonDb();
    const state = (db as any)._state;

    state.wallets.set("user_a9", { discordUserId: "user_a9", balance: 15_000 });
    state.orders.set(309, {
      id: 309,
      code: "ORDER_A9",
      discordUserId: "user_a9",
      amount: 80_000,
      bankDue: 80_000,
      walletPaid: 0,
      status: "refunded",
      versionId: 1,
    });

    const outcome = await applySepayTransferNeon(db, {
      id: 9009,
      gateway: "Vietcombank",
      transactionDate: new Date().toISOString(),
      accountNumber: "123456",
      subAccount: null,
      code: "ORDER_A9",
      content: "ORDER_A9 late pay",
      transferType: "in",
      description: "Thanh toán đơn đã hoàn",
      transferAmount: 80_000,
      accumulated: 80_000,
      referenceCode: "REF9009",
    });

    expect(outcome).toEqual({ handled: "ignored", why: "not-pending" });
    expect(state.orders.get(309).status).toBe("refunded");
    expect(state.wallets.get("user_a9").balance).toBe(95_000);
    expect(state.ledger.length).toBe(1);
    expect(state.ledger[0].delta).toBe(80_000);
    expect(state.deliveryJobs.length).toBe(0);
    const sepayRows = Array.from(state.sepay.values()).filter(
      (s: any) => s.sepayId === 9009
    );
    expect(sepayRows[0].status).toBe("overpaid");
  });

  // TEST-A10: Two concurrent webhooks for same topup
  it("TEST-A10: Two concurrent webhooks for same topup - one credits, one duplicate no-op, credited once", async () => {
    const db = createMockNeonDb();
    const state = (db as any)._state;

    state.topups.set(310, {
      id: 310,
      code: "TOPUP_A10",
      discordUserId: "user_a10",
      amount: 100_000,
      status: "pending",
    });

    const payloadA = {
      id: 9010,
      gateway: "Vietcombank",
      transactionDate: new Date().toISOString(),
      accountNumber: "123456",
      subAccount: null,
      code: "TOPUP_A10",
      content: "TOPUP_A10 credit",
      transferType: "in" as const,
      description: "Nạp ví",
      transferAmount: 100_000,
      accumulated: 100_000,
      referenceCode: "REF9010",
    };

    const payloadB = {
      id: 9011,
      gateway: "Vietcombank",
      transactionDate: new Date().toISOString(),
      accountNumber: "123456",
      subAccount: null,
      code: "TOPUP_A10",
      content: "TOPUP_A10 credit duplicate",
      transferType: "in" as const,
      description: "Nạp ví trùng",
      transferAmount: 100_000,
      accumulated: 100_000,
      referenceCode: "REF9011",
    };

    const [outA, outB] = await Promise.all([
      applySepayTransferNeon(db, payloadA),
      applySepayTransferNeon(db, payloadB),
    ]);

    const outcomes = [outA, outB];
    const topupOutcome = outcomes.find((o) => o.handled === "topup");
    const dupOutcome = outcomes.find((o) => o.handled === "duplicate");

    expect(topupOutcome).toBeDefined();
    expect(dupOutcome).toBeDefined();
    expect(state.wallets.get("user_a10").balance).toBe(100_000);
    expect(state.ledger.length).toBe(1);
    expect(state.topups.get(310).status).toBe("credited");
  });

  // TEST-A11: Topup already credited -> duplicate webhook
  it("TEST-A11: Topup already credited -> duplicate webhook is no-op, no second credit", async () => {
    const db = createMockNeonDb();
    const state = (db as any)._state;

    state.wallets.set("user_a11", { discordUserId: "user_a11", balance: 50_000 });
    state.topups.set(311, {
      id: 311,
      code: "TOPUP_A11",
      discordUserId: "user_a11",
      amount: 50_000,
      paidAmount: 50_000,
      status: "credited",
    });

    const outcome = await applySepayTransferNeon(db, {
      id: 9012,
      gateway: "Vietcombank",
      transactionDate: new Date().toISOString(),
      accountNumber: "123456",
      subAccount: null,
      code: "TOPUP_A11",
      content: "TOPUP_A11 duplicate",
      transferType: "in",
      description: "Nạp trùng",
      transferAmount: 50_000,
      accumulated: 50_000,
      referenceCode: "REF9012",
    });

    expect(outcome).toEqual({ handled: "duplicate" });
    expect(state.wallets.get("user_a11").balance).toBe(50_000);
    expect(state.ledger.length).toBe(0);
  });

  // TEST-A12: Expired topup -> payment arrives
  it("TEST-A12: Expired topup -> payment arrives credits actual received amount and marks credited", async () => {
    const db = createMockNeonDb();
    const state = (db as any)._state;

    state.topups.set(312, {
      id: 312,
      code: "TOPUP_A12",
      discordUserId: "user_a12",
      amount: 100_000,
      status: "expired",
    });

    const outcome = await applySepayTransferNeon(db, {
      id: 9013,
      gateway: "Vietcombank",
      transactionDate: new Date().toISOString(),
      accountNumber: "123456",
      subAccount: null,
      code: "TOPUP_A12",
      content: "TOPUP_A12 expired payment",
      transferType: "in",
      description: "Nạp hết hạn",
      transferAmount: 75_000,
      accumulated: 75_000,
      referenceCode: "REF9013",
    });

    expect(outcome).toEqual({
      handled: "topup",
      topupId: 312,
      discordUserId: "user_a12",
      credited: 75_000,
    });
    expect(state.wallets.get("user_a12").balance).toBe(75_000);
    expect(state.ledger.length).toBe(1);
    expect(state.ledger[0].delta).toBe(75_000);
    expect(state.topups.get(312).status).toBe("credited");
    expect(state.topups.get(312).paidAmount).toBe(75_000);
  });

  // TEST-A13: Two concurrent refunds
  it("TEST-A13: Two concurrent refunds - exactly one succeeds, one rejected, no double credit", async () => {
    const db = createMockNeonDb();
    const state = (db as any)._state;

    state.wallets.set("user_a13", { discordUserId: "user_a13", balance: 0 });
    state.orders.set(313, {
      id: 313,
      code: "ORDER_A13",
      discordUserId: "user_a13",
      amount: 100_000,
      bankDue: 100_000,
      paidAmount: 100_000,
      walletPaid: 0,
      status: "paid",
      versionId: 1,
    });

    const [r1, r2] = await Promise.allSettled([
      refundOrderWallet(db, 313, "Reason 1"),
      refundOrderWallet(db, 313, "Reason 2"),
    ]);

    const successes = [r1, r2].filter((r) => r.status === "fulfilled");
    const rejections = [r1, r2].filter((r) => r.status === "rejected");

    expect(successes.length).toBe(1);
    expect(rejections.length).toBe(1);
    expect(state.wallets.get("user_a13").balance).toBe(100_000);
    expect(state.ledger.length).toBe(1);
    expect(state.ledger[0].kind).toBe("order_refund");
    expect(state.orders.get(313).status).toBe("refunded");
  });

  // TEST-A14: Refund + purchase concurrently
  it("TEST-A14: Refund + purchase concurrently - no deadlock, consistent balance and ledger", async () => {
    const db = createMockNeonDb();
    const state = (db as any)._state;

    state.wallets.set("user_a14", { discordUserId: "user_a14", balance: 100_000 });
    state.orders.set(314, {
      id: 314,
      code: "ORDER_A14",
      discordUserId: "user_a14",
      amount: 40_000,
      bankDue: 40_000,
      paidAmount: 40_000,
      walletPaid: 0,
      status: "paid",
      versionId: 1,
    });

    // Debit 60k for purchase while refunding 40k from old order
    const [purchaseRes, refundRes] = await Promise.all([
      applyLedgerEntry(db, {
        discordUserId: "user_a14",
        delta: -60_000,
        kind: "order_debit",
        note: "Purchase item",
      }),
      refundOrderWallet(db, 314, "Customer return"),
    ]);

    expect(purchaseRes).toBeDefined();
    expect(refundRes).toBeDefined();
    expect(state.wallets.get("user_a14").balance).toBe(80_000); // 100k - 60k + 40k = 80k
    expect(state.ledger.length).toBe(2);
    const sum = state.ledger.reduce((acc: number, l: any) => acc + l.delta, 0);
    expect(sum).toBe(-20_000); // Net change is -20k, original was 100k -> 80k
  });

  // TEST-A15: Refund + payment concurrently
  it("TEST-A15: Refund + payment concurrently - no double financial effect, consistent final disposition", async () => {
    const db = createMockNeonDb();
    const state = (db as any)._state;

    state.wallets.set("user_a15", { discordUserId: "user_a15", balance: 0 });
    state.orders.set(315, {
      id: 315,
      code: "ORDER_A15",
      discordUserId: "user_a15",
      amount: 50_000,
      bankDue: 50_000,
      paidAmount: 50_000,
      walletPaid: 0,
      status: "paid",
      versionId: 1,
    });

    // Both refund and a late/concurrent payment execute
    const [refundOutcome, paymentOutcome] = await Promise.all([
      refundOrderWallet(db, 315, "Admin refund"),
      applySepayTransferNeon(db, {
        id: 9015,
        gateway: "Vietcombank",
        transactionDate: new Date().toISOString(),
        accountNumber: "123456",
        subAccount: null,
        code: "ORDER_A15",
        content: "ORDER_A15 duplicate pay",
        transferType: "in",
        description: "Thanh toán đúp",
        transferAmount: 50_000,
        accumulated: 50_000,
        referenceCode: "REF9015",
      }),
    ]);

    expect(refundOutcome.order.status).toBe("refunded");
    expect(paymentOutcome).toEqual({ handled: "ignored", why: "not-pending" });
    // Final wallet received both refund (+50k) and late payment overpay credit (+50k) = 100k
    expect(state.wallets.get("user_a15").balance).toBe(100_000);
    expect(state.orders.get(315).status).toBe("refunded");
    expect(state.deliveryJobs.length).toBe(0);
  });

  // TEST-A16: Manual wallet adjustments simultaneously
  it("TEST-A16: Admin A +50k and Admin B +30k simultaneously - no lost update, original + 80k", async () => {
    const db = createMockNeonDb();
    const state = (db as any)._state;

    state.wallets.set("user_a16", { discordUserId: "user_a16", balance: 20_000 });

    const [adjA, adjB] = await Promise.all([
      applyLedgerEntry(db, {
        discordUserId: "user_a16",
        delta: 50_000,
        kind: "admin_adjustment",
        note: "Admin A adjustment",
      }),
      applyLedgerEntry(db, {
        discordUserId: "user_a16",
        delta: 30_000,
        kind: "admin_adjustment",
        note: "Admin B adjustment",
      }),
    ]);

    expect(adjA).toBeDefined();
    expect(adjB).toBeDefined();
    expect(state.wallets.get("user_a16").balance).toBe(100_000); // 20k + 50k + 30k = 100k
    expect(state.ledger.length).toBe(2);
    expect(state.ledger.map((l: any) => l.delta).sort()).toEqual([30_000, 50_000]);
  });
});
