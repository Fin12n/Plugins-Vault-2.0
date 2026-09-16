import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export type Db = Database.Database;

let instance: Db | undefined;
let instancePath: string | undefined;

/**
 * Opens the SQLite database with the pragmas this app depends on.
 *
 * WAL lets the HTTP server read while the bot writes. foreign_keys must be set
 * per-connection — SQLite defaults it off, so ON DELETE CASCADE and SET NULL
 * silently do nothing without this.
 *
 * synchronous=FULL rather than the usual WAL pairing of NORMAL: this database is
 * the only record of money received. Under NORMAL, a committed transaction can
 * be lost to an OS crash or power cut, and since the webhook already answered
 * SePay with success there would be no retry — the payment would simply vanish.
 * Write volume here is a few rows per download, so the durability is free.
 */
export function openDb(dbPath: string): Db {
  mkdirSync(dirname(dbPath), { recursive: true, mode: 0o750 });

  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');
  db.pragma('synchronous = FULL');
  return db;
}

/**
 * Opens the process-wide database handle. Throws when called again with a
 * different path, rather than silently handing back the first one — that
 * failure mode makes a test quietly mutate the production database.
 */
export function initDb(dbPath: string): Db {
  if (instance) {
    if (instancePath !== dbPath) {
      throw new Error(`Database đã mở ở "${instancePath}", không thể mở lại ở "${dbPath}".`);
    }
    return instance;
  }
  instance = openDb(dbPath);
  instancePath = dbPath;
  return instance;
}

export function db(): Db {
  if (!instance) throw new Error('Database chưa được khởi tạo — gọi initDb() trước.');
  return instance;
}

export function closeDb(): void {
  instance?.close();
  instance = undefined;
  instancePath = undefined;
}

/**
 * Unix seconds. Every timestamp column uses this unit, with one deliberate
 * exception: upstream_state.release_date_ms, whose suffix marks it.
 */
export function now(): number {
  return Math.floor(Date.now() / 1000);
}
