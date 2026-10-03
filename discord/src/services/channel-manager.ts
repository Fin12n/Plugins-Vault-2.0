import { getDiscordChannel, setDiscordChannel, listDiscordChannels } from '../repositories/neon-channels.js';
import { getNeonDb } from '../db/neon.js';
import type { Env } from '../config/index.js';

interface CachedChannel {
  channelId: string;
  expiresAt: number;
}

const CACHE_TTL_MS = 60_000; // 60 giây cache trong bộ nhớ
const channelCache = new Map<string, CachedChannel>();

/**
 * Xóa toàn bộ hoặc một key trong cache
 */
export function invalidateChannelCache(purpose?: string): void {
  if (purpose) {
    channelCache.delete(purpose);
  } else {
    channelCache.clear();
  }
}

/**
 * Lấy channelId theo purpose với cache 60s và fallback về biến môi trường
 */
export async function getChannelId(
  purpose: string,
  fallbackEnvId?: string,
): Promise<string | null> {
  const now = Date.now();
  const cached = channelCache.get(purpose);
  if (cached && cached.expiresAt > now) {
    return cached.channelId;
  }

  try {
    const db = getNeonDb();
    const row = await getDiscordChannel(db, purpose);

    if (row && row.isEnabled && row.channelId) {
      channelCache.set(purpose, {
        channelId: row.channelId,
        expiresAt: now + CACHE_TTL_MS,
      });
      return row.channelId;
    }
  } catch (err) {
    console.warn(`[ChannelManager] Không thể đọc kênh "${purpose}" từ DB, chuyển sang fallback:`, err instanceof Error ? err.message : err);
  }

  // Fallback
  if (fallbackEnvId) {
    return fallbackEnvId;
  }

  return null;
}

/**
 * Cập nhật kênh theo purpose và làm mới cache ngay lập tức
 */
export async function updateChannelPurpose(data: {
  purpose: string;
  channelId: string;
  channelName?: string;
  guildId?: string;
  isEnabled?: boolean;
  updatedBy?: string;
}): Promise<void> {
  const db = getNeonDb();
  await setDiscordChannel(db, data);

  // Cập nhật lại cache lập tức
  channelCache.set(data.purpose, {
    channelId: data.channelId,
    expiresAt: Date.now() + CACHE_TTL_MS,
  });
}

/**
 * Tự động đồng bộ các kênh mặc định từ .env vào DB nếu chưa có
 */
export async function autoSeedDefaultChannels(env: Env): Promise<void> {
  try {
    const db = getNeonDb();
    const existing = await listDiscordChannels(db);
    const existingPurposes = new Set(existing.map((c) => c.purpose));

    // 1. Kênh Thông Báo Lỗi / Sự Cố (Notify)
    if (!existingPurposes.has('notify') && env.DISCORD_NOTIFY_CHANNEL_ID) {
      await setDiscordChannel(db, {
        purpose: 'notify',
        channelId: env.DISCORD_NOTIFY_CHANNEL_ID,
        channelName: 'notify-channel',
        guildId: env.DISCORD_GUILD_ID,
        isEnabled: true,
        updatedBy: 'system_auto_seed',
      });
      console.log(`[ChannelManager] ✅ Đã tự động seed kênh "notify" từ .env vào Database: ${env.DISCORD_NOTIFY_CHANNEL_ID}`);
    }
  } catch (err) {
    console.warn('[ChannelManager] Lỗi khi auto-seed kênh mặc định:', err instanceof Error ? err.message : err);
  }
}
