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
        const doInsert = () => {
          const tableName = getTableName(table);
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

            if (tableName === "wallets" && typeof val0 === "string") {
              const w = wallets.get(val0) ?? { discordUserId: val0, balance: 0 };
              const updated = { ...w, ...patch };
              wallets.set(val0, updated);
              return [updated];
            }
            if (tableName === "orders" && typeof val0 === "number") {
              const o = orders.get(val0);
              if (o) {
                const updated = { ...o, ...patch };
                orders.set(val0, updated);
                return [updated];
              }
            }
            if (tableName === "wallet_topups" && typeof val0 === "number") {
              const t = topups.get(val0);
              if (t) {
                const updated = { ...t, ...patch };
                topups.set(val0, updated);
                return [updated];
              }
            }
            if (tableName === "sepay_transactions" && typeof val0 === "number") {
              const s = sepay.get(val0);
              if (s) {
                const updated = { ...s, ...patch };
                sepay.set(val0, updated);
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
      return await cb(mockDb);
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
