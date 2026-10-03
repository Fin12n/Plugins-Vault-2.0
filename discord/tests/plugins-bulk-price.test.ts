import { describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { bulkUpdatePluginPrices } from '../src/repositories/plugins.js';
import { migrate } from '../src/db/migrate.js';

describe('bulkUpdatePluginPrices repository', () => {
  it('updates specific plugin ids with fixed price', () => {
    const db = new Database(':memory:');
    migrate(db);

    const now = 1700000000;
    db.prepare(`INSERT INTO plugins (id, display_name, slug, descriptor_name, platform, deposit_price, created_at) VALUES (1, 'Plugin A', 'plugin-a', 'PluginA', 'spigot', 10000, ?)`).run(now);
    db.prepare(`INSERT INTO plugins (id, display_name, slug, descriptor_name, platform, deposit_price, created_at) VALUES (2, 'Plugin B', 'plugin-b', 'PluginB', 'spigot', 15000, ?)`).run(now);
    db.prepare(`INSERT INTO plugins (id, display_name, slug, descriptor_name, platform, deposit_price, created_at) VALUES (3, 'Plugin C', 'plugin-c', 'PluginC', 'spigot', 20000, ?)`).run(now);

    const count = bulkUpdatePluginPrices(db, {
      ids: [1, 2],
      mode: 'set',
      value: 30000,
    });

    expect(count).toBe(2);
    const p1 = db.prepare('SELECT deposit_price FROM plugins WHERE id = 1').get() as { deposit_price: number };
    const p2 = db.prepare('SELECT deposit_price FROM plugins WHERE id = 2').get() as { deposit_price: number };
    const p3 = db.prepare('SELECT deposit_price FROM plugins WHERE id = 3').get() as { deposit_price: number };

    expect(p1.deposit_price).toBe(30000);
    expect(p2.deposit_price).toBe(30000);
    expect(p3.deposit_price).toBe(20000);
  });

  it('updates plugins by fixed delta (add / subtract)', () => {
    const db = new Database(':memory:');
    migrate(db);

    const now = 1700000000;
    db.prepare(`INSERT INTO plugins (id, display_name, slug, descriptor_name, platform, deposit_price, created_at) VALUES (1, 'Plugin A', 'plugin-a', 'PluginA', 'spigot', 10000, ?)`).run(now);
    db.prepare(`INSERT INTO plugins (id, display_name, slug, descriptor_name, platform, deposit_price, created_at) VALUES (2, 'Plugin B', 'plugin-b', 'PluginB', 'spigot', 2000, ?)`).run(now);

    // Subtract 5000; deposit_price must not go below 0
    bulkUpdatePluginPrices(db, {
      ids: [1, 2],
      mode: 'add_fixed',
      value: -5000,
    });

    const p1 = db.prepare('SELECT deposit_price FROM plugins WHERE id = 1').get() as { deposit_price: number };
    const p2 = db.prepare('SELECT deposit_price FROM plugins WHERE id = 2').get() as { deposit_price: number };

    expect(p1.deposit_price).toBe(5000);
    expect(p2.deposit_price).toBe(0); // Clamped at 0
  });

  it('updates plugins by percentage discount and rounds cleanly', () => {
    const db = new Database(':memory:');
    migrate(db);

    const now = 1700000000;
    db.prepare(`INSERT INTO plugins (id, display_name, slug, descriptor_name, platform, deposit_price, created_at) VALUES (1, 'Plugin A', 'plugin-a', 'PluginA', 'spigot', 20000, ?)`).run(now);

    // 25% discount -> 15000
    bulkUpdatePluginPrices(db, {
      ids: [1],
      mode: 'multiply_percent',
      value: -25,
    });

    const p1 = db.prepare('SELECT deposit_price FROM plugins WHERE id = 1').get() as { deposit_price: number };
    expect(p1.deposit_price).toBe(15000);
  });

  it('supports allMatching flag with optional query filter', () => {
    const db = new Database(':memory:');
    migrate(db);

    const now = 1700000000;
    db.prepare(`INSERT INTO plugins (id, display_name, slug, descriptor_name, platform, deposit_price, created_at) VALUES (1, 'Vulcan AC', 'vulcan-ac', 'Vulcan', 'spigot', 10000, ?)`).run(now);
    db.prepare(`INSERT INTO plugins (id, display_name, slug, descriptor_name, platform, deposit_price, created_at) VALUES (2, 'Matrix AC', 'matrix-ac', 'Matrix', 'spigot', 10000, ?)`).run(now);
    db.prepare(`INSERT INTO plugins (id, display_name, slug, descriptor_name, platform, deposit_price, created_at) VALUES (3, 'Citizens', 'citizens', 'Citizens', 'spigot', 10000, ?)`).run(now);

    const count = bulkUpdatePluginPrices(db, {
      allMatching: true,
      query: 'AC',
      mode: 'set',
      value: 50000,
    });

    expect(count).toBe(2);
    const p3 = db.prepare('SELECT deposit_price FROM plugins WHERE id = 3').get() as { deposit_price: number };
    expect(p3.deposit_price).toBe(10000);
  });
});
