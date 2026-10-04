import { eq, desc } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import type { Database } from "../db/neon.js";
import { spigotAccountRefs, type SpigotAccountRef, type NewSpigotAccountRef } from "@vault/db";

/**
 * Lấy toàn bộ danh sách Spigot Account References trong Neon DB (Non-sensitive).
 */
export async function listSpigotAccountRefs(
  db: Database
): Promise<SpigotAccountRef[]> {
  return db.select().from(spigotAccountRefs).orderBy(desc(spigotAccountRefs.createdAt));
}

/**
 * Tìm Spigot Account Reference theo nhãn (label).
 */
export async function findSpigotAccountRefByLabel(
  db: Database,
  label: string
): Promise<SpigotAccountRef | null> {
  const rows = await db
    .select()
    .from(spigotAccountRefs)
    .where(eq(spigotAccountRefs.label, label))
    .limit(1);
  return rows[0] ?? null;
}

/**
 * Thêm mới hoặc cập nhật Spigot Account Reference vào Neon DB (Chỉ metadata non-sensitive).
 */
export async function upsertSpigotAccountRef(
  db: Database,
  input: {
    accountId?: string;
    label: string;
    status?: string;
    health?: string;
    lastVerifiedAt?: Date | null;
  }
): Promise<SpigotAccountRef> {
  const accountId = input.accountId || randomUUID();
  const values: NewSpigotAccountRef = {
    accountId,
    label: input.label,
    status: input.status ?? "active",
    health: input.health ?? "healthy",
    lastVerifiedAt: input.lastVerifiedAt ?? null,
    updatedAt: new Date(),
  };

  const result = await db
    .insert(spigotAccountRefs)
    .values(values)
    .onConflictDoUpdate({
      target: spigotAccountRefs.label,
      set: {
        ...(input.status ? { status: input.status } : {}),
        ...(input.health ? { health: input.health } : {}),
        ...(input.lastVerifiedAt !== undefined ? { lastVerifiedAt: input.lastVerifiedAt } : {}),
        updatedAt: new Date(),
      },
    })
    .returning();

  const ref = result[0];
  if (!ref) {
    throw new Error("Không thể lưu Spigot Account Reference vào database");
  }
  return ref;
}

/**
 * Cập nhật health và status của Spigot Account Reference.
 */
export async function updateSpigotAccountRefHealth(
  db: Database,
  label: string,
  health: string,
  status?: string
): Promise<void> {
  await db
    .update(spigotAccountRefs)
    .set({
      health,
      ...(status ? { status } : {}),
      updatedAt: new Date(),
    })
    .where(eq(spigotAccountRefs.label, label));
}
