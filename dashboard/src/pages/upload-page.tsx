import { useCallback, useRef, useState } from 'react';
import { UploadCloud } from 'lucide-react';
import { useToast } from '../components/toast.js';
import { Stat } from '../components/ui.js';
import { api, type UploadResponse } from '../lib/api-client.js';
import { formatBytes, vi } from '../i18n/vi.js';

const ACCEPTED = ['.jar', '.zip'];

/** Drag-drop batch upload with a per-file outcome report. */
export function UploadPage() {
  const toast = useToast();
  const [over, setOver] = useState(false);
  const [busy, setBusy] = useState(false);
  const [queued, setQueued] = useState<{ count: number; bytes: number } | null>(null);
  /** Số byte đã gửi, để vẽ thanh tiến trình thật thay vì một dòng chữ đứng im. */
  const [sent, setSent] = useState(0);
  const [result, setResult] = useState<UploadResponse | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const resultRef = useRef<HTMLDivElement>(null);

  const send = useCallback(
    async (files: File[]) => {
      if (busy) {
        toast.error(vi.upload.toastBusy);
        return;
      }

      const jars = files.filter((file) => ACCEPTED.some((ext) => file.name.toLowerCase().endsWith(ext)));
      const rejected = files.length - jars.length;
      if (rejected > 0) {
        toast.error(vi.upload.toastRejected(rejected, ACCEPTED.join(' / ')));
      }
      if (jars.length === 0) return;

      setBusy(true);
      setResult(null);
      setQueued({ count: jars.length, bytes: jars.reduce((sum, file) => sum + file.size, 0) });
      setSent(0);
      try {
        const response = await api.upload(jars, (sentBytes) => setSent(sentBytes));
        setResult(response);
        const { added, duplicate, pending, failed } = response.summary;
        if (failed > 0) toast.error(vi.upload.toastFailed(added, failed));
        else if (pending > 0) toast.show('info', vi.upload.toastPending(added, pending));
        else toast.success(vi.upload.toastSuccess(added, duplicate));
        requestAnimationFrame(() => resultRef.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest' }));
      } catch (err) {
        toast.error(err instanceof Error ? err.message : vi.common.error);
      } finally {
        setBusy(false);
        setQueued(null);
      }
    },
    [busy, toast],
  );

  return (
    <>
      <div className="content-head">
        <h2>{vi.upload.heading}</h2>
        <span className="muted">{vi.upload.subtitle}</span>
      </div>

      <div
        className={`dropzone${over ? ' over' : ''}`}
        role="button"
        tabIndex={busy ? -1 : 0}
        aria-disabled={busy}
        aria-label={vi.upload.dropHint}
        onDragOver={(event) => {
          event.preventDefault();
          if (!busy) setOver(true);
        }}
        onDragLeave={() => setOver(false)}
        onDrop={(event) => {
          event.preventDefault();
          setOver(false);
          void send(Array.from(event.dataTransfer.files));
        }}
        onClick={() => {
          if (!busy) inputRef.current?.click();
        }}
        onKeyDown={(event) => {
          if (busy) return;
          if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault();
            inputRef.current?.click();
          }
        }}
      >
        {busy ? (
          <>
            <span className="status status-running">
              <span className="status-dot" aria-hidden="true" />
              {queued ? vi.upload.uploadingQueued(queued.count, formatBytes(queued.bytes)) : vi.upload.uploading}
            </span>
            {queued && (
              <div className="progress" role="progressbar" aria-valuemin={0} aria-valuemax={queued.bytes} aria-valuenow={sent}>
                <div className="progress-bar" style={{ width: `${Math.round((sent / queued.bytes) * 100)}%` }} />
                <span className="progress-label">
                  {formatBytes(sent)} / {formatBytes(queued.bytes)}
                  {sent >= queued.bytes && vi.upload.readingDescriptor}
                </span>
              </div>
            )}
          </>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 14 }}>
            <div
              style={{
                width: 56,
                height: 56,
                borderRadius: '50%',
                backgroundColor: 'var(--surface)',
                boxShadow: 'var(--nm-raised-sm)',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                color: 'var(--accent)',
              }}
            >
              <UploadCloud size={28} />
            </div>
            <div style={{ textAlign: 'center' }}>
              <p style={{ margin: '0 0 6px', fontSize: 16, fontWeight: 750, color: 'var(--heading)' }}>
                {vi.upload.dropHint}
              </p>
              <p style={{ margin: 0, fontSize: 13, color: 'var(--muted)' }}>
                {vi.upload.subtitle}
              </p>
            </div>
            <button
              type="button"
              className="small"
              style={{ pointerEvents: 'none', marginTop: 4 }}
            >
              {vi.upload.browseButton}
            </button>
          </div>
        )}
        <input
          ref={inputRef}
          type="file"
          multiple
          accept={ACCEPTED.join(',')}
          hidden
          onChange={(event) => {
            void send(Array.from(event.target.files ?? []));
            event.target.value = '';
          }}
        />
      </div>

      {result && (
        <div ref={resultRef} className="panel" style={{ marginTop: 16 }}>
          <h3>{vi.upload.resultHeading}</h3>
          <div className="stat-grid" style={{ marginBottom: 16 }}>
            <Stat label={vi.upload.added} value={result.summary.added} tone={result.summary.added > 0 ? 'ok' : undefined} />
            <Stat label={vi.upload.duplicate} value={result.summary.duplicate} />
            <Stat
              label={vi.upload.pending}
              value={result.summary.pending}
              tone={result.summary.pending > 0 ? 'warn' : undefined}
            />
            <Stat
              label={vi.upload.failed}
              value={result.summary.failed}
              tone={result.summary.failed > 0 ? 'danger' : undefined}
            />
          </div>
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>{vi.upload.colFile}</th>
                  <th>{vi.upload.colResult}</th>
                </tr>
              </thead>
              <tbody>
                {result.results.map((row, index) => (
                  <tr key={`${row.originalName}-${index}`}>
                    <td className="mono">{row.originalName}</td>
                    <td>{renderOutcome(row)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {result.summary.pending > 0 && (
            <p className="hint">{vi.upload.pendingTabHint(vi.nav.pending)}</p>
          )}
        </div>
      )}
    </>
  );
}

function renderOutcome(row: UploadResponse['results'][number]) {
  switch (row.status) {
    case 'added':
      return (
        <>
          <span className="badge ok">{vi.upload.added}</span> {row.pluginName} {row.version ?? ''}{' '}
          {row.createdPlugin && (
            <span className="badge accent" style={{ marginLeft: 6 }} title={vi.upload.badgeNewPluginTooltip}>
              {vi.upload.badgeNewPlugin}
            </span>
          )}
          {row.versionFlag !== 'ok' && (
            <span className="badge warn" style={{ marginLeft: 6 }} title={vi.plugins.flagWarning}>
              {row.versionFlag}
            </span>
          )}
        </>
      );
    case 'duplicate':
      return (
        <>
          <span className="badge">{vi.upload.duplicate}</span> {row.existingPluginName} {row.existingVersion ?? ''}
        </>
      );
    case 'pending':
      return (
        <>
          <span className="badge warn">{vi.upload.pending}</span> {vi.pending.reasons[row.reason] ?? row.reason}
          {row.detail && <span className="hint">{row.detail}</span>}
        </>
      );
    case 'failed':
      return (
        <>
          <span className="badge danger">{vi.upload.failed}</span> <span className="muted">{row.detail}</span>
        </>
      );
  }
}
