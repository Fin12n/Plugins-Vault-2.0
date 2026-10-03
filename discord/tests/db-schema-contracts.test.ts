import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { migrate } from '../src/db/migrate.js';

/**
 * Schema and migration contract tests. These lock in the constraints later
 * phases depend on — SQLite cannot add constraints after the fact, so a
 * regression here means a full table rebuild.
 */
function freshDb(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  return db;
}

const schemaSql = readFileSync(join(process.cwd(), 'src/db/schema.sql'), 'utf8');

function migrated(): Database.Database {
  const db = freshDb();
  migrate(db);
  return db;
}

describe('migrate', () => {
  it('applies every migration then becomes a no-op', () => {
    const db = freshDb();
    expect(migrate(db)).toEqual({ applied: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12], from: 0, to: 12 });
    expect(migrate(db)).toEqual({ applied: [], from: 12, to: 12 });
    db.close();
  });

  it('rebuilds orders without orphaning its foreign keys', () => {
    // The rebuild in migration 2 runs with foreign_keys=OFF, so a mistake here
    // would not raise — it would silently leave dangling references behind.
    const db = migrated();
    expect(db.pragma('foreign_key_check')).toEqual([]);
    expect(db.pragma('foreign_keys', { simple: true })).toBe(1);
    db.close();
  });

  it('accepts underpaid as an order status and rejects an unknown one', () => {
    const db = migrated();
    db.prepare(
      `INSERT INTO plugins (slug, display_name, descriptor_name, platform, deposit_price, is_premium, created_at)
       VALUES ('p', 'P', 'P', 'spigot', 20000, 0, 1)`,
    ).run();
    const insert = (status: string) =>
      db
        .prepare(
          `INSERT INTO orders (code, discord_user_id, version_id, plugin_name, version_label,
                              amount, status, created_at, expires_at)
           VALUES (?, '1', NULL, 'P', '1.0', 20000, ?, 1, 2)`,
        )
        .run(`C${status}`, status);

    expect(() => insert('underpaid')).not.toThrow();
    expect(() => insert('refunded')).toThrow(/CHECK constraint failed/);
    db.close();
  });

  it('creates every table as STRICT', () => {
    const db = migrated();
    const tables = db
      .prepare("SELECT name, strict FROM pragma_table_list WHERE schema='main' AND name NOT LIKE 'sqlite_%'")
      .all() as { name: string; strict: number }[];
    expect(tables).toHaveLength(21);
    expect(tables.filter((t) => t.strict !== 1)).toEqual([]);
    db.close();
  });

  it('is expressible as raw schema.sql without error', () => {
    const db = freshDb();
    expect(() => db.exec(schemaSql)).not.toThrow();
    db.close();
  });

  it('produces the same database whether built by schema.sql or by migrations', () => {
    // A fresh install runs schema.sql; an upgrade replays migrations. If the two
    // drift, a bug appears on only one of them — and the one that breaks is
    // production, which is always the upgraded path.
    //
    // Compared structurally rather than by SQL text: the two carry different
    // comment wording, which is harmless, but columns, foreign keys and indexes
    // must match exactly.
    const structure = (db: Database.Database): string => {
      const lines: string[] = [];
      const tables = db
        .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
        .all() as { name: string }[];

      for (const table of tables) {
        lines.push(table.name);
        const columns = db.prepare(`PRAGMA table_info(${table.name})`).all() as {
          name: string;
          type: string;
          notnull: number;
          dflt_value: string | null;
          pk: number;
        }[];
        for (const column of columns) {
          lines.push(`  ${column.name}:${column.type}:${column.notnull}:${column.dflt_value}:${column.pk}`);
        }
        const fks = db.prepare(`PRAGMA foreign_key_list(${table.name})`).all() as {
          from: string;
          table: string;
          to: string;
          on_delete: string;
        }[];
        for (const fk of fks) lines.push(`  fk ${fk.from}->${fk.table}.${fk.to}:${fk.on_delete}`);

        const indexes = db.prepare(`PRAGMA index_list(${table.name})`).all() as {
          name: string;
          unique: number;
        }[];
        lines.push(...indexes.map((i) => `  idx ${i.name}:${i.unique}`).sort());
      }
      return lines.join('\n');
    };

    const viaMigrations = migrated();
    const viaSchema = freshDb();
    viaSchema.exec(schemaSql);

    expect(structure(viaSchema)).toBe(structure(viaMigrations));

    viaMigrations.close();
    viaSchema.close();
  });
});

describe('schema constraints', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = migrated();
    db.prepare(
      "INSERT INTO plugins (id, slug, display_name, descriptor_name, created_at) VALUES (1, 'mm', 'MythicMobs', 'MythicMobs', 100)",
    ).run();
  });

  const insertVersion = (overrides: Record<string, unknown> = {}) => {
    const row = {
      plugin_id: 1,
      version: '1.0',
      raw_version: '1.0',
      sha256: 'a'.repeat(64),
      rel_path: 'aa/x',
      bytes: 10,
      original_name: 'x.jar',
      descriptor_kind: 'spigot',
      version_flag: 'ok',
      is_stable: 0,
      uploaded_at: 100,
      ...overrides,
    };
    return db
      .prepare(
        `INSERT INTO versions (plugin_id, version, raw_version, sha256, rel_path, bytes, original_name,
         descriptor_kind, version_flag, is_stable, uploaded_at)
         VALUES (@plugin_id, @version, @raw_version, @sha256, @rel_path, @bytes, @original_name,
         @descriptor_kind, @version_flag, @is_stable, @uploaded_at)`,
      )
      .run(row);
  };

  it('keeps a numeric-looking version as TEXT', () => {
    insertVersion({ version: '1.0' });
    const row = db.prepare('SELECT version, typeof(version) AS ty FROM versions').get() as {
      version: string;
      ty: string;
    };
    expect(row.version).toBe('1.0');
    expect(row.ty).toBe('text');
  });

  it('allows a null version for platforms where it is optional', () => {
    expect(() => insertVersion({ version: null, raw_version: null, descriptor_kind: 'velocity' })).not.toThrow();
  });

  it('rejects an unknown version_flag', () => {
    expect(() => insertVersion({ version_flag: 'regex_recovered' })).toThrow(/CHECK/);
  });

  it('rejects an unknown descriptor_kind', () => {
    expect(() => insertVersion({ descriptor_kind: 'forge' })).toThrow(/CHECK/);
  });

  it('rejects a non-boolean is_stable', () => {
    expect(() => insertVersion({ is_stable: 42 })).toThrow(/CHECK/);
  });

  it('blocks a duplicate blob by sha256', () => {
    insertVersion();
    expect(() => insertVersion({ rel_path: 'bb/y', version: '2.0' })).toThrow(/UNIQUE/);
  });

  it('rejects an unknown order status and delivery method', () => {
    expect(() =>
      db
        .prepare(
          "INSERT INTO orders (code, discord_user_id, plugin_name, amount, status, created_at, expires_at) VALUES ('VN1','9','MythicMobs',1,'refunded',1,2)",
        )
        .run(),
    ).toThrow(/CHECK/);
    expect(() =>
      db
        .prepare(
          "INSERT INTO audit_log (discord_user_id, plugin_name, amount, delivery_method, delivered_at) VALUES ('9','MythicMobs',0,'email',1)",
        )
        .run(),
    ).toThrow(/CHECK/);
  });

  it('rejects an unknown platform', () => {
    expect(() =>
      db
        .prepare(
          "INSERT INTO plugins (slug, display_name, descriptor_name, platform, created_at) VALUES ('x','X','X','papper',1)",
        )
        .run(),
    ).toThrow(/CHECK/);
  });

  it('enforces exact alias matching via a child table, not substring', () => {
    db.prepare("INSERT INTO plugin_aliases (plugin_id, alias) VALUES (1, 'Core')").run();
    const hit = db.prepare('SELECT plugin_id FROM plugin_aliases WHERE alias = ?').get('CoreProtect');
    expect(hit).toBeUndefined();
    expect(db.prepare('SELECT plugin_id FROM plugin_aliases WHERE alias = ?').get('Core')).toEqual({ plugin_id: 1 });
  });

  it('refuses to let two plugins claim the same alias', () => {
    db.prepare("INSERT INTO plugins (id, slug, display_name, descriptor_name, created_at) VALUES (2,'ot','Other','Other',1)").run();
    db.prepare("INSERT INTO plugin_aliases (plugin_id, alias) VALUES (1, 'Shared')").run();
    expect(() => db.prepare("INSERT INTO plugin_aliases (plugin_id, alias) VALUES (2, 'Shared')").run()).toThrow(/UNIQUE/);
  });

  it('cascades version deletion when a plugin is removed', () => {
    insertVersion();
    db.prepare('DELETE FROM plugins WHERE id = 1').run();
    expect((db.prepare('SELECT count(*) AS c FROM versions').get() as { c: number }).c).toBe(0);
  });

  it('preserves the order record when its version is pruned', () => {
    insertVersion();
    const versionId = (db.prepare('SELECT id FROM versions').get() as { id: number }).id;
    db.prepare(
      `INSERT INTO orders (code, discord_user_id, version_id, plugin_name, version_label, amount, status, created_at, expires_at, paid_at)
       VALUES ('VNABC12345', '999', ?, 'MythicMobs', '1.0', 20000, 'paid', 100, 200, 150)`,
    ).run(versionId);

    db.prepare('DELETE FROM versions WHERE id = ?').run(versionId);

    const order = db.prepare('SELECT version_id, plugin_name, version_label, amount, status FROM orders').get();
    expect(order).toEqual({
      version_id: null,
      plugin_name: 'MythicMobs',
      version_label: '1.0',
      amount: 20000,
      status: 'paid',
    });
  });

  it('keeps audit rows after the version is gone', () => {
    insertVersion();
    const versionId = (db.prepare('SELECT id FROM versions').get() as { id: number }).id;
    db.prepare(
      "INSERT INTO audit_log (discord_user_id, version_id, plugin_name, version_label, amount, delivery_method, delivered_at) VALUES ('9', ?, 'MythicMobs', '1.0', 5000, 'link', 1)",
    ).run(versionId);
    db.prepare('DELETE FROM versions WHERE id = ?').run(versionId);
    const row = db.prepare('SELECT version_id, plugin_name, amount FROM audit_log').get();
    expect(row).toEqual({ version_id: null, plugin_name: 'MythicMobs', amount: 5000 });
  });

  it('allows an empty version_label for a version that has no version string', () => {
    expect(() =>
      db
        .prepare(
          "INSERT INTO audit_log (discord_user_id, plugin_name, amount, delivery_method, delivered_at) VALUES ('9','VelocityPlugin',0,'link',1)",
        )
        .run(),
    ).not.toThrow();
    expect((db.prepare('SELECT version_label FROM audit_log').get() as { version_label: string }).version_label).toBe('');
  });

  it('dedupes SePay transactions on sepay_id', () => {
    const insert = db.prepare(
      "INSERT INTO sepay_transactions (sepay_id, amount, transfer_type, raw_payload, received_at) VALUES (?, 1000, 'in', '{}', 1)",
    );
    insert.run(92704);
    expect(() => insert.run(92704)).toThrow(/UNIQUE/);
  });

  it('records transfer_type so outgoing transfers stay distinguishable', () => {
    expect(() =>
      db
        .prepare(
          "INSERT INTO sepay_transactions (sepay_id, amount, transfer_type, raw_payload, received_at) VALUES (1, 1000, 'sideways', '{}', 1)",
        )
        .run(),
    ).toThrow(/CHECK/);
  });

  it('stores a token hash as raw bytes, not hex text', () => {
    insertVersion();
    const versionId = (db.prepare('SELECT id FROM versions').get() as { id: number }).id;
    const insert = db.prepare(
      'INSERT INTO download_tokens (token_hash, version_id, discord_user_id, expires_at, created_at) VALUES (?, ?, ?, ?, ?)',
    );
    expect(() => insert.run(Buffer.alloc(32, 7), versionId, '9', 200, 100)).not.toThrow();
    expect(() => insert.run('a'.repeat(64), versionId, '9', 200, 100)).toThrow();
  });
});
