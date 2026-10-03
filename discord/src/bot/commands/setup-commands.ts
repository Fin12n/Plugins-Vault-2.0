import {
  ChannelType,
  ChatInputCommandInteraction,
  SlashCommandBuilder,
} from 'discord.js';
import type { BotDeps } from '../components/handle-component-interaction.js';
import { requireAdminRole } from '../guards/require-admin-role.js';
import { getNeonDb } from '../../db/neon.js';
import { updateChannelPurpose } from '../../services/channel-manager.js';
import { listDiscordChannels } from '../../repositories/neon-channels.js';
import {
  findStaffByDiscordId,
  createStaff,
  updateStaff,
  listStaffs,
} from '../../repositories/neon-staffs.js';
import { createAuditLog } from '../../repositories/neon-audit-logs.js';
import {
  createSuccessContainer,
  createErrorContainer,
  createNoticeContainer,
  v2Payload,
  V2_COLOUR,
} from '../components/build-v2-containers.js';
import { ContainerBuilder, TextDisplayBuilder } from 'discord.js';

export const setupCommand = new SlashCommandBuilder()
  .setName('setup')
  .setDescription('Quản trị hệ thống EZStore (Cài đặt kênh thông báo, nhân sự & phân quyền)')
  .addSubcommandGroup((group) =>
    group
      .setName('channel')
      .setDescription('Quản lý các kênh Discord chức năng của hệ thống')
      .addSubcommand((sub) =>
        sub
          .setName('set')
          .setDescription('Chỉ định kênh chức năng (nhận thông báo, đơn hàng, audit, v.v.)')
          .addStringOption((opt) =>
            opt
              .setName('purpose')
              .setDescription('Mục đích của kênh')
              .setRequired(true)
              .addChoices(
                { name: '🚨 Kênh thông báo lỗi & sự cố (notify)', value: 'notify' },
                { name: '🛒 Kênh thông báo đơn hàng mới (orders)', value: 'orders' },
                { name: '📜 Kênh log kiểm toán quản trị (audit)', value: 'audit' },
                { name: '📦 Kênh đặt Bảng điều khiển mua hàng (panel)', value: 'panel' },
              ),
          )
          .addChannelOption((opt) =>
            opt
              .setName('channel')
              .setDescription('Kênh Discord cần chỉ định')
              .setRequired(true)
              .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement),
          ),
      )
      .addSubcommand((sub) =>
        sub.setName('list').setDescription('Xem danh sách các kênh chức năng đang cấu hình'),
      ),
  )
  .addSubcommandGroup((group) =>
    group
      .setName('staff')
      .setDescription('Quản lý phân quyền nhân sự (Staffs)')
      .addSubcommand((sub) =>
        sub
          .setName('add')
          .setDescription('Thêm hoặc cập nhật quyền nhân sự')
          .addUserOption((opt) =>
            opt.setName('user').setDescription('Thành viên cần cấp quyền').setRequired(true),
          )
          .addStringOption((opt) =>
            opt
              .setName('role')
              .setDescription('Vai trò nhân sự')
              .setRequired(true)
              .addChoices(
                { name: '👑 Quản trị viên cấp cao (admin)', value: 'admin' },
                { name: '🛡️ Điều hành viên / Duyệt plugin (moderator)', value: 'moderator' },
                { name: '💬 Hỗ trợ viên khách hàng (support)', value: 'support' },
              ),
          )
          .addStringOption((opt) =>
            opt.setName('email').setDescription('Email để sau này liên kết với Dashboard').setRequired(false),
          ),
      )
      .addSubcommand((sub) =>
        sub
          .setName('remove')
          .setDescription('Tước quyền nhân sự của một thành viên')
          .addUserOption((opt) =>
            opt.setName('user').setDescription('Thành viên cần gỡ quyền').setRequired(true),
          ),
      )
      .addSubcommand((sub) =>
        sub.setName('list').setDescription('Xem danh sách toàn bộ nhân sự đang hoạt động'),
      ),
  );

/**
 * Xử lý lệnh /setup
 */
export async function handleSetupCommand(
  interaction: ChatInputCommandInteraction,
  deps: BotDeps,
): Promise<void> {
  if (!(await requireAdminRole(interaction, deps))) return;

  await interaction.deferReply({ ephemeral: true });

  const group = interaction.options.getSubcommandGroup();
  const sub = interaction.options.getSubcommand();
  const db = getNeonDb();

  try {
    // ------------------------------------------------------------------------
    // NHÓM 1: CẤU HÌNH KÊNH DISCORD (/setup channel ...)
    // ------------------------------------------------------------------------
    if (group === 'channel') {
      if (sub === 'set') {
        const purpose = interaction.options.getString('purpose', true);
        const channel = interaction.options.getChannel('channel', true);

        await updateChannelPurpose({
          purpose,
          channelId: channel.id,
          channelName: 'name' in channel && channel.name ? String(channel.name) : undefined,
          guildId: interaction.guildId ?? undefined,
          updatedBy: `${interaction.user.tag} (${interaction.user.id})`,
        });

        // Ghi Audit Log
        await createAuditLog(db, {
          discordUserId: interaction.user.id,
          action: 'channel.set',
          targetType: 'channel',
          targetId: purpose,
          details: { channelId: channel.id, channelName: 'name' in channel ? channel.name : '' },
        }).catch(() => null);

        const okContainer = createSuccessContainer(
          'Đã Cập Nhật Kênh Thành Công',
          `Kênh **${purpose.toUpperCase()}** của hệ thống đã được gán vào: <#${channel.id}>\n` +
            `*Tất cả thông báo liên quan từ nay sẽ được tự động gửi vào kênh này.*`,
        );
        await interaction.editReply(v2Payload(okContainer, [], { ephemeral: true }));
        return;
      }

      if (sub === 'list') {
        const channels = await listDiscordChannels(db);
        const lines = channels.map(
          (c) => `• **${c.purpose.toUpperCase()}**: <#${c.channelId}> \`[ID: ${c.channelId}]\` ${c.isEnabled ? '🟢 Hoạt động' : '🔴 Tắt'}`,
        );

        const container = new ContainerBuilder()
          .setAccentColor(V2_COLOUR.brand)
          .addTextDisplayComponents(
            new TextDisplayBuilder().setContent(
              `# 📡 Cấu Hình Kênh Hệ Thống EZStore\n\n` +
                (lines.length > 0 ? lines.join('\n') : '*Chưa có kênh nào được cấu hình trong Database.*'),
            ),
          );

        await interaction.editReply(v2Payload(container, [], { ephemeral: true }));
        return;
      }
    }

    // ------------------------------------------------------------------------
    // NHÓM 2: QUẢN LÝ NHÂN SỰ (/setup staff ...)
    // ------------------------------------------------------------------------
    if (group === 'staff') {
      if (sub === 'add') {
        const user = interaction.options.getUser('user', true);
        const role = interaction.options.getString('role', true);
        const email = interaction.options.getString('email') ?? undefined;

        const existing = await findStaffByDiscordId(db, user.id);
        if (existing) {
          await updateStaff(db, existing.id, {
            role,
            email: email ?? existing.email,
            isActive: true,
            username: user.username,
            displayName: user.displayName,
          });
        } else {
          await createStaff(db, {
            discordUserId: user.id,
            username: user.username,
            displayName: user.displayName,
            role,
            email,
            isActive: true,
            addedBy: interaction.user.id,
            permissions: role === 'admin' ? ['*'] : [role],
          });
        }

        // Ghi Audit Log
        await createAuditLog(db, {
          discordUserId: interaction.user.id,
          action: 'staff.add',
          targetType: 'staff',
          targetId: user.id,
          details: { role, email },
        }).catch(() => null);

        const okContainer = createSuccessContainer(
          'Đã Cập Nhật Nhân Sự',
          `Đã cấp quyền cho thành viên <@${user.id}> thành công!\n` +
            `• **Vai trò:** \`${role.toUpperCase()}\`\n` +
            (email ? `• **Email liên kết:** \`${email}\`\n` : '') +
            `• **Trạng thái:** 🟢 Đang hoạt động`,
        );
        await interaction.editReply(v2Payload(okContainer, [], { ephemeral: true }));
        return;
      }

      if (sub === 'remove') {
        const user = interaction.options.getUser('user', true);
        const existing = await findStaffByDiscordId(db, user.id);

        if (!existing) {
          const notice = createNoticeContainer(
            'Không tìm thấy nhân sự',
            `Thành viên <@${user.id}> hiện không có trong danh sách nhân sự quản trị.`,
          );
          await interaction.editReply(v2Payload(notice, [], { ephemeral: true }));
          return;
        }

        // Vô hiệu hóa tài khoản
        await updateStaff(db, existing.id, { isActive: false });

        // Ghi Audit Log
        await createAuditLog(db, {
          discordUserId: interaction.user.id,
          action: 'staff.remove',
          targetType: 'staff',
          targetId: user.id,
          details: { previousRole: existing.role },
        }).catch(() => null);

        const okContainer = createSuccessContainer(
          'Đã Thu Hồi Quyền Nhân Sự',
          `Đã khóa quyền quản trị của <@${user.id}> thành công. Thành viên này sẽ không thể sử dụng các lệnh Admin nữa.`,
        );
        await interaction.editReply(v2Payload(okContainer, [], { ephemeral: true }));
        return;
      }

      if (sub === 'list') {
        const staffList = await listStaffs(db);
        const lines = staffList
          .filter((s) => s.isActive)
          .map(
            (s) =>
              `• <@${s.discordUserId}> (\`${s.username}\`) — Vai trò: **${s.role.toUpperCase()}**${s.email ? ` | Email: \`${s.email}\`` : ''}`,
          );

        const container = new ContainerBuilder()
          .setAccentColor(V2_COLOUR.brand)
          .addTextDisplayComponents(
            new TextDisplayBuilder().setContent(
              `# 👥 Danh Sách Nhân Sự Quản Trị EZStore\n\n` +
                (lines.length > 0 ? lines.join('\n') : '*Chưa có nhân sự nào trong hệ thống.*'),
            ),
          );

        await interaction.editReply(v2Payload(container, [], { ephemeral: true }));
        return;
      }
    }

    const err = createErrorContainer('Lệnh không hợp lệ', 'Không xác định được thao tác yêu cầu.');
    await interaction.editReply(v2Payload(err, [], { ephemeral: true }));
  } catch (err) {
    console.error('Lỗi thực thi /setup:', err);
    const errContainer = createErrorContainer(
      'Thao tác thất bại',
      `Đã xảy ra lỗi: ${err instanceof Error ? err.message : String(err)}`,
    );
    await interaction.editReply(v2Payload(errContainer, [], { ephemeral: true }));
  }
}
