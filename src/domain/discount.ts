export const DISCOUNT_TYPES = ['percent', 'fixed'] as const;
export type DiscountType = (typeof DISCOUNT_TYPES)[number];

export type DiscountCode = {
  id: number;
  code: string;
  type: DiscountType;
  value: number; // % (e.g. 20) or VND (e.g. 10000)
  minOrder: number;
  maxDiscount: number | null;
  maxUses: number | null;
  usedCount: number;
  expiresAt: number | null; // unix timestamp in seconds
  isActive: boolean;
  createdAt: number;
};

export type CreateDiscountInput = {
  code: string;
  type: DiscountType;
  value: number;
  minOrder?: number;
  maxDiscount?: number | null;
  maxUses?: number | null;
  expiresAt?: number | null;
  isActive?: boolean;
};

export type UpdateDiscountInput = Partial<{
  code: string;
  type: DiscountType;
  value: number;
  minOrder: number;
  maxDiscount: number | null;
  maxUses: number | null;
  expiresAt: number | null;
  isActive: boolean;
}>;

export type DiscountValidationResult = {
  valid: boolean;
  error?: string;
  discountAmount?: number;
  finalAmount?: number;
  discount?: DiscountCode;
};
