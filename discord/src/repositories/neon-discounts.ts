import { eq, sql } from "drizzle-orm";
import type { Database } from "../db/neon.js";
import { discountCodes, type DiscountCode } from "@vault/db";

/**
 * Tìm mã giảm giá theo code.
 */
export async function findDiscountByCode(
  db: Database,
  code: string
): Promise<DiscountCode | null> {
  const result = await db
    .select()
    .from(discountCodes)
    .where(eq(discountCodes.code, code.toUpperCase()));
  return result[0] ?? null;
}

/**
 * Tăng số lượt sử dụng của mã giảm giá thêm 1.
 */
export async function incrementDiscountUses(
  db: Database,
  id: number
): Promise<void> {
  await db
    .update(discountCodes)
    .set({
      usedCount: sql`${discountCodes.usedCount} + 1`,
    })
    .where(eq(discountCodes.id, id));
}

/**
 * Lấy toàn bộ danh sách mã giảm giá.
 */
export async function listDiscounts(
  db: Database
): Promise<DiscountCode[]> {
  return db.select().from(discountCodes);
}
