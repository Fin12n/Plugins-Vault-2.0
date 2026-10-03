import { randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { stat, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import type { Readable } from 'node:stream';
import type { Database } from '../../db/neon.js';
import type { IngestErrorCode, IngestFailureReason, IngestResult } from '../../domain/ingest.js';
import type { DescriptorKind, PluginPlatform } from '../../domain/plugin.js';
import {
  addPluginAlias,
  createPlugin,
  findPluginById,
  findPluginByDescriptorName,
  findPluginBySlug,
} from '../../repositories/neon-plugins.js';
import { createPendingIngest, findPendingIngestBySha } from '../../repositories/neon-pending-ingest.js';
import { createVersion, findVersionBySha256 } from '../../repositories/neon-versions.js';
import { createManualUpload } from '../../repositories/neon-manual-uploads.js';
import { readJarDescriptor } from '../descriptor/read-jar-descriptor.js';
import { shaToRelPath, slugifyPluginName } from '../vault/content-addressed-paths.js';
import { commitToVault, hashAndStoreToTemp } from '../vault/hash-and-store-file.js';

export type NeonIngestContext = {
  db: Database;
  vaultDir: string;
  tmpDir: string;
};

export type NeonIngestSource = {
  originalName: string;
  open: () => Readable;
  pluginId?: number;
  uploadedBy?: string;
  adminNote?: string;
};

const PLATFORM_BY_KIND: Record<DescriptorKind, PluginPlatform> = {
  paper: 'paper',
  spigot: 'spigot',
  velocity: 'velocity',
  bungee: 'bungee',
  manual: 'spigot',
};

const MAX_SLUG_LENGTH = 64;

async function allocateSlug(db: Database, base: string): Promise<string> {
  const existing = await findPluginBySlug(db, base);
  if (!existing) return base;

  for (let i = 2; i < 1000; i++) {
    const suffix = `-${i}`;
    const trimmed = base.slice(0, MAX_SLUG_LENGTH - suffix.length).replace(/-+$/, '');
    const candidate = `${trimmed}${suffix}`;
    const check = await findPluginBySlug(db, candidate);
    if (!check) return candidate;
  }
  throw new Error(`Không tìm được slug trống cho "${base}"`);
}

function isPostgresUniqueViolation(err: unknown): boolean {
  return (
    (err as { code?: string })?.code === '23505' ||
    (err as { message?: string })?.message?.includes('unique constraint') === true
  );
}

async function duplicateResult(
  db: Database,
  originalName: string,
  sha256: string
): Promise<IngestResult> {
  const existing = await findVersionBySha256(db, sha256);
  let pluginName = 'không rõ';
  if (existing) {
    const p = await findPluginById(db, existing.pluginId);
    if (p) pluginName = p.displayName;
  }
  return {
    status: 'duplicate',
    originalName,
    sha256,
    existingPluginName: pluginName,
    existingVersion: existing?.version ?? null,
  };
}

/**
 * Xử lý nạp một tệp JAR duy nhất vào hệ thống Neon PostgreSQL.
 */
async function ingestOne(
  ctx: NeonIngestContext,
  source: NeonIngestSource
): Promise<IngestResult> {
  const tmpPath = join(ctx.tmpDir, `ingest-${randomUUID()}.jar`);
  let keepTemp = false;
  let stage: IngestErrorCode = 'read-failed';

  const park = async (
    reason: IngestFailureReason,
    detail: string,
    sha256: string,
    fileSize: number,
    detected?: { name?: string | null; version?: string | null; kind?: string | null }
  ): Promise<IngestResult> => {
    const existing = await findPendingIngestBySha(ctx.db, sha256);
    if (existing) {
      return {
        status: 'pending',
        originalName: source.originalName,
        reason,
        detail,
        pendingId: existing.id,
      };
    }

    const pending = await createPendingIngest(ctx.db, {
      uploadedBy: source.uploadedBy || 'system',
      originalFilename: source.originalName,
      sha256,
      tmpPath,
      fileSize,
      detectedPluginName: detected?.name ?? null,
      detectedVersion: detected?.version ?? null,
      detectedPlatform: detected?.kind ?? null,
      status: 'needs_review',
      errorReason: reason,
      errorDetail: detail,
    });

    keepTemp = true;
    return {
      status: 'pending',
      originalName: source.originalName,
      reason,
      detail,
      pendingId: pending.id,
    };
  };

  try {
    const stored = await hashAndStoreToTemp(source.open, tmpPath);

    stage = 'db-failed';
    const existing = await findVersionBySha256(ctx.db, stored.sha256);
    if (existing) {
      const blobPresent = await stat(join(ctx.vaultDir, existing.relPath)).then(
        () => true,
        () => false
      );
      if (blobPresent) {
        return await duplicateResult(ctx.db, source.originalName, stored.sha256);
      }
      await commitToVault(ctx.vaultDir, stored.sha256, tmpPath);
      return await duplicateResult(ctx.db, source.originalName, stored.sha256);
    }

    stage = 'read-failed';
    const descriptor = await readJarDescriptor(tmpPath);

    stage = 'db-failed';
    if (!descriptor.ok) {
      return await park(descriptor.reason, descriptor.detail, stored.sha256, stored.bytes);
    }

    let plugin =
      source.pluginId !== undefined ? await findPluginById(ctx.db, source.pluginId) : null;
    let createdPlugin = false;

    if (plugin && plugin.descriptorName !== descriptor.name) {
      await addPluginAlias(ctx.db, plugin.id, descriptor.name);
    }

    if (!plugin) {
      plugin = await findPluginByDescriptorName(ctx.db, descriptor.name);
    }

    if (!plugin) {
      const baseSlug = slugifyPluginName(descriptor.name);
      if (!baseSlug) {
        const detail = `Tên "${descriptor.name}" không tạo được slug hợp lệ`;
        return await park('missing-fields', detail, stored.sha256, stored.bytes, {
          name: descriptor.name,
          version: descriptor.version,
          kind: descriptor.kind,
        });
      }

      const allocated = await allocateSlug(ctx.db, baseSlug);
      plugin = await createPlugin(ctx.db, {
        pluginId: `plugin-${allocated}`,
        slug: allocated,
        displayName: descriptor.name,
        descriptorName: descriptor.name,
        aliases: [],
        platform: PLATFORM_BY_KIND[descriptor.kind],
        depositPrice: 0,
        isPremium: false,
        spigotLink: '',
      });
      createdPlugin = true;
    } else if (plugin.descriptorName !== descriptor.name) {
      await addPluginAlias(ctx.db, plugin.id, descriptor.name);
    }

    let version;
    try {
      version = await createVersion(ctx.db, {
        pluginId: plugin.id,
        version: descriptor.version,
        rawVersion: descriptor.rawVersion || null,
        sha256: stored.sha256,
        relPath: shaToRelPath(stored.sha256),
        bytes: stored.bytes,
        originalName: source.originalName,
        descriptorKind: descriptor.kind,
        isStable: true,
        versionFlag: descriptor.versionFlag,
        source: source.uploadedBy ? 'manual' : 'spigot_auto',
        changeLogs: '',
      });

      if (source.uploadedBy) {
        await createManualUpload(ctx.db, {
          versionId: version.id,
          pluginId: plugin.id,
          uploadedBy: source.uploadedBy,
          originalName: source.originalName,
          adminNote: source.adminNote || 'Tải lên thủ công qua Bot Discord',
        });
      }
    } catch (err) {
      if (isPostgresUniqueViolation(err)) {
        return await duplicateResult(ctx.db, source.originalName, stored.sha256);
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
      versionFlag: version.versionFlag as any,
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
    if (!keepTemp) {
      await unlink(tmpPath).catch(() => undefined);
    }
  }
}

/**
 * Xử lý nạp hàng loạt file JAR vào Neon PostgreSQL.
 */
export async function ingestJarBatchNeon(
  ctx: NeonIngestContext,
  sources: NeonIngestSource[]
): Promise<IngestResult[]> {
  const results: IngestResult[] = [];
  for (const source of sources) {
    results.push(await ingestOne(ctx, source));
  }
  return results;
}

/** Tạo IngestSource từ file trên đĩa cứng */
export function fileSourceNeon(
  path: string,
  originalName: string,
  options?: { pluginId?: number; uploadedBy?: string; adminNote?: string }
): NeonIngestSource {
  return {
    originalName,
    open: () => createReadStream(path),
    pluginId: options?.pluginId,
    uploadedBy: options?.uploadedBy,
    adminNote: options?.adminNote,
  };
}
