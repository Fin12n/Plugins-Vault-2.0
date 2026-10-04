import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { mkdtemp, rm, writeFile, symlink, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveBlobPath } from '../src/services/delivery/deliver-version.js';
import {
  refundOrderWallet,
  cancelPendingOrder,
  requeueDeliveryJob,
} from '../src/repositories/neon-orders.js';
import { processNextDeliveryJob } from '../src/services/delivery/neon-delivery-worker.js';
import { DiscordAPIError, RESTJSONErrorCodes } from 'discord.js';
import type { Database } from '../src/db/neon.js';

describe('PHASE 2 — COMPREHENSIVE ACCEPTANCE TESTS', () => {
  // --------------------------------------------------------------------------
  // TEST SUITE 1: Acceptance Test C — Storage Confinement & Symlink Escape
  // --------------------------------------------------------------------------
  describe('Acceptance Test C: Storage Confinement & Symlink Jail', () => {
    let tempVaultDir: string;
    let outsideDir: string;

    beforeEach(async () => {
      tempVaultDir = await mkdtemp(join(tmpdir(), 'vault-jail-test-'));
      outsideDir = await mkdtemp(join(tmpdir(), 'vault-outside-test-'));
    });

    afterEach(async () => {
      await rm(tempVaultDir, { recursive: true, force: true }).catch(() => {});
      await rm(outsideDir, { recursive: true, force: true }).catch(() => {});
    });

    it('cho phép đọc file hợp lệ nằm hoàn toàn bên trong vaultDir', async () => {
      const jarName = 'plugin-1.0.jar';
      const fullPath = join(tempVaultDir, jarName);
      await writeFile(fullPath, 'fake-jar-content');

      const resolved = await resolveBlobPath(tempVaultDir, jarName);
      expect(resolved).not.toBeNull();
      expect(resolved).toContain(jarName);
    });

    it('chặn đứng path traversal ../ cố tình thoát khỏi vaultDir', async () => {
      // Tạo file nhạy cảm ở ngoài thư mục vault
      const secretFile = join(outsideDir, 'secret.env');
      await writeFile(secretFile, 'SUPER_SECRET_KEY=12345');

      // Thử dùng relPath có ../ để thoát
      const maliciousRelPath = `../../${join('vault-outside-test', 'secret.env')}`;
      const resolved = await resolveBlobPath(tempVaultDir, maliciousRelPath);

      expect(resolved).toBeNull();
    });

    it('chặn đứng symbolic link bên trong vault nhưng trỏ tới file bên ngoài (Symlink Escape)', async () => {
      // 1. Tạo file bên ngoài vault
      const targetOutsideFile = join(outsideDir, 'sensitive.json');
      await writeFile(targetOutsideFile, '{"sensitive": true}');

      // 2. Tạo symlink bên trong vault trỏ ra targetOutsideFile
      const symlinkInVault = join(tempVaultDir, 'escaped-link.jar');
      try {
        await symlink(targetOutsideFile, symlinkInVault, 'file');
      } catch (err: any) {
        // Trên Windows nếu không có quyền SeCreateSymbolicLinkPrivilege (Developer mode off)
        // symlink có thể báo lỗi EPERM -> Bỏ qua test symlink nếu OS không cho tạo
        if (err.code === 'EPERM') return;
        throw err;
      }

      // 3. Kiểm tra resolveBlobPath
      const resolved = await resolveBlobPath(tempVaultDir, 'escaped-link.jar');
      expect(resolved).toBeNull();
    });
  });

  // --------------------------------------------------------------------------
  // TEST SUITE 2: Acceptance Test A — Refund Lock Ordering & Concurrency
  // --------------------------------------------------------------------------
  describe('Acceptance Test A: Refund Lock Ordering & Financial Semantics', () => {
    function createMockNeonDbForRefund(initialOrder: any, initialWalletBalance = 0) {
      let walletBalance = initialWalletBalance;
      let order = { ...initialOrder };
      const ledger: any[] = [];
      const lockAcquiredOrder: string[] = [];

      const mockDb: any = {
        transaction: async (cb: any) => {
          const tx: any = {
            select: (fields?: any) => ({
              from: (table: any) => ({
                where: (cond: any) => ({
                  limit: () => {
                    // Pre-read step
                    return [{ discordUserId: order.discordUserId }];
                  },
                  for: async (mode: string) => {
                    const tableName = table[Symbol.for('drizzle:Name')] || table._?.name || 'unknown';
                    lockAcquiredOrder.push(tableName);
                    if (tableName === 'wallets') {
                      return [{ discordUserId: order.discordUserId, balance: walletBalance }];
                    }
                    if (tableName === 'orders') {
                      return [order];
                    }
                    return [];
                  },
                }),
              }),
            }),
            insert: (table: any) => ({
              values: (val: any) => ({
                onConflictDoNothing: () => {},
                returning: () => [val],
              }),
            }),
            update: (table: any) => ({
              set: (vals: any) => ({
                where: (cond: any) => {
                  const tableName = table[Symbol.for('drizzle:Name')] || table._?.name || 'unknown';
                  if (tableName === 'wallets') {
                    if (vals.balance !== undefined) walletBalance = vals.balance;
                  }
                  if (tableName === 'orders') {
                    order = { ...order, ...vals };
                  }
                  return {
                    returning: () => [order],
                  };
                },
              }),
            }),
          };

          // Theo dõi ledger
          const origInsert = tx.insert;
          tx.insert = (table: any) => {
            const tableName = table[Symbol.for('drizzle:Name')] || table._?.name || 'unknown';
            if (tableName === 'wallet_ledger') {
              return {
                values: (val: any) => {
                  ledger.push(val);
                  return Promise.resolve();
                },
              };
            }
            return origInsert(table);
          };

          return await cb(tx);
        },
      };

      return {
        db: mockDb as Database,
        getWalletBalance: () => walletBalance,
        getOrder: () => order,
        getLedger: () => ledger,
        getLockOrder: () => lockAcquiredOrder,
      };
    }

    it('hoàn tiền thành công tuân thủ nghiêm ngặt Canonical Lock Order (wallets -> orders)', async () => {
      const mock = createMockNeonDbForRefund(
        {
          id: 101,
          code: 'EZ-101',
          discordUserId: 'user_456',
          status: 'paid',
          walletPaid: 20000,
          bankDue: 30000,
          paidAmount: 30000,
          pluginName: 'VaultCore',
        },
        50000
      );

      const result = await refundOrderWallet(mock.db, 101, 'Khách yêu cầu hủy');

      // 1. Kiểm tra Canonical Lock Order: wallets PHẢI được khóa trước orders
      const lockOrder = mock.getLockOrder();
      expect(lockOrder).toEqual(['wallets', 'orders']);

      // 2. Kiểm tra số tiền hoàn: 20k (walletPaid) + 30k (paidAmount) = 50k
      expect(result.refundAmount).toBe(50000);
      expect(result.newBalance).toBe(100000);
      expect(mock.getWalletBalance()).toBe(100000);

      // 3. Kiểm tra trạng thái order đổi sang refunded
      expect(result.order.status).toBe('refunded');
      expect(mock.getOrder().status).toBe('refunded');

      // 4. Kiểm tra bút toán ledger
      const ledger = mock.getLedger();
      expect(ledger.length).toBe(1);
      expect(ledger[0].delta).toBe(50000);
      expect(ledger[0].kind).toBe('order_refund');
      expect(ledger[0].refId).toBe(101);
    });

    it('tính toán đúng số tiền hoàn cho đơn wallet_paid thuần túy (bankDue = 0)', async () => {
      const mock = createMockNeonDbForRefund(
        {
          id: 102,
          code: 'EZ-102',
          discordUserId: 'user_789',
          status: 'wallet_paid',
          walletPaid: 75000,
          bankDue: 0,
          paidAmount: null,
          pluginName: 'CombatLog',
        },
        10000
      );

      const result = await refundOrderWallet(mock.db, 102, 'Lỗi tệp');
      expect(result.refundAmount).toBe(75000);
      expect(result.newBalance).toBe(85000);
      expect(mock.getOrder().status).toBe('refunded');
    });

    it('chặn đứng double refund nếu đơn hàng đã ở trạng thái refunded', async () => {
      const mock = createMockNeonDbForRefund(
        {
          id: 103,
          code: 'EZ-103',
          discordUserId: 'user_999',
          status: 'refunded',
          walletPaid: 50000,
          bankDue: 0,
        },
        100000
      );

      await expect(refundOrderWallet(mock.db, 103, 'Refund lại lần 2')).rejects.toThrow(
        'đã được hoàn tiền trước đó'
      );
    });

    it('từ chối hoàn tiền cho đơn hàng chưa thanh toán (pending / expired)', async () => {
      const mock = createMockNeonDbForRefund(
        {
          id: 104,
          code: 'EZ-104',
          discordUserId: 'user_111',
          status: 'pending',
          walletPaid: 0,
          bankDue: 50000,
        },
        0
      );

      await expect(refundOrderWallet(mock.db, 104, 'Thử refund đơn pending')).rejects.toThrow(
        "không thể hoàn tiền"
      );
    });
  });

  // --------------------------------------------------------------------------
  // TEST SUITE 3: Acceptance Test B — Pending Order Cancellation Semantics
  // --------------------------------------------------------------------------
  describe('Acceptance Test B: Pending Order Cancellation Semantics', () => {
    function createMockNeonDbForCancel(initialOrder: any, initialWalletBalance = 0) {
      let walletBalance = initialWalletBalance;
      let order = { ...initialOrder };
      const ledger: any[] = [];
      const lockAcquiredOrder: string[] = [];

      const mockDb: any = {
        transaction: async (cb: any) => {
          const tx: any = {
            select: () => ({
              from: (table: any) => ({
                where: () => ({
                  limit: () => [order],
                  for: async () => {
                    const tableName = table[Symbol.for('drizzle:Name')] || table._?.name || 'unknown';
                    lockAcquiredOrder.push(tableName);
                    if (tableName === 'wallets') {
                      return [{ discordUserId: order.discordUserId, balance: walletBalance }];
                    }
                    if (tableName === 'orders') {
                      return [order];
                    }
                    return [];
                  },
                }),
              }),
            }),
            insert: (table: any) => ({
              values: (val: any) => {
                const tableName = table[Symbol.for('drizzle:Name')] || table._?.name || 'unknown';
                if (tableName === 'wallet_ledger') {
                  ledger.push(val);
                }
                return {
                  onConflictDoNothing: () => {},
                };
              },
            }),
            update: (table: any) => ({
              set: (vals: any) => ({
                where: () => {
                  const tableName = table[Symbol.for('drizzle:Name')] || table._?.name || 'unknown';
                  if (tableName === 'wallets') {
                    if (vals.balance !== undefined) walletBalance = vals.balance;
                  }
                  if (tableName === 'orders') {
                    order = { ...order, ...vals };
                  }
                  return {
                    returning: () => [order],
                  };
                },
              }),
            }),
          };

          return await cb(tx);
        },
      };

      return {
        db: mockDb as Database,
        getWalletBalance: () => walletBalance,
        getOrder: () => order,
        getLedger: () => ledger,
        getLockOrder: () => lockAcquiredOrder,
      };
    }

    it('Case A: Hủy đơn pending thuần túy (walletPaid = 0) -> Đổi status, 0 biến động ví, 0 bút toán sổ cái', async () => {
      const mock = createMockNeonDbForCancel(
        {
          id: 201,
          code: 'EZ-201',
          discordUserId: 'user_bank_only',
          status: 'pending',
          walletPaid: 0,
          bankDue: 100000,
        },
        50000
      );

      const result = await cancelPendingOrder(mock.db, 201, 'Người dùng đổi ý');

      expect(result.order.status).toBe('cancelled');
      expect(result.refundedCoins).toBe(0);
      expect(mock.getWalletBalance()).toBe(50000); // Số dư ví giữ nguyên 100%
      expect(mock.getLedger().length).toBe(0); // 0 bút toán sổ cái
      expect(mock.getLockOrder()).toEqual(['orders']); // Chỉ cần khóa orders
    });

    it('Case B: Hủy đơn pending có cấn trừ ví (walletPaid > 0) -> Hoàn lại coin đã giữ, ghi 1 ledger order_cancel_credit', async () => {
      const mock = createMockNeonDbForCancel(
        {
          id: 202,
          code: 'EZ-202',
          discordUserId: 'user_split_pay',
          status: 'pending',
          walletPaid: 40000,
          bankDue: 60000,
        },
        10000
      );

      const result = await cancelPendingOrder(mock.db, 202, 'Hết hạn hoặc user hủy');

      // Canonical Lock Order: wallets (FOR UPDATE) -> orders (FOR UPDATE)
      expect(mock.getLockOrder()).toEqual(['wallets', 'orders']);

      expect(result.order.status).toBe('cancelled');
      expect(result.refundedCoins).toBe(40000);
      expect(mock.getWalletBalance()).toBe(50000); // 10k + 40k hoàn lại

      const ledger = mock.getLedger();
      expect(ledger.length).toBe(1);
      expect(ledger[0].delta).toBe(40000);
      expect(ledger[0].kind).toBe('order_cancel_credit');
      expect(ledger[0].refId).toBe(202);
    });

    it('từ chối hủy đơn nếu đơn hàng không ở trạng thái pending (ví dụ đã paid/delivered)', async () => {
      const mock = createMockNeonDbForCancel(
        {
          id: 203,
          code: 'EZ-203',
          discordUserId: 'user_paid',
          status: 'paid',
          walletPaid: 0,
          bankDue: 50000,
        },
        0
      );

      await expect(cancelPendingOrder(mock.db, 203)).rejects.toThrow(
        "Chỉ có thể hủy đơn hàng ở trạng thái 'pending'"
      );
    });
  });

  // --------------------------------------------------------------------------
  // TEST SUITE 4: Acceptance Test D — DM Blocked Bug Fix
  // --------------------------------------------------------------------------
  describe('Acceptance Test D: DM Blocked Delivery Reliability', () => {
    it('khi người mua chặn DM Bot (mã lỗi 50007), đơn hàng KHÔNG bao giờ bị hạ thành underpaid', async () => {
      let orderStatus = 'paid';
      let jobStatus = 'queued';
      let jobLastError: string | null = null;

      const mockNeonDb: any = {
        execute: async () => ({
          rows: [
            {
              id: 301,
              orderId: 501,
              discordUserId: 'blocked_user',
              versionId: 10,
              requestedMethod: 'attachment',
              status: 'queued',
              claimToken: 'token_1',
            },
          ],
        }),
        // Mock query claim job
        transaction: async (cb: any) => cb(mockNeonDb),
        select: () => ({
          from: (table: any) => ({
            where: () => ({
              limit: () => [
                {
                  id: 301,
                  orderId: 501,
                  discordUserId: 'blocked_user',
                  versionId: 10,
                  requestedMethod: 'attachment',
                  status: 'queued',
                  claimToken: 'token_1',
                },
              ],
              for: () => {
                const tableName = table?.[Symbol.for('drizzle:Name')] || table?._?.name || '';
                if (tableName === 'orders') {
                  return [
                    {
                      id: 501,
                      status: 'paid',
                      discordUserId: 'blocked_user',
                      amount: 50000,
                      bankDue: 50000,
                      paidAmount: 50000,
                      walletPaid: 0,
                    },
                  ];
                }
                return [
                  {
                    id: 301,
                    orderId: 501,
                    discordUserId: 'blocked_user',
                    versionId: 10,
                    requestedMethod: 'attachment',
                    status: 'queued',
                    claimToken: 'token_1',
                  },
                ];
              },
            }),
          }),
        }),
        update: (table: any) => ({
          set: (vals: any) => ({
            where: () => {
              const tableName = table[Symbol.for('drizzle:Name')] || table._?.name || 'unknown';
              if (tableName === 'delivery_jobs') {
                if (vals.status) jobStatus = vals.status;
                if (vals.lastError) jobLastError = vals.lastError;
              }
              if (tableName === 'orders') {
                if (vals.status) orderStatus = vals.status;
              }
              return { returning: () => [{}] };
            },
          }),
        }),
      };

      // Mock Discord client gửi DM ném lỗi 50007 CannotSendMessagesToThisUser
      const mockDiscordError = new DiscordAPIError(
        { code: RESTJSONErrorCodes.CannotSendMessagesToThisUser, message: 'Cannot send messages to this user' },
        RESTJSONErrorCodes.CannotSendMessagesToThisUser,
        403,
        'POST',
        '/users/blocked_user/channels',
        {}
      );

      const mockClient: any = {
        users: {
          fetch: vi.fn().mockResolvedValue({
            send: vi.fn().mockRejectedValue(mockDiscordError),
          }),
        },
      };

      // Tạo temp vault dir với file hợp lệ
      const tempVault = await mkdtemp(join(tmpdir(), 'vault-dm-test-'));
      const jarPath = join(tempVault, 'test.jar');
      await writeFile(jarPath, 'dummy-jar');

      // Giả lập mock version và plugin repos
      vi.mock('../src/repositories/neon-versions.js', () => ({
        findVersionById: vi.fn().mockResolvedValue({
          id: 10,
          pluginId: 1,
          version: '1.0.0',
          relPath: 'test.jar',
          bytes: 1000,
          originalName: 'test.jar',
        }),
      }));

      vi.mock('../src/repositories/neon-plugins.js', () => ({
        findPluginById: vi.fn().mockResolvedValue({
          id: 1,
          slug: 'test-plugin',
          displayName: 'Test Plugin',
        }),
      }));

      vi.mock('../src/repositories/neon-download-tokens.js', () => ({
        mintDownloadToken: vi.fn().mockResolvedValue({}),
        revokeDownloadTokensByOrder: vi.fn().mockResolvedValue(0),
      }));

      const res = await processNextDeliveryJob({
        neonDb: mockNeonDb,
        client: mockClient,
        vaultDir: tempVault,
        publicBaseUrl: 'http://localhost:3000',
        attachMaxBytes: 10 * 1024 * 1024,
        tokenTtlMinutes: 30,
      });

      await rm(tempVault, { recursive: true, force: true }).catch(() => {});

      // KẾT QUẢ NGHIỆM THU:
      // 1. Worker xử lý job xong và thông báo reason = dm_blocked
      expect(res.processed).toBe(true);
      expect(res.success).toBe(false);
      expect(res.reason).toBe('dm_blocked');

      // 2. Trạng thái order PHẢI giữ nguyên 'paid', TUYỆT ĐỐI KHÔNG BIẾN THÀNH 'underpaid'
      expect(orderStatus).toBe('paid');

      // 3. Job được đánh dấu failed với lastError = 'dm_blocked' để Dashboard hiển thị cảnh báo
      expect(jobStatus).toBe('failed');
      expect(jobLastError).toBe('dm_blocked');
    });
  });

  // --------------------------------------------------------------------------
  // TEST SUITE 5: Requeue Delivery Job
  // --------------------------------------------------------------------------
  describe('Requeue / Release Delivery Job', () => {
    it('đưa lại đơn hàng đã thanh toán vào hàng đợi giao hàng thành công', async () => {
      let deliveryJobStatus = 'failed';

      const mockNeonDb: any = {
        select: () => ({
          from: (table: any) => ({
            where: () => ({
              limit: () => {
                const tableName = table[Symbol.for('drizzle:Name')] || table._?.name || 'unknown';
                if (tableName === 'orders') {
                  return [{ id: 601, code: 'EZ-601', status: 'paid', versionId: 10, discordUserId: 'u1' }];
                }
                if (tableName === 'delivery_jobs') {
                  return [{ id: 801, orderId: 601, status: deliveryJobStatus }];
                }
                return [];
              },
            }),
          }),
        }),
        update: () => ({
          set: (vals: any) => ({
            where: () => {
              if (vals.status) deliveryJobStatus = vals.status;
              return Promise.resolve();
            },
          }),
        }),
      };

      const result = await requeueDeliveryJob(mockNeonDb, 601);
      expect(result.ok).toBe(true);
      expect(deliveryJobStatus).toBe('queued');
    });

    it('từ chối requeue đơn hàng chưa thanh toán (pending)', async () => {
      const mockNeonDb: any = {
        select: () => ({
          from: () => ({
            where: () => ({
              limit: () => [{ id: 602, code: 'EZ-602', status: 'pending' }],
            }),
          }),
        }),
      };

      await expect(requeueDeliveryJob(mockNeonDb, 602)).rejects.toThrow(
        "Chỉ có thể giao lại đơn hàng đã thanh toán"
      );
    });
  });
});
