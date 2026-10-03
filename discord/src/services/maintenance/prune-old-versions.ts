import { unlink } from 'node:fs/promises';
import { join } from 'node:path';
import type { Db } from '../../db/connection.js';
import { countPlugins, listPlugins } from '../../repositories/plugins.js';
import { deleteVersionAndCheckBlob, listVersionsByPlugin } from '../../repositories/versions.js';

export type PrunedVersion = {
  pluginName: string;
  versionId: number;
  version: string | null;
  bytesFreed: number;
  blobRemoved: boolean;
};

export type PruneOutcome = { pruned: PrunedVersion[]; bytesFreed: number };

/**
 * Keeps every stable-marked version plus the N most recent per plugin.
 *
 * Deletion is irreversible, so each removal is logged individually — silently
 * dropping a version the owner wanted is worse than disk pressure. dryRun exists
 * so the owner can see what a first real run would take.
 *
 * Blobs are unlinked only when the reference check inside the delete transaction
 * says nothing else points at them.
 */
export async function pruneOldVersions(
  deps: { db: Db; vaultDir: string },
  options: { keepCount: number; dryRun?: boolean },
): Promise<PruneOutcome> {
  const total = countPlugins(deps.db);
  const plugins = listPlugins(deps.db, total, 0);
  const pruned: PrunedVersion[] = [];
  let bytesFreed = 0;

  for (const plugin of plugins) {
    // Newest first; ordering by upload time rather than version string, since
    // upstream names are not reliably sortable.
    const versions = listVersionsByPlugin(deps.db, plugin.id);

    const candidates = versions
      // Stable versions are kept regardless of position, and do not consume a slot
      // in the keep window either.
      .filter((version) => !version.isStable)
      .slice(options.keepCount);

    for (const version of candidates) {
      if (options.dryRun) {
        pruned.push({
          pluginName: plugin.displayName,
          versionId: version.id,
          version: version.version,
          bytesFreed: version.bytes,
          blobRemoved: false,
        });
        bytesFreed += version.bytes;
        continue;
      }

      const outcome = deleteVersionAndCheckBlob(deps.db, version.id);
      if (!outcome.deleted) continue;

      if (outcome.blobUnreferenced && outcome.sha256) {
        await unlink(join(deps.vaultDir, outcome.sha256.slice(0, 2), outcome.sha256)).catch(() => undefined);
        bytesFreed += version.bytes;
      }

      pruned.push({
        pluginName: plugin.displayName,
        versionId: version.id,
        version: version.version,
        bytesFreed: version.bytes,
        blobRemoved: outcome.blobUnreferenced,
      });
    }
  }

  return { pruned, bytesFreed };
}

/** One log line per removal, so a mistaken prune is diagnosable afterwards. */
export function formatPruneLog(outcome: PruneOutcome): string[] {
  return outcome.pruned.map(
    (entry) =>
      `Đã xoá ${entry.pluginName} ${entry.version ?? '(không rõ phiên bản)'} — ${(entry.bytesFreed / 1048576).toFixed(1)} MB`,
  );
}
