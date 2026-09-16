import { useState } from 'react';
import {
  Tag,
  Plus,
  Copy,
  Check,
  Edit2,
  Trash2,
  Percent,
  DollarSign,
  Calendar,
  Users,
  ShieldCheck,
  Sparkles,
  X,
  ShoppingBag,
  ShieldAlert,
  Coins,
  CheckCircle2,
  AlertTriangle,
} from 'lucide-react';
import { EmptyState, ErrorState, RefreshButton, TableSkeleton } from '../components/ui.js';
import { PillSwitch } from '../components/theme-lang-toggles.js';
import { useToast } from '../components/toast.js';
import { useI18n } from '../i18n/context.js';
import { formatTimestamp, formatVnd } from '../i18n/vi.js';
import { api } from '../lib/api-client.js';
import { useAsync } from '../lib/use-async.js';

type DiscountType = 'percent' | 'fixed';

type DiscountCode = {
  id: number;
  code: string;
  type: DiscountType;
  value: number;
  minOrder: number;
  maxDiscount: number | null;
  maxUses: number | null;
  usedCount: number;
  expiresAt: number | null;
  isActive: boolean;
  createdAt: number;
};

type DiscountsResponse = {
  items: DiscountCode[];
};

export function DiscountsPage() {
  const { t } = useI18n();
  const [copiedId, setCopiedId] = useState<number | null>(null);
  const [modalMode, setModalMode] = useState<'create' | 'edit' | null>(null);
  const [editingDiscount, setEditingDiscount] = useState<DiscountCode | null>(null);
  const [deletingDiscount, setDeletingDiscount] = useState<DiscountCode | null>(null);
  const [deleting, setDeleting] = useState(false);

  // Form states
  const [formCode, setFormCode] = useState('');
  const [formType, setFormType] = useState<DiscountType>('percent');
  const [formValue, setFormValue] = useState<number>(10);
  const [formMinOrder, setFormMinOrder] = useState<number>(0);
  const [formMaxDiscount, setFormMaxDiscount] = useState<number | ''>('');
  const [formMaxUses, setFormMaxUses] = useState<number | ''>('');
  const [formExpiresAt, setFormExpiresAt] = useState<string>('');
  const [formIsActive, setFormIsActive] = useState<boolean>(true);
  const [submitting, setSubmitting] = useState(false);

  const toast = useToast();
  const query = useAsync<DiscountsResponse>('/api/discounts');

  const items = query.data?.items ?? [];

  const copyCode = async (code: string, id: number) => {
    try {
      await navigator.clipboard.writeText(code);
      setCopiedId(id);
      toast.success(t.discounts.codeCopied);
      setTimeout(() => setCopiedId(null), 2000);
    } catch {
      // Fallback
    }
  };

  const handleToggle = async (discount: DiscountCode) => {
    const nextActive = !discount.isActive;
    // Optimistic instant UI update
    if (query.data) {
      query.set({
        ...query.data,
        items: query.data.items.map((it) =>
          it.id === discount.id ? { ...it, isActive: nextActive } : it
        ),
      });
    }

    try {
      const res = await api.patch<{ ok?: boolean; discount?: DiscountCode; isActive?: boolean }>(
        `/api/discounts/${discount.id}/toggle`,
      );
      const isNowActive = res?.discount?.isActive ?? res?.isActive ?? nextActive;
      toast.success(isNowActive ? t.discounts.toastActive : t.discounts.toastInactive);
      await query.reload();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t.discounts.toastSaveError);
      await query.reload();
    }
  };

  const handleDeleteClick = (discount: DiscountCode) => {
    setDeletingDiscount(discount);
  };

  const confirmDelete = async () => {
    if (!deletingDiscount) return;
    setDeleting(true);
    try {
      await api.del(`/api/discounts/${deletingDiscount.id}`);
      toast.success(t.discounts.deleteSuccess);
      setDeletingDiscount(null);
      await query.reload();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t.discounts.toastDeleteError);
    } finally {
      setDeleting(false);
    }
  };

  const openCreateModal = () => {
    setModalMode('create');
    setEditingDiscount(null);
    setFormCode('');
    setFormType('percent');
    setFormValue(10);
    setFormMinOrder(0);
    setFormMaxDiscount('');
    setFormMaxUses('');
    setFormExpiresAt('');
    setFormIsActive(true);
  };

  const openEditModal = (d: DiscountCode) => {
    setModalMode('edit');
    setEditingDiscount(d);
    setFormCode(d.code);
    setFormType(d.type);
    setFormValue(d.value);
    setFormMinOrder(d.minOrder);
    setFormMaxDiscount(d.maxDiscount !== null ? d.maxDiscount : '');
    setFormMaxUses(d.maxUses !== null ? d.maxUses : '');
    if (d.expiresAt) {
      const date = new Date(d.expiresAt * 1000);
      const iso = date.toISOString().split('T')[0] ?? '';
      setFormExpiresAt(iso);
    } else {
      setFormExpiresAt('');
    }
    setFormIsActive(d.isActive);
  };

  const closeModal = () => {
    setModalMode(null);
    setEditingDiscount(null);
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!formCode.trim()) {
      toast.error(t.discounts.toastCodeRequired);
      return;
    }
    if (formValue <= 0) {
      toast.error(t.discounts.toastValueRequired);
      return;
    }

    let expiresSec: number | null = null;
    if (formExpiresAt) {
      const parsed = new Date(formExpiresAt + 'T23:59:59').getTime();
      if (!isNaN(parsed)) {
        expiresSec = Math.floor(parsed / 1000);
      }
    }

    setSubmitting(true);
    try {
      if (modalMode === 'create') {
        await api.post('/api/discounts', {
          code: formCode.trim().toUpperCase().replace(/\s+/g, ''),
          type: formType,
          value: Number(formValue),
          minOrder: Number(formMinOrder) || 0,
          maxDiscount: formMaxDiscount ? Number(formMaxDiscount) : null,
          maxUses: formMaxUses ? Number(formMaxUses) : null,
          expiresAt: expiresSec,
          isActive: formIsActive,
        });
        toast.success(t.discounts.saveSuccess);
      } else if (modalMode === 'edit' && editingDiscount) {
        await api.patch(`/api/discounts/${editingDiscount.id}`, {
          code: formCode.trim().toUpperCase().replace(/\s+/g, ''),
          type: formType,
          value: Number(formValue),
          minOrder: Number(formMinOrder) || 0,
          maxDiscount: formMaxDiscount ? Number(formMaxDiscount) : null,
          maxUses: formMaxUses ? Number(formMaxUses) : null,
          expiresAt: expiresSec,
          isActive: formIsActive,
        });
        toast.success(t.discounts.saveSuccess);
      }
      closeModal();
      await query.reload();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t.discounts.toastSaveError);
    } finally {
      setSubmitting(false);
    }
  };

  // Live preview calculations
  const sampleOrder = 100000;
  let sampleDiscount = 0;
  let isCapped = false;
  if (formType === 'percent') {
    sampleDiscount = Math.round((sampleOrder * formValue) / 100);
    if (formMaxDiscount && sampleDiscount > Number(formMaxDiscount)) {
      sampleDiscount = Number(formMaxDiscount);
      isCapped = true;
    }
  } else {
    sampleDiscount = formValue;
  }
  const sampleFinal = Math.max(0, sampleOrder - sampleDiscount);

  const activeCount = items.filter((i) => i.isActive).length;
  const totalRedemptions = items.reduce((sum, i) => sum + i.usedCount, 0);

  return (
    <>
      <div className="content-head">
        <div>
          <h2>{t.discounts.heading}</h2>
          <p className="muted" style={{ marginTop: 4 }}>
            {t.discounts.subtitle}
          </p>
        </div>
        <div className="button-row">
          <button type="button" className="btn btn-primary" onClick={openCreateModal}>
            <Plus size={15} style={{ marginRight: 6 }} />
            <span>{t.discounts.createBtn}</span>
          </button>
          <RefreshButton onClick={() => void query.reload()} busy={query.refreshing} />
        </div>
      </div>

      {query.error && <ErrorState message={query.error} onRetry={() => void query.reload()} />}
      {query.loading && <TableSkeleton rows={5} cols={6} />}

      {query.data && !query.error && (
        <>
          {/* Top Summary Metrics */}
          <div className="stat-grid" style={{ marginBottom: 24 }}>
            <div className="stat">
              <div className="stat-label-wrap">
                <Tag size={16} className="stat-icon-accent" />
                <span className="stat-label">{t.discounts.statTotal}</span>
              </div>
              <div className="stat-num">{items.length}</div>
            </div>

            <div className="stat">
              <div className="stat-label-wrap">
                <ShieldCheck size={16} className="stat-icon-ok" />
                <span className="stat-label">{t.discounts.statActive}</span>
              </div>
              <div className="stat-num ok-text">{activeCount}</div>
            </div>

            <div className="stat">
              <div className="stat-label-wrap">
                <Users size={16} className="stat-icon-accent" />
                <span className="stat-label">{t.discounts.statUses}</span>
              </div>
              <div className="stat-num">{totalRedemptions}</div>
            </div>
          </div>

          {items.length === 0 ? (
            <EmptyState
              title={t.discounts.emptyTitle}
              hint={t.discounts.emptyHint}
              action={
                <button type="button" className="btn btn-primary" onClick={openCreateModal}>
                  <Plus size={14} style={{ marginRight: 6 }} />
                  <span>{t.discounts.createBtn}</span>
                </button>
              }
            />
          ) : (
            <div className="panel" style={{ padding: 0, overflow: 'hidden' }}>
              <div className="table-responsive">
                <table className="data-table">
                  <thead>
                    <tr>
                      <th style={{ minWidth: 150 }}>{t.discounts.code}</th>
                      <th style={{ minWidth: 120 }}>{t.discounts.value}</th>
                      <th style={{ minWidth: 130 }}>{t.discounts.minOrder}</th>
                      <th style={{ minWidth: 110 }}>{t.discounts.usedCount}</th>
                      <th style={{ minWidth: 120 }}>{t.discounts.expiresAt}</th>
                      <th style={{ minWidth: 100 }}>{t.discounts.status}</th>
                      <th style={{ width: 90, textAlign: 'right' }}>{t.discounts.actions}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {items.map((d) => (
                      <tr key={d.id}>
                        <td>
                          <div className="discount-code-cell">
                            <span className="discount-code-badge">{d.code}</span>
                            <button
                              type="button"
                              className="btn btn-ghost btn-xs copy-btn"
                              onClick={() => void copyCode(d.code, d.id)}
                              title={t.discounts.copyCode}
                            >
                              {copiedId === d.id ? <Check size={12} /> : <Copy size={12} />}
                            </button>
                          </div>
                        </td>
                        <td>
                          <div className="discount-value-cell">
                            {d.type === 'percent' ? (
                              <span className="discount-pill percent">
                                <Percent size={11} style={{ marginRight: 2 }} />
                                {d.value}%
                              </span>
                            ) : (
                              <span className="discount-pill fixed">
                                <DollarSign size={11} />
                                {formatVnd(d.value)}
                              </span>
                            )}
                            {d.type === 'percent' && d.maxDiscount && (
                              <div className="discount-sub-hint muted">
                                {t.discounts.maxDiscountCap(formatVnd(d.maxDiscount))}
                              </div>
                            )}
                          </div>
                        </td>
                        <td>
                          {d.minOrder > 0 ? (
                            <span>{formatVnd(d.minOrder)}</span>
                          ) : (
                            <span className="muted">0 ₫</span>
                          )}
                        </td>
                        <td>
                          <div className="discount-usage-cell">
                            <strong>{d.usedCount}</strong>
                            {d.maxUses !== null ? (
                              <span className="muted"> / {d.maxUses}</span>
                            ) : (
                              <span className="muted"> (∞)</span>
                            )}
                          </div>
                        </td>
                        <td>
                          {d.expiresAt ? (
                            <div className="discount-expiry-cell">
                              <Calendar size={12} className="muted" />
                              <span>{formatTimestamp(d.expiresAt)}</span>
                            </div>
                          ) : (
                            <span className="muted">{t.discounts.neverExpires}</span>
                          )}
                        </td>
                        <td>
                          <div className="status-toggle-cell">
                            <PillSwitch
                              checked={d.isActive}
                              onChange={() => void handleToggle(d)}
                              ariaLabel={d.isActive ? t.discounts.active : t.discounts.inactive}
                              size="sm"
                            />
                            <span
                              className="status-toggle-label"
                              style={{
                                color: d.isActive ? 'var(--ok)' : 'var(--muted)',
                              }}
                              onClick={() => void handleToggle(d)}
                              title={d.isActive ? t.discounts.active : t.discounts.inactive}
                            >
                              {d.isActive ? t.discounts.active : t.discounts.inactive}
                            </span>
                          </div>
                        </td>
                        <td style={{ textAlign: 'right' }}>
                          <div className="actions-cell">
                            <button
                              type="button"
                              className="btn btn-ghost btn-sm"
                              onClick={() => openEditModal(d)}
                              title={t.discounts.edit}
                            >
                              <Edit2 size={13} />
                            </button>
                            <button
                              type="button"
                              className="btn btn-ghost btn-sm text-danger"
                              onClick={() => handleDeleteClick(d)}
                              title={t.discounts.delete}
                            >
                              <Trash2 size={13} />
                            </button>
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </>
      )}

      {/* Create / Edit Modal (UI/UX PRO MAX) */}
      {modalMode && (
        <div className="modal-backdrop" onClick={closeModal}>
          <div className="modal-card" onClick={(e) => e.stopPropagation()} style={{ maxWidth: 540 }}>
            <div className="modal-header">
              <div className="modal-title-wrap">
                <div className="modal-title-icon">
                  {modalMode === 'create' ? <Tag size={20} /> : <Edit2 size={20} />}
                </div>
                <div>
                  <h3>
                    {modalMode === 'create' ? t.discounts.createTitle : t.discounts.editTitle}
                  </h3>
                  <div className="modal-header-sub">{t.discounts.subtitle}</div>
                </div>
              </div>
              <button type="button" className="modal-close-btn" onClick={closeModal} title={t.common.close}>
                <X size={16} />
              </button>
            </div>

            <form onSubmit={handleSubmit} className="modal-form">
              <div className="modal-body">
                {/* Code */}
                <div className="form-group">
                  <label className="form-label">
                    <span className="form-label-title">
                      <Tag size={13} className="text-accent" />
                      <span>{t.discounts.code} *</span>
                    </span>
                    <span className="form-label-hint">{t.discounts.autoUppercaseHint}</span>
                  </label>
                  <input
                    type="text"
                    className="form-input mono"
                    placeholder={t.discounts.codePlaceholder}
                    value={formCode}
                    onChange={(e) => setFormCode(e.target.value.toUpperCase().replace(/\s+/g, ''))}
                    required
                    maxLength={32}
                    autoFocus
                  />
                </div>

                {/* Discount Type: Full width segmented switcher */}
                <div className="form-group">
                  <label className="form-label">
                    <span className="form-label-title">
                      <Percent size={13} className="text-accent" />
                      <span>{t.discounts.type}</span>
                    </span>
                  </label>
                  <div className="discount-type-segmented" role="group" style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
                    <button
                      type="button"
                      className={`discount-type-btn ${formType === 'percent' ? 'active' : ''}`}
                      onClick={() => setFormType('percent')}
                      style={{ justifyContent: 'center' }}
                    >
                      <Percent size={14} />
                      <span>{t.discounts.typePercent}</span>
                    </button>
                    <button
                      type="button"
                      className={`discount-type-btn ${formType === 'fixed' ? 'active' : ''}`}
                      onClick={() => setFormType('fixed')}
                      style={{ justifyContent: 'center' }}
                    >
                      <Coins size={14} />
                      <span>{t.discounts.typeFixed}</span>
                    </button>
                  </div>
                </div>

                {/* Value & Conditional Secondary Field */}
                {formType === 'percent' ? (
                  <>
                    <div className="form-row-2">
                      <div className="form-group">
                        <label className="form-label">
                          <span className="form-label-title">
                            <Percent size={13} className="text-accent" />
                            <span>{t.discounts.value} (%) *</span>
                          </span>
                          <span className="form-label-hint">1% – 100%</span>
                        </label>
                        <div style={{ position: 'relative' }}>
                          <input
                            type="number"
                            className="form-input"
                            min={1}
                            max={100}
                            step={1}
                            value={formValue}
                            onChange={(e) => setFormValue(Number(e.target.value))}
                            required
                          />
                          <span
                            style={{
                              position: 'absolute',
                              right: 14,
                              top: '50%',
                              transform: 'translateY(-50%)',
                              color: 'var(--muted)',
                              fontWeight: 700,
                              pointerEvents: 'none',
                            }}
                          >
                            %
                          </span>
                        </div>
                      </div>

                      <div className="form-group">
                        <label className="form-label">
                          <span className="form-label-title">
                            <ShieldAlert size={13} className="text-accent" />
                            <span>{t.discounts.maxDiscount}</span>
                          </span>
                          <span className="form-label-hint">VNĐ</span>
                        </label>
                        <input
                          type="number"
                          className="form-input"
                          min={1000}
                          step={5000}
                          placeholder={t.discounts.unlimitedPlaceholder}
                          value={formMaxDiscount}
                          onChange={(e) =>
                            setFormMaxDiscount(e.target.value ? Number(e.target.value) : '')
                          }
                        />
                      </div>
                    </div>

                    <div className="form-row-2">
                      <div className="form-group">
                        <label className="form-label">
                          <span className="form-label-title">
                            <ShoppingBag size={13} className="text-accent" />
                            <span>{t.discounts.minOrder}</span>
                          </span>
                          <span className="form-label-hint">VNĐ</span>
                        </label>
                        <input
                          type="number"
                          className="form-input"
                          min={0}
                          step={5000}
                          placeholder="0 ₫"
                          value={formMinOrder}
                          onChange={(e) => setFormMinOrder(Number(e.target.value))}
                        />
                      </div>

                      <div className="form-group">
                        <label className="form-label">
                          <span className="form-label-title">
                            <Users size={13} className="text-accent" />
                            <span>{t.discounts.maxUses}</span>
                          </span>
                        </label>
                        <input
                          type="number"
                          className="form-input"
                          min={1}
                          step={1}
                          placeholder={t.discounts.unlimitedPlaceholder}
                          value={formMaxUses}
                          onChange={(e) => setFormMaxUses(e.target.value ? Number(e.target.value) : '')}
                        />
                      </div>
                    </div>

                    <div className="form-group">
                      <label className="form-label">
                        <span className="form-label-title">
                          <Calendar size={13} className="text-accent" />
                          <span>{t.discounts.expiresAt}</span>
                        </span>
                      </label>
                      <input
                        type="date"
                        className="form-input"
                        value={formExpiresAt}
                        onChange={(e) => setFormExpiresAt(e.target.value)}
                      />
                    </div>
                  </>
                ) : (
                  <>
                    <div className="form-row-2">
                      <div className="form-group">
                        <label className="form-label">
                          <span className="form-label-title">
                            <Coins size={13} className="text-accent" />
                            <span>{t.discounts.value} (₫) *</span>
                          </span>
                          <span className="form-label-hint">VNĐ</span>
                        </label>
                        <div style={{ position: 'relative' }}>
                          <input
                            type="number"
                            className="form-input"
                            min={1000}
                            step={5000}
                            value={formValue}
                            onChange={(e) => setFormValue(Number(e.target.value))}
                            required
                          />
                          <span
                            style={{
                              position: 'absolute',
                              right: 14,
                              top: '50%',
                              transform: 'translateY(-50%)',
                              color: 'var(--muted)',
                              fontWeight: 700,
                              pointerEvents: 'none',
                            }}
                          >
                            ₫
                          </span>
                        </div>
                      </div>

                      <div className="form-group">
                        <label className="form-label">
                          <span className="form-label-title">
                            <ShoppingBag size={13} className="text-accent" />
                            <span>{t.discounts.minOrder}</span>
                          </span>
                          <span className="form-label-hint">VNĐ</span>
                        </label>
                        <input
                          type="number"
                          className="form-input"
                          min={0}
                          step={5000}
                          placeholder="0 ₫"
                          value={formMinOrder}
                          onChange={(e) => setFormMinOrder(Number(e.target.value))}
                        />
                      </div>
                    </div>

                    <div className="form-row-2">
                      <div className="form-group">
                        <label className="form-label">
                          <span className="form-label-title">
                            <Users size={13} className="text-accent" />
                            <span>{t.discounts.maxUses}</span>
                          </span>
                        </label>
                        <input
                          type="number"
                          className="form-input"
                          min={1}
                          step={1}
                          placeholder={t.discounts.unlimitedPlaceholder}
                          value={formMaxUses}
                          onChange={(e) => setFormMaxUses(e.target.value ? Number(e.target.value) : '')}
                        />
                      </div>

                      <div className="form-group">
                        <label className="form-label">
                          <span className="form-label-title">
                            <Calendar size={13} className="text-accent" />
                            <span>{t.discounts.expiresAt}</span>
                          </span>
                        </label>
                        <input
                          type="date"
                          className="form-input"
                          value={formExpiresAt}
                          onChange={(e) => setFormExpiresAt(e.target.value)}
                        />
                      </div>
                    </div>
                  </>
                )}

                {/* Active switch card */}
                <div
                  className="active-toggle-box"
                  onClick={() => setFormIsActive(!formIsActive)}
                  role="button"
                  tabIndex={0}
                >
                  <div className="active-toggle-info">
                    <div className="active-toggle-title">
                      <CheckCircle2
                        size={16}
                        style={{ color: formIsActive ? 'var(--ok)' : 'var(--muted)' }}
                      />
                      <span>{formIsActive ? t.discounts.active : t.discounts.inactive}</span>
                    </div>
                    <div className="active-toggle-desc">{t.discounts.activeDesc}</div>
                  </div>
                  <PillSwitch
                    checked={formIsActive}
                    onChange={() => setFormIsActive(!formIsActive)}
                    ariaLabel={formIsActive ? t.discounts.active : t.discounts.inactive}
                    size="sm"
                  />
                </div>

                {/* Live sample preview card */}
                <div className="discount-calc-card">
                  <div className="calc-card-head">
                    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                      <Sparkles size={14} />
                      <span>{t.discounts.sampleOrderTitle}</span>
                    </span>
                    {isCapped && formMaxDiscount && (
                      <span className="calc-cap-badge">
                        {t.discounts.maxDiscountCap(formatVnd(Number(formMaxDiscount)))}
                      </span>
                    )}
                  </div>
                  <div className="calc-breakdown-row">
                    <span className="muted">{t.discounts.sampleOriginal} (100.000 ₫):</span>
                    <span className="mono">{formatVnd(sampleOrder)}</span>
                  </div>
                  <div className="calc-breakdown-row">
                    <span className="muted">{t.discounts.sampleDiscountAmt}:</span>
                    <span className="calc-value savings">-{formatVnd(sampleDiscount)}</span>
                  </div>
                  <div className="calc-breakdown-row final">
                    <strong style={{ color: 'var(--heading)' }}>{t.discounts.samplePayAmt}:</strong>
                    <span className="calc-value total">{formatVnd(sampleFinal)}</span>
                  </div>
                </div>
              </div>

              <div className="modal-footer">
                <button
                  type="button"
                  className="btn btn-secondary"
                  onClick={closeModal}
                  disabled={submitting}
                >
                  <X size={14} />
                  <span>{t.discounts.cancelBtn}</span>
                </button>
                <button
                  type="submit"
                  className="btn btn-primary"
                  disabled={submitting}
                >
                  <Check size={14} />
                  <span>{submitting ? t.common.loading : t.discounts.saveBtn}</span>
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Delete Confirmation Modal (UI/UX PRO MAX) */}
      {deletingDiscount && (
        <div className="modal-backdrop" onClick={() => !deleting && setDeletingDiscount(null)}>
          <div
            className="modal-card"
            onClick={(e) => e.stopPropagation()}
            style={{ maxWidth: 440 }}
          >
            <div className="delete-confirm-body">
              <div className="delete-confirm-icon">
                <AlertTriangle size={28} />
              </div>
              <div className="delete-confirm-title">{t.discounts.deleteTitle}</div>
              <div className="delete-confirm-desc">
                {t.discounts.deletePrompt(deletingDiscount.code)}
              </div>
            </div>
            <div className="modal-footer" style={{ justifyContent: 'center', marginTop: 16 }}>
              <button
                type="button"
                className="btn btn-secondary"
                onClick={() => setDeletingDiscount(null)}
                disabled={deleting}
              >
                <X size={14} />
                <span>{t.discounts.cancelBtn}</span>
              </button>
              <button
                type="button"
                className="btn btn-danger"
                onClick={() => void confirmDelete()}
                disabled={deleting}
              >
                <Trash2 size={14} />
                <span>{deleting ? t.common.loading : t.discounts.deleteBtn}</span>
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
