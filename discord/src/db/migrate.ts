import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Db } from './connection.js';

const here = dirname(fileURLToPath(import.meta.url));

/**
 * Numbered migrations tracked via PRAGMA user_version.
 *
 * Migration 1 is the base schema. Later schema changes append an entry here;
 * never edit an existing one, since databases in the field have already applied
 * it.
 *
 * wrapInTransaction defaults to true. Set it false for a migration that must
 * rebuild a table: SQLite's 12-step rebuild recipe requires
 * `PRAGMA foreign_keys=OFF`, and that pragma is SILENTLY IGNORED inside an open
 * transaction. A rebuild that appears to disable FKs but does not will have its
 * `DROP TABLE old` cascade into orders and download_tokens — inside a
 * transaction that then commits successfully, so nothing rolls back and nothing
 * logs. Such a migration must manage its own pragma and transaction sequencing.
 */
type Migration = {
  version: number;
  name: string;
  wrapInTransaction?: boolean;
  run: (db: Db) => void;
};

const migrations: Migration[] = [
  {
    version: 1,
    name: 'base-schema',
    run: (db) => {
      // schema.sql sits beside this file in src/ and beside the compiled JS in
      // dist/, so resolve relative to the module rather than the CWD.
      const sql = readFileSync(join(here, 'schema.sql'), 'utf8');
      db.exec(sql);
    },
  },
  {
    version: 2,
    name: 'orders-underpaid-status',
    // Rebuild, so it manages its own pragma/transaction sequencing per the note
    // above. SQLite cannot widen a CHECK constraint with ALTER TABLE.
    wrapInTransaction: false,
    run: (db) => {
      // An underpaid transfer used to leave the order 'pending', where the
      // reconcile view could not see it and the expiry sweep then marked it
      // 'expired' — money taken, no file, and no trace outside sepay_transactions.
      db.pragma('foreign_keys = OFF');
      try {
        db.transaction(() => {
          db.exec(`
            CREATE TABLE orders_new (
              id              INTEGER PRIMARY KEY AUTOINCREMENT,
              code            TEXT    NOT NULL UNIQUE,
              discord_user_id TEXT    NOT NULL,
              version_id      INTEGER REFERENCES versions (id) ON DELETE SET NULL,
              plugin_name     TEXT    NOT NULL,
              version_label   TEXT    NOT NULL DEFAULT '',
              amount          INTEGER NOT NULL CHECK (amount >= 0),
              status          TEXT    NOT NULL DEFAULT 'pending'
                                CHECK (status IN ('pending', 'paid', 'delivered',
                                                  'expired', 'dm_blocked', 'underpaid')),
              -- What actually arrived, so the owner can see the shortfall.
              paid_amount     INTEGER CHECK (paid_amount IS NULL OR paid_amount >= 0),
              created_at      INTEGER NOT NULL,
              expires_at      INTEGER NOT NULL,
              paid_at         INTEGER,
              delivered_at    INTEGER
            ) STRICT;

            INSERT INTO orders_new (id, code, discord_user_id, version_id, plugin_name,
                                    version_label, amount, status, paid_amount,
                                    created_at, expires_at, paid_at, delivered_at)
              SELECT id, code, discord_user_id, version_id, plugin_name,
                     version_label, amount, status, NULL,
                     created_at, expires_at, paid_at, delivered_at
              FROM orders;

            DROP TABLE orders;
            ALTER TABLE orders_new RENAME TO orders;

            CREATE INDEX IF NOT EXISTS idx_orders_status     ON orders (status);
            CREATE INDEX IF NOT EXISTS idx_orders_user       ON orders (discord_user_id);
            CREATE INDEX IF NOT EXISTS idx_orders_version_id ON orders (version_id);
          `);
        })();

        const orphans = db.pragma('foreign_key_check') as unknown[];
        if (orphans.length > 0) throw new Error('orders rebuild để lại tham chiếu hỏng');
      } finally {
        db.pragma('foreign_keys = ON');
      }
    },
  },
  {
    version: 3,
    name: 'pending-download-queue',
    run: (db) => {
      // Detection saves upstream_state before a download can run, so without a
      // separate record a transient failure (network blip, ENOSPC, restart
      // mid-sweep) means that version is never re-emitted and never fetched.
      db.exec(`
        CREATE TABLE IF NOT EXISTS pending_download (
          plugin_id        INTEGER NOT NULL REFERENCES plugins (id) ON DELETE CASCADE,
          version_uuid     TEXT    NOT NULL,
          version_name     TEXT    NOT NULL,
          attempts         INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
          last_error       TEXT    NOT NULL DEFAULT '',
          next_attempt_at  INTEGER NOT NULL,
          created_at       INTEGER NOT NULL,
          PRIMARY KEY (plugin_id, version_uuid)
        ) STRICT;

        CREATE INDEX IF NOT EXISTS idx_pending_download_due ON pending_download (next_attempt_at);
      `);
    },
  },
  {
    version: 4,
    name: 'resource-ownership-cache',
    run: (db) => {
      // Learned from successful downloads so later sweeps go straight to the
      // account that owns a plugin instead of walking the whole list, which is
      // both slow and the clearest lockout signal.
      db.exec(`
        CREATE TABLE IF NOT EXISTS resource_ownership (
          resource_id   INTEGER NOT NULL,
          account_label TEXT    NOT NULL,
          state         TEXT    NOT NULL CHECK (state IN ('owned', 'not_owned')),
          checked_at    INTEGER NOT NULL,
          PRIMARY KEY (resource_id, account_label)
        ) STRICT;

        CREATE INDEX IF NOT EXISTS idx_resource_ownership_state
          ON resource_ownership (resource_id, state);
      `);
    },
  },
  {
    version: 5,
    name: 'account-scan-state',
    run: (db) => {
      // Scanning one account's purchased list costs ~45s. At 100 accounts that is
      // over an hour per sweep and it blocks downloading entirely, so the scan
      // becomes once-per-day per account while downloads stay hourly.
      db.exec(`
        CREATE TABLE IF NOT EXISTS account_scan_state (
          account_label  TEXT    PRIMARY KEY,
          last_scan_at   INTEGER NOT NULL,
          resource_count INTEGER NOT NULL DEFAULT 0,
          last_error     TEXT    NOT NULL DEFAULT ''
        ) STRICT;
      `);
    },
  },
  {
    version: 6,
    name: 'wallet-ledger',
    run: (db) => {
      // Balances in VND rather than coins: coins are a 1000:1 display unit, and
      // storing them would round away the remainder of every conversion.
      db.exec(`
        CREATE TABLE IF NOT EXISTS wallets (
          discord_user_id TEXT    PRIMARY KEY,
          balance         INTEGER NOT NULL DEFAULT 0 CHECK (balance >= 0),
          created_at      INTEGER NOT NULL,
          updated_at      INTEGER NOT NULL
        ) STRICT;

        CREATE TABLE IF NOT EXISTS wallet_ledger (
          id              INTEGER PRIMARY KEY AUTOINCREMENT,
          discord_user_id TEXT    NOT NULL,
          delta           INTEGER NOT NULL,
          balance_after   INTEGER NOT NULL CHECK (balance_after >= 0),
          kind            TEXT    NOT NULL
                            CHECK (kind IN ('card_topup', 'bank_topup', 'order_hold',
                                            'order_refund', 'overpay', 'manual')),
          ref_type        TEXT    NOT NULL DEFAULT ''
                            CHECK (ref_type IN ('order', 'topup', 'card', '')),
          ref_id          INTEGER,
          note            TEXT    NOT NULL DEFAULT '',
          created_at      INTEGER NOT NULL
        ) STRICT;

        CREATE INDEX IF NOT EXISTS idx_wallet_ledger_user
          ON wallet_ledger (discord_user_id, created_at DESC);
        CREATE INDEX IF NOT EXISTS idx_wallet_ledger_ref
          ON wallet_ledger (ref_type, ref_id);
      `);
    },
  },
  {
    version: 7,
    name: 'orders-wallet-split',
    // Rebuild: SQLite cannot add a column with a CHECK, nor widen the existing
    // status CHECK, via ALTER TABLE. Manages its own pragma/transaction
    // sequencing per the note at the top — migration 2 is the worked example.
    wrapInTransaction: false,
    run: (db) => {
      // An order can now be settled partly from a wallet, so the single `amount`
      // column no longer says how much to transfer. Splitting it matters because
      // the QR is built from what is still owed: showing the full price when the
      // wallet already covered part of it collects the difference twice.
      db.pragma('foreign_keys = OFF');
      try {
        db.transaction(() => {
          db.exec(`
            CREATE TABLE orders_new (
              id              INTEGER PRIMARY KEY AUTOINCREMENT,
              code            TEXT    NOT NULL UNIQUE,
              discord_user_id TEXT    NOT NULL,
              version_id      INTEGER REFERENCES versions (id) ON DELETE SET NULL,
              plugin_name     TEXT    NOT NULL,
              version_label   TEXT    NOT NULL DEFAULT '',
              -- Full price. Always equals wallet_paid + bank_due.
              amount          INTEGER NOT NULL CHECK (amount >= 0),
              -- Taken from the wallet when the order opened, already deducted.
              wallet_paid     INTEGER NOT NULL DEFAULT 0 CHECK (wallet_paid >= 0),
              -- Still owed by bank transfer. This is what the QR carries.
              bank_due        INTEGER NOT NULL DEFAULT 0 CHECK (bank_due >= 0),
              -- 'wallet_paid' is settled entirely from the wallet, so no transfer
              -- will ever arrive. Kept distinct from 'paid' so the reconcile view
              -- does not fill with orders that need nothing done.
              status          TEXT    NOT NULL DEFAULT 'pending'
                                CHECK (status IN ('pending', 'paid', 'delivered',
                                                  'expired', 'dm_blocked', 'underpaid',
                                                  'wallet_paid')),
              paid_amount     INTEGER CHECK (paid_amount IS NULL OR paid_amount >= 0),
              created_at      INTEGER NOT NULL,
              expires_at      INTEGER NOT NULL,
              paid_at         INTEGER,
              delivered_at    INTEGER
            ) STRICT;

            -- Existing orders predate wallets: nothing was taken from a balance,
            -- so the whole price was and remains due by transfer.
            INSERT INTO orders_new (id, code, discord_user_id, version_id, plugin_name,
                                    version_label, amount, wallet_paid, bank_due, status,
                                    paid_amount, created_at, expires_at, paid_at, delivered_at)
              SELECT id, code, discord_user_id, version_id, plugin_name,
                     version_label, amount, 0, amount, status,
                     paid_amount, created_at, expires_at, paid_at, delivered_at
              FROM orders;

            DROP TABLE orders;
            ALTER TABLE orders_new RENAME TO orders;

            CREATE INDEX IF NOT EXISTS idx_orders_status     ON orders (status);
            CREATE INDEX IF NOT EXISTS idx_orders_user       ON orders (discord_user_id);
            CREATE INDEX IF NOT EXISTS idx_orders_version_id ON orders (version_id);
          `);
        })();

        const orphans = db.pragma('foreign_key_check') as unknown[];
        if (orphans.length > 0) throw new Error('orders rebuild để lại tham chiếu hỏng');
      } finally {
        db.pragma('foreign_keys = ON');
      }
    },
  },
  {
    version: 8,
    name: 'wallet-topups',
    run: (db) => {
      // A separate table rather than a flavour of `orders`: an order is bound to
      // a version, a plugin name and a version label, none of which a wallet
      // top-up has. Folding it in would mean every stats and reconcile query
      // needs an extra predicate to exclude it — the kind that gets forgotten
      // once and quietly misreports the fund.
      //
      // No 'underpaid' status either, and that asymmetry is the point: for a
      // top-up every amount is valid, since there is no goods to withhold.
      db.exec(`
        CREATE TABLE IF NOT EXISTS wallet_topups (
          id              INTEGER PRIMARY KEY AUTOINCREMENT,
          code            TEXT    NOT NULL UNIQUE,
          discord_user_id TEXT    NOT NULL,
          -- What they said they would send. Shown on the QR, nothing more.
          amount          INTEGER NOT NULL CHECK (amount > 0),
          -- What actually arrived, and what gets credited.
          paid_amount     INTEGER CHECK (paid_amount IS NULL OR paid_amount >= 0),
          status          TEXT    NOT NULL DEFAULT 'pending'
                            CHECK (status IN ('pending', 'credited', 'expired')),
          created_at      INTEGER NOT NULL,
          expires_at      INTEGER NOT NULL,
          credited_at     INTEGER
        ) STRICT;

        CREATE INDEX IF NOT EXISTS idx_wallet_topups_status ON wallet_topups (status);
        CREATE INDEX IF NOT EXISTS idx_wallet_topups_user   ON wallet_topups (discord_user_id);
      `);
    },
  },
  {
    version: 9,
    name: 'card-topups',
    run: (db) => {
      // card2k sends no callback — its own client submits and then polls. So the
      // pending state has to live here rather than in a setInterval closure, or a
      // restart mid-flight would abandon a card that was already consumed.
      db.exec(`
        CREATE TABLE IF NOT EXISTS card_topups (
          id               INTEGER PRIMARY KEY AUTOINCREMENT,
          request_id       TEXT    NOT NULL UNIQUE,
          discord_user_id  TEXT    NOT NULL,
          telco            TEXT    NOT NULL,
          serial           TEXT    NOT NULL,
          code             TEXT    NOT NULL DEFAULT '',
          declared_value   INTEGER NOT NULL CHECK (declared_value > 0),
          actual_value     INTEGER CHECK (actual_value IS NULL OR actual_value >= 0),
          net_amount       INTEGER CHECK (net_amount IS NULL OR net_amount >= 0),
          status           TEXT    NOT NULL DEFAULT 'pending'
                             CHECK (status IN ('pending', 'success', 'wrong_amount',
                                               'failed', 'timeout', 'needs_review')),
          provider_status  INTEGER,
          provider_message TEXT    NOT NULL DEFAULT '',
          trans_id         TEXT,
          attempts         INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
          next_poll_at     INTEGER,
          credited_at      INTEGER,
          created_at       INTEGER NOT NULL
        ) STRICT;

        CREATE INDEX IF NOT EXISTS idx_card_topups_poll ON card_topups (status, next_poll_at);
        CREATE INDEX IF NOT EXISTS idx_card_topups_user ON card_topups (discord_user_id, created_at DESC);
        CREATE INDEX IF NOT EXISTS idx_card_topups_serial ON card_topups (serial);
      `);
    },
  },
  {
    version: 10,
    name: 'plugins-desc-and-discount-codes',
    run: (db) => {
      const cols = db.prepare(`PRAGMA table_info(plugins)`).all() as { name: string }[];
      const colNames = new Set(cols.map((c) => c.name));
      if (!colNames.has('description')) {
        db.exec(`ALTER TABLE plugins ADD COLUMN description TEXT NOT NULL DEFAULT '';`);
      }
      if (!colNames.has('external_link')) {
        db.exec(`ALTER TABLE plugins ADD COLUMN external_link TEXT NOT NULL DEFAULT '';`);
      }

      db.exec(`
        CREATE TABLE IF NOT EXISTS discount_codes (
          id           INTEGER PRIMARY KEY AUTOINCREMENT,
          code         TEXT    NOT NULL UNIQUE,
          type         TEXT    NOT NULL CHECK (type IN ('percent', 'fixed')),
          value        INTEGER NOT NULL CHECK (value > 0),
          min_order    INTEGER NOT NULL DEFAULT 0 CHECK (min_order >= 0),
          max_discount INTEGER,
          max_uses     INTEGER CHECK (max_uses IS NULL OR max_uses > 0),
          used_count   INTEGER NOT NULL DEFAULT 0 CHECK (used_count >= 0),
          expires_at   INTEGER,
          is_active    INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0, 1)),
          created_at   INTEGER NOT NULL
        ) STRICT;

        CREATE INDEX IF NOT EXISTS idx_discount_codes_code   ON discount_codes (code);
        CREATE INDEX IF NOT EXISTS idx_discount_codes_active ON discount_codes (is_active);

        CREATE TABLE IF NOT EXISTS discount_code_redemptions (
          id              INTEGER PRIMARY KEY AUTOINCREMENT,
          discount_id     INTEGER NOT NULL REFERENCES discount_codes (id) ON DELETE CASCADE,
          discord_user_id TEXT    NOT NULL,
          order_id        INTEGER REFERENCES orders (id) ON DELETE SET NULL,
          discount_amount INTEGER NOT NULL CHECK (discount_amount > 0),
          redeemed_at     INTEGER NOT NULL
        ) STRICT;

        CREATE INDEX IF NOT EXISTS idx_discount_redemptions_discount ON discount_code_redemptions (discount_id);
        CREATE INDEX IF NOT EXISTS idx_discount_redemptions_user     ON discount_code_redemptions (discord_user_id);
      `);
    },
  },
  {
    version: 11,
    name: 'dashboard-staff',
    run: (db) => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS dashboard_staff (
          discord_user_id TEXT    PRIMARY KEY,
          username        TEXT    NOT NULL DEFAULT '',
          display_name    TEXT    NOT NULL DEFAULT '',
          avatar          TEXT,
          added_by        TEXT    NOT NULL,
          created_at      INTEGER NOT NULL
        ) STRICT;
      `);
    },
  },
  {
    version: 12,
    name: 'spigot-accounts',
    run: (db) => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS spigot_accounts (
          id                   INTEGER PRIMARY KEY AUTOINCREMENT,
          label                TEXT    NOT NULL UNIQUE,
          username             TEXT    NOT NULL,
          password_encrypted   TEXT    NOT NULL,
          xf_user_encrypted    TEXT    NOT NULL DEFAULT '',
          xf_session_encrypted TEXT    NOT NULL DEFAULT '',
          issued_at            TEXT,
          last_verified_at     TEXT,
          status               TEXT    NOT NULL DEFAULT 'ok'
                                 CHECK (status IN ('ok', 'stale', 'needs_login', 'locked')),
          is_enabled           INTEGER NOT NULL DEFAULT 1 CHECK (is_enabled IN (0, 1)),
          created_at           INTEGER NOT NULL,
          updated_at           INTEGER NOT NULL
        ) STRICT;

        CREATE INDEX IF NOT EXISTS idx_spigot_accounts_status  ON spigot_accounts (status);
        CREATE INDEX IF NOT EXISTS idx_spigot_accounts_enabled ON spigot_accounts (is_enabled);
      `);
    },
  },
];

/**
 * Applies pending migrations. Safe to call on every boot — already-applied
 * versions are skipped.
 */
export function migrate(db: Db): { applied: number[]; from: number; to: number } {
  const current = db.pragma('user_version', { simple: true }) as number;
  const pending = migrations.filter((m) => m.version > current).sort((a, b) => a.version - b.version);
  const applied: number[] = [];

  for (const migration of pending) {
    // user_version is a literal from the list above, never user input; PRAGMA
    // cannot be parameterized.
    const bump = () => db.pragma(`user_version = ${migration.version}`);

    if (migration.wrapInTransaction === false) {
      migration.run(db);
      bump();
    } else {
      db.transaction(() => {
        migration.run(db);
        bump();
      })();
    }
    applied.push(migration.version);
  }

  const to = db.pragma('user_version', { simple: true }) as number;
  return { applied, from: current, to };
}
