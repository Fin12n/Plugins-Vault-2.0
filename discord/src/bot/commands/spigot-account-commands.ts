import {
  ContainerBuilder,
  MessageFlags,
  SeparatorBuilder,
  SeparatorSpacingSize,
  SlashCommandBuilder,
  TextDisplayBuilder,
  type ChatInputCommandInteraction,
} from 'discord.js';
import type { BotDeps } from '../components/handle-component-interaction.js';
import {
  deleteSpigotAccount,
  findSpigotAccountByLabel,
  listSpigotAccounts,
  setSpigotAccountEnabled,
  upsertSpigotAccount,
} from '../../repositories/spigot-accounts.js';
import { listAccountOwnedPlugins } from '../../repositories/resource-ownership.js';
import { requireAdminRole } from '../guards/require-admin-role.js';
import { createErrorContainer, V2_COLOUR, v2Payload } from '../components/build-v2-containers.js';

export const spigotAccountCommand = new SlashCommandBuilder()
  .setName('spigot-account')
  .setDescription('Quản lý các tài khoản SpigotMC trong hệ thống (Components V2 - Admin)')
  .addSubcommand((sub) =>
    sub.setName('list').setDescription('Xem danh sách tài khoản SpigotMC và tình trạng Cookie'),
  )
  .addSubcommand((sub) =>
    sub
      .setName('add')
      .setDescription('Thêm tài khoản SpigotMC mới vào hệ thống')
      .addStringOption((opt) =>
        opt.setName('label').setDescription('Nhãn tài khoản (vd: acc-1, main, spigot_pro)').setRequired(true),
      )
      .addStringOption((opt) =>
        opt.setName('username').setDescription('Tên đăng nhập hoặc email SpigotMC').setRequired(true),
      )
      .addStringOption((opt) =>
        opt.setName('password').setDescription('Mật khẩu SpigotMC').setRequired(true),
      )
      .addBooleanOption((opt) =>
        opt.setName('enabled').setDescription('Kích hoạt tài khoản ngay sau khi thêm').setRequired(false),
      )
      .addStringOption((opt) =>
        opt.setName('xf_user').setDescription('Cookie xf_user nếu có sẵn').setRequired(false),
      )
      .addStringOption((opt) =>
        opt.setName('xf_session').setDescription('Cookie xf_session nếu có sẵn').setRequired(false),
      ),
  )
  .addSubcommand((sub) =>
    sub
      .setName('edit')
      .setDescription('Chỉnh sửa thông tin hoặc cập nhật Cookie cho tài khoản SpigotMC')
      .addStringOption((opt) =>
        opt.setName('label').setDescription('Nhãn tài khoản cần chỉnh sửa').setRequired(true),
      )
      .addStringOption((opt) =>
        opt.setName('username').setDescription('Cập nhật username/email mới').setRequired(false),
      )
      .addStringOption((opt) =>
        opt.setName('password').setDescription('Cập nhật mật khẩu mới').setRequired(false),
      )
      .addStringOption((opt) =>
        opt.setName('xf_user').setDescription('Cập nhật Cookie xf_user mới').setRequired(false),
      )
      .addStringOption((opt) =>
        opt.setName('xf_session').setDescription('Cập nhật Cookie xf_session mới').setRequired(false),
      ),
  )
  .addSubcommand((sub) =>
    sub
      .setName('toggle')
      .setDescription('Bật hoặc tắt trạng thái sử dụng của một tài khoản SpigotMC')
      .addStringOption((opt) =>
        opt.setName('label').setDescription('Nhãn tài khoản cần bật/tắt').setRequired(true),
      )
      .addBooleanOption((opt) =>
        opt.setName('enabled').setDescription('Trạng thái kích hoạt (True: Bật, False: Tắt)').setRequired(true),
      ),
  )
  .addSubcommand((sub) =>
    sub
      .setName('delete')
      .setDescription('Xóa tài khoản SpigotMC khỏi hệ thống')
      .addStringOption((opt) =>
        opt.setName('label').setDescription('Nhãn tài khoản cần xóa').setRequired(true),
      ),
  );

/**
 * Xử lý lệnh /spigot-account (list | add | edit | toggle | delete)
 */
export async function handleSpigotAccountCommand(
  interaction: ChatInputCommandInteraction,
  deps: BotDeps,
): Promise<void> {
  if (!interaction.deferred && !interaction.replied) {
    await interaction.deferReply({
      flags: MessageFlags.Ephemeral,
    }).catch(() => undefined);
  }

  if (!(await requireAdminRole(interaction, deps))) return;

  const subcommand = interaction.options.getSubcommand();

  // 1. LIST
  if (subcommand === 'list') {
    const accounts = listSpigotAccounts(deps.db);

    if (accounts.length === 0) {
      const container = new ContainerBuilder()
        .setAccentColor(V2_COLOUR.pending)
        .addTextDisplayComponents(
          new TextDisplayBuilder().setContent(
            `# 👤 Danh Sách Tài Khoản SpigotMC\n` +
              `Chưa có tài khoản Spigot nào được cấu hình trong hệ thống.\n` +
              `Dùng lệnh \`/spigot-account add\` để thêm tài khoản mới!`,
          ),
        );
      await interaction.editReply(v2Payload(container, [], { ephemeral: true })).catch(() => undefined);
      return;
    }

    const container = new ContainerBuilder()
      .setAccentColor(V2_COLOUR.brand)
      .addTextDisplayComponents(
        new TextDisplayBuilder().setContent(
          `# 👤 Quản Lý Tài Khoản SpigotMC (${accounts.length})\n` +
            `Các tài khoản dưới đây được dùng để tự động đăng nhập, quét plugin đã mua và tải tệp \`.jar\` về kho.`,
        ),
      );

    for (const acc of accounts) {
      const hasCookie = Boolean(acc.xfUser.reveal());
      const owned = listAccountOwnedPlugins(deps.db, acc.label);
      const cookieBadge = hasCookie
        ? '🟢 **Có Cookie phiên sống**'
        : '⚪ **Chưa có Cookie** (sẽ tự động đăng nhập khi quét)';

      const verifiedText = acc.lastVerifiedAt
        ? new Date(acc.lastVerifiedAt).toLocaleString('vi-VN')
        : 'Chưa xác thực';

      const samplePlugins = owned.slice(0, 3).map((p) => p.displayName).join(', ');
      const moreText = owned.length > 3 ? ` và ${owned.length - 3} plugin khác` : '';

      container
        .addSeparatorComponents(
          new SeparatorBuilder().setDivider(true).setSpacing(SeparatorSpacingSize.Small),
        )
        .addTextDisplayComponents(
          new TextDisplayBuilder().setContent(
            `### ${acc.isEnabled ? '✅' : '⏸️'} [${acc.label}] — ${acc.username}\n` +
              `• **Trạng thái:** ${acc.isEnabled ? '🟢 Đang hoạt động' : '🔴 Đã tắt'}\n` +
              `• **Cookie phiên:** ${cookieBadge}\n` +
              `• **Plugin sở hữu:** **${owned.length}** plugin${samplePlugins ? ` (${samplePlugins}${moreText})` : ''}\n` +
              `• **Lần cập nhật cuối:** ${verifiedText}`,
          ),
        );
    }

    container
      .addSeparatorComponents(
        new SeparatorBuilder().setDivider(true).setSpacing(SeparatorSpacingSize.Small),
      )
      .addTextDisplayComponents(
        new TextDisplayBuilder().setContent(
          `*Dùng \`/spigot scan\` để quét & lấy Cookie tự động  •  \`/spigot-account edit\` để sửa*`,
        ),
      );

    await interaction.editReply(v2Payload(container, [], { ephemeral: true })).catch(() => undefined);
    return;
  }

  // 2. ADD
  if (subcommand === 'add') {
    const label = interaction.options.getString('label', true).trim();
    const username = interaction.options.getString('username', true).trim();
    const password = interaction.options.getString('password', true);
    const enabled = interaction.options.getBoolean('enabled') ?? true;
    const xfUser = interaction.options.getString('xf_user')?.trim();
    const xfSession = interaction.options.getString('xf_session')?.trim();

    const existing = findSpigotAccountByLabel(deps.db, label);
    if (existing) {
      const err = createErrorContainer(
        'Nhãn tài khoản đã tồn tại',
        `Đã có tài khoản mang nhãn \`${label}\`. Vui lòng chọn nhãn khác hoặc dùng \`/spigot-account edit\`.`,
      );
      await interaction.editReply(v2Payload(err, [], { ephemeral: true })).catch(() => undefined);
      return;
    }

    upsertSpigotAccount(deps.db, {
      label,
      username,
      password,
      isEnabled: enabled,
      ...(xfUser ? { xfUser } : {}),
      ...(xfSession ? { xfSession } : {}),
      issuedAt: xfUser ? new Date().toISOString() : null,
      lastVerifiedAt: xfUser ? new Date().toISOString() : null,
    });

    const container = new ContainerBuilder()
      .setAccentColor(V2_COLOUR.success)
      .addTextDisplayComponents(
        new TextDisplayBuilder().setContent(
          `# ✅ Đã Thêm Tài Khoản SpigotMC Mới\n` +
            `Đã thêm tài khoản **${label}** (\`${username}\`) vào hệ thống!\n\n` +
            `• **Mật khẩu**: Đã được mã hóa AES-256 an toàn trong database.\n` +
            `• **Trạng thái**: ${enabled ? '🟢 Bật' : '🔴 Tắt'}\n` +
            `• **Cookie phiên**: ${xfUser ? '🟢 Đã cấu hình thủ công' : '⚪ Chưa có (sẽ tự động đăng nhập khi quét)'}\n\n` +
            `💡 **Gợi ý**: Chạy lệnh \`/spigot scan\` ngay để bot tự động đăng nhập qua CloakBrowser và lưu Cookie phiên sống!`,
        ),
      );

    await interaction.editReply(v2Payload(container, [], { ephemeral: true })).catch(() => undefined);
    return;
  }

  // 3. EDIT
  if (subcommand === 'edit') {
    const label = interaction.options.getString('label', true).trim();
    const username = interaction.options.getString('username')?.trim();
    const password = interaction.options.getString('password');
    const xfUser = interaction.options.getString('xf_user')?.trim();
    const xfSession = interaction.options.getString('xf_session')?.trim();

    const existing = findSpigotAccountByLabel(deps.db, label);
    if (!existing) {
      const err = createErrorContainer('Không tìm thấy tài khoản', `Không tìm thấy tài khoản có nhãn \`${label}\` trong hệ thống.`);
      await interaction.editReply(v2Payload(err, [], { ephemeral: true })).catch(() => undefined);
      return;
    }

    upsertSpigotAccount(deps.db, {
      label,
      username: username ?? existing.username,
      password: password ?? existing.password.reveal(),
      isEnabled: existing.isEnabled,
      ...(xfUser !== undefined ? { xfUser } : {}),
      ...(xfSession !== undefined ? { xfSession } : {}),
      ...(xfUser ? { issuedAt: new Date().toISOString(), lastVerifiedAt: new Date().toISOString() } : {}),
    });

    const container = new ContainerBuilder()
      .setAccentColor(V2_COLOUR.brand)
      .addTextDisplayComponents(
        new TextDisplayBuilder().setContent(
          `# ✏️ Đã Cập Nhật Tài Khoản SpigotMC\n` +
            `Đã cập nhật thông tin cho tài khoản **${label}** thành công!\n\n` +
            `• **Username**: \`${username ?? existing.username}\`\n` +
            `• **Mật khẩu**: ${password ? '🔑 Đã cập nhật mật khẩu mới' : 'Giữ nguyên'}\n` +
            `• **Cookie phiên**: ${xfUser ? '🟢 Đã cập nhật Cookie mới' : 'Giữ nguyên'}`,
        ),
      );

    await interaction.editReply(v2Payload(container, [], { ephemeral: true })).catch(() => undefined);
    return;
  }

  // 4. TOGGLE
  if (subcommand === 'toggle') {
    const label = interaction.options.getString('label', true).trim();
    const enabled = interaction.options.getBoolean('enabled', true);

    const existing = findSpigotAccountByLabel(deps.db, label);
    if (!existing) {
      const err = createErrorContainer('Không tìm thấy tài khoản', `Không tìm thấy tài khoản có nhãn \`${label}\` trong hệ thống.`);
      await interaction.editReply(v2Payload(err, [], { ephemeral: true })).catch(() => undefined);
      return;
    }

    setSpigotAccountEnabled(deps.db, label, enabled);

    const container = new ContainerBuilder()
      .setAccentColor(enabled ? V2_COLOUR.success : V2_COLOUR.danger)
      .addTextDisplayComponents(
        new TextDisplayBuilder().setContent(
          `# ${enabled ? '🟢 Đã Kích Hoạt Tài Khoản' : '⏸️ Đã Tạm Tắt Tài Khoản'}\n` +
            `Tài khoản **${label}** hiện đã được chuyển sang trạng thái: **${enabled ? 'BẬT (Cho phép quét & tải)' : 'TẮT (Bỏ qua khi quét)'}**.`,
        ),
      );

    await interaction.editReply(v2Payload(container, [], { ephemeral: true })).catch(() => undefined);
    return;
  }

  // 5. DELETE
  if (subcommand === 'delete') {
    const label = interaction.options.getString('label', true).trim();

    const existing = findSpigotAccountByLabel(deps.db, label);
    if (!existing) {
      const err = createErrorContainer('Không tìm thấy tài khoản', `Không tìm thấy tài khoản có nhãn \`${label}\` trong hệ thống.`);
      await interaction.editReply(v2Payload(err, [], { ephemeral: true })).catch(() => undefined);
      return;
    }

    deleteSpigotAccount(deps.db, label);

    const container = new ContainerBuilder()
      .setAccentColor(V2_COLOUR.danger)
      .addTextDisplayComponents(
        new TextDisplayBuilder().setContent(
          `# 🗑️ Đã Xóa Tài Khoản SpigotMC\n` +
            `Đã xóa hoàn toàn tài khoản **${label}** khỏi hệ thống database.`,
        ),
      );

    await interaction.editReply(v2Payload(container, [], { ephemeral: true })).catch(() => undefined);
    return;
  }
}
