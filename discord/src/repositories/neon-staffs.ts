import { eq, or } from 'drizzle-orm';
import { staffs, type Staff, type NewStaff } from '@vault/db';
import type { Database } from '../db/neon.js';

/**
 * Tìm nhân sự theo Discord Snowflake ID
 */
export async function findStaffByDiscordId(
  db: Database,
  discordUserId: string,
): Promise<Staff | null> {
  const rows = await db
    .select()
    .from(staffs)
    .where(eq(staffs.discordUserId, discordUserId))
    .limit(1);

  return rows[0] ?? null;
}

/**
 * Tìm nhân sự theo Email
 */
export async function findStaffByEmail(
  db: Database,
  email: string,
): Promise<Staff | null> {
  const rows = await db
    .select()
    .from(staffs)
    .where(eq(staffs.email, email))
    .limit(1);

  return rows[0] ?? null;
}

/**
 * Tạo mới nhân sự
 */
export async function createStaff(
  db: Database,
  data: NewStaff,
): Promise<Staff> {
  const rows = await db.insert(staffs).values(data).returning();
  return rows[0]!;
}

/**
 * Cập nhật thông tin nhân sự
 */
export async function updateStaff(
  db: Database,
  id: number,
  data: Partial<NewStaff>,
): Promise<Staff | null> {
  const rows = await db
    .update(staffs)
    .set({
      ...data,
      updatedAt: new Date(),
    })
    .where(eq(staffs.id, id))
    .returning();

  return rows[0] ?? null;
}

/**
 * Danh sách toàn bộ nhân sự
 */
export async function listStaffs(db: Database): Promise<Staff[]> {
  return db.select().from(staffs).orderBy(staffs.id);
}

/**
 * Kiểm tra xem một người dùng Discord có quyền quản trị (Admin / Owner / Moderator) không
 */
export async function isDiscordStaffAdmin(
  db: Database,
  discordUserId: string,
): Promise<boolean> {
  const staff = await findStaffByDiscordId(db, discordUserId);
  if (!staff || !staff.isActive) {
    return false;
  }

  if (staff.role === 'owner' || staff.role === 'admin') {
    return true;
  }

  // Hoặc kiểm tra mảng permissions
  if (
    staff.permissions.includes('*') ||
    staff.permissions.includes('plugins.manage') ||
    staff.permissions.includes('channels.manage')
  ) {
    return true;
  }

  return false;
}

/**
 * Tự động đảm bảo tài khoản Owner tồn tại trong bảng staffs khi bot boot
 */
export async function ensureOwnerStaffExists(
  db: Database,
  ownerDiscordId?: string,
): Promise<void> {
  if (!ownerDiscordId) return;

  try {
    const existing = await findStaffByDiscordId(db, ownerDiscordId);
    if (!existing) {
      await db.insert(staffs).values({
        discordUserId: ownerDiscordId,
        username: 'Owner',
        displayName: 'EZStore Owner',
        role: 'owner',
        permissions: ['*'],
        isActive: true,
        addedBy: 'system_auto_boot',
      }).onConflictDoNothing();
      console.log(`[NeonStaffs] ✅ Đã tự động tạo tài khoản Owner đầu tiên cho Discord ID: ${ownerDiscordId}`);
    }
  } catch (err) {
    console.warn('[NeonStaffs] Lỗi khi kiểm tra / khởi tạo Owner Staff:', err instanceof Error ? err.message : err);
  }
}
