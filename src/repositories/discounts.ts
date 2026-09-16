import type { Db } from '../db/connection.js';
import { now } from '../db/connection.js';
import { toDiscountCode, toSqlBool, type DiscountRow } from '../db/row-mappers.js';
import type {
  CreateDiscountInput,
  DiscountCode,
  DiscountValidationResult,
  UpdateDiscountInput,
} from '../domain/discount.js';

const SELECT = 'SELECT * FROM discount_codes';

export function listDiscountCodes(db: Db): DiscountCode[] {
  const rows = db.prepare(`${SELECT} ORDER BY created_at DESC`).all() as DiscountRow[];
  return rows.map(toDiscountCode);
}

export function findDiscountById(db: Db, id: number): DiscountCode | null {
  const row = db.prepare(`${SELECT} WHERE id = ?`).get(id) as DiscountRow | undefined;
  return row ? toDiscountCode(row) : null;
}

export function findDiscountByCode(db: Db, code: string): DiscountCode | null {
  const normalized = code.trim().toUpperCase();
  const row = db.prepare(`${SELECT} WHERE code = ?`).get(normalized) as DiscountRow | undefined;
  return row ? toDiscountCode(row) : null;
}

export function createDiscountCode(db: Db, input: CreateDiscountInput): DiscountCode {
  const normalized = input.code.trim().toUpperCase();
  if (!normalized) throw new Error('Mã giảm giá không được để trống');
  if (input.value <= 0) throw new Error('Giá trị giảm giá phải lớn hơn 0');
  if (input.type === 'percent' && input.value > 100) {
    throw new Error('Giảm giá phần trăm không được vượt quá 100%');
  }

  const info = db
    .prepare(
      `INSERT INTO discount_codes (
        code, type, value, min_order, max_discount, max_uses, used_count, expires_at, is_active, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?, ?)`,
    )
    .run(
      normalized,
      input.type,
      input.value,
      input.minOrder ?? 0,
      input.maxDiscount ?? null,
      input.maxUses ?? null,
      input.expiresAt ?? null,
      toSqlBool(input.isActive ?? true),
      now(),
    );

  const created = findDiscountById(db, Number(info.lastInsertRowid));
  if (!created) throw new Error('Không tạo được mã giảm giá');
  return created;
}

export function updateDiscountCode(db: Db, id: number, patch: UpdateDiscountInput): DiscountCode {
  const existing = findDiscountById(db, id);
  if (!existing) throw new Error(`Không tìm thấy mã giảm giá #${id}`);

  const sets: string[] = [];
  const values: (string | number | null)[] = [];

  if (patch.code !== undefined) {
    const normalized = patch.code.trim().toUpperCase();
    if (!normalized) throw new Error('Mã không được để trống');
    sets.push('code = ?');
    values.push(normalized);
  }
  if (patch.type !== undefined) {
    sets.push('type = ?');
    values.push(patch.type);
  }
  if (patch.value !== undefined) {
    if (patch.value <= 0) throw new Error('Giá trị giảm giá phải lớn hơn 0');
    sets.push('value = ?');
    values.push(patch.value);
  }
  if (patch.minOrder !== undefined) {
    sets.push('min_order = ?');
    values.push(patch.minOrder);
  }
  if (patch.maxDiscount !== undefined) {
    sets.push('max_discount = ?');
    values.push(patch.maxDiscount);
  }
  if (patch.maxUses !== undefined) {
    sets.push('max_uses = ?');
    values.push(patch.maxUses);
  }
  if (patch.expiresAt !== undefined) {
    sets.push('expires_at = ?');
    values.push(patch.expiresAt);
  }
  if (patch.isActive !== undefined) {
    sets.push('is_active = ?');
    values.push(toSqlBool(patch.isActive));
  }

  if (sets.length > 0) {
    values.push(id);
    db.prepare(`UPDATE discount_codes SET ${sets.join(', ')} WHERE id = ?`).run(...values);
  }

  const updated = findDiscountById(db, id);
  if (!updated) throw new Error('Không cập nhật được mã');
  return updated;
}

export function toggleDiscountActive(db: Db, id: number, active?: boolean): DiscountCode {
  const existing = findDiscountById(db, id);
  if (!existing) throw new Error(`Không tìm thấy mã giảm giá #${id}`);

  const nextActive = active !== undefined ? active : !existing.isActive;
  db.prepare('UPDATE discount_codes SET is_active = ? WHERE id = ?').run(toSqlBool(nextActive), id);

  const updated = findDiscountById(db, id);
  if (!updated) throw new Error('Không cập nhật được trạng thái');
  return updated;
}

export function deleteDiscountCode(db: Db, id: number): void {
  db.prepare('DELETE FROM discount_codes WHERE id = ?').run(id);
}

export function validateDiscount(
  db: Db,
  code: string,
  orderAmount: number,
  userId?: string,
): DiscountValidationResult {
  const discount = findDiscountByCode(db, code);
  if (!discount) {
    return { valid: false, error: 'Mã giảm giá không tồn tại' };
  }

  if (!discount.isActive) {
    return { valid: false, error: 'Mã giảm giá đang bị tạm khoá' };
  }

  const currentSeconds = now();
  if (discount.expiresAt !== null && discount.expiresAt < currentSeconds) {
    return { valid: false, error: 'Mã giảm giá đã hết hạn sử dụng' };
  }

  if (discount.maxUses !== null && discount.usedCount >= discount.maxUses) {
    return { valid: false, error: 'Mã giảm giá đã hết lượt sử dụng' };
  }

  if (orderAmount < discount.minOrder) {
    return {
      valid: false,
      error: `Đơn hàng tối thiểu để dùng mã này là ${discount.minOrder.toLocaleString('vi-VN')} ₫`,
    };
  }

  let discountAmount = 0;
  if (discount.type === 'percent') {
    discountAmount = Math.round((orderAmount * discount.value) / 100);
    if (discount.maxDiscount !== null && discountAmount > discount.maxDiscount) {
      discountAmount = discount.maxDiscount;
    }
  } else {
    discountAmount = discount.value;
  }

  // Discount cannot exceed order total
  if (discountAmount > orderAmount) {
    discountAmount = orderAmount;
  }

  const finalAmount = Math.max(0, orderAmount - discountAmount);

  return {
    valid: true,
    discount,
    discountAmount,
    finalAmount,
  };
}

export function recordDiscountRedemption(
  db: Db,
  discountId: number,
  discordUserId: string,
  discountAmount: number,
  orderId?: number,
): void {
  db.transaction(() => {
    db.prepare('UPDATE discount_codes SET used_count = used_count + 1 WHERE id = ?').run(discountId);
    db.prepare(
      `INSERT INTO discount_code_redemptions (discount_id, discord_user_id, order_id, discount_amount, redeemed_at)
       VALUES (?, ?, ?, ?, ?)`,
    ).run(discountId, discordUserId, orderId ?? null, discountAmount, now());
  })();
}
