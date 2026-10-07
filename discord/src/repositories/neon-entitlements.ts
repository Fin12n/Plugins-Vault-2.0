import { eq, and } from 'drizzle-orm';
import type { Database } from '../db/neon.js';
import {
  pluginEntitlements,
  type PluginEntitlement,
  type NewPluginEntitlement,
  type EntitlementStatus,
} from '@vault/db';

/**
 * Phase 5A: Canonical Entitlement Repository
 *
 * Quản trị quyền sở hữu phiên bản (Version-Specific Entitlement) hoàn toàn tách biệt
 * với giao dịch tài chính (Purchase/Order) và tệp vật lý (Artifact).
 *
 * QUY TẮC BẤT BIẾN:
 * 1. Quyền sở hữu tính theo từng phiên bản cụ thể (USER + PLUGIN VERSION).
 * 2. Mua version 1.1 KHÔNG tự động cấp quyền cho 1.2.
 * 3. Hoàn tiền/thu hồi chỉ đổi trạng thái sang REVOKED, KHÔNG xóa dữ liệu lịch sử.
 */

/**
 * Tìm entitlement theo ID số nguyên.
 */
export async function findEntitlementById(
  db: Database,
  id: number,
): Promise<PluginEntitlement | null> {
  const result = await db
    .select()
    .from(pluginEntitlements)
    .where(eq(pluginEntitlements.id, id));
  return result[0] ?? null;
}

/**
 * Lấy entitlement cụ thể của một user đối với một plugin version.
 */
export async function getUserVersionEntitlement(
  db: Database,
  userId: string,
  pluginVersionId: number,
): Promise<PluginEntitlement | null> {
  const result = await db
    .select()
    .from(pluginEntitlements)
    .where(
      and(
        eq(pluginEntitlements.userId, userId),
        eq(pluginEntitlements.pluginVersionId, pluginVersionId),
      ),
    );
  return result[0] ?? null;
}

/**
 * Kiểm tra xem user có quyền sở hữu hợp lệ (ACTIVE) đối với phiên bản này hay không.
 */
export async function hasUserVersionEntitlement(
  db: Database,
  userId: string,
  pluginVersionId: number,
): Promise<boolean> {
  const entitlement = await getUserVersionEntitlement(db, userId, pluginVersionId);
  return entitlement !== null && entitlement.status === 'ACTIVE';
}

/**
 * Cấp quyền sở hữu phiên bản cho user theo cách lũy biến (idempotent grant).
 * Nếu đã có bản ghi ACTIVE, trả về bản ghi hiện tại.
 * Nếu trước đó bị REVOKED hoặc SUSPENDED, kích hoạt lại sang ACTIVE.
 */
export async function grantEntitlement(
  db: Database,
  input: {
    userId: string;
    pluginVersionId: number;
    orderId?: number | null;
    status?: EntitlementStatus;
  },
): Promise<PluginEntitlement> {
  const existing = await getUserVersionEntitlement(db, input.userId, input.pluginVersionId);

  if (existing) {
    if (existing.status === 'ACTIVE') {
      return existing;
    }
    // Kích hoạt lại quyền nếu đang bị revoked/suspended
    const updated = await db
      .update(pluginEntitlements)
      .set({
        status: input.status ?? 'ACTIVE',
        orderId: input.orderId !== undefined ? input.orderId : existing.orderId,
        revokedAt: null,
        updatedAt: new Date(),
      })
      .where(eq(pluginEntitlements.id, existing.id))
      .returning();
    return updated[0]!;
  }

  try {
    const inserted = await db
      .insert(pluginEntitlements)
      .values({
        userId: input.userId,
        pluginVersionId: input.pluginVersionId,
        orderId: input.orderId ?? null,
        status: input.status ?? 'ACTIVE',
        grantedAt: new Date(),
      })
      .returning();

    const created = inserted[0];
    if (!created) {
      throw new Error(`Không thể cấp entitlement cho user ${input.userId} với version ${input.pluginVersionId}`);
    }
    return created;
  } catch (err: any) {
    const existingConcurrent = await getUserVersionEntitlement(db, input.userId, input.pluginVersionId);
    if (existingConcurrent) return existingConcurrent;
    throw err;
  }
}

/**
 * Thu hồi quyền sở hữu phiên bản (ví dụ khi hoàn tiền order).
 * Đánh dấu status = 'REVOKED' và cập nhật revoked_at, KHÔNG hard-delete bản ghi.
 */
export async function revokeEntitlement(
  db: Database,
  userId: string,
  pluginVersionId: number,
  _reason?: string,
): Promise<PluginEntitlement | null> {
  const existing = await getUserVersionEntitlement(db, userId, pluginVersionId);
  if (!existing) {
    return null;
  }

  const updated = await db
    .update(pluginEntitlements)
    .set({
      status: 'REVOKED',
      revokedAt: new Date(),
      updatedAt: new Date(),
    })
    .where(eq(pluginEntitlements.id, existing.id))
    .returning();

  return updated[0] ?? null;
}

/**
 * Lấy danh sách toàn bộ các phiên bản mà user được cấp quyền sở hữu.
 */
export async function listEntitlementsForUser(
  db: Database,
  userId: string,
): Promise<PluginEntitlement[]> {
  return db
    .select()
    .from(pluginEntitlements)
    .where(eq(pluginEntitlements.userId, userId));
}
