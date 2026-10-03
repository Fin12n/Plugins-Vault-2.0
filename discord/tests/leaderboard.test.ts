import { describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { getDepositLeaderboard } from '../src/repositories/leaderboard.js';
import { migrate } from '../src/db/migrate.js';

describe('getDepositLeaderboard repository', () => {
  it('aggregates deposit rankings and calculates correct podium and stats', () => {
    const db = new Database(':memory:');
    migrate(db);

    const now = 1700000000;

    // User A: 500k bank
    db.prepare(`INSERT INTO wallets (discord_user_id, balance, created_at, updated_at) VALUES ('user_a', 500000, ?, ?)`).run(now, now);
    db.prepare(`INSERT INTO wallet_ledger (discord_user_id, delta, balance_after, kind, created_at) VALUES ('user_a', 500000, 500000, 'bank_topup', ?)`).run(now);

    // User B: 300k card
    db.prepare(`INSERT INTO wallets (discord_user_id, balance, created_at, updated_at) VALUES ('user_b', 300000, ?, ?)`).run(now, now);
    db.prepare(`INSERT INTO wallet_ledger (discord_user_id, delta, balance_after, kind, created_at) VALUES ('user_b', 300000, 300000, 'card_topup', ?)`).run(now);

    // User C: 150k bank + 50k card = 200k
    db.prepare(`INSERT INTO wallets (discord_user_id, balance, created_at, updated_at) VALUES ('user_c', 200000, ?, ?)`).run(now, now);
    db.prepare(`INSERT INTO wallet_ledger (discord_user_id, delta, balance_after, kind, created_at) VALUES ('user_c', 150000, 150000, 'bank_topup', ?)`).run(now);
    db.prepare(`INSERT INTO wallet_ledger (discord_user_id, delta, balance_after, kind, created_at) VALUES ('user_c', 50000, 200000, 'card_topup', ?)`).run(now + 10);

    const res = getDepositLeaderboard(db, { since: 0 });

    expect(res.total).toBe(3);
    expect(res.items.length).toBe(3);

    // Rank 1: user_a
    expect(res.items[0].rank).toBe(1);
    expect(res.items[0].discordUserId).toBe('user_a');
    expect(res.items[0].totalDeposited).toBe(500000);
    expect(res.items[0].coins).toBe(500);

    // Rank 2: user_b
    expect(res.items[1].rank).toBe(2);
    expect(res.items[1].discordUserId).toBe('user_b');
    expect(res.items[1].totalDeposited).toBe(300000);

    // Rank 3: user_c
    expect(res.items[2].rank).toBe(3);
    expect(res.items[2].discordUserId).toBe('user_c');
    expect(res.items[2].totalDeposited).toBe(200000);
    expect(res.items[2].bankDeposited).toBe(150000);
    expect(res.items[2].cardDeposited).toBe(50000);
    expect(res.items[2].topupCount).toBe(2);

    // Overall stats
    expect(res.stats.overallTotal).toBe(1000000);
    expect(res.stats.overallUsers).toBe(3);
    expect(res.stats.maxSingleDeposit).toBe(500000);
    expect(res.stats.averageDeposit).toBe(Math.round(1000000 / 3));
  });

  it('filters by timeframe (since parameter)', () => {
    const db = new Database(':memory:');
    migrate(db);

    const oldTime = 1600000000;
    const newTime = 1700000000;

    // Old deposit
    db.prepare(`INSERT INTO wallet_ledger (discord_user_id, delta, balance_after, kind, created_at) VALUES ('old_user', 50000, 50000, 'bank_topup', ?)`).run(oldTime);
    // Recent deposit
    db.prepare(`INSERT INTO wallet_ledger (discord_user_id, delta, balance_after, kind, created_at) VALUES ('new_user', 100000, 100000, 'bank_topup', ?)`).run(newTime);

    const res = getDepositLeaderboard(db, { since: 1650000000 });
    expect(res.total).toBe(1);
    expect(res.items[0].discordUserId).toBe('new_user');
  });
});
