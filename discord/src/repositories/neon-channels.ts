import { eq } from 'drizzle-orm';
import { discordChannels, type DiscordChannel, type NewDiscordChannel } from '@vault/db';
import type { Database } from '../db/neon.js';

/**
 * Lấy thông tin kênh Discord theo mục đích (purpose)
 */
export async function getDiscordChannel(
  db: Database,
  purpose: string,
): Promise<DiscordChannel | null> {
  const rows = await db
    .select()
    .from(discordChannels)
    .where(eq(discordChannels.purpose, purpose))
    .limit(1);

  return rows[0] ?? null;
}

/**
 * Cập nhật hoặc thêm mới cấu hình kênh Discord theo purpose
 */
export async function setDiscordChannel(
  db: Database,
  data: {
    purpose: string;
    channelId: string;
    channelName?: string;
    guildId?: string;
    isEnabled?: boolean;
    updatedBy?: string;
  },
): Promise<DiscordChannel> {
  const rows = await db
    .insert(discordChannels)
    .values({
      purpose: data.purpose,
      channelId: data.channelId,
      channelName: data.channelName,
      guildId: data.guildId,
      isEnabled: data.isEnabled ?? true,
      updatedBy: data.updatedBy,
      updatedAt: new Date(),
    })
    .onConflictDoUpdate({
      target: discordChannels.purpose,
      set: {
        channelId: data.channelId,
        channelName: data.channelName,
        guildId: data.guildId,
        isEnabled: data.isEnabled ?? true,
        updatedBy: data.updatedBy,
        updatedAt: new Date(),
      },
    })
    .returning();

  return rows[0]!;
}

/**
 * Lấy danh sách tất cả các kênh Discord đã được cấu hình
 */
export async function listDiscordChannels(db: Database): Promise<DiscordChannel[]> {
  return db.select().from(discordChannels).orderBy(discordChannels.purpose);
}

/**
 * Xóa cấu hình kênh theo purpose
 */
export async function deleteDiscordChannel(db: Database, purpose: string): Promise<boolean> {
  const result = await db.delete(discordChannels).where(eq(discordChannels.purpose, purpose));
  return true;
}
