-- Plugin vault schema. All tables STRICT: SQLite rejects type mismatches
-- instead of silently coercing, which matters for version strings that must
-- never become numbers. Enum and boolean columns additionally carry CHECK
-- constraints, because STRICT validates storage class only — it happily
-- accepts is_stable=42 or a typo'd status string.
--
-- SQLite has no ALTER TABLE ADD CONSTRAINT, so constraints must land here
-- rather than in a later migration (which would require a full table rebuild).

CREATE TABLE IF NOT EXISTS plugins (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  slug            TEXT    NOT NULL UNIQUE,
  display_name    TEXT    NOT NULL,
  -- Name as declared inside the jar descriptor. May differ from the name shown
  -- on Spigot, which is what the plugin_aliases table absorbs.
  descriptor_name TEXT    NOT NULL,
  platform        TEXT    NOT NULL DEFAULT 'spigot'
                    CHECK (platform IN ('paper', 'spigot', 'velocity', 'bungee')),
  -- Spiget numeric resource ID; NULL means update-checking is off.
  resource_id     INTEGER,
  deposit_price   INTEGER NOT NULL DEFAULT 0 CHECK (deposit_price >= 0),
  is_premium      INTEGER NOT NULL DEFAULT 0 CHECK (is_premium IN (0, 1)),
  description     TEXT    NOT NULL DEFAULT '',
  external_link   TEXT    NOT NULL DEFAULT '',
  created_at      INTEGER NOT NULL
) STRICT;

CREATE INDEX IF NOT EXISTS idx_plugins_descriptor_name ON plugins (descriptor_name);
CREATE INDEX IF NOT EXISTS idx_plugins_resource_id     ON plugins (resource_id);

-- Alternate descriptor names mapping to a plugin. A child table rather than a
-- delimited column so that (a) lookups are exact instead of substring matches
-- (alias "Core" must not match plugin "CoreProtect"), and (b) UNIQUE makes
-- "alias already claimed" a database error instead of a race.
CREATE TABLE IF NOT EXISTS plugin_aliases (
  plugin_id INTEGER NOT NULL REFERENCES plugins (id) ON DELETE CASCADE,
  alias     TEXT    NOT NULL UNIQUE,
  PRIMARY KEY (plugin_id, alias)
) STRICT;

CREATE TABLE IF NOT EXISTS versions (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  plugin_id       INTEGER NOT NULL REFERENCES plugins (id) ON DELETE CASCADE,
  -- Cleaned version string. Always TEXT: `version: 1.0` in a descriptor must
  -- stay "1.0" and never become the number 1. Nullable because version is
  -- optional for Velocity and unvalidated for BungeeCord.
  version         TEXT,
  -- Exact bytes as they appeared in the descriptor, for auditing.
  raw_version     TEXT,
  sha256          TEXT    NOT NULL UNIQUE,
  -- Path relative to VAULT_DIR, content-addressed: <sha[0:2]>/<sha>
  rel_path        TEXT    NOT NULL,
  bytes           INTEGER NOT NULL CHECK (bytes >= 0),
  original_name   TEXT    NOT NULL,
  descriptor_kind TEXT    NOT NULL
                    CHECK (descriptor_kind IN ('paper', 'spigot', 'velocity', 'bungee', 'manual')),
  is_stable       INTEGER NOT NULL DEFAULT 0 CHECK (is_stable IN (0, 1)),
  version_flag    TEXT    NOT NULL DEFAULT 'ok'
                    CHECK (version_flag IN ('ok', 'unresolved-placeholder', 'regex-recovered', 'manual')),
  uploaded_at     INTEGER NOT NULL
) STRICT;

-- Composite serves both the bot's version list and the prune sweep, which
-- order by upload time within a plugin.
CREATE INDEX IF NOT EXISTS idx_versions_plugin_uploaded ON versions (plugin_id, uploaded_at DESC);

CREATE TABLE IF NOT EXISTS orders (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  -- Payment code embedded in the bank transfer memo. Stored UPPERCASE because
  -- SePay uppercases the code it extracts.
  code            TEXT    NOT NULL UNIQUE,
  discord_user_id TEXT    NOT NULL,
  -- SET NULL, not CASCADE: deleting or pruning a version must never erase the
  -- record that money was taken for it. The denormalized labels below keep the
  -- order readable afterwards.
  version_id      INTEGER REFERENCES versions (id) ON DELETE SET NULL,
  plugin_name     TEXT    NOT NULL,
  version_label   TEXT    NOT NULL DEFAULT '',
  -- Full price of the download. Always equals wallet_paid + bank_due.
  amount          INTEGER NOT NULL CHECK (amount >= 0),
  -- Settled from the coin wallet when the order opened, already deducted there.
  -- Held rather than merely recorded, so one balance cannot fund two orders.
  wallet_paid     INTEGER NOT NULL DEFAULT 0 CHECK (wallet_paid >= 0),
  -- Still owed by bank transfer, and what the QR carries. Kept separate from
  -- amount because a QR showing the full price after the wallet already covered
  -- part of it would collect the difference twice.
  bank_due        INTEGER NOT NULL DEFAULT 0 CHECK (bank_due >= 0),
  -- 'wallet_paid' means settled entirely from the wallet, so no transfer will
  -- ever arrive. Distinct from 'paid' so the reconcile view is not filled with
  -- orders that need nothing done.
  status          TEXT    NOT NULL DEFAULT 'pending'
                    CHECK (status IN ('pending', 'paid', 'delivered',
                                      'expired', 'dm_blocked', 'underpaid',
                                      'wallet_paid')),
  -- What actually arrived, so the owner can see the shortfall on an underpaid
  -- order. NULL until a transfer lands.
  paid_amount     INTEGER CHECK (paid_amount IS NULL OR paid_amount >= 0),
  created_at      INTEGER NOT NULL,
  expires_at      INTEGER NOT NULL,
  paid_at         INTEGER,
  delivered_at    INTEGER
) STRICT;

CREATE INDEX IF NOT EXISTS idx_orders_status     ON orders (status);
CREATE INDEX IF NOT EXISTS idx_orders_user       ON orders (discord_user_id);
CREATE INDEX IF NOT EXISTS idx_orders_version_id ON orders (version_id);

CREATE TABLE IF NOT EXISTS sepay_transactions (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  -- SePay's own transaction id: the only field guaranteed present and stable
  -- across retries and dashboard replays. referenceCode can be empty, so it
  -- cannot serve as the dedupe key.
  sepay_id      INTEGER NOT NULL UNIQUE,
  order_id      INTEGER REFERENCES orders (id) ON DELETE SET NULL,
  amount        INTEGER NOT NULL,
  -- Kept queryable during the observation period; transferAmount is positive
  -- even for outgoing transfers, so this is the only way to tell them apart.
  transfer_type TEXT    NOT NULL CHECK (transfer_type IN ('in', 'out')),
  code          TEXT,
  -- Raw memo fields kept verbatim so real bank behavior can be observed.
  content       TEXT    NOT NULL DEFAULT '',
  description   TEXT    NOT NULL DEFAULT '',
  raw_payload   TEXT    NOT NULL,
  received_at   INTEGER NOT NULL
) STRICT;

CREATE TABLE IF NOT EXISTS download_tokens (
  -- Raw sha256 digest bytes (createHash(...).digest(), NOT .digest('hex')).
  -- The raw token itself is never stored.
  token_hash      BLOB    PRIMARY KEY,
  version_id      INTEGER NOT NULL REFERENCES versions (id) ON DELETE CASCADE,
  discord_user_id TEXT    NOT NULL,
  order_id        INTEGER REFERENCES orders (id) ON DELETE SET NULL,
  expires_at      INTEGER NOT NULL,
  used_at         INTEGER,
  created_at      INTEGER NOT NULL
) STRICT;

CREATE INDEX IF NOT EXISTS idx_download_tokens_expires    ON download_tokens (expires_at);
CREATE INDEX IF NOT EXISTS idx_download_tokens_version_id ON download_tokens (version_id);

CREATE TABLE IF NOT EXISTS audit_log (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  discord_user_id TEXT    NOT NULL,
  version_id      INTEGER REFERENCES versions (id) ON DELETE SET NULL,
  order_id        INTEGER REFERENCES orders (id) ON DELETE SET NULL,
  -- Denormalized so the log survives plugin/version deletion. version_label
  -- defaults to '' because versions.version is legitimately nullable.
  plugin_name     TEXT    NOT NULL,
  version_label   TEXT    NOT NULL DEFAULT '',
  amount          INTEGER NOT NULL DEFAULT 0 CHECK (amount >= 0),
  delivery_method TEXT    NOT NULL CHECK (delivery_method IN ('attachment', 'link', 'manual')),
  ip              TEXT,
  delivered_at    INTEGER NOT NULL
) STRICT;

CREATE INDEX IF NOT EXISTS idx_audit_log_delivered_at ON audit_log (delivered_at);
CREATE INDEX IF NOT EXISTS idx_audit_log_user         ON audit_log (discord_user_id);
CREATE INDEX IF NOT EXISTS idx_audit_log_version_id   ON audit_log (version_id);
CREATE INDEX IF NOT EXISTS idx_audit_log_order_id     ON audit_log (order_id);

-- Runtime-editable settings. Authoritative over env at runtime: env supplies
-- only the first-boot seed, so the owner can change admin roles and thresholds
-- from the dashboard without SSH.
CREATE TABLE IF NOT EXISTS config (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
) STRICT;

CREATE TABLE IF NOT EXISTS pending_ingest (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  original_filename TEXT    NOT NULL,
  sha256            TEXT    NOT NULL,
  tmp_path          TEXT    NOT NULL,
  bytes             INTEGER NOT NULL CHECK (bytes >= 0),
  reason            TEXT    NOT NULL
                      CHECK (reason IN ('no-descriptor', 'unreadable-zip', 'invalid-yaml',
                                        'missing-fields', 'not-a-plugin', 'too-large')),
  detail            TEXT    NOT NULL DEFAULT '',
  created_at        INTEGER NOT NULL
) STRICT;

CREATE TABLE IF NOT EXISTS upstream_state (
  plugin_id       INTEGER PRIMARY KEY REFERENCES plugins (id) ON DELETE CASCADE,
  -- Upstream identity is the version uuid, never the version name: names are
  -- neither unique nor semver-ordered.
  version_uuid    TEXT    NOT NULL,
  version_name    TEXT    NOT NULL,
  -- MILLISECONDS, unlike every other timestamp here. Spiget returns seconds;
  -- the client converts at its boundary so no caller has to remember which.
  -- The _ms suffix is the reminder.
  release_date_ms INTEGER NOT NULL,
  checked_at      INTEGER NOT NULL
) STRICT;

CREATE TABLE IF NOT EXISTS pending_download (
  plugin_id        INTEGER NOT NULL REFERENCES plugins (id) ON DELETE CASCADE,
  -- Upstream identity, so a retry fetches the version that was actually seen.
  version_uuid     TEXT    NOT NULL,
  version_name     TEXT    NOT NULL,
  attempts         INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  last_error       TEXT    NOT NULL DEFAULT '',
  -- Unix seconds. A retry is skipped until the clock passes this.
  next_attempt_at  INTEGER NOT NULL,
  created_at       INTEGER NOT NULL,
  -- One row per (plugin, upstream version): a second sighting of the same
  -- version must update the existing attempt, never queue a duplicate.
  PRIMARY KEY (plugin_id, version_uuid)
) STRICT;

CREATE INDEX IF NOT EXISTS idx_pending_download_due ON pending_download (next_attempt_at);
-- Which account owns which resource, learned from a successful download.
--
-- Without this the sweep walks every account for every plugin, which is slow
-- and — more importantly — repeated 403s across accounts look exactly like
-- credential stuffing, the behaviour most likely to get the accounts locked.
CREATE TABLE IF NOT EXISTS resource_ownership (
  resource_id   INTEGER NOT NULL,
  -- Account label, not an id: the credentials file is hand-edited and has no
  -- stable numbering. A renamed label re-learns on the next sweep, which is
  -- cheaper than forcing the owner to keep an id in sync.
  account_label TEXT    NOT NULL,
  -- 'owned' means a download succeeded. 'not_owned' means the account was
  -- authenticated and still refused, so the pairing is settled and can be
  -- skipped rather than retried every hour.
  state         TEXT    NOT NULL CHECK (state IN ('owned', 'not_owned')),
  checked_at    INTEGER NOT NULL,
  PRIMARY KEY (resource_id, account_label)
) STRICT;

CREATE INDEX IF NOT EXISTS idx_resource_ownership_state ON resource_ownership (resource_id, state);
-- Lần cuối quét trang "đã mua" của từng tài khoản.
--
-- Quét một tài khoản mất khoảng 45 giây (Cloudflare, đăng nhập, đọc trang, nghỉ
-- giữa các tài khoản). Với 100 tài khoản thì mỗi lượt quét mất hơn một giờ và
-- chặn luôn việc tải, nên danh sách đã mua chỉ được quét lại mỗi ngày một lần cho
-- mỗi tài khoản, còn việc tải vẫn chạy mỗi giờ.
CREATE TABLE IF NOT EXISTS account_scan_state (
  account_label  TEXT    PRIMARY KEY,
  last_scan_at   INTEGER NOT NULL,
  -- Số plugin thấy được lần cuối, để log nói được điều gì đã thay đổi.
  resource_count INTEGER NOT NULL DEFAULT 0,
  -- '' khi lần quét cuối thành công.
  last_error     TEXT    NOT NULL DEFAULT ''
) STRICT;

-- Coin wallets. Balances are in ĐỒNG (VND), not coins: coins are a 1000:1
-- display unit, and storing them would round every conversion away — an
-- overpayment of 1.500 ₫ kept as "1 coin" loses 500 ₫ with no way to trace it.
CREATE TABLE IF NOT EXISTS wallets (
  discord_user_id TEXT    PRIMARY KEY,
  -- CHECK is the last line of defence: a logic bug that overdraws rolls the
  -- transaction back instead of quietly creating a negative balance.
  balance         INTEGER NOT NULL DEFAULT 0 CHECK (balance >= 0),
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL
) STRICT;

-- Every balance movement, append-only.
--
-- balance_after is denormalized on purpose: it makes a mismatch between the
-- stored balance and the sum of its history detectable with one query, which is
-- the only way to notice that a write path skipped the ledger.
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

CREATE INDEX IF NOT EXISTS idx_wallet_ledger_user ON wallet_ledger (discord_user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_wallet_ledger_ref  ON wallet_ledger (ref_type, ref_id);

-- Bank transfers that top up a coin wallet, unattached to any plugin.
--
-- A separate table rather than a flavour of `orders`: an order is bound to a
-- version, a plugin name and a version label, none of which a top-up has.
-- Folding it in would mean every stats and reconcile query needs an extra
-- predicate to exclude it — the kind that gets forgotten once and quietly
-- misreports the fund.
--
-- Note there is no 'underpaid' status, and that asymmetry with `orders` is the
-- point: for a top-up every amount is valid, because there is no goods to
-- withhold. Sending 30.000 against a 50.000 request credits 30.000.
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

-- Scratch cards submitted to card2k.
--
-- card2k sends no callback — its own client submits and then polls every 60s up
-- to 30 times. So the in-flight state has to live in the database rather than in
-- a scheduler closure: a restart mid-flight would otherwise abandon a card that
-- had already been consumed, with no record that anyone owed anything.
CREATE TABLE IF NOT EXISTS card_topups (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  -- Idempotency key sent to card2k. UNIQUE, so the same submission cannot be
  -- recorded twice even if the caller retries.
  request_id       TEXT    NOT NULL UNIQUE,
  discord_user_id  TEXT    NOT NULL,
  telco            TEXT    NOT NULL,
  serial           TEXT    NOT NULL,
  -- Card PIN. Cleared once the transaction reaches a terminal state: a used PIN
  -- is worthless, but a REJECTED one still holds money, so it is kept until then.
  code             TEXT    NOT NULL DEFAULT '',
  -- Denomination the person declared.
  declared_value   INTEGER NOT NULL CHECK (declared_value > 0),
  -- The card's real value per the telco. This is what gets credited.
  actual_value     INTEGER CHECK (actual_value IS NULL OR actual_value >= 0),
  -- What card2k actually pays after their fee. Recorded for reconciliation only;
  -- the wallet is credited on actual_value, and the difference is the owner's cost.
  net_amount       INTEGER CHECK (net_amount IS NULL OR net_amount >= 0),
  -- 'timeout' and 'needs_review' are NOT failures: the card may have been
  -- consumed while the outcome is unknown, so they wait for a human instead of
  -- being written off.
  status           TEXT    NOT NULL DEFAULT 'pending'
                     CHECK (status IN ('pending', 'success', 'wrong_amount',
                                       'failed', 'timeout', 'needs_review')),
  -- Raw provider status, including codes not in the documented table.
  provider_status  INTEGER,
  provider_message TEXT    NOT NULL DEFAULT '',
  -- card2k's transaction id. TEXT because it is a Java long, and a large long
  -- loses precision as a JS number. Never used in arithmetic.
  trans_id         TEXT,
  attempts         INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  next_poll_at     INTEGER,
  -- Set when the wallet was credited. The exactly-once guard: the credit UPDATE
  -- requires this to be NULL, so two overlapping polls cannot both pay out.
  credited_at      INTEGER,
  created_at       INTEGER NOT NULL
) STRICT;

CREATE INDEX IF NOT EXISTS idx_card_topups_poll   ON card_topups (status, next_poll_at);
CREATE INDEX IF NOT EXISTS idx_card_topups_user   ON card_topups (discord_user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_card_topups_serial ON card_topups (serial);

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

-- Staff members allowed to access dashboard via Discord OAuth2.
-- The superowner (DISCORD_OWNER_ID) always has access even without a row here.
CREATE TABLE IF NOT EXISTS dashboard_staff (
  discord_user_id TEXT    PRIMARY KEY,
  username        TEXT    NOT NULL DEFAULT '',
  display_name    TEXT    NOT NULL DEFAULT '',
  avatar          TEXT,
  added_by        TEXT    NOT NULL,
  created_at      INTEGER NOT NULL
) STRICT;

