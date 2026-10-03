import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Db } from '../src/db/connection.js';
import { migrate } from '../src/db/migrate.js';
import { createPlugin } from '../src/repositories/plugins.js';
import { createVersion } from '../src/repositories/versions.js';
import {
  expireStaleTopups,
  findTopupById,
  findTopupByCode,
  listTopupsByUser,
} from '../src/repositories/wallet-topups.js';
import { getBalance, listLedger, reconcileBalances } from '../src/repositories/wallets.js';
import { applySepayTransfer, openOrder, type OrderConfig } from '../src/services/payment/match-and-fulfil-order.js';
import { isCodeAvailable, openWalletTopup } from '../src/services/payment/open-wallet-topup.js';
import type { SepayWebhookPayload } from '../src/domain/order.js';
import { parseTopupAmount } from '../src/bot/commands/wallet-commands.js';

const USER = '100000000000000001';

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

describe('nạp ví qua chuyển khoản', () => {
  let db: Db;

  beforeEach(() => {
    db = new Database(':memory:') as Db;
    db.pragma('foreign_keys = ON');
    migrate(db);
  });

  afterEach(() => db.close());

  describe('mở phiếu nạp', () => {
    it('sinh mã và QR đúng số tiền', () => {
      const topup = openWalletTopup(db, config, { discordUserId: USER, amount: 50_000 })!;

      expect(topup.code).toMatch(/^VN[A-Z0-9]{8}$/);
      expect(topup.qrUrl).toContain('amount=50000');
      expect(topup.qrUrl).toContain(topup.code);
      expect(findTopupById(db, topup.id)?.status).toBe('pending');
    });

    it('từ chối số tiền không hợp lệ', () => {
      expect(openWalletTopup(db, config, { discordUserId: USER, amount: 0 })).toBeNull();
      expect(openWalletTopup(db, config, { discordUserId: USER, amount: -1000 })).toBeNull();
      expect(openWalletTopup(db, config, { discordUserId: USER, amount: 1.5 })).toBeNull();
    });
  });

  describe('không trùng mã với đơn plugin', () => {
    it('mã đã dùng cho đơn thì phiếu nạp không nhận', () => {
      const plugin = createPlugin(db, {
        slug: 'p',
        displayName: 'P',
        descriptorName: 'P',
        platform: 'spigot',
      });
      db.prepare('UPDATE plugins SET deposit_price = 10000 WHERE id = ?').run(plugin.id);
      const sha = 'e'.repeat(64);
      const versionId = createVersion(db, {
        pluginId: plugin.id,
        version: '1.0',
        rawVersion: '1.0',
        sha256: sha,
        relPath: `${sha.slice(0, 2)}/${sha}`,
        bytes: 1,
        originalName: 'p.jar',
        descriptorKind: 'spigot',
        versionFlag: 'ok',
      }).id;

      const order = openOrder(db, config, { discordUserId: USER, versionId })!;

      // The two tables share one code space, and neither UNIQUE constraint can
      // see the other — so the check has to span both.
      expect(isCodeAvailable(db, order.code)).toBe(false);
    });

    it('mã đã dùng cho phiếu nạp thì đơn không nhận', () => {
      const topup = openWalletTopup(db, config, { discordUserId: USER, amount: 20_000 })!;
      expect(isCodeAvailable(db, topup.code)).toBe(false);
      expect(isCodeAvailable(db, topup.code.toLowerCase())).toBe(false);
    });
  });

  describe('nhận chuyển khoản', () => {
    it('cộng đúng số tiền thực nhận', () => {
      const topup = openWalletTopup(db, config, { discordUserId: USER, amount: 50_000 })!;

      const outcome = applySepayTransfer(db, basePayload({ code: topup.code, transferAmount: 50_000 }));

      expect(outcome).toMatchObject({ handled: 'topup', topupId: topup.id, credited: 50_000 });
      expect(getBalance(db, USER)).toBe(50_000);
      expect(findTopupById(db, topup.id)).toMatchObject({ status: 'credited', paidAmount: 50_000 });
    });

    it('chuyển thiếu vẫn cộng đúng số đã chuyển, không có underpaid', () => {
      // The deliberate asymmetry with orders: a top-up sells nothing, so there is
      // no shortfall to withhold against.
      const topup = openWalletTopup(db, config, { discordUserId: USER, amount: 50_000 })!;

      applySepayTransfer(db, basePayload({ code: topup.code, transferAmount: 30_000 }));

      expect(getBalance(db, USER)).toBe(30_000);
      expect(findTopupById(db, topup.id)?.status).toBe('credited');
    });

    it('chuyển thừa cũng cộng đủ', () => {
      const topup = openWalletTopup(db, config, { discordUserId: USER, amount: 50_000 })!;
      applySepayTransfer(db, basePayload({ code: topup.code, transferAmount: 70_000 }));
      expect(getBalance(db, USER)).toBe(70_000);
    });

    it('webhook lặp không cộng hai lần', () => {
      const topup = openWalletTopup(db, config, { discordUserId: USER, amount: 50_000 })!;
      const payload = basePayload({ code: topup.code, transferAmount: 50_000 });

      applySepayTransfer(db, payload);
      // Same sepay id: caught by the transaction dedupe before anything else.
      expect(applySepayTransfer(db, payload)).toEqual({ handled: 'duplicate' });
      expect(getBalance(db, USER)).toBe(50_000);
    });

    it('hai webhook khác id cho cùng phiếu chỉ cộng một lần', () => {
      const topup = openWalletTopup(db, config, { discordUserId: USER, amount: 50_000 })!;

      applySepayTransfer(db, basePayload({ code: topup.code, transferAmount: 50_000 }));
      // A different transaction that names an already-credited top-up: the
      // status predicate is the second layer of the exactly-once guard.
      const second = applySepayTransfer(db, basePayload({ code: topup.code, transferAmount: 50_000 }));

      expect(second).toEqual({ handled: 'ignored', why: 'not-pending' });
      expect(getBalance(db, USER)).toBe(50_000);
    });

    it('ghi sổ cái trỏ về phiếu nạp', () => {
      const topup = openWalletTopup(db, config, { discordUserId: USER, amount: 50_000 })!;
      applySepayTransfer(db, basePayload({ code: topup.code, transferAmount: 50_000 }));

      const [entry] = listLedger(db, USER, 1);
      expect(entry).toMatchObject({ delta: 50_000, kind: 'bank_topup', refType: 'topup', refId: topup.id });
      expect(reconcileBalances(db)).toEqual([]);
    });

    it('mã lạ vẫn báo no-order như trước', () => {
      const outcome = applySepayTransfer(db, basePayload({ code: 'VNNOPE001', transferAmount: 10_000 }));
      expect(outcome).toEqual({ handled: 'ignored', why: 'no-order' });
    });

    it('khớp mã không phân biệt hoa thường', () => {
      const topup = openWalletTopup(db, config, { discordUserId: USER, amount: 10_000 })!;
      applySepayTransfer(db, basePayload({ code: topup.code.toLowerCase(), transferAmount: 10_000 }));
      expect(getBalance(db, USER)).toBe(10_000);
    });
  });

  describe('hết hạn', () => {
    it('phiếu quá hạn chuyển sang expired và không hoàn gì', () => {
      const topup = openWalletTopup(db, config, { discordUserId: USER, amount: 50_000 })!;
      db.prepare('UPDATE wallet_topups SET expires_at = 1 WHERE id = ?').run(topup.id);

      expect(expireStaleTopups(db)).toBe(1);
      expect(findTopupById(db, topup.id)?.status).toBe('expired');
      // Nothing was ever held, so there is nothing to give back.
      expect(getBalance(db, USER)).toBe(0);
      expect(listLedger(db, USER, 10)).toEqual([]);
    });

    it('không đụng phiếu đã cộng', () => {
      const topup = openWalletTopup(db, config, { discordUserId: USER, amount: 50_000 })!;
      applySepayTransfer(db, basePayload({ code: topup.code, transferAmount: 50_000 }));
      db.prepare('UPDATE wallet_topups SET expires_at = 1 WHERE id = ?').run(topup.id);

      expect(expireStaleTopups(db)).toBe(0);
      expect(findTopupById(db, topup.id)?.status).toBe('credited');
    });

    it('phiếu hết hạn rồi thì chuyển khoản đến không cộng ví', () => {
      const topup = openWalletTopup(db, config, { discordUserId: USER, amount: 50_000 })!;
      db.prepare('UPDATE wallet_topups SET expires_at = 1 WHERE id = ?').run(topup.id);
      expireStaleTopups(db);

      const outcome = applySepayTransfer(db, basePayload({ code: topup.code, transferAmount: 50_000 }));

      expect(outcome).toEqual({ handled: 'ignored', why: 'not-pending' });
      expect(getBalance(db, USER)).toBe(0);
    });
  });

  describe('lịch sử', () => {
    it('liệt kê phiếu của một người, mới nhất trước', () => {
      const first = openWalletTopup(db, config, { discordUserId: USER, amount: 10_000 })!;
      const second = openWalletTopup(db, config, { discordUserId: USER, amount: 20_000 })!;

      const listed = listTopupsByUser(db, USER, 10);
      expect(listed.map((t) => t.id)).toEqual([second.id, first.id]);
      expect(findTopupByCode(db, first.code)?.id).toBe(first.id);
    });
  });
});

describe('nhập số tiền nạp', () => {
  it('nhận số trần', () => {
    expect(parseTopupAmount('50000')).toBe(50_000);
  });

  it('nhận dấu chấm và phẩy như bàn phím Việt', () => {
    // Rejecting the separators people actually type reads as the bot being broken.
    expect(parseTopupAmount('50.000')).toBe(50_000);
    expect(parseTopupAmount('50,000')).toBe(50_000);
    expect(parseTopupAmount('1.000.000')).toBe(1_000_000);
    expect(parseTopupAmount(' 50.000 ₫ ')).toBe(50_000);
  });

  it('hiểu số nhỏ là số coin', () => {
    // Nobody transfers 50 ₫, so "50" can only mean fifty coins — and the shop
    // quotes every price in coins.
    expect(parseTopupAmount('50')).toBe(50_000);
    expect(parseTopupAmount('10')).toBe(10_000);
  });

  it('từ chối chữ và số ngoài khoảng', () => {
    expect(parseTopupAmount('abc')).toBeNull();
    expect(parseTopupAmount('')).toBeNull();
    expect(parseTopupAmount('0')).toBeNull();
    expect(parseTopupAmount('-5000')).toBeNull();
    expect(parseTopupAmount('999999999999')).toBeNull();
  });
});
