import { describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { migrate } from '../src/db/migrate.js';
import {
  createDiscountCode,
  deleteDiscountCode,
  findDiscountByCode,
  listDiscountCodes,
  toggleDiscountActive,
  updateDiscountCode,
  validateDiscount,
} from '../src/repositories/discounts.js';

describe('discounts repository', () => {
  it('creates percent and fixed discount codes and normalizes uppercase', () => {
    const db = new Database(':memory:');
    migrate(db);

    const d1 = createDiscountCode(db, {
      code: 'summer20',
      type: 'percent',
      value: 20,
      minOrder: 50000,
      maxDiscount: 30000,
    });

    expect(d1.code).toBe('SUMMER20');
    expect(d1.type).toBe('percent');
    expect(d1.value).toBe(20);
    expect(d1.minOrder).toBe(50000);
    expect(d1.maxDiscount).toBe(30000);
    expect(d1.isActive).toBe(true);

    const d2 = createDiscountCode(db, {
      code: 'GIAM10K',
      type: 'fixed',
      value: 10000,
    });

    expect(d2.code).toBe('GIAM10K');
    expect(d2.type).toBe('fixed');
    expect(d2.value).toBe(10000);

    const list = listDiscountCodes(db);
    expect(list.length).toBe(2);
  });

  it('validates discount with minimum order and max discount limits', () => {
    const db = new Database(':memory:');
    migrate(db);

    createDiscountCode(db, {
      code: 'VIP50',
      type: 'percent',
      value: 50,
      minOrder: 100000,
      maxDiscount: 60000,
    });

    // Case 1: Order amount below minimum
    const v1 = validateDiscount(db, 'vip50', 80000);
    expect(v1.valid).toBe(false);
    expect(v1.error).toContain('tối thiểu');

    // Case 2: Order 200,000đ -> 50% = 100k, capped by maxDiscount 60k
    const v2 = validateDiscount(db, 'VIP50', 200000);
    expect(v2.valid).toBe(true);
    expect(v2.discountAmount).toBe(60000);
    expect(v2.finalAmount).toBe(140000);

    // Case 3: Order 100,000đ -> 50% = 50k
    const v3 = validateDiscount(db, 'VIP50', 100000);
    expect(v3.valid).toBe(true);
    expect(v3.discountAmount).toBe(50000);
    expect(v3.finalAmount).toBe(50000);
  });

  it('handles toggle active and delete', () => {
    const db = new Database(':memory:');
    migrate(db);

    const d = createDiscountCode(db, {
      code: 'SALE',
      type: 'fixed',
      value: 5000,
    });

    const toggled = toggleDiscountActive(db, d.id, false);
    expect(toggled.isActive).toBe(false);

    const v = validateDiscount(db, 'SALE', 20000);
    expect(v.valid).toBe(false);
    expect(v.error).toContain('tạm khoá');

    deleteDiscountCode(db, d.id);
    expect(findDiscountByCode(db, 'SALE')).toBeNull();
  });
});
