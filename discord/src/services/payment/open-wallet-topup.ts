/**
 * Opening a wallet top-up.
 *
 * Shares the payment-code alphabet and length with plugin orders, so a code must
 * be checked against BOTH tables before use. A UNIQUE constraint on each table
 * cannot see the other, and a cross-table collision would be the worst kind of
 * bug: a transfer meant to buy a plugin would land in a wallet instead, or the
 * reverse.
 */
import type { Db } from '../../db/connection.js';
import type { CreatedTopup } from '../../domain/wallet.js';
import { findOrderByCode } from '../../repositories/orders.js';
import { countTopupsByCode, createWalletTopup } from '../../repositories/wallet-topups.js';
import { buildVietQrUrl, generatePaymentCode } from './build-vietqr-url.js';
import type { OrderConfig } from './match-and-fulfil-order.js';

/** True when the code is free in both payment-code spaces. */
export function isCodeAvailable(db: Db, code: string): boolean {
  return findOrderByCode(db, code) === null && countTopupsByCode(db, code) === 0;
}

export function openWalletTopup(
  db: Db,
  config: OrderConfig,
  input: { discordUserId: string; amount: number },
): CreatedTopup | null {
  if (!Number.isInteger(input.amount) || input.amount <= 0) return null;

  for (let attempt = 0; attempt < 5; attempt++) {
    const code = generatePaymentCode(config.codePrefix, config.codeSuffixLength);
    if (!isCodeAvailable(db, code)) continue;

    const topup = createWalletTopup(db, {
      code,
      discordUserId: input.discordUserId,
      amount: input.amount,
      ttlMinutes: config.ttlMinutes,
    });

    return {
      id: topup.id,
      code: topup.code,
      amount: topup.amount,
      qrUrl: buildVietQrUrl({
        accountNumber: config.accountNumber,
        bankCode: config.bankCode,
        amount: topup.amount,
        code: topup.code,
      }),
      expiresAt: topup.expiresAt,
    };
  }
  return null;
}
