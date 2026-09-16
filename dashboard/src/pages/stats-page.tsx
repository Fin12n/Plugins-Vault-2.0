import { useState } from 'react';
import { User } from 'lucide-react';
import { EmptyState, ErrorState, RefreshButton, Stat, TableSkeleton } from '../components/ui.js';
import { formatVnd, vi } from '../i18n/vi.js';
import { type DiscordUserProfile, type StatsView } from '../lib/api-client.js';
import { useAsync } from '../lib/use-async.js';

function renderUserCell(discordUserId: string, userProfile?: DiscordUserProfile) {
  const avatarUrl = userProfile?.avatarUrl;
  const isCustomName = userProfile?.displayName && !/^\d{15,22}$/.test(userProfile.displayName);
  const displayName = isCustomName ? userProfile.displayName : null;
  const isCustomUsername = userProfile?.username && !/^\d{15,22}$/.test(userProfile.username);
  const username = isCustomUsername ? userProfile.username : null;

  return (
    <div className="table-user-cell" style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
      {avatarUrl ? (
        <img
          src={avatarUrl}
          alt={displayName ?? discordUserId}
          className="table-user-avatar"
          style={{ width: 32, height: 32, borderRadius: '50%', objectFit: 'cover', flexShrink: 0, border: '1px solid var(--border)' }}
        />
      ) : (
        <div
          className="table-user-avatar placeholder"
          style={{
            width: 32,
            height: 32,
            borderRadius: '50%',
            background: 'rgba(56, 189, 248, 0.15)',
            color: 'var(--accent)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            fontSize: 12,
            fontWeight: 700,
            flexShrink: 0,
            border: '1px solid rgba(56, 189, 248, 0.25)',
          }}
        >
          {displayName ? displayName.charAt(0).toUpperCase() : <User size={14} />}
        </div>
      )}
      <div style={{ display: 'flex', flexDirection: 'column', minWidth: 0 }}>
        <div className="table-user-name" style={{ fontWeight: 650, color: 'var(--heading)', fontSize: 13.5 }}>
          {displayName ?? `Admin #${discordUserId.slice(-4)}`}
        </div>
        <div className="table-user-sub mono muted" style={{ fontSize: 11 }}>
          {username ? `@${username}` : discordUserId}
        </div>
      </div>
    </div>
  );
}

function currentMonth(): string {
  const now = new Date();
  return `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}`;
}

/** Tháng trước tháng đang xem, cho hai nút đi lùi/đi tới. */
function shiftMonth(month: string, delta: number): string {
  const [year, index] = month.split('-').map(Number);
  const date = new Date(Date.UTC(year ?? 1970, (index ?? 1) - 1 + delta, 1));
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}`;
}

/** Monthly party-fund report: totals plus a breakdown per plugin and per admin. */
export function StatsPage() {
  const [month, setMonth] = useState(currentMonth());
  const stats = useAsync<StatsView>(`/api/stats/monthly?month=${month}`);
  const thisMonth = currentMonth();

  const data = stats.data;
  // Trung bình mỗi lần tải: con số này trả lời "giá cọc đang đặt có hợp lý không?", thứ
  // mà hai con số tổng không nói ra.
  const average = data && data.totalDownloads > 0 ? Math.round(data.totalAmount / data.totalDownloads) : 0;

  return (
    <>
      <div className="content-head">
        <h2>{vi.stats.heading}</h2>
        <div className="button-row">
          <RefreshButton onClick={() => void stats.reload()} busy={stats.refreshing} />
          <button type="button" className="ghost small" onClick={() => setMonth(shiftMonth(month, -1))}>
            {vi.stats.prevMonth}
          </button>
          <button
            type="button"
            className="ghost small"
            disabled={month >= thisMonth}
            onClick={() => setMonth(shiftMonth(month, 1))}
          >
            {vi.stats.nextMonth}
          </button>
        </div>
      </div>

      <label style={{ maxWidth: 220 }} htmlFor="stats-month">
        <span>{vi.stats.month}</span>
        <input
          id="stats-month"
          type="month"
          value={month}
          max={thisMonth}
          onChange={(event) => setMonth(event.target.value || thisMonth)}
        />
      </label>

      {stats.error && <ErrorState message={stats.error} onRetry={() => void stats.reload()} />}
      {stats.loading && <TableSkeleton rows={4} cols={3} />}

      {data && (
        <div className={stats.refreshing ? 'refreshing' : undefined}>
          <div className="stat-grid" style={{ marginBottom: 16 }}>
            <Stat label={vi.stats.totalDownloads} value={data.totalDownloads} />
            <Stat label={vi.stats.totalAmount} value={formatVnd(data.totalAmount)} tone="ok" />
            <Stat label={vi.stats.averagePerDownload} value={formatVnd(average)} />
          </div>

          {data.totalDownloads === 0 && (
            <EmptyState
              title={vi.stats.empty}
              hint={vi.stats.emptyHint(month)}
            />
          )}

          {data.perPlugin.length > 0 && (
            <div className="panel flush">
              <h3 style={{ padding: '14px 12px 0' }}>{vi.stats.perPlugin}</h3>
              <div className="table-wrap">
                <table>
                  <thead>
                    <tr>
                      <th>{vi.log.plugin}</th>
                      <th className="right">{vi.stats.downloads}</th>
                      <th className="right">{vi.stats.amount}</th>
                      <th className="right">{vi.stats.shareRatio}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.perPlugin.map((row) => (
                      <tr key={row.pluginName}>
                        <td>{row.pluginName}</td>
                        <td className="right">{row.downloads}</td>
                        <td className="right nowrap">{formatVnd(row.amount)}</td>
                        {/* Tỷ trọng nói ngay plugin nào gánh quỹ, thay vì để mắt so
                            hàng chục con số với nhau. */}
                        <td className="right nowrap muted">
                          {data.totalAmount > 0 ? `${Math.round((row.amount / data.totalAmount) * 100)}%` : '—'}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {data.perUser.length > 0 && (
            <div className="panel flush">
              <h3 style={{ padding: '14px 12px 0' }}>{vi.stats.perUser}</h3>
              <div className="table-wrap">
                <table>
                  <thead>
                    <tr>
                      <th>{vi.log.user}</th>
                      <th className="right">{vi.stats.downloads}</th>
                      <th className="right">{vi.stats.amount}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.perUser.map((row) => (
                      <tr key={row.discordUserId}>
                        <td>{renderUserCell(row.discordUserId, row.userProfile)}</td>
                        <td className="right">{row.downloads}</td>
                        <td className="right nowrap">{formatVnd(row.amount)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </div>
      )}
    </>
  );
}
