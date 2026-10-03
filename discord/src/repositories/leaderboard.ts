/**
 * Leaderboard repository for coin wallet deposits.
 */
import type { Db } from '../db/connection.js';

export type LeaderboardEntry = {
  rank: number;
  discordUserId: string;
  totalDeposited: number;
  coins: number;
  bankDeposited: number;
  cardDeposited: number;
  otherDeposited: number;
  topupCount: number;
  currentBalance: number;
  lastTopupAt: number;
};

export type LeaderboardStats = {
  overallTotal: number;
  overallUsers: number;
  averageDeposit: number;
  maxSingleDeposit: number;
};

export type LeaderboardResult = {
  items: LeaderboardEntry[];
  stats: LeaderboardStats;
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
  resetAt: number | null;
};

export function getLeaderboardResetAt(db: Db): number | null {
  const row = db.prepare(`SELECT value FROM config WHERE key = 'leaderboard_reset_at'`).get() as
    | { value: string }
    | undefined;
  if (!row) return null;
  const num = parseInt(row.value, 10);
  return Number.isNaN(num) ? null : num;
}

export function setLeaderboardResetAt(db: Db, resetAt: number | null): void {
  if (resetAt === null) {
    db.prepare(`DELETE FROM config WHERE key = 'leaderboard_reset_at'`).run();
  } else {
    db.prepare(`INSERT OR REPLACE INTO config (key, value) VALUES ('leaderboard_reset_at', ?)`).run(
      String(resetAt),
    );
  }
}

export function getDepositLeaderboard(
  db: Db,
  options: { since?: number; page?: number; pageSize?: number } = {},
): LeaderboardResult {
  const resetAt = getLeaderboardResetAt(db);
  const baselineSince = resetAt ?? 0;
  const since = Math.max(options.since ?? 0, baselineSince);
  const page = Math.max(1, options.page ?? 1);
  const pageSize = Math.max(1, Math.min(100, options.pageSize ?? 25));
  const offset = (page - 1) * pageSize;

  const countRow = db
    .prepare(
      `SELECT count(DISTINCT discord_user_id) AS c
       FROM wallet_ledger
       WHERE delta > 0
         AND kind IN ('bank_topup', 'card_topup', 'overpay', 'manual')
         AND (? = 0 OR created_at >= ?)`,
    )
    .get(since, since) as { c: number } | undefined;
  const total = countRow?.c ?? 0;

  const statsRow = db
    .prepare(
      `SELECT
         coalesce(sum(delta), 0) AS overallTotal,
         count(DISTINCT discord_user_id) AS overallUsers,
         coalesce(max(delta), 0) AS maxSingleDeposit
       FROM wallet_ledger
       WHERE delta > 0
         AND kind IN ('bank_topup', 'card_topup', 'overpay', 'manual')
         AND (? = 0 OR created_at >= ?)`,
    )
    .get(since, since) as
    | { overallTotal: number; overallUsers: number; maxSingleDeposit: number }
    | undefined;

  const overallTotal = statsRow?.overallTotal ?? 0;
  const overallUsers = statsRow?.overallUsers ?? 0;
  const maxSingleDeposit = statsRow?.maxSingleDeposit ?? 0;
  const averageDeposit = overallUsers > 0 ? Math.round(overallTotal / overallUsers) : 0;

  const rows = db
    .prepare(
      `SELECT
         l.discord_user_id AS discordUserId,
         coalesce(sum(l.delta), 0) AS totalDeposited,
         coalesce(sum(CASE WHEN l.kind = 'bank_topup' THEN l.delta ELSE 0 END), 0) AS bankDeposited,
         coalesce(sum(CASE WHEN l.kind = 'card_topup' THEN l.delta ELSE 0 END), 0) AS cardDeposited,
         coalesce(sum(CASE WHEN l.kind IN ('overpay', 'manual') THEN l.delta ELSE 0 END), 0) AS otherDeposited,
         count(1) AS topupCount,
         coalesce(w.balance, 0) AS currentBalance,
         max(l.created_at) AS lastTopupAt
       FROM wallet_ledger l
       LEFT JOIN wallets w ON w.discord_user_id = l.discord_user_id
       WHERE l.delta > 0
         AND l.kind IN ('bank_topup', 'card_topup', 'overpay', 'manual')
         AND (? = 0 OR l.created_at >= ?)
       GROUP BY l.discord_user_id
       HAVING totalDeposited > 0
       ORDER BY totalDeposited DESC, lastTopupAt ASC
       LIMIT ? OFFSET ?`,
    )
    .all(since, since, pageSize, offset) as Array<{
    discordUserId: string;
    totalDeposited: number;
    bankDeposited: number;
    cardDeposited: number;
    otherDeposited: number;
    topupCount: number;
    currentBalance: number;
    lastTopupAt: number;
  }>;

  const items: LeaderboardEntry[] = rows.map((row, index) => ({
    rank: offset + index + 1,
    discordUserId: row.discordUserId,
    totalDeposited: row.totalDeposited,
    coins: Math.floor(row.totalDeposited / 1000),
    bankDeposited: row.bankDeposited,
    cardDeposited: row.cardDeposited,
    otherDeposited: row.otherDeposited,
    topupCount: row.topupCount,
    currentBalance: row.currentBalance,
    lastTopupAt: row.lastTopupAt,
  }));

  return {
    items,
    stats: {
      overallTotal,
      overallUsers,
      averageDeposit,
      maxSingleDeposit,
    },
    total,
    page,
    pageSize,
    totalPages: Math.max(1, Math.ceil(total / pageSize)),
    resetAt,
  };
}
