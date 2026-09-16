import { readdir, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import type { Db } from '../../db/connection.js';
import type { PluginVersion } from '../../domain/plugin.js';
import { addAlias, findPluginById } from '../../repositories/plugins.js';
import { deletePendingIngest, findPendingIngest, listPendingIngest } from '../../repositories/pending-ingest.js';
import { createVersion, findVersionBySha } from '../../repositories/versions.js';
import { shaToRelPath } from '../vault/content-addressed-paths.js';
import { commitToVault } from '../vault/hash-and-store-file.js';

export type AssignPendingInput = {
  pendingId: number;
  pluginId: number;
  /** Owner-supplied, since the jar could not declare one readably. */
  version: string;
  /** Record the jar's declared name as an alias so future uploads self-file. */
  aliasName?: string;
};

export type AssignPendingResult =
  | { ok: true; version: PluginVersion }
  | { ok: false; reason: 'pending-not-found' | 'plugin-not-found' | 'duplicate' };

/**
 * Files a jar the automatic path could not identify.
 *
 * Shares the row-before-blob ordering with the normal ingest path: registering
 * the version first means a failed insert cannot leave an untracked blob in the
 * vault, which prune would never reach because it only walks rows.
 */
export async function assignPendingIngest(
  ctx: { db: Db; vaultDir: string },
  input: AssignPendingInput,
): Promise<AssignPendingResult> {
  const pending = findPendingIngest(ctx.db, input.pendingId);
  if (!pending) return { ok: false, reason: 'pending-not-found' };

  const plugin = findPluginById(ctx.db, input.pluginId);
  if (!plugin) return { ok: false, reason: 'plugin-not-found' };

  if (findVersionBySha(ctx.db, pending.sha256)) {
    // Already archived under some plugin; drop the pending copy.
    deletePendingIngest(ctx.db, input.pendingId);
    await unlink(pending.tmpPath).catch(() => undefined);
    return { ok: false, reason: 'duplicate' };
  }

  const version = createVersion(ctx.db, {
    pluginId: plugin.id,
    version: input.version,
    rawVersion: null,
    sha256: pending.sha256,
    relPath: shaToRelPath(pending.sha256),
    bytes: pending.bytes,
    originalName: pending.originalFilename,
    descriptorKind: 'manual',
    versionFlag: 'manual',
  });

  await commitToVault(ctx.vaultDir, pending.sha256, pending.tmpPath);
  if (input.aliasName) addAlias(ctx.db, plugin.id, input.aliasName);
  deletePendingIngest(ctx.db, input.pendingId);

  return { ok: true, version };
}

/** Discards a pending jar and its temp copy. */
export async function discardPendingIngest(db: Db, pendingId: number): Promise<boolean> {
  const pending = findPendingIngest(db, pendingId);
  if (!pending) return false;
  deletePendingIngest(db, pendingId);
  await unlink(pending.tmpPath).catch(() => undefined);
  return true;
}

/**
 * Removes temp files left behind by an interrupted ingest.
 *
 * Pending rows own their temp files, so anything in the temp directory not
 * referenced by a row is a crash leftover. This MUST run before the HTTP server
 * starts accepting uploads — otherwise it would delete the temp of an ingest
 * currently in flight.
 */
export async function sweepOrphanedTemps(db: Db, tmpDir: string): Promise<number> {
  const owned = new Set(listPendingIngest(db).map((p) => p.tmpPath));

  const entries = await readdir(tmpDir).catch(() => [] as string[]);
  let removed = 0;

  for (const name of entries) {
    if (!name.startsWith('ingest-')) continue;
    const full = join(tmpDir, name);
    if (owned.has(full)) continue;
    await unlink(full).catch(() => undefined);
    removed++;
  }
  return removed;
}
