import Database from 'better-sqlite3';
import { DiscordAPIError } from 'discord.js';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Db } from '../src/db/connection.js';
import { migrate } from '../src/db/migrate.js';
import { createPlugin } from '../src/repositories/plugins.js';
import { createVersion } from '../src/repositories/versions.js';
import {
  expireStaleOrders,
  findOrderByCode,
  findOrderById,
  listUndeliveredPaidOrders,
  markOrderStatus,
  refundOrderWallet,
} from '../src/repositories/orders.js';
import { applyLedgerEntry, getBalance, listLedger, reconcileBalances } from '../src/repositories/wallets.js';
import {
  applySepayTransfer,
  fulfilOrder,
  openOrder,
  type OrderConfig,
} from '../src/services/payment/match-and-fulfil-order.js';
import type { SepayWebhookPayload } from '../src/domain/order.js';

const BUYER = '100000000000000001';

const config: OrderConfig = {
  accountNumber: '0010000000355',
  bankCode: 'Vietcombank',
  codePrefix: 'VN',
  codeSuffixLength: 8,
  ttlMinutes: 15,
};

function basePayload(over: Partial<SepayWebhookPayload> = {}): SepayWebhookPayload {
  return {
    id: Math.floor(Math.random() * 1_000_000_000),
    gateway: 'Vietcombank',
    transactionDate: '2026-08-05 10:00:00',
    accountNumber: '0010000000355',
    subAccount: null,
    code: null,
    content: '',
    transferType: 'in',
    description: '',
    transferAmount: 0,
    accumulated: 0,
    referenceCode: '',
    ...over,
  };
}

describe('trả đơn bằng coin', () => {
  let db: Db;

  function seedPricedVersion(price: number): number {
    const plugin = createPlugin(db, {
      slug: 'priced',
      displayName: 'Priced Plugin',
      descriptorName: 'Priced',
      platform: 'spigot',
    });
    db.prepare('UPDATE plugins SET deposit_price = ? WHERE id = ?').run(price, plugin.id);
    const sha = 'd'.repeat(64);
    return createVersion(db, {
      pluginId: plugin.id,
      version: '2.0.0',
      rawVersion: '2.0.0',
      sha256: sha,
      relPath: `${sha.slice(0, 2)}/${sha}`,
      bytes: 10,
      originalName: 'p.jar',
      descriptorKind: 'spigot',
      versionFlag: 'ok',
    }).id;
  }

  beforeEach(() => {
    db = new Database(':memory:') as Db;
    db.pragma('foreign_keys = ON');
    migrate(db);
  });

  afterEach(() => db.close());

  describe('mở đơn', () => {
    it('ví đủ tiền thì không sinh QR và đơn đã thanh toán', () => {
      applyLedgerEntry(db, { discordUserId: BUYER, delta: 100_000, kind: 'bank_topup' });
      const versionId = seedPricedVersion(30_000);

      const order = openOrder(db, config, { discordUserId: BUYER, versionId })!;

      expect(order).toMatchObject({ amount: 30_000, walletPaid: 30_000, bankDue: 0, qrUrl: null });
      expect(getBalance(db, BUYER)).toBe(70_000);
      expect(findOrderById(db, order.id)?.status).toBe('wallet_paid');
    });

    it('ví thiếu thì QR chỉ mang phần còn thiếu', () => {
      applyLedgerEntry(db, { discordUserId: BUYER, delta: 20_000, kind: 'bank_topup' });
      const versionId = seedPricedVersion(30_000);

      const order = openOrder(db, config, { discordUserId: BUYER, versionId })!;

      expect(order).toMatchObject({ amount: 30_000, walletPaid: 20_000, bankDue: 10_000 });
      // The QR must ask for what is owed, not the full price — otherwise the
      // wallet's share is collected twice.
      expect(order.qrUrl).toContain('amount=10000');
      expect(getBalance(db, BUYER)).toBe(0);
      expect(findOrderById(db, order.id)?.status).toBe('pending');
    });

    it('ví rỗng giữ nguyên hành vi cũ', () => {
      const versionId = seedPricedVersion(30_000);
      const order = openOrder(db, config, { discordUserId: BUYER, versionId })!;

      expect(order).toMatchObject({ walletPaid: 0, bankDue: 30_000 });
      expect(order.qrUrl).toContain('amount=30000');
      expect(listLedger(db, BUYER, 10)).toEqual([]);
    });

    it('coin bị trừ ngay nên hai đơn không tiêu cùng một số dư', () => {
      applyLedgerEntry(db, { discordUserId: BUYER, delta: 30_000, kind: 'bank_topup' });
      const versionId = seedPricedVersion(30_000);

      const first = openOrder(db, config, { discordUserId: BUYER, versionId })!;
      const second = openOrder(db, config, { discordUserId: BUYER, versionId })!;

      expect(first.walletPaid).toBe(30_000);
      // Balance is gone, so the second order owes the whole price by transfer.
      expect(second.walletPaid).toBe(0);
      expect(second.bankDue).toBe(30_000);
    });

    it('số dư bị rút mất giữa chừng thì không tạo ra đơn nào', () => {
      applyLedgerEntry(db, { discordUserId: BUYER, delta: 30_000, kind: 'bank_topup' });
      const versionId = seedPricedVersion(30_000);

      // Drains the balance between openOrder's read and its deduction. Wrapping
      // the ledger write is the only way to hit that window deterministically.
      const realPrepare = db.prepare.bind(db);
      let drained = false;
      db.prepare = ((sql: string) => {
        // Fires on the wallet upsert, which runs just before applyLedgerEntry
        // reads the balance — the exact window openOrder must survive.
        if (!drained && sql.includes('INSERT INTO wallets')) {
          drained = true;
          realPrepare('UPDATE wallets SET balance = 0 WHERE discord_user_id = ?').run(BUYER);
        }
        return realPrepare(sql);
      }) as typeof db.prepare;

      const order = openOrder(db, config, { discordUserId: BUYER, versionId });
      db.prepare = realPrepare;

      expect(order).toBeNull();
      // The insert must roll back with the deduction. An order surviving here
      // would claim wallet_paid against coins that were never taken — a free
      // plugin, and a balance that no longer matches its ledger.
      expect(db.prepare('SELECT count(*) AS c FROM orders').get()).toEqual({ c: 0 });
      expect(reconcileBalances(db)).toEqual([]);
    });

    it('ghi sổ cái trỏ đúng về đơn đã giữ coin', () => {
      applyLedgerEntry(db, { discordUserId: BUYER, delta: 50_000, kind: 'bank_topup' });
      const versionId = seedPricedVersion(30_000);
      const order = openOrder(db, config, { discordUserId: BUYER, versionId })!;

      const [hold] = listLedger(db, BUYER, 1);
      expect(hold).toMatchObject({ delta: -30_000, kind: 'order_hold', refType: 'order', refId: order.id });
    });
  });

  describe('hết hạn hoàn coin', () => {
    it('hoàn đúng số coin đã giữ', () => {
      applyLedgerEntry(db, { discordUserId: BUYER, delta: 20_000, kind: 'bank_topup' });
      const versionId = seedPricedVersion(30_000);
      const order = openOrder(db, config, { discordUserId: BUYER, versionId })!;
      expect(getBalance(db, BUYER)).toBe(0);

      db.prepare('UPDATE orders SET expires_at = 1 WHERE id = ?').run(order.id);
      expect(expireStaleOrders(db)).toEqual({ expired: 1, refunded: 1 });

      expect(getBalance(db, BUYER)).toBe(20_000);
      expect(findOrderById(db, order.id)?.status).toBe('expired');
      expect(reconcileBalances(db)).toEqual([]);
    });

    it('quét hai lần chỉ hoàn một lần', () => {
      applyLedgerEntry(db, { discordUserId: BUYER, delta: 20_000, kind: 'bank_topup' });
      const versionId = seedPricedVersion(30_000);
      const order = openOrder(db, config, { discordUserId: BUYER, versionId })!;
      db.prepare('UPDATE orders SET expires_at = 1 WHERE id = ?').run(order.id);

      expireStaleOrders(db);
      // The second sweep finds nothing pending, which is what stops a double
      // refund — the predicate lives in the UPDATE, not in this test.
      expect(expireStaleOrders(db)).toEqual({ expired: 0, refunded: 0 });
      expect(getBalance(db, BUYER)).toBe(20_000);
    });

    it('không hoàn đơn đã thanh toán trọn bằng ví', () => {
      applyLedgerEntry(db, { discordUserId: BUYER, delta: 30_000, kind: 'bank_topup' });
      const versionId = seedPricedVersion(30_000);
      const order = openOrder(db, config, { discordUserId: BUYER, versionId })!;
      db.prepare('UPDATE orders SET expires_at = 1 WHERE id = ?').run(order.id);

      expect(expireStaleOrders(db)).toEqual({ expired: 0, refunded: 0 });
      expect(findOrderById(db, order.id)?.status).toBe('wallet_paid');
      expect(getBalance(db, BUYER)).toBe(0);
    });
  });

  describe('hoàn coin khi giao thất bại', () => {
    it('hoàn một lần và lần hai không cộng thêm', () => {
      applyLedgerEntry(db, { discordUserId: BUYER, delta: 30_000, kind: 'bank_topup' });
      const versionId = seedPricedVersion(30_000);
      const order = openOrder(db, config, { discordUserId: BUYER, versionId })!;

      expect(refundOrderWallet(db, order.id, 'giao hàng thất bại')).toBe(true);
      expect(getBalance(db, BUYER)).toBe(30_000);

      expect(refundOrderWallet(db, order.id, 'giao hàng thất bại')).toBe(false);
      expect(getBalance(db, BUYER)).toBe(30_000);
    });

    it('không hoàn đơn đã giao', () => {
      applyLedgerEntry(db, { discordUserId: BUYER, delta: 30_000, kind: 'bank_topup' });
      const versionId = seedPricedVersion(30_000);
      const order = openOrder(db, config, { discordUserId: BUYER, versionId })!;
      db.prepare("UPDATE orders SET status = 'delivered' WHERE id = ?").run(order.id);

      expect(refundOrderWallet(db, order.id, 'x')).toBe(false);
      expect(getBalance(db, BUYER)).toBe(0);
    });
  });

  describe('không hoàn coin hai lần', () => {
    it('quét hết hạn rồi hoàn tay cũng chỉ hoàn một lần', () => {
      applyLedgerEntry(db, { discordUserId: BUYER, delta: 20_000, kind: 'bank_topup' });
      const versionId = seedPricedVersion(30_000);
      const order = openOrder(db, config, { discordUserId: BUYER, versionId })!;
      db.prepare('UPDATE orders SET expires_at = 1 WHERE id = ?').run(order.id);

      expect(expireStaleOrders(db)).toEqual({ expired: 1, refunded: 1 });
      expect(getBalance(db, BUYER)).toBe(20_000);

      // Both paths must share one claim. Two different predicates would each see
      // an unrefunded order and pay out — and the ledger would stay internally
      // consistent, so reconcileBalances could never catch it.
      expect(refundOrderWallet(db, order.id, 'lần hai')).toBe(false);
      expect(getBalance(db, BUYER)).toBe(20_000);
      expect(listLedger(db, BUYER, 10).filter((e) => e.kind === 'order_refund')).toHaveLength(1);
      expect(reconcileBalances(db)).toEqual([]);
    });
  });

  describe('đơn chưa trả tiền thì không giao được', () => {
    it('đơn hết hạn bị từ chối', async () => {
      applyLedgerEntry(db, { discordUserId: BUYER, delta: 20_000, kind: 'bank_topup' });
      const versionId = seedPricedVersion(30_000);
      const order = openOrder(db, config, { discordUserId: BUYER, versionId })!;
      db.prepare('UPDATE orders SET expires_at = 1 WHERE id = ?').run(order.id);
      expireStaleOrders(db);

      // Coins already went back and no transfer ever arrived, so releasing would
      // hand over the file for nothing. The route accepts any id, not only the
      // ones the reconcile view lists.
      const result = await fulfilOrder({ db, delivery: {} as never }, order.id);

      expect(result).toEqual({ ok: false, reason: 'not-paid' });
      expect(findOrderById(db, order.id)?.status).toBe('expired');
      expect(db.prepare('SELECT count(*) AS c FROM audit_log').get()).toEqual({ c: 0 });
    });

    it('đơn còn đang chờ chuyển khoản cũng bị từ chối', async () => {
      const versionId = seedPricedVersion(30_000);
      const order = openOrder(db, config, { discordUserId: BUYER, versionId })!;

      const result = await fulfilOrder({ db, delivery: {} as never }, order.id);

      expect(result).toEqual({ ok: false, reason: 'not-paid' });
    });
  });

  describe('giao hàng thất bại', () => {
    let root: string;

    /** A vault holding the seeded blob, so delivery fails at the DM, not the file. */
    async function seedVault(): Promise<number> {
      const versionId = seedPricedVersion(30_000);
      const sha = 'd'.repeat(64);
      await mkdir(join(root, sha.slice(0, 2)), { recursive: true });
      await writeFile(join(root, sha.slice(0, 2), sha), 'jar');
      return versionId;
    }

    /** Delivery deps whose DM send fails in the requested way. */
    function deliveryThat(mode: 'ok' | 'dm_blocked' | 'error') {
      return {
        db,
        vaultDir: root,
        publicBaseUrl: 'http://localhost:3000',
        attachMaxBytes: 99_999,
        tokenTtlMinutes: 15,
        client: {
          users: {
            fetch: async () => ({
              send: async () => {
                if (mode === 'dm_blocked') {
                  // A real DiscordAPIError: the production code narrows with
                  // instanceof, so a look-alike would take the generic branch.
                  throw new DiscordAPIError(
                    { code: 50007, message: 'Cannot send messages to this user' },
                    50007,
                    403,
                    'POST',
                    'https://discord.com/api/v10/channels/1/messages',
                    {},
                  );
                }
                if (mode === 'error') throw new Error('network down');
              },
            }),
          },
        },
      } as unknown as Parameters<typeof fulfilOrder>[0]['delivery'];
    }

    beforeEach(async () => {
      root = await mkdtemp(join(tmpdir(), 'wallet-deliver-'));
    });

    afterEach(async () => {
      await rm(root, { recursive: true, force: true });
    });

    it('lỗi giao hàng thì GIỮ coin và đơn vẫn giao lại được', async () => {
      applyLedgerEntry(db, { discordUserId: BUYER, delta: 30_000, kind: 'bank_topup' });
      const versionId = await seedVault();
      const order = openOrder(db, config, { discordUserId: BUYER, versionId })!;

      const result = await fulfilOrder({ db, delivery: deliveryThat('error') }, order.id);

      expect(result.ok).toBe(false);
      // A failure is usually temporary. Refunding while the order stays releasable
      // would hand back the coins and then the file — and on a wallet-paid order
      // the download token minted moments earlier is still live and unused.
      expect(getBalance(db, BUYER)).toBe(0);
      expect(findOrderById(db, order.id)?.walletPaid).toBe(30_000);
      // No webhook is coming for a wallet-paid order, so the reconcile view is the
      // only place it can ever be seen again.
      expect(listUndeliveredPaidOrders(db).map((o) => o.id)).toContain(order.id);
    });

    it('giao lại thành công sau khi lỗi thì thu đúng tiền', async () => {
      applyLedgerEntry(db, { discordUserId: BUYER, delta: 30_000, kind: 'bank_topup' });
      const versionId = await seedVault();
      const order = openOrder(db, config, { discordUserId: BUYER, versionId })!;

      await fulfilOrder({ db, delivery: deliveryThat('error') }, order.id);
      const retry = await fulfilOrder({ db, delivery: deliveryThat('ok') }, order.id);

      expect(retry.ok).toBe(true);
      expect(getBalance(db, BUYER)).toBe(0);
      expect(db.prepare('SELECT amount FROM audit_log').get()).toEqual({ amount: 30_000 });
    });

    it('chủ kho hoàn coin tay thì đơn đóng lại, không giao được nữa', async () => {
      applyLedgerEntry(db, { discordUserId: BUYER, delta: 30_000, kind: 'bank_topup' });
      const versionId = await seedVault();
      const order = openOrder(db, config, { discordUserId: BUYER, versionId })!;
      await fulfilOrder({ db, delivery: deliveryThat('error') }, order.id);

      expect(refundOrderWallet(db, order.id, 'chủ kho hoàn coin')).toBe(true);
      markOrderStatus(db, order.id, 'expired');
      expect(getBalance(db, BUYER)).toBe(30_000);

      // Refunded means the order is dead; delivering now would be free.
      const after = await fulfilOrder({ db, delivery: deliveryThat('ok') }, order.id);
      expect(after).toEqual({ ok: false, reason: 'not-paid' });
      expect(reconcileBalances(db)).toEqual([]);
    });

    it('chặn tin nhắn riêng thì KHÔNG hoàn coin', async () => {
      applyLedgerEntry(db, { discordUserId: BUYER, delta: 30_000, kind: 'bank_topup' });
      const versionId = await seedVault();
      const order = openOrder(db, config, { discordUserId: BUYER, versionId })!;

      const result = await fulfilOrder({ db, delivery: deliveryThat('dm_blocked') }, order.id);

      expect(result.reason).toBe('dm_blocked');
      // The download token stays valid, so the file is still theirs to collect —
      // refunding would give it away for free.
      expect(getBalance(db, BUYER)).toBe(0);
      expect(findOrderById(db, order.id)?.status).toBe('dm_blocked');
    });

    it('ghi sổ quỹ theo đủ giá, tính cả phần trả bằng coin', async () => {
      applyLedgerEntry(db, { discordUserId: BUYER, delta: 30_000, kind: 'bank_topup' });
      const versionId = await seedVault();
      const order = openOrder(db, config, { discordUserId: BUYER, versionId })!;

      await fulfilOrder({ db, delivery: deliveryThat('ok') }, order.id);

      // Coins were bought with real money earlier; omitting them would understate
      // the fund by the wallet's share.
      expect(db.prepare('SELECT amount FROM audit_log').get()).toEqual({ amount: 30_000 });
      expect(findOrderById(db, order.id)?.status).toBe('delivered');
    });
  });

  describe('chuyển khoản với đơn có ví', () => {
    it('trả đủ phần còn thiếu thì đơn được thanh toán', () => {
      applyLedgerEntry(db, { discordUserId: BUYER, delta: 20_000, kind: 'bank_topup' });
      const versionId = seedPricedVersion(30_000);
      const order = openOrder(db, config, { discordUserId: BUYER, versionId })!;

      const outcome = applySepayTransfer(db, basePayload({ code: order.code, transferAmount: 10_000 }));

      expect(outcome).toEqual({ handled: 'paid', orderId: order.id });
      expect(findOrderByCode(db, order.code)?.status).toBe('paid');
    });

    it('trả thiếu so với phần còn thiếu thì thành underpaid', () => {
      applyLedgerEntry(db, { discordUserId: BUYER, delta: 20_000, kind: 'bank_topup' });
      const versionId = seedPricedVersion(30_000);
      const order = openOrder(db, config, { discordUserId: BUYER, versionId })!;

      const outcome = applySepayTransfer(db, basePayload({ code: order.code, transferAmount: 5_000 }));

      expect(outcome).toEqual({ handled: 'ignored', why: 'underpaid' });
      expect(listUndeliveredPaidOrders(db).map((o) => o.id)).toContain(order.id);
    });

    it('ghi sổ quỹ đúng giá khi chuyển thừa, không cộng đôi', async () => {
      applyLedgerEntry(db, { discordUserId: BUYER, delta: 20_000, kind: 'bank_topup' });
      const versionId = seedPricedVersion(30_000);
      const order = openOrder(db, config, { discordUserId: BUYER, versionId })!;

      // Transferred the full 30.000 though only 10.000 was owed. The 20.000
      // surplus is credited back to the wallet, so counting it again in the audit
      // row would report a 30.000 plugin as 50.000.
      applySepayTransfer(db, basePayload({ code: order.code, transferAmount: 30_000 }));

      const root = await mkdtemp(join(tmpdir(), 'wallet-audit-'));
      const sha = 'd'.repeat(64);
      await mkdir(join(root, sha.slice(0, 2)), { recursive: true });
      await writeFile(join(root, sha.slice(0, 2), sha), 'jar');
      const delivery = {
        db,
        vaultDir: root,
        publicBaseUrl: 'http://localhost:3000',
        attachMaxBytes: 99_999,
        tokenTtlMinutes: 15,
        client: { users: { fetch: async () => ({ send: async () => undefined }) } },
      } as unknown as Parameters<typeof fulfilOrder>[0]['delivery'];

      await fulfilOrder({ db, delivery }, order.id);
      await rm(root, { recursive: true, force: true });

      expect(db.prepare('SELECT amount FROM audit_log').get()).toEqual({ amount: 30_000 });
    });

    it('trả đủ giá gốc dù ví đã gánh một phần thì phần thừa vào ví', () => {
      applyLedgerEntry(db, { discordUserId: BUYER, delta: 20_000, kind: 'bank_topup' });
      const versionId = seedPricedVersion(30_000);
      const order = openOrder(db, config, { discordUserId: BUYER, versionId })!;

      // Transferred the full price out of habit, though only 10.000 was owed.
      applySepayTransfer(db, basePayload({ code: order.code, transferAmount: 30_000 }));

      expect(findOrderByCode(db, order.code)?.status).toBe('paid');
      expect(getBalance(db, BUYER)).toBe(20_000);
      const [surplus] = listLedger(db, BUYER, 1);
      expect(surplus).toMatchObject({ delta: 20_000, kind: 'overpay', refId: order.id });
    });

    it('chuyển khoản cho đơn đã trả trọn bằng ví thì toàn bộ vào ví', () => {
      applyLedgerEntry(db, { discordUserId: BUYER, delta: 30_000, kind: 'bank_topup' });
      const versionId = seedPricedVersion(30_000);
      const order = openOrder(db, config, { discordUserId: BUYER, versionId })!;

      const outcome = applySepayTransfer(db, basePayload({ code: order.code, transferAmount: 30_000 }));

      // Not delivered twice, and not silently kept either.
      expect(outcome).toEqual({ handled: 'ignored', why: 'not-pending' });
      expect(getBalance(db, BUYER)).toBe(30_000);
      expect(findOrderByCode(db, order.code)?.status).toBe('wallet_paid');
    });

    it('sổ cái luôn khớp số dư sau mọi đường chạy', () => {
      applyLedgerEntry(db, { discordUserId: BUYER, delta: 100_000, kind: 'bank_topup' });
      const versionId = seedPricedVersion(30_000);

      const a = openOrder(db, config, { discordUserId: BUYER, versionId })!;
      const b = openOrder(db, config, { discordUserId: BUYER, versionId })!;
      db.prepare('UPDATE orders SET expires_at = 1 WHERE id = ?').run(a.id);
      expireStaleOrders(db);
      applySepayTransfer(db, basePayload({ code: b.code, transferAmount: 999 }));

      expect(reconcileBalances(db)).toEqual([]);
    });
  });
});
