import { useEffect, useState } from 'react';
import { Crown, Trash2, UserPlus, Users } from 'lucide-react';
import { useToast } from '../components/toast.js';
import { ErrorState, RefreshButton, TableSkeleton, TimeAgo } from '../components/ui.js';
import { formatBytes, vi } from '../i18n/vi.js';
import { api, type SettingsView, type SpigotAccountsView, type StaffListResponse } from '../lib/api-client.js';
import { useAsync } from '../lib/use-async.js';
import { useCurrentUser } from '../lib/user-context.js';

const SNOWFLAKE = /^\d{17,20}$/;

export function SettingsPage() {
  const toast = useToast();
  const loaded = useAsync<SettingsView>('/api/settings');
  const spigot = useAsync<SpigotAccountsView>('/api/spigot-accounts');

  const [roles, setRoles] = useState<string | null>(null);
  const [keepCount, setKeepCount] = useState<string | null>(null);
  const [attachMax, setAttachMax] = useState<string | null>(null);
  const [autoDownload, setAutoDownload] = useState<boolean | null>(null);
  const [busy, setBusy] = useState(false);

  const settings = loaded.data;
  // Ô nhập chỉ ghi đè khi người dùng đã sửa: nhờ vậy một lần tải lại sau khi lưu không
  // xoá mất thứ đang gõ, và không cần đồng bộ state trong useEffect.
  const rolesValue = roles ?? settings?.adminRoleIds.join('\n') ?? '';
  const keepValue = keepCount ?? String(settings?.pruneKeepCount ?? '');
  const attachValue = attachMax ?? String(settings?.attachMaxBytes ?? '');
  const autoValue = autoDownload ?? settings?.autoDownloadEnabled ?? false;

  // Cảnh báo trước khi rời trang nếu còn thay đổi chưa lưu: trang này chỉ có một nút
  // Lưu, và ba ô ở trên rất dễ sửa xong rồi bỏ đi.
  const dirty = roles !== null || keepCount !== null || attachMax !== null || autoDownload !== null;
  useEffect(() => {
    if (!dirty) return;
    const onLeave = (event: BeforeUnloadEvent): void => event.preventDefault();
    window.addEventListener('beforeunload', onLeave);
    return () => window.removeEventListener('beforeunload', onLeave);
  }, [dirty]);

  const save = async (): Promise<void> => {
    const roleIds = rolesValue
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean);

    if (roleIds.length === 0 || !roleIds.every((id) => SNOWFLAKE.test(id))) {
      toast.error(vi.settings.invalidRole);
      return;
    }

    setBusy(true);
    try {
      const updated = await api.patch<SettingsView>('/api/settings', {
        adminRoleIds: roleIds,
        pruneKeepCount: Number(keepValue) || 10,
        attachMaxBytes: Number(attachValue) || 0,
        autoDownloadEnabled: autoValue,
      });
      loaded.set(updated);
      setRoles(null);
      setKeepCount(null);
      setAttachMax(null);
      setAutoDownload(null);
      toast.success(vi.settings.saved);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : vi.common.error);
    } finally {
      setBusy(false);
    }
  };

  if (loaded.error) return <ErrorState message={loaded.error} onRetry={() => void loaded.reload()} />;
  if (!settings) return <TableSkeleton rows={4} cols={2} />;

  return (
    <>
      <div className="content-head">
        <h2>{vi.settings.heading}</h2>
        <div className="button-row">
          {dirty && <span className="badge warn">{vi.settings.unsavedChanges}</span>}
          {/* Không đọc lại khi còn thay đổi chưa lưu: nó sẽ ghi đè thứ đang gõ. */}
          <RefreshButton onClick={() => void loaded.reload()} busy={loaded.refreshing || dirty} />
        </div>
      </div>

      <div className="panel">
        <label htmlFor="admin-roles">
          <span>{vi.settings.adminRoles}</span>
          <textarea
            id="admin-roles"
            value={rolesValue}
            onChange={(event) => setRoles(event.target.value)}
            spellCheck={false}
          />
        </label>
        <p className="hint">{vi.settings.adminRolesHint}</p>

        <hr className="panel-divider" />

        <div className="row">
          <label htmlFor="prune-keep">
            <span>{vi.settings.pruneKeepCount}</span>
            <input
              id="prune-keep"
              type="number"
              min={1}
              max={1000}
              value={keepValue}
              onChange={(event) => setKeepCount(event.target.value)}
            />
          </label>
          <label htmlFor="attach-max">
            <span>{vi.settings.attachMaxBytes}</span>
            <input
              id="attach-max"
              type="number"
              min={0}
              step={1024 * 1024}
              value={attachValue}
              onChange={(event) => setAttachMax(event.target.value)}
            />
          </label>
        </div>
        <p className="hint">{vi.settings.pruneHint}</p>
        {/* Byte thô là con số không ai nhẩm được: 8388608 hiện thành 8.0 MB ngay cạnh. */}
        <p className="hint">
          {vi.settings.attachHint} {vi.settings.currentValue}: <strong>{formatBytes(Number(attachValue) || 0)}</strong>.
        </p>

        <button className="primary" onClick={() => void save()} disabled={busy} aria-busy={busy}>
          {vi.settings.save}
        </button>
      </div>

      <div className="panel">
        <label style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 0 }}>
          <input
            type="checkbox"
            checked={autoValue}
            onChange={(event) => setAutoDownload(event.target.checked)}
            style={{ flex: '0 0 auto' }}
          />
          <span style={{ margin: 0 }}>{vi.settings.autoDownload}</span>
          <span className={autoValue ? 'badge warn' : 'badge'}>
            {autoValue ? vi.settings.autoDownloadOn : vi.settings.autoDownloadOff}
          </span>
          {/* Công tắc này chỉ có hiệu lực sau khi Lưu; trước đây nó trông như đã đổi
              ngay, nên trạng thái hiện trên giao diện có thể trái với máy chủ. */}
          {autoDownload !== null && autoDownload !== settings.autoDownloadEnabled && (
            <span className="badge warn">{vi.settings.unsavedChanges}</span>
          )}
        </label>
        <p className="hint">{vi.settings.autoDownloadHint}</p>

        <p style={{ marginBottom: 4 }}>
          <strong>{vi.settings.spigotAccounts}</strong>
        </p>
        {spigot.loading && <p className="muted">{vi.common.loading}</p>}
        {spigot.error && <p className="muted">{vi.settings.spigotError}</p>}
        {spigot.data?.configured === false && (
          <p className={spigot.data.reason === 'malformed' ? 'error' : 'muted'}>
            {spigot.data.reason === 'malformed' ? vi.settings.spigotAccountsBad : vi.settings.spigotAccountsNone}
          </p>
        )}
        {spigot.data?.configured === true && (
          <p className="button-row">
            {spigot.data.accounts.map((account) => (
              <span key={account.label} className={account.enabled ? 'badge ok' : 'badge'}>
                {account.label}
                {!account.enabled && ` (${vi.settings.accountDisabled})`}
              </span>
            ))}
          </p>
        )}
        <p className="hint">{vi.settings.spigotAccountsHint}</p>

        <button className="primary" onClick={() => void save()} disabled={busy} aria-busy={busy}>
          {vi.settings.save}
        </button>
      </div>

      <StaffManagementSection />
    </>
  );
}

function StaffManagementSection() {
  const toast = useToast();
  const currentUser = useCurrentUser();
  const staffQuery = useAsync<StaffListResponse>('/api/staff');
  const [newDiscordId, setNewDiscordId] = useState('');
  const [adding, setAdding] = useState(false);
  const [deletingId, setDeletingId] = useState<string | null>(null);

  const isOwner = currentUser?.role === 'owner';

  const handleAddStaff = async (e: React.FormEvent) => {
    e.preventDefault();
    const id = newDiscordId.trim();
    if (!SNOWFLAKE.test(id)) {
      toast.error('ID Discord phải là số gồm 17-20 chữ số (Snowflake)');
      return;
    }

    setAdding(true);
    try {
      await api.post('/api/staff', { discordUserId: id });
      toast.success('Đã thêm thành viên Staff thành công');
      setNewDiscordId('');
      await staffQuery.reload();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Không thể thêm Staff');
    } finally {
      setAdding(false);
    }
  };

  const handleRemoveStaff = async (id: string, name: string) => {
    if (!confirm(`Bạn có chắc chắn muốn huỷ quyền Staff của ${name} (${id}) không?`)) {
      return;
    }

    setDeletingId(id);
    try {
      await api.del(`/api/staff/${id}`);
      toast.success(`Đã xoá quyền Staff của ${name}`);
      await staffQuery.reload();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Không thể xoá Staff');
    } finally {
      setDeletingId(null);
    }
  };

  const ownerId = staffQuery.data?.ownerId || '958254424231378964';
  const staffList = staffQuery.data?.items ?? [];

  return (
    <div className="panel staff-management-panel" style={{ marginTop: 24 }}>
      <div className="panel-header-row" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
        <div>
          <h3 style={{ display: 'flex', alignItems: 'center', gap: 8, margin: 0 }}>
            <Users size={18} style={{ color: 'var(--accent)' }} />
            <span>Phân Quyền & Đội Ngũ Staff (Discord OAuth2)</span>
          </h3>
          <p className="hint" style={{ margin: '4px 0 0' }}>
            Các tài khoản Discord được cấp quyền đăng nhập vào hệ thống kho plugin qua nút "Đăng nhập với Discord".
          </p>
        </div>
        <RefreshButton onClick={() => void staffQuery.reload()} busy={staffQuery.refreshing} />
      </div>

      {/* Owner Badge Display */}
      <div className="owner-status-box">
        <div className="owner-avatar-icon">
          <Crown size={18} />
        </div>
        <div className="owner-info">
          <div className="owner-title-line">
            <span className="owner-name">Chủ sở hữu hệ thống (Owner)</span>
            <span className="badge ok">Toàn quyền cao nhất</span>
          </div>
          <div className="owner-id-line mono muted">
            ID Discord: <strong>{ownerId}</strong> {currentUser?.userId === ownerId && ' (Tài khoản hiện tại)'}
          </div>
        </div>
      </div>

      {/* Add Staff Form (Only for Owner) */}
      {isOwner ? (
        <form onSubmit={handleAddStaff} className="add-staff-form" style={{ marginTop: 20, marginBottom: 20 }}>
          <div style={{ display: 'flex', gap: 12, alignItems: 'flex-end', flexWrap: 'wrap' }}>
            <label style={{ flex: '1 1 260px', margin: 0 }}>
              <span style={{ fontSize: 13, fontWeight: 600 }}>Thêm Staff mới qua Discord User ID</span>
              <input
                type="text"
                value={newDiscordId}
                onChange={(e) => setNewDiscordId(e.target.value)}
                placeholder="Ví dụ: 1259335621063999519"
                disabled={adding}
                style={{ marginTop: 6 }}
              />
            </label>
            <button
              type="submit"
              className="primary"
              disabled={adding || !SNOWFLAKE.test(newDiscordId.trim())}
              aria-busy={adding}
              style={{ display: 'inline-flex', alignItems: 'center', gap: 6, height: 42 }}
            >
              <UserPlus size={16} />
              <span>{adding ? 'Đang thêm...' : 'Cấp quyền Staff'}</span>
            </button>
          </div>
          <p className="hint" style={{ marginTop: 6 }}>
            Nhập Discord Snowflake ID (17-20 chữ số). Hệ thống sẽ tự động đồng bộ Avatar và Tên hiển thị từ Discord Bot.
          </p>
        </form>
      ) : (
        <p className="hint hint-warn" style={{ marginTop: 16 }}>
          Chỉ có Chủ sở hữu mới có quyền thêm hoặc xoá thành viên Staff.
        </p>
      )}

      <hr className="panel-divider" />

      <h4 style={{ margin: '16px 0 12px', fontSize: 14 }}>Danh sách Staff được ủy quyền ({staffList.length})</h4>

      {staffQuery.loading && <p className="muted">Đang tải danh sách Staff...</p>}
      {staffQuery.error && <p className="error">{staffQuery.error}</p>}

      {!staffQuery.loading && staffList.length === 0 && (
        <p className="muted" style={{ padding: '16px 0' }}>
          Chưa có Staff nào được cấp quyền. Chỉ có Chủ sở hữu ({ownerId}) có thể đăng nhập qua Discord.
        </p>
      )}

      {staffList.length > 0 && (
        <div className="table-wrap">
          <table className="staff-table">
            <thead>
              <tr>
                <th>Thành viên</th>
                <th>Discord ID</th>
                <th>Người cấp quyền</th>
                <th>Ngày cấp</th>
                {isOwner && <th style={{ textAlign: 'right' }}>Thao tác</th>}
              </tr>
            </thead>
            <tbody>
              {staffList.map((member) => (
                <tr key={member.discordUserId}>
                  <td>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                      {member.avatar ? (
                        <img
                          src={member.avatar}
                          alt={member.displayName}
                          style={{ width: 32, height: 32, borderRadius: '50%', objectFit: 'cover' }}
                        />
                      ) : (
                        <div
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
                          }}
                        >
                          {member.displayName ? member.displayName.charAt(0).toUpperCase() : 'S'}
                        </div>
                      )}
                      <div>
                        <div style={{ fontWeight: 650, color: 'var(--heading)' }}>{member.displayName || member.username}</div>
                        <div className="hint compact mono">@{member.username}</div>
                      </div>
                    </div>
                  </td>
                  <td className="mono">{member.discordUserId}</td>
                  <td>
                    <span className="badge">{member.addedBy}</span>
                  </td>
                  <td className="muted nowrap">
                    <TimeAgo unixSeconds={member.createdAt} />
                  </td>
                  {isOwner && (
                    <td style={{ textAlign: 'right' }}>
                      <button
                        type="button"
                        className="small danger"
                        onClick={() => void handleRemoveStaff(member.discordUserId, member.displayName || member.username)}
                        disabled={deletingId === member.discordUserId}
                        style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}
                      >
                        <Trash2 size={13} />
                        <span>Xoá quyền</span>
                      </button>
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
