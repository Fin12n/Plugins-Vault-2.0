import { useState } from 'react';
import { Trophy, Medal, Crown, Copy, Check, Users, DollarSign, Flame, Sparkles, User, RotateCcw, X, AlertTriangle } from 'lucide-react';
import { Pager } from '../components/pager.js';
import { useToast } from '../components/toast.js';
import { EmptyState, ErrorState, RefreshButton, TableSkeleton, TimeAgo } from '../components/ui.js';
import { useI18n } from '../i18n/context.js';
import { formatCoins, formatVnd } from '../i18n/vi.js';
import { useAsync } from '../lib/use-async.js';

type DiscordUserProfile = {
  id: string;
  username: string;
  displayName: string;
  avatarUrl: string | null;
};

type LeaderboardEntry = {
  rank: number;
  discordUserId: string;
  userProfile?: DiscordUserProfile;
  totalDeposited: number;
  coins: number;
  bankDeposited: number;
  cardDeposited: number;
  otherDeposited: number;
  topupCount: number;
  currentBalance: number;
  lastTopupAt: number;
};

type LeaderboardStats = {
  overallTotal: number;
  overallUsers: number;
  averageDeposit: number;
  maxSingleDeposit: number;
};

type LeaderboardResponse = {
  items: LeaderboardEntry[];
  stats: LeaderboardStats;
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
  resetAt?: number | null;
};

type Timeframe = 'all' | 'month' | 'week' | 'today';

function renderPodiumAvatar(userProfile?: DiscordUserProfile, frameClass = '') {
  if (userProfile?.avatarUrl) {
    return <img src={userProfile.avatarUrl} alt={userProfile.displayName} className="podium-avatar-img" />;
  }
  const isSnowflake = !userProfile?.displayName || /^\d{15,22}$/.test(userProfile.displayName);
  if (!isSnowflake && userProfile?.displayName) {
    return (
      <div className={`podium-avatar-placeholder ${frameClass}`}>
        {userProfile.displayName[0]?.toUpperCase()}
      </div>
    );
  }
  return (
    <div className={`podium-avatar-placeholder ${frameClass}`}>
      <User size={32} />
    </div>
  );
}

function renderTableAvatar(userProfile?: DiscordUserProfile) {
  if (userProfile?.avatarUrl) {
    return <img src={userProfile.avatarUrl} alt={userProfile.displayName} className="user-avatar-thumb" />;
  }
  const isSnowflake = !userProfile?.displayName || /^\d{15,22}$/.test(userProfile.displayName);
  if (!isSnowflake && userProfile?.displayName) {
    return (
      <div className="user-avatar-thumb placeholder">
        {userProfile.displayName[0]?.toUpperCase()}
      </div>
    );
  }
  return (
    <div className="user-avatar-thumb placeholder">
      <User size={16} />
    </div>
  );
}

function getDisplayName(userProfile?: DiscordUserProfile, discordUserId = '', defaultLabel = 'Discord User') {
  if (userProfile?.displayName && !/^\d{15,22}$/.test(userProfile.displayName)) {
    return userProfile.displayName;
  }
  return `${defaultLabel} #${discordUserId.slice(-4)}`;
}

function getSubUsername(userProfile?: DiscordUserProfile, discordUserId = '') {
  if (userProfile?.username && !/^\d{15,22}$/.test(userProfile.username)) {
    return `@${userProfile.username}`;
  }
  return discordUserId;
}

export function LeaderboardPage() {
  const { t, lang } = useI18n();
  const [timeframe, setTimeframe] = useState<Timeframe>('all');
  const [page, setPage] = useState(1);
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const toast = useToast();

  const query = useAsync<LeaderboardResponse>(
    `/api/leaderboard?timeframe=${timeframe}&page=${page}&pageSize=25`,
  );

  const copyDiscordId = async (id: string) => {
    try {
      await navigator.clipboard.writeText(id);
      setCopiedId(id);
      toast.success(t.leaderboard.toastCopied);
      setTimeout(() => setCopiedId(null), 2000);
    } catch {
      // Fallback
    }
  };

  const [showResetModal, setShowResetModal] = useState(false);
  const [resetting, setResetting] = useState(false);

  const handleConfirmReset = async () => {
    setResetting(true);
    try {
      const res = await fetch('/api/leaderboard/reset', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ reset: true }),
      });
      if (!res.ok) throw new Error('Reset failed');
      toast.success(t.leaderboard.toastResetSuccess);
      setShowResetModal(false);
      void query.reload();
    } catch {
      toast.error(t.leaderboard.toastResetError);
    } finally {
      setResetting(false);
    }
  };

  const handleUndoReset = async () => {
    if (!confirm(t.leaderboard.confirmRestorePrompt)) return;
    setResetting(true);
    try {
      const res = await fetch('/api/leaderboard/reset', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ undo: true }),
      });
      if (!res.ok) throw new Error('Undo failed');
      toast.success(t.leaderboard.toastRestoreSuccess);
      void query.reload();
    } catch {
      toast.error(t.leaderboard.toastRestoreError);
    } finally {
      setResetting(false);
    }
  };

  const handleTimeframeChange = (tf: Timeframe) => {
    setTimeframe(tf);
    setPage(1);
  };

  const data = query.data;
  const items = data?.items ?? [];
  const top1 = items[0];
  const top2 = items[1];
  const top3 = items[2];

  return (
    <>
      <div className="content-head">
        <div>
          <h2>{t.leaderboard.heading}</h2>
          <p className="muted" style={{ marginTop: 4 }}>
            {t.leaderboard.subtitle}
          </p>
        </div>
        <div className="button-row">
          <button
            type="button"
            className="btn btn-secondary danger-hover"
            onClick={() => setShowResetModal(true)}
            title={t.leaderboard.resetBtnTitle}
            style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}
          >
            <RotateCcw size={14} />
            <span>{t.leaderboard.resetBtn}</span>
          </button>
          <RefreshButton onClick={() => void query.reload()} busy={query.refreshing} />
        </div>
      </div>

      {/* Active Reset Notification Banner */}
      {data?.resetAt ? (
        <div
          className="leaderboard-reset-banner"
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: 12,
            padding: '12px 18px',
            marginBottom: 20,
            background: 'rgba(56, 189, 248, 0.08)',
            border: '1px solid rgba(56, 189, 248, 0.25)',
            borderRadius: 'var(--radius)',
            flexWrap: 'wrap',
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <RotateCcw size={16} className="text-accent" style={{ flexShrink: 0 }} />
            <div>
              <strong style={{ color: 'var(--heading)' }}>{t.leaderboard.resetBannerTitle}</strong>
              <span className="muted" style={{ marginLeft: 8, fontSize: 13 }}>
                {t.leaderboard.resetBannerFrom(new Date(data.resetAt * 1000).toLocaleString(lang === 'en' ? 'en-US' : 'vi-VN'))}
              </span>
            </div>
          </div>
          <button
            type="button"
            className="btn btn-secondary btn-sm"
            onClick={handleUndoReset}
            disabled={resetting}
            style={{ fontSize: 12.5, padding: '4px 12px' }}
          >
            {t.leaderboard.restoreOldHistory}
          </button>
        </div>
      ) : null}

      {/* Timeframe Filter Tabs */}
      <div className="leaderboard-filter-row">
        <div className="timeframe-pill-group" role="tablist">
          <button
            type="button"
            className={`timeframe-pill ${timeframe === 'all' ? 'active' : ''}`}
            onClick={() => handleTimeframeChange('all')}
            role="tab"
            aria-selected={timeframe === 'all'}
          >
            <Trophy size={14} />
            <span>{t.leaderboard.allTime}</span>
          </button>
          <button
            type="button"
            className={`timeframe-pill ${timeframe === 'month' ? 'active' : ''}`}
            onClick={() => handleTimeframeChange('month')}
            role="tab"
            aria-selected={timeframe === 'month'}
          >
            <span>{t.leaderboard.thisMonth}</span>
          </button>
          <button
            type="button"
            className={`timeframe-pill ${timeframe === 'week' ? 'active' : ''}`}
            onClick={() => handleTimeframeChange('week')}
            role="tab"
            aria-selected={timeframe === 'week'}
          >
            <span>{t.leaderboard.thisWeek}</span>
          </button>
          <button
            type="button"
            className={`timeframe-pill ${timeframe === 'today' ? 'active' : ''}`}
            onClick={() => handleTimeframeChange('today')}
            role="tab"
            aria-selected={timeframe === 'today'}
          >
            <span>{t.leaderboard.today}</span>
          </button>
        </div>
      </div>

      {query.error && <ErrorState message={query.error} onRetry={() => void query.reload()} />}
      {query.loading && <TableSkeleton rows={6} cols={6} />}

      {data && !query.error && (
        <>
          {/* Summary Stats Grid */}
          <div className="stat-grid" style={{ marginBottom: 24 }}>
            <div className="stat">
              <div className="stat-label-wrap">
                <DollarSign size={16} className="stat-icon-accent" />
                <span className="stat-label">{t.leaderboard.statTotal}</span>
              </div>
              <div className="stat-num">{formatVnd(data.stats.overallTotal)}</div>
            </div>
            <div className="stat">
              <div className="stat-label-wrap">
                <Users size={16} className="stat-icon-accent" />
                <span className="stat-label">{t.leaderboard.statUsers}</span>
              </div>
              <div className="stat-num">{data.stats.overallUsers.toLocaleString()}</div>
            </div>
            <div className="stat">
              <div className="stat-label-wrap">
                <Sparkles size={16} className="stat-icon-accent" />
                <span className="stat-label">{t.leaderboard.statAvg}</span>
              </div>
              <div className="stat-num">{formatVnd(data.stats.averageDeposit)}</div>
            </div>
            <div className="stat">
              <div className="stat-label-wrap">
                <Flame size={16} className="stat-icon-accent" />
                <span className="stat-label">{t.leaderboard.statMax}</span>
              </div>
              <div className="stat-num">{formatVnd(data.stats.maxSingleDeposit)}</div>
            </div>
          </div>

          {/* Top 3 Podium (Shown on first page when at least 1 depositor exists) */}
          {page === 1 && items.length > 0 && (
            <div className="podium-container">
              {/* Runner Up: Rank #2 */}
              <div className={`podium-card podium-rank-2 ${!top2 ? 'podium-empty' : ''}`}>
                {top2 ? (
                  <>
                    <div className="podium-avatar-wrap silver-frame">
                      {renderPodiumAvatar(top2.userProfile, 'silver')}
                    </div>
                    <div className="podium-rank-tag">#2 {t.leaderboard.podium2}</div>
                    <div className="podium-name" title={getDisplayName(top2.userProfile, top2.discordUserId, t.leaderboard.unknownUser)}>
                      {getDisplayName(top2.userProfile, top2.discordUserId, t.leaderboard.unknownUser)}
                    </div>
                    <div className="podium-user mono">{getSubUsername(top2.userProfile, top2.discordUserId)}</div>
                    <div className="podium-amount">{formatVnd(top2.totalDeposited)}</div>
                    <div className="podium-coins">{formatCoins(top2.coins)} coins</div>
                    <div className="podium-count muted">{top2.topupCount} {t.leaderboard.topupCount.toLowerCase()}</div>
                  </>
                ) : (
                  <div className="podium-placeholder">—</div>
                )}
                <div className="podium-pillar pillar-silver">
                  <span>2</span>
                </div>
              </div>

              {/* Champion: Rank #1 */}
              <div className={`podium-card podium-rank-1 ${!top1 ? 'podium-empty' : ''}`}>
                {top1 ? (
                  <>
                    <div className="podium-avatar-wrap gold-frame">
                      <div className="podium-crown">
                        <Crown size={34} />
                      </div>
                      {renderPodiumAvatar(top1.userProfile, 'gold')}
                    </div>
                    <div className="podium-rank-tag gold">#1 {t.leaderboard.podium1}</div>
                    <div className="podium-name gold" title={getDisplayName(top1.userProfile, top1.discordUserId, t.leaderboard.unknownUser)}>
                      {getDisplayName(top1.userProfile, top1.discordUserId, t.leaderboard.unknownUser)}
                    </div>
                    <div className="podium-user mono highlight">{getSubUsername(top1.userProfile, top1.discordUserId)}</div>
                    <div className="podium-amount gold">{formatVnd(top1.totalDeposited)}</div>
                    <div className="podium-coins gold">{formatCoins(top1.coins)} coins</div>
                    <div className="podium-count muted">{top1.topupCount} {t.leaderboard.topupCount.toLowerCase()}</div>
                  </>
                ) : (
                  <div className="podium-placeholder">—</div>
                )}
                <div className="podium-pillar pillar-gold">
                  <span>1</span>
                </div>
              </div>

              {/* Third Place: Rank #3 */}
              <div className={`podium-card podium-rank-3 ${!top3 ? 'podium-empty' : ''}`}>
                {top3 ? (
                  <>
                    <div className="podium-avatar-wrap bronze-frame">
                      {renderPodiumAvatar(top3.userProfile, 'bronze')}
                    </div>
                    <div className="podium-rank-tag">#3 {t.leaderboard.podium3}</div>
                    <div className="podium-name" title={getDisplayName(top3.userProfile, top3.discordUserId, t.leaderboard.unknownUser)}>
                      {getDisplayName(top3.userProfile, top3.discordUserId, t.leaderboard.unknownUser)}
                    </div>
                    <div className="podium-user mono">{getSubUsername(top3.userProfile, top3.discordUserId)}</div>
                    <div className="podium-amount">{formatVnd(top3.totalDeposited)}</div>
                    <div className="podium-coins">{formatCoins(top3.coins)} coins</div>
                    <div className="podium-count muted">{top3.topupCount} {t.leaderboard.topupCount.toLowerCase()}</div>
                  </>
                ) : (
                  <div className="podium-placeholder">—</div>
                )}
                <div className="podium-pillar pillar-bronze">
                  <span>3</span>
                </div>
              </div>
            </div>
          )}

          {/* Full Rankings Table */}
          {items.length === 0 ? (
            <EmptyState
              title={t.leaderboard.emptyTitle}
              hint={t.leaderboard.emptyHint}
            />
          ) : (
            <div className={`panel flush${query.refreshing ? ' refreshing' : ''}`} style={{ marginTop: 24 }}>
              <div className="table-wrap">
                <table>
                  <thead>
                    <tr>
                      <th style={{ width: 64, textAlign: 'center' }}>{t.leaderboard.rank}</th>
                      <th>{t.leaderboard.user}</th>
                      <th style={{ textAlign: 'right' }}>{t.leaderboard.totalDeposited}</th>
                      <th style={{ textAlign: 'right' }}>{t.leaderboard.coins}</th>
                      <th style={{ textAlign: 'right' }}>{t.leaderboard.bankDeposited}</th>
                      <th style={{ textAlign: 'right' }}>{t.leaderboard.cardDeposited}</th>
                      <th style={{ textAlign: 'center' }}>{t.leaderboard.topupCount}</th>
                      <th style={{ textAlign: 'right' }}>{t.leaderboard.currentBalance}</th>
                      <th style={{ textAlign: 'right' }}>{t.leaderboard.lastTopup}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {items.map((item) => (
                      <tr key={item.discordUserId} className={item.rank <= 3 ? `rank-row-${item.rank}` : ''}>
                        <td style={{ textAlign: 'center' }}>
                          <span className={`rank-badge rank-${item.rank <= 3 ? item.rank : 'other'}`}>
                            {item.rank === 1 && '🥇'}
                            {item.rank === 2 && '🥈'}
                            {item.rank === 3 && '🥉'}
                            {item.rank > 3 && item.rank}
                          </span>
                        </td>
                        <td>
                          <div className="user-profile-cell">
                            {renderTableAvatar(item.userProfile)}
                            <div className="user-text-info">
                              <div className="user-display-name">
                                {getDisplayName(item.userProfile, item.discordUserId, t.leaderboard.unknownUser)}
                              </div>
                              <div className="user-sub-id mono muted">
                                {getSubUsername(item.userProfile, item.discordUserId)}
                              </div>
                            </div>
                            <button
                              type="button"
                              className="copy-id-btn"
                              title={t.leaderboard.copyId}
                              onClick={() => void copyDiscordId(item.discordUserId)}
                            >
                              {copiedId === item.discordUserId ? (
                                <Check size={14} className="copied" />
                              ) : (
                                <Copy size={14} />
                              )}
                            </button>
                          </div>
                        </td>
                        <td className="right nowrap">
                          <strong className={item.rank === 1 ? 'gold-text' : undefined}>
                            {formatVnd(item.totalDeposited)}
                          </strong>
                        </td>
                        <td className="right nowrap">{formatCoins(item.coins)}</td>
                        <td className="right nowrap muted">{formatVnd(item.bankDeposited)}</td>
                        <td className="right nowrap muted">{formatVnd(item.cardDeposited)}</td>
                        <td className="right nowrap" style={{ textAlign: 'center' }}>{item.topupCount}</td>
                        <td className="right nowrap">{formatVnd(item.currentBalance)}</td>
                        <td className="muted nowrap" style={{ textAlign: 'right' }}>
                          <TimeAgo unixSeconds={item.lastTopupAt} />
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <Pager page={data.page} totalPages={data.totalPages} onChange={setPage} />
            </div>
          )}
        </>
      )}

      {/* Confirmation Modal for Reset Leaderboard */}
      {showResetModal && (
        <div className="modal-backdrop" onClick={() => setShowResetModal(false)}>
          <div className="modal-card" onClick={(e) => e.stopPropagation()} style={{ maxWidth: 480 }}>
            <div className="modal-header">
              <div className="modal-title-wrap">
                <div className="modal-title-icon danger">
                  <RotateCcw size={20} />
                </div>
                <div>
                  <h3>{t.leaderboard.resetModalTitle}</h3>
                  <div className="modal-header-sub">{t.leaderboard.resetModalSub}</div>
                </div>
              </div>
              <button
                type="button"
                className="modal-close-btn"
                onClick={() => setShowResetModal(false)}
                title={t.common.close}
              >
                <X size={16} />
              </button>
            </div>
            <div className="modal-body" style={{ padding: '20px 24px' }}>
              <p style={{ lineHeight: 1.6, color: 'var(--heading)' }}>
                {t.leaderboard.resetModalConfirmText}
              </p>
              <div
                style={{
                  padding: '12px 16px',
                  background: 'rgba(56, 189, 248, 0.08)',
                  border: '1px solid rgba(56, 189, 248, 0.2)',
                  borderRadius: 'var(--radius)',
                  fontSize: '13px',
                  color: 'var(--text)',
                  marginTop: 8,
                }}
              >
                💡 <strong>{lang === 'en' ? 'Note:' : 'Lưu ý:'}</strong> {t.leaderboard.resetModalNote}
              </div>
            </div>
            <div className="modal-footer">
              <button
                type="button"
                className="btn btn-secondary"
                onClick={() => setShowResetModal(false)}
                disabled={resetting}
              >
                {t.leaderboard.cancelBtn}
              </button>
              <button
                type="button"
                className="btn btn-danger"
                onClick={handleConfirmReset}
                disabled={resetting}
              >
                <RotateCcw size={14} />
                <span>{resetting ? t.leaderboard.resettingBtn : t.leaderboard.confirmResetBtn}</span>
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
