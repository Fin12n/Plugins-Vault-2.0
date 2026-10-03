import { eq, desc } from "drizzle-orm";
import type { Database } from "../db/neon.js";
import { manualUploads, type ManualUpload, type NewManualUpload } from "@vault/db";

/**
 * Ghi nhận nhật ký một lần upload thủ công file jar của Staff/Admin.
 */
export async function createManualUpload(
  db: Database,
  input: NewManualUpload
): Promise<ManualUpload> {
  const inserted = await db.insert(manualUploads).values(input).returning();
  const created = inserted[0];
  if (!created) {
    throw new Error("Không thể ghi nhận nhật ký manual_uploads");
  }
  return created;
}

/**
 * Lấy lịch sử upload thủ công cho một plugin cụ thể.
 */
export async function listManualUploadsForPlugin(
  db: Database,
  pluginId: number
): Promise<ManualUpload[]> {
  return db
    .select()
    .from(manualUploads)
    .where(eq(manualUploads.pluginId, pluginId))
    .orderBy(desc(manualUploads.createdAt));
}

/**
 * Lấy lịch sử upload thủ công của một nhân viên/staff (theo Discord User ID).
 */
export async function listManualUploadsByStaff(
  db: Database,
  uploadedBy: string
): Promise<ManualUpload[]> {
  return db
    .select()
    .from(manualUploads)
    .where(eq(manualUploads.uploadedBy, uploadedBy))
    .orderBy(desc(manualUploads.createdAt));
}

/**
 * Lấy danh sách các lần upload thủ công gần đây nhất trên toàn hệ thống.
 */
export async function listRecentManualUploads(
  db: Database,
  limit = 50
): Promise<ManualUpload[]> {
  return db
    .select()
    .from(manualUploads)
    .orderBy(desc(manualUploads.createdAt))
    .limit(limit);
}
