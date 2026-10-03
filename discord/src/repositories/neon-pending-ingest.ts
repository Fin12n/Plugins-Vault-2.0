import { eq, desc } from "drizzle-orm";
import type { Database } from "../db/neon.js";
import { pendingIngest, type PendingIngest, type NewPendingIngest } from "@vault/db";

/**
 * Đưa một file jar cần duyệt/chỉnh sửa vào hàng đợi pending_ingest.
 */
export async function createPendingIngest(
  db: Database,
  input: NewPendingIngest
): Promise<PendingIngest> {
  const inserted = await db.insert(pendingIngest).values(input).returning();
  const created = inserted[0];
  if (!created) {
    throw new Error("Không thể ghi nhận hàng đợi pending_ingest");
  }
  return created;
}

/**
 * Tìm bản ghi pending ingest theo ID.
 */
export async function findPendingIngestById(
  db: Database,
  id: number
): Promise<PendingIngest | null> {
  const result = await db
    .select()
    .from(pendingIngest)
    .where(eq(pendingIngest.id, id));
  return result[0] ?? null;
}

/**
 * Tìm bản ghi pending ingest theo mã SHA-256 (tránh lưu trùng file rác).
 */
export async function findPendingIngestBySha(
  db: Database,
  sha256: string
): Promise<PendingIngest | null> {
  const result = await db
    .select()
    .from(pendingIngest)
    .where(eq(pendingIngest.sha256, sha256));
  return result[0] ?? null;
}

/**
 * Lấy danh sách hàng đợi pending ingest (mặc định lấy trạng thái 'needs_review').
 */
export async function listPendingIngests(
  db: Database,
  status: string = "needs_review"
): Promise<PendingIngest[]> {
  return db
    .select()
    .from(pendingIngest)
    .where(eq(pendingIngest.status, status))
    .orderBy(desc(pendingIngest.createdAt));
}

/**
 * Cập nhật trạng thái duyệt hàng đợi (approved hoặc rejected).
 */
export async function resolvePendingIngest(
  db: Database,
  id: number,
  status: "approved" | "rejected"
): Promise<PendingIngest | null> {
  const updated = await db
    .update(pendingIngest)
    .set({
      status,
      resolvedAt: new Date(),
    })
    .where(eq(pendingIngest.id, id))
    .returning();
  return updated[0] ?? null;
}

/**
 * Xóa một bản ghi pending ingest khỏi cơ sở dữ liệu.
 */
export async function deletePendingIngest(
  db: Database,
  id: number
): Promise<void> {
  await db.delete(pendingIngest).where(eq(pendingIngest.id, id));
}
