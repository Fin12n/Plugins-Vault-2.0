import { describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { migrate } from '../src/db/migrate.js';
import { getOverviewAnalytics } from '../src/services/stats/overview-stats.js';

describe('overview stats service', () => {
  it('aggregates revenue timeline and calculates percentages properly', () => {
    const db = new Database(':memory:');
    migrate(db);

    const nowSeconds = Math.floor(Date.now() / 1000);

    // 1 Bank deposit: 300,000 VND
    db.prepare(
      `INSERT INTO wallet_ledger (discord_user_id, delta, balance_after, kind, created_at)
       VALUES ('user1', 300000, 300000, 'bank_topup', ?)`,
    ).run(nowSeconds);

    // 1 Card deposit: 100,000 VND
    db.prepare(
      `INSERT INTO wallet_ledger (discord_user_id, delta, balance_after, kind, created_at)
       VALUES ('user2', 100000, 100000, 'card_topup', ?)`,
    ).run(nowSeconds);

    const data = getOverviewAnalytics(db, '7d', 'all');

    expect(data.summary.totalRevenue).toBe(400000);
    expect(data.summary.bankRevenue).toBe(300000);
    expect(data.summary.cardRevenue).toBe(100000);
    expect(data.summary.totalTransactions).toBe(2);
    expect(data.summary.activeUsers).toBe(2);
    expect(data.summary.averageDeposit).toBe(200000);

    expect(data.breakdown.bankPercent).toBe(75);
    expect(data.breakdown.cardPercent).toBe(25);
    expect(data.timeline.length).toBeGreaterThanOrEqual(1);

    // Filter bank only
    const bankOnly = getOverviewAnalytics(db, '7d', 'bank');
    expect(bankOnly.summary.totalRevenue).toBe(300000);
    expect(bankOnly.summary.bankRevenue).toBe(300000);
    expect(bankOnly.summary.cardRevenue).toBe(0);
    expect(bankOnly.summary.totalTransactions).toBe(1);
  });
});
