import type { Db } from '../../db/connection.js';
import { countPlugins, listPlugins, updatePlugin } from '../../repositories/plugins.js';
import { findUpstreamState, saveUpstreamState, touchUpstreamState } from '../../repositories/upstream-state.js';
import { listVersionsByPlugin } from '../../repositories/versions.js';
import type { SpigetClient, SpigetVersion } from './spiget-client.js';

export type UpdateFinding = {
  pluginId: number;
  pluginName: string;
  resourceId: number;
  isPremium: boolean;
  upstream: SpigetVersion;
  /** Newest version currently archived, or null when the vault has none. */
  archivedVersion: string | null;
};

export type CheckOutcome = { findings: UpdateFinding[]; checked: number; failed: number };

/**
 * Polls every plugin that has a resource id and reports genuinely new versions.
 *
 * Notification only, never automated acquisition: downloading a purchased premium
 * resource automatically is not something the marketplace permits, and premium
 * metadata is scraped with reduced fidelity anyway, so the owner verifies before
 * acting.
 *
 * Each plugin is isolated in a try/catch — one 404 or timeout must not abort the
 * sweep for the rest.
 */
export async function checkPluginUpdates(
  db: Db,
  client: SpigetClient,
  logger: { warn: (message: string) => void } = { warn: console.warn },
  onProgress?: (index: number, total: number, pluginName: string) => void,
): Promise<CheckOutcome> {
  const total = countPlugins(db);
  const tracked = listPlugins(db, total, 0).filter((plugin) => plugin.resourceId !== null);

  const findings: UpdateFinding[] = [];
  let checked = 0;
  let failed = 0;

  for (let i = 0; i < tracked.length; i++) {
    const plugin = tracked[i]!;
    onProgress?.(i + 1, tracked.length, plugin.displayName);
    const resourceId = plugin.resourceId!;
    try {
      if (!plugin.externalLink || plugin.externalLink.trim() === '') {
        const spigotUrl = `https://www.spigotmc.org/resources/${resourceId}/`;
        updatePlugin(db, plugin.id, { externalLink: spigotUrl });
        plugin.externalLink = spigotUrl;
      }
      const latest = await client.getLatestVersion(resourceId);
      checked++;
      if (!latest) continue;

      const state = findUpstreamState(db, plugin.id);

      // Identity is the uuid, not the name: names repeat across releases, so
      // comparing them would miss a genuine update.
      if (state?.versionUuid === latest.uuid) {
        touchUpstreamState(db, plugin.id);
        continue;
      }

      const newestArchived = listVersionsByPlugin(db, plugin.id, 1)[0] ?? null;

      // First sight of a plugin records the state without announcing: the owner
      // does not need a notification for something already in the vault.
      const isFirstObservation = state === null;
      saveUpstreamState(db, {
        pluginId: plugin.id,
        versionUuid: latest.uuid,
        versionName: latest.name,
        releaseDateMs: latest.releaseDateMs,
      });

      if (isFirstObservation && newestArchived?.version === latest.name) continue;

      findings.push({
        pluginId: plugin.id,
        pluginName: plugin.displayName,
        resourceId,
        isPremium: plugin.isPremium,
        upstream: latest,
        archivedVersion: newestArchived?.version ?? null,
      });
    } catch (err) {
      failed++;
      logger.warn(`Không kiểm tra được resource ${resourceId}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  return { findings, checked, failed };
}

/** Vietnamese notification text for one finding. */
export function formatUpdateNotice(finding: UpdateFinding): string {
  const released = new Date(finding.upstream.releaseDateMs).toLocaleDateString('vi-VN', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
  });
  const archived = finding.archivedVersion ?? 'chưa có bản nào';
  const premiumNote = finding.isPremium
    ? '\n_Plugin premium — dữ liệu phiên bản có thể chậm, hãy kiểm tra lại trên trang resource._'
    : '';

  return (
    `**${finding.pluginName}** có bản mới: \`${finding.upstream.name}\` (phát hành ${released})\n` +
    `Kho đang có: \`${archived}\`\n` +
    `https://www.spigotmc.org/resources/${finding.resourceId}/${premiumNote}`
  );
}
