import type { Db } from '../db/connection.js';
import { now } from '../db/connection.js';

/**
 * Queue of upstream versions seen but not yet archived.
 *
 * Exists because `checkPluginUpdates` commits `upstream_state` inside its
 * detection loop, before any download runs. Once that row is written the next
 * sweep short-circuits on a matching uuid, so without a separate record a
 * transient failure loses the version silently and permanently.
 */

export type PendingDownload = {
  pluginId: number;
  versionUuid: string;
  versionName: string;
  attempts: number;
  lastError: string;
  nextAttemptAt: number;
  createdAt: number;
};

type Row = {
  plugin_id: number;
  version_uuid: string;
  version_name: string;
  attempts: number;
  last_error: string;
  next_attempt_at: number;
  created_at: number;
};

const toPending = (row: Row): PendingDownload => ({
  pluginId: row.plugin_id,
  versionUuid: row.version_uuid,
  versionName: row.version_name,
  attempts: row.attempts,
  lastError: row.last_error,
  nextAttemptAt: row.next_attempt_at,
  createdAt: row.created_at,
});

/**
 * Records a version as owed.
 *
 * Idempotent on (plugin, uuid): re-detecting the same version must not reset the
 * backoff, or a permanently failing download would retry at full rate forever.
 */
export function enqueueDownload(
  db: Db,
  input: { pluginId: number; versionUuid: string; versionName: string },
): void {
  const ts = now();
  db.prepare(
    `INSERT INTO pending_download (plugin_id, version_uuid, version_name, attempts,
                                   last_error, next_attempt_at, created_at)
     VALUES (?, ?, ?, 0, '', ?, ?)
     ON CONFLICT (plugin_id, version_uuid) DO NOTHING`,
  ).run(input.pluginId, input.versionUuid, input.versionName, ts, ts);
}

/**
 * Rows whose backoff has elapsed, fair across plugins.
 *
 * A historical backfill can create hundreds of rows for one plugin in the same
 * second. Plain `created_at ASC LIMIT N` then serves that plugin for many sweeps
 * and starves every later resource. Rank within each plugin first, then take one
 * row per rank: every tracked plugin gets a turn before any gets a second one.
 */
export function listDueDownloads(db: Db, limit: number, maxAttempts = 3): PendingDownload[] {
  const rows = db
    .prepare(
      `WITH due AS (
         SELECT *, ROW_NUMBER() OVER (
           PARTITION BY plugin_id
           ORDER BY created_at ASC, version_uuid ASC
         ) AS plugin_rank
         FROM pending_download
         WHERE next_attempt_at <= ? AND attempts < ?
       )
       SELECT plugin_id, version_uuid, version_name, attempts,
              last_error, next_attempt_at, created_at
       FROM due
       ORDER BY plugin_rank ASC, created_at ASC, plugin_id ASC
       LIMIT ?`,
    )
    .all(now(), maxAttempts, limit) as Row[];
  return rows.map(toPending);
}

export function findPendingDownload(db: Db, pluginId: number, versionUuid: string): PendingDownload | null {
  const row = db.prepare(
    'SELECT * FROM pending_download WHERE plugin_id = ? AND version_uuid = ?',
  ).get(pluginId, versionUuid) as Row | undefined;
  return row ? toPending(row) : null;
}

/** Clears a row once the outcome is terminal — archived, duplicate, or unowned. */
export function resolveDownload(db: Db, pluginId: number, versionUuid: string): void {
  db.prepare('DELETE FROM pending_download WHERE plugin_id = ? AND version_uuid = ?').run(pluginId, versionUuid);
}

/**
 * Records a retryable failure and pushes the next attempt out.
 *
 * Exponential with a ceiling: a plugin whose download keeps failing must not
 * consume the whole per-sweep budget every hour and crowd out working ones.
 */
export function deferDownload(
  db: Db,
  pluginId: number,
  versionUuid: string,
  error: string,
  baseDelaySeconds = 900,
): void {
  const row = db
    .prepare('SELECT attempts FROM pending_download WHERE plugin_id = ? AND version_uuid = ?')
    .get(pluginId, versionUuid) as { attempts: number } | undefined;

  const attempts = (row?.attempts ?? 0) + 1;
  const delay = Math.min(baseDelaySeconds * 2 ** (attempts - 1), 24 * 60 * 60);

  db.prepare(
    `UPDATE pending_download
     SET attempts = ?, last_error = ?, next_attempt_at = ?
     WHERE plugin_id = ? AND version_uuid = ?`,
  ).run(attempts, error.slice(0, 500), now() + delay, pluginId, versionUuid);
}

/** Records an upstream gate without delaying the post-challenge resume. */
export function keepDownloadDue(
  db: Db,
  pluginId: number,
  versionUuid: string,
  error: string,
): void {
  db.prepare(
    `UPDATE pending_download
     SET last_error = ?, next_attempt_at = ?
     WHERE plugin_id = ? AND version_uuid = ?`,
  ).run(error.slice(0, 500), now(), pluginId, versionUuid);
}

/** Everything still owed, for the dashboard and for tests. */
export function listAllPendingDownloads(db: Db): PendingDownload[] {
  const rows = db.prepare('SELECT * FROM pending_download ORDER BY created_at ASC').all() as Row[];
  return rows.map(toPending);
}
