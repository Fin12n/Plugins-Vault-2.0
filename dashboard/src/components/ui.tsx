import type { ReactNode } from 'react';
import { AlertCircle, Inbox, RefreshCw } from 'lucide-react';
import { useI18n } from '../i18n/context.js';

/** Khung xương bảng: giữ đúng chiều cao để giao diện không nhảy khi dữ liệu về. */
export function TableSkeleton({ rows = 5, cols = 4 }: { rows?: number; cols?: number }) {
  const { lang } = useI18n();
  return (
    <div className="panel" aria-busy="true" aria-label={lang === 'vi' ? 'Đang tải dữ liệu' : 'Loading data'}>
      <table className="skeleton-table">
        <tbody>
          {Array.from({ length: rows }, (_, row) => (
            <tr key={row}>
              {Array.from({ length: cols }, (_, col) => (
                <td key={col}>
                  <span className="skeleton-bar" style={{ width: col === 0 ? '70%' : '45%' }} />
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** Trạng thái rỗng có hành động đi kèm. */
export function EmptyState({
  title,
  hint,
  action,
}: {
  title: string;
  hint?: string;
  action?: ReactNode;
}) {
  return (
    <div className="empty-state panel">
      <div style={{ display: 'flex', justifyContent: 'center', marginBottom: 12 }}>
        <Inbox size={40} className="muted" />
      </div>
      <p className="empty-title">{title}</p>
      {hint && <p className="hint">{hint}</p>}
      {action && <div className="empty-action">{action}</div>}
    </div>
  );
}

/** Lỗi tải dữ liệu, kèm nút thử lại */
export function ErrorState({ message, onRetry }: { message: string; onRetry?: () => void }) {
  const { lang } = useI18n();
  return (
    <div className="panel error-state" role="alert">
      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <AlertCircle size={20} color="var(--danger)" />
        <p className="error" style={{ margin: 0, fontWeight: 600 }}>
          {message}
        </p>
      </div>
      {onRetry && (
        <button type="button" onClick={onRetry} style={{ marginTop: 12 }}>
          <RefreshCw size={14} />
          <span>{lang === 'vi' ? 'Thử lại' : 'Retry'}</span>
        </button>
      )}
    </div>
  );
}

/** Đèn trạng thái */
export function StatusDot({ tone, label }: { tone: 'ok' | 'warn' | 'danger' | 'idle'; label: string }) {
  return (
    <span className={`status status-${tone}`}>
      <span className="status-dot" aria-hidden="true" />
      {label}
    </span>
  );
}

/** Nhãn nhỏ trên một con số lớn, dùng cho hàng thống kê */
export function Stat({ label, value, tone }: { label: string; value: ReactNode; tone?: 'ok' | 'warn' | 'danger' }) {
  return (
    <div className="stat">
      <span className="muted">{label}</span>
      <div className={`value${tone ? ` value-${tone}` : ''}`}>{value}</div>
    </div>
  );
}

/** Nút đọc lại dữ liệu với Lucide RefreshCw icon */
export function RefreshButton({ onClick, busy }: { onClick: () => void; busy?: boolean }) {
  const { lang } = useI18n();
  return (
    <button
      type="button"
      className="ghost small"
      onClick={onClick}
      disabled={busy}
      aria-busy={busy}
      title={lang === 'vi' ? 'Đọc lại dữ liệu' : 'Reload data'}
    >
      <RefreshCw size={14} className={busy ? 'animate-spin' : ''} />
      <span>{lang === 'vi' ? 'Làm mới' : 'Refresh'}</span>
    </button>
  );
}

/** Thời điểm ở dạng người đọc được */
export function TimeAgo({ unixSeconds }: { unixSeconds: number | null }) {
  const { lang } = useI18n();
  if (unixSeconds === null) return <span className="muted">—</span>;
  const locale = lang === 'vi' ? 'vi-VN' : 'en-US';
  const absolute = new Date(unixSeconds * 1000).toLocaleString(locale, { dateStyle: 'medium', timeStyle: 'short' });
  return (
    <time dateTime={new Date(unixSeconds * 1000).toISOString()} title={absolute} className="nowrap">
      {relativeTime(unixSeconds, Date.now(), lang)}
    </time>
  );
}

export function relativeTime(unixSeconds: number, now = Date.now(), lang = 'vi'): string {
  const seconds = Math.round(now / 1000 - unixSeconds);
  const future = seconds < 0;
  const abs = Math.abs(seconds);

  if (lang === 'en') {
    const say = (value: number, unit: string): string =>
      future ? `in ${value} ${unit}${value > 1 ? 's' : ''}` : `${value} ${unit}${value > 1 ? 's' : ''} ago`;

    if (abs < 45) return future ? 'soon' : 'just now';
    if (abs < 3_600) return say(Math.round(abs / 60), 'min');
    if (abs < 86_400) return say(Math.round(abs / 3_600), 'hr');
    if (abs < 30 * 86_400) return say(Math.round(abs / 86_400), 'day');
    return new Date(unixSeconds * 1000).toLocaleDateString('en-US', { dateStyle: 'medium' });
  }

  const say = (value: number, unit: string): string =>
    future ? `sau ${value} ${unit}` : `${value} ${unit} trước`;

  if (abs < 45) return future ? 'sắp tới' : 'vừa xong';
  if (abs < 3_600) return say(Math.round(abs / 60), 'phút');
  if (abs < 86_400) return say(Math.round(abs / 3_600), 'giờ');
  if (abs < 30 * 86_400) return say(Math.round(abs / 86_400), 'ngày');
  return new Date(unixSeconds * 1000).toLocaleDateString('vi-VN', { dateStyle: 'medium' });
}
