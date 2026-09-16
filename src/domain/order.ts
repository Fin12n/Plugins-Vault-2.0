/**
 * pending: QR shown, awaiting transfer
 * paid: transfer matched, delivery not yet confirmed
 * wallet_paid: settled entirely from the coin wallet — no transfer will ever
 *   arrive, so it is kept distinct from 'paid' to keep such orders out of the
 *   reconcile view, which exists for orders that still need a decision
 * delivered: file handed over, audit row written
 * expired: TTL passed without payment — delivers nothing, and any coins held for
 *   it are returned to the wallet
 * dm_blocked: paid, but the bot cannot DM the user; token stays valid
 * underpaid: money arrived but short of bank_due; never swept by the expiry
 *   sweep, and surfaced in reconcile so the owner can release or refund
 *
 * Mirrored by a CHECK constraint on orders.status.
 */
export const ORDER_STATUSES = [
  'pending',
  'paid',
  'delivered',
  'expired',
  'dm_blocked',
  'underpaid',
  'wallet_paid',
] as const;
export type OrderStatus = (typeof ORDER_STATUSES)[number];

export type Order = {
  id: number;
  /** Uppercase payment code embedded in the transfer memo. */
  code: string;
  discordUserId: string;
  /**
   * Null once the version is deleted or pruned. The order survives on purpose:
   * losing the record that money was taken is worse than a dangling reference,
   * which is what the denormalized labels below cover.
   */
  versionId: number | null;
  pluginName: string;
  versionLabel: string;
  /** Full price. Always equals walletPaid + bankDue. */
  amount: number;
  /** Taken from the coin wallet when the order opened, already deducted there. */
  walletPaid: number;
  /** Still owed by transfer, and what the QR carries. */
  bankDue: number;
  status: OrderStatus;
  /** What actually arrived. Null until a transfer lands. */
  paidAmount: number | null;
  createdAt: number;
  expiresAt: number;
  paidAt: number | null;
  deliveredAt: number | null;
};

/**
 * SePay webhook payload. Field names and nullability follow SePay's documented
 * contract; see plans phase-05 for the traps each field carries.
 */
export type SepayWebhookPayload = {
  /** Stable across retries and dashboard replays — the dedupe key. */
  id: number;
  gateway: string;
  /** "YYYY-MM-DD HH:mm:ss" in Vietnam local time (UTC+7), no timezone suffix. */
  transactionDate: string;
  accountNumber: string;
  subAccount: string | null;
  /** null means no code matched; empty string can mean recognition is disabled. */
  code: string | null;
  /** Original transfer memo, unprocessed by SePay. */
  content: string;
  /** Always positive, even when transferType is "out". */
  transferType: 'in' | 'out';
  description: string;
  transferAmount: number;
  accumulated: number;
  /** Can be empty — unusable as a dedupe key. */
  referenceCode: string;
};

export type CreatedOrder = {
  id: number;
  code: string;
  /** Full price. */
  amount: number;
  /** Deducted from the wallet already. Zero when the wallet was empty. */
  walletPaid: number;
  /** Owed by transfer. Zero means fully settled from the wallet. */
  bankDue: number;
  /**
   * Null when bankDue is zero: there is nothing to transfer, so showing a QR
   * would invite a second payment for an order that is already settled.
   */
  qrUrl: string | null;
  expiresAt: number;
};
