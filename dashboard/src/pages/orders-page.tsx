import { useState } from 'react';
import { useToast } from '../components/toast.js';
import { EmptyState, ErrorState, RefreshButton, TableSkeleton, TimeAgo } from '../components/ui.js';
import { formatVnd, vi } from '../i18n/vi.js';
import { api, ApiError, type OrderView } from '../lib/api-client.js';
import { useAsync } from '../lib/use-async.js';

/** Đơn kèm thông tin liên kết tải đã được dùng hay chưa. */
type UndeliveredOrder = OrderView & { linkUsedAt: number | null };

/**
 * Reconcile view: orders where money arrived but the file did not.
 *
 * This is the recovery path for a missed webhook or a blocked DM. SePay exposes no
 * transaction-query API, so an order stuck in `paid` cannot be resolved
 * automatically — the owner releases it by hand from here.
 */
export function OrdersPage() {
  const orders = useAsync<{ items: UndeliveredOrder[] }>('/api/orders/undelivered');

  return (
    <>
      <div className="content-head">
        <h2>{vi.orders.heading}</h2>
        <div className="button-row">
          {orders.data && orders.data.items.length > 0 && (
            <span className="badge warn">{vi.orders.pendingBadge(orders.data.items.length)}</span>
          )}
          <RefreshButton onClick={() => void orders.reload()} busy={orders.refreshing} />
        </div>
      </div>
      <p className="hint" style={{ marginBottom: 16 }}>
        {vi.orders.explain}
      </p>

      {orders.error && <ErrorState message={orders.error} onRetry={() => void orders.reload()} />}
      {orders.loading && <TableSkeleton rows={3} cols={6} />}
      {orders.data?.items.length === 0 && !orders.error && (
        <EmptyState title={vi.orders.empty} hint={vi.orders.emptyHint} />
      )}

      {orders.data && orders.data.items.length > 0 && (
        <div className={`panel flush${orders.refreshing ? ' refreshing' : ''}`}>
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>{vi.orders.code}</th>
                  <th>{vi.orders.user}</th>
                  <th>{vi.orders.plugin}</th>
                  <th>{vi.orders.version}</th>
                  <th className="right">{vi.orders.amount}</th>
                  <th className="right">{vi.orders.held}</th>
                  <th>{vi.orders.paidAt}</th>
                  <th>{vi.orders.status}</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {orders.data.items.map((order) => (
                  <OrderRow key={order.id} order={order} onDone={() => void orders.reload()} />
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </>
  );
}

function OrderRow({ order, onDone }: { order: UndeliveredOrder; onDone: () => void }) {
  const toast = useToast();
  const [busy, setBusy] = useState<'release' | 'refund' | null>(null);

  const release = async (): Promise<void> => {
    setBusy('release');
    try {
      await api.post(`/api/orders/${order.id}/release`);
      toast.success(vi.orders.toastDelivered(order.pluginName, order.discordUserId));
      onDone();
    } catch (err) {
      // 503 means the bot has no Discord connection; 409 carries a reason from
      // fulfilOrder, which is a known key often enough to be worth translating.
      // An unmapped message is a raw Discord error and stays in English, so it
      // gets a Vietnamese prefix rather than being dropped — the detail matters
      // most precisely when something unexpected broke.
      if (err instanceof ApiError && err.status === 503) toast.error(vi.orders.botOffline);
      else if (err instanceof ApiError) toast.error(vi.orders.reasons[err.message] ?? vi.orders.unknownReason(err.message));
      else toast.error(err instanceof Error ? err.message : vi.common.error);
    } finally {
      // Not only in catch: a release can succeed while the reload that follows
      // fails, which leaves this row mounted with the button stuck disabled.
      setBusy(null);
    }
  };

  const refundWallet = async (): Promise<void> => {
    // Hỏi lại và nói rõ hệ quả. Đơn dm_blocked là ca nguy hiểm: liên kết tải của nó
    // còn hiệu lực, nên nếu khách đã tải thì hoàn coin là mất trắng.
    const warning =
      order.linkUsedAt !== null
        ? vi.orders.confirmRefundWarningDownloaded
        : vi.orders.confirmRefundWarningRevoke;
    if (!confirm(vi.orders.confirmRefund(formatVnd(order.walletPaid), order.discordUserId, warning))) return;

    setBusy('refund');
    try {
      const result = await api.post<{ refunded: number; revokedLinks: number }>(
        `/api/orders/${order.id}/refund-wallet`,
      );
      toast.success(vi.orders.toastRefunded(formatVnd(result.refunded), result.revokedLinks));
      onDone();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : vi.common.error);
    } finally {
      setBusy(null);
    }
  };

  return (
    <tr>
      <td className="nowrap mono">{order.code}</td>
      <td className="nowrap mono">{order.discordUserId}</td>
      <td>{order.pluginName}</td>
      <td>{order.versionLabel || <span className="muted">—</span>}</td>
      <td className="right nowrap">
        {order.status === 'underpaid' && order.paidAmount !== null ? (
          // Both figures, so the owner sees the shortfall without opening the DB.
          <span className="badge danger">{vi.orders.shortfall(formatVnd(order.paidAmount), formatVnd(order.amount))}</span>
        ) : (
          formatVnd(order.paidAmount ?? order.amount)
        )}
      </td>
      <td className="right nowrap">
        {order.walletPaid > 0 ? formatVnd(order.walletPaid) : <span className="muted">—</span>}
      </td>
      <td className="muted nowrap">
        <TimeAgo unixSeconds={order.paidAt} />
      </td>
      <td className="nowrap">
        <span className={order.status === 'paid' ? 'badge warn' : 'badge danger'}>
          {vi.orders.statuses[order.status] ?? order.status}
        </span>
        {/* Trạng thái liên kết là thông tin quyết định giữa "giao lại" và "hoàn coin". */}
        {order.linkUsedAt !== null ? (
          <div className="hint">
            {vi.orders.linkDownloaded} <TimeAgo unixSeconds={order.linkUsedAt} />
          </div>
        ) : (
          order.status === 'dm_blocked' && <div className="hint">{vi.orders.linkStillActive}</div>
        )}
      </td>
      <td className="right nowrap">
        <div className="button-row" style={{ justifyContent: 'flex-end' }}>
          <button
            className="primary small"
            disabled={busy !== null}
            aria-busy={busy === 'release'}
            onClick={() => void release()}
          >
            {vi.orders.release}
          </button>
          {/* Only when coins are actually held. Returning them closes the order, so
              this is the "give up on this one" action rather than a retry. */}
          {order.walletPaid > 0 && (
            <button
              className="small danger"
              disabled={busy !== null}
              aria-busy={busy === 'refund'}
              onClick={() => void refundWallet()}
            >
              {vi.orders.refundWallet}
            </button>
          )}
        </div>
      </td>
    </tr>
  );
}
