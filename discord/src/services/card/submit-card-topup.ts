/**
 * Submitting a scratch card, and resolving it by polling.
 *
 * Two rules decided by the owner shape everything here:
 *
 * 1. The card2k fee is absorbed. Someone topping up with a 50.000 ₫ card gets
 *    50.000 ₫ of coins even though card2k pays out less. So the wallet is credited
 *    on the card's REAL VALUE (`actual_value`), never on the net (`net_amount`) —
 *    but the net is recorded, because the gap is the owner's running cost.
 *
 * 2. A wrong declared denomination still credits, at the card's real value. The
 *    card is consumed by card2k either way, so refusing would take the money and
 *    give nothing back.
 */
import { randomUUID } from 'node:crypto';
import type { Db } from '../../db/connection.js';
import { now } from '../../db/connection.js';
import type { CardTopup } from '../../domain/card-topup.js';
import {
  claimCardCredit,
  createCardTopup,
  findCardTopupById,
  hasPendingSerial,
  listDuePolls,
  recordPollAttempt,
  scrubCardCode,
  settleCardTopup,
} from '../../repositories/card-topups.js';
import { applyLedgerEntry } from '../../repositories/wallets.js';
import { getNeonDb } from '../../db/neon.js';
import { applyLedgerEntry as applyLedgerEntryNeon } from '../../repositories/neon-wallets.js';
import {
  Card2kError,
  checkCard,
  isCard2kConfigured,
  submitCard,
  type Card2kConfig,
  type CardResult,
} from './card2k-client.js';
import { isTelco, isValidDenomination, type Telco } from './card2k-telcos.js';

/** Matches card2k's own client: 60s apart, 30 tries, so a 30-minute ceiling. */
export const POLL_INTERVAL_SECONDS = 60;
export const MAX_POLL_ATTEMPTS = 30;

export type SubmitRejection =
  | 'not-configured'
  | 'bad-telco'
  | 'bad-amount'
  | 'bad-serial'
  | 'bad-code'
  | 'duplicate';

export type SubmitResult =
  | { ok: true; topup: CardTopup }
  | { ok: false; why: SubmitRejection };

/** Serial and PIN are digits and letters only; anything else is a typo. */
const SERIAL_PATTERN = /^[A-Za-z0-9]{6,32}$/;

/**
 * Submits a card and returns its recorded state.
 *
 * Validates locally first so a malformed request never reaches card2k: a rejected
 * submission may still consume the card, which makes client-side validation a
 * money-saving measure rather than a politeness.
 *
 * A network failure does NOT settle the card. card2k may well have received it,
 * so the row stays 'pending' and the poll decides — writing it off here is how a
 * paid-for card silently disappears.
 */
export async function submitCardTopup(
  db: Db,
  config: Card2kConfig,
  input: { discordUserId: string; telco: string; serial: string; code: string; declaredValue: number },
): Promise<SubmitResult> {
  if (!isCard2kConfigured(config)) return { ok: false, why: 'not-configured' };
  if (!isTelco(input.telco)) return { ok: false, why: 'bad-telco' };

  const telco: Telco = input.telco;
  const serial = input.serial.trim();
  const code = input.code.trim();

  if (!isValidDenomination(telco, input.declaredValue)) return { ok: false, why: 'bad-amount' };
  if (!SERIAL_PATTERN.test(serial)) return { ok: false, why: 'bad-serial' };
  if (!SERIAL_PATTERN.test(code)) return { ok: false, why: 'bad-code' };
  if (hasPendingSerial(db, telco, serial)) return { ok: false, why: 'duplicate' };

  const requestId = randomUUID();

  // Recorded before the call, so a crash mid-submission leaves evidence rather
  // than an eaten card.
  const topup = createCardTopup(db, {
    requestId,
    discordUserId: input.discordUserId,
    telco,
    serial,
    code,
    declaredValue: input.declaredValue,
    firstPollAt: now() + POLL_INTERVAL_SECONDS,
  });

  let result: CardResult;
  try {
    result = await submitCard(config, {
      telco,
      serial,
      code,
      amount: input.declaredValue,
      requestId,
    });
  } catch (err) {
    if (err instanceof Card2kError && err.notSubmitted) {
      // Certainly never sent — safe to settle now and stop polling for something
      // that does not exist on card2k's side.
      settleCardTopup(db, topup.id, {
        status: 'needs_review',
        providerMessage: err.message,
      });
      return { ok: true, topup: findCardTopupById(db, topup.id) ?? topup };
    }
    // Might have arrived. Leave it pending and let the poll find out.
    recordPollAttempt(db, topup.id, {
      nextPollAt: now() + POLL_INTERVAL_SECONDS,
      providerMessage: err instanceof Error ? err.message : String(err),
    });
    return { ok: true, topup: findCardTopupById(db, topup.id) ?? topup };
  }

  applyResult(db, topup.id, result);
  return { ok: true, topup: findCardTopupById(db, topup.id) ?? topup };
}

export type PollSummary = { checked: number; settled: number; credited: number };

/**
 * One sweep over cards awaiting an answer.
 *
 * Serial rather than parallel: the sweep is bounded by MAX_POLL_ATTEMPTS per card,
 * and hammering a payment provider concurrently is the behaviour most likely to
 * look abusive.
 */
export async function pollPendingCards(db: Db, config: Card2kConfig): Promise<PollSummary> {
  const summary: PollSummary = { checked: 0, settled: 0, credited: 0 };
  if (!isCard2kConfigured(config)) return summary;

  for (const topup of listDuePolls(db)) {
    summary.checked++;

    // Attempts are counted whether or not the check succeeds, so a provider that
    // is down cannot keep a card pending forever.
    if (topup.attempts >= MAX_POLL_ATTEMPTS) {
      // NOT 'failed': the ceiling means we never learned the outcome, and the card
      // may have been consumed. A human decides.
      if (settleCardTopup(db, topup.id, { status: 'timeout', providerMessage: 'hết số lần kiểm tra' })) {
        summary.settled++;
      }
      continue;
    }

    let result: CardResult;
    try {
      result = await checkCard(config, {
        requestId: topup.requestId,
        serial: topup.serial,
        code: topup.code,
        telco: topup.telco as Telco,
        amount: topup.declaredValue,
      });
    } catch (err) {
      recordPollAttempt(db, topup.id, {
        nextPollAt: now() + POLL_INTERVAL_SECONDS,
        providerMessage: err instanceof Error ? err.message : String(err),
      });
      continue;
    }

    const applied = applyResult(db, topup.id, result);
    if (applied.settled) summary.settled++;
    if (applied.credited) summary.credited++;
  }

  return summary;
}

/**
 * Applies one provider answer: settles the row and credits if it earned a credit.
 *
 * The claim and the ledger write share a transaction, and the claim only succeeds
 * once. That is the exactly-once guard — not any check in this function, which two
 * overlapping sweeps would both pass.
 */
export function applyResult(db: Db, id: number, result: CardResult): { settled: boolean; credited: boolean } {
  if (result.outcome === 'pending') {
    recordPollAttempt(db, id, {
      nextPollAt: now() + POLL_INTERVAL_SECONDS,
      providerStatus: result.providerStatus,
      providerMessage: result.providerMessage,
    });
    return { settled: false, credited: false };
  }

  // 'unknown' becomes 'needs_review': the provider said something outside the
  // documented table, so the card may have been consumed while we cannot tell.
  // Collapsing it into 'failed' would write off a card that might have been paid.
  //
  // A creditable outcome with no usable real value goes the same way. card2k
  // consumed the card and paid out, so it cannot be dropped — but the amount to
  // credit is unknown, and falling back to the declared value would be wrong
  // precisely for a wrong-denomination card, which is the case where they differ.
  // 'success' with credited_at NULL would be worse than either: not pending so no
  // poll retries it, not in the review list so the owner never sees it, and the
  // resolve route refuses it — money taken with no route to fix it.
  const earnsCredit = result.outcome === 'success' || result.outcome === 'wrong_amount';
  const hasValue = result.actualValue !== null && result.actualValue > 0;
  const status =
    result.outcome === 'unknown' || (earnsCredit && !hasValue) ? 'needs_review' : result.outcome;

  const settled = settleCardTopup(db, id, {
    status,
    actualValue: result.actualValue,
    netAmount: result.netAmount,
    providerStatus: result.providerStatus,
    providerMessage: result.providerMessage,
    transId: result.transId,
  });
  // Lost the race to a concurrent sweep, which owns the credit.
  if (!settled) return { settled: false, credited: false };

  if (!earnsCredit || !hasValue) return { settled: true, credited: false };

  const topup = findCardTopupById(db, id);
  if (!topup) return { settled: true, credited: false };

  // Credit on the card's real value, not the net: the fee is the owner's to bear.
  const creditable = result.actualValue as number;

  const credited = db.transaction((): boolean => {
    if (!claimCardCredit(db, id)) return false;
    applyLedgerEntry(db, {
      discordUserId: topup.discordUserId,
      delta: creditable,
      kind: 'card_topup',
      refType: 'card',
      refId: id,
      note: result.outcome === 'wrong_amount' ? 'nạp thẻ sai mệnh giá' : 'nạp thẻ cào',
    });
    return true;
  })();

  if (credited) {
    scrubCardCode(db, id);

    // Đồng bộ số dư sang Neon PostgreSQL Authority
    try {
      const neonDb = getNeonDb();
      if (neonDb) {
        void applyLedgerEntryNeon(neonDb, {
          discordUserId: topup.discordUserId,
          delta: creditable,
          kind: 'card_credit',
          refType: 'card',
          refId: id,
          note: result.outcome === 'wrong_amount' ? 'nạp thẻ sai mệnh giá' : 'nạp thẻ cào',
        }).catch((err) => {
          console.error('Lỗi khi ghi sổ cái Neon cho thẻ cào:', err);
        });
      }
    } catch {
      // Ignored if Neon is not configured in current unit test
    }
  }

  return { settled: true, credited };
}
