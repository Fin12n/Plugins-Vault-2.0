/**
 * Wallet balances and their ledger.
 *
 * Every balance change goes through applyLedgerEntry. There is deliberately no
 * other way to write `wallets.balance` — a direct UPDATE somewhere else is
 * exactly how a stored balance and its history drift apart, and once they have
 * drifted there is no way to tell which one is right.
 */
import type { Db } from '../db/connection.js';
import { now } from '../db/connection.js';
import { toLedgerEntry, toWallet, type LedgerRow, type WalletRow } from '../db/row-mappers.js';
import type { LedgerEntry, LedgerKind, LedgerRefType, Wallet } from '../domain/wallet.js';

export function findWallet(db: Db, discordUserId: string): Wallet | null {
  const row = db.prepare('SELECT * FROM wallets WHERE discord_user_id = ?').get(discordUserId) as
    | WalletRow
    | undefined;
  return row ? toWallet(row) : null;
}

/**
 * Current balance in VND. Returns 0 for someone who has never had a wallet,
 * rather than throwing: "no wallet yet" and "empty wallet" are the same thing to
 * every caller, and a row is only worth creating once money moves.
 */
export function getBalance(db: Db, discordUserId: string): number {
  const row = db.prepare('SELECT balance FROM wallets WHERE discord_user_id = ?').get(discordUserId) as
    | { balance: number }
    | undefined;
  return row?.balance ?? 0;
}

export type LedgerInput = {
  discordUserId: string;
  /** VND. Positive credits, negative debits. */
  delta: number;
  kind: LedgerKind;
  refType?: LedgerRefType;
  refId?: number | null;
  note?: string;
};

/**
 * Moves a balance and records why, atomically.
 *
 * Returns the new balance, or null when a debit exceeds what is there. Refusing
 * up front rather than letting the CHECK constraint fire matters: an overdraw is
 * a routine race (two orders opened at once), not a corrupt database, and it
 * should read as a "no" the caller can act on instead of an exception.
 *
 * Callers that must not credit twice — a payment webhook, a card poll — need
 * their own idempotency guard in the SAME transaction as this call. This
 * function is atomic, not idempotent: called twice it credits twice, correctly.
 */
export function applyLedgerEntry(db: Db, input: LedgerInput): number | null {
  const apply = db.transaction((): number | null => {
    const at = now();

    // Create on first use. INSERT OR IGNORE rather than a read-then-write, so
    // two concurrent first credits cannot both decide the wallet is missing.
    db.prepare(
      `INSERT INTO wallets (discord_user_id, balance, created_at, updated_at)
       VALUES (?, 0, ?, ?)
       ON CONFLICT (discord_user_id) DO NOTHING`,
    ).run(input.discordUserId, at, at);

    const current = getBalance(db, input.discordUserId);
    const next = current + input.delta;
    if (next < 0) return null;

    db.prepare('UPDATE wallets SET balance = ?, updated_at = ? WHERE discord_user_id = ?').run(
      next,
      at,
      input.discordUserId,
    );

    db.prepare(
      `INSERT INTO wallet_ledger (discord_user_id, delta, balance_after, kind,
                                  ref_type, ref_id, note, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      input.discordUserId,
      input.delta,
      next,
      input.kind,
      input.refType ?? '',
      input.refId ?? null,
      input.note ?? '',
      at,
    );

    return next;
  });

  return apply();
}

/** Ledger for one wallet, newest first. */
export function listLedger(db: Db, discordUserId: string, limit: number, offset = 0): LedgerEntry[] {
  const rows = db
    .prepare(
      `SELECT * FROM wallet_ledger WHERE discord_user_id = ?
        ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?`,
    )
    .all(discordUserId, limit, offset) as LedgerRow[];
  return rows.map(toLedgerEntry);
}

export function countLedger(db: Db, discordUserId: string): number {
  return (
    db.prepare('SELECT count(*) AS c FROM wallet_ledger WHERE discord_user_id = ?').get(discordUserId) as {
      c: number;
    }
  ).c;
}

/**
 * Wallets holding money, richest first.
 *
 * `search` khớp theo tiền tố của Discord ID: chủ kho có ID trong tay (copy từ
 * Discord) và cần đúng ví đó, còn phân trang 25 dòng một lần thì phải lật qua hàng
 * chục trang mới thấy — nhất là khi thứ tự là theo số dư giảm dần.
 */
export function listWallets(db: Db, limit: number, offset = 0, search?: string): Wallet[] {
  const rows = search
    ? (db
        .prepare(
          `SELECT * FROM wallets WHERE discord_user_id LIKE ?
           ORDER BY balance DESC, discord_user_id ASC LIMIT ? OFFSET ?`,
        )
        .all(`${search}%`, limit, offset) as WalletRow[])
    : (db
        .prepare('SELECT * FROM wallets ORDER BY balance DESC, discord_user_id ASC LIMIT ? OFFSET ?')
        .all(limit, offset) as WalletRow[]);
  return rows.map(toWallet);
}

export function countWallets(db: Db, search?: string): number {
  if (search) {
    return (
      db.prepare('SELECT count(*) AS c FROM wallets WHERE discord_user_id LIKE ?').get(`${search}%`) as { c: number }
    ).c;
  }
  return (db.prepare('SELECT count(*) AS c FROM wallets').get() as { c: number }).c;
}

/**
 * Tổng số dư đang nợ người dùng, tính theo VNĐ.
 *
 * Đây là khoản đối ứng của quỹ: tiền đã nhận nhưng chưa dùng để mua gì, nên nó KHÔNG
 * phải tiền của quỹ. Không có con số này thì trang thống kê nói quỹ có X, còn phần
 * người dùng còn quyền chi vẫn nằm ẩn trong hai mươi ví lẻ.
 */
export function sumWalletBalances(db: Db): number {
  return (db.prepare('SELECT coalesce(sum(balance), 0) AS total FROM wallets').get() as { total: number }).total;
}

export type BalanceDrift = { discordUserId: string; balance: number; ledgerSum: number };

/**
 * Wallets whose stored balance disagrees with the sum of their ledger.
 *
 * Always expected to be empty. It is non-empty only if some code path changed a
 * balance without recording it, which is silent and unrecoverable by the time
 * anyone notices — so it is surfaced on the dashboard and asserted in tests.
 */
export function reconcileBalances(db: Db): BalanceDrift[] {
  return db
    .prepare(
      `SELECT w.discord_user_id AS discordUserId,
              w.balance         AS balance,
              coalesce(sum(l.delta), 0) AS ledgerSum
         FROM wallets w
         LEFT JOIN wallet_ledger l ON l.discord_user_id = w.discord_user_id
        GROUP BY w.discord_user_id
       HAVING w.balance != coalesce(sum(l.delta), 0)`,
    )
    .all() as BalanceDrift[];
}
