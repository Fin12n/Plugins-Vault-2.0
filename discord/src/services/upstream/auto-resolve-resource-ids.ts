import type { Db } from '../../db/connection.js';
import { listPlugins, updatePlugin } from '../../repositories/plugins.js';
import { displayFrom, normalizeName } from './sync-purchased-resources.js';
import { sweepLogs } from '../maintenance/sweep-logs.js';

export type ResolvedResource = {
  pluginId: number;
  displayName: string;
  resourceId: number;
  spigotName: string;
};

export type AutoResolveResult = {
  resolved: ResolvedResource[];
  unresolved: { pluginId: number; displayName: string }[];
};

type SpigetSearchItem = {
  id: number;
  name: string;
  tag?: string;
  downloads?: number;
};

const SPIGET_SEARCH_BASE = 'https://api.spiget.org/v2/search/resources';

/**
 * Tự động tra cứu và gắn mã Resource ID cho các plugin chưa gắn mã bằng Spiget Search API.
 *
 * Giúp tự động hóa toàn diện: Người dùng không cần phải tra cứu thủ công mã số
 * Spigot của từng plugin để nhập vào bảng.
 */
export async function autoResolveMissingResourceIds(
  db: Db,
  options?: {
    fetchImpl?: typeof fetch;
    delayMs?: number;
    log?: (message: string, level?: 'info' | 'success' | 'warn' | 'error') => void;
  },
): Promise<AutoResolveResult> {
  const fetchFn = options?.fetchImpl ?? fetch;
  const delayMs = options?.delayMs ?? 400;
  const log =
    options?.log ??
    ((msg, level) => {
      console.log(msg);
      sweepLogs.add(msg, level ?? 'info');
    });

  const allPlugins = listPlugins(db, 100_000, 0);
  const unassigned = allPlugins.filter((p) => p.resourceId === null);
  const takenIds = new Set<number>(
    allPlugins.map((p) => p.resourceId).filter((id): id is number => id !== null),
  );

  const result: AutoResolveResult = { resolved: [], unresolved: [] };
  if (unassigned.length === 0) {
    return result;
  }

  log(`🔍 Bắt đầu tự động tra cứu mã Spigot cho ${unassigned.length} plugin chưa gắn mã...`, 'info');

  for (let i = 0; i < unassigned.length; i++) {
    const plugin = unassigned[i]!;
    // Đợi một khoảng ngắn tránh rate limit của Spiget API
    if (i > 0 && delayMs > 0) {
      await new Promise((r) => setTimeout(r, delayMs));
    }

    const cleanDisplay = displayFrom(plugin.displayName);
    const searchQueries = [
      cleanDisplay,
      cleanDisplay.replace(/[^a-zA-Z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim(),
      plugin.descriptorName,
    ].filter((q, idx, arr) => q && q.length >= 2 && arr.indexOf(q) === idx);

    let candidates: SpigetSearchItem[] = [];
    for (const query of searchQueries) {
      try {
        const url = `${SPIGET_SEARCH_BASE}/${encodeURIComponent(query)}?field=name&size=6`;
        const resp = await fetchFn(url, {
          headers: {
            'user-agent': 'plugin-vault-bot (auto-resolver)',
            accept: 'application/json',
          },
          signal: AbortSignal.timeout(12_000),
        });
        if (resp.ok) {
          const items = (await resp.json()) as SpigetSearchItem[];
          if (Array.isArray(items) && items.length > 0) {
            candidates = items;
            break;
          }
        }
      } catch {
        // Tiếp tục thử query kế tiếp
      }
    }

    const targetNormalized = normalizeName(plugin.displayName);
    const targetDescriptorNorm = normalizeName(plugin.descriptorName);

    // Lọc bỏ các ID đã được gắn cho plugin khác
    const validCandidates = candidates.filter((c) => !takenIds.has(c.id));

    let bestMatch: SpigetSearchItem | null = null;

    // 1. Khớp chính xác tên chuẩn hóa (Exact normalized match)
    for (const item of validCandidates) {
      const itemNorm = normalizeName(item.name);
      if (itemNorm === targetNormalized || itemNorm === targetDescriptorNorm) {
        bestMatch = item;
        break;
      }
    }

    // 2. Khớp theo prefix hoặc tên rút gọn nếu không có exact match
    if (!bestMatch) {
      for (const item of validCandidates) {
        const itemNorm = normalizeName(item.name);
        const cleanItemName = normalizeName(displayFrom(item.name));
        if (
          cleanItemName === targetNormalized ||
          itemNorm.startsWith(targetNormalized) ||
          targetNormalized.startsWith(itemNorm)
        ) {
          bestMatch = item;
          break;
        }
      }
    }

    if (bestMatch) {
      const externalLink = plugin.externalLink && plugin.externalLink.trim() !== ''
        ? plugin.externalLink
        : `https://www.spigotmc.org/resources/${bestMatch.id}/`;

      updatePlugin(db, plugin.id, {
        resourceId: bestMatch.id,
        externalLink,
      });

      takenIds.add(bestMatch.id);
      result.resolved.push({
        pluginId: plugin.id,
        displayName: plugin.displayName,
        resourceId: bestMatch.id,
        spigotName: bestMatch.name,
      });

      log(
        `✅ [Auto-ID] Đã gắn mã Spigot ID: ${bestMatch.id} cho "${plugin.displayName}" (Khớp với: ${bestMatch.name.slice(0, 45)}...)`,
        'success',
      );
    } else {
      result.unresolved.push({
        pluginId: plugin.id,
        displayName: plugin.displayName,
      });
    }
  }

  log(
    `✨ Hoàn tất tự động gắn mã: Đã gắn thành công ${result.resolved.length}/${unassigned.length} plugin.`,
    result.resolved.length > 0 ? 'success' : 'info',
  );

  return result;
}
