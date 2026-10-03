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
import { listSpigotAccounts } from '../../repositories/spigot-accounts.js';
import { listAccountOwnedPlugins } from '../../repositories/resource-ownership.js';
import { countPlugins } from '../../repositories/plugins.js';
import { requireAdminRole } from '../guards/require-admin-role.js';
import { createErrorContainer, V2_COLOUR, v2Payload } from '../components/build-v2-containers.js';

export const spigotCommand = new SlashCommandBuilder()
  .setName('spigot')
  .setDescription('Quản lý SpigotMC Crawler, phiên Cookie và tải plugin tự động (Components V2)')
  .addSubcommand((sub) =>
    sub
      .setName('scan')
      .setDescription('Kích hoạt tiến trình quét plugin đã mua trên SpigotMC (CloakBrowser & Cookie)')
      .addBooleanOption((opt) =>
        opt
          .setName('force')
          .setDescription('Bắt buộc quét lại ngay cả khi phiên vừa được quét gần đây')
          .setRequired(false),
      ),
  )
  .addSubcommand((sub) =>
    sub
      .setName('download')
      .setDescription('Kích hoạt Worker tự động tải plugin SpigotMC về kho lưu trữ')
      .addIntegerOption((opt) =>
        opt
          .setName('resource_id')
          .setDescription('Mã Spigot Resource ID cụ thể cần ưu tiên tải về kho')
          .setRequired(false),
      ),
  )
  .addSubcommand((sub) =>
    sub
      .setName('status')
      .setDescription('Xem trạng thái các tài khoản SpigotMC, Cookie và phiên làm việc'),
  );

export async function handleSpigotCommand(
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

  if (subcommand === 'scan') {
    const force = interaction.options.getBoolean('force') ?? false;

    if (!deps.maintenance) {
      const err = createErrorContainer('Dịch vụ bảo trì chưa sẵn sàng', 'Hệ thống bảo trì đang khởi động, vui lòng thử lại sau.');
      await interaction.editReply(v2Payload(err, [], { ephemeral: true })).catch(() => undefined);
      return;
    }

    const currentStatus = deps.maintenance.getUpdateStatus();
    if (currentStatus.running) {
      const op = deps.maintenance.getCurrentOperation ? deps.maintenance.getCurrentOperation() : 'đang chạy';
      const container = new ContainerBuilder()
        .setAccentColor(V2_COLOUR.pending)
        .addTextDisplayComponents(
          new TextDisplayBuilder().setContent(
            `# ⏳ Hệ Thống Đang Bận\n` +
              `Tiến trình bảo trì Spigot đang chạy (${op}).\n` +
              `Vui lòng đợi phiên hiện tại hoàn thành trước khi bắt đầu quét mới.`,
          ),
        );
      await interaction.editReply(v2Payload(container, [], { ephemeral: true })).catch(() => undefined);
      return;
    }

    const triggered = deps.maintenance.triggerScanOnly
      ? deps.maintenance.triggerScanOnly()
      : deps.maintenance.triggerUpdateCheck(force);

    if (triggered) {
      const container = new ContainerBuilder()
        .setAccentColor(V2_COLOUR.success)
        .addTextDisplayComponents(
          new TextDisplayBuilder().setContent(
            `# 🚀 Đã Kích Hoạt Quét Plugin SpigotMC\n` +
              `Đã khởi động tiến trình quét SpigotMC bằng **CloakBrowser Engine**!\n\n` +
              `⚡ **Tự Động Tiêm Cookie**: Nếu tài khoản đã có Cookie phiên \`xf_user\` còn hạn, hệ thống sẽ mở trực tiếp trang đã mua.\n` +
              `🛡️ **Vượt Cloudflare Turnstile**: Khi Cookie hết hạn hoặc đăng nhập lần đầu, bot tự động giải thử thách Turnstile.\n` +
              `🔑 **Lưu Cookie Phiên**: Cookie mới sẽ được tự động mã hóa và lưu vào database \`vault.db\` để tái sử dụng lâu dài.\n` +
              `📦 **Liên Kết Bản Quyền**: Toàn bộ plugin đã mua sẽ được ghi nhận quyền sở hữu và đưa vào danh sách theo dõi cập nhật.\n\n` +
              `*Có thể theo dõi log chi tiết trong Dashboard quản trị.*`,
          ),
        );
      await interaction.editReply(v2Payload(container, [], { ephemeral: true })).catch(() => undefined);
    } else {
      const err = createErrorContainer('Không thể kích hoạt quét', 'Không thể khởi chạy lượt quét. Kiểm tra cấu hình hoặc thử lại sau.');
      await interaction.editReply(v2Payload(err, [], { ephemeral: true })).catch(() => undefined);
    }
    return;
  }

  if (subcommand === 'download') {
    const resourceId = interaction.options.getInteger('resource_id') ?? undefined;

    if (!deps.maintenance) {
      const err = createErrorContainer('Dịch vụ bảo trì chưa sẵn sàng', 'Hệ thống bảo trì đang khởi động, vui lòng thử lại sau.');
      await interaction.editReply(v2Payload(err, [], { ephemeral: true })).catch(() => undefined);
      return;
    }

    const currentOp = deps.maintenance.getCurrentOperation?.() ?? 'idle';
    if (currentOp !== 'idle') {
      const err = createErrorContainer(
        'Tiến trình đang bận',
        currentOp === 'scanning'
          ? 'Tiến trình Quét tài khoản Spigot đang diễn ra. Vui lòng đợi trong giây lát rồi thử lại!'
          : 'Tiến trình Tải plugin đang chạy trong nền. Trình duyệt CloakBrowser đang tiến hành tải về kho lưu trữ.',
      );
      await interaction.editReply(v2Payload(err, [], { ephemeral: true })).catch(() => undefined);
      return;
    }

    const triggered = deps.maintenance.triggerOrderedDownload
      ? deps.maintenance.triggerOrderedDownload({ targetResourceId: resourceId })
      : deps.maintenance.triggerFullBatchDownload
        ? deps.maintenance.triggerFullBatchDownload({ autoResolveIds: true })
        : deps.maintenance.triggerUpdateCheck(true);

    if (triggered) {
      const isHeadless = deps.env?.CLOAKBROWSER_HEADLESS ?? false;
      const browserModeText = isHeadless
        ? 'Chạy ngầm (Headless mode)'
        : 'Cửa sổ hiển thị trực tiếp (GUI mode)';

      const container = new ContainerBuilder()
        .setAccentColor(V2_COLOUR.brand)
        .addTextDisplayComponents(
          new TextDisplayBuilder().setContent(
            `# ⬇️ Đã Kích Hoạt Tiến Trình Tải Plugin\n` +
              (resourceId
                ? `Đã ưu tiên tải **Spigot Resource #${resourceId}** và kích hoạt Worker CloakBrowser tải về kho lưu trữ!\n\n`
                : `Đã kích hoạt Worker CloakBrowser tải toàn bộ các plugin và phiên bản mới nhất về kho lưu trữ!\n\n`) +
              `• **Trình Duyệt**: **${browserModeText}** — Tự động tiêm Cookie phiên sống hoặc đăng nhập an toàn.\n` +
              `• **Bảo Toàn Toàn Vẹn**: Tự động trích xuất file \`.jar\`, đọc \`plugin.yml\` để nhận diện tên & phiên bản, kiểm tra mã SHA-256 trước khi lưu vào kho.\n` +
              `• **Thứ Tự Tải**: Tải tuần tự qua 1 tab duy nhất, chống phát hiện và vượt Cloudflare Turnstile.\n\n` +
              `*Dùng \`/spigot status\` để xem danh sách tài khoản hoặc theo dõi log chi tiết trong Dashboard.*`,
          ),
        );
      await interaction.editReply(v2Payload(container, [], { ephemeral: true })).catch(() => undefined);
    } else {
      const err = createErrorContainer('Không thể kích hoạt tải', 'Tiến trình tải hiện đang bận hoặc chưa sẵn sàng. Thử lại sau ít phút.');
      await interaction.editReply(v2Payload(err, [], { ephemeral: true })).catch(() => undefined);
    }
    return;
  }

  if (subcommand === 'status') {
    const accounts = listSpigotAccounts(deps.db);
    const totalInVault = countPlugins(deps.db);

    if (accounts.length === 0) {
      const container = new ContainerBuilder()
        .setAccentColor(V2_COLOUR.pending)
        .addTextDisplayComponents(
          new TextDisplayBuilder().setContent(
            `# 📊 Trạng Thái SpigotMC & Cookie\n` +
              `Chưa có tài khoản Spigot nào được cấu hình trong hệ thống.\n` +
              `Vui lòng cấu hình tài khoản trong Dashboard hoặc tệp \`spigot_accounts.json\`.`,
          ),
        );
      await interaction.editReply(v2Payload(container, [], { ephemeral: true })).catch(() => undefined);
      return;
    }

    const container = new ContainerBuilder()
      .setAccentColor(V2_COLOUR.success)
      .addTextDisplayComponents(
        new TextDisplayBuilder().setContent(
          `# 📊 Danh Sách Tài Khoản SpigotMC & Cookie\n` +
            `Hiện có **${accounts.length}** tài khoản Spigot và **${totalInVault}** plugin trong kho lưu trữ.\n\n` +
            `Hệ thống tự động sử dụng **CloakBrowser Engine** và tiêm Cookie cho các tác vụ tải & quét.`,
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

      const samplePlugins = owned.slice(0, 3).map((p: any) => p.displayName).join(', ');
      const moreText = owned.length > 3 ? ` và ${owned.length - 3} plugin khác` : '';

      container
        .addSeparatorComponents(
          new SeparatorBuilder().setDivider(true).setSpacing(SeparatorSpacingSize.Small),
        )
        .addTextDisplayComponents(
          new TextDisplayBuilder().setContent(
            `### 👤 ${acc.label} (${acc.username})\n` +
              `• **Trạng thái:** ${acc.isEnabled ? '✅ Bật' : '⏸️ Tắt'}\n` +
              `• **Cookie phiên:** ${cookieBadge}\n` +
              `• **Số plugin sở hữu:** **${owned.length}** plugin${samplePlugins ? ` (${samplePlugins}${moreText})` : ''}\n` +
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
          `*Dùng \`/spigot scan\` để quét mới  •  \`/spigot download\` để tải plugin*`,
        ),
      );

    await interaction.editReply(v2Payload(container, [], { ephemeral: true })).catch(() => undefined);
    return;
  }
}
