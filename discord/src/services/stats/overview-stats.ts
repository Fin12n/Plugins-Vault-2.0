import type { Db } from '../../db/connection.js';
import { now } from '../../db/connection.js';

export type OverviewTimeframe = '7d' | '30d' | 'this_month' | 'last_month' | 'custom' | 'all';
export type OverviewTypeFilter = 'all' | 'bank' | 'card';

export type RevenueTimelinePoint = {
  date: string;
  label: string;
  bank: number;
  card: number;
  other: number;
  total: number;
  count: number;
};

export type OverviewSummary = {
  totalRevenue: number;
  bankRevenue: number;
  cardRevenue: number;
  otherRevenue: number;
  totalTransactions: number;
  bankTransactions: number;
  cardTransactions: number;
  activeUsers: number;
  averageDeposit: number;
};

export type OverviewBreakdown = {
  bankPercent: number;
  cardPercent: number;
  otherPercent: number;
};

export type TopTransaction = {
  id: number;
  discordUserId: string;
  delta: number;
  kind: string;
  note: string;
  createdAt: number;
};

export type OverviewAnalytics = {
  timeframe: OverviewTimeframe;
  typeFilter: OverviewTypeFilter;
  summary: OverviewSummary;
  breakdown: OverviewBreakdown;
  timeline: RevenueTimelinePoint[];
  recentTopups: TopTransaction[];
  customFrom?: string;
  customTo?: string;
};

export function getTimeframeBounds(
  timeframe: OverviewTimeframe,
  customFrom?: string,
  customTo?: string,
): { since: number; until?: number; isMonthly: boolean } {
  const currentSeconds = now();
  const currentDate = new Date(currentSeconds * 1000);

  // UTC+7 offset calculation
  const vnOffsetMs = 7 * 60 * 60 * 1000;
  const vnNow = new Date(currentDate.getTime() + vnOffsetMs);
  const vnYear = vnNow.getUTCFullYear();
  const vnMonth = vnNow.getUTCMonth(); // 0-indexed

  if (timeframe === '7d') {
    return { since: currentSeconds - 7 * 86400, isMonthly: false };
  }
  if (timeframe === '30d') {
    return { since: currentSeconds - 30 * 86400, isMonthly: false };
  }
  if (timeframe === 'this_month') {
    const startOfMonthUtcSeconds = Math.floor(Date.UTC(vnYear, vnMonth, 1) / 1000) - 7 * 3600;
    return { since: startOfMonthUtcSeconds, isMonthly: false };
  }
  if (timeframe === 'last_month') {
    const prevMonthYear = vnMonth === 0 ? vnYear - 1 : vnYear;
    const prevMonth = vnMonth === 0 ? 11 : vnMonth - 1;
    const startOfPrevMonthSeconds = Math.floor(Date.UTC(prevMonthYear, prevMonth, 1) / 1000) - 7 * 3600;
    const endOfPrevMonthSeconds = Math.floor(Date.UTC(vnYear, vnMonth, 1) / 1000) - 7 * 3600;
    return { since: startOfPrevMonthSeconds, until: endOfPrevMonthSeconds, isMonthly: false };
  }
  if (timeframe === 'custom' && customFrom) {
    const [y1, m1, d1] = customFrom.split('-').map(Number);
    const startMs = Date.UTC(y1 ?? vnYear, (m1 ?? 1) - 1, d1 ?? 1) - 7 * 3600 * 1000;
    const since = Math.floor(startMs / 1000);
    let until: number | undefined;
    if (customTo) {
      const [y2, m2, d2] = customTo.split('-').map(Number);
      const endMs = Date.UTC(y2 ?? vnYear, (m2 ?? 1) - 1, (d2 ?? 1) + 1) - 7 * 3600 * 1000;
      until = Math.floor(endMs / 1000);
    }
    const isMonthly = until !== undefined ? (until - since) > 90 * 86400 : false;
    return { since, until, isMonthly };
  }

  // 'all'
  return { since: 0, isMonthly: true };
}

export function getOverviewAnalytics(
  db: Db,
  timeframe: OverviewTimeframe = '30d',
  typeFilter: OverviewTypeFilter = 'all',
  customFrom?: string,
  customTo?: string,
): OverviewAnalytics {
  const { since, until, isMonthly } = getTimeframeBounds(timeframe, customFrom, customTo);

  const conditions: string[] = [
    `delta > 0`,
    `kind IN ('bank_topup', 'card_topup', 'overpay', 'manual')`,
    `created_at >= ?`,
  ];
  const params: (number | string)[] = [since];

  if (until !== undefined) {
    conditions.push(`created_at < ?`);
    params.push(until);
  }

  if (typeFilter === 'bank') {
    conditions.push(`kind = 'bank_topup'`);
  } else if (typeFilter === 'card') {
    conditions.push(`kind = 'card_topup'`);
  }

  const whereClause = conditions.join(' AND ');

  // Summary aggregation
  const summaryRow = db
    .prepare(
      `SELECT
        coalesce(sum(delta), 0) AS totalRevenue,
        coalesce(sum(CASE WHEN kind = 'bank_topup' THEN delta ELSE 0 END), 0) AS bankRevenue,
        coalesce(sum(CASE WHEN kind = 'card_topup' THEN delta ELSE 0 END), 0) AS cardRevenue,
        coalesce(sum(CASE WHEN kind IN ('overpay', 'manual') THEN delta ELSE 0 END), 0) AS otherRevenue,
        count(*) AS totalTransactions,
        coalesce(sum(CASE WHEN kind = 'bank_topup' THEN 1 ELSE 0 END), 0) AS bankTransactions,
        coalesce(sum(CASE WHEN kind = 'card_topup' THEN 1 ELSE 0 END), 0) AS cardTransactions,
        count(DISTINCT discord_user_id) AS activeUsers
      FROM wallet_ledger
      WHERE ${whereClause}`,
    )
    .get(...params) as {
      totalRevenue: number;
      bankRevenue: number;
      cardRevenue: number;
      otherRevenue: number;
      totalTransactions: number;
      bankTransactions: number;
      cardTransactions: number;
      activeUsers: number;
    };

  const total = summaryRow.totalRevenue;
  const bankPct = total > 0 ? Math.round((summaryRow.bankRevenue / total) * 100) : 0;
  const cardPct = total > 0 ? Math.round((summaryRow.cardRevenue / total) * 100) : 0;
  const otherPct = total > 0 ? Math.max(0, 100 - bankPct - cardPct) : 0;

  const avgDeposit = summaryRow.totalTransactions > 0
    ? Math.round(summaryRow.totalRevenue / summaryRow.totalTransactions)
    : 0;

  // Timeline aggregation (group by day or by month)
  const groupFormat = isMonthly ? '%Y-%m' : '%Y-%m-%d';
  const timelineRows = db
    .prepare(
      `SELECT
        strftime('${groupFormat}', datetime(created_at, 'unixepoch', '+7 hours')) AS timeKey,
        coalesce(sum(delta), 0) AS total,
        coalesce(sum(CASE WHEN kind = 'bank_topup' THEN delta ELSE 0 END), 0) AS bank,
        coalesce(sum(CASE WHEN kind = 'card_topup' THEN delta ELSE 0 END), 0) AS card,
        coalesce(sum(CASE WHEN kind IN ('overpay', 'manual') THEN delta ELSE 0 END), 0) AS other,
        count(*) AS count
      FROM wallet_ledger
      WHERE ${whereClause}
      GROUP BY timeKey
      ORDER BY timeKey ASC`,
    )
    .all(...params) as {
      timeKey: string;
      total: number;
      bank: number;
      card: number;
      other: number;
      count: number;
    }[];

  const dataMap = new Map<
    string,
    { total: number; bank: number; card: number; other: number; count: number }
  >();
  for (const r of timelineRows) {
    dataMap.set(r.timeKey, r);
  }

  const timeline: RevenueTimelinePoint[] = [];

  function toVnDateKey(timestampSeconds: number): string {
    const d = new Date(timestampSeconds * 1000 + 7 * 3600 * 1000);
    const y = d.getUTCFullYear();
    const m = String(d.getUTCMonth() + 1).padStart(2, '0');
    const day = String(d.getUTCDate()).padStart(2, '0');
    return `${y}-${m}-${day}`;
  }

  function toVnMonthKey(timestampSeconds: number): string {
    const d = new Date(timestampSeconds * 1000 + 7 * 3600 * 1000);
    const y = d.getUTCFullYear();
    const m = String(d.getUTCMonth() + 1).padStart(2, '0');
    return `${y}-${m}`;
  }

  if (!isMonthly) {
    const currentSeconds = now();
    const effectiveStart = since > 0 ? since : currentSeconds - 30 * 86400;
    const effectiveEnd = until !== undefined ? until - 1 : currentSeconds;

    const visitedKeys = new Set<string>();
    // Step forward day by day
    for (let s = effectiveStart; s <= effectiveEnd + 43200; s += 86400) {
      const dateKey = toVnDateKey(s);
      if (visitedKeys.has(dateKey)) continue;
      visitedKeys.add(dateKey);

      const parts = dateKey.split('-');
      const label = `${parts[2]}/${parts[1]}`;
      const entry = dataMap.get(dateKey);

      timeline.push({
        date: dateKey,
        label,
        bank: entry?.bank ?? 0,
        card: entry?.card ?? 0,
        other: entry?.other ?? 0,
        total: entry?.total ?? 0,
        count: entry?.count ?? 0,
      });
    }
  } else {
    // Monthly aggregation
    const currentSeconds = now();
    const currentMonthKey = toVnMonthKey(currentSeconds);

    let startYear = 0;
    let startMonth = 0;
    if (timelineRows.length > 0 && timelineRows[0]?.timeKey) {
      const [y, m] = timelineRows[0].timeKey.split('-').map(Number);
      startYear = y ?? 2026;
      startMonth = m ?? 1;
    } else {
      const d = new Date(currentSeconds * 1000 + 7 * 3600 * 1000);
      startYear = d.getUTCFullYear() - 1;
      startMonth = d.getUTCMonth() + 1;
    }

    const [endYear, endMonth] = currentMonthKey.split('-').map(Number);
    let currY = startYear;
    let currM = startMonth;

    while (currY < (endYear ?? 2026) || (currY === (endYear ?? 2026) && currM <= (endMonth ?? 12))) {
      const monthKey = `${currY}-${String(currM).padStart(2, '0')}`;
      const entry = dataMap.get(monthKey);
      timeline.push({
        date: monthKey,
        label: `T${currM}/${currY}`,
        bank: entry?.bank ?? 0,
        card: entry?.card ?? 0,
        other: entry?.other ?? 0,
        total: entry?.total ?? 0,
        count: entry?.count ?? 0,
      });

      currM++;
      if (currM > 12) {
        currM = 1;
        currY++;
      }
    }
  }

  // Recent high-value topups
  const topRows = db
    .prepare(
      `SELECT id, discord_user_id AS discordUserId, delta, kind, note, created_at AS createdAt
       FROM wallet_ledger
       WHERE ${whereClause}
       ORDER BY created_at DESC, id DESC
       LIMIT 8`,
    )
    .all(...params) as TopTransaction[];

  return {
    timeframe,
    typeFilter,
    summary: {
      totalRevenue: summaryRow.totalRevenue,
      bankRevenue: summaryRow.bankRevenue,
      cardRevenue: summaryRow.cardRevenue,
      otherRevenue: summaryRow.otherRevenue,
      totalTransactions: summaryRow.totalTransactions,
      bankTransactions: summaryRow.bankTransactions,
      cardTransactions: summaryRow.cardTransactions,
      activeUsers: summaryRow.activeUsers,
      averageDeposit: avgDeposit,
    },
    breakdown: {
      bankPercent: bankPct,
      cardPercent: cardPct,
      otherPercent: otherPct,
    },
    timeline,
    recentTopups: topRows,
    customFrom,
    customTo,
  };
}
