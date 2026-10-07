import { eq } from 'drizzle-orm';
import type { Database } from '../db/neon.js';
import {
  pluginArtifacts,
  type PluginArtifact,
  type NewPluginArtifact,
  type ArtifactStatus,
} from '@vault/db';

/**
 * Phase 5A: Canonical Artifact Repository
 *
 * Quản trị vòng đời tệp vật lý độc lập với danh tính phiên bản.
 * Mỗi Plugin Version có tối đa một canonical artifact (UNIQUE(plugin_version_id)).
 */

export class ArtifactNotFoundError extends Error {
  constructor(versionId: number) {
    super(`Không tìm thấy canonical artifact cho version ID ${versionId}`);
    this.name = 'ArtifactNotFoundError';
  }
}

/**
 * Tìm artifact theo ID số nguyên.
 */
export async function findArtifactById(
  db: Database,
  id: number,
): Promise<PluginArtifact | null> {
  const result = await db
    .select()
    .from(pluginArtifacts)
    .where(eq(pluginArtifacts.id, id));
  return result[0] ?? null;
}

/**
 * Tìm canonical artifact liên kết với một phiên bản cụ thể.
 */
export async function findCanonicalArtifactByVersionId(
  db: Database,
  versionId: number,
): Promise<PluginArtifact | null> {
  const result = await db
    .select()
    .from(pluginArtifacts)
    .where(eq(pluginArtifacts.pluginVersionId, versionId));
  return result[0] ?? null;
}

/**
 * Tìm artifact theo giá trị hash sha256.
 */
export async function findArtifactBySha256(
  db: Database,
  sha256: string,
): Promise<PluginArtifact | null> {
  const result = await db
    .select()
    .from(pluginArtifacts)
    .where(eq(pluginArtifacts.sha256, sha256));
  return result[0] ?? null;
}

/**
 * Lấy hoặc tạo mới Artifact theo cách lũy biến (idempotent getOrCreate).
 * Nếu đã tồn tại artifact cho plugin_version_id, trả về bản ghi hiện hữu (không ghi đè ngầm).
 */
export async function getOrCreateArtifact(
  db: Database,
  input: NewPluginArtifact,
): Promise<PluginArtifact> {
  // 1. Kiểm tra artifact hiện hữu
  const existing = await findCanonicalArtifactByVersionId(db, input.pluginVersionId);
  if (existing) {
    return existing;
  }

  // 2. Chèn mới với cơ chế an toàn concurrency
  try {
    const inserted = await db
      .insert(pluginArtifacts)
      .values(input)
      .returning();

    const created = inserted[0];
    if (!created) {
      throw new Error(`Không thể khởi tạo bản ghi artifact cho version ${input.pluginVersionId}`);
    }
    return created;
  } catch (err: any) {
    const existingConcurrent = await findCanonicalArtifactByVersionId(db, input.pluginVersionId);
    if (existingConcurrent) return existingConcurrent;
    throw err;
  }
}

/**
 * Cập nhật trạng thái chu trình sống của artifact (PENDING -> DOWNLOADING -> VERIFYING -> READY / FAILED / CORRUPT).
 */
export async function updateArtifactStatus(
  db: Database,
  versionId: number,
  status: ArtifactStatus,
  patch: Partial<NewPluginArtifact> = {},
): Promise<PluginArtifact | null> {
  const updatePayload: Record<string, unknown> = {
    ...patch,
    status,
    updatedAt: new Date(),
  };

  if (status === 'READY') {
    updatePayload.verifiedAt = updatePayload.verifiedAt ?? new Date();
    updatePayload.jarValid = true;
  }

  const updated = await db
    .update(pluginArtifacts)
    .set(updatePayload)
    .where(eq(pluginArtifacts.pluginVersionId, versionId))
    .returning();

  return updated[0] ?? null;
}

/**
 * Kiểm tra xem một artifact có ở trạng thái sẵn sàng tải hay không (chỉ READY mới hợp lệ).
 */
export function isArtifactUsable(artifact: PluginArtifact | null | undefined): boolean {
  if (!artifact) return false;
  return artifact.status === 'READY' && artifact.jarValid === true;
}
