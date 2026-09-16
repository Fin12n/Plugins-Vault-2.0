import type { Db } from '../db/connection.js';
import { now } from '../db/connection.js';
import { toUpstreamState, type UpstreamStateRow } from '../db/row-mappers.js';
import type { UpstreamState } from '../domain/plugin.js';

export function findUpstreamState(db: Db, pluginId: number): UpstreamState | null {
  const row = db.prepare('SELECT * FROM upstream_state WHERE plugin_id = ?').get(pluginId) as
    | UpstreamStateRow
    | undefined;
  return row ? toUpstreamState(row) : null;
}

/**
 * Records the newest upstream version seen for a plugin.
 *
 * Persisted rather than held in memory so a restart does not re-announce versions
 * the owner has already been told about.
 */
export function saveUpstreamState(
  db: Db,
  input: { pluginId: number; versionUuid: string; versionName: string; releaseDateMs: number },
): void {
  db.prepare(
    `INSERT INTO upstream_state (plugin_id, version_uuid, version_name, release_date_ms, checked_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT (plugin_id) DO UPDATE SET
       version_uuid = excluded.version_uuid,
       version_name = excluded.version_name,
       release_date_ms = excluded.release_date_ms,
       checked_at = excluded.checked_at`,
  ).run(input.pluginId, input.versionUuid, input.versionName, input.releaseDateMs, now());
}

/** Updates only the check time, for a poll that found nothing new. */
export function touchUpstreamState(db: Db, pluginId: number): void {
  db.prepare('UPDATE upstream_state SET checked_at = ? WHERE plugin_id = ?').run(now(), pluginId);
}
