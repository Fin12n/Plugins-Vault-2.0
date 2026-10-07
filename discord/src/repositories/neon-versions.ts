import { eq, and, desc } from "drizzle-orm";
import type { Database } from "../db/neon.js";
import { versions, type Version, type NewVersion } from "@vault/db";

/**
 * Thêm phiên bản mới đã tải và trích xuất sha256 vào database.
 */
export async function createVersion(
  db: Database,
  input: NewVersion
): Promise<Version> {
  const inserted = await db.insert(versions).values(input).returning();
  const created = inserted[0];
  if (!created) {
    throw new Error("Không thể khởi tạo bản ghi version");
  }
  return created;
}

/**
 * Tìm phiên bản theo ID.
 */
export async function findVersionById(
  db: Database,
  id: number
): Promise<Version | null> {
  const result = await db.select().from(versions).where(eq(versions.id, id));
  return result[0] ?? null;
}

/**
 * Tìm phiên bản theo hash sha256 (kiểm tra trùng lặp).
 */
export async function findVersionBySha256(
  db: Database,
  sha256: string
): Promise<Version | null> {
  const result = await db
    .select()
    .from(versions)
    .where(eq(versions.sha256, sha256));
  return result[0] ?? null;
}

/**
 * Lấy danh sách toàn bộ phiên bản của một plugin, xếp mới nhất lên đầu.
 */
export async function listVersionsForPlugin(
  db: Database,
  pluginId: number
): Promise<Version[]> {
  return db
    .select()
    .from(versions)
    .where(eq(versions.pluginId, pluginId))
    .orderBy(desc(versions.uploadedAt));
}

/**
 * Lấy phiên bản ổn định (is_stable = true) mới nhất của plugin để phục vụ download.
 */
export async function getLatestStableVersion(
  db: Database,
  pluginId: number
): Promise<Version | null> {
  const result = await db
    .select()
    .from(versions)
    .where(and(eq(versions.pluginId, pluginId), eq(versions.isStable, true)))
    .orderBy(desc(versions.uploadedAt))
    .limit(1);
  return result[0] ?? null;
}

/**
 * Tìm phiên bản theo version_normalized.
 */
export async function findVersionByNormalized(
  db: Database,
  pluginId: number,
  versionNormalized: string,
): Promise<Version | null> {
  const result = await db
    .select()
    .from(versions)
    .where(
      and(
        eq(versions.pluginId, pluginId),
        eq(versions.versionNormalized, versionNormalized),
      ),
    )
    .limit(1);
  return result[0] ?? null;
}

/**
 * Lấy hoặc tạo mới Plugin Version theo cách lũy biến (idempotent getOrCreate).
 * Khớp theo (pluginId, versionNormalized).
 * Đảm bảo tính bất biến (immutability) của version identity: không update đè version cũ.
 */
export async function getOrCreatePluginVersion(
  db: Database,
  input: NewVersion,
): Promise<Version> {
  // 1. Kiểm tra theo normalized version
  if (input.versionNormalized) {
    const existing = await findVersionByNormalized(db, input.pluginId, input.versionNormalized);
    if (existing) return existing;
  }

  // 2. Kiểm tra theo version string gốc
  if (input.version) {
    const existingByVer = await db
      .select()
      .from(versions)
      .where(and(eq(versions.pluginId, input.pluginId), eq(versions.version, input.version)))
      .limit(1);
    if (existingByVer[0]) return existingByVer[0];
  }

  // 3. Chèn bản ghi mới với cơ chế an toàn concurrency
  try {
    return await createVersion(db, input);
  } catch (err: any) {
    if (input.versionNormalized) {
      const existing = await findVersionByNormalized(db, input.pluginId, input.versionNormalized);
      if (existing) return existing;
    }
    if (input.version) {
      const existingByVer = await db
        .select()
        .from(versions)
        .where(and(eq(versions.pluginId, input.pluginId), eq(versions.version, input.version)))
        .limit(1);
      if (existingByVer[0]) return existingByVer[0];
    }
    throw err;
  }
}
