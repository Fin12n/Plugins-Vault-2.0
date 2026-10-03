import type { Db } from '../db/connection.js';
import { now } from '../db/connection.js';
import type { WalletTopup, WalletTopupStatus } from '../domain/wallet.js';

export type WalletTopupRow = {
  id: number;
  code: string;
  discord_user_id: string;
  amount: number;
  paid_amount: number | null;
  status: string;
  created_at: number;
  expires_at: number;
  credited_at: number | null;
};

export function toWalletTopup(row: WalletTopupRow): WalletTopup {
  return {
    id: row.id,
    code: row.code,
    discordUserId: row.discord_user_id,
    amount: row.amount,
    paidAmount: row.paid_amount,
    status: row.status as WalletTopupStatus,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    creditedAt: row.credited_at,
  };
}

const SELECT = 'SELECT * FROM wallet_topups';

export function createWalletTopup(
  db: Db,
  input: { code: string; discordUserId: string; amount: number; ttlMinutes: number },
): WalletTopup {
  const created = now();
  const info = db
    .prepare(
      `INSERT INTO wallet_topups (code, discord_user_id, amount, status, created_at, expires_at)
       VALUES (?, ?, ?, 'pending', ?, ?)`,
    )
    .run(input.code, input.discordUserId, input.amount, created, created + input.ttlMinutes * 60);

  const topup = findTopupById(db, Number(info.lastInsertRowid));
  if (!topup) throw new Error('Không tạo được phiếu nạp');
  return topup;
}

export function findTopupById(db: Db, id: number): WalletTopup | null {
  const row = db.prepare(`${SELECT} WHERE id = ?`).get(id) as WalletTopupRow | undefined;
  return row ? toWalletTopup(row) : null;
}

/** Uppercase, matching how SePay reports whatever it extracted from the memo. */
export function findTopupByCode(db: Db, code: string): WalletTopup | null {
  const row = db.prepare(`${SELECT} WHERE code = ?`).get(code.toUpperCase()) as WalletTopupRow | undefined;
  return row ? toWalletTopup(row) : null;
}

/**
 * Marks a top-up credited, returning false when it was already settled.
 *
 * The `status = 'pending'` predicate lives in the UPDATE so the database decides
 * whether a credit is still owed. Callers pair this with the ledger write in one
 * transaction, which is what makes crediting exactly-once rather than merely
 * usually-once.
 */
export function markTopupCredited(db: Db, id: number, paidAmount: number): boolean {
  return (
    db
      .prepare(
        `UPDATE wallet_topups SET status = 'credited', paid_amount = ?, credited_at = ?
          WHERE id = ? AND status = 'pending'`,
      )
      .run(paidAmount, now(), id).changes === 1
  );
}

export function listTopupsByUser(db: Db, discordUserId: string, limit: number): WalletTopup[] {
  const rows = db
    .prepare(`${SELECT} WHERE discord_user_id = ? ORDER BY created_at DESC, id DESC LIMIT ?`)
    .all(discordUserId, limit) as WalletTopupRow[];
  return rows.map(toWalletTopup);
}

/**
 * Expires unpaid top-ups past their TTL.
 *
 * Nothing to refund, unlike an order: a top-up holds no coins, it only reserves a
 * payment code. Expiring is purely bookkeeping so a stale code stops matching.
 */
export function expireStaleTopups(db: Db): number {
  return db
    .prepare("UPDATE wallet_topups SET status = 'expired' WHERE status = 'pending' AND expires_at <= ?")
    .run(now()).changes;
}

export function countTopupsByCode(db: Db, code: string): number {
  return (
    db.prepare('SELECT count(*) AS c FROM wallet_topups WHERE code = ?').get(code.toUpperCase()) as { c: number }
  ).c;
}
