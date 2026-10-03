import { randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { stat, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import type { Readable } from 'node:stream';
import type { Db } from '../../db/connection.js';
import type { IngestErrorCode, IngestFailureReason, IngestResult } from '../../domain/ingest.js';
import type { DescriptorKind, PluginPlatform } from '../../domain/plugin.js';
import {
  addAlias,
  createPlugin,
  findPluginById,
  findPluginByDescriptorName,
  findPluginBySlug,
} from '../../repositories/plugins.js';
import { createPendingIngest, findPendingBySha } from '../../repositories/pending-ingest.js';
import { createVersion, findVersionBySha } from '../../repositories/versions.js';
import { readJarDescriptor } from '../descriptor/read-jar-descriptor.js';
import { shaToRelPath, slugifyPluginName } from '../vault/content-addressed-paths.js';
import { commitToVault, hashAndStoreToTemp } from '../vault/hash-and-store-file.js';

export type IngestContext = { db: Db; vaultDir: string; tmpDir: string };

export type IngestSource = {
  originalName: string;
  /** A factory, not a stream: see hashAndStoreToTemp for why. */
  open: () => Readable;
  /**
   * Plugin the jar is already known to belong to, bypassing name matching.
   *
   * Set when the jar was fetched for a specific tracked plugin. The descriptor
   * name inside a jar is the code-level name ("Vulcan") while the vault entry
   * carries the marketplace title ("Vulcan Anti-Cheat"), so matching by name
   * files the download under a brand-new plugin instead. The tracked entry then
   * stays empty forever, re-triggering the same download every sweep, while the
   * archived copy sits under a duplicate with no resource id.
   */
  pluginId?: number;
};

/** Descriptor kinds map onto the platform a plugin targets. */
const PLATFORM_BY_KIND: Record<DescriptorKind, PluginPlatform> = {
  paper: 'paper',
  spigot: 'spigot',
  velocity: 'velocity',
  bungee: 'bungee',
  manual: 'spigot',
};

const MAX_SLUG_LENGTH = 64;

/**
 * Finds a free slug. Two different plugin names can normalize to the same slug
 * ("My Plugin" and "my-plugin"), and slug is UNIQUE, so collisions take a numeric
 * suffix. Room for the suffix is reserved by truncating the base, otherwise a
 * base already at the length limit produces candidates identical to itself and no
 * suffix ever frees it.
 */
function allocateSlug(db: Db, base: string): string {
  if (!findPluginBySlug(db, base)) return base;

  for (let i = 2; i < 1000; i++) {
    const suffix = `-${i}`;
    const trimmed = base.slice(0, MAX_SLUG_LENGTH - suffix.length).replace(/-+$/, '');
    const candidate = `${trimmed}${suffix}`;
    if (!findPluginBySlug(db, candidate)) return candidate;
  }
  throw new Error(`Không tìm được slug trống cho "${base}"`);
}

function isUniqueViolation(err: unknown): boolean {
  return (err as { code?: string } | undefined)?.code === 'SQLITE_CONSTRAINT_UNIQUE';
}

function pluginDisplayName(db: Db, pluginId: number): string {
  return findPluginById(db, pluginId)?.displayName ?? 'không rõ';
}

function duplicateResult(db: Db, originalName: string, sha256: string): IngestResult {
  const existing = findVersionBySha(db, sha256);
  return {
    status: 'duplicate',
    originalName,
    sha256,
    existingPluginName: existing ? pluginDisplayName(db, existing.pluginId) : 'không rõ',
    existingVersion: existing?.version ?? null,
  };
}

/**
 * Ingests one jar: hash to temp, read its descriptor, dedupe by content, then
 * file it under the matching plugin.
 *
 * Temp lifecycle is the subtle part. The temp is unlinked on every exit except
 * when a pending_ingest row now owns it — and `keepTemp` is set only AFTER that
 * row is committed, so a failed insert cannot leave a file with nothing
 * referencing it.
 */
async function ingestOne(ctx: IngestContext, source: IngestSource): Promise<IngestResult> {
  const tmpPath = join(ctx.tmpDir, `ingest-${randomUUID()}.jar`);
  let keepTemp = false;
  let stage: IngestErrorCode = 'read-failed';

  /** Parks the jar for manual assignment, taking ownership of the temp file. */
  const park = (reason: IngestFailureReason, detail: string, sha256: string, bytes: number): IngestResult => {
    // Same content already parked: reuse that row rather than accumulating
    // another full-size temp copy for every retry.
    const existing = findPendingBySha(ctx.db, sha256);
    if (existing) {
      return { status: 'pending', originalName: source.originalName, reason, detail, pendingId: existing.id };
    }

    const pendingId = createPendingIngest(ctx.db, {
      originalFilename: source.originalName,
      sha256,
      tmpPath,
      bytes,
      reason,
      detail,
    });
    // Only now does something reference the file.
    keepTemp = true;
    return { status: 'pending', originalName: source.originalName, reason, detail, pendingId };
  };

  try {
    const stored = await hashAndStoreToTemp(source.open, tmpPath);

    // Content dedupe first: an identical blob needs no interpretation, and this
    // is the cheap path for a re-uploaded jar.
    stage = 'db-failed';
    const existing = findVersionBySha(ctx.db, stored.sha256);
    if (existing) {
      // Trust the filesystem over the row. If the blob went missing (manual
      // deletion, an interrupted prune), treating this as a duplicate would
      // discard the only copy and leave the version permanently undeliverable.
      const blobPresent = await stat(join(ctx.vaultDir, existing.relPath)).then(
        () => true,
        () => false,
      );
      if (blobPresent) {
        return duplicateResult(ctx.db, source.originalName, stored.sha256);
      }
      await commitToVault(ctx.vaultDir, stored.sha256, tmpPath);
      return duplicateResult(ctx.db, source.originalName, stored.sha256);
    }

    stage = 'read-failed';
    const descriptor = await readJarDescriptor(tmpPath);

    stage = 'db-failed';
    if (!descriptor.ok) {
      return park(descriptor.reason, descriptor.detail, stored.sha256, stored.bytes);
    }

    let plugin = source.pluginId !== undefined ? findPluginById(ctx.db, source.pluginId) : null;
    let createdPlugin = false;

    if (plugin && plugin.descriptorName !== descriptor.name) {
      // The caller knows this jar belongs here, so teach the mapping instead of
      // letting the next upload of the same jar create a second plugin.
      addAlias(ctx.db, plugin.id, descriptor.name);
    }

    if (!plugin) plugin = findPluginByDescriptorName(ctx.db, descriptor.name);

    if (!plugin) {
      const baseSlug = slugifyPluginName(descriptor.name);
      if (!baseSlug) {
        const detail = `tên "${descriptor.name}" không tạo được slug hợp lệ`;
        return park('missing-fields', detail, stored.sha256, stored.bytes);
      }

      plugin = createPlugin(ctx.db, {
        slug: allocateSlug(ctx.db, baseSlug),
        displayName: descriptor.name,
        descriptorName: descriptor.name,
        platform: PLATFORM_BY_KIND[descriptor.kind],
      });
      createdPlugin = true;
    } else if (plugin.descriptorName !== descriptor.name) {
      // Matched through an alias — record it so the mapping stays visible.
      addAlias(ctx.db, plugin.id, descriptor.name);
    }

    // Register the row BEFORE moving the blob into place. Committing first would
    // leave an untracked blob in the vault on any insert failure, and prune only
    // walks rows, so such a blob leaks forever.
    let version;
    try {
      version = createVersion(ctx.db, {
        pluginId: plugin.id,
        version: descriptor.version,
        rawVersion: descriptor.rawVersion || null,
        sha256: stored.sha256,
        relPath: shaToRelPath(stored.sha256),
        bytes: stored.bytes,
        originalName: source.originalName,
        descriptorKind: descriptor.kind,
        versionFlag: descriptor.versionFlag,
      });
    } catch (err) {
      // A concurrent ingest of identical content won the race between the dedupe
      // check above and this insert. That is a duplicate, not a failure.
      if (isUniqueViolation(err)) {
        return duplicateResult(ctx.db, source.originalName, stored.sha256);
      }
      throw err;
    }

    stage = 'storage-failed';
    await commitToVault(ctx.vaultDir, stored.sha256, tmpPath);

    return {
      status: 'added',
      originalName: source.originalName,
      pluginId: plugin.id,
      pluginName: plugin.displayName,
      versionId: version.id,
      version: version.version,
      versionFlag: version.versionFlag,
      createdPlugin,
    };
  } catch (err) {
    return {
      status: 'failed',
      originalName: source.originalName,
      code: stage,
      detail: err instanceof Error ? err.message : String(err),
    };
  } finally {
    if (!keepTemp) await unlink(tmpPath).catch(() => undefined);
  }
}

/**
 * Ingests a batch, each file independently.
 *
 * Sequential because disk I/O dominates and a stable per-file result order is
 * easier to report. Correctness does not depend on it: the sha UNIQUE constraint
 * is what actually prevents a duplicate row under concurrency, and plugin
 * creation is a synchronous block that cannot interleave.
 */
export async function ingestJarBatch(ctx: IngestContext, sources: IngestSource[]): Promise<IngestResult[]> {
  const results: IngestResult[] = [];
  for (const source of sources) {
    results.push(await ingestOne(ctx, source));
  }
  return results;
}

/** Convenience wrapper for ingesting files already on disk. */
export function fileSource(path: string, originalName: string, pluginId?: number): IngestSource {
  return { originalName, open: () => createReadStream(path), ...(pluginId !== undefined ? { pluginId } : {}) };
}
