import type { Db } from '../db/connection.js';
import { now } from '../db/connection.js';
import type { CardTopup, CardTopupStatus } from '../domain/card-topup.js';

export type CardTopupRow = {
  id: number;
  request_id: string;
  discord_user_id: string;
  telco: string;
  serial: string;
  code: string;
  declared_value: number;
  actual_value: number | null;
  net_amount: number | null;
  status: string;
  provider_status: number | null;
  provider_message: string;
  trans_id: string | null;
  attempts: number;
  next_poll_at: number | null;
  credited_at: number | null;
  created_at: number;
};

export function toCardTopup(row: CardTopupRow): CardTopup {
  return {
    id: row.id,
    requestId: row.request_id,
    discordUserId: row.discord_user_id,
    telco: row.telco,
    serial: row.serial,
    code: row.code,
    declaredValue: row.declared_value,
    actualValue: row.actual_value,
    netAmount: row.net_amount,
    status: row.status as CardTopupStatus,
    providerStatus: row.provider_status,
    providerMessage: row.provider_message,
    transId: row.trans_id,
    attempts: row.attempts,
    nextPollAt: row.next_poll_at,
    creditedAt: row.credited_at,
    createdAt: row.created_at,
  };
}

const SELECT = 'SELECT * FROM card_topups';

/**
 * Records a card BEFORE it is submitted.
 *
 * Order matters and is the whole point: submitting first and recording after
 * means a crash in between consumes a card with no trace that anyone is owed for
 * it. Recording first can at worst leave a row for a card that was never sent,
 * which the poll resolves.
 */
export function createCardTopup(
  db: Db,
  input: {
    requestId: string;
    discordUserId: string;
    telco: string;
    serial: string;
    code: string;
    declaredValue: number;
    firstPollAt: number;
  },
): CardTopup {
  const info = db
    .prepare(
      `INSERT INTO card_topups (request_id, discord_user_id, telco, serial, code,
                                declared_value, status, next_poll_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?)`,
    )
    .run(
      input.requestId,
      input.discordUserId,
      input.telco,
      input.serial,
      input.code,
      input.declaredValue,
      input.firstPollAt,
      now(),
    );

  const topup = findCardTopupById(db, Number(info.lastInsertRowid));
  if (!topup) throw new Error('Không tạo được phiếu nạp thẻ');
  return topup;
}

export function findCardTopupById(db: Db, id: number): CardTopup | null {
  const row = db.prepare(`${SELECT} WHERE id = ?`).get(id) as CardTopupRow | undefined;
  return row ? toCardTopup(row) : null;
}

export function findCardTopupByRequestId(db: Db, requestId: string): CardTopup | null {
  const row = db.prepare(`${SELECT} WHERE request_id = ?`).get(requestId) as CardTopupRow | undefined;
  return row ? toCardTopup(row) : null;
}

/**
 * True when this serial is already in flight.
 *
 * Guards against a double submission of the same physical card, which card2k may
 * or may not treat idempotently — undocumented, so it is prevented here instead.
 */
export function hasPendingSerial(db: Db, telco: string, serial: string): boolean {
  const row = db
    .prepare("SELECT 1 AS x FROM card_topups WHERE telco = ? AND serial = ? AND status = 'pending' LIMIT 1")
    .get(telco, serial) as { x: number } | undefined;
  return row !== undefined;
}

/** Pending cards due for another check. */
export function listDuePolls(db: Db, limit = 50): CardTopup[] {
  const rows = db
    .prepare(
      `${SELECT} WHERE status = 'pending' AND next_poll_at IS NOT NULL AND next_poll_at <= ?
        ORDER BY next_poll_at ASC LIMIT ?`,
    )
    .all(now(), limit) as CardTopupRow[];
  return rows.map(toCardTopup);
}

/** Records a poll attempt that left the card still pending. */
export function recordPollAttempt(
  db: Db,
  id: number,
  input: { nextPollAt: number; providerStatus?: number | null; providerMessage?: string },
): void {
  db.prepare(
    `UPDATE card_topups
        SET attempts = attempts + 1,
            next_poll_at = ?,
            provider_status = coalesce(?, provider_status),
            provider_message = ?
      WHERE id = ? AND status = 'pending'`,
  ).run(input.nextPollAt, input.providerStatus ?? null, input.providerMessage ?? '', id);
}

/**
 * Moves a card to a terminal state.
 *
 * Only from 'pending', so two overlapping polls cannot both settle it — the later
 * one finds nothing to update and its return value says so.
 */
export function settleCardTopup(
  db: Db,
  id: number,
  input: {
    status: Exclude<CardTopupStatus, 'pending'>;
    actualValue?: number | null;
    netAmount?: number | null;
    providerStatus?: number | null;
    providerMessage?: string;
    transId?: string | null;
  },
): boolean {
  return (
    db
      .prepare(
        `UPDATE card_topups
            SET status = ?, actual_value = ?, net_amount = ?, provider_status = ?,
                provider_message = ?, trans_id = ?, next_poll_at = NULL,
                attempts = attempts + 1
          WHERE id = ? AND status = 'pending'`,
      )
      .run(
        input.status,
        input.actualValue ?? null,
        input.netAmount ?? null,
        input.providerStatus ?? null,
        input.providerMessage ?? '',
        input.transId ?? null,
        id,
      ).changes === 1
  );
}

/**
 * Claims the right to credit a card, exactly once.
 *
 * Returns true only for the caller that flipped credited_at from NULL. Pair with
 * the ledger write in one transaction: that pairing, not any check in application
 * code, is what makes a double credit impossible when two polls overlap.
 */
export function claimCardCredit(db: Db, id: number): boolean {
  return (
    db.prepare('UPDATE card_topups SET credited_at = ? WHERE id = ? AND credited_at IS NULL').run(now(), id)
      .changes === 1
  );
}

/**
 * Scrubs the card PIN.
 *
 * Only for terminal rows: a used PIN is worthless, but a REJECTED one still holds
 * money and the person will want it back to try elsewhere.
 */
export function scrubCardCode(db: Db, id: number): void {
  db.prepare("UPDATE card_topups SET code = '' WHERE id = ? AND status IN ('success', 'wrong_amount')").run(id);
}

export function listCardTopupsByUser(db: Db, discordUserId: string, limit: number): CardTopup[] {
  const rows = db
    .prepare(`${SELECT} WHERE discord_user_id = ? ORDER BY created_at DESC, id DESC LIMIT ?`)
    .all(discordUserId, limit) as CardTopupRow[];
  return rows.map(toCardTopup);
}

/** Cards the owner must resolve by hand. */
export function listCardsNeedingReview(db: Db): CardTopup[] {
  const rows = db
    .prepare(`${SELECT} WHERE status IN ('timeout', 'needs_review') ORDER BY created_at ASC`)
    .all() as CardTopupRow[];
  return rows.map(toCardTopup);
}

export function listCardTopups(db: Db, limit: number, offset = 0): CardTopup[] {
  const rows = db
    .prepare(`${SELECT} ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?`)
    .all(limit, offset) as CardTopupRow[];
  return rows.map(toCardTopup);
}

export function countCardTopups(db: Db): number {
  return (db.prepare('SELECT count(*) AS c FROM card_topups').get() as { c: number }).c;
}

/**
 * Owner's cost for a month: what was credited minus what card2k actually paid. *
 * The fee is absorbed rather than passed on, so this is the only place that number
 * is visible. Counts credited rows only — an uncredited card cost nothing.
 */
export function cardFeeCost(db: Db, from: number, to: number): { credited: number; received: number; cost: number } {
  const row = db
    .prepare(
      `SELECT coalesce(sum(actual_value), 0) AS credited,
              coalesce(sum(net_amount), 0)   AS received
         FROM card_topups
        WHERE credited_at IS NOT NULL AND created_at >= ? AND created_at < ?`,
    )
    .get(from, to) as { credited: number; received: number };

  return { credited: row.credited, received: row.received, cost: row.credited - row.received };
}
