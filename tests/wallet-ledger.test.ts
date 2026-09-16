import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Db } from '../src/db/connection.js';
import { migrate } from '../src/db/migrate.js';
import { coinsToVnd, toCoins, VND_PER_COIN } from '../src/domain/wallet.js';
import {
  applyLedgerEntry,
  countLedger,
  countWallets,
  findWallet,
  getBalance,
  listLedger,
  listWallets,
  reconcileBalances,
} from '../src/repositories/wallets.js';

const USER = '100000000000000001';
const OTHER = '100000000000000002';

describe('ví coin', () => {
  let db: Db;

  beforeEach(() => {
    db = new Database(':memory:') as Db;
    db.pragma('foreign_keys = ON');
    migrate(db);
  });

  afterEach(() => db.close());

  describe('quy đổi coin', () => {
    it('làm tròn xuống khi hiển thị nhưng không mất số dư', () => {
      // The whole reason balances are stored in VND: 1.500 ₫ displays as 1 coin
      // while all 1.500 ₫ stays spendable.
      expect(toCoins(1500)).toBe(1);
      expect(toCoins(999)).toBe(0);
      expect(toCoins(1000)).toBe(1);
      expect(coinsToVnd(30)).toBe(30_000);
      expect(VND_PER_COIN).toBe(1000);
    });
  });

  describe('cộng và trừ', () => {
    it('ví chưa tồn tại có số dư 0 và không ném lỗi', () => {
      expect(getBalance(db, USER)).toBe(0);
      expect(findWallet(db, USER)).toBeNull();
      expect(countWallets(db)).toBe(0);
    });

    it('tạo ví ở lần cộng đầu tiên', () => {
      expect(applyLedgerEntry(db, { discordUserId: USER, delta: 50_000, kind: 'card_topup' })).toBe(50_000);
      expect(getBalance(db, USER)).toBe(50_000);
      expect(countWallets(db)).toBe(1);
    });

    it('cộng rồi trừ cho số dư đúng và balance_after khớp từng dòng', () => {
      applyLedgerEntry(db, { discordUserId: USER, delta: 100_000, kind: 'bank_topup' });
      applyLedgerEntry(db, { discordUserId: USER, delta: -30_000, kind: 'order_hold', refType: 'order', refId: 7 });
      applyLedgerEntry(db, { discordUserId: USER, delta: 5_000, kind: 'overpay' });

      expect(getBalance(db, USER)).toBe(75_000);

      // Oldest first, so the running balance can be checked against each delta.
      const entries = listLedger(db, USER, 10).reverse();
      let running = 0;
      for (const entry of entries) {
        running += entry.delta;
        expect(entry.balanceAfter).toBe(running);
      }
      expect(running).toBe(75_000);
    });

    it('giữ nguồn gốc của từng dòng', () => {
      applyLedgerEntry(db, {
        discordUserId: USER,
        delta: -30_000,
        kind: 'order_hold',
        refType: 'order',
        refId: 42,
        note: 'giữ coin cho đơn',
      });
      // Refused: nothing to debit yet.
      expect(getBalance(db, USER)).toBe(0);

      applyLedgerEntry(db, { discordUserId: USER, delta: 30_000, kind: 'card_topup', refType: 'card', refId: 9 });
      const [entry] = listLedger(db, USER, 1);
      expect(entry!.refType).toBe('card');
      expect(entry!.refId).toBe(9);
      expect(entry!.kind).toBe('card_topup');
    });
  });

  describe('không cho âm', () => {
    it('trừ quá số dư trả null và không đổi gì', () => {
      applyLedgerEntry(db, { discordUserId: USER, delta: 20_000, kind: 'bank_topup' });

      const result = applyLedgerEntry(db, { discordUserId: USER, delta: -30_000, kind: 'order_hold' });

      expect(result).toBeNull();
      expect(getBalance(db, USER)).toBe(20_000);
      // The refusal must leave no trace: a rejected debit is not a movement.
      expect(countLedger(db, USER)).toBe(1);
    });

    it('trừ đúng bằng số dư được phép', () => {
      applyLedgerEntry(db, { discordUserId: USER, delta: 20_000, kind: 'bank_topup' });
      expect(applyLedgerEntry(db, { discordUserId: USER, delta: -20_000, kind: 'order_hold' })).toBe(0);
      expect(getBalance(db, USER)).toBe(0);
    });

    it('trừ trên ví chưa tồn tại bị từ chối', () => {
      expect(applyLedgerEntry(db, { discordUserId: USER, delta: -1, kind: 'order_hold' })).toBeNull();
    });
  });

  describe('đối chiếu sổ cái', () => {
    it('số dư luôn bằng tổng sổ cái sau nhiều thao tác', () => {
      // Deterministic pseudo-random: a fixed sequence keeps a failure reproducible.
      let seed = 12345;
      const next = () => (seed = (seed * 1103515245 + 12345) % 2147483648);

      for (let i = 0; i < 200; i++) {
        const user = next() % 2 === 0 ? USER : OTHER;
        const credit = next() % 3 !== 0;
        const magnitude = (next() % 20) * 1000;
        applyLedgerEntry(db, {
          discordUserId: user,
          delta: credit ? magnitude : -magnitude,
          kind: credit ? 'card_topup' : 'order_hold',
        });
      }

      expect(reconcileBalances(db)).toEqual([]);
    });

    it('phát hiện được khi số dư bị sửa mà không ghi sổ', () => {
      applyLedgerEntry(db, { discordUserId: USER, delta: 10_000, kind: 'bank_topup' });
      // Simulates the bug this check exists to catch: a write path bypassing the
      // ledger. Nothing in src/ may do this.
      db.prepare('UPDATE wallets SET balance = 999 WHERE discord_user_id = ?').run(USER);

      const drift = reconcileBalances(db);
      expect(drift).toHaveLength(1);
      expect(drift[0]).toMatchObject({ discordUserId: USER, balance: 999, ledgerSum: 10_000 });
    });
  });

  describe('danh sách ví', () => {
    it('sắp theo số dư giảm dần', () => {
      applyLedgerEntry(db, { discordUserId: USER, delta: 10_000, kind: 'bank_topup' });
      applyLedgerEntry(db, { discordUserId: OTHER, delta: 90_000, kind: 'bank_topup' });

      expect(listWallets(db, 10).map((w) => w.discordUserId)).toEqual([OTHER, USER]);
      expect(countWallets(db)).toBe(2);
    });

    it('phân trang sổ cái', () => {
      for (let i = 0; i < 5; i++) {
        applyLedgerEntry(db, { discordUserId: USER, delta: 1_000, kind: 'card_topup' });
      }
      expect(countLedger(db, USER)).toBe(5);
      expect(listLedger(db, USER, 2, 0)).toHaveLength(2);
      expect(listLedger(db, USER, 2, 4)).toHaveLength(1);
    });
  });

  describe('ràng buộc database', () => {
    it('chặn kind không hợp lệ', () => {
      expect(() =>
        db
          .prepare(
            `INSERT INTO wallet_ledger (discord_user_id, delta, balance_after, kind, created_at)
             VALUES (?, 1, 1, 'nonsense', 0)`,
          )
          .run(USER),
      ).toThrow();
    });

    it('chặn số dư âm ở tầng cột', () => {
      expect(() =>
        db
          .prepare('INSERT INTO wallets (discord_user_id, balance, created_at, updated_at) VALUES (?, -1, 0, 0)')
          .run(USER),
      ).toThrow();
    });
  });
});
