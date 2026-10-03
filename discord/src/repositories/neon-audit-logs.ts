import { desc } from 'drizzle-orm';
import { auditLogs, type AuditLog, type NewAuditLog } from '@vault/db';
import type { Database } from '../db/neon.js';

/**
 * Ghi lại vết hành động quản trị viên vào bảng audit_logs
 */
export async function createAuditLog(
  db: Database,
  data: NewAuditLog,
): Promise<AuditLog> {
  const rows = await db.insert(auditLogs).values(data).returning();
  return rows[0]!;
}

/**
 * Lấy danh sách nhật ký hành động gần nhất
 */
export async function listRecentAuditLogs(
  db: Database,
  limit = 50,
): Promise<AuditLog[]> {
  return db
    .select()
    .from(auditLogs)
    .orderBy(desc(auditLogs.createdAt))
    .limit(limit);
}
