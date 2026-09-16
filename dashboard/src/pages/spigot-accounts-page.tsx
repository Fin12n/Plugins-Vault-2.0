import { useEffect, useRef, useState } from 'react';
import {
  Activity,
  AlertTriangle,
  CheckCircle2,
  Clock,
  Download,
  FolderUp,
  Globe,
  Link,
  Maximize2,
  Minimize2,
  Package,
  PackageCheck,
  Play,
  Plus,
  Power,
  RefreshCw,
  RotateCw,
  Search,
  Server,
  ShieldCheck,
  Square,
  Terminal,
  Trash2,
  Unlink,
  UserCheck,
  Users,
  X,
  Zap,
} from 'lucide-react';
import { useToast } from '../components/toast.js';
import { RefreshButton, TimeAgo } from '../components/ui.js';
import { InstanceMonitor } from '../components/instance-monitor.js';
import { formatTimestamp, vi } from '../i18n/vi.js';
import {
  api,
  type SpigotAccountView,
  type SpigotAccountsView,
  type SpigotCredentialPreviewAccount,
  type SpigotCredentialPreview,
  type SpigotRunStatus,
  type SpigotChallengeStatus,
  type SweepLogEntry,
  type SweepLogsResponse,
  type SweepLogLevel,
  type InstancesResponse,
  type InstanceWorkerState,
  type SpigotOwnershipOverview,
  type OwnedPluginSummary,
} from '../lib/api-client.js';

const EXAMPLE = `User: account@example.com
Password: your-password
Plugins found: 2
Status: success
Purchased resources:
Vault+
Advanced Enchantments
--------------------------------------------------`;

/** Định dạng câu log đẹp mắt: loại bỏ emoji lặp và làm nổi bật plugin, phiên bản, tài khoản */
function parseLogTokens(message: string) {
  // Bỏ các emoji hoặc ký tự lặp ở đầu câu để tránh lặp icon
  const clean = message
    .replace(/^[\s✅❌⚠️🔄🛒➖🛑🔑✓•⚠·\u2705\u274C\u26A0\uFE0F]+/, '')
    .trim();

  // Tách theo token: **plugin**, `version`, (tài khoản xxx)
  const regex = /(\*\*[^*]+\*\*|`[^`]+`|\(tài khoản [^)]+\))/g;
  const parts = clean.split(regex);

  return parts.map((part, index) => {
    if (part.startsWith('**') && part.endsWith('**')) {
      return (
        <span key={index} className="log-token-plugin">
          {part.slice(2, -2)}
        </span>
      );
    }
    if (part.startsWith('`') && part.endsWith('`')) {
      return (
        <span key={index} className="log-token-version">
          {part.slice(1, -1)}
        </span>
      );
    }
    if (part.startsWith('(tài khoản ') && part.endsWith(')')) {
      const account = part.slice(11, -1);
      return (
        <span key={index} className="log-token-account" title={`Tài khoản: ${account}`}>
          @{account}
        </span>
      );
    }
    return <span key={index}>{part}</span>;
  });
}

export function SpigotAccountsPage() {
  const toast = useToast();
  const [text, setText] = useState('');
  const [preview, setPreview] = useState<SpigotCredentialPreview | null>(null);
  const [current, setCurrent] = useState<SpigotAccountsView | null>(null);
  const [busy, setBusy] = useState(false);
  const [run, setRun] = useState<SpigotRunStatus | null>(null);
  const [challenge, setChallenge] = useState<SpigotChallengeStatus | null>(null);
  const [currentProxyIp, setCurrentProxyIp] = useState<string | null>(null);
  const [proxyEnabled, setProxyEnabled] = useState<boolean>(true);
  const [proxyToggleBusy, setProxyToggleBusy] = useState(false);
  const [stoppingDownloads, setStoppingDownloads] = useState(false);
  const [rotatingProxy, setRotatingProxy] = useState(false);
  const [logs, setLogs] = useState<SweepLogEntry[]>([]);
  const [selectedWorkerLog, setSelectedWorkerLog] = useState<number | 'all'>('all');
  const [instances, setInstances] = useState<InstanceWorkerState[]>([]);
  const [concurrency, setConcurrency] = useState<number>(2);
  const [activeWorkers, setActiveWorkers] = useState<number>(0);
  const [autoScroll, setAutoScroll] = useState(true);
  const [isExpanded, setIsExpanded] = useState(false);
  const [accountTab, setAccountTab] = useState<'current' | 'import'>('current');
  const [ownershipData, setOwnershipData] = useState<SpigotOwnershipOverview | null>(null);
  const [autoLinking, setAutoLinking] = useState(false);
  const [assignModalAccount, setAssignModalAccount] = useState<string | null>(null);
  const [selectedPluginToAssign, setSelectedPluginToAssign] = useState<number | ''>('');
  const [assignSearch, setAssignSearch] = useState('');
  const fileRef = useRef<HTMLInputElement>(null);
  const logContainerRef = useRef<HTMLDivElement>(null);

  const refresh = async () => {
    setCurrent(await api.get<SpigotAccountsView>('/api/spigot-accounts'));
    void fetchOwnership();
  };

  const fetchOwnership = async () => {
    try {
      const data = await api.get<SpigotOwnershipOverview>('/api/spigot-accounts/ownership');
      setOwnershipData(data);
    } catch {
      // ignore
    }
  };

  const handleAutoLink = async () => {
    if (autoLinking) return;
    setAutoLinking(true);
    try {
      const res = await api.post<{ ok: boolean; linkedCount: number; details: string[] }>('/api/spigot-accounts/auto-link');
      if (res.linkedCount > 0) {
        toast.show('success', `Đã tự động liên kết thành công ${res.linkedCount} plugin vào đúng tài khoản sở hữu!`);
      } else {
        toast.show('info', 'Tất cả plugin đã mua đã được liên kết hoặc chưa tìm thấy plugin mới khớp tên.');
      }
      await refresh();
      await fetchOwnership();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Không thể tự động liên kết');
    } finally {
      setAutoLinking(false);
    }
  };

  const handleAssignPlugin = async (resourceId: number, accountLabel: string) => {
    try {
      await api.post('/api/spigot-accounts/assign-ownership', { resourceId, accountLabel });
      toast.show('success', `Đã gán plugin #${resourceId} cho tài khoản @${accountLabel}`);
      setAssignModalAccount(null);
      setSelectedPluginToAssign('');
      await refresh();
      await fetchOwnership();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Không thể gán plugin');
    }
  };

  const handleRemovePlugin = async (resourceId: number, accountLabel: string) => {
    try {
      await api.post('/api/spigot-accounts/remove-ownership', { resourceId, accountLabel });
      toast.show('info', `Đã gỡ quyền sở hữu plugin #${resourceId} khỏi tài khoản @${accountLabel}`);
      await refresh();
      await fetchOwnership();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Không thể gỡ plugin');
    }
  };

  const fetchInstances = async () => {
    try {
      const res = await api.get<InstancesResponse>('/api/spigot-downloads/instances');
      setConcurrency(res.concurrency);
      setActiveWorkers(res.activeWorkers);
      setInstances(res.instances);
    } catch {
      // ignore
    }
  };

  const handleConcurrencyChange = async (newConcurrency: number) => {
    try {
      const res = await api.post<{ ok: boolean; concurrency: number }>('/api/spigot-downloads/concurrency', {
        concurrency: newConcurrency,
      });
      setConcurrency(res.concurrency);
      toast.show('success', `Đã cập nhật số luồng tải song song sang ${res.concurrency} worker(s)`);
      await fetchInstances();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Không thể cập nhật số luồng song song');
    }
  };

  const fetchLogsAndStatus = async (targetWorker?: number | 'all') => {
    try {
      const activeFilter = targetWorker !== undefined ? targetWorker : selectedWorkerLog;
      const url =
        activeFilter !== 'all'
          ? `/api/spigot-downloads/logs?workerId=${activeFilter}`
          : '/api/spigot-downloads/logs';
      const res = await api.get<SweepLogsResponse>(url);
      setRun({
        running: res.running,
        lastStartedAt: res.lastStartedAt,
        lastFinishedAt: res.lastFinishedAt,
      });
      if (res.currentProxyIp !== undefined) {
        setCurrentProxyIp(res.currentProxyIp);
      }
      if (res.proxyEnabled !== undefined) {
        setProxyEnabled(res.proxyEnabled);
      }
      setLogs(res.logs);
    } catch {
      // ignore
    }
  };

  const handleToggleProxy = async () => {
    if (proxyToggleBusy) return;
    setProxyToggleBusy(true);
    try {
      const next = !proxyEnabled;
      const res = await api.post<{ ok: boolean; proxyEnabled: boolean }>('/api/spigot-proxy/toggle', { enabled: next });
      setProxyEnabled(res.proxyEnabled);
      if (res.proxyEnabled) {
        toast.show('success', 'Đã BẬT Proxy — Sử dụng Proxy xoay IP cho Spigot');
      } else {
        toast.show('info', 'Đã TẮT Proxy — Chuyển sang kết nối trực tiếp bằng IP máy chủ');
      }
      await fetchLogsAndStatus();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Không thể chuyển đổi trạng thái Proxy');
    } finally {
      setProxyToggleBusy(false);
    }
  };

  const handleRotateProxy = async () => {
    if (rotatingProxy) return;
    setRotatingProxy(true);
    try {
      const res = await api.post<{ ok: boolean; currentProxyIp: string | null; error?: string }>('/api/spigot-proxy/rotate');
      if (res.ok && res.currentProxyIp) {
        setCurrentProxyIp(res.currentProxyIp);
        toast.show('success', `Đã xoay sang IP Proxy mới: ${res.currentProxyIp}`);
      } else {
        toast.show('info', res.error || 'Không thể xoay proxy lúc này');
      }
      await fetchLogsAndStatus();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Không thể xoay Proxy IP');
    } finally {
      setRotatingProxy(false);
    }
  };

  const handleStopDownloads = async () => {
    if (stoppingDownloads) return;
    setStoppingDownloads(true);
    try {
      await api.post<{ ok: boolean; stopped: boolean }>('/api/spigot-downloads/stop');
      setRun({ running: false, lastStartedAt: run?.lastStartedAt ?? null, lastFinishedAt: Date.now() });
      toast.show('info', '🛑 Đã gửi lệnh DỪNG KHẨN CẤP toàn bộ các luồng Chrome và tiến trình tải!');
      await fetchLogsAndStatus();
      await fetchInstances();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Không thể dừng tiến trình');
    } finally {
      setStoppingDownloads(false);
    }
  };

  const clearLogs = async () => {
    try {
      const body = selectedWorkerLog !== 'all' ? { workerId: selectedWorkerLog } : {};
      await api.post('/api/spigot-downloads/logs/clear', body);
      setLogs([]);
      toast.show(
        'info',
        selectedWorkerLog !== 'all'
          ? `Đã xóa nhật ký của Worker #${selectedWorkerLog}`
          : 'Đã xóa toàn bộ nhật ký quét & tải',
      );
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Không thể xóa log');
    }
  };

  useEffect(() => {
    void refresh().catch(() => setCurrent(null));
    void fetchOwnership();
    void fetchLogsAndStatus(selectedWorkerLog);
    void fetchInstances();
    void api.get<SpigotChallengeStatus>('/api/spigot-challenge').then(setChallenge).catch(() => setChallenge(null));
  }, []);

  useEffect(() => {
    void fetchLogsAndStatus(selectedWorkerLog);
  }, [selectedWorkerLog]);

  useEffect(() => {
    const interval = run?.running ? 1200 : 3500;
    const timer = window.setInterval(() => {
      void fetchLogsAndStatus();
      void fetchInstances();
    }, interval);
    return () => window.clearInterval(timer);
  }, [run?.running, selectedWorkerLog]);

  useEffect(() => {
    const timer = window.setInterval(() => {
      void api.get<SpigotChallengeStatus>('/api/spigot-challenge').then(setChallenge).catch(() => undefined);
    }, 3000);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    if (!run?.running && run?.lastFinishedAt) void refresh().catch(() => undefined);
  }, [run?.running, run?.lastFinishedAt]);

  useEffect(() => {
    if (autoScroll && logContainerRef.current) {
      logContainerRef.current.scrollTop = logContainerRef.current.scrollHeight;
    }
  }, [logs, autoScroll]);

  const inspect = async () => {
    setBusy(true);
    try {
      const result = await api.post<SpigotCredentialPreview>('/api/spigot-credentials/preview', { text });
      setPreview(result);
      toast.show('info', vi.spigotAccounts.toastReadSuccess(result.summary.total, result.summary.enabled));
    } catch (err) {
      setPreview(null);
      toast.error(err instanceof Error ? err.message : vi.spigotAccounts.toastCannotRead);
    } finally {
      setBusy(false);
    }
  };

  const save = async () => {
    setBusy(true);
    try {
      const result = await api.put<SpigotCredentialPreview>('/api/spigot-credentials', { text });
      setPreview(result);
      await refresh();
      setText('');
      toast.success(vi.spigotAccounts.toastSaveSuccess(result.summary.total));
    } catch (err) {
      toast.error(err instanceof Error ? err.message : vi.spigotAccounts.toastCannotSave);
    } finally {
      setBusy(false);
    }
  };

  const loadFile = async (file: File) => {
    const bytes = await file.arrayBuffer();
    const view = new Uint8Array(bytes);
    const utf16 = view[0] === 0xff && view[1] === 0xfe;
    setText(new TextDecoder(utf16 ? 'utf-16le' : 'utf-8').decode(bytes).replace(/^\uFEFF/, ''));
    setPreview(null);
    toast.show('info', vi.spigotAccounts.toastFileLoaded(file.name));
  };

  const runNow = async () => {
    try {
      setRun(await api.post<SpigotRunStatus>('/api/spigot-downloads/run-download-now'));
      toast.success(vi.spigotAccounts.toastRunStarted);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : vi.spigotAccounts.toastCannotStart);
    }
  };

  const runScanNow = async () => {
    try {
      await api.post('/api/spigot-accounts/scan-now');
      toast.success('Đã kích hoạt quét tài nguyên đã mua cho tất cả tài khoản!');
      await fetchLogsAndStatus();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Không thể bắt đầu quét tài khoản');
    }
  };

  const runDownloadNow = async () => {
    try {
      setRun(await api.post<SpigotRunStatus>('/api/spigot-downloads/run-download-now'));
      toast.success('Đã kích hoạt tải plugin theo thứ tự từng tài khoản!');
      await fetchLogsAndStatus();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Không thể bắt đầu tải plugin');
    }
  };

  const runAllNow = async () => {
    try {
      setRun(await api.post<SpigotRunStatus>('/api/spigot-downloads/run-all', { autoResolveIds: true }));
      toast.success('Đã kích hoạt tiến trình: Tải Tất Cả & Tự Động Gắn ID!');
    } catch (err) {
      toast.error(err instanceof Error ? err.message : vi.spigotAccounts.toastCannotStart);
    }
  };

  const isProxyActive = currentProxyIp && !currentProxyIp.includes('Direct') && !currentProxyIp.includes('Chờ');
  const enabledCount = current?.configured ? current.accounts.filter((a) => a.enabled).length : 0;
  const totalCount = current?.accounts?.length ?? 0;
  const totalPurchased = current?.accounts
    ? current.accounts.reduce((acc, a) => acc + a.purchasedResources.length, 0)
    : 0;

  return (
    <>
      <div className="content-head">
        <h2>{vi.spigotAccounts.heading}</h2>
        <RefreshButton onClick={() => void refresh().catch(() => undefined)} />
      </div>

      {/* 1. HERO CONTROL HUB - SCAN & DOWNLOAD CENTER */}
      <section className="panel spigot-hero-hub">
        <div className="spigot-hub-grid">
          {/* Cột trái: Bộ kích hoạt & Trạng thái hoạt động */}
          <div className="spigot-hub-action">
            <div className="hub-header-badge-row">
              <div className="hub-title-wrap">
                <span className="hub-eyebrow">Hệ Thống Tự Động Hóa Upstream</span>
                <h3 className="hub-title">{vi.spigotAccounts.runHeading}</h3>
              </div>
              {run?.running ? (
                <span className="hero-status-pill running">
                  <span className="pulse-neon-dot" />
                  <span>{vi.spigotAccounts.runningStatus}</span>
                </span>
              ) : (
                <span className="hero-status-pill idle">
                  <span className="idle-dot" />
                  <span>Sẵn sàng hoạt động</span>
                </span>
              )}
            </div>

            <p className="hub-desc">{vi.spigotAccounts.runHint}</p>

            <div className="hub-action-row" style={{ display: 'flex', gap: '10px', flexWrap: 'wrap' }}>
              {/* Nút 1: Run Scan Now (Chỉ quét danh sách đã mua của các tài khoản) */}
              <button
                className="btn-hero-run"
                onClick={() => void runScanNow()}
                disabled={run?.running || current?.configured !== true}
                aria-busy={run?.running === true}
                title="Quét trang Purchased Resources của tất cả tài khoản Spigot để cập nhật danh sách plugin đã mua (KHÔNG tải file)"
                style={{
                  background: 'linear-gradient(135deg, #0284c7 0%, #0369a1 100%)',
                  boxShadow: '0 4px 15px rgba(2, 132, 199, 0.4)',
                }}
              >
                <Search size={18} />
                <span>🔍 Quét Tài Khoản Ngay (Run Scan Now)</span>
              </button>

              {/* Nút 2: Run Download Now (Tải tuần tự theo từng tài khoản -> plugin -> 10 bản) */}
              <button
                className="btn-hero-run"
                onClick={() => void runDownloadNow()}
                disabled={run?.running || current?.configured !== true}
                aria-busy={run?.running === true}
                title="Quét và tải đủ 10 phiên bản của từng plugin theo thứ tự từng tài khoản trong 1 phiên liên tục. Bản nào lỗi sẽ đưa vào danh sách tải sau."
                style={{
                  background: 'linear-gradient(135deg, #10b981 0%, #059669 100%)',
                  boxShadow: '0 4px 15px rgba(16, 185, 129, 0.4)',
                }}
              >
                {run?.running ? (
                  <>
                    <RefreshCw size={18} className="spin-icon" />
                    <span>Đang chạy tải...</span>
                  </>
                ) : (
                  <>
                    <Download size={18} />
                    <span>🚀 Tải Plugin Ngay (Run Download Now)</span>
                  </>
                )}
              </button>

              {/* Nút 3: Tải Tất Cả & Tự Động Gắn ID */}
              <button
                className="btn-hero-run"
                onClick={() => void runAllNow()}
                disabled={run?.running || current?.configured !== true}
                aria-busy={run?.running === true}
                title="Tự động tra cứu Spiget gắn ID cho plugin chưa có, quét toàn bộ tài khoản và tải mọi phiên bản về kho"
                style={{
                  background: 'rgba(255, 255, 255, 0.07)',
                  borderColor: 'rgba(255, 255, 255, 0.15)',
                  boxShadow: 'none',
                }}
              >
                <Zap size={16} style={{ color: '#fbbf24' }} />
                <span style={{ fontSize: '13px' }}>Tự Động Gắn ID & Tải Hết</span>
              </button>

              {(run?.running || activeWorkers > 0) && (
                <button
                  type="button"
                  className="btn-hero-stop"
                  onClick={() => void handleStopDownloads()}
                  disabled={stoppingDownloads}
                  title="Dừng khẩn cấp: Ngắt mọi luồng Chrome và dừng quét/tải ngay lập tức"
                >
                  <Square size={16} fill="currentColor" />
                  <span>{stoppingDownloads ? 'Đang dừng...' : '🛑 Dừng khẩn cấp'}</span>
                </button>
              )}
            </div>

            {current?.configured !== true ? (
              <p className="hint hint-warn" style={{ marginTop: 10 }}>
                {vi.spigotAccounts.unconfiguredHint}
              </p>
            ) : (
              <p className="hint compact" style={{ marginTop: 10 }}>
                Hệ thống sẽ mở trình duyệt tự động, giải captcha nếu có, rà soát phiên bản mới nhất và tải tệp jar vào kho lưu trữ.
              </p>
            )}
          </div>

          {/* Cột phải: Bento Metrics Cards */}
          <div className="spigot-hub-bento">
            <div className="bento-metric-card">
              <div className="bento-card-top">
                <span className="bento-card-label">Tài khoản khả dụng</span>
                <Users size={16} className="bento-card-icon" />
              </div>
              <div className="bento-card-val">
                {enabledCount}
                <small className="bento-sub"> / {totalCount} tài khoản</small>
              </div>
              <div className="bento-card-footer">
                <span className={enabledCount > 0 ? 'badge ok' : 'badge'}>
                  {current?.configured ? `${enabledCount} đang hoạt động` : 'Chưa cấu hình'}
                </span>
              </div>
            </div>

            <div className="bento-metric-card">
              <div className="bento-card-top">
                <span className="bento-card-label">IP Proxy kết nối</span>
                <Globe size={16} className="bento-card-icon" />
              </div>
              <div className={`bento-card-val ${isProxyActive ? 'has-proxy' : ''}`}>
                {isProxyActive && <span className="proxy-ping-dot" />}
                <span className="mono" style={{ fontSize: 15 }}>{currentProxyIp || 'Chờ kích hoạt'}</span>
              </div>
              <div className="bento-card-footer" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <span className={isProxyActive ? 'badge accent' : 'badge'}>
                  {isProxyActive ? 'Suiproxy xoay IP' : 'Kết nối Trực tiếp'}
                </span>
                {proxyEnabled && (
                  <button
                    type="button"
                    className="bento-rotate-proxy-btn"
                    onClick={() => void handleRotateProxy()}
                    disabled={rotatingProxy}
                    title="Yêu cầu hệ thống xoay sang IP Proxy mới"
                  >
                    <RotateCw size={11} className={rotatingProxy ? 'spin-icon' : ''} />
                    <span>{rotatingProxy ? 'Đang xoay...' : 'Đổi IP'}</span>
                  </button>
                )}
              </div>
            </div>

            <div className="bento-metric-card">
              <div className="bento-card-top">
                <span className="bento-card-label">Lần quét gần nhất</span>
                <Clock size={16} className="bento-card-icon" />
              </div>
              <div className="bento-card-val">
                {run?.lastFinishedAt ? (
                  <TimeAgo unixSeconds={Math.floor(run.lastFinishedAt / 1000)} />
                ) : run?.lastStartedAt ? (
                  <span style={{ color: 'var(--accent)' }}>Đang xử lý...</span>
                ) : (
                  <span className="muted">Chưa có dữ liệu</span>
                )}
              </div>
              <div className="bento-card-footer">
                <span className="hint compact" style={{ margin: 0 }}>
                  {run?.lastFinishedAt ? formatTimestamp(Math.floor(run.lastFinishedAt / 1000)) : 'Chờ chu kỳ tiếp theo'}
                </span>
              </div>
            </div>

            <div className="bento-metric-card">
              <div className="bento-card-top">
                <span className="bento-card-label">Plugin đã theo dõi</span>
                <Package size={16} className="bento-card-icon" />
              </div>
              <div className="bento-card-val">
                {totalPurchased}
                <small className="bento-sub"> tài nguyên</small>
              </div>
              <div className="bento-card-footer">
                <span className="badge">Tự động đồng bộ</span>
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* 2. GIÁM SÁT TRÌNH DUYỆT SONG SONG (MULTI-WORKER MONITOR) */}
      <InstanceMonitor
        instances={instances}
        concurrency={concurrency}
        activeWorkers={activeWorkers}
        isRunning={Boolean(run?.running)}
        selectedWorkerId={selectedWorkerLog}
        onConcurrencyChange={handleConcurrencyChange}
        onSelectWorkerLog={(workerId) => {
          setSelectedWorkerLog(workerId);
        }}
      />

      {/* 3. CONSOLE NHẬT KÝ REAL-TIME */}
      <section className={`panel spigot-console-section ${isExpanded ? 'is-expanded' : ''}`}>
        <div className="spigot-console-header">
          <div className="console-header-left">
            <div className="console-title-wrap">
              <Terminal size={15} className="console-icon" />
              <span className="console-title">Console Nhật Ký Quét & Tải Real-Time</span>
            </div>
            {run?.running ? (
              <span className="console-badge running">
                <span className="pulse-dot" /> Đang chạy
              </span>
            ) : (
              <span className="console-badge idle">Sẵn sàng</span>
            )}
            <span className="console-counter-badge">{logs.length} bản ghi</span>
            {(run?.running || activeWorkers > 0) && (
              <button
                type="button"
                className="console-emergency-stop-btn"
                onClick={() => void handleStopDownloads()}
                disabled={stoppingDownloads}
                title="Dừng khẩn cấp: Ngắt mọi luồng Chrome và dừng quét/tải ngay lập tức"
              >
                <Square size={11} fill="currentColor" />
                <span>{stoppingDownloads ? 'Đang dừng...' : '🛑 Stop khẩn cấp'}</span>
              </button>
            )}
          </div>

          <div className="console-header-center">
            <div className={`console-proxy-pill ${!proxyEnabled ? 'is-disabled' : ''}`} title="Địa chỉ IP Proxy đang được gán cho kết nối Spigot">
              <Globe size={13} className={`proxy-globe-icon ${proxyEnabled ? '' : 'is-disabled'}`} />
              <span className="proxy-pill-label">Proxy IP:</span>
              <span className={`proxy-pill-value ${isProxyActive && proxyEnabled ? 'is-proxy' : 'is-direct'}`}>
                {isProxyActive && proxyEnabled && <span className="proxy-ping-dot" />}
                {proxyEnabled ? (currentProxyIp || 'Chờ kích hoạt') : 'Direct (IP máy chủ)'}
              </span>
            </div>

            {proxyEnabled && (
              <button
                type="button"
                className="console-proxy-rotate-btn"
                onClick={() => void handleRotateProxy()}
                disabled={rotatingProxy}
                title="Bấm để xoay sang một địa chỉ Proxy IP mới ngay lập tức"
              >
                <RotateCw size={12} className={`proxy-rotate-icon ${rotatingProxy ? 'spin-icon' : ''}`} />
                <span>{rotatingProxy ? 'Đang xoay...' : 'Xoay IP khác'}</span>
              </button>
            )}

            <button
              type="button"
              className={`console-proxy-toggle-btn ${proxyEnabled ? 'is-enabled' : 'is-disabled'}`}
              onClick={() => void handleToggleProxy()}
              disabled={proxyToggleBusy}
              title={
                proxyEnabled
                  ? 'Bấm để TẮT Proxy (Chuyển sang kết nối trực tiếp bằng IP máy chủ VPS)'
                  : 'Bấm để BẬT lại Proxy (Sử dụng Proxy xoay IP)'
              }
            >
              <Power size={12} className="proxy-toggle-icon" />
              <span>{proxyToggleBusy ? 'Đang lưu...' : proxyEnabled ? 'Tắt Proxy' : 'Bật Proxy'}</span>
            </button>
          </div>

          <div className="console-header-right">
            <label className="console-autoscroll-toggle" title="Tự động cuộn xuống khi có sự kiện mới">
              <input
                type="checkbox"
                checked={autoScroll}
                onChange={(e) => setAutoScroll(e.target.checked)}
              />
              <span>Tự cuộn</span>
            </label>

            <button
              type="button"
              className="console-tool-btn"
              onClick={() => setIsExpanded(!isExpanded)}
              title={isExpanded ? 'Thu nhỏ cửa sổ' : 'Mở rộng toàn màn hình'}
            >
              {isExpanded ? <Minimize2 size={13} /> : <Maximize2 size={13} />}
              <span>{isExpanded ? 'Thu gọn' : 'Mở rộng'}</span>
            </button>

            <button
              type="button"
              className="console-tool-btn btn-clear"
              onClick={() => void clearLogs()}
              title="Xóa sạch lịch sử nhật ký"
              disabled={logs.length === 0}
            >
              <Trash2 size={13} />
              <span>Xóa</span>
            </button>
          </div>
        </div>

        {/* Thanh chọn Tab lọc Log theo từng Worker riêng biệt */}
        <div
          className="console-worker-tabs"
          style={{
            display: 'flex',
            gap: '6px',
            padding: '8px 16px',
            background: 'rgba(0, 0, 0, 0.3)',
            borderBottom: '1px solid rgba(255, 255, 255, 0.08)',
            overflowX: 'auto',
            alignItems: 'center',
          }}
        >
          <span style={{ fontSize: '11px', color: 'var(--muted)', fontWeight: 600, marginRight: '4px', textTransform: 'uppercase', letterSpacing: '0.04em' }}>
            Lọc Log Worker:
          </span>
          <button
            type="button"
            className={`console-worker-tab-btn ${selectedWorkerLog === 'all' ? 'active' : ''}`}
            onClick={() => setSelectedWorkerLog('all')}
            style={{
              padding: '3px 10px',
              borderRadius: '6px',
              fontSize: '12px',
              border: '1px solid',
              borderColor: selectedWorkerLog === 'all' ? 'var(--accent)' : 'rgba(255, 255, 255, 0.1)',
              background: selectedWorkerLog === 'all' ? 'rgba(59, 130, 246, 0.25)' : 'rgba(255, 255, 255, 0.04)',
              color: selectedWorkerLog === 'all' ? '#93c5fd' : 'inherit',
              cursor: 'pointer',
              fontWeight: selectedWorkerLog === 'all' ? 600 : 400,
            }}
          >
            🌐 Tất cả luồng ({logs.length})
          </button>
          {Array.from({ length: concurrency }, (_, idx) => idx + 1).map((workerId) => {
            const isSelected = selectedWorkerLog === workerId;
            const workerInstance = instances.find((w) => w.id === workerId);
            const isBusy =
              workerInstance &&
              workerInstance.status !== 'idle' &&
              workerInstance.status !== 'completed';
            return (
              <button
                key={workerId}
                type="button"
                className={`console-worker-tab-btn ${isSelected ? 'active' : ''}`}
                onClick={() => setSelectedWorkerLog(workerId)}
                style={{
                  padding: '3px 10px',
                  borderRadius: '6px',
                  fontSize: '12px',
                  border: '1px solid',
                  borderColor: isSelected ? 'var(--accent)' : 'rgba(255, 255, 255, 0.1)',
                  background: isSelected ? 'rgba(59, 130, 246, 0.25)' : 'rgba(255, 255, 255, 0.04)',
                  color: isSelected ? '#93c5fd' : 'inherit',
                  cursor: 'pointer',
                  fontWeight: isSelected ? 600 : 400,
                  display: 'flex',
                  alignItems: 'center',
                  gap: '4px',
                }}
              >
                {isBusy && <span className="instance-pulse-dot" style={{ width: 6, height: 6 }} />}
                Worker #{workerId}
                {workerInstance?.accountLabel && (
                  <span style={{ fontSize: '10px', opacity: 0.75 }}>
                    (@{workerInstance.accountLabel})
                  </span>
                )}
              </button>
            );
          })}
        </div>

        <div
          ref={logContainerRef}
          className={`spigot-console-body ${isExpanded ? 'expanded' : ''}`}
        >
          {logs.length === 0 ? (
            <div className="spigot-console-empty">
              <Terminal size={32} className="empty-terminal-icon" />
              <p className="empty-title">Console đang ở trạng thái sẵn sàng</p>
              <span className="empty-desc">
                Bấm <strong>"Quét và tải ngay"</strong> ở trên để theo dõi tiến trình thời gian thực: mở Chrome, xoay Proxy IP, giải thử thách Cloudflare, đọc danh sách plugin và lưu file JAR vào kho.
              </span>
            </div>
          ) : (
            logs.map((entry) => {
              const time = new Date(entry.timestamp).toLocaleTimeString('vi-VN', {
                hour12: false,
                hour: '2-digit',
                minute: '2-digit',
                second: '2-digit',
              });
              return (
                <div key={entry.id} className={`console-log-row log-lvl-${entry.level}`}>
                  <span className="console-log-time">[{time}]</span>
                  <span className="console-log-lvl">
                    {entry.level === 'success' && 'SUCCESS'}
                    {entry.level === 'error' && 'ERROR'}
                    {entry.level === 'warn' && 'WARN'}
                    {entry.level === 'info' && 'INFO'}
                  </span>
                  <div className="console-log-content">
                    {parseLogTokens(entry.message)}
                  </div>
                </div>
              );
            })
          )}
        </div>
      </section>

      {challenge?.active && <SpigotChallengePanel challenge={challenge} onClosed={() => setChallenge(null)} />}

      {/* 3. KHU VỰC QUẢN LÝ TÀI KHOẢN SPIGOT - TÁCH BIỆT & THOÁNG ĐÃNG */}
      <section className="panel spigot-accounts-container">
        <div className="spigot-section-nav">
          <div className="spigot-tab-group">
            <button
              type="button"
              className={`spigot-tab-btn ${accountTab === 'current' ? 'active' : ''}`}
              onClick={() => setAccountTab('current')}
            >
              <UserCheck size={16} />
              <span>Tài khoản hiện tại</span>
              {current?.configured && (
                <span className="tab-badge">{current.accounts.length}</span>
              )}
            </button>
            <button
              type="button"
              className={`spigot-tab-btn ${accountTab === 'import' ? 'active' : ''}`}
              onClick={() => setAccountTab('import')}
            >
              <FolderUp size={16} />
              <span>Nhập & Cập nhật</span>
              {preview && (
                <span className="tab-badge ok">{preview.summary.total}</span>
              )}
            </button>
          </div>

          <div className="spigot-tab-tools">
            <span className="hint compact">
              {accountTab === 'current'
                ? 'Danh sách tài khoản dùng để tải tự động'
                : 'Định dạng tài khoản kèm mật khẩu để giải mã'}
            </span>
          </div>
        </div>

        {accountTab === 'current' && (
          <div className="spigot-tab-pane">
            <div className="account-panel-heading" style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 12 }}>
              <div>
                <h3>{vi.spigotAccounts.currentHeading}</h3>
                <p className="hint">{vi.spigotAccounts.currentHint}</p>
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                {current?.configured && (
                  <button
                    type="button"
                    className="small"
                    onClick={() => void handleAutoLink()}
                    disabled={autoLinking}
                    title="Tự động quét danh mục đã mua của tất cả tài khoản và liên kết với các plugin khớp tên trong kho"
                    style={{
                      display: 'inline-flex',
                      alignItems: 'center',
                      gap: 6,
                      background: 'linear-gradient(135deg, rgba(16, 185, 129, 0.2) 0%, rgba(5, 150, 105, 0.3) 100%)',
                      borderColor: 'rgba(16, 185, 129, 0.4)',
                      color: '#6ee7b7',
                      fontWeight: 600,
                      padding: '6px 12px',
                    }}
                  >
                    <Zap size={14} className={autoLinking ? 'spin-icon' : ''} />
                    <span>{autoLinking ? 'Đang tự động liên kết...' : '⚡ Tự động liên kết (Auto-Link)'}</span>
                  </button>
                )}
                {current?.configured && (
                  <span className="badge ok">{vi.spigotAccounts.accountsCount(current.accounts.length)}</span>
                )}
              </div>
            </div>
            {current?.configured === false && (
              <div className="empty-account-box" style={{ padding: '24px 16px', textAlign: 'center' }}>
                <p className="muted" style={{ marginBottom: 12 }}>
                  {vi.spigotAccounts.noValidAccounts}{' '}
                  {current.reason === 'malformed' ? vi.spigotAccounts.fileMalformed : vi.spigotAccounts.noFile}
                </p>
                <button type="button" className="small primary" onClick={() => setAccountTab('import')}>
                  Chuyển sang tab Nhập tài khoản
                </button>
              </div>
            )}
            {current?.configured && (
              <CurrentAccountTable
                accounts={current.accounts}
                onRemovePlugin={handleRemovePlugin}
                onOpenAssignModal={(accountLabel) => {
                  setAssignModalAccount(accountLabel);
                  setSelectedPluginToAssign('');
                  setAssignSearch('');
                }}
              />
            )}

            {/* CẢNH BÁO PLUGIN TRONG KHO CHƯA ĐƯỢC GÁN TÀI KHOẢN */}
            {ownershipData?.unassignedPlugins && ownershipData.unassignedPlugins.length > 0 ? (
              <div
                style={{
                  marginTop: 24,
                  padding: 16,
                  borderRadius: 10,
                  background: 'rgba(245, 158, 11, 0.08)',
                  border: '1px solid rgba(245, 158, 11, 0.25)',
                }}
              >
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 10, flexWrap: 'wrap', gap: 10 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <AlertTriangle size={18} style={{ color: '#f59e0b' }} />
                    <h4 style={{ margin: 0, fontSize: 14, color: '#fbbf24', fontWeight: 600 }}>
                      Plugin trong kho chưa được gán tài khoản Spigot ({ownershipData.unassignedPlugins.length})
                    </h4>
                  </div>
                  <button
                    type="button"
                    className="small"
                    onClick={() => void handleAutoLink()}
                    disabled={autoLinking}
                    style={{
                      display: 'inline-flex',
                      alignItems: 'center',
                      gap: 6,
                      background: 'rgba(245, 158, 11, 0.15)',
                      borderColor: 'rgba(245, 158, 11, 0.35)',
                      color: '#fef3c7',
                    }}
                  >
                    <Zap size={13} className={autoLinking ? 'spin-icon' : ''} />
                    <span>{autoLinking ? 'Đang liên kết...' : '⚡ Thử tự động liên kết tất cả'}</span>
                  </button>
                </div>
                <p className="hint compact" style={{ margin: '0 0 12px 0', color: 'rgba(255, 255, 255, 0.7)' }}>
                  Hệ thống tuân thủ nghiêm ngặt <strong>Strict Account Targeting</strong>: Mỗi tài khoản chỉ sở hữu một số plugin nhất định. Các plugin dưới đây chưa có tài khoản sở hữu được ghi nhận, nên hệ thống sẽ <strong>từ chối tải bừa</strong> để bảo vệ tài khoản khỏi bị khóa hoặc lỗi 403.
                </p>
                <div className="table-scroll">
                  <table style={{ margin: 0, fontSize: 12 }}>
                    <thead>
                      <tr>
                        <th>Tên Plugin trong kho</th>
                        <th>Resource ID</th>
                        <th>Gán nhanh cho Tài khoản Spigot</th>
                      </tr>
                    </thead>
                    <tbody>
                      {ownershipData.unassignedPlugins.map((plugin) => (
                        <tr key={plugin.id}>
                          <td style={{ fontWeight: 500 }}>{plugin.displayName}</td>
                          <td className="mono" style={{ color: 'var(--accent)' }}>
                            #{plugin.resourceId}
                          </td>
                          <td>
                            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                              <select
                                id={`assign-select-${plugin.resourceId}`}
                                style={{
                                  padding: '3px 8px',
                                  fontSize: 12,
                                  borderRadius: 4,
                                  background: 'rgba(0, 0, 0, 0.4)',
                                  border: '1px solid rgba(255, 255, 255, 0.15)',
                                  color: 'inherit',
                                  maxWidth: 240,
                                }}
                                defaultValue=""
                              >
                                <option value="" disabled>
                                  -- Chọn tài khoản sở hữu --
                                </option>
                                {current?.accounts.map((a) => (
                                  <option key={a.label} value={a.label}>
                                    @{a.username} ({a.purchasedResources.length} mục đã mua)
                                  </option>
                                ))}
                              </select>
                              <button
                                type="button"
                                className="small primary"
                                onClick={() => {
                                  const selectEl = document.getElementById(
                                    `assign-select-${plugin.resourceId}`,
                                  ) as HTMLSelectElement | null;
                                  if (selectEl && selectEl.value) {
                                    void handleAssignPlugin(plugin.resourceId, selectEl.value);
                                  } else {
                                    toast.show('info', 'Vui lòng chọn một tài khoản trước');
                                  }
                                }}
                                style={{ padding: '2px 10px', fontSize: 11 }}
                              >
                                Gán
                              </button>
                            </div>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            ) : ownershipData?.unassignedPlugins ? (
              <div
                style={{
                  marginTop: 20,
                  padding: '10px 14px',
                  borderRadius: 8,
                  background: 'rgba(16, 185, 129, 0.08)',
                  border: '1px solid rgba(16, 185, 129, 0.2)',
                  display: 'flex',
                  alignItems: 'center',
                  gap: 8,
                }}
              >
                <ShieldCheck size={16} style={{ color: '#10b981' }} />
                <span style={{ fontSize: 12, color: '#a7f3d0' }}>
                  100% các plugin có Resource ID trong kho đã được gán tài khoản sở hữu chính xác. Hệ thống sẽ tải đúng tài khoản!
                </span>
              </div>
            ) : null}

            {current === null && <p className="muted">{vi.common.loading}</p>}
          </div>
        )}

        {accountTab === 'import' && (
          <div className="spigot-tab-pane">
            <div className="account-panel-heading">
              <div>
                <h3>{vi.spigotAccounts.pasteHeading}</h3>
                <p className="hint">{vi.spigotAccounts.pasteHint}</p>
              </div>
            </div>

            <textarea
              className="credential-input"
              value={text}
              onChange={(event) => {
                setText(event.target.value);
                setPreview(null);
              }}
              placeholder={EXAMPLE}
              spellCheck={false}
            />
            <input
              ref={fileRef}
              type="file"
              accept=".txt,.json,text/plain,application/json"
              hidden
              onChange={(event) => {
                const file = event.target.files?.[0];
                if (file) void loadFile(file);
              }}
            />
            <div className="button-row" style={{ marginTop: 12 }}>
              <button onClick={() => fileRef.current?.click()} style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                <FolderUp size={15} />
                <span>{vi.spigotAccounts.chooseFile}</span>
              </button>
              <button onClick={() => void inspect()} disabled={busy || text.trim() === ''} style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                <CheckCircle2 size={15} />
                <span>{vi.spigotAccounts.inspectButton}</span>
              </button>
              <button className="primary" onClick={() => void save()} disabled={busy || !preview} style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                <Download size={15} />
                <span>{vi.spigotAccounts.saveButton}</span>
              </button>
            </div>
            <p className="hint" style={{ marginTop: 10 }}>{vi.spigotAccounts.securityHint}</p>

            {preview && (
              <div className="preview-container" style={{ marginTop: 24 }}>
                <div className="preview-summary">
                  <span>
                    <strong>{preview.summary.total}</strong>{' '}
                    {vi.spigotAccounts.previewTotal(preview.summary.total).replace(/^\d+\s*/, '')}
                  </span>
                  <span>
                    <strong>{preview.summary.enabled}</strong>{' '}
                    {vi.spigotAccounts.previewEnabled(preview.summary.enabled).replace(/^\d+\s*/, '')}
                  </span>
                  <span>
                    <strong>{preview.summary.excluded}</strong>{' '}
                    {vi.spigotAccounts.previewExcluded(preview.summary.excluded).replace(/^\d+\s*/, '')}
                  </span>
                  <span>
                    <strong>{preview.summary.resources}</strong>{' '}
                    {vi.spigotAccounts.previewResources(preview.summary.resources).replace(/^\d+\s*/, '')}
                  </span>
                </div>
                <p className="hint">{vi.spigotAccounts.previewFilterHint}</p>
                <PreviewAccountTable accounts={preview.accounts} />
              </div>
            )}
          </div>
        )}
      </section>

      {/* MODAL GÁN PLUGIN CHO TÀI KHOẢN */}
      {assignModalAccount && (
        <div
          style={{
            position: 'fixed',
            inset: 0,
            background: 'rgba(0, 0, 0, 0.75)',
            backdropFilter: 'blur(4px)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            zIndex: 1000,
            padding: 16,
          }}
          onClick={() => setAssignModalAccount(null)}
        >
          <div
            style={{
              background: '#181a20',
              border: '1px solid rgba(255, 255, 255, 0.15)',
              borderRadius: 12,
              padding: 24,
              maxWidth: 520,
              width: '100%',
              boxShadow: '0 20px 40px rgba(0, 0, 0, 0.6)',
            }}
            onClick={(e) => e.stopPropagation()}
          >
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 16 }}>
              <div>
                <h3 style={{ margin: 0, fontSize: 16, fontWeight: 600 }}>Gán Plugin cho Tài Khoản Spigot</h3>
                <p className="hint compact" style={{ margin: '4px 0 0 0' }}>
                  Tài khoản: <strong style={{ color: 'var(--accent)' }}>@{assignModalAccount}</strong>
                </p>
              </div>
              <button
                type="button"
                onClick={() => setAssignModalAccount(null)}
                style={{ background: 'transparent', border: 'none', color: 'rgba(255, 255, 255, 0.6)', cursor: 'pointer' }}
              >
                <X size={18} />
              </button>
            </div>

            <div style={{ marginBottom: 16 }}>
              <label style={{ display: 'block', fontSize: 12, marginBottom: 6, fontWeight: 500 }}>
                Tìm kiếm plugin trong kho:
              </label>
              <div style={{ position: 'relative' }}>
                <Search size={14} style={{ position: 'absolute', left: 10, top: 10, opacity: 0.5 }} />
                <input
                  type="text"
                  placeholder="Nhập tên plugin hoặc Resource ID..."
                  value={assignSearch}
                  onChange={(e) => setAssignSearch(e.target.value)}
                  style={{ width: '100%', paddingLeft: 30, fontSize: 13 }}
                />
              </div>
            </div>

            <div style={{ marginBottom: 20 }}>
              <label style={{ display: 'block', fontSize: 12, marginBottom: 6, fontWeight: 500 }}>
                Chọn plugin để liên kết (chỉ tải bằng tài khoản này):
              </label>
              <select
                size={8}
                style={{
                  width: '100%',
                  padding: 8,
                  fontSize: 12,
                  background: 'rgba(0, 0, 0, 0.5)',
                  border: '1px solid rgba(255, 255, 255, 0.15)',
                  borderRadius: 6,
                  color: 'inherit',
                }}
                value={selectedPluginToAssign}
                onChange={(e) => setSelectedPluginToAssign(Number(e.target.value))}
              >
                {ownershipData?.allPlugins
                  ?.filter((p) => {
                    if (!assignSearch) return true;
                    const q = assignSearch.toLowerCase();
                    return p.displayName.toLowerCase().includes(q) || String(p.resourceId).includes(q);
                  })
                  .map((p) => (
                    <option key={p.id} value={p.resourceId} style={{ padding: '6px 8px' }}>
                      {p.displayName} (#{p.resourceId})
                    </option>
                  ))}
              </select>
            </div>

            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 10 }}>
              <button type="button" onClick={() => setAssignModalAccount(null)}>
                Hủy
              </button>
              <button
                type="button"
                className="primary"
                disabled={!selectedPluginToAssign}
                onClick={() => {
                  if (selectedPluginToAssign && assignModalAccount) {
                    void handleAssignPlugin(Number(selectedPluginToAssign), assignModalAccount);
                  }
                }}
              >
                Xác nhận Gán Plugin
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}

function SpigotChallengePanel({ challenge, onClosed }: { challenge: SpigotChallengeStatus; onClosed: () => void }) {
  const [frameNonce, setFrameNonce] = useState(Date.now());
  const [remainingMs, setRemainingMs] = useState<number | null>(
    challenge.expiresAt === null ? null : challenge.expiresAt - Date.now(),
  );
  const [error, setError] = useState<string | null>(null);
  const [text, setText] = useState('');
  const [retrying, setRetrying] = useState(false);
  const pointerTimer = useRef<number | null>(null);
  const pendingPointer = useRef<{ x: number; y: number } | null>(null);

  useEffect(() => {
    if (retrying) return;
    const timer = window.setInterval(() => setFrameNonce(Date.now()), 1400);
    return () => window.clearInterval(timer);
  }, [retrying]);

  useEffect(() => {
    if (challenge.expiresAt === null) return;
    const tick = (): void => setRemainingMs((challenge.expiresAt ?? 0) - Date.now());
    tick();
    const timer = window.setInterval(tick, 1000);
    return () => window.clearInterval(timer);
  }, [challenge.expiresAt]);

  const normalizedPoint = (event: React.MouseEvent<HTMLImageElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    return {
      x: (event.clientX - rect.left) / rect.width,
      y: (event.clientY - rect.top) / rect.height,
    };
  };

  const movePointer = (event: React.MouseEvent<HTMLImageElement>) => {
    if (retrying) return;
    pendingPointer.current = normalizedPoint(event);
    if (pointerTimer.current !== null) return;
    pointerTimer.current = window.setTimeout(() => {
      pointerTimer.current = null;
      const point = pendingPointer.current;
      pendingPointer.current = null;
      if (point) void api.post('/api/spigot-challenge/pointer', point).catch(() => undefined);
    }, 70);
  };

  const clickFrame = async (event: React.MouseEvent<HTMLImageElement>) => {
    if (retrying) return;
    try {
      await api.post('/api/spigot-challenge/click', normalizedPoint(event));
      setFrameNonce(Date.now());
    } catch (err) {
      setError(err instanceof Error ? err.message : vi.spigotAccounts.toastClickFailed);
    }
  };

  const sendText = async () => {
    if (!text || retrying) return;
    try {
      await api.post('/api/spigot-challenge/type', { text });
      setText('');
      setFrameNonce(Date.now());
    } catch (err) {
      setError(err instanceof Error ? err.message : vi.spigotAccounts.toastTypeFailed);
    }
  };

  const retry = async () => {
    setRetrying(true);
    setError(null);
    try {
      await api.post('/api/spigot-challenge/retry');
      onClosed();
    } catch (err) {
      setError(err instanceof Error ? err.message : vi.spigotAccounts.toastLoginFailed);
    } finally {
      setRetrying(false);
    }
  };

  const close = async () => {
    await api.del('/api/spigot-challenge');
    onClosed();
  };

  return (
    <section className="panel challenge-panel">
      <div className="account-panel-heading">
        <div>
          <h3>{vi.spigotAccounts.challengeHeading}</h3>
          <p className="hint">
            {vi.spigotAccounts.challengeAccount}: {challenge.accountLabel}. {challenge.reason}
          </p>
        </div>
        <span className={remainingMs !== null && remainingMs < 2 * 60_000 ? 'badge danger' : 'badge warn'}>
          {remainingMs === null
            ? vi.spigotAccounts.challengeAutoClose
            : vi.spigotAccounts.challengeRemaining(Math.max(0, Math.ceil(remainingMs / 60_000)))}
        </span>
      </div>
      <p className="hint">{vi.spigotAccounts.challengeHostHint}</p>
      <p className="hint">{vi.spigotAccounts.challengeInstruction}</p>
      <img
        className="challenge-frame"
        src={`/api/spigot-challenge/frame?t=${frameNonce}`}
        onMouseMove={movePointer}
        onClick={(event) => void clickFrame(event)}
        aria-busy={retrying}
        alt={vi.spigotAccounts.challengeAlt}
      />
      <div className="challenge-controls">
        <input
          disabled={retrying}
          value={text}
          onChange={(event) => setText(event.target.value)}
          placeholder={vi.spigotAccounts.challengeInputPlaceholder}
        />
        <button disabled={retrying} onClick={() => void sendText()}>
          {vi.spigotAccounts.challengeSendText}
        </button>
        {(['Tab', 'Enter', 'Backspace', 'Escape'] as const).map((key) => (
          <button
            disabled={retrying}
            key={key}
            onClick={() => void api.post('/api/spigot-challenge/key', { key }).then(() => setFrameNonce(Date.now()))}
          >
            {key}
          </button>
        ))}
        <button className="primary" disabled={retrying} onClick={() => void retry()}>
          {retrying ? vi.spigotAccounts.challengeVerifying : vi.spigotAccounts.challengeVerified}
        </button>
        <button disabled={retrying} onClick={() => void close()}>
          {vi.spigotAccounts.challengeClose}
        </button>
      </div>
      {error && <p className="error">{error}</p>}
    </section>
  );
}

function CurrentAccountTable({
  accounts,
  onRemovePlugin,
  onOpenAssignModal,
}: {
  accounts: SpigotAccountView[];
  onRemovePlugin: (resourceId: number, accountLabel: string) => Promise<void>;
  onOpenAssignModal: (accountLabel: string) => void;
}) {
  return (
    <div className="table-scroll">
      <table>
        <thead>
          <tr>
            <th style={{ width: '180px' }}>{vi.spigotAccounts.colAccount}</th>
            <th style={{ width: '120px' }}>{vi.spigotAccounts.colStatus}</th>
            <th style={{ minWidth: '280px' }}>Plugin trong kho đã gán (Tải đúng tài khoản)</th>
            <th style={{ minWidth: '200px' }}>{vi.spigotAccounts.colResource} (Gốc Spigot)</th>
            <th style={{ width: '110px' }}>{vi.spigotAccounts.colDecision}</th>
          </tr>
        </thead>
        <tbody>
          {accounts.map((account) => (
            <tr key={account.label}>
              <td>
                <div style={{ fontWeight: 600 }}>{account.username}</div>
                <div className="hint compact mono" style={{ fontSize: 11, opacity: 0.75 }}>
                  {account.label}
                </div>
              </td>
              <td>
                <LiveScanStatus account={account} />
              </td>
              <td>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                    <span className="hint compact" style={{ margin: 0, fontWeight: 500 }}>
                      Đã gán: <strong>{account.ownedPlugins?.length ?? 0}</strong> plugin
                    </span>
                    <button
                      type="button"
                      className="small"
                      onClick={() => onOpenAssignModal(account.label)}
                      style={{
                        padding: '2px 8px',
                        fontSize: '11px',
                        display: 'inline-flex',
                        alignItems: 'center',
                        gap: '4px',
                        background: 'rgba(59, 130, 246, 0.15)',
                        borderColor: 'rgba(59, 130, 246, 0.3)',
                        color: '#93c5fd',
                      }}
                    >
                      <Plus size={12} />
                      <span>Gán Plugin</span>
                    </button>
                  </div>
                  <div className="spigot-assigned-tags-wrap">
                    {account.ownedPlugins && account.ownedPlugins.length > 0 ? (
                      account.ownedPlugins.map((plugin) => (
                        <span
                          key={plugin.id}
                          className="spigot-assigned-tag"
                          title={`Resource ID: #${plugin.resourceId} — Slug: ${plugin.slug}`}
                        >
                          <PackageCheck size={13} style={{ color: '#818cf8', flexShrink: 0 }} />
                          <span className="spigot-assigned-tag-title">{plugin.displayName}</span>
                          <span className="spigot-assigned-tag-id">#{plugin.resourceId}</span>
                          <button
                            type="button"
                            className="spigot-assigned-tag-remove"
                            onClick={(e) => {
                              e.stopPropagation();
                              void onRemovePlugin(plugin.resourceId, account.label);
                            }}
                            title={`Gỡ liên kết ${plugin.displayName} khỏi tài khoản này`}
                          >
                            <X size={11} strokeWidth={2.5} />
                          </button>
                        </span>
                      ))
                    ) : (
                      <span className="hint compact muted" style={{ margin: 0, fontSize: 11, fontStyle: 'italic' }}>
                        Chưa gán plugin nào từ kho (Bấm "Gán Plugin" để liên kết)
                      </span>
                    )}
                  </div>
                </div>
              </td>
              <td>
                <div className="resource-count">
                  {vi.spigotAccounts.importCount(account.purchasedResources.length)}
                  {account.liveScan.resourceCount !== null
                    ? ` | ${vi.spigotAccounts.liveScanCount(account.liveScan.resourceCount)}`
                    : ''}
                </div>
                <div className="resource-list">
                  {account.purchasedResources.map((resource) => (
                    <span key={resource}>{resource}</span>
                  ))}
                </div>
              </td>
              <td>
                {account.enabled ? (
                  <span className="badge ok">{vi.spigotAccounts.decisionEnabled}</span>
                ) : (
                  <>
                    <span className="badge">{vi.spigotAccounts.decisionSkipped}</span>
                    <p className="hint compact">{account.exclusionReason}</p>
                  </>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function LiveScanStatus({ account }: { account: SpigotAccountView }) {
  const scan = account.liveScan;
  if (scan.status === 'never') return <span className="badge warn">{vi.spigotAccounts.statusNever}</span>;
  return (
    <>
      <span className={scan.status === 'ok' ? 'badge ok' : 'badge danger'}>
        {scan.status === 'ok' ? vi.spigotAccounts.statusSuccess : vi.spigotAccounts.statusFailed}
      </span>
      <p className="hint compact" title={formatTimestamp(scan.lastScanAt)}>
        <TimeAgo unixSeconds={scan.lastScanAt} />
      </p>
      {scan.error && <p className="hint compact error-text">{scan.error}</p>}
    </>
  );
}

function PreviewAccountTable({ accounts }: { accounts: SpigotCredentialPreviewAccount[] }) {
  return (
    <div className="table-scroll">
      <table>
        <thead>
          <tr>
            <th>{vi.spigotAccounts.colAccount}</th>
            <th>{vi.spigotAccounts.colImportStatus}</th>
            <th>{vi.spigotAccounts.colResource}</th>
            <th>{vi.spigotAccounts.colDecision}</th>
          </tr>
        </thead>
        <tbody>
          {accounts.map((account) => (
            <tr key={account.label}>
              <td>{account.username}</td>
              <td>
                <span className={account.importedStatus === 'success' ? 'badge ok' : 'badge warn'}>
                  {account.importedStatus || vi.spigotAccounts.statusUnknown}
                </span>
              </td>
              <td>
                <div className="resource-count">
                  {vi.spigotAccounts.importCount(account.purchasedResources.length)}
                </div>
                <div className="resource-list">
                  {account.purchasedResources.map((resource) => (
                    <span key={resource}>{resource}</span>
                  ))}
                </div>
              </td>
              <td>
                {account.enabled ? (
                  <span className="badge ok">{vi.spigotAccounts.decisionEnabled}</span>
                ) : (
                  <>
                    <span className="badge">{vi.spigotAccounts.decisionSkipped}</span>
                    <p className="hint compact">{account.exclusionReason}</p>
                  </>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
