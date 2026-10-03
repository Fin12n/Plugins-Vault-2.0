import type { Db } from '../db/connection.js';
import { now } from '../db/connection.js';
import { toOrder, type OrderRow } from '../db/row-mappers.js';
import type { Order, OrderStatus } from '../domain/order.js';
import { applyLedgerEntry } from './wallets.js';

export type CreateOrderInput = {
  code: string;
  discordUserId: string;
  versionId: number;
  pluginName: string;
  versionLabel: string;
  amount: number;
  /**
   * Already deducted from the wallet by the caller, inside the same transaction.
   * Omit for an order paid entirely by transfer.
   */
  walletPaid?: number;
  /**
   * Remainder owed by transfer. Defaults to the full amount, which is the
   * pre-wallet behaviour: nothing taken from a balance, everything still due.
   */
  bankDue?: number;
  ttlMinutes: number;
};

const SELECT = 'SELECT * FROM orders';

export function createOrder(db: Db, input: CreateOrderInput): Order {
  const created = now();
  const walletPaid = input.walletPaid ?? 0;
  const bankDue = input.bankDue ?? input.amount - walletPaid;

  const info = db
    .prepare(
      `INSERT INTO orders (code, discord_user_id, version_id, plugin_name, version_label,
                           amount, wallet_paid, bank_due, status, created_at, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      input.code,
      input.discordUserId,
      input.versionId,
      input.pluginName,
      input.versionLabel,
      input.amount,
      walletPaid,
      bankDue,
      // Nothing left to transfer means the order is already settled; leaving it
      // 'pending' would let the TTL sweep expire an order that was fully paid.
      // A zero-price order keeps 'pending' so the existing free-download path is
      // unchanged.
      bankDue === 0 && walletPaid > 0 ? 'wallet_paid' : 'pending',
      created,
      created + input.ttlMinutes * 60,
    );

  const order = findOrderById(db, Number(info.lastInsertRowid));
  if (!order) throw new Error('Không tạo được đơn');
  return order;
}

export function findOrderById(db: Db, id: number): Order | null {
  const row = db.prepare(`${SELECT} WHERE id = ?`).get(id) as OrderRow | undefined;
  return row ? toOrder(row) : null;
}

/**
 * Looks up an order by payment code.
 *
 * Codes are stored and compared uppercase because SePay uppercases whatever it
 * extracts; a mixed-case stored code would never match.
 */
export function findOrderByCode(db: Db, code: string): Order | null {
  const row = db.prepare(`${SELECT} WHERE code = ?`).get(code.toUpperCase()) as OrderRow | undefined;
  return row ? toOrder(row) : null;
}

export function markOrderPaid(db: Db, id: number, paidAmount?: number): void {
  db.prepare(
    "UPDATE orders SET status = 'paid', paid_at = ?, paid_amount = ? WHERE id = ? AND status = 'pending'",
  ).run(now(), paidAmount ?? null, id);
}

export function markOrderDelivered(db: Db, id: number): void {
  db.prepare("UPDATE orders SET status = 'delivered', delivered_at = ? WHERE id = ?").run(now(), id);
}

export function markOrderStatus(db: Db, id: number, status: OrderStatus): void {
  db.prepare('UPDATE orders SET status = ? WHERE id = ?').run(status, id);
}

/**
 * Orders where money was taken but the file was not handed over — the reconcile
 * view's source.
 *
 * Includes `underpaid`: a short transfer is still money taken, and leaving it out
 * is how it used to vanish. Includes `wallet_paid` for the same reason — coins
 * were deducted, and if delivery failed there is no webhook coming to retry it, so
 * this view is the only place such an order can ever be seen again.
 *
 * Ordered by paid_at, which is null for `wallet_paid` (no transfer ever arrived),
 * so created_at breaks the tie and the oldest unresolved order still surfaces
 * first.
 */
export function listUndeliveredPaidOrders(db: Db): Order[] {
  const rows = db
    .prepare(
      `${SELECT} WHERE status IN ('paid', 'dm_blocked', 'underpaid', 'wallet_paid')
        ORDER BY coalesce(paid_at, created_at) ASC`,
    )
    .all() as OrderRow[];
  return rows.map(toOrder);
}

/** Records a short transfer: money in, but below the deposit. */
export function markOrderUnderpaid(db: Db, id: number, paidAmount: number): void {
  db.prepare(
    "UPDATE orders SET status = 'underpaid', paid_amount = ?, paid_at = ? WHERE id = ? AND status = 'pending'",
  ).run(paidAmount, now(), id);
}

/**
 * Expires pending orders past their TTL, returning any coins held for them.
 *
 * Only `pending` rows are touched: a paid order must never become expired, since
 * money has already changed hands, and `wallet_paid` orders are already settled.
 *
 * Expiring and refunding are separate claims on purpose. The status flip claims
 * the expiry; `refundOrderWallet` claims the coins by zeroing `wallet_paid`. Both
 * paths refund through that single claim, so an order cannot be refunded once by
 * the sweep and again by a later manual release — which is exactly what two
 * different predicates would allow, invisibly, since the ledger would stay
 * internally consistent and the drift check would show nothing.
 */
export function expireStaleOrders(db: Db): { expired: number; refunded: number } {
  const sweep = db.transaction((): { expired: number; refunded: number } => {
    const due = db
      .prepare(`${SELECT} WHERE status = 'pending' AND expires_at <= ?`)
      .all(now()) as OrderRow[];

    let refunded = 0;
    let expired = 0;

    for (const row of due) {
      const changed = db
        .prepare("UPDATE orders SET status = 'expired' WHERE id = ? AND status = 'pending'")
        .run(row.id).changes;
      // Lost the race to another sweep; that sweep owns the refund.
      if (changed === 0) continue;
      expired++;

      if (refundOrderWallet(db, row.id, 'đơn hết hạn')) refunded++;
    }

    return { expired, refunded };
  });

  return sweep();
}

/**
 * Returns coins held for an order, exactly once.
 *
 * Zeroing `wallet_paid` IS the claim: whoever flips it from non-zero owns the
 * refund, and every later caller gets false. Both the expiry sweep and the
 * delivery-failure path go through here for that reason.
 *
 * Deliberately not called for `dm_blocked` — the download token stays valid
 * there and the owner can still release it from the reconcile view, so refunding
 * would give away the file.
 */
export function refundOrderWallet(db: Db, id: number, note: string): boolean {
  const refund = db.transaction((): boolean => {
    const row = db.prepare(`${SELECT} WHERE id = ?`).get(id) as OrderRow | undefined;
    if (!row || row.wallet_paid <= 0) return false;
    if (row.status === 'delivered') return false;

    const changed = db.prepare('UPDATE orders SET wallet_paid = 0 WHERE id = ? AND wallet_paid = ?').run(
      id,
      row.wallet_paid,
    ).changes;
    if (changed === 0) return false;

    applyLedgerEntry(db, {
      discordUserId: row.discord_user_id,
      delta: row.wallet_paid,
      kind: 'order_refund',
      refType: 'order',
      refId: id,
      note,
    });
    return true;
  });

  return refund();
}

/**
 * Records a SePay transaction, returning false when it has been seen before.
 *
 * `sepay_id` is the only field guaranteed present and stable across retries and
 * dashboard replays, both of which are routine rather than exceptional.
 * `referenceCode` can be empty so it cannot serve as the key. ON CONFLICT makes
 * the dedupe atomic at the database level, which matters because retries can
 * arrive concurrently.
 */
export function recordSepayTransaction(
  db: Db,
  input: {
    sepayId: number;
    orderId: number | null;
    amount: number;
    transferType: 'in' | 'out';
    code: string | null;
    content: string;
    description: string;
    rawPayload: string;
  },
): boolean {
  const row = db
    .prepare(
      `INSERT INTO sepay_transactions (sepay_id, order_id, amount, transfer_type, code,
                                       content, description, raw_payload, received_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (sepay_id) DO NOTHING
       RETURNING id`,
    )
    .get(
      input.sepayId,
      input.orderId,
      input.amount,
      input.transferType,
      input.code,
      input.content,
      input.description,
      input.rawPayload,
      now(),
    ) as { id: number } | undefined;

  return row !== undefined;
}

export function attachTransactionToOrder(db: Db, sepayId: number, orderId: number): void {
  db.prepare('UPDATE sepay_transactions SET order_id = ? WHERE sepay_id = ?').run(orderId, sepayId);
}
