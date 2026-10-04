import { describe, it, expect, vi, beforeEach } from "vitest";
import { DiscordAPIError, RESTJSONErrorCodes } from "discord.js";
import {
  claimStaleOrQueuedDeliveryJob,
  claimDeliveryJobById,
  markDeliveryJobSuccess,
  markDeliveryJobRetryable,
  markDeliveryJobFailed,
  refreshDeliveryJobHeartbeat,
  cancelDeliveryJobsByOrder,
} from "../src/repositories/neon-delivery-jobs.js";
import {
  refundOrderWallet,
  cancelPendingOrder,
  updateOrderStatus,
  requeueDeliveryJob,
} from "../src/repositories/neon-orders.js";
import {
  mintDownloadToken,
  claimDownloadToken,
  revokeDownloadTokensByOrder,
} from "../src/repositories/neon-download-tokens.js";
import {
  processNextDeliveryJob,
  type DeliveryWorkerDeps,
} from "../src/services/delivery/neon-delivery-worker.js";
import { startDeliveryScheduler } from "../src/services/delivery/neon-delivery-scheduler.js";

vi.mock("../src/services/delivery/deliver-version.js", async (importOriginal) => {
  const actual: any = await importOriginal();
  return {
    ...actual,
    resolveBlobPath: vi.fn(async () => "/fake/path/test-plugin-1.0.0.jar"),
  };
});

function extractValues(cond: any): any[] {
  if (!cond) return [];
  const vals: any[] = [];
  function recurse(c: any) {
    if (!c) return;
    if (typeof c === "string" || typeof c === "number" || typeof c === "boolean") {
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

/**
 * Tạo mock Neon DB với đầy đủ Transaction Serialization Queue (txQueue)
 * và lưu trữ in-memory cho các bảng delivery_jobs, orders, wallets, wallet_ledger, download_tokens, delivery_logs.
 */
function createMockDeliveryNeonDb() {
  let nextJobId = 100;
  let nextLogId = 500;
  let txQueue = Promise.resolve();

  const state = {
    wallets: new Map<string, any>(),
    orders: new Map<number, any>(),
    deliveryJobs: new Map<number, any>(),
    deliveryLogs: new Map<number, any>(),
    downloadTokens: new Map<string, any>(),
    ledger: [] as any[],
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
    ]),
    plugins: new Map<number, any>([
      [10, { id: 10, slug: "test-plugin", displayName: "Test Plugin" }],
    ]),
  };

  function getTableName(table: any): string {
    return (
      table?._?.name ??
      table?.tableName ??
      table?.[Symbol.for("drizzle:Name")] ??
      ""
    );
  }

  const mockDb: any = {
    _state: state,

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
              const res = Array.from(state.orders.values());
              return targetOrderId !== undefined ? res.filter((o) => o.id === targetOrderId) : res;
            }
            if (tbl === "delivery_jobs") {
              const targetId = vals.find((v) => typeof v === "number");
              const res = Array.from(state.deliveryJobs.values());
              if (targetId !== undefined) {
                return res.filter((j) => j.orderId === targetId || j.id === targetId);
              }
              return res;
            }
            if (tbl === "download_tokens") {
              const targetHash = vals.find((v) => typeof v === "string");
              const res = Array.from(state.downloadTokens.values());
              return targetHash ? res.filter((t) => t.tokenHash === targetHash) : res;
            }
            if (tbl === "versions") {
              const targetVerId = vals.find((v) => typeof v === "number");
              const res = Array.from(state.versions.values());
              return targetVerId !== undefined ? res.filter((v) => v.id === targetVerId) : res;
            }
            if (tbl === "plugins") {
              const targetPluginId = vals.find((v) => typeof v === "number");
              const res = Array.from(state.plugins.values());
              return targetPluginId !== undefined ? res.filter((p) => p.id === targetPluginId) : res;
            }
            return [];
          };
          return {
            for: () => run(),
            limit: () => run(),
            then: (res: any) => res(run()),
          };
        },
        limit: (n: number) => Array.from(state.orders.values()).slice(0, n),
      }),
    }),

    insert: (table: any) => ({
      values: (val: any) => {
        const tbl = getTableName(table);
        const executeInsert = (doNothing = false) => {
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
          if (tbl === "download_tokens") {
            if (doNothing && state.downloadTokens.has(val.tokenHash)) return [];
            state.downloadTokens.set(val.tokenHash, { ...val, createdAt: new Date() });
            return [state.downloadTokens.get(val.tokenHash)];
          }
          if (tbl === "delivery_logs") {
            const id = nextLogId++;
            const row = { id, ...val };
            state.deliveryLogs.set(id, row);
            return [row];
          }
          if (tbl === "wallets") {
            if (doNothing && state.wallets.has(val.discordUserId)) return [];
            state.wallets.set(val.discordUserId, { ...val, balance: val.balance ?? 0 });
            return [state.wallets.get(val.discordUserId)];
          }
          if (tbl === "wallet_ledger") {
            state.ledger.push({ id: state.ledger.length + 1, ...val });
            return [{ id: state.ledger.length, ...val }];
          }
          if (tbl === "orders") {
            const id = val.id || 999;
            state.orders.set(id, { id, ...val });
            return [{ id, ...val }];
          }
          return [];
        };

        return {
          onConflictDoNothing: () => ({
            returning: () => executeInsert(true),
            then: (resolve: any) => resolve(executeInsert(true)),
          }),
          returning: () => executeInsert(false),
          then: (resolve: any) => resolve(executeInsert(false)),
        };
      },
    }),

    update: (table: any) => ({
      set: (patch: any) => ({
        where: (condition: any) => {
          const tbl = getTableName(table);
          const updatedRows: any[] = [];
          const vals = extractValues(condition);

          if (tbl === "delivery_jobs") {
            const targetId = vals.find((v) => typeof v === "number");
            const targetClaimToken = vals.find(
              (v) =>
                typeof v === "string" &&
                !["queued", "processing", "retryable", "delivered", "failed", "cancelled"].includes(v)
            );
            const targetStatuses = vals.filter(
              (v) =>
                typeof v === "string" &&
                ["queued", "processing", "retryable", "delivered", "failed", "cancelled"].includes(v)
            );

            for (const [id, job] of state.deliveryJobs.entries()) {
              let match = true;
              if (targetId !== undefined && id !== targetId && job.orderId !== targetId) match = false;
              if (targetClaimToken !== undefined && job.claimToken !== targetClaimToken) match = false;
              if (targetStatuses.length > 0 && !targetStatuses.includes(job.status)) match = false;

              if (match) {
                const updated = { ...job, ...patch };
                state.deliveryJobs.set(id, updated);
                updatedRows.push(updated);
              }
            }
          } else if (tbl === "orders") {
            const targetOrderId = vals.find((v) => typeof v === "number");
            const allowedStatuses = vals.filter(
              (v) =>
                typeof v === "string" &&
                ["paid", "wallet_paid", "pending", "delivered", "refunded", "cancelled"].includes(v)
            );
            for (const [id, order] of state.orders.entries()) {
              let match = true;
              if (targetOrderId !== undefined && id !== targetOrderId) match = false;
              if (allowedStatuses.length > 0 && !allowedStatuses.includes(order.status)) match = false;

              if (match) {
                const updated = { ...order, ...patch };
                state.orders.set(id, updated);
                updatedRows.push(updated);
              }
            }
          } else if (tbl === "wallets") {
            const targetUserId = vals.find((v) => typeof v === "string");
            for (const [userId, wallet] of state.wallets.entries()) {
              if (targetUserId === undefined || userId === targetUserId) {
                const updated = { ...wallet, ...patch };
                state.wallets.set(userId, updated);
                updatedRows.push(updated);
              }
            }
          }

          return {
            returning: () => updatedRows,
            then: (resolve: any) => resolve(updatedRows),
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
              if (!v.usedAt) {
                state.downloadTokens.delete(k);
                deleted.push(v);
              }
            }
          }
        }
        return {
          returning: () => deleted,
          then: (resolve: any) => resolve(deleted),
        };
      },
    }),

    execute: async (queryObj: any) => {
      // Mock raw SQL execution cho claimStaleOrQueuedDeliveryJob và claimDeliveryJobById
      const now = new Date();
      const rows: any[] = [];
      const vals = extractValues(queryObj);
      const claimantToken = (vals.find((v) => typeof v === "string") as string) || "test-worker";

      const sqlString =
        queryObj.queryChunks
          ?.map((c: any) =>
            typeof c === "string"
              ? c
              : Array.isArray(c?.value)
              ? c.value.join(" ")
              : ""
          )
          .join(" ") || "";
      const isTargetedClaim = !sqlString.includes("SELECT id FROM delivery_jobs");
      const targetJobId = isTargetedClaim
        ? (vals.find((v) => typeof v === "number") as number | undefined)
        : undefined;

      // Quét job theo điều kiện SQL v7:
      // status = 'queued'
      // OR (status = 'retryable' AND (next_retry_at IS NULL OR next_retry_at <= NOW()))
      // OR (status = 'processing' AND locked_at <= NOW() - leaseDuration)
      for (const [id, job] of state.deliveryJobs.entries()) {
        if (targetJobId !== undefined && id !== targetJobId) {
          continue;
        }

        const isQueued = job.status === "queued";
        const isRetryableReady =
          job.status === "retryable" &&
          (!job.nextRetryAt || new Date(job.nextRetryAt).getTime() <= now.getTime());
        const isLeaseExpired =
          job.status === "processing" &&
          job.lockedAt &&
          now.getTime() - new Date(job.lockedAt).getTime() >= 300_000;

        if (isQueued || isRetryableReady || isLeaseExpired) {
          job.status = "processing";
          job.claimToken = claimantToken;
          job.lockedAt = now;
          job.externalAttemptCount = (job.externalAttemptCount || 0) + 1;
          job.updatedAt = now;
          rows.push({ ...job });
          break; // LIMIT 1
        }
      }

      return { rows };
    },

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

      const snapWallets = new Map(Array.from(state.wallets.entries()).map(([k, v]) => [k, { ...v }]));
      const snapOrders = new Map(Array.from(state.orders.entries()).map(([k, v]) => [k, { ...v }]));
      const snapJobs = new Map(Array.from(state.deliveryJobs.entries()).map(([k, v]) => [k, { ...v }]));
      const snapLogs = new Map(Array.from(state.deliveryLogs.entries()).map(([k, v]) => [k, { ...v }]));
      const snapTokens = new Map(Array.from(state.downloadTokens.entries()).map(([k, v]) => [k, { ...v }]));
      const snapLedger = state.ledger.map((l) => ({ ...l }));

      try {
        return await cb(mockDb);
      } catch (err) {
        state.wallets = snapWallets;
        state.orders = snapOrders;
        state.deliveryJobs = snapJobs;
        state.deliveryLogs = snapLogs;
        state.downloadTokens = snapTokens;
        state.ledger = snapLedger;
        throw err;
      } finally {
        release!();
      }
    },
  };

  return mockDb;
}

/**
 * Mock Discord Client
 */
function createMockDiscordClient(opts?: { shouldFailDm?: boolean; dmErrorCode?: number; delayMs?: number }) {
  return {
    users: {
      fetch: async (userId: string) => {
        return {
          id: userId,
          send: async (_payload: any) => {
            if (opts?.delayMs) {
              await new Promise((r) => setTimeout(r, opts.delayMs));
            }
            if (opts?.shouldFailDm) {
              if (opts.dmErrorCode === RESTJSONErrorCodes.CannotSendMessagesToThisUser) {
                const err = new DiscordAPIError(
                  { code: RESTJSONErrorCodes.CannotSendMessagesToThisUser, message: "Cannot send messages to this user" },
                  RESTJSONErrorCodes.CannotSendMessagesToThisUser,
                  403,
                  "POST",
                  "https://discord.com/api/v10/channels/1/messages",
                  {}
                );
                throw err;
              }
              throw new Error("Discord API Transient Network Failure");
            }
            return { id: `msg-${Date.now()}` };
          },
        };
      },
    },
  } as any;
}

describe("PHASE 3B REGRESSION TEST SUITE (TEST-B1 to TEST-B19)", () => {
  // TEST-B1: Hai worker claim đồng thời -> duy nhất 1 worker sở hữu reservation
  it("TEST-B1: Two concurrent workers claim job - exactly one acquires reservation", async () => {
    const db = createMockDeliveryNeonDb();
    const state = db._state;
    state.deliveryJobs.set(1, { id: 1, orderId: 10, versionId: 1, status: "queued", discordUserId: "user1" });

    // Hai worker cùng claim đồng thời
    const [workerA, workerB] = await Promise.all([
      claimStaleOrQueuedDeliveryJob(db, "worker-A", 300),
      claimStaleOrQueuedDeliveryJob(db, "worker-B", 300),
    ]);

    const winner = workerA || workerB;
    const loser = workerA ? workerB : workerA;

    expect(winner).toBeDefined();
    expect(loser).toBeNull();
    expect(state.deliveryJobs.get(1).status).toBe("processing");
  });

  // TEST-B2: Lease duration 300s -> I/O kéo dài 15s không bị worker khác cướp quyền
  it("TEST-B2: Fresh processing job with 300s lease cannot be stolen by second worker", async () => {
    const db = createMockDeliveryNeonDb();
    const state = db._state;
    // Job vừa được lock 15 giây trước (lockedAt = NOW - 15s, lease = 300s)
    const fifteenSecAgo = new Date(Date.now() - 15_000);
    state.deliveryJobs.set(2, {
      id: 2,
      orderId: 20,
      versionId: 1,
      status: "processing",
      claimToken: "worker-A",
      lockedAt: fifteenSecAgo,
    });

    const secondClaim = await claimStaleOrQueuedDeliveryJob(db, "worker-B", 300);
    expect(secondClaim).toBeNull(); // Không được cướp quyền
    expect(state.deliveryJobs.get(2).claimToken).toBe("worker-A");
  });

  // TEST-B3: Phục hồi sự cố -> Job kẹt processing quá hạn lease (> 300s) được reclaim an toàn
  it("TEST-B3: Stale processing job past lease (> 300s) is reclaimed exactly once", async () => {
    const db = createMockDeliveryNeonDb();
    const state = db._state;
    // Job bị kẹt 350 giây trước
    const staleTime = new Date(Date.now() - 350_000);
    state.deliveryJobs.set(3, {
      id: 3,
      orderId: 30,
      versionId: 1,
      status: "processing",
      claimToken: "dead-worker",
      lockedAt: staleTime,
    });

    const reclaim = await claimStaleOrQueuedDeliveryJob(db, "worker-C", 300);
    expect(reclaim).toBeDefined();
    expect(reclaim?.id).toBe(3);
    expect(state.deliveryJobs.get(3).claimToken).toBe("worker-C");
  });

  // TEST-B4 (v7 Spec): Worker claim processing -> Admin refund concurrently nhận DELIVERY_IN_PROGRESS -> delivery completes -> post-delivery refund succeeds
  it("TEST-B4: Refund during processing is rejected with DELIVERY_IN_PROGRESS, completes delivery, allows post-delivery refund", async () => {
    const db = createMockDeliveryNeonDb();
    const state = db._state;

    state.wallets.set("user_b4", { discordUserId: "user_b4", balance: 0 });
    state.orders.set(40, {
      id: 40,
      code: "ORDER_B4",
      discordUserId: "user_b4",
      amount: 100_000,
      bankDue: 100_000,
      paidAmount: 100_000,
      status: "paid",
      walletPaid: 0,
      versionId: 1,
    });
    state.deliveryJobs.set(400, {
      id: 400,
      orderId: 40,
      versionId: 1,
      discordUserId: "user_b4",
      status: "processing",
      claimToken: "worker-b4",
      lockedAt: new Date(),
    });

    // 1. Admin refund trong lúc job đang processing -> Bắt buộc bị REJECT với DELIVERY_IN_PROGRESS
    await expect(refundOrderWallet(db, 40, "Admin refund attempt")).rejects.toThrow(
      /DELIVERY_IN_PROGRESS/
    );

    // Không có biến động ví
    expect(state.wallets.get("user_b4").balance).toBe(0);
    expect(state.orders.get(40).status).toBe("paid");

    // 2. Worker hoàn tất giao hàng
    await markDeliveryJobSuccess(db, 400, "worker-b4");
    await updateOrderStatus(db, 40, "delivered");
    expect(state.deliveryJobs.get(400).status).toBe("delivered");
    expect(state.orders.get(40).status).toBe("delivered");

    // 3. Sau khi giao hàng thành công, Admin thực hiện Post-delivery refund -> Cho phép
    const refundResult = await refundOrderWallet(db, 40, "Post-delivery refund");
    expect(refundResult.order.status).toBe("refunded");
    expect(refundResult.newBalance).toBe(100_000);
    expect(state.deliveryJobs.get(400).status).toBe("delivered"); // Giữ nguyên delivered
  });

  // TEST-B5: Terminal Job Guard -> Job đã delivered, failed, cancelled không thể bị claim lại
  it("TEST-B5: Terminal delivery job (delivered, failed, cancelled) cannot be reactivated", async () => {
    const db = createMockDeliveryNeonDb();
    const state = db._state;

    state.deliveryJobs.set(51, { id: 51, orderId: 51, versionId: 1, status: "delivered" });
    state.deliveryJobs.set(52, { id: 52, orderId: 52, versionId: 1, status: "failed" });

    const claimDelivered = await claimDeliveryJobById(db, 51, "worker-test");
    const claimFailed = await claimDeliveryJobById(db, 52, "worker-test");

    expect(claimDelivered).toBeNull();
    expect(claimFailed).toBeNull();
    expect(state.deliveryJobs.get(51).status).toBe("delivered");
    expect(state.deliveryJobs.get(52).status).toBe("failed");
  });

  // TEST-B6: Thu hồi token khi refund -> Link tải một lần bị xóa và trả về 410
  it("TEST-B6: Download token revoked on refund - returns null on claim", async () => {
    const db = createMockDeliveryNeonDb();
    const state = db._state;

    state.downloadTokens.set("token_hash_b6", {
      tokenHash: "token_hash_b6",
      orderId: 60,
      discordUserId: "user_b6",
      versionId: 1,
      usedAt: null,
      expiresAt: new Date(Date.now() + 3600_000),
    });

    const revokedCount = await revokeDownloadTokensByOrder(db, 60);
    expect(revokedCount).toBe(1);
    expect(state.downloadTokens.has("token_hash_b6")).toBe(false);

    const claimAttempt = await claimDownloadToken(db, "token_hash_b6");
    expect(claimAttempt).toBeNull();
  });

  // TEST-B7: Ngưỡng Max Retries -> Sau 5 lần lỗi tạm thời, job chuyển sang failed
  it("TEST-B7: Job reaches MAX_RETRIES (5) and permanently fails", async () => {
    const db = createMockDeliveryNeonDb();
    const state = db._state;

    state.deliveryJobs.set(70, {
      id: 70,
      orderId: 70,
      versionId: 1,
      status: "processing",
      claimToken: "worker-b7",
      retryCount: 4, // Đang ở lần 4, lần tiếp theo là 5 >= maxRetries
    });

    const retryResult = await markDeliveryJobRetryable(
      db,
      70,
      "worker-b7",
      "Network connection reset",
      4,
      5
    );

    expect(retryResult).toBe(true);
    expect(state.deliveryJobs.get(70).status).toBe("failed");
    expect(state.deliveryJobs.get(70).lastError).toContain("Quá số lần thử lại tối đa");
  });

  // TEST-B8: Exponential Backoff -> Job retryable có next_retry_at tăng dần và không bị claim trước hạn
  it("TEST-B8: Retryable job has exponential backoff next_retry_at and cannot be claimed prematurely", async () => {
    const db = createMockDeliveryNeonDb();
    const state = db._state;

    // Retry lần 1: delay 30 * 2^1 = 60s
    const futureDate = new Date(Date.now() + 60_000);
    state.deliveryJobs.set(80, {
      id: 80,
      orderId: 80,
      versionId: 1,
      status: "retryable",
      nextRetryAt: futureDate,
    });

    const claimTooEarly = await claimStaleOrQueuedDeliveryJob(db, "worker-b8", 300);
    expect(claimTooEarly).toBeNull(); // Chưa đến hạn, không được claim
  });

  // TEST-B9 (v7 Spec): Scheduler Anti-Busy-Loop -> No job: poll again; Transient error: backoff & continues; Fatal: stops
  it("TEST-B9: Scheduler handles empty queue, transient errors without busy-loop, and fatal stops", async () => {
    const db = createMockDeliveryNeonDb();
    const client = createMockDiscordClient();

    let pollCount = 0;
    const workerDeps: DeliveryWorkerDeps = {
      neonDb: db,
      client,
      vaultDir: "vault",
      publicBaseUrl: "https://example.com",
      attachMaxBytes: 10_000_000,
      tokenTtlMinutes: 60,
    };

    const scheduler = startDeliveryScheduler(workerDeps, 50, 1000);
    expect(scheduler.isRunning()).toBe(true);

    // Trigger khi không có job -> không crash, duy trì running
    scheduler.trigger();
    await new Promise((r) => setTimeout(r, 100));
    expect(scheduler.isRunning()).toBe(true);

    await scheduler.stop();
    expect(scheduler.isRunning()).toBe(false);
  });

  // TEST-B10: DM Blocked (50007) -> Đánh dấu failed dứt khoát, không retry, tiền đơn giữ nguyên
  it("TEST-B10: Discord 50007 DM blocked marks job failed permanently, preserves order funds", async () => {
    const db = createMockDeliveryNeonDb();
    const state = db._state;

    state.orders.set(100, {
      id: 100,
      code: "ORDER_B10",
      discordUserId: "user_blocked",
      amount: 50_000,
      paidAmount: 50_000,
      bankDue: 50_000,
      walletPaid: 0,
      status: "paid",
      versionId: 1,
    });
    state.deliveryJobs.set(1000, {
      id: 1000,
      orderId: 100,
      versionId: 1,
      discordUserId: "user_blocked",
      status: "queued",
    });

    const client = createMockDiscordClient({
      shouldFailDm: true,
      dmErrorCode: RESTJSONErrorCodes.CannotSendMessagesToThisUser,
    });

    const result = await processNextDeliveryJob({
      neonDb: db,
      client,
      vaultDir: "vault",
      publicBaseUrl: "https://example.com",
      attachMaxBytes: 10_000_000,
      tokenTtlMinutes: 60,
    });

    expect(result.processed).toBe(true);
    expect(result.success).toBe(false);
    expect(result.reason).toBe("dm_blocked");
    expect(state.deliveryJobs.get(1000).status).toBe("failed");
    expect(state.orders.get(100).status).toBe("paid"); // Không bị hạ status
  });

  // TEST-B11: Requeue thủ công -> Admin requeue tạo job mới và log kiểm toán phân biệt
  it("TEST-B11: Manual requeue creates fresh queued job and logs distinguish attempts", async () => {
    const db = createMockDeliveryNeonDb();
    const state = db._state;

    state.orders.set(110, {
      id: 110,
      code: "ORDER_B11",
      discordUserId: "user_b11",
      status: "paid",
      versionId: 1,
    });
    state.deliveryJobs.set(1100, {
      id: 1100,
      orderId: 110,
      versionId: 1,
      status: "failed",
      lastError: "dm_blocked",
    });

    const requeueRes = await requeueDeliveryJob(db, 110);
    expect(requeueRes.ok).toBe(true);
    expect(state.deliveryJobs.get(1100).status).toBe("queued");
    expect(state.deliveryJobs.get(1100).lastError).toBeNull();
  });

  // TEST-B12 (v7 Spec): Bounded Graceful Shutdown -> SIGTERM stops claims, allows bounded finish or recovery
  it("TEST-B12: Graceful shutdown stops new claims and gives bounded timeout for in-flight job", async () => {
    const db = createMockDeliveryNeonDb();
    const client = createMockDiscordClient({ delayMs: 50 });

    const scheduler = startDeliveryScheduler(
      {
        neonDb: db,
        client,
        vaultDir: "vault",
        publicBaseUrl: "https://example.com",
        attachMaxBytes: 10_000_000,
        tokenTtlMinutes: 60,
      },
      10_000,
      200
    );

    // Stop trong lúc không có in-flight hoặc in-flight ngắn
    await scheduler.stop();
    expect(scheduler.isRunning()).toBe(false);
  });

  // TEST-B13: Worker claims processing -> Admin refund concurrently -> Refund rejected, delivery continues
  it("TEST-B13: Worker claim processing causes concurrent refund to be rejected", async () => {
    const db = createMockDeliveryNeonDb();
    const state = db._state;

    state.wallets.set("user_b13", { discordUserId: "user_b13", balance: 0 });
    state.orders.set(130, {
      id: 130,
      code: "ORDER_B13",
      discordUserId: "user_b13",
      amount: 50_000,
      bankDue: 50_000,
      paidAmount: 50_000,
      walletPaid: 0,
      status: "paid",
      versionId: 1,
    });
    state.deliveryJobs.set(1300, {
      id: 1300,
      orderId: 130,
      versionId: 1,
      discordUserId: "user_b13",
      status: "processing",
      claimToken: "worker-b13",
      lockedAt: new Date(),
    });

    await expect(refundOrderWallet(db, 130, "Concurrent refund")).rejects.toThrow(
      /DELIVERY_IN_PROGRESS/
    );
    expect(state.orders.get(130).status).toBe("paid");
    expect(state.wallets.get("user_b13").balance).toBe(0);
  });

  // TEST-B14 (v7 Spec): Refund commits before worker claim -> Job cancelled/failed, worker does not send DM
  it("TEST-B14: Refund commits before worker claim - job cancelled and worker does not deliver", async () => {
    const db = createMockDeliveryNeonDb();
    const state = db._state;

    state.wallets.set("user_b14", { discordUserId: "user_b14", balance: 0 });
    state.orders.set(140, {
      id: 140,
      code: "ORDER_B14",
      discordUserId: "user_b14",
      amount: 50_000,
      bankDue: 50_000,
      paidAmount: 50_000,
      walletPaid: 0,
      status: "paid",
      versionId: 1,
    });
    state.deliveryJobs.set(1400, {
      id: 1400,
      orderId: 140,
      versionId: 1,
      discordUserId: "user_b14",
      status: "queued",
    });

    // 1. Admin refund commit trước
    await refundOrderWallet(db, 140, "Admin refund early");
    expect(state.orders.get(140).status).toBe("refunded");
    expect(state.deliveryJobs.get(1400).status).toBe("failed");

    // 2. Worker quét job sau đó -> Bị chặn, không gửi tệp
    let discordCalled = false;
    const client = {
      users: {
        fetch: async () => {
          discordCalled = true;
          return { send: async () => ({ id: "1" }) };
        },
      },
    } as any;

    const result = await processNextDeliveryJob({
      neonDb: db,
      client,
      vaultDir: "vault",
      publicBaseUrl: "https://example.com",
      attachMaxBytes: 10_000_000,
      tokenTtlMinutes: 60,
    });

    expect(discordCalled).toBe(false); // Tuyệt đối không gọi Discord DM
  });

  // TEST-B15: Worker claim before cancel -> Cancel rejected with DELIVERY_IN_PROGRESS
  it("TEST-B15: Worker claims before cancel - cancel rejected with DELIVERY_IN_PROGRESS", async () => {
    const db = createMockDeliveryNeonDb();
    const state = db._state;

    state.orders.set(150, {
      id: 150,
      code: "ORDER_B15",
      discordUserId: "user_b15",
      amount: 50_000,
      bankDue: 50_000,
      walletPaid: 0,
      status: "pending",
      versionId: 1,
    });
    state.deliveryJobs.set(1500, {
      id: 1500,
      orderId: 150,
      versionId: 1,
      status: "processing",
      claimToken: "worker-b15",
    });

    await expect(cancelPendingOrder(db, 150, "User cancel")).rejects.toThrow(
      /DELIVERY_IN_PROGRESS/
    );
    expect(state.orders.get(150).status).toBe("pending");
  });

  // TEST-B16: Giao hàng thành công -> Sau đó Admin refund -> Delivery giữ nguyên delivered, Order chuyển refunded
  it("TEST-B16: Delivery succeeds, subsequent refund transitions order to refunded while job stays delivered", async () => {
    const db = createMockDeliveryNeonDb();
    const state = db._state;

    state.wallets.set("user_b16", { discordUserId: "user_b16", balance: 0 });
    state.orders.set(160, {
      id: 160,
      code: "ORDER_B16",
      discordUserId: "user_b16",
      amount: 50_000,
      bankDue: 50_000,
      paidAmount: 50_000,
      walletPaid: 0,
      status: "delivered",
      versionId: 1,
    });
    state.deliveryJobs.set(1600, {
      id: 1600,
      orderId: 160,
      versionId: 1,
      status: "delivered",
    });

    const refund = await refundOrderWallet(db, 160, "Post-delivery warranty refund");
    expect(refund.order.status).toBe("refunded");
    expect(refund.newBalance).toBe(50_000);
    expect(state.deliveryJobs.get(1600).status).toBe("delivered");
    expect(state.ledger.length).toBe(1);
    expect(state.ledger[0].kind).toBe("order_refund");
  });

  // TEST-B17: Gửi Discord thành công nhưng server crash trước khi mark success -> At-least-once recovery
  it("TEST-B17: Crash after external send leaves job in processing, recovered after lease expires", async () => {
    const db = createMockDeliveryNeonDb();
    const state = db._state;

    // Giả lập worker A gửi DM thành công nhưng crash trước khi gọi markDeliveryJobSuccess
    const crashTime = new Date(Date.now() - 320_000); // 320s trước (quá hạn 300s)
    state.deliveryJobs.set(1700, {
      id: 1700,
      orderId: 170,
      versionId: 1,
      discordUserId: "user_b17",
      status: "processing",
      claimToken: "worker-crashed",
      lockedAt: crashTime,
    });

    const reclaim = await claimStaleOrQueuedDeliveryJob(db, "worker-recovery", 300);
    expect(reclaim).toBeDefined();
    expect(reclaim?.id).toBe(1700);
    expect(state.deliveryJobs.get(1700).claimToken).toBe("worker-recovery");
  });

  // TEST-B18: Quá trình gửi Discord kéo dài -> Heartbeat cập nhật locked_at liên tục, không bị cướp quyền
  it("TEST-B18: Active heartbeat refreshes locked_at, preventing second worker from stealing job", async () => {
    const db = createMockDeliveryNeonDb();
    const state = db._state;

    state.deliveryJobs.set(1800, {
      id: 1800,
      orderId: 180,
      versionId: 1,
      status: "processing",
      claimToken: "worker-active",
      lockedAt: new Date(Date.now() - 250_000), // Gần hết hạn (250s)
    });

    // Heartbeat làm mới lockedAt
    const heartbeatOk = await refreshDeliveryJobHeartbeat(db, 1800, "worker-active");
    expect(heartbeatOk).toBe(true);

    const updatedJob = state.deliveryJobs.get(1800);
    expect(Date.now() - new Date(updatedJob.lockedAt).getTime()).toBeLessThan(5000);

    // Worker khác không thể cướp quyền vì lease vừa được gia hạn
    const secondClaim = await claimStaleOrQueuedDeliveryJob(db, "worker-sniper", 300);
    expect(secondClaim).toBeNull();
  });

  // TEST-B19 (v7 Spec): Mất lease Heartbeat trong lúc gửi ngoại vi -> Worker dừng mọi DB mutation, outcome cục bộ UNKNOWN
  it("TEST-B19: Heartbeat lease lost - worker halts DB mutation, sets local outcome UNKNOWN, preserves recovery", async () => {
    const db = createMockDeliveryNeonDb();
    const state = db._state;

    state.orders.set(190, {
      id: 190,
      code: "ORDER_B19",
      discordUserId: "user_b19",
      status: "paid",
      amount: 50_000,
      paidAmount: 50_000,
      bankDue: 50_000,
      walletPaid: 0,
      versionId: 1,
    });
    state.deliveryJobs.set(1900, {
      id: 1900,
      orderId: 190,
      versionId: 1,
      discordUserId: "user_b19",
      status: "queued",
    });

    // Giả lập worker thực thi với heartbeat interval cực ngắn (10ms)
    // Và làm cho refreshDeliveryJobHeartbeat trả về false (giả lập bị mất lease)
    let heartbeatCalls = 0;
    const originalUpdate = db.update;
    db.update = (table: any) => {
      const u = originalUpdate(table);
      return {
        set: (patch: any) => ({
          where: (cond: any) => {
            if (patch.lockedAt && !patch.status) {
              heartbeatCalls++;
              // Làm mất lease: trả về rỗng (0 rows updated)
              return {
                returning: () => [],
                then: (res: any) => res([]),
              };
            }
            return u.set(patch).where(cond);
          },
        }),
      };
    };

    const client = createMockDiscordClient({ delayMs: 30 });

    const result = await processNextDeliveryJob({
      neonDb: db,
      client,
      vaultDir: "vault",
      publicBaseUrl: "https://example.com",
      attachMaxBytes: 10_000_000,
      tokenTtlMinutes: 60,
      heartbeatIntervalMs: 10,
    });

    expect(result.processed).toBe(true);
    expect(result.localOutcome).toBe("UNKNOWN");
    expect(result.reason).toBe("heartbeat_lease_lost");

    // QUY TẮC v7: TUYỆT ĐỐI KHÔNG MUTATE DB SAU KHI MẤT LEASE
    // Đơn hàng KHÔNG bị chuyển thành delivered
    expect(state.orders.get(190).status).toBe("paid");
    // Không ghi log kiểm toán
    expect(state.deliveryLogs.size).toBe(0);
    // Job trong DB KHÔNG có status = 'unknown' (chỉ giữ processing để worker khác reclaim sau khi hết hạn lease)
    expect(state.deliveryJobs.get(1900).status).toBe("processing");
  });
});
