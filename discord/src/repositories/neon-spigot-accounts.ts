import { eq, desc } from "drizzle-orm";
import type { Database } from "../db/neon.js";
import { spigotAccounts, type SpigotAccount, type NewSpigotAccount } from "@vault/db";

/**
 * Lấy toàn bộ danh sách tài khoản Spigot trong Neon DB.
 */
export async function listSpigotAccounts(
  db: Database
): Promise<SpigotAccount[]> {
  return db.select().from(spigotAccounts).orderBy(desc(spigotAccounts.id));
}

/**
 * Lấy danh sách tài khoản Spigot đang bật (is_enabled = true).
 */
export async function listEnabledSpigotAccounts(
  db: Database
): Promise<SpigotAccount[]> {
  return db
    .select()
    .from(spigotAccounts)
    .where(eq(spigotAccounts.isEnabled, true))
    .orderBy(desc(spigotAccounts.id));
}

/**
 * Thêm mới hoặc cập nhật tài khoản Spigot vào Neon DB.
 */
export async function upsertSpigotAccount(
  db: Database,
  input: {
    label: string;
    username: string;
    passwordEncrypted: string;
    xfUserEncrypted?: string;
    xfSessionEncrypted?: string;
  }
): Promise<SpigotAccount> {
  const values: NewSpigotAccount = {
    label: input.label,
    username: input.username,
    passwordEncrypted: input.passwordEncrypted,
    xfUserEncrypted: input.xfUserEncrypted ?? "",
    xfSessionEncrypted: input.xfSessionEncrypted ?? "",
    status: "ok",
    isEnabled: true,
    updatedAt: new Date(),
  };

  const result = await db
    .insert(spigotAccounts)
    .values(values)
    .onConflictDoUpdate({
      target: spigotAccounts.label,
      set: {
        username: values.username,
        passwordEncrypted: values.passwordEncrypted,
        ...(input.xfUserEncrypted ? { xfUserEncrypted: input.xfUserEncrypted } : {}),
        ...(input.xfSessionEncrypted ? { xfSessionEncrypted: input.xfSessionEncrypted } : {}),
        updatedAt: new Date(),
      },
    })
    .returning();

  const account = result[0];
  if (!account) {
    throw new Error("Không thể lưu tài khoản Spigot vào database");
  }
  return account;
}

/**
 * Cập nhật session cookies sau khi đăng nhập Spigot thành công.
 */
export async function updateAccountCookies(
  db: Database,
  label: string,
  xfUserEncrypted: string,
  xfSessionEncrypted: string
): Promise<void> {
  await db
    .update(spigotAccounts)
    .set({
      xfUserEncrypted,
      xfSessionEncrypted,
      lastVerifiedAt: new Date(),
      status: "ok",
      updatedAt: new Date(),
    })
    .where(eq(spigotAccounts.label, label));
}

/**
 * Cập nhật trạng thái tài khoản Spigot ('ok' | 'stale' | 'needs_login' | 'locked').
 */
export async function updateAccountStatus(
  db: Database,
  label: string,
  status: "ok" | "stale" | "needs_login" | "locked"
): Promise<void> {
  await db
    .update(spigotAccounts)
    .set({ status, updatedAt: new Date() })
    .where(eq(spigotAccounts.label, label));
}
