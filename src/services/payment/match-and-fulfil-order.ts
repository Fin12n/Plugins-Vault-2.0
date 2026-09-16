import type { Db } from '../../db/connection.js';
import type { CreatedOrder, Order, SepayWebhookPayload } from '../../domain/order.js';
import {
  attachTransactionToOrder,
  createOrder,
  findOrderByCode,
  findOrderById,
  markOrderDelivered,
  markOrderPaid,
  markOrderStatus,
  markOrderUnderpaid,
  recordSepayTransaction,
  refundOrderWallet,
} from '../../repositories/orders.js';
import { applyLedgerEntry, getBalance } from '../../repositories/wallets.js';
import { findTopupByCode, markTopupCredited } from '../../repositories/wallet-topups.js';
import { findVersionWithPlugin } from '../../repositories/versions.js';
import type { DeliveryDeps } from '../delivery/deliver-version.js';
import { deliverVersion } from '../delivery/deliver-version.js';
import { buildVietQrUrl, generatePaymentCode } from './build-vietqr-url.js';
import { isCodeAvailable } from './open-wallet-topup.js';

export type OrderConfig = {
  accountNumber: string;
  bankCode: string;
  codePrefix: string;
  codeSuffixLength: number;
  ttlMinutes: number;
};

/**
 * Thrown to abort the order transaction when the balance moved underneath it.
 *
 * A throw, not a returned null: better-sqlite3 rolls a transaction back only on an
 * exception. Returning a sentinel COMMITS whatever the callback already wrote,
 * which here would leave an order recording wallet_paid against coins that were
 * never actually deducted — a free plugin.
 */
class BalanceMovedError extends Error {}

/**
 * Opens an order, spending whatever coins the buyer has before asking for a
 * transfer, and returns what the bot needs to show next.
 *
 * Coins are DEDUCTED here rather than merely recorded as intended. Recording an
 * intention would let two orders opened moments apart both plan to spend the
 * same balance, and the second would find it gone at delivery time. Deducting up
 * front makes the balance the thing that runs out, which is what the expiry
 * refund then gives back.
 *
 * The deduction and the insert share one transaction: a crash between them would
 * otherwise take coins with no order to show for it.
 *
 * The unique constraint on `code` is the collision guard; a retry loop covers the
 * astronomically unlikely case rather than trusting randomness blindly.
 */
export function openOrder(
  db: Db,
  config: OrderConfig,
  input: { discordUserId: string; versionId: number },
): CreatedOrder | null {
  const version = findVersionWithPlugin(db, input.versionId);
  if (!version) return null;

  for (let attempt = 0; attempt < 5; attempt++) {
    const code = generatePaymentCode(config.codePrefix, config.codeSuffixLength);
    // Checked against wallet top-ups too: both share this code space, and a
    // collision would route a plugin payment into a wallet or the reverse.
    if (!isCodeAvailable(db, code)) continue;

    const price = version.depositPrice;

    let opened: Order;
    try {
      opened = db.transaction((): Order => {
        // Read inside the transaction: a balance read outside it could be stale by
        // the time the deduction runs.
        const balance = getBalance(db, input.discordUserId);
        const walletPaid = Math.min(balance, price);
        const bankDue = price - walletPaid;

        const order = createOrder(db, {
          code,
          discordUserId: input.discordUserId,
          versionId: version.id,
          // Denormalized so the order stays readable after a prune removes the version.
          pluginName: version.pluginDisplayName,
          versionLabel: version.version ?? '',
          amount: price,
          walletPaid,
          bankDue,
          ttlMinutes: config.ttlMinutes,
        });

        if (walletPaid > 0) {
          // Written after the insert so the ledger row can name the order it paid
          // for, which is what makes a refund traceable back to its cause.
          const remaining = applyLedgerEntry(db, {
            discordUserId: input.discordUserId,
            delta: -walletPaid,
            kind: 'order_hold',
            refType: 'order',
            refId: order.id,
            note: 'giữ coin cho đơn',
          });
          // Refused only if the balance moved between the read and the write.
          // Throwing discards the insert as well, so no order can survive claiming
          // coins that were never taken.
          if (remaining === null) throw new BalanceMovedError();
        }

        return order;
      })();
    } catch (err) {
      if (err instanceof BalanceMovedError) return null;
      throw err;
    }

    return {
      id: opened.id,
      code: opened.code,
      amount: opened.amount,
      walletPaid: opened.walletPaid,
      bankDue: opened.bankDue,
      // No QR when nothing is owed: showing one would invite a transfer for an
      // order that is already settled.
      qrUrl:
        opened.bankDue > 0
          ? buildVietQrUrl({
              accountNumber: config.accountNumber,
              bankCode: config.bankCode,
              // What is still owed, NOT the full price.
              amount: opened.bankDue,
              code: opened.code,
            })
          : null,
      expiresAt: opened.expiresAt,
    };
  }
  return null;
}

export type WebhookOutcome =
  | { handled: 'duplicate' }
  | { handled: 'ignored'; why: 'outgoing' | 'no-code' | 'no-order' | 'underpaid' | 'not-pending' }
  | { handled: 'paid'; orderId: number }
  | { handled: 'topup'; topupId: number; discordUserId: string; credited: number };

/**
 * Applies an incoming transfer to a pending order.
 *
 * Runs synchronously and fast: SePay treats a response as failed unless it
 * arrives within 30 seconds, so delivery is dispatched by the caller only after
 * the acknowledgement has been sent.
 */
export function applySepayTransfer(db: Db, payload: SepayWebhookPayload): WebhookOutcome {
  // Dedupe first, and at the database level. Retries and dashboard replays are
  // both routine, and two retries can arrive concurrently.
  const isNew = recordSepayTransaction(db, {
    sepayId: payload.id,
    orderId: null,
    amount: payload.transferAmount,
    transferType: payload.transferType,
    code: payload.code,
    content: payload.content,
    description: payload.description,
    rawPayload: JSON.stringify(payload),
  });
  if (!isNew) return { handled: 'duplicate' };

  // transferAmount is positive even for outgoing transfers, so without this guard
  // money leaving the account would credit orders.
  if (payload.transferType !== 'in') return { handled: 'ignored', why: 'outgoing' };

  // null and empty are semantically distinct: null means nothing matched, empty
  // can mean code recognition is switched off in the SePay dashboard. A truthiness
  // check would hide that misconfiguration.
  if (payload.code === null || payload.code.trim() === '') return { handled: 'ignored', why: 'no-code' };

  const order = findOrderByCode(db, payload.code);
  // Orders are looked up first, and the order matters: a plugin order must never
  // be mistaken for a top-up, since only one of the two delivers a file. The code
  // spaces do not overlap (openOrder and openWalletTopup both check both tables),
  // so this is a precedence rule rather than a tiebreak.
  if (!order) return applyTopupTransfer(db, payload);

  attachTransactionToOrder(db, payload.id, order.id);

  if (order.status !== 'pending') {
    // A settled order receiving a transfer means the buyer paid for something
    // that needed no payment — most often a 'wallet_paid' order whose QR they had
    // open from an earlier attempt. Delivering again is wrong, and keeping the
    // money silently is worse, so it lands in their wallet.
    if (order.status === 'wallet_paid' || order.status === 'delivered') {
      applyLedgerEntry(db, {
        discordUserId: order.discordUserId,
        delta: payload.transferAmount,
        kind: 'overpay',
        refType: 'order',
        refId: order.id,
        note: 'chuyển khoản cho đơn đã thanh toán',
      });
    }
    return { handled: 'ignored', why: 'not-pending' };
  }

  // Underpayment is money taken, so it gets its own terminal-ish status rather
  // than staying 'pending': pending rows are swept to 'expired' by the TTL job,
  // which would erase the only sign a short transfer ever arrived. 'underpaid'
  // is excluded from that sweep and shows up in reconcile for the owner to
  // release or refund.
  //
  // Compared against bankDue, not amount: when coins covered part of the price,
  // the full price was never owed by transfer.
  if (payload.transferAmount < order.bankDue) {
    markOrderUnderpaid(db, order.id, payload.transferAmount);
    return { handled: 'ignored', why: 'underpaid' };
  }

  markOrderPaid(db, order.id, payload.transferAmount);

  // Surplus is kept rather than dropped. Someone who rounds 30.000 up to 50.000
  // has still handed over 50.000, and the difference belongs to them.
  const surplus = payload.transferAmount - order.bankDue;
  if (surplus > 0) {
    applyLedgerEntry(db, {
      discordUserId: order.discordUserId,
      delta: surplus,
      kind: 'overpay',
      refType: 'order',
      refId: order.id,
      note: 'chuyển khoản thừa',
    });
  }

  return { handled: 'paid', orderId: order.id };
}

/**
 * Credits a transfer that matched a wallet top-up rather than a plugin order.
 *
 * Credits what ARRIVED, not what was requested: a top-up sells nothing, so there
 * is no shortfall to withhold against. Sending 30.000 against a 50.000 request
 * credits 30.000, and sending 70.000 credits 70.000.
 *
 * The status flip and the ledger write share one transaction, and the flip only
 * succeeds from 'pending' — together that is the exactly-once guard. The
 * sepay_transactions dedupe upstream already stops a replayed webhook; this is the
 * second layer, because the cost of crediting twice is real money.
 */
function applyTopupTransfer(db: Db, payload: SepayWebhookPayload): WebhookOutcome {
  const topup = findTopupByCode(db, payload.code ?? '');
  if (!topup) return { handled: 'ignored', why: 'no-order' };

  const credited = db.transaction((): boolean => {
    if (!markTopupCredited(db, topup.id, payload.transferAmount)) return false;
    applyLedgerEntry(db, {
      discordUserId: topup.discordUserId,
      delta: payload.transferAmount,
      kind: 'bank_topup',
      refType: 'topup',
      refId: topup.id,
      note: 'nạp ví qua chuyển khoản',
    });
    return true;
  })();

  if (!credited) return { handled: 'ignored', why: 'not-pending' };

  return {
    handled: 'topup',
    topupId: topup.id,
    discordUserId: topup.discordUserId,
    credited: payload.transferAmount,
  };
}

/**
 * Delivers a paid order. Idempotent on status, because a payment provider retry
 * or a manual release must not deliver twice.
 */
export async function fulfilOrder(
  deps: { db: Db; delivery: DeliveryDeps },
  orderId: number,
  options: { manual?: boolean } = {},
): Promise<{ ok: boolean; reason?: string }> {
  const order = findOrderById(deps.db, orderId);
  if (!order) return { ok: false, reason: 'not-found' };
  if (order.status === 'delivered') return { ok: true };
  if (order.versionId === null) return { ok: false, reason: 'version-gone' };
  // Nothing was ever paid for these: 'expired' means the TTL passed with no
  // transfer (and any coins already went back), 'pending' means the transfer has
  // not arrived. Releasing either hands over the file for free, and the route is
  // reachable with any id, not only the ones the reconcile view lists.
  if (order.status === 'expired' || order.status === 'pending') {
    return { ok: false, reason: 'not-paid' };
  }

  const outcome = await deliverVersion(deps.delivery, {
    discordUserId: order.discordUserId,
    versionId: order.versionId,
    orderId: order.id,
    // What was actually paid, not what was asked. The fund report sums audit
    // amounts, so an underpaid release billed at full price would overstate it.
    // Coins count too — they were bought with real money earlier — but the
    // transfer is capped at what was owed, because any surplus was already
    // credited back to the wallet and would otherwise be counted twice.
    amount: order.walletPaid + Math.min(order.paidAmount ?? order.bankDue, order.bankDue),
    manual: options.manual,
  });

  if (outcome.ok) {
    markOrderDelivered(deps.db, order.id);
    return { ok: true };
  }

  // No refund on failure, deliberately. The order stays releasable from the
  // reconcile view — a missing blob or a Discord outage is usually temporary —
  // and refunding while it remains releasable would hand back the coins AND then
  // the file. The owner returns the coins explicitly with refundOrderWallet when
  // they decide the order is dead.
  if (outcome.reason === 'dm_blocked') {
    markOrderStatus(deps.db, order.id, 'dm_blocked');
    return { ok: false, reason: 'dm_blocked' };
  }
  return { ok: false, reason: outcome.message };
}
