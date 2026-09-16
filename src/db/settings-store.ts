/**
 * Runtime settings store.
 *
 * Resolves the env-versus-database ambiguity: env supplies boot-critical values
 * (tokens, paths, secrets) and seeds these settings on FIRST boot only.
 * Afterwards the database is authoritative, so the owner can change admin roles
 * and thresholds from the dashboard without SSH. Without this rule, a role added
 * in the dashboard would be ignored by a bot reading env, and the new admin
 * would be refused forever.
 */
import type { Env } from '../config/env.js';
import { type Db } from './connection.js';

export const SETTING_KEYS = [
  'admin_role_ids',
  'prune_keep_count',
  'attach_max_bytes',
  'order_ttl_minutes',
  'download_token_ttl_minutes',
  'auto_download_enabled',
  'spigot_proxy_enabled',
  'spigot_download_concurrency',
] as const;
export type SettingKey = (typeof SETTING_KEYS)[number];

export type Settings = {
  adminRoleIds: string[];
  pruneKeepCount: number;
  attachMaxBytes: number;
  orderTtlMinutes: number;
  downloadTokenTtlMinutes: number;
  /** Spigot auto-download. Off unless the owner deliberately turns it on. */
  autoDownloadEnabled: boolean;
  /** Spigot proxy usage toggle. On by default if proxy is configured. */
  spigotProxyEnabled: boolean;
  /** Number of concurrent browser instances (workers) for downloads (1 to 10). */
  spigotDownloadConcurrency: number;
};

function readRaw(db: Db): Map<string, string> {
  const rows = db.prepare('SELECT key, value FROM config').all() as { key: string; value: string }[];
  return new Map(rows.map((r) => [r.key, r.value]));
}

/**
 * Writes env-derived defaults for any setting not yet present. Existing rows are
 * left untouched, so this is safe on every boot and never overwrites a value the
 * owner changed in the dashboard.
 */
export function seedSettings(db: Db, env: Env): void {
  const existing = readRaw(db);
  const defaults: Record<SettingKey, string> = {
    admin_role_ids: env.DISCORD_ADMIN_ROLE_IDS.join(','),
    prune_keep_count: String(env.PRUNE_KEEP_COUNT),
    attach_max_bytes: String(env.ATTACH_MAX_BYTES),
    order_ttl_minutes: String(env.ORDER_TTL_MINUTES),
    download_token_ttl_minutes: String(env.DOWNLOAD_TOKEN_TTL_MINUTES),
    // Never seeded from env: enabling a Terms-violating feature must be a
    // deliberate click, not a leftover variable in a copied .env.
    auto_download_enabled: 'false',
    spigot_proxy_enabled: 'true',
    spigot_download_concurrency: String(env.SPIGOT_DOWNLOAD_CONCURRENCY),
  };

  const insert = db.prepare('INSERT INTO config (key, value) VALUES (?, ?)');
  const tx = db.transaction(() => {
    for (const key of SETTING_KEYS) {
      if (!existing.has(key)) insert.run(key, defaults[key]);
    }
  });
  tx();
}

/** Reads current settings, falling back to the env value when a row is absent. */
export function getSettings(db: Db, env: Env): Settings {
  const raw = readRaw(db);
  const int = (key: SettingKey, fallback: number): number => {
    const parsed = Number(raw.get(key));
    return Number.isInteger(parsed) ? parsed : fallback;
  };

  const roleIds = (raw.get('admin_role_ids') ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter((s) => /^\d{17,20}$/.test(s));

  return {
    adminRoleIds: roleIds.length > 0 ? roleIds : env.DISCORD_ADMIN_ROLE_IDS,
    pruneKeepCount: int('prune_keep_count', env.PRUNE_KEEP_COUNT),
    attachMaxBytes: int('attach_max_bytes', env.ATTACH_MAX_BYTES),
    orderTtlMinutes: int('order_ttl_minutes', env.ORDER_TTL_MINUTES),
    downloadTokenTtlMinutes: int('download_token_ttl_minutes', env.DOWNLOAD_TOKEN_TTL_MINUTES),
    // Only the exact string 'true' enables it. The int() helper cannot express
    // this, and anything looser would let a stray value switch it on.
    autoDownloadEnabled: raw.get('auto_download_enabled') === 'true',
    spigotProxyEnabled: raw.get('spigot_proxy_enabled') !== 'false',
    spigotDownloadConcurrency: Math.max(1, Math.min(10, int('spigot_download_concurrency', env.SPIGOT_DOWNLOAD_CONCURRENCY))),
  };
}

export function setSetting(db: Db, key: SettingKey, value: string): void {
  db.prepare('INSERT INTO config (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value').run(
    key,
    value,
  );
}
