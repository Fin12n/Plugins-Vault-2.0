import { eq, sql, and, desc, count } from "drizzle-orm";
import type { Database } from "../db/neon.js";
import { assertNotFrozen } from "../services/maintenance/write-freeze.js";
import {
  discountCodes,
  discountCodeRedemptions,
  type DiscountCode,
  type NewDiscountCode,
  type DiscountCodeRedemption,
  type NewDiscountCodeRedemption,
} from "@vault/db";

type DbOrTx = Parameters<Parameters<Database["transaction"]>[0]>[0] | Database;

/**
 * Tìm mã giảm giá theo code (case-insensitive).
 */
export async function findDiscountByCode(
  db: DbOrTx,
  code: string
): Promise<DiscountCode | null> {
  const result = await db
    .select()
    .from(discountCodes)
    .where(eq(discountCodes.code, code.toUpperCase()))
    .limit(1);
  return result[0] ?? null;
}

/**
 * Tìm mã giảm giá theo ID.
 */
export async function findDiscountById(
  db: DbOrTx,
  id: number
): Promise<DiscountCode | null> {
  const result = await db
    .select()
    .from(discountCodes)
    .where(eq(discountCodes.id, id))
    .limit(1);
  return result[0] ?? null;
}

/**
 * Tạo mã giảm giá mới.
 */
export async function createDiscountCode(
  db: DbOrTx,
  input: NewDiscountCode
): Promise<DiscountCode> {
  const rows = await db
    .insert(discountCodes)
    .values({
      ...input,
      code: input.code.toUpperCase(),
    })
    .returning();
  const created = rows[0];
  if (!created) {
    throw new Error("Không thể tạo mã giảm giá");
  }
  return created;
}

/**
 * Lấy toàn bộ danh sách mã giảm giá.
 */
export async function listDiscounts(
  db: DbOrTx
): Promise<DiscountCode[]> {
  return db.select().from(discountCodes).orderBy(desc(discountCodes.createdAt));
}

/**
 * Khóa và áp dụng mã giảm giá theo Canonical Lock Order (Step 1: discount_codes).
 * Xác thực hạn sử dụng, số lượt tối đa, giá trị đơn hàng tối thiểu.
 */
export async function lockAndRedeemDiscountCode(
  tx: Parameters<Parameters<Database["transaction"]>[0]>[0],
  input: {
    code: string;
    discordUserId: string;
    orderId: number;
    orderAmount: number;
  }
): Promise<{
  discount: DiscountCode;
  discountAmount: number;
  finalAmount: number;
  redemption: DiscountCodeRedemption;
}> {
  assertNotFrozen("Áp dụng mã giảm giá");
  const { code, discordUserId, orderId, orderAmount } = input;

  // 1. Lock row discount_codes với FOR UPDATE
  const lockedRows = await tx
    .select()
    .from(discountCodes)
    .where(eq(discountCodes.code, code.toUpperCase()))
    .for("update");

  const discount = lockedRows[0];
  if (!discount) {
    throw new Error(`Mã giảm giá '${code}' không tồn tại`);
  }

  if (!discount.isActive) {
    throw new Error(`Mã giảm giá '${code}' hiện đang bị vô hiệu hóa`);
  }

  if (discount.expiresAt && discount.expiresAt.getTime() < Date.now()) {
    throw new Error(`Mã giảm giá '${code}' đã hết hạn`);
  }

  if (discount.maxUses !== null && discount.usedCount >= discount.maxUses) {
    throw new Error(`Mã giảm giá '${code}' đã hết số lượt sử dụng`);
  }

  if (discount.minOrder > 0 && orderAmount < discount.minOrder) {
    throw new Error(
      `Đơn hàng cần tối thiểu ${discount.minOrder.toLocaleString("vi-VN")}đ để áp dụng mã giảm giá này`
    );
  }

  // 2. Tính số tiền giảm
  let discountAmount = 0;
  if (discount.type === "fixed") {
    discountAmount = Math.min(discount.value, orderAmount);
  } else if (discount.type === "percent") {
    const rawDiscount = Math.floor((orderAmount * discount.value) / 100);
    discountAmount =
      discount.maxDiscount != null
        ? Math.min(rawDiscount, discount.maxDiscount)
        : rawDiscount;
  }
  discountAmount = Math.min(discountAmount, orderAmount);
  const finalAmount = Math.max(0, orderAmount - discountAmount);

  // 3. Tăng usedCount
  await tx
    .update(discountCodes)
    .set({
      usedCount: sql`${discountCodes.usedCount} + 1`,
    })
    .where(eq(discountCodes.id, discount.id));

  // 4. Ghi nhận redemption record (chống trùng lặp theo orderId)
  const redemptions = await tx
    .insert(discountCodeRedemptions)
    .values({
      discountId: discount.id,
      discordUserId,
      orderId,
      discountAmount,
    })
    .returning();

  const redemption = redemptions[0];
  if (!redemption) {
    throw new Error(`Không thể ghi nhận lượt sử dụng mã giảm giá '${code}' cho đơn hàng #${orderId}`);
  }

  return {
    discount,
    discountAmount,
    finalAmount,
    redemption,
  };
}

/**
 * Tìm redemption theo orderId.
 */
export async function findRedemptionByOrder(
  db: DbOrTx,
  orderId: number
): Promise<DiscountCodeRedemption | null> {
  const rows = await db
    .select()
    .from(discountCodeRedemptions)
    .where(eq(discountCodeRedemptions.orderId, orderId))
    .limit(1);
  return rows[0] ?? null;
}

/**
 * Đếm số lần user đã áp dụng mã giảm giá này.
 */
export async function countUserRedemptions(
  db: DbOrTx,
  discountId: number,
  discordUserId: string
): Promise<number> {
  const res = await db
    .select({ total: count() })
    .from(discountCodeRedemptions)
    .where(
      and(
        eq(discountCodeRedemptions.discountId, discountId),
        eq(discountCodeRedemptions.discordUserId, discordUserId)
      )
    );
  return res[0]?.total ?? 0;
}
