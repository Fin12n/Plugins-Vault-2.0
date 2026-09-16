import React, { useState } from 'react';
import {
  Cpu,
  Globe,
  Package,
  UserCheck,
  CheckCircle2,
  AlertTriangle,
  Loader2,
  Layers,
  Sparkles,
  Zap,
} from 'lucide-react';
import type { InstanceWorkerState, WorkerStatus } from '../lib/api-client.js';

type InstanceMonitorProps = {
  instances: InstanceWorkerState[];
  concurrency: number;
  activeWorkers: number;
  isRunning: boolean;
  selectedWorkerId?: number | 'all';
  onConcurrencyChange?: (concurrency: number) => Promise<void> | void;
  onSelectWorkerLog?: (workerId: number) => void;
};

export function InstanceMonitor({
  instances,
  concurrency,
  activeWorkers,
  isRunning,
  selectedWorkerId,
  onConcurrencyChange,
  onSelectWorkerLog,
}: InstanceMonitorProps) {
  const [changingConcurrency, setChangingConcurrency] = useState(false);

  const handleSelectConcurrency = async (count: number) => {
    if (count === concurrency || changingConcurrency) return;
    try {
      setChangingConcurrency(true);
      await onConcurrencyChange?.(count);
    } finally {
      setChangingConcurrency(false);
    }
  };

  const getStatusBadge = (status: WorkerStatus) => {
    switch (status) {
      case 'downloading':
        return (
          <span className="instance-badge instance-badge-downloading">
            <span className="instance-pulse-dot bg-ok" />
            Đang tải jar
          </span>
        );
      case 'logging_in':
        return (
          <span className="instance-badge instance-badge-login">
            <Loader2 className="w-3 h-3 animate-spin text-accent" />
            Đăng nhập
          </span>
        );
      case 'starting':
        return (
          <span className="instance-badge instance-badge-starting">
            <Loader2 className="w-3 h-3 animate-spin text-accent" />
            Khởi động Chrome
          </span>
        );
      case 'solving_challenge':
        return (
          <span className="instance-badge instance-badge-solving">
            <Zap className="w-3 h-3 text-warn" />
            Giải Cloudflare
          </span>
        );
      case 'stalled':
        return (
          <span className="instance-badge instance-badge-error" style={{ color: '#f59e0b', borderColor: '#f59e0b' }}>
            <AlertTriangle className="w-3 h-3 text-warn animate-bounce" />
            Bị nghẽn (&gt;90s)
          </span>
        );
      case 'error':
        return (
          <span className="instance-badge instance-badge-error">
            <AlertTriangle className="w-3 h-3 text-danger" />
            Gặp sự cố
          </span>
        );
      case 'stopped':
        return (
          <span className="instance-badge instance-badge-error" style={{ color: '#ef4444', borderColor: '#ef4444' }}>
            <AlertTriangle className="w-3 h-3 text-danger" />
            Đã dừng luồng (Chrome bị tắt)
          </span>
        );
      case 'completed':
        return (
          <span className="instance-badge instance-badge-completed">
            <CheckCircle2 className="w-3 h-3 text-ok" />
            Hoàn thành
          </span>
        );
      case 'idle':
      default:
        return (
          <span className="instance-badge instance-badge-idle">
            <span className="instance-dot-idle" />
            Chờ nhiệm vụ
          </span>
        );
    }
  };

  // Nếu chưa có instances nào (ví dụ chưa quét bao giờ), tự tạo các placeholder theo concurrency
  const displayInstances: InstanceWorkerState[] =
    instances.length > 0
      ? instances
      : Array.from({ length: concurrency }, (_, idx) => ({
          id: idx + 1,
          status: 'idle',
          accountLabel: null,
          proxy: null,
          pluginName: null,
          versionName: null,
          progressText: 'Chờ bắt đầu phiên quét...',
          bytesDownloaded: 0,
          startedAt: null,
          updatedAt: Date.now(),
          successCount: 0,
          failCount: 0,
        }));

  return (
    <div className="instance-monitor-container">
      {/* Header bar */}
      <div className="instance-monitor-header">
        <div className="instance-monitor-title-group">
          <div className="instance-icon-wrapper">
            <Cpu className="w-5 h-5 text-accent" />
          </div>
          <div>
            <div className="instance-title-row">
              <h3 className="instance-monitor-title">Giám Sát Trình Duyệt Song Song</h3>
              <span className={`instance-state-pill ${isRunning ? 'running' : 'idle'}`}>
                {isRunning ? (
                  <>
                    <span className="instance-pulse-dot" />
                    Đang chạy ({activeWorkers}/{concurrency} luồng)
                  </>
                ) : (
                  <>
                    <span className="instance-dot-idle" />
                    Chế độ chờ ({concurrency} luồng sẵn sàng)
                  </>
                )}
              </span>
            </div>
            <p className="instance-monitor-subtitle">
              Mỗi luồng mở một trình duyệt Chrome độc lập với tài khoản và Proxy xoay IP riêng biệt.
            </p>
          </div>
        </div>

        {/* Concurrency controller */}
        <div className="instance-concurrency-control">
          <span className="instance-concurrency-label">
            <Layers className="w-3.5 h-3.5 mr-1 inline" />
            Số luồng song song:
          </span>
          <div className="instance-concurrency-buttons">
            {[1, 2, 3, 4, 5].map((count) => {
              const isSelected = count === concurrency;
              return (
                <button
                  key={count}
                  type="button"
                  disabled={changingConcurrency}
                  className={`instance-concurrency-btn ${isSelected ? 'active' : ''}`}
                  onClick={() => handleSelectConcurrency(count)}
                  title={`Chạy ${count} trình duyệt cùng lúc`}
                >
                  {count}
                </button>
              );
            })}
          </div>
        </div>
      </div>

      {/* Grid Workers Cards */}
      <div className="instance-workers-grid">
        {displayInstances.map((worker) => {
          const isBusy = worker.status !== 'idle' && worker.status !== 'completed';
          return (
            <div
              key={worker.id}
              className={`instance-worker-card ${isBusy ? 'card-active' : 'card-idle'}`}
            >
              {/* Card Top */}
              <div className="instance-worker-card-header">
                <div className="instance-worker-id">
                  <div className="instance-worker-avatar">
                    <span>#{worker.id}</span>
                  </div>
                  <div>
                    <span className="instance-worker-name">Worker #{worker.id}</span>
                    <span className="instance-worker-time">
                      {isBusy ? 'Đang xử lý' : 'Đang nghỉ'}
                    </span>
                  </div>
                </div>
                {getStatusBadge(worker.status)}
              </div>

              {/* Account & Proxy Info */}
              <div className="instance-worker-meta">
                <div className="instance-meta-item" title="Tài khoản Spigot đang sử dụng">
                  <UserCheck className="w-3.5 h-3.5 text-muted" />
                  <span className="instance-meta-label">Account:</span>
                  <span className="instance-meta-value">
                    {worker.accountLabel ? `@${worker.accountLabel}` : '---'}
                  </span>
                </div>

                <div className="instance-meta-item" title="Proxy IP gán cho Worker này">
                  <Globe className="w-3.5 h-3.5 text-muted" />
                  <span className="instance-meta-label">Proxy:</span>
                  <span className="instance-meta-value" title={worker.proxy ?? 'Direct'}>
                    {worker.proxy ? worker.proxy.replace(/^[a-z]+:\/\//i, '') : 'Direct'}
                  </span>
                </div>
              </div>

              {/* Current Job (Plugin & Version) */}
              <div className="instance-worker-task">
                <Package className="w-4 h-4 text-accent" />
                <div className="instance-task-info">
                  <span className="instance-task-plugin">
                    {worker.pluginName || 'Chưa nhận plugin'}
                  </span>
                  {worker.versionName && (
                    <span className="instance-task-version">v{worker.versionName}</span>
                  )}
                </div>
              </div>

              {/* Realtime progress log line */}
              <div className="instance-worker-progress">
                <div className="instance-progress-text" title={worker.progressText}>
                  {worker.progressText || 'Sẵn sàng'}
                </div>
              </div>

              {/* Stats footer */}
              <div className="instance-worker-footer" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <div style={{ display: 'flex', gap: '6px' }}>
                  <div className="instance-stats-pill success">
                    <CheckCircle2 className="w-3 h-3 mr-1 inline text-ok" />
                    <span>{worker.successCount} xong</span>
                  </div>
                  {worker.failCount > 0 && (
                    <div className="instance-stats-pill fail">
                      <AlertTriangle className="w-3 h-3 mr-1 inline text-warn" />
                      <span>{worker.failCount} lỗi</span>
                    </div>
                  )}
                </div>

                {onSelectWorkerLog && (
                  <button
                    type="button"
                    className="instance-stats-pill"
                    onClick={() => onSelectWorkerLog(worker.id)}
                    style={{
                      cursor: 'pointer',
                      background: selectedWorkerId === worker.id ? 'rgba(59, 130, 246, 0.25)' : 'rgba(255, 255, 255, 0.06)',
                      borderColor: selectedWorkerId === worker.id ? 'var(--accent)' : 'rgba(255, 255, 255, 0.12)',
                      color: selectedWorkerId === worker.id ? 'var(--accent)' : 'inherit',
                      padding: '2px 8px',
                      fontSize: '11px',
                    }}
                    title={`Lọc xem riêng nhật ký của Worker #${worker.id}`}
                  >
                    <span>📋 Xem log</span>
                  </button>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
