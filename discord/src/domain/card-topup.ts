/**
 * Card top-up state.
 *
 * pending: submitted (or submission outcome unknown), being polled
 * success: card accepted, declared denomination was right
 * wrong_amount: card accepted but the declared denomination was wrong — still a
 *   credit, at the card's real value, because card2k consumed the card either way
 * failed: card2k said the card is invalid or already used; nothing was taken
 * timeout: polled to the ceiling without an answer. NOT a failure — the card may
 *   have been consumed, so it waits for a human
 * needs_review: card2k returned a status outside the known table. Also not a
 *   failure, for the same reason
 *
 * Mirrored by a CHECK constraint on card_topups.status.
 */
export const CARD_TOPUP_STATUSES = [
  'pending',
  'success',
  'wrong_amount',
  'failed',
  'timeout',
  'needs_review',
] as const;
export type CardTopupStatus = (typeof CARD_TOPUP_STATUSES)[number];

/** Statuses that will never change again without human action. */
export const CARD_TERMINAL_STATUSES: readonly CardTopupStatus[] = [
  'success',
  'wrong_amount',
  'failed',
  'timeout',
  'needs_review',
];

/** Statuses where the outcome is unresolved and the owner must decide. */
export const CARD_REVIEW_STATUSES: readonly CardTopupStatus[] = ['timeout', 'needs_review'];

export type CardTopup = {
  id: number;
  requestId: string;
  discordUserId: string;
  telco: string;
  serial: string;
  /** Cleared once terminal. Empty string means it has been scrubbed. */
  code: string;
  declaredValue: number;
  /** The card's real value. Null until card2k says. */
  actualValue: number | null;
  /** Net paid by card2k after their fee. For reconciliation, not for crediting. */
  netAmount: number | null;
  status: CardTopupStatus;
  providerStatus: number | null;
  providerMessage: string;
  transId: string | null;
  attempts: number;
  nextPollAt: number | null;
  creditedAt: number | null;
  createdAt: number;
};
