import { randomBytes } from 'node:crypto';

/**
 * VietQR image URL builder.
 *
 * A plain GET image endpoint — no API call, no auth, no SDK. The result can go
 * straight into a Discord embed image.
 */
export function buildVietQrUrl(input: {
  accountNumber: string;
  bankCode: string;
  amount: number;
  code: string;
  template?: 'compact' | 'qronly';
}): string {
  const params = new URLSearchParams({
    acc: input.accountNumber,
    bank: input.bankCode,
    amount: String(input.amount),
    des: input.code,
  });
  if (input.template) params.set('template', input.template);
  return `https://qr.sepay.vn/img?${params.toString()}`;
}

/** Digits and uppercase letters only — the alphabet SePay's extractor accepts. */
const SUFFIX_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';

/**
 * Generates a payment code.
 *
 * SePay extracts this from the transfer memo server-side using a prefix template
 * configured in its dashboard, then uppercases the result. Constraints that shape
 * the format: the prefix is 2-5 letters, the suffix length must sit inside the
 * configured min/max (a shorter code yields an empty `code` silently), and the
 * character class is digits or A-Z0-9.
 *
 * Uppercase A-Z0-9 also survives whatever Vietnamese banks do to memos —
 * uppercasing is a no-op and there are no diacritics to strip. SePay's matching is
 * substring-based, so bank-prepended text like "CT DEN:" does not break it.
 */
export function generatePaymentCode(prefix: string, suffixLength: number): string {
  const bytes = randomBytes(suffixLength);
  let suffix = '';
  for (let i = 0; i < suffixLength; i++) {
    suffix += SUFFIX_ALPHABET[bytes[i]! % SUFFIX_ALPHABET.length];
  }
  return `${prefix.toUpperCase()}${suffix}`;
}

/**
 * Parses SePay's transactionDate, which is Vietnam local time (UTC+7) with no
 * timezone suffix. `new Date(raw)` would read it as local or UTC depending on the
 * runtime and land hours off.
 */
export function parseSepayTimestamp(raw: string): number | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})$/.exec(raw.trim());
  if (!match) return null;

  const [, year, month, day, hour, minute, second] = match.map(Number) as unknown as number[];
  const asUtc = Date.UTC(year!, month! - 1, day!, hour!, minute!, second!);
  // Shift back by the UTC+7 offset the wall-clock string is expressed in.
  return Math.floor((asUtc - 7 * 60 * 60 * 1000) / 1000);
}
