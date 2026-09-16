/**
 * Manual resolution of cards the poll could not settle.
 *
 * Separate from submit-card-topup because these are owner actions rather than
 * provider-driven ones, but they must reuse the same credit claim: the whole point
 * is that releasing a card by hand cannot double-pay one the poll settled a moment
 * earlier.
 */
import type { Db } from '../../db/connection.js';
import { claimCardCredit, findCardTopupById, scrubCardCode } from '../../repositories/card-topups.js';
import { applyLedgerEntry } from '../../repositories/wallets.js';

/**
 * Credits a reviewed card, at an amount the owner supplies.
 *
 * An amount is needed because the reason the card is here at all is that card2k
 * never told us its real value. Returns false when the credit was already claimed.
 */
export function creditReviewedCard(db: Db, id: number, amount: number): boolean {
  const credited = db.transaction((): boolean => {
    const card = findCardTopupById(db, id);
    if (!card) return false;
    if (!claimCardCredit(db, id)) return false;

    applyLedgerEntry(db, {
      discordUserId: card.discordUserId,
      delta: amount,
      kind: 'card_topup',
      refType: 'card',
      refId: id,
      note: 'chủ kho xử lý tay',
    });
    // Mirrors the automatic path so the dashboard shows a settled state rather
    // than leaving the row looking unresolved forever.
    //
    // net_amount defaults to the credited amount when the provider never reported
    // one. It feeds the monthly fee figure, which sums credited minus received —
    // leaving it NULL would report this card as 100% fee and overstate the owner's
    // cost by its whole face value. Equal values claim no fee, which is the honest
    // answer when the payout is genuinely unknown.
    db.prepare(
      `UPDATE card_topups
          SET status = 'success', actual_value = ?, net_amount = coalesce(net_amount, ?)
        WHERE id = ?`,
    ).run(amount, amount, id);
    return true;
  })();

  if (credited) scrubCardCode(db, id);
  return credited;
}

/**
 * Closes a reviewed card without paying out.
 *
 * The PIN is deliberately kept: the owner decided not to credit, which usually
 * means the card was never consumed, and the person will want it back to try
 * elsewhere.
 */
export function markCardResolvedWithoutCredit(db: Db, id: number): void {
  db.prepare(
    `UPDATE card_topups SET status = 'failed', provider_message = 'chủ kho xác nhận không cộng'
      WHERE id = ? AND status IN ('timeout', 'needs_review')`,
  ).run(id);
}
