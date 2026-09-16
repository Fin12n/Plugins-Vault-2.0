import { useEffect, useRef, useState } from 'react';
import {
  DollarSign,
  CheckSquare,
  X,
  Plus,
  ExternalLink,
  Edit2,
  Trash2,
  Globe,
  FileText,
  Package,
  Layers,
  Crown,
  Search,
  Zap,
  Loader2,
} from 'lucide-react';
import { Pager } from '../components/pager.js';
import { useToast } from '../components/toast.js';
import { EmptyState, ErrorState, RefreshButton, TableSkeleton, TimeAgo } from '../components/ui.js';
import { formatBytes, formatVnd, vi } from '../i18n/vi.js';
import { api, type Paginated, type PluginView, type VersionView } from '../lib/api-client.js';
import { useAsync } from '../lib/use-async.js';

type Detail = PluginView & { versions: VersionView[] };

export function PluginsPage() {
  const toast = useToast();
  const [page, setPage] = useState(1);
  const [query, setQuery] = useState('');
  const [draft, setDraft] = useState('');
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const searchRef = useRef<HTMLInputElement>(null);

  // Selection state for bulk price adjustment & bulk delete
  const [selectedIds, setSelectedIds] = useState<Set<number>>(new Set());
  const [selectAllMatching, setSelectAllMatching] = useState(false);
  const [showBulkModal, setShowBulkModal] = useState(false);
  const [showAddModal, setShowAddModal] = useState(false);
  const [deletingId, setDeletingId] = useState<number | null>(null);
  const [bulkDeleting, setBulkDeleting] = useState(false);
  const [batchLoading, setBatchLoading] = useState(false);

  const params = new URLSearchParams({ page: String(page), pageSize: '25' });
  if (query) params.set('q', query);
  const list = useAsync<Paginated<PluginView>>(`/api/plugins?${params}`);

  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      const target = event.target as HTMLElement | null;
      const typing = target?.tagName === 'INPUT' || target?.tagName === 'TEXTAREA' || target?.tagName === 'SELECT';
      if (event.key === '/' && !typing) {
        event.preventDefault();
        searchRef.current?.focus();
      }
      if (event.key === 'Escape' && typing) (target as HTMLElement).blur();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  if (selectedId !== null) {
    return (
      <PluginDetail
        id={selectedId}
        onClose={() => {
          setSelectedId(null);
          void list.reload();
        }}
      />
    );
  }

  const items = list.data?.items ?? [];
  const totalCount = list.data?.total ?? 0;
  const loadedVersions = items.reduce((sum, p) => sum + (p.versionCount || 0), 0);
  const trackedCount = items.filter((p) => p.resourceId !== null).length;
  const premiumCount = items.filter((p) => p.isPremium).length;

  const allCurrentPageChecked =
    items.length > 0 && items.every((p) => selectedIds.has(p.id) || selectAllMatching);

  const toggleSelectAllCurrentPage = () => {
    if (allCurrentPageChecked) {
      // Uncheck current page
      const next = new Set(selectedIds);
      items.forEach((p) => next.delete(p.id));
      setSelectedIds(next);
      setSelectAllMatching(false);
    } else {
      // Check all current page
      const next = new Set(selectedIds);
      items.forEach((p) => next.add(p.id));
      setSelectedIds(next);
    }
  };

  const toggleSelectOne = (id: number) => {
    const next = new Set(selectedIds);
    if (selectAllMatching) {
      // Transitioning away from all-matching
      items.forEach((p) => next.add(p.id));
      next.delete(id);
      setSelectAllMatching(false);
    } else if (next.has(id)) {
      next.delete(id);
    } else {
      next.add(id);
    }
    setSelectedIds(next);
  };

  const effectiveSelectedCount = selectAllMatching
    ? list.data?.total ?? 0
    : selectedIds.size;

  const handleDeleteOne = async (plugin: PluginView) => {
    const confirmMsg = `${vi.plugins.confirmDeletePlugin}\n\nPlugin: "${plugin.displayName}" (${plugin.versionCount} phiên bản)`;
    if (!window.confirm(confirmMsg)) return;

    setDeletingId(plugin.id);
    try {
      await api.del(`/api/plugins/${plugin.id}`);
      toast.success(vi.plugins.toastPluginDeleted(plugin.displayName));
      if (selectedIds.has(plugin.id)) {
        const next = new Set(selectedIds);
        next.delete(plugin.id);
        setSelectedIds(next);
      }
      void list.reload();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : vi.common.error);
    } finally {
      setDeletingId(null);
    }
  };

  const handleBulkDelete = async () => {
    const totalMatching = list.data?.total ?? 0;
    const count = selectAllMatching ? totalMatching : selectedIds.size;
    if (count === 0) return;

    const confirmMsg = selectAllMatching
      ? vi.plugins.confirmBulkDeleteAll(totalMatching)
      : vi.plugins.confirmBulkDelete(count);

    if (!window.confirm(confirmMsg)) return;

    setBulkDeleting(true);
    try {
      const res = await api.post<{ deletedCount: number; removedVersions: number }>('/api/plugins/bulk-delete', {
        ids: selectAllMatching ? undefined : Array.from(selectedIds),
        allMatching: selectAllMatching || undefined,
        query: query || undefined,
      });
      toast.success(vi.plugins.toastBulkDeleteSuccess(res.deletedCount));
      setSelectedIds(new Set());
      setSelectAllMatching(false);
      void list.reload();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : vi.plugins.toastBulkDeleteError);
    } finally {
      setBulkDeleting(false);
    }
  };

  const handleRunBatch = async () => {
    try {
      setBatchLoading(true);
      await api.post('/api/spigot-downloads/run-all', { autoResolveIds: true });
      toast.success('Đã kích hoạt tự động gắn ID & tải tất cả plugin về kho! Bạn có thể xem chi tiết tiến trình tại tab Tài khoản Spigot.');
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Không thể kích hoạt tiến trình tải');
    } finally {
      setBatchLoading(false);
    }
  };

  return (
    <>
      <div className="content-head">
        <h2>{vi.plugins.heading}</h2>
        <div className="button-row">
          <button
            type="button"
            className="btn btn-secondary"
            onClick={() => void handleRunBatch()}
            disabled={batchLoading}
            title="Tự động tra cứu gắn mã Spigot Resource ID cho các plugin chưa có và tải toàn bộ phiên bản về kho"
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: 6,
              background: 'linear-gradient(135deg, rgba(245, 158, 11, 0.15) 0%, rgba(234, 88, 12, 0.2) 100%)',
              borderColor: 'rgba(245, 158, 11, 0.4)',
              color: '#fbbf24',
              fontWeight: 600,
            }}
          >
            {batchLoading ? <Loader2 size={15} className="spin-icon" /> : <Zap size={15} />}
            <span>⚡ Tự Động Gắn ID & Tải Về</span>
          </button>
          <button type="button" className="btn btn-primary" onClick={() => setShowAddModal(true)}>
            <Plus size={15} style={{ marginRight: 6 }} />
            <span>{vi.plugins.createPluginBtn}</span>
          </button>
          {list.data && (
            <span className="muted">
              {query ? vi.plugins.countWithQuery(list.data.total, query) : vi.plugins.count(list.data.total)}
            </span>
          )}
          <RefreshButton onClick={() => void list.reload()} busy={list.refreshing} />
        </div>
      </div>

      {/* Bento Summary Metrics (UI/UX Pro Max) */}
      <div className="plugins-bento-grid">
        <div className="plugin-bento-card">
          <div className="bento-icon-box blue">
            <Package size={20} />
          </div>
          <div className="bento-data">
            <span className="bento-val">{totalCount}</span>
            <span className="bento-lbl">Tổng Plugins</span>
          </div>
        </div>
        <div className="plugin-bento-card">
          <div className="bento-icon-box green">
            <Layers size={20} />
          </div>
          <div className="bento-data">
            <span className="bento-val">{loadedVersions}</span>
            <span className="bento-lbl">Bản Lưu Trữ</span>
          </div>
        </div>
        <div className="plugin-bento-card">
          <div className="bento-icon-box amber">
            <Globe size={20} />
          </div>
          <div className="bento-data">
            <span className="bento-val">{trackedCount}</span>
            <span className="bento-lbl">Khớp Spigot</span>
          </div>
        </div>
        <div className="plugin-bento-card">
          <div className="bento-icon-box purple">
            <Crown size={20} />
          </div>
          <div className="bento-data">
            <span className="bento-val">{premiumCount}</span>
            <span className="bento-lbl">Plugin Premium</span>
          </div>
        </div>
      </div>

      <div className="plugins-search-bar-wrap">
        <form
          className="plugins-search-form"
          onSubmit={(event) => {
            event.preventDefault();
            setPage(1);
            setQuery(draft.trim());
            setSelectedIds(new Set());
            setSelectAllMatching(false);
          }}
        >
          <div className="search-input-inner">
            <Search size={16} className="search-icon-left" />
            <input
              ref={searchRef}
              type="search"
              placeholder={`${vi.plugins.search}  (/)`}
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
              aria-label={vi.plugins.search}
            />
            {draft ? (
              <button
                type="button"
                className="search-clear-btn"
                onClick={() => {
                  setDraft('');
                  setQuery('');
                  setPage(1);
                  setSelectedIds(new Set());
                  setSelectAllMatching(false);
                  searchRef.current?.focus();
                }}
                title={vi.plugins.clearFilter}
              >
                <X size={14} />
              </button>
            ) : (
              <span className="search-kbd-badge">/</span>
            )}
          </div>
          <button type="submit">{vi.plugins.searchSubmit}</button>
          {query !== '' && (
            <button
              type="button"
              className="ghost"
              onClick={() => {
                setDraft('');
                setQuery('');
                setPage(1);
                setSelectedIds(new Set());
                setSelectAllMatching(false);
              }}
            >
              {vi.plugins.clearFilter}
            </button>
          )}
        </form>
      </div>

      {/* Floating / Sticky Bulk Action Bar */}
      {effectiveSelectedCount > 0 && (
        <div className="bulk-action-bar">
          <div className="bulk-action-left">
            <CheckSquare size={16} className="bulk-icon" />
            <span className="bulk-action-count">
              {selectAllMatching
                ? vi.bulkPrice.allMatchingSelected(list.data?.total ?? 0)
                : vi.bulkPrice.selectedCount(selectedIds.size)}
            </span>
          </div>
          <div className="bulk-action-right">
            <button
              type="button"
              className="primary small"
              onClick={() => setShowBulkModal(true)}
            >
              <DollarSign size={14} />
              <span>{vi.bulkPrice.btnBulkAdjust}</span>
            </button>
            <button
              type="button"
              className="danger small"
              onClick={() => void handleBulkDelete()}
              disabled={bulkDeleting}
              aria-busy={bulkDeleting}
              style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}
            >
              <Trash2 size={14} />
              <span>{vi.plugins.btnBulkDelete}</span>
            </button>
            <button
              type="button"
              className="ghost small"
              onClick={() => {
                setSelectedIds(new Set());
                setSelectAllMatching(false);
              }}
            >
              <X size={14} />
              <span>{vi.bulkPrice.clearSelection}</span>
            </button>
          </div>
        </div>
      )}

      {list.error && <ErrorState message={list.error} onRetry={() => void list.reload()} />}
      {list.loading && <TableSkeleton rows={6} cols={5} />}

      {list.data && list.data.items.length === 0 && !list.error && (
        <EmptyState
          title={query ? vi.plugins.noMatchTitle(query) : vi.plugins.empty}
          hint={query ? vi.plugins.noMatchHint : vi.plugins.emptyHint}
          action={
            query ? (
              <button
                type="button"
                onClick={() => {
                  setDraft('');
                  setQuery('');
                }}
              >
                {vi.plugins.clearFilter}
              </button>
            ) : undefined
          }
        />
      )}

      {list.data && list.data.items.length > 0 && (
        <div className={`panel flush${list.refreshing ? ' refreshing' : ''}`}>
          {/* Select all matching banner across pages */}
          {allCurrentPageChecked && list.data.total > list.data.items.length && (
            <div className="selection-notice-banner">
              {!selectAllMatching ? (
                <>
                  <span>{vi.bulkPrice.selectedCount(selectedIds.size)}. </span>
                  <button
                    type="button"
                    className="inline-action-btn"
                    onClick={() => setSelectAllMatching(true)}
                  >
                    {vi.bulkPrice.selectAllMatching(list.data.total)}
                  </button>
                </>
              ) : (
                <>
                  <span>{vi.bulkPrice.allMatchingSelected(list.data.total)}. </span>
                  <button
                    type="button"
                    className="inline-action-btn"
                    onClick={() => {
                      setSelectAllMatching(false);
                      setSelectedIds(new Set());
                    }}
                  >
                    {vi.bulkPrice.clearSelection}
                  </button>
                </>
              )}
            </div>
          )}

          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th style={{ width: 44, textAlign: 'center' }}>
                    <input
                      type="checkbox"
                      className="custom-checkbox"
                      checked={allCurrentPageChecked}
                      onChange={toggleSelectAllCurrentPage}
                      aria-label="Select all on current page"
                    />
                  </th>
                  <th>{vi.plugins.name}</th>
                  <th>{vi.plugins.platform}</th>
                  <th className="right">{vi.plugins.versions}</th>
                  <th className="right">{vi.plugins.price}</th>
                  <th style={{ width: 140, textAlign: 'right' }} />
                </tr>
              </thead>
              <tbody>
                {list.data.items.map((plugin) => {
                  const isChecked = selectAllMatching || selectedIds.has(plugin.id);
                  return (
                    <tr key={plugin.id} className={isChecked ? 'row-selected' : undefined}>
                      <td style={{ width: 44, textAlign: 'center' }}>
                        <input
                          type="checkbox"
                          className="custom-checkbox"
                          checked={isChecked}
                          onChange={() => toggleSelectOne(plugin.id)}
                          aria-label={`Select ${plugin.displayName}`}
                        />
                      </td>
                      <td>
                        <div className="plugin-name-cell">
                          <span className="plugin-title-text">{plugin.displayName}</span>
                          {plugin.externalLink && (
                            <a
                              href={plugin.externalLink}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="external-plugin-link"
                              title={vi.plugins.openLink}
                              onClick={(e) => e.stopPropagation()}
                              style={{
                                display: 'inline-flex',
                                verticalAlign: 'middle',
                                color: 'var(--accent, #38bdf8)',
                              }}
                            >
                              <ExternalLink size={13} />
                            </a>
                          )}
                          {plugin.isPremium && (
                            <span className="tag-badge premium">
                              <Crown size={11} />
                              {vi.plugins.premium}
                            </span>
                          )}
                          {plugin.resourceId === null ? (
                            <span
                              className="tag-badge warning"
                              title={vi.plugins.unassignedResourceTooltip}
                            >
                              {vi.plugins.unassignedResource}
                            </span>
                          ) : (
                            <span className="tag-badge tracked" title={`Spigot Resource #${plugin.resourceId}`}>
                              <Globe size={11} />
                              ID: {plugin.resourceId}
                            </span>
                          )}
                        </div>
                      </td>
                      <td>
                        <span className="platform-pill">{plugin.platform}</span>
                      </td>
                      <td className="right">
                        <span className={`version-count-pill ${plugin.versionCount > 0 ? 'has-versions' : 'zero-versions'}`}>
                          {plugin.versionCount}
                        </span>
                      </td>
                      <td className="right">
                        <span className={`price-pill ${plugin.depositPrice === 0 ? 'free' : ''}`}>
                          {plugin.depositPrice === 0 ? 'Miễn phí' : formatVnd(plugin.depositPrice)}
                        </span>
                      </td>
                      <td className="right">
                        <div className="row-actions-wrap">
                          <button
                            type="button"
                            className="btn-table-version"
                            onClick={() => setSelectedId(plugin.id)}
                            title={vi.plugins.versionList}
                          >
                            <FileText size={13} />
                            <span>{vi.plugins.versionList}</span>
                          </button>
                          <button
                            type="button"
                            className="btn-table-delete"
                            title={vi.plugins.deletePluginBtn}
                            aria-label={`${vi.plugins.delete} ${plugin.displayName}`}
                            disabled={deletingId === plugin.id}
                            aria-busy={deletingId === plugin.id}
                            onClick={(e) => {
                              e.stopPropagation();
                              void handleDeleteOne(plugin);
                            }}
                          >
                            <Trash2 size={14} />
                          </button>
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <Pager page={list.data.page} totalPages={list.data.totalPages} onChange={setPage} />
        </div>
      )}

      {showBulkModal && (
        <BulkPriceModal
          selectedCount={selectedIds.size}
          allMatching={selectAllMatching}
          totalMatching={list.data?.total ?? 0}
          selectedIds={Array.from(selectedIds)}
          query={query}
          onClose={() => setShowBulkModal(false)}
          onSuccess={() => {
            setShowBulkModal(false);
            setSelectedIds(new Set());
            setSelectAllMatching(false);
            void list.reload();
          }}
        />
      )}

      {showAddModal && (
        <AddPluginModal
          onClose={() => setShowAddModal(false)}
          onSuccess={() => {
            setShowAddModal(false);
            void list.reload();
          }}
        />
      )}
    </>
  );
}

function BulkPriceModal({
  selectedCount,
  allMatching,
  totalMatching,
  selectedIds,
  query,
  onClose,
  onSuccess,
}: {
  selectedCount: number;
  allMatching: boolean;
  totalMatching: number;
  selectedIds: number[];
  query: string;
  onClose: () => void;
  onSuccess: () => void;
}) {
  const toast = useToast();
  const [mode, setMode] = useState<'set' | 'add_fixed' | 'multiply_percent'>('set');
  const [valueStr, setValueStr] = useState('20000');
  const [busy, setBusy] = useState(false);

  const numVal = Number(valueStr) || 0;

  const sampleOriginal = 20000;
  let sampleNew = 20000;
  if (mode === 'set') {
    sampleNew = Math.max(0, numVal);
  } else if (mode === 'add_fixed') {
    sampleNew = Math.max(0, sampleOriginal + numVal);
  } else if (mode === 'multiply_percent') {
    sampleNew = Math.max(0, Math.round((sampleOriginal * (1 + numVal / 100)) / 1000) * 1000);
  }

  const apply = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    try {
      const res = await api.post<{ updatedCount: number }>('/api/plugins/bulk-price', {
        ids: allMatching ? undefined : selectedIds,
        allMatching: allMatching || undefined,
        query: query || undefined,
        mode,
        value: numVal,
      });
      toast.success(vi.bulkPrice.toastSuccess(res.updatedCount));
      onSuccess();
    } catch {
      toast.error(vi.bulkPrice.toastError);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="panel modal-card" onClick={(e) => e.stopPropagation()} role="dialog" aria-modal="true">
        <h3>{vi.bulkPrice.modalTitle}</h3>
        <p className="muted" style={{ marginBottom: 16 }}>
          {allMatching ? vi.bulkPrice.modalSubtitleAll(totalMatching) : vi.bulkPrice.modalSubtitle(selectedCount)}
        </p>

        <form onSubmit={apply} className="stack">
          <label>
            <span>{vi.bulkPrice.mode}</span>
            <select
              value={mode}
              onChange={(e) => {
                const next = e.target.value as 'set' | 'add_fixed' | 'multiply_percent';
                setMode(next);
                if (next === 'set') setValueStr('20000');
                else if (next === 'add_fixed') setValueStr('5000');
                else if (next === 'multiply_percent') setValueStr('-20');
              }}
            >
              <option value="set">{vi.bulkPrice.modeSet} — {vi.bulkPrice.modeSetDesc}</option>
              <option value="add_fixed">{vi.bulkPrice.modeAdd} — {vi.bulkPrice.modeAddDesc}</option>
              <option value="multiply_percent">{vi.bulkPrice.modePercent} — {vi.bulkPrice.modePercentDesc}</option>
            </select>
          </label>

          <label>
            <span>
              {mode === 'set' && vi.bulkPrice.fixedValueLabel}
              {mode === 'add_fixed' && vi.bulkPrice.addValueLabel}
              {mode === 'multiply_percent' && vi.bulkPrice.percentValueLabel}
            </span>
            <input
              type="number"
              value={valueStr}
              onChange={(e) => setValueStr(e.target.value)}
              step={mode === 'multiply_percent' ? '5' : '1000'}
              required
            />
          </label>

          <div className="price-preview-box">
            <span className="price-preview-title">{vi.bulkPrice.preview}:</span>
            <span className="price-preview-calc">
              {vi.bulkPrice.previewExample(formatVnd(sampleOriginal), formatVnd(sampleNew))}
            </span>
          </div>

          <div className="button-row" style={{ marginTop: 14, justifyContent: 'flex-end' }}>
            <button type="button" className="ghost" onClick={onClose} disabled={busy}>
              {vi.bulkPrice.btnCancel}
            </button>
            <button type="submit" className="primary" disabled={busy} aria-busy={busy}>
              {vi.bulkPrice.btnApply}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

function AddPluginModal({
  onClose,
  onSuccess,
}: {
  onClose: () => void;
  onSuccess: () => void;
}) {
  const toast = useToast();
  const [displayName, setDisplayName] = useState('');
  const [platform, setPlatform] = useState('spigot');
  const [depositPrice, setDepositPrice] = useState(0);
  const [resourceId, setResourceId] = useState('');
  const [isPremium, setIsPremium] = useState(false);
  const [externalLink, setExternalLink] = useState('');
  const [description, setDescription] = useState('');
  const [busy, setBusy] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!displayName.trim()) {
      toast.error('Vui lòng nhập tên plugin');
      return;
    }
    setBusy(true);
    try {
      await api.post('/api/plugins', {
        displayName: displayName.trim(),
        platform,
        depositPrice: Number(depositPrice) || 0,
        resourceId: resourceId.trim() ? Number(resourceId) : null,
        isPremium,
        externalLink: externalLink.trim(),
        description: description.trim(),
      });
      toast.success(vi.plugins.toastPluginCreated(displayName.trim()));
      onSuccess();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Tạo plugin thất bại');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="panel modal-card" onClick={(e) => e.stopPropagation()} style={{ maxWidth: 540 }}>
        <div className="modal-header">
          <h3>{vi.plugins.createPluginTitle}</h3>
          <button type="button" className="btn btn-ghost btn-sm" onClick={onClose}>
            ✕
          </button>
        </div>

        <form onSubmit={handleSubmit}>
          <div className="modal-body stack" style={{ gap: 14 }}>
            <label>
              <span>{vi.plugins.name} *</span>
              <input
                type="text"
                placeholder="VD: CombatLogX, EssentialsX"
                value={displayName}
                onChange={(e) => setDisplayName(e.target.value)}
                required
              />
            </label>

            <div className="form-row-2">
              <label>
                <span>{vi.plugins.platform}</span>
                <select value={platform} onChange={(e) => setPlatform(e.target.value)}>
                  <option value="spigot">Spigot / Paper</option>
                  <option value="paper">Paper Only</option>
                  <option value="velocity">Velocity</option>
                  <option value="bungee">BungeeCord</option>
                </select>
              </label>

              <label>
                <span>{vi.plugins.price}</span>
                <input
                  type="number"
                  min="0"
                  step="1000"
                  value={depositPrice}
                  onChange={(e) => setDepositPrice(Number(e.target.value))}
                />
              </label>
            </div>

            <div className="form-row-2">
              <label>
                <span>{vi.plugins.resourceId}</span>
                <input
                  type="number"
                  min="1"
                  placeholder={vi.plugins.resourceIdPlaceholder}
                  value={resourceId}
                  onChange={(e) => {
                    const val = e.target.value;
                    setResourceId(val);
                    if (val.trim() && (!externalLink || externalLink.includes('spigotmc.org/resources/'))) {
                      setExternalLink(`https://www.spigotmc.org/resources/${val.trim()}/`);
                    }
                  }}
                />
              </label>

              <label className="checkbox-label" style={{ alignSelf: 'center', marginTop: 14 }}>
                <input
                  type="checkbox"
                  className="custom-checkbox"
                  checked={isPremium}
                  onChange={(e) => setIsPremium(e.target.checked)}
                />
                <span>{vi.plugins.premium}</span>
              </label>
            </div>

            <label>
              <span>{vi.plugins.externalLink}</span>
              <input
                type="url"
                placeholder={vi.plugins.externalLinkPlaceholder}
                value={externalLink}
                onChange={(e) => setExternalLink(e.target.value)}
              />
            </label>

            <label>
              <span>{vi.plugins.description}</span>
              <textarea
                rows={3}
                placeholder={vi.plugins.descriptionPlaceholder}
                value={description}
                onChange={(e) => setDescription(e.target.value)}
              />
            </label>
          </div>

          <div className="modal-footer">
            <button type="button" className="btn btn-secondary" onClick={onClose} disabled={busy}>
              {vi.common.no}
            </button>
            <button type="submit" className="btn btn-primary" disabled={busy} aria-busy={busy}>
              {busy ? vi.common.loading : vi.common.yes}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

function PluginDetail({ id, onClose }: { id: number; onClose: () => void }) {
  const detail = useAsync<Detail>(`/api/plugins/${id}`);
  const toast = useToast();
  const [displayName, setDisplayName] = useState<string | null>(null);
  const [price, setPrice] = useState<string | null>(null);
  const [resourceId, setResourceId] = useState<string | null>(null);
  const [premium, setPremium] = useState<boolean | null>(null);
  const [description, setDescription] = useState<string | null>(null);
  const [externalLink, setExternalLink] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [busyVersion, setBusyVersion] = useState<number | null>(null);
  const [deletingPlugin, setDeletingPlugin] = useState(false);

  // Version edit modal state
  const [editingVersion, setEditingVersion] = useState<VersionView | null>(null);
  const [versionStringDraft, setVersionStringDraft] = useState('');
  const [versionStableDraft, setVersionStableDraft] = useState(false);
  const [savingVersion, setSavingVersion] = useState(false);

  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const plugin = detail.data;
  const nameValue = displayName ?? plugin?.displayName ?? '';
  const priceValue = price ?? String(plugin?.depositPrice ?? '');
  const resourceValue = resourceId ?? (plugin?.resourceId === null || plugin === null ? '' : String(plugin.resourceId));
  const premiumValue = premium ?? plugin?.isPremium ?? false;
  const descValue = description ?? plugin?.description ?? '';
  const linkValue = externalLink ?? plugin?.externalLink ?? '';

  const save = async (): Promise<void> => {
    if (!plugin) return;
    setSaving(true);
    try {
      await api.patch(`/api/plugins/${plugin.id}`, {
        displayName: nameValue.trim() || plugin.displayName,
        depositPrice: Number(priceValue) || 0,
        resourceId: resourceValue === '' ? null : Number(resourceValue),
        isPremium: premiumValue,
        description: descValue.trim(),
        externalLink: linkValue.trim(),
      });
      toast.success(vi.plugins.saved);
      setDisplayName(null);
      setPrice(null);
      setResourceId(null);
      setPremium(null);
      setDescription(null);
      setExternalLink(null);
      void detail.reload();
    } catch {
      toast.error(vi.common.error);
    } finally {
      setSaving(false);
    }
  };

  const handleDeletePlugin = async () => {
    if (!plugin) return;
    if (!window.confirm(vi.plugins.confirmDeletePlugin)) return;
    setDeletingPlugin(true);
    try {
      await api.del(`/api/plugins/${plugin.id}`);
      toast.success(vi.plugins.toastPluginDeleted(plugin.displayName));
      onClose();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : vi.common.error);
    } finally {
      setDeletingPlugin(false);
    }
  };

  const removeVersion = async (version: VersionView): Promise<void> => {
    if (!window.confirm(vi.plugins.confirmDeleteVersion)) return;
    setBusyVersion(version.id);
    try {
      await api.del(`/api/versions/${version.id}`);
      toast.success(vi.plugins.toastVersionDeleted(version.version ?? version.originalName));
      void detail.reload();
    } catch {
      toast.error(vi.common.error);
    } finally {
      setBusyVersion(null);
    }
  };

  const toggleStable = async (version: VersionView): Promise<void> => {
    setBusyVersion(version.id);
    try {
      await api.patch(`/api/versions/${version.id}`, { isStable: !version.isStable });
      toast.success(version.isStable ? vi.plugins.toastUnmarkedStable : vi.plugins.toastMarkedStable);
      void detail.reload();
    } catch {
      toast.error(vi.common.error);
    } finally {
      setBusyVersion(null);
    }
  };

  const openEditVersion = (version: VersionView) => {
    setEditingVersion(version);
    setVersionStringDraft(version.version ?? '');
    setVersionStableDraft(version.isStable);
  };

  const saveEditedVersion = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!editingVersion) return;
    setSavingVersion(true);
    try {
      await api.patch(`/api/versions/${editingVersion.id}`, {
        version: versionStringDraft.trim() || undefined,
        isStable: versionStableDraft,
      });
      toast.success(vi.plugins.toastVersionUpdated);
      setEditingVersion(null);
      void detail.reload();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : vi.common.error);
    } finally {
      setSavingVersion(false);
    }
  };

  if (detail.error) return <ErrorState message={detail.error} onRetry={() => void detail.reload()} />;
  if (detail.loading || !plugin) return <TableSkeleton rows={4} cols={4} />;

  return (
    <>
      <div className="content-head">
        <h2>
          {plugin.displayName}{' '}
          <span className="muted" style={{ fontWeight: 400 }}>
            ({plugin.platform})
          </span>
        </h2>
        <div className="button-row">
          <button className="ghost" onClick={onClose}>
            {vi.common.close}
          </button>
        </div>
      </div>

      <div className="panel">
        <h3>{vi.plugins.heading}</h3>
        <div className="form-grid">
          <label>
            <span>{vi.plugins.name}</span>
            <input
              type="text"
              value={nameValue}
              onChange={(e) => setDisplayName(e.target.value)}
              required
            />
          </label>

          <label>
            <span>{vi.plugins.price}</span>
            <input
              type="number"
              min="0"
              step="1000"
              value={priceValue}
              onChange={(e) => setPrice(e.target.value)}
            />
          </label>

          <label>
            <span>{vi.plugins.resourceId}</span>
            <input
              type="number"
              min="1"
              placeholder={vi.plugins.resourceIdPlaceholder}
              value={resourceValue}
              onChange={(e) => {
                const val = e.target.value;
                setResourceId(val);
                if (val.trim() && (!linkValue || linkValue.includes('spigotmc.org/resources/'))) {
                  setExternalLink(`https://www.spigotmc.org/resources/${val.trim()}/`);
                }
              }}
            />
            <p className="hint">{vi.plugins.resourceIdHint}</p>
          </label>

          <label className="checkbox-label" style={{ alignSelf: 'center', marginTop: 12 }}>
            <input
              type="checkbox"
              className="custom-checkbox"
              checked={premiumValue}
              onChange={(e) => setPremium(e.target.checked)}
            />
            <span>{vi.plugins.premium}</span>
          </label>
        </div>

        <div style={{ marginTop: 14 }}>
          <label>
            <span>{vi.plugins.externalLink}</span>
            <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
              <input
                type="url"
                placeholder={vi.plugins.externalLinkPlaceholder}
                value={linkValue}
                onChange={(e) => setExternalLink(e.target.value)}
                style={{ flex: 1 }}
              />
              {linkValue && (
                <a
                  href={linkValue}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="btn btn-secondary btn-sm"
                  title={vi.plugins.openLink}
                  style={{ display: 'inline-flex', alignItems: 'center', gap: 4, height: 38, padding: '0 12px' }}
                >
                  <ExternalLink size={14} />
                  <span>{vi.plugins.openLink}</span>
                </a>
              )}
            </div>
          </label>
        </div>

        <div style={{ marginTop: 14 }}>
          <label>
            <span>{vi.plugins.description}</span>
            <textarea
              rows={4}
              placeholder={vi.plugins.descriptionPlaceholder}
              value={descValue}
              onChange={(e) => setDescription(e.target.value)}
            />
          </label>
        </div>

        <div
          className="button-row"
          style={{
            marginTop: 20,
            justifyContent: 'space-between',
            borderTop: '1px solid var(--border-subtle)',
            paddingTop: 16,
          }}
        >
          <button
            type="button"
            className="btn btn-ghost text-danger"
            onClick={() => void handleDeletePlugin()}
            disabled={deletingPlugin}
            style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}
          >
            <Trash2 size={15} />
            <span>{vi.plugins.deletePluginBtn}</span>
          </button>

          <button
            type="button"
            className="btn btn-primary"
            onClick={() => void save()}
            disabled={saving}
            aria-busy={saving}
          >
            {vi.plugins.save}
          </button>
        </div>
      </div>

      <div className="panel flush">
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>{vi.plugins.versions}</th>
                <th>{vi.plugins.uploadedAt}</th>
                <th className="right">{vi.plugins.size}</th>
                <th style={{ textAlign: 'right' }}>Hành động</th>
              </tr>
            </thead>
            <tbody>
              {plugin.versions.map((version) => (
                <tr key={version.id}>
                  <td>
                    {version.version ?? <span className="muted">—</span>}
                    {version.isStable && <span className="badge ok" style={{ marginLeft: 6 }}>{vi.plugins.stable}</span>}
                    {version.versionFlag !== 'ok' && version.versionFlag !== 'manual' && (
                      <span className="badge warn" style={{ marginLeft: 6 }} title={vi.plugins.flagWarning}>
                        {version.versionFlag}
                      </span>
                    )}
                    <div className="hint mono">{version.originalName}</div>
                  </td>
                  <td className="muted">
                    <TimeAgo unixSeconds={version.uploadedAt} />
                  </td>
                  <td className="right nowrap">{formatBytes(version.bytes)}</td>
                  <td className="right nowrap">
                    <div style={{ display: 'inline-flex', gap: 6, alignItems: 'center' }}>
                      <button
                        type="button"
                        className="btn btn-ghost btn-sm"
                        onClick={() => openEditVersion(version)}
                        title={vi.plugins.editVersion}
                      >
                        <Edit2 size={13} />
                        <span style={{ marginLeft: 4 }}>{vi.plugins.editVersion}</span>
                      </button>
                      <button
                        type="button"
                        className="small"
                        onClick={() => void toggleStable(version)}
                        disabled={busyVersion === version.id}
                        aria-busy={busyVersion === version.id}
                      >
                        {version.isStable ? vi.plugins.unmarkStable : vi.plugins.markStable}
                      </button>
                      <button
                        type="button"
                        className="small danger"
                        onClick={() => void removeVersion(version)}
                        disabled={busyVersion === version.id}
                      >
                        {vi.plugins.delete}
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {/* Edit Version Modal */}
      {editingVersion && (
        <div className="modal-backdrop" onClick={() => setEditingVersion(null)}>
          <div className="panel modal-card" onClick={(e) => e.stopPropagation()} style={{ maxWidth: 440 }}>
            <div className="modal-header">
              <h3>{vi.plugins.editVersion}</h3>
              <button type="button" className="btn btn-ghost btn-sm" onClick={() => setEditingVersion(null)}>
                ✕
              </button>
            </div>

            <form onSubmit={saveEditedVersion}>
              <div className="modal-body stack" style={{ gap: 14 }}>
                <label>
                  <span>Chuỗi phiên bản</span>
                  <input
                    type="text"
                    value={versionStringDraft}
                    onChange={(e) => setVersionStringDraft(e.target.value)}
                    placeholder={vi.plugins.versionPlaceholder}
                    required
                  />
                </label>

                <label className="checkbox-label" style={{ marginTop: 8 }}>
                  <input
                    type="checkbox"
                    className="custom-checkbox"
                    checked={versionStableDraft}
                    onChange={(e) => setVersionStableDraft(e.target.checked)}
                  />
                  <span>{vi.plugins.isStable}</span>
                </label>
              </div>

              <div className="modal-footer">
                <button
                  type="button"
                  className="btn btn-secondary"
                  onClick={() => setEditingVersion(null)}
                  disabled={savingVersion}
                >
                  {vi.common.no}
                </button>
                <button type="submit" className="btn btn-primary" disabled={savingVersion} aria-busy={savingVersion}>
                  {savingVersion ? vi.common.loading : vi.plugins.saveVersion}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </>
  );
}
