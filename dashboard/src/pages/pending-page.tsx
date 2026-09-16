import { useState } from 'react';
import { useToast } from '../components/toast.js';
import { EmptyState, ErrorState, RefreshButton, TableSkeleton, TimeAgo } from '../components/ui.js';
import { formatBytes, vi } from '../i18n/vi.js';
import { api, type PendingView, type PluginView } from '../lib/api-client.js';
import { useAsync } from '../lib/use-async.js';

/** Manual assignment queue for jars the automatic path could not identify. */
export function PendingPage() {
  const pending = useAsync<{ items: PendingView[] }>('/api/pending');
  const plugins = useAsync<{ items: PluginView[] }>('/api/plugins?pageSize=200');

  const reload = async (): Promise<void> => {
    await Promise.all([pending.reload(), plugins.reload()]);
  };

  return (
    <>
      <div className="content-head">
        <h2>{vi.pending.heading}</h2>
        <div className="button-row">
          {pending.data && pending.data.items.length > 0 && (
            <span className="muted">{vi.pending.pendingCount(pending.data.items.length)}</span>
          )}
          <RefreshButton onClick={() => void reload()} busy={pending.refreshing} />
        </div>
      </div>

      {pending.error && <ErrorState message={pending.error} onRetry={() => void reload()} />}
      {pending.loading && <TableSkeleton rows={3} cols={3} />}

      {pending.data?.items.length === 0 && !pending.error && (
        <EmptyState
          title={vi.pending.empty}
          hint={vi.pending.emptyHint}
        />
      )}

      <div className={pending.refreshing ? 'refreshing' : undefined}>
        {pending.data?.items.map((item) => (
          <PendingRow key={item.id} item={item} plugins={plugins.data?.items ?? []} onDone={() => void reload()} />
        ))}
      </div>
    </>
  );
}

function PendingRow({
  item,
  plugins,
  onDone,
}: {
  item: PendingView;
  plugins: PluginView[];
  onDone: () => void;
}) {
  const toast = useToast();
  const [pluginId, setPluginId] = useState('');
  const [version, setVersion] = useState('');
  const [busy, setBusy] = useState<'assign' | 'discard' | null>(null);

  const assign = async (): Promise<void> => {
    if (!pluginId || !version.trim()) return;
    setBusy('assign');
    try {
      await api.post(`/api/pending/${item.id}/assign`, { pluginId: Number(pluginId), version: version.trim() });
      const name = plugins.find((plugin) => String(plugin.id) === pluginId)?.displayName ?? 'plugin';
      toast.success(vi.pending.toastAssigned(item.originalFilename, name, version.trim()));
      onDone();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : vi.common.error);
    } finally {
      setBusy(null);
    }
  };

  const discard = async (): Promise<void> => {
    if (!confirm(vi.pending.confirmDiscard)) return;
    setBusy('discard');
    try {
      await api.del(`/api/pending/${item.id}`);
      toast.success(vi.pending.toastDiscarded(item.originalFilename));
      onDone();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : vi.common.error);
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="panel">
      <div style={{ marginBottom: 12 }}>
        <strong className="mono">{item.originalFilename}</strong>
        <div className="hint">
          {formatBytes(item.bytes)} · <TimeAgo unixSeconds={item.createdAt} />
        </div>
        <div style={{ marginTop: 6 }}>
          <span className="badge warn">{vi.pending.reasons[item.reason] ?? item.reason}</span>
          {item.detail && (
            <span className="muted" style={{ marginLeft: 8, fontSize: 13 }}>
              {item.detail}
            </span>
          )}
        </div>
      </div>

      <div className="row">
        <label htmlFor={`assign-plugin-${item.id}`}>
          <span>{vi.pending.assignTo}</span>
          <select
            id={`assign-plugin-${item.id}`}
            value={pluginId}
            onChange={(event) => setPluginId(event.target.value)}
          >
            <option value="">{vi.pending.selectPlugin}</option>
            {plugins.map((plugin) => (
              <option key={plugin.id} value={plugin.id}>
                {plugin.displayName}
              </option>
            ))}
          </select>
        </label>
        <label htmlFor={`assign-version-${item.id}`}>
          <span>{vi.pending.version}</span>
          <input
            id={`assign-version-${item.id}`}
            value={version}
            onChange={(event) => setVersion(event.target.value)}
            placeholder="1.0.0"
            onKeyDown={(event) => {
              // Enter trong ô phiên bản là hành động rõ ràng nhất ở đây.
              if (event.key === 'Enter' && pluginId && version.trim()) void assign();
            }}
          />
        </label>
        <button
          className="primary"
          disabled={busy !== null || !pluginId || !version.trim()}
          aria-busy={busy === 'assign'}
          onClick={() => void assign()}
        >
          {vi.pending.assign}
        </button>
        <button className="danger" disabled={busy !== null} aria-busy={busy === 'discard'} onClick={() => void discard()}>
          {vi.pending.discard}
        </button>
      </div>
      {plugins.length === 0 && <p className="hint">Chưa có plugin nào để gán — hãy tải lên một jar đọc được trước.</p>}
    </div>
  );
}
