import { type ChatInputCommandInteraction, type Interaction } from 'discord.js';
import type { Env } from '../../config/env.js';
import type { Db } from '../../db/connection.js';
import { getSettings } from '../../db/settings-store.js';
import { botVi } from '../i18n/bot-vi.js';
import { createErrorContainer, v2Payload } from '../components/build-v2-containers.js';

/**
 * Gates a command on the configured admin role.
 *
 * inCachedGuild() is the correct guard, not inGuild(): interaction.member is
 * `GuildMember | APIInteractionGuildMember | null`, and on the raw branch `.roles`
 * is a plain string[] with no `.cache`. inGuild() narrows only guildId, so
 * `member.roles.cache.has()` would not compile — and casting to GuildMember
 * compiles but throws at runtime when raw data arrives.
 *
 * Roles come from the settings table, not env: the owner can add a role from the
 * dashboard, and a bot reading env would refuse that admin forever.
 */
export async function requireAdminRole(
  interaction: ChatInputCommandInteraction,
  deps: { db: Db; env: Env },
): Promise<boolean> {
  if (!interaction.inCachedGuild()) {
    const errorContainer = createErrorContainer(botVi.guildOnly, botVi.guildOnlyHint);
    const payload = v2Payload(errorContainer, [], { ephemeral: true });
    if (interaction.deferred || interaction.replied) {
      await interaction.editReply(payload).catch(() => undefined);
    } else {
      await interaction.reply(payload).catch(() => undefined);
    }
    return false;
  }

  // 1. Chủ sở hữu (Owner) luôn có toàn quyền
  if (deps.env.DISCORD_OWNER_ID && interaction.user.id === deps.env.DISCORD_OWNER_ID) {
    return true;
  }

  // 2. Kiểm tra role admin trên server Discord
  const allowed = getSettings(deps.db, deps.env).adminRoleIds;
  if (allowed.some((roleId) => interaction.member.roles.cache.has(roleId))) {
    return true;
  }

  // 3. Kiểm tra quyền qua bảng staffs trong Neon PostgreSQL
  try {
    const { getNeonDb } = await import('../../db/neon.js');
    const { isDiscordStaffAdmin } = await import('../../repositories/neon-staffs.js');
    const isStaff = await isDiscordStaffAdmin(getNeonDb(), interaction.user.id);
    if (isStaff) {
      return true;
    }
  } catch {
    // Neon query fallback
  }

  // Logged so the owner can tell a misconfigured role from an actual intrusion.
  console.warn(`Từ chối: ${interaction.user.id} không có quyền admin hoặc staff`);
  const errorContainer = createErrorContainer(botVi.noAccess, botVi.noAccessHint);
  const payload = v2Payload(errorContainer, [], { ephemeral: true });
  if (interaction.deferred || interaction.replied) {
    await interaction.editReply(payload).catch(() => undefined);
  } else {
    await interaction.reply(payload).catch(() => undefined);
  }
  return false;
}

/**
 * Role check for a component interaction, where a reply may already exist.
 * Returns the verdict rather than replying, since the caller chooses between
 * reply and update.
 */
export function hasAdminRole(interaction: Interaction, deps: { db: Db; env: Env }): boolean {
  if (!interaction.inCachedGuild()) return false;
  const allowed = getSettings(deps.db, deps.env).adminRoleIds;
  return allowed.some((roleId) => interaction.member.roles.cache.has(roleId));
}
