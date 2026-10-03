import { readdir, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import type { Database } from '../../db/neon.js';
import type { Version } from '@vault/db';
import { addPluginAlias, findPluginById } from '../../repositories/neon-plugins.js';
import {
  deletePendingIngest,
  findPendingIngestById,
  listPendingIngests,
  resolvePendingIngest,
} from '../../repositories/neon-pending-ingest.js';
import { createVersion, findVersionBySha256 } from '../../repositories/neon-versions.js';
import { createManualUpload } from '../../repositories/neon-manual-uploads.js';
import { shaToRelPath } from '../vault/content-addressed-paths.js';
import { commitToVault } from '../vault/hash-and-store-file.js';

export type AssignPendingInputNeon = {
  pendingId: number;
  pluginId: number;
  version: string;
  isStable?: boolean;
  aliasName?: string;
  assignedBy?: string;
  adminNote?: string;
};

export type AssignPendingResultNeon =
  | { ok: true; version: Version }
  | { ok: false; reason: 'pending-not-found' | 'plugin-not-found' | 'duplicate' };

/**
 * Gán file JAR trong hàng đợi pending_ingest vào một plugin đã xác định.
 */
export async function assignPendingIngestNeon(
  ctx: { db: Database; vaultDir: string },
  input: AssignPendingInputNeon
): Promise<AssignPendingResultNeon> {
  const pending = await findPendingIngestById(ctx.db, input.pendingId);
  if (!pending) return { ok: false, reason: 'pending-not-found' };

  const plugin = await findPluginById(ctx.db, input.pluginId);
  if (!plugin) return { ok: false, reason: 'plugin-not-found' };

  const existing = await findVersionBySha256(ctx.db, pending.sha256);
  if (existing) {
    await deletePendingIngest(ctx.db, input.pendingId);
    await unlink(pending.tmpPath).catch(() => undefined);
    return { ok: false, reason: 'duplicate' };
  }

  const version = await createVersion(ctx.db, {
    pluginId: plugin.id,
    version: input.version,
    rawVersion: null,
    sha256: pending.sha256,
    relPath: shaToRelPath(pending.sha256),
    bytes: pending.fileSize,
    originalName: pending.originalFilename,
    descriptorKind: pending.detectedPlatform || 'manual',
    isStable: input.isStable ?? true,
    versionFlag: 'manual',
    source: 'manual',
    changeLogs: '',
  });

  await createManualUpload(ctx.db, {
    versionId: version.id,
    pluginId: plugin.id,
    uploadedBy: input.assignedBy || pending.uploadedBy,
    originalName: pending.originalFilename,
    adminNote: input.adminNote || 'Duyệt thủ công từ hàng đợi pending_ingest',
  });

  await commitToVault(ctx.vaultDir, pending.sha256, pending.tmpPath);

  if (input.aliasName) {
    await addPluginAlias(ctx.db, plugin.id, input.aliasName);
  }

  await resolvePendingIngest(ctx.db, input.pendingId, 'approved');

  return { ok: true, version };
}

/**
 * Hủy bỏ tệp JAR trong hàng đợi và dọn file tạm.
 */
export async function discardPendingIngestNeon(
  db: Database,
  pendingId: number
): Promise<boolean> {
  const pending = await findPendingIngestById(db, pendingId);
  if (!pending) return false;

  await deletePendingIngest(db, pendingId);
  await unlink(pending.tmpPath).catch(() => undefined);
  return true;
}

/**
 * Dọn sạch các tệp tạm mồ côi (không nằm trong danh sách pending_ingest) khi khởi động bot.
 */
export async function sweepOrphanedTempsNeon(
  db: Database,
  tmpDir: string
): Promise<number> {
  const pendings = await listPendingIngests(db, 'needs_review');
  const owned = new Set(pendings.map((p) => p.tmpPath));

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
