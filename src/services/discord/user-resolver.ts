import type { Client } from 'discord.js';

export type DiscordUserProfile = {
  id: string;
  username: string;
  displayName: string;
  avatarUrl: string | null;
};

type CacheEntry = {
  profile: DiscordUserProfile;
  expiresAt: number;
};

const userCache = new Map<string, CacheEntry>();
const CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour

/**
 * Resolves a Discord user's actual profile (Avatar, Display Name, Username)
 * via the running Discord bot client, caching results to avoid rate-limiting.
 */
export async function resolveDiscordUserProfile(
  client: Client | undefined,
  userId: string,
): Promise<DiscordUserProfile> {
  const cached = userCache.get(userId);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.profile;
  }

  // Fallback defaults
  const fallback: DiscordUserProfile = {
    id: userId,
    username: userId,
    displayName: userId,
    avatarUrl: null,
  };

  if (!client || !client.isReady()) {
    return fallback;
  }

  try {
    const user = await client.users.fetch(userId);
    const profile: DiscordUserProfile = {
      id: user.id,
      username: user.username,
      displayName: user.globalName ?? user.displayName ?? user.username,
      avatarUrl: user.displayAvatarURL({ size: 128, extension: 'png' }),
    };

    userCache.set(userId, {
      profile,
      expiresAt: Date.now() + CACHE_TTL_MS,
    });

    return profile;
  } catch {
    // If user fetch fails (e.g. invalid snowflake or user left discord), cache fallback for 10 minutes
    userCache.set(userId, {
      profile: fallback,
      expiresAt: Date.now() + 10 * 60 * 1000,
    });
    return fallback;
  }
}

/**
 * Batch resolves multiple Discord user profiles in parallel.
 */
export async function batchResolveDiscordUsers(
  client: Client | undefined,
  userIds: string[],
): Promise<Map<string, DiscordUserProfile>> {
  const result = new Map<string, DiscordUserProfile>();
  const uniqueIds = Array.from(new Set(userIds));

  await Promise.all(
    uniqueIds.map(async (id) => {
      const profile = await resolveDiscordUserProfile(client, id);
      result.set(id, profile);
    }),
  );

  return result;
}
