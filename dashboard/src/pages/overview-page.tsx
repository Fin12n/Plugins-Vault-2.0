import { useState } from 'react';
import {
  DollarSign,
  Landmark,
  CreditCard,
  Activity,
  Calendar,
  Layers,
  TrendingUp,
  BarChart3,
  AreaChart,
  User,
  Sparkles,
} from 'lucide-react';
import { ErrorState, RefreshButton, TableSkeleton, TimeAgo } from '../components/ui.js';
import { useI18n } from '../i18n/context.js';
import { formatVnd } from '../i18n/vi.js';
import { useAsync } from '../lib/use-async.js';

type OverviewTimeframe = '7d' | '30d' | 'this_month' | 'last_month' | 'custom' | 'all';
type OverviewTypeFilter = 'all' | 'bank' | 'card';
type ChartMode = 'area' | 'bar';

type RevenueTimelinePoint = {
  date: string;
  label: string;
  bank: number;
  card: number;
  other: number;
  total: number;
  count: number;
};

type OverviewSummary = {
  totalRevenue: number;
  bankRevenue: number;
  cardRevenue: number;
  otherRevenue: number;
  totalTransactions: number;
  bankTransactions: number;
  cardTransactions: number;
  activeUsers: number;
  averageDeposit: number;
};

type OverviewBreakdown = {
  bankPercent: number;
  cardPercent: number;
  otherPercent: number;
};

type DiscordUserProfile = {
  id: string;
  username: string;
  displayName: string;
  avatarUrl: string | null;
};

type TopTransaction = {
  id: number;
  discordUserId: string;
  delta: number;
  kind: string;
  note: string;
  createdAt: number;
  userProfile?: DiscordUserProfile;
};

type OverviewResponse = {
  summary: OverviewSummary;
  breakdown: OverviewBreakdown;
  timeline: RevenueTimelinePoint[];
  recentTopups: TopTransaction[];
  customFrom?: string;
  customTo?: string;
};

export function OverviewPage() {
  const { t, lang } = useI18n();
  const [timeframe, setTimeframe] = useState<OverviewTimeframe>('30d');
  const [typeFilter, setTypeFilter] = useState<OverviewTypeFilter>('all');
  const [chartMode, setChartMode] = useState<ChartMode>('area');
  const [hoveredIndex, setHoveredIndex] = useState<number | null>(null);

  const [customFrom, setCustomFrom] = useState('');
  const [customTo, setCustomTo] = useState('');

  let queryUrl = `/api/overview?timeframe=${timeframe}&type=${typeFilter}`;
  if (timeframe === 'custom') {
    if (customFrom) queryUrl += `&from=${customFrom}`;
    if (customTo) queryUrl += `&to=${customTo}`;
  }

  const query = useAsync<OverviewResponse>(queryUrl);

  const data = query.data;
  const timeline = data?.timeline ?? [];

  // SVG Chart sizing & coordinates
  const svgWidth = 840;
  const svgHeight = 280;
  const padLeft = 70;
  const padRight = 30;
  const padTop = 25;
  const padBottom = 40;
  const chartW = svgWidth - padLeft - padRight;
  const chartH = svgHeight - padTop - padBottom;

  const maxVal = Math.max(
    ...timeline.map((p) => {
      if (typeFilter === 'bank') return p.bank;
      if (typeFilter === 'card') return p.card;
      return p.total;
    }),
    100000,
  );

  // Y-axis tick marks
  const yTicks = [0, maxVal * 0.25, maxVal * 0.5, maxVal * 0.75, maxVal];

  // Point coordinates
  const points = timeline.map((p, idx) => {
    const x =
      timeline.length <= 1
        ? padLeft + chartW / 2
        : padLeft + (idx / (timeline.length - 1)) * chartW;
    const val = typeFilter === 'bank' ? p.bank : typeFilter === 'card' ? p.card : p.total;
    const y = padTop + chartH - (val / maxVal) * chartH;
    const bankY = padTop + chartH - (p.bank / maxVal) * chartH;
    const cardY = padTop + chartH - (p.card / maxVal) * chartH;
    return { ...p, x, y, bankY, cardY, val };
  });

  // SVG path generation
  const buildSmoothPath = (pts: { x: number; y: number }[]) => {
    if (pts.length === 0) return '';
    const first = pts[0];
    if (!first) return '';
    if (pts.length === 1) return `M ${first.x} ${first.y}`;
    let d = `M ${first.x},${first.y}`;
    for (let i = 0; i < pts.length - 1; i++) {
      const p0 = pts[i];
      const p1 = pts[i + 1];
      if (!p0 || !p1) continue;
      const cx = (p0.x + p1.x) / 2;
      d += ` C ${cx},${p0.y} ${cx},${p1.y} ${p1.x},${p1.y}`;
    }
    return d;
  };

  const linePath = buildSmoothPath(points);
  const bankPath = buildSmoothPath(points.map((p) => ({ x: p.x, y: p.bankY })));
  const cardPath = buildSmoothPath(points.map((p) => ({ x: p.x, y: p.cardY })));

  const firstPoint = points[0];
  const lastPoint = points[points.length - 1];
  const areaPath =
    firstPoint && lastPoint && points.length > 0
      ? `${linePath} L ${lastPoint.x},${padTop + chartH} L ${firstPoint.x},${padTop + chartH} Z`
      : '';

  const hoveredPoint = hoveredIndex !== null ? points[hoveredIndex] : null;

  // Bar width calculation
  const barWidth = Math.max(6, Math.min(28, (chartW / Math.max(1, points.length)) * 0.55));

  // Quick stats calculation
  const peakPoint = [...points].sort((a, b) => b.val - a.val)[0];
  const totalInWindow = points.reduce((acc, p) => acc + p.val, 0);
  const avgDaily = Math.round(totalInWindow / Math.max(1, points.length));

  return (
    <>
      <div className="content-head">
        <div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <h2 style={{ margin: 0 }}>{t.overview.heading}</h2>
            <span
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: 5,
                fontSize: 11,
                fontWeight: 700,
                padding: '2px 8px',
                borderRadius: '999px',
                background: 'rgba(16, 185, 129, 0.12)',
                color: '#10b981',
                border: '1px solid rgba(16, 185, 129, 0.25)',
              }}
            >
              <span
                style={{
                  width: 6,
                  height: 6,
                  borderRadius: '50%',
                  background: '#10b981',
                  boxShadow: '0 0 6px #10b981',
                }}
              />
              {t.overview.systemLive}
            </span>
          </div>
          <p className="muted" style={{ marginTop: 4 }}>
            {t.overview.subtitle}
          </p>
        </div>
        <div className="button-row">
          <RefreshButton onClick={() => void query.reload()} busy={query.refreshing} />
        </div>
      </div>

      {/* Filter Toolbar */}
      <div className="overview-filter-bar">
        {/* Timeframe selector */}
        <div className="timeframe-pill-group" role="tablist">
          <button
            type="button"
            className={`timeframe-pill ${timeframe === '7d' ? 'active' : ''}`}
            onClick={() => setTimeframe('7d')}
          >
            <Calendar size={13} />
            <span>{t.overview.sevenDays}</span>
          </button>
          <button
            type="button"
            className={`timeframe-pill ${timeframe === '30d' ? 'active' : ''}`}
            onClick={() => setTimeframe('30d')}
          >
            <span>{t.overview.thirtyDays}</span>
          </button>
          <button
            type="button"
            className={`timeframe-pill ${timeframe === 'this_month' ? 'active' : ''}`}
            onClick={() => setTimeframe('this_month')}
          >
            <span>{t.overview.thisMonth}</span>
          </button>
          <button
            type="button"
            className={`timeframe-pill ${timeframe === 'last_month' ? 'active' : ''}`}
            onClick={() => setTimeframe('last_month')}
          >
            <span>{t.overview.lastMonth}</span>
          </button>
          <button
            type="button"
            className={`timeframe-pill ${timeframe === 'all' ? 'active' : ''}`}
            onClick={() => setTimeframe('all')}
          >
            <span>{t.overview.allTime}</span>
          </button>
          <button
            type="button"
            className={`timeframe-pill ${timeframe === 'custom' ? 'active' : ''}`}
            onClick={() => {
              setTimeframe('custom');
              if (!customFrom) {
                const now = new Date();
                const past = new Date(Date.now() - 14 * 86400 * 1000);
                setCustomTo(now.toISOString().split('T')[0] ?? '');
                setCustomFrom(past.toISOString().split('T')[0] ?? '');
              }
            }}
          >
            <Calendar size={13} />
            <span>{t.overview.customRange}</span>
          </button>
        </div>

        {/* Channel selector */}
        <div className="timeframe-pill-group channel-filter" role="tablist">
          <button
            type="button"
            className={`timeframe-pill ${typeFilter === 'all' ? 'active' : ''}`}
            onClick={() => setTypeFilter('all')}
          >
            <Layers size={13} />
            <span>{t.overview.allTypes}</span>
          </button>
          <button
            type="button"
            className={`timeframe-pill ${typeFilter === 'bank' ? 'active' : ''}`}
            onClick={() => setTypeFilter('bank')}
          >
            <Landmark size={13} />
            <span>{t.overview.bankOnly}</span>
          </button>
          <button
            type="button"
            className={`timeframe-pill ${typeFilter === 'card' ? 'active' : ''}`}
            onClick={() => setTypeFilter('card')}
          >
            <CreditCard size={13} />
            <span>{t.overview.cardOnly}</span>
          </button>
        </div>
      </div>

      {/* Custom Date Range Filter Inputs */}
      {timeframe === 'custom' && (
        <div
          className="custom-date-range-bar"
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 12,
            flexWrap: 'wrap',
            padding: '12px 18px',
            background: 'var(--surface-muted)',
            borderRadius: 'var(--radius)',
            border: '1px solid var(--border)',
            boxShadow: 'var(--nm-pressed-sm)',
            marginBottom: 20,
            marginTop: -8,
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <Calendar size={14} className="text-accent" />
            <span style={{ fontSize: 13, fontWeight: 650, color: 'var(--heading)' }}>
              {t.overview.filterByDate}
            </span>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <label style={{ fontSize: 12.5, color: 'var(--muted)', display: 'flex', alignItems: 'center', gap: 6 }}>
              <span>{t.overview.dateFrom}</span>
              <input
                type="date"
                className="form-input"
                style={{ height: 34, padding: '0 10px', fontSize: 12.5, width: 140 }}
                value={customFrom}
                onChange={(e) => setCustomFrom(e.target.value)}
              />
            </label>
            <span style={{ color: 'var(--muted)' }}>—</span>
            <label style={{ fontSize: 12.5, color: 'var(--muted)', display: 'flex', alignItems: 'center', gap: 6 }}>
              <span>{t.overview.dateTo}</span>
              <input
                type="date"
                className="form-input"
                style={{ height: 34, padding: '0 10px', fontSize: 12.5, width: 140 }}
                value={customTo}
                onChange={(e) => setCustomTo(e.target.value)}
              />
            </label>
          </div>
          {customFrom && (
            <div style={{ fontSize: 12, color: 'var(--accent)', fontWeight: 600, marginLeft: 'auto' }}>
              📅 {customTo
                ? t.overview.rangeBadge(customFrom.split('-').reverse().join('/'), customTo.split('-').reverse().join('/'))
                : t.overview.rangeBadgeSingle(customFrom.split('-').reverse().join('/'))}
            </div>
          )}
        </div>
      )}

      {query.error && <ErrorState message={query.error} onRetry={() => void query.reload()} />}
      {query.loading && <TableSkeleton rows={8} cols={4} />}

      {data && !query.error && (
        <>
          {/* Top 4 KPI Cards */}
          <div className="stat-grid" style={{ marginBottom: 24 }}>
            {/* Total Revenue */}
            <div className="stat stat-primary-glow">
              <div className="stat-label-wrap">
                <DollarSign size={16} className="stat-icon-accent" />
                <span className="stat-label">{t.overview.totalRevenue}</span>
              </div>
              <div className="stat-num gold-text">{formatVnd(data.summary.totalRevenue)}</div>
              <div className="stat-subtext muted">
                <TrendingUp size={13} style={{ display: 'inline', verticalAlign: 'middle', marginRight: 4 }} />
                {data.summary.totalTransactions} {t.overview.transactionsCount}
              </div>
            </div>

            {/* Bank Revenue */}
            <div className="stat stat-bank-glow">
              <div className="stat-label-wrap">
                <Landmark size={16} className="stat-icon-bank" />
                <span className="stat-label">{t.overview.bankRevenue}</span>
                <span className="channel-pill bank">{data.breakdown.bankPercent}%</span>
              </div>
              <div className="stat-num bank-text">{formatVnd(data.summary.bankRevenue)}</div>
              <div className="stat-subtext muted">
                {data.summary.bankTransactions} {t.overview.transactionsCount}
              </div>
            </div>

            {/* Card Revenue */}
            <div className="stat stat-card-glow">
              <div className="stat-label-wrap">
                <CreditCard size={16} className="stat-icon-card" />
                <span className="stat-label">{t.overview.cardRevenue}</span>
                <span className="channel-pill card">{data.breakdown.cardPercent}%</span>
              </div>
              <div className="stat-num card-text">{formatVnd(data.summary.cardRevenue)}</div>
              <div className="stat-subtext muted">
                {data.summary.cardTransactions} {t.overview.transactionsCount}
              </div>
            </div>

            {/* Average Deposit & Users */}
            <div className="stat">
              <div className="stat-label-wrap">
                <Activity size={16} className="stat-icon-accent" />
                <span className="stat-label">{t.overview.avgTransaction}</span>
              </div>
              <div className="stat-num">{formatVnd(data.summary.averageDeposit)}</div>
              <div className="stat-subtext muted">
                {data.summary.activeUsers} {t.overview.depositorsCount}
              </div>
            </div>
          </div>

          {/* Revenue Chart Section */}
          <div className="panel" style={{ marginBottom: 24, padding: '22px 20px 16px' }}>
            <div
              className="panel-head"
              style={{
                marginBottom: 16,
                display: 'flex',
                alignItems: 'flex-start',
                justifyContent: 'space-between',
                flexWrap: 'wrap',
                gap: 12,
              }}
            >
              <div>
                <h3 style={{ margin: 0, fontSize: '1.05rem', fontWeight: 600 }}>
                  {t.overview.revenueTimeline}
                </h3>
                <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginTop: 4 }}>
                  <span className="muted" style={{ fontSize: '0.85rem' }}>
                    {typeFilter === 'all'
                      ? t.overview.chartTimelineAggregated
                      : typeFilter === 'bank'
                      ? t.overview.chartTimelineBank
                      : t.overview.chartTimelineCard}
                  </span>
                  {peakPoint && peakPoint.val > 0 && (
                    <span
                      style={{
                        fontSize: 11,
                        padding: '1px 8px',
                        borderRadius: '999px',
                        background: 'rgba(245, 158, 11, 0.12)',
                        color: '#f59e0b',
                        fontWeight: 600,
                      }}
                    >
                      {t.overview.peakDay}: {peakPoint.label} ({formatVnd(peakPoint.val)})
                    </span>
                  )}
                </div>
              </div>

              <div className="chart-header-actions">
                {/* Chart Style Toggle: Area vs Bar */}
                <div className="chart-type-toggle-group">
                  <button
                    type="button"
                    className={`chart-type-btn ${chartMode === 'area' ? 'active' : ''}`}
                    onClick={() => setChartMode('area')}
                    title={t.overview.chartTypeArea}
                  >
                    <AreaChart size={13} />
                    <span>{t.overview.chartTypeArea}</span>
                  </button>
                  <button
                    type="button"
                    className={`chart-type-btn ${chartMode === 'bar' ? 'active' : ''}`}
                    onClick={() => setChartMode('bar')}
                    title={t.overview.chartTypeBar}
                  >
                    <BarChart3 size={13} />
                    <span>{t.overview.chartTypeBar}</span>
                  </button>
                </div>

                {/* Legends */}
                <div className="chart-legend-row">
                  <span className="chart-legend-item">
                    <span className="legend-dot total-dot" />
                    <span>{t.overview.totalLabel}</span>
                  </span>
                  <span className="chart-legend-item">
                    <span className="legend-dot bank-dot" />
                    <span>{t.overview.bankShort}</span>
                  </span>
                  <span className="chart-legend-item">
                    <span className="legend-dot card-dot" />
                    <span>{t.overview.cardShort}</span>
                  </span>
                </div>
              </div>
            </div>

            {timeline.length === 0 ? (
              <div className="empty-chart-box">
                <span className="muted">{t.overview.noData}</span>
              </div>
            ) : (
              <div className="svg-chart-container">
                <svg
                  viewBox={`0 0 ${svgWidth} ${svgHeight}`}
                  className="revenue-svg"
                  preserveAspectRatio="none"
                >
                  <defs>
                    <linearGradient id="totalAreaGrad" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="0%" stopColor="#38bdf8" stopOpacity="0.32" />
                      <stop offset="60%" stopColor="#38bdf8" stopOpacity="0.08" />
                      <stop offset="100%" stopColor="#38bdf8" stopOpacity="0.0" />
                    </linearGradient>
                    <linearGradient id="bankGrad" x1="0" y1="0" x2="1" y2="0">
                      <stop offset="0%" stopColor="#06b6d4" />
                      <stop offset="100%" stopColor="#0ea5e9" />
                    </linearGradient>
                    <linearGradient id="cardGrad" x1="0" y1="0" x2="1" y2="0">
                      <stop offset="0%" stopColor="#f97316" />
                      <stop offset="100%" stopColor="#fb923c" />
                    </linearGradient>
                    <linearGradient id="barGrad" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="0%" stopColor="#38bdf8" />
                      <stop offset="100%" stopColor="#0284c7" />
                    </linearGradient>
                    <linearGradient id="bankBarGrad" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="0%" stopColor="#06b6d4" />
                      <stop offset="100%" stopColor="#0891b2" />
                    </linearGradient>
                    <linearGradient id="cardBarGrad" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="0%" stopColor="#f97316" />
                      <stop offset="100%" stopColor="#ea580c" />
                    </linearGradient>
                  </defs>

                  {/* Horizontal grid lines & Y labels */}
                  {yTicks.map((tick, i) => {
                    const y = padTop + chartH - (tick / maxVal) * chartH;
                    return (
                      <g key={i}>
                        <line
                          x1={padLeft}
                          y1={y}
                          x2={padLeft + chartW}
                          y2={y}
                          className="chart-grid-line"
                        />
                        <text x={padLeft - 12} y={y + 4} className="chart-axis-text right">
                          {tick >= 1000000
                            ? `${(tick / 1000000).toFixed(1)}M`
                            : tick >= 1000
                            ? `${Math.round(tick / 1000)}k`
                            : tick}
                        </text>
                      </g>
                    );
                  })}

                  {/* Area Mode Rendering */}
                  {chartMode === 'area' && (
                    <>
                      {/* Area fill */}
                      {typeFilter === 'all' && (
                        <path d={areaPath} fill="url(#totalAreaGrad)" className="area-path" />
                      )}

                      {/* Bank track line */}
                      {(typeFilter === 'all' || typeFilter === 'bank') && (
                        <path
                          d={bankPath}
                          fill="none"
                          stroke="url(#bankGrad)"
                          strokeWidth={typeFilter === 'bank' ? 3 : 1.75}
                          strokeDasharray={typeFilter === 'all' ? '4 3' : undefined}
                          className="track-line bank-line"
                        />
                      )}

                      {/* Card track line */}
                      {(typeFilter === 'all' || typeFilter === 'card') && (
                        <path
                          d={cardPath}
                          fill="none"
                          stroke="url(#cardGrad)"
                          strokeWidth={typeFilter === 'card' ? 3 : 1.75}
                          strokeDasharray={typeFilter === 'all' ? '4 3' : undefined}
                          className="track-line card-line"
                        />
                      )}

                      {/* Total track line */}
                      {typeFilter === 'all' && (
                        <path
                          d={linePath}
                          fill="none"
                          stroke="#38bdf8"
                          strokeWidth={2.75}
                          className="track-line total-line"
                        />
                      )}

                      {/* Hover Crosshair Guide */}
                      {hoveredPoint && (
                        <line
                          x1={hoveredPoint.x}
                          y1={padTop}
                          x2={hoveredPoint.x}
                          y2={padTop + chartH}
                          className="chart-crosshair"
                        />
                      )}

                      {/* Interactive Point Circles */}
                      {points.map((p, idx) => (
                        <g key={idx} className="chart-dot-hitbox">
                          {/* Invisible larger hit target */}
                          <rect
                            x={p.x - 12}
                            y={padTop}
                            width={24}
                            height={chartH + 20}
                            fill="transparent"
                            onMouseEnter={() => setHoveredIndex(idx)}
                            onMouseLeave={() => setHoveredIndex(null)}
                          />
                          <circle
                            cx={p.x}
                            cy={p.y}
                            r={hoveredIndex === idx ? 6 : p.val > 0 ? 4 : 2.5}
                            className={`chart-dot ${hoveredIndex === idx ? 'hovered' : ''}`}
                            style={{ opacity: p.val > 0 || hoveredIndex === idx ? 1 : 0.4 }}
                            onMouseEnter={() => setHoveredIndex(idx)}
                            onMouseLeave={() => setHoveredIndex(null)}
                          />
                        </g>
                      ))}
                    </>
                  )}

                  {/* Bar Mode Rendering */}
                  {chartMode === 'bar' && (
                    <g>
                      {points.map((p, idx) => {
                        const h = (p.val / maxVal) * chartH;
                        const y = padTop + chartH - h;
                        const isHovered = hoveredIndex === idx;
                        return (
                          <g key={idx}>
                            {/* Background column hit target */}
                            <rect
                              x={p.x - barWidth}
                              y={padTop}
                              width={barWidth * 2}
                              height={chartH}
                              fill="transparent"
                              onMouseEnter={() => setHoveredIndex(idx)}
                              onMouseLeave={() => setHoveredIndex(null)}
                            />
                            {/* Bar rectangle */}
                            <rect
                              x={p.x - barWidth / 2}
                              y={p.val > 0 ? y : padTop + chartH - 3}
                              width={barWidth}
                              height={p.val > 0 ? h : 3}
                              rx={barWidth > 8 ? 4 : 2}
                              ry={barWidth > 8 ? 4 : 2}
                              fill={
                                typeFilter === 'bank'
                                  ? 'url(#bankBarGrad)'
                                  : typeFilter === 'card'
                                  ? 'url(#cardBarGrad)'
                                  : 'url(#barGrad)'
                              }
                              className="chart-bar-rect"
                              style={{
                                opacity: isHovered ? 1 : p.val > 0 ? 0.85 : 0.25,
                              }}
                              onMouseEnter={() => setHoveredIndex(idx)}
                              onMouseLeave={() => setHoveredIndex(null)}
                            />
                          </g>
                        );
                      })}
                    </g>
                  )}

                  {/* X Axis Labels (Smart sampling to prevent collision) */}
                  {points.map((p, idx) => {
                    const step = Math.max(1, Math.ceil(points.length / 7));
                    const isEdge = idx === 0 || idx === points.length - 1;
                    const isStep = idx % step === 0;
                    const showLabel = points.length <= 8 || isEdge || isStep;

                    if (!showLabel) return null;

                    return (
                      <text
                        key={`lbl-${idx}`}
                        x={p.x}
                        y={padTop + chartH + 20}
                        className="chart-axis-text center"
                      >
                        {p.label}
                      </text>
                    );
                  })}
                </svg>

                {/* Floating Interactive Tooltip */}
                {hoveredPoint && (
                  <div
                    className="chart-tooltip"
                    style={{
                      left: `${(hoveredPoint.x / svgWidth) * 100}%`,
                      top: `${Math.max(8, (hoveredPoint.y / svgHeight) * 100 - 15)}%`,
                    }}
                  >
                    <div className="tooltip-date">{hoveredPoint.date}</div>
                    <div className="tooltip-row total-row">
                      <span className="tooltip-row-left">
                        <span className="tooltip-dot total" />
                        <span>{t.overview.totalLabel}:</span>
                      </span>
                      <strong className="gold-text">{formatVnd(hoveredPoint.total)}</strong>
                    </div>
                    <div className="tooltip-row">
                      <span className="tooltip-row-left">
                        <span className="tooltip-dot bank" />
                        <span className="muted">{t.overview.bankShort}:</span>
                      </span>
                      <span>{formatVnd(hoveredPoint.bank)}</span>
                    </div>
                    <div className="tooltip-row">
                      <span className="tooltip-row-left">
                        <span className="tooltip-dot card" />
                        <span className="muted">{t.overview.cardShort}:</span>
                      </span>
                      <span>{formatVnd(hoveredPoint.card)}</span>
                    </div>
                    <div className="tooltip-count muted">
                      {hoveredPoint.count} {t.overview.transactionsCount}
                    </div>
                  </div>
                )}
              </div>
            )}
          </div>

          {/* Bottom Grid: Donut Breakdown + Recent Topups */}
          <div className="overview-bottom-grid">
            {/* Donut Chart: Payment Channels Breakdown */}
            <div className="panel" style={{ padding: '24px 22px' }}>
              <div className="panel-head" style={{ marginBottom: 20 }}>
                <div>
                  <h3 style={{ margin: 0, fontSize: '1.05rem', fontWeight: 600 }}>
                    {t.overview.revenueBreakdown}
                  </h3>
                  <span className="muted" style={{ fontSize: '0.85rem' }}>
                    {t.overview.channelShareTitle}
                  </span>
                </div>
              </div>

              <div className="donut-card-wrap">
                <div className="donut-svg-wrap">
                  <svg viewBox="0 0 160 160" className="donut-svg">
                    {/* Background Track Ring */}
                    <circle
                      cx="80"
                      cy="80"
                      r="60"
                      fill="none"
                      stroke="var(--line)"
                      strokeWidth="16"
                    />

                    {/* Bank Segment */}
                    {data.breakdown.bankPercent > 0 && (
                      <circle
                        cx="80"
                        cy="80"
                        r="60"
                        fill="none"
                        stroke="#06b6d4"
                        strokeWidth="16"
                        strokeDasharray={`${(data.breakdown.bankPercent * 377) / 100} 377`}
                        strokeDashoffset="0"
                        strokeLinecap="round"
                        style={{ transition: 'stroke-dasharray 0.6s ease' }}
                      />
                    )}

                    {/* Card Segment */}
                    {data.breakdown.cardPercent > 0 && (
                      <circle
                        cx="80"
                        cy="80"
                        r="60"
                        fill="none"
                        stroke="#f97316"
                        strokeWidth="16"
                        strokeDasharray={`${(data.breakdown.cardPercent * 377) / 100} 377`}
                        strokeDashoffset={`-${(data.breakdown.bankPercent * 377) / 100}`}
                        strokeLinecap="round"
                        style={{ transition: 'stroke-dasharray 0.6s ease' }}
                      />
                    )}
                  </svg>
                  <div className="donut-center-info">
                    <span className="donut-center-total">{formatVnd(data.summary.totalRevenue)}</span>
                    <span className="donut-center-label">{t.overview.donutCenterLabel}</span>
                  </div>
                </div>

                <div className="donut-breakdown-list">
                  {/* Bank Channel */}
                  <div className="donut-channel-item">
                    <div className="donut-channel-header">
                      <span className="donut-channel-title">
                        <span className="legend-dot bank-dot" />
                        <span>{t.overview.bankLabel}</span>
                        <span className="channel-pill bank">{data.breakdown.bankPercent}%</span>
                      </span>
                      <span className="donut-channel-amount">{formatVnd(data.summary.bankRevenue)}</span>
                    </div>
                    <div className="donut-progress-track">
                      <div
                        className="donut-progress-bar bank"
                        style={{ width: `${data.breakdown.bankPercent}%` }}
                      />
                    </div>
                  </div>

                  {/* Card Channel */}
                  <div className="donut-channel-item">
                    <div className="donut-channel-header">
                      <span className="donut-channel-title">
                        <span className="legend-dot card-dot" />
                        <span>{t.overview.cardLabel}</span>
                        <span className="channel-pill card">{data.breakdown.cardPercent}%</span>
                      </span>
                      <span className="donut-channel-amount">{formatVnd(data.summary.cardRevenue)}</span>
                    </div>
                    <div className="donut-progress-track">
                      <div
                        className="donut-progress-bar card"
                        style={{ width: `${data.breakdown.cardPercent}%` }}
                      />
                    </div>
                  </div>

                  {/* Other Channel (if > 0) */}
                  {data.breakdown.otherPercent > 0 && (
                    <div className="donut-channel-item">
                      <div className="donut-channel-header">
                        <span className="donut-channel-title">
                          <span className="legend-dot other-dot" />
                          <span>{t.overview.otherLabel}</span>
                          <span className="channel-pill other">{data.breakdown.otherPercent}%</span>
                        </span>
                        <span className="donut-channel-amount">{formatVnd(data.summary.otherRevenue)}</span>
                      </div>
                      <div className="donut-progress-track">
                        <div
                          className="donut-progress-bar other"
                          style={{ width: `${data.breakdown.otherPercent}%` }}
                        />
                      </div>
                    </div>
                  )}
                </div>
              </div>
            </div>

            {/* Recent Topups Stream */}
            <div className="panel" style={{ padding: '24px 22px' }}>
              <div className="panel-head" style={{ marginBottom: 16 }}>
                <div>
                  <h3 style={{ margin: 0, fontSize: '1.05rem', fontWeight: 600 }}>
                    {t.overview.recentTopups}
                  </h3>
                  <span className="muted" style={{ fontSize: '0.85rem' }}>
                    {t.overview.latestTransactionsCount(data.recentTopups.length)}
                  </span>
                </div>
              </div>

              {data.recentTopups.length === 0 ? (
                <div className="muted" style={{ padding: '36px 0', textAlign: 'center' }}>
                  <Sparkles size={24} style={{ opacity: 0.4, marginBottom: 8 }} />
                  <div>{t.overview.noRecentDeposits}</div>
                </div>
              ) : (
                <div className="recent-deposits-wrap">
                  {data.recentTopups.map((tx) => (
                    <div key={tx.id} className="recent-deposit-item">
                      <div className="recent-deposit-user">
                        {tx.userProfile?.avatarUrl ? (
                           <img
                            src={tx.userProfile.avatarUrl}
                            alt={tx.userProfile.displayName}
                            className="recent-deposit-avatar"
                          />
                        ) : (
                          <div className="recent-deposit-avatar placeholder">
                            {tx.userProfile?.displayName && !/^\d{15,22}$/.test(tx.userProfile.displayName) ? (
                              tx.userProfile.displayName[0]?.toUpperCase()
                            ) : (
                              <User size={15} />
                            )}
                          </div>
                        )}
                        <div className="recent-deposit-info">
                          <div className="recent-deposit-name">
                            {tx.userProfile?.displayName && !/^\d{15,22}$/.test(tx.userProfile.displayName)
                              ? tx.userProfile.displayName
                              : `${t.leaderboard.unknownUser} #${tx.discordUserId.slice(-4)}`}
                          </div>
                          <div className="recent-deposit-sub muted mono">
                            {tx.userProfile?.username && !/^\d{15,22}$/.test(tx.userProfile.username)
                              ? `@${tx.userProfile.username}`
                              : tx.discordUserId}
                          </div>
                        </div>
                      </div>

                      <div className="recent-deposit-meta">
                        <span className={`deposit-channel-pill ${tx.kind === 'bank_topup' ? 'bank' : 'card'}`}>
                          {tx.kind === 'bank_topup'
                            ? t.overview.bankShort
                            : tx.kind === 'card_topup'
                            ? t.overview.cardShort
                            : t.overview.otherShort}
                        </span>
                        <div className="recent-deposit-amount">+{formatVnd(tx.delta)}</div>
                        <div className="muted" style={{ fontSize: 11 }}>
                          <TimeAgo unixSeconds={tx.createdAt} />
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        </>
      )}
    </>
  );
}
