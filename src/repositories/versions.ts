import type { Db } from '../db/connection.js';
import { now } from '../db/connection.js';
import { toPluginVersion, toSqlBool, type VersionRow } from '../db/row-mappers.js';
import type { DescriptorKind, PluginVersion, VersionFlag, VersionWithPlugin } from '../domain/plugin.js';

export type CreateVersionInput = {
  pluginId: number;
  version: string | null;
  rawVersion: string | null;
  sha256: string;
  relPath: string;
  bytes: number;
  originalName: string;
  descriptorKind: DescriptorKind;
  versionFlag: VersionFlag;
};

const SELECT = 'SELECT * FROM versions';

export function findVersionById(db: Db, id: number): PluginVersion | null {
  const row = db.prepare(`${SELECT} WHERE id = ?`).get(id) as VersionRow | undefined;
  return row ? toPluginVersion(row) : null;
}

export function findVersionBySha(db: Db, sha256: string): PluginVersion | null {
  const row = db.prepare(`${SELECT} WHERE sha256 = ?`).get(sha256) as VersionRow | undefined;
  return row ? toPluginVersion(row) : null;
}

export function createVersion(db: Db, input: CreateVersionInput): PluginVersion {
  const info = db
    .prepare(
      `INSERT INTO versions (plugin_id, version, raw_version, sha256, rel_path, bytes,
                             original_name, descriptor_kind, version_flag, uploaded_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      input.pluginId,
      input.version,
      input.rawVersion,
      input.sha256,
      input.relPath,
      input.bytes,
      input.originalName,
      input.descriptorKind,
      input.versionFlag,
      now(),
    );

  const created = findVersionById(db, Number(info.lastInsertRowid));
  if (!created) throw new Error('Không tạo được version');
  return created;
}

/**
 * Versions newest-first by upload time.
 *
 * Never order by the version string: upstream version names are neither unique
 * nor semver-ordered (real values include "3.2.3m" and "2.0.6 BETA", and one
 * resource ships two distinct releases both named "4.0.15").
 */
export function listVersionsByPlugin(db: Db, pluginId: number, limit?: number, offset = 0): PluginVersion[] {
  const sql = `${SELECT} WHERE plugin_id = ? ORDER BY uploaded_at DESC, id DESC${
    limit === undefined ? '' : ' LIMIT ? OFFSET ?'
  }`;
  const rows = (limit === undefined
    ? db.prepare(sql).all(pluginId)
    : db.prepare(sql).all(pluginId, limit, offset)) as VersionRow[];
  return rows.map(toPluginVersion);
}

export function countVersionsByPlugin(db: Db, pluginId: number): number {
  return (db.prepare('SELECT count(*) AS c FROM versions WHERE plugin_id = ?').get(pluginId) as { c: number }).c;
}

export function setVersionStable(db: Db, id: number, isStable: boolean): void {
  db.prepare('UPDATE versions SET is_stable = ? WHERE id = ?').run(toSqlBool(isStable), id);
}

/** Corrects a version string the owner fixed by hand, e.g. an unresolved placeholder. */
export function setVersionString(db: Db, id: number, version: string): void {
  db.prepare("UPDATE versions SET version = ?, version_flag = 'manual' WHERE id = ?").run(version, id);
}

export function deleteVersion(db: Db, id: number): void {
  db.prepare('DELETE FROM versions WHERE id = ?').run(id);
}

/**
 * Whether any surviving row still points at a blob.
 *
 * Today `sha256` is UNIQUE, so a blob has at most one row and this is equivalent
 * to "the row still exists" — but the check is the right shape for the prune path
 * and stays correct if that constraint is ever relaxed.
 */
export function isShaReferenced(db: Db, sha256: string): boolean {
  const row = db.prepare('SELECT 1 FROM versions WHERE sha256 = ? LIMIT 1').get(sha256);
  return row !== undefined;
}

/**
 * Version joined with the plugin fields the delivery flow needs: display name for
 * the message, slug for the filename, deposit price to decide whether payment is
 * required at all.
 */
export function findVersionWithPlugin(db: Db, versionId: number): VersionWithPlugin | null {
  const row = db
    .prepare(
      `SELECT v.*, p.slug AS plugin_slug, p.display_name AS plugin_display_name,
              p.deposit_price AS deposit_price
         FROM versions v JOIN plugins p ON p.id = v.plugin_id
        WHERE v.id = ?`,
    )
    .get(versionId) as (VersionRow & { plugin_slug: string; plugin_display_name: string; deposit_price: number }) | undefined;

  if (!row) return null;
  return {
    ...toPluginVersion(row),
    pluginSlug: row.plugin_slug,
    pluginDisplayName: row.plugin_display_name,
    depositPrice: row.deposit_price,
  };
}

/**
 * Deletes a version and reports whether its blob is now unreferenced.
 *
 * Both steps run in one transaction so a concurrent ingest cannot insert a new
 * row for the same content between the delete and the check — which would
 * otherwise leave a row pointing at a blob the caller is about to unlink.
 * The caller performs the unlink only when `blobUnreferenced` is true.
 */
export function deleteVersionAndCheckBlob(db: Db, id: number): { deleted: boolean; sha256: string | null; blobUnreferenced: boolean } {
  const tx = db.transaction(() => {
    const existing = findVersionById(db, id);
    if (!existing) return { deleted: false, sha256: null, blobUnreferenced: false };

    db.prepare('DELETE FROM versions WHERE id = ?').run(id);
    return {
      deleted: true,
      sha256: existing.sha256,
      blobUnreferenced: !isShaReferenced(db, existing.sha256),
    };
  });
  return tx();
}
