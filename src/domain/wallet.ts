/**
 * Wallet domain.
 *
 * Balances are stored in ĐỒNG (VND), never in coins. Coins are a display unit at
 * a fixed 1000:1 rate, so storing them would round every conversion away: an
 * overpayment of 1.500 ₫ saved as "1 coin" quietly loses 500 ₫ of someone's
 * money, and that drift compounds with no way to trace it back. VND is the
 * smallest unit that actually exists.
 */

/** Fixed display rate. 1 coin = 1.000 ₫. */
export const VND_PER_COIN = 1000;

/**
 * Every reason a balance can move. Mirrored by a CHECK constraint on
 * wallet_ledger.kind.
 *
 * card_topup: scratch card accepted — credited at the card's real face value
 * bank_topup: transfer landed against a wallet top-up code
 * order_hold: deducted when an order opens, so one balance cannot fund two orders
 * order_refund: returned when that order expires or delivery fails
 * overpay: transfer exceeded what was due; the surplus is kept rather than lost
 * manual: owner adjusted the balance from the dashboard
 */
export const LEDGER_KINDS = [
  'card_topup',
  'bank_topup',
  'order_hold',
  'order_refund',
  'overpay',
  'manual',
] as const;
export type LedgerKind = (typeof LEDGER_KINDS)[number];

/** What a ledger row points at, for tracing a movement back to its cause. */
export const LEDGER_REF_TYPES = ['order', 'topup', 'card', ''] as const;
export type LedgerRefType = (typeof LEDGER_REF_TYPES)[number];

export type Wallet = {
  discordUserId: string;
  /** VND, never negative. */
  balance: number;
  createdAt: number;
  updatedAt: number;
};

export type LedgerEntry = {
  id: number;
  discordUserId: string;
  /** VND. Positive credits, negative debits. */
  delta: number;
  /** Balance immediately after this row, so drift is detectable by comparison. */
  balanceAfter: number;
  kind: LedgerKind;
  refType: LedgerRefType;
  refId: number | null;
  note: string;
  createdAt: number;
};

/**
 * Coins for display. Floors, so a 1.500 ₫ balance shows as 1 coin while all
 * 1.500 ₫ stays spendable — the remainder is displayed, not discarded.
 */
export function toCoins(vnd: number): number {
  return Math.floor(vnd / VND_PER_COIN);
}

export function coinsToVnd(coins: number): number {
  return coins * VND_PER_COIN;
}

/**
 * Balance as both units, because either alone is confusing: coins are what the
 * shop is priced in, VND is what people transfer.
 */
export function formatBalance(vnd: number): string {
  return `${toCoins(vnd).toLocaleString('vi-VN')} coin (${vnd.toLocaleString('vi-VN')} ₫)`;
}

/**
 * pending: QR shown, awaiting transfer
 * credited: money arrived and the wallet was credited with what arrived
 * expired: TTL passed without a transfer — nothing was held, so nothing is undone
 *
 * Deliberately has no 'underpaid': for a top-up every amount is valid, because
 * there is no goods to withhold. Mirrored by a CHECK on wallet_topups.status.
 */
export const WALLET_TOPUP_STATUSES = ['pending', 'credited', 'expired'] as const;
export type WalletTopupStatus = (typeof WALLET_TOPUP_STATUSES)[number];

export type WalletTopup = {
  id: number;
  /** Uppercase payment code embedded in the transfer memo. */
  code: string;
  discordUserId: string;
  /** What they said they would send. Shown on the QR, nothing more. */
  amount: number;
  /** What actually arrived, and what was credited. Null until a transfer lands. */
  paidAmount: number | null;
  status: WalletTopupStatus;
  createdAt: number;
  expiresAt: number;
  creditedAt: number | null;
};

export type CreatedTopup = {
  id: number;
  code: string;
  amount: number;
  qrUrl: string;
  expiresAt: number;
};
