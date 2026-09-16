import { useState } from 'react';
import { User } from 'lucide-react';
import { Pager } from '../components/pager.js';
import { EmptyState, ErrorState, RefreshButton, TableSkeleton } from '../components/ui.js';
import { formatTimestampExact, formatVnd, vi } from '../i18n/vi.js';
import { type AuditView, type DiscordUserProfile, type Paginated } from '../lib/api-client.js';
import { useAsync } from '../lib/use-async.js';

function renderUserCell(discordUserId: string, userProfile?: DiscordUserProfile) {
  const avatarUrl = userProfile?.avatarUrl;
  const isCustomName = userProfile?.displayName && !/^\d{15,22}$/.test(userProfile.displayName);
  const displayName = isCustomName ? userProfile.displayName : null;
  const isCustomUsername = userProfile?.username && !/^\d{15,22}$/.test(userProfile.username);
  const username = isCustomUsername ? userProfile.username : null;

  return (
    <div className="table-user-cell" style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
      {avatarUrl ? (
        <img
          src={avatarUrl}
          alt={displayName ?? discordUserId}
          className="table-user-avatar"
          style={{ width: 28, height: 28, borderRadius: '50%', objectFit: 'cover', flexShrink: 0, border: '1px solid var(--border)' }}
        />
      ) : (
        <div
          className="table-user-avatar placeholder"
          style={{
            width: 28,
            height: 28,
            borderRadius: '50%',
            background: 'rgba(56, 189, 248, 0.15)',
            color: 'var(--accent)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            fontSize: 11,
            fontWeight: 700,
            flexShrink: 0,
            border: '1px solid rgba(56, 189, 248, 0.25)',
          }}
        >
          {displayName ? displayName.charAt(0).toUpperCase() : <User size={13} />}
        </div>
      )}
      <div style={{ display: 'flex', flexDirection: 'column', minWidth: 0 }}>
        <div className="table-user-name" style={{ fontWeight: 650, color: 'var(--heading)', fontSize: 13 }}>
          {displayName ?? `User #${discordUserId.slice(-4)}`}
        </div>
        <div className="table-user-sub mono muted" style={{ fontSize: 11 }}>
          {username ? `@${username}` : discordUserId}
        </div>
      </div>
    </div>
  );
}

export function LogPage() {
  const [page, setPage] = useState(1);
  const [month, setMonth] = useState('');
  const [userId, setUserId] = useState('');

  const params = new URLSearchParams({ page: String(page), pageSize: '25' });
  if (month) params.set('month', month);
  // Chỉ gửi khi đủ dạng snowflake: gõ dở dang một ID 18 chữ số sẽ tạo ra mười tám lượt
  // gọi API, và mười bảy lượt đầu đều chắc chắn không khớp gì.
  if (/^\d{17,20}$/.test(userId.trim())) params.set('userId', userId.trim());
  const log = useAsync<Paginated<AuditView>>(`/api/log?${params}`);

  const filtered = month !== '' || userId !== '';

  return (
    <>
      <div className="content-head">
        <h2>{vi.log.heading}</h2>
        <div className="button-row">
          {log.data && (
            <span className="muted">
              {vi.log.logHeaderTotal(log.data.total, filtered)}
            </span>
          )}
          <RefreshButton onClick={() => void log.reload()} busy={log.refreshing} />
        </div>
      </div>

      <div className="row" style={{ marginBottom: 16 }}>
        <label htmlFor="log-month">
          <span>{vi.log.filterMonth}</span>
          <input
            id="log-month"
            type="month"
            value={month}
            onChange={(event) => {
              setPage(1);
              setMonth(event.target.value);
            }}
          />
        </label>
        <label htmlFor="log-user">
          <span>{vi.log.filterUser}</span>
          <input
            id="log-user"
            inputMode="numeric"
            placeholder="123456789012345678"
            value={userId}
            onChange={(event) => {
              setPage(1);
              setUserId(event.target.value);
            }}
            aria-invalid={userId !== '' && !/^\d{17,20}$/.test(userId.trim())}
          />
        </label>
        <button
          type="button"
          className="ghost"
          disabled={!filtered}
          onClick={() => {
            setPage(1);
            setMonth('');
            setUserId('');
          }}
        >
          {vi.log.clear}
        </button>
      </div>

      {userId !== '' && !/^\d{17,20}$/.test(userId.trim()) && (
        <p className="hint" style={{ marginTop: -8, marginBottom: 12 }}>
          {vi.log.invalidDiscordIdHint}
        </p>
      )}

      {log.error && <ErrorState message={log.error} onRetry={() => void log.reload()} />}
      {log.loading && <TableSkeleton rows={6} cols={6} />}
      {log.data?.items.length === 0 && !log.error && (
        <EmptyState
          title={vi.log.empty}
          hint={filtered ? vi.log.emptyHintFiltered : vi.log.emptyHintUnfiltered}
        />
      )}

      {log.data && log.data.items.length > 0 && (
        <div className={`panel flush${log.refreshing ? ' refreshing' : ''}`}>
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>{vi.log.at}</th>
                  <th>{vi.log.user}</th>
                  <th>{vi.log.plugin}</th>
                  <th>{vi.log.version}</th>
                  <th className="right">{vi.log.amount}</th>
                  <th>{vi.log.method}</th>
                </tr>
              </thead>
              <tbody>
                {log.data.items.map((row) => (
                  <tr key={row.id}>
                    {/* Sổ giao hàng dùng mốc chính xác, không dùng "3 phút trước": nó
                        được đối chiếu với sao kê ngân hàng theo từng giây. */}
                    <td className="muted nowrap">{formatTimestampExact(row.deliveredAt)}</td>
                    <td>{renderUserCell(row.discordUserId, row.userProfile)}</td>
                    <td>{row.pluginName}</td>
                    <td>{row.versionLabel || <span className="muted">—</span>}</td>
                    <td className="right nowrap">{formatVnd(row.amount)}</td>
                    <td className="muted">{vi.log.methods[row.deliveryMethod] ?? row.deliveryMethod}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <Pager page={log.data.page} totalPages={log.data.totalPages} onChange={setPage} />
        </div>
      )}
    </>
  );
}
