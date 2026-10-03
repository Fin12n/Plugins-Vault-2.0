import {
  ActionRowBuilder,
  AutocompleteInteraction,
  ChannelType,
  ChatInputCommandInteraction,
  ModalBuilder,
  ModalSubmitInteraction,
  SlashCommandBuilder,
  StringSelectMenuBuilder,
  StringSelectMenuInteraction,
  TextInputBuilder,
  TextInputStyle,
  TextDisplayBuilder,
  ContainerBuilder,
} from 'discord.js';
import type { BotDeps } from '../components/handle-component-interaction.js';
import { requireAdminRole } from '../guards/require-admin-role.js';
import { getNeonDb } from '../../db/neon.js';
import {
  findPluginByAny,
  listPlugins,
  listPluginsWithVersionStats,
} from '../../repositories/neon-plugins.js';
import {
  createErrorContainer,
  createNoticeContainer,
  createStorePanelPayload,
  createSuccessContainer,
  V2_COLOUR,
  v2Payload,
} from '../components/build-v2-containers.js';
import { handlePluginDetail } from './plugin-info-commands.js';
import { handleShelfCommand } from './shelf-commands.js';
import { botVi, formatVnd } from '../i18n/bot-vi.js';
import { getChannelId } from '../../services/channel-manager.js';

// ============================================================================
// 1. SLASH COMMAND DEFINITIONS (5 LỆNH CHUẨN)
// ============================================================================

/**
 * /menu - Mở menu kệ hàng plugins hiện có (Ephemeral)
 */
export const menuCommand = new SlashCommandBuilder()
  .setName('menu')
  .setDescription('Mở kệ hàng hiển thị toàn bộ plugin trong kho (Giao diện Canvas & Components V2)')
  .addIntegerOption((opt) =>
    opt.setName('trang').setDescription('Số thứ tự trang cần xem').setMinValue(1).setRequired(false),
  );

/**
 * /panel-sent [channel] - Gửi UI Panel chọn plugin vào kênh được chỉ định
 */
export const panelSentCommand = new SlashCommandBuilder()
  .setName('panel-sent')
  .setDescription('Gửi UI Panel mua plugin đến 1 kênh được chỉ định (bỏ trống = kênh hiện tại)')
  .addChannelOption((opt) =>
    opt
      .setName('channel')
      .setDescription('Kênh nhận panel (mặc định là kênh hiện tại)')
      .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement)
      .setRequired(false),
  );

/**
 * /info [plugin] - Xem thông tin chi tiết của 1 plugin
 */
export const infoCommand = new SlashCommandBuilder()
  .setName('info')
  .setDescription('Xem thông tin chi tiết, banner và các phiên bản của một plugin!')
  .addStringOption((opt) =>
    opt
      .setName('plugin')
      .setDescription('ID, slug, plugin_id hoặc tên plugin cần tra cứu')
      .setRequired(true)
      .setAutocomplete(true),
  );

/**
 * /find - Dialog nhập tên plugins cần tìm
 */
export const findCommand = new SlashCommandBuilder()
  .setName('find')
  .setDescription('Mở hộp thoại tìm kiếm plugin theo tên hoặc từ khóa!');

/**
 * /report - Báo cáo lỗi về cho Ban Quản Trị
 */
export const reportCommand = new SlashCommandBuilder()
  .setName('report')
  .setDescription('Mở hộp thoại gửi báo cáo sự cố hoặc lỗi plugin về cho Ban Quản Trị!');

// ============================================================================
// 2. COMMAND HANDLERS
// ============================================================================

/**
 * Xử lý lệnh /menu
 */
export async function handleMenuCommand(
  interaction: ChatInputCommandInteraction,
  deps: BotDeps,
): Promise<void> {
  await handleShelfCommand(interaction, deps);
}

/**
 * Xử lý lệnh /panel-sent [channel]
 */
export async function handlePanelSentCommand(
  interaction: ChatInputCommandInteraction,
  deps: BotDeps,
): Promise<void> {
  if (!(await requireAdminRole(interaction, deps))) return;

  await interaction.deferReply({ ephemeral: true });

  const targetChannel =
    interaction.options.getChannel('channel') ?? interaction.channel;

  if (!targetChannel || !('isSendable' in targetChannel) || !targetChannel.isSendable()) {
    const errContainer = createErrorContainer(
      'Kênh không hợp lệ',
      'Kênh được chọn không thể nhận tin nhắn hoặc bot không có quyền gửi tin nhắn vào đó.',
    );
    await interaction.editReply(v2Payload(errContainer, [], { ephemeral: true }));
    return;
  }

  try {
    const neonDb = getNeonDb();
    const items = await listPluginsWithVersionStats(neonDb, 25);
    const panelMsg = createStorePanelPayload(items);

    await targetChannel.send(panelMsg);

    const okContainer = createSuccessContainer(
      'Đã gửi Panel thành công',
      `Bảng điều khiển chọn plugin EZStore đã được đăng vào kênh <#${targetChannel.id}>.`,
    );
    await interaction.editReply(v2Payload(okContainer, [], { ephemeral: true }));
  } catch (err) {
    console.error('Lỗi khi gửi Panel:', err);
    const errContainer = createErrorContainer(
      'Gửi Panel thất bại',
      `Đã xảy ra lỗi: ${err instanceof Error ? err.message : String(err)}`,
    );
    await interaction.editReply(v2Payload(errContainer, [], { ephemeral: true }));
  }
}

/**
 * Xử lý gợi ý Autocomplete cho /info
 */
export async function handleInfoAutocomplete(
  interaction: AutocompleteInteraction,
  _deps: BotDeps,
): Promise<void> {
  try {
    const focused = interaction.options.getFocused().trim();
    const neonDb = getNeonDb();
    const matches = await listPlugins(neonDb, 25, 0, focused.length > 0 ? focused : undefined);

    await interaction.respond(
      matches.map((p) => {
        const priceTag =
          p.depositPrice > 0
            ? ` [${p.depositPrice.toLocaleString('vi-VN')} ₫]`
            : ' [Free]';
        const name = `${p.displayName}${priceTag}`.slice(0, 100);
        return {
          name,
          value: String(p.id),
        };
      }),
    );
  } catch (err) {
    console.error('Lỗi autocomplete /info:', err);
    await interaction.respond([]).catch(() => undefined);
  }
}

/**
 * Xử lý lệnh /info [plugin]
 */
export async function handleInfoCommand(
  interaction: ChatInputCommandInteraction,
  deps: BotDeps,
): Promise<void> {
  const query = interaction.options.getString('plugin', true).trim();
  const neonDb = getNeonDb();
  const plugin = await findPluginByAny(neonDb, query);

  if (!plugin) {
    const errorContainer = createErrorContainer(
      'Không tìm thấy plugin',
      `Không tìm thấy plugin nào khớp với định danh "${query}". Hãy sử dụng /find để tìm kiếm.`,
    );
    await interaction.reply(v2Payload(errorContainer, [], { ephemeral: true }));
    return;
  }

  await handlePluginDetail(interaction, deps, plugin.id);
}

/**
 * Xử lý lệnh /find -> Hiển thị Modal Dialog
 */
export async function handleFindCommand(
  interaction: ChatInputCommandInteraction,
  _deps: BotDeps,
): Promise<void> {
  const modal = new ModalBuilder()
    .setCustomId('modal:find_plugin')
    .setTitle('🔍 Tìm Kiếm Plugins - EZStore');

  const input = new TextInputBuilder()
    .setCustomId('find_query')
    .setLabel('Tên, alias hoặc từ khóa plugin')
    .setPlaceholder('Ví dụ: ItemsAdder, Chunky, WorldEdit...')
    .setStyle(TextInputStyle.Short)
    .setRequired(true)
    .setMaxLength(100);

  modal.addComponents(new ActionRowBuilder<TextInputBuilder>().addComponents(input));
  await interaction.showModal(modal);
}

/**
 * Xử lý lệnh /report -> Hiển thị Modal Dialog
 */
export async function handleReportCommand(
  interaction: ChatInputCommandInteraction,
  _deps: BotDeps,
): Promise<void> {
  const modal = new ModalBuilder()
    .setCustomId('modal:report_issue')
    .setTitle('🚨 Báo Cáo Sự Cố & Hỗ Trợ');

  const titleInput = new TextInputBuilder()
    .setCustomId('report_title')
    .setLabel('Tiêu đề sự cố / Plugin gặp lỗi')
    .setPlaceholder('Ví dụ: Không tải được ItemsAdder v3.6.1...')
    .setStyle(TextInputStyle.Short)
    .setRequired(true)
    .setMaxLength(120);

  const detailInput = new TextInputBuilder()
    .setCustomId('report_details')
    .setLabel('Mô tả chi tiết lỗi gặp phải')
    .setPlaceholder('Vui lòng nêu rõ lỗi, các bước tái hiện hoặc dán link ảnh...')
    .setStyle(TextInputStyle.Paragraph)
    .setRequired(true)
    .setMaxLength(1000);

  modal.addComponents(
    new ActionRowBuilder<TextInputBuilder>().addComponents(titleInput),
    new ActionRowBuilder<TextInputBuilder>().addComponents(detailInput),
  );

  await interaction.showModal(modal);
}

// ============================================================================
// 3. MODAL & SELECT MENU INTERACTION HANDLERS
// ============================================================================

/**
 * Xử lý khi người dùng submit Modal tìm kiếm /find
 */
export async function handleFindModalSubmit(
  interaction: ModalSubmitInteraction,
  deps: BotDeps,
): Promise<void> {
  await interaction.deferReply({ ephemeral: true });

  const query = interaction.fields.getTextInputValue('find_query').trim();
  const neonDb = getNeonDb();
  const matches = await listPlugins(neonDb, 25, 0, query);

  if (matches.length === 0) {
    const notFoundContainer = createNoticeContainer(
      botVi.notFound(query),
      'Hãy thử tìm bằng từ khóa ngắn hơn, hoặc sử dụng lệnh /menu để xem danh mục.',
    );
    await interaction.editReply(v2Payload(notFoundContainer, [], { ephemeral: true }));
    return;
  }

  if (matches.length === 1 && matches[0]) {
    await handlePluginDetail(interaction, deps, matches[0].id);
    return;
  }

  // Nếu tìm thấy nhiều plugin, tạo Select Menu để user chọn plugin cụ thể
  const options = matches.map((p) => ({
    label: p.displayName.slice(0, 100),
    description:
      p.depositPrice > 0
        ? `Giá cọc: ${formatVnd(p.depositPrice)}`
        : 'Miễn phí tải về',
    value: String(p.id),
    emoji: { name: '📦' },
  }));

  const container = new ContainerBuilder()
    .setAccentColor(V2_COLOUR.brand)
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        `## 🔍 Kết quả tìm kiếm cho: \`${query}\`\n` +
          `Tìm thấy **${matches.length}** plugin phù hợp. Hãy chọn plugin bên dưới để xem chi tiết:`,
      ),
    );

  const selectRow = new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId('panel:select_plugin')
      .setPlaceholder('🔻 Chọn plugin để xem chi tiết...')
      .addOptions(options),
  );

  await interaction.editReply(v2Payload(container, [selectRow], { ephemeral: true }));
}

/**
 * Xử lý khi người dùng submit Modal báo cáo /report
 */
export async function handleReportModalSubmit(
  interaction: ModalSubmitInteraction,
  deps: BotDeps,
): Promise<void> {
  const title = interaction.fields.getTextInputValue('report_title').trim();
  const details = interaction.fields.getTextInputValue('report_details').trim();

  // Gửi thông báo đến Admin Notify Channel (Lấy động từ Database kèm fallback .env)
  const notifyChannelId = await getChannelId('notify', deps.env.DISCORD_NOTIFY_CHANNEL_ID);
  if (notifyChannelId && interaction.client) {
    try {
      const channel = await interaction.client.channels.fetch(notifyChannelId);
      if (channel && 'isSendable' in channel && channel.isSendable()) {
        const reportContainer = new ContainerBuilder()
          .setAccentColor(V2_COLOUR.danger)
          .addTextDisplayComponents(
            new TextDisplayBuilder().setContent(
              `# 🚨 BÁO CÁO SỰ CỐ MỚI\n` +
                `• **Người báo cáo:** <@${interaction.user.id}> (\`${interaction.user.tag}\`)\n` +
                `• **Kênh:** <#${interaction.channelId}>\n` +
                `• **Thời gian:** <t:${Math.floor(Date.now() / 1000)}:F>\n\n` +
                `### 📌 ${title}\n` +
                `>>> ${details}`,
            ),
          );
        await channel.send(v2Payload(reportContainer));
      }
    } catch (err) {
      console.warn('Không gửi được báo cáo tới kênh Admin:', err);
    }
  }

  const thanksContainer = createSuccessContainer(
    'Đã gửi báo cáo sự cố',
    'Cảm ơn bạn đã phản hồi! Ban Quản Trị đã nhận được thông tin và sẽ tiến hành kiểm tra xử lý sớm nhất.',
  );
  await interaction.reply(v2Payload(thanksContainer, [], { ephemeral: true }));
}

/**
 * Xử lý khi chọn plugin từ Panel Select Menu ('panel:select_plugin')
 */
export async function handlePanelSelectPlugin(
  interaction: StringSelectMenuInteraction,
  deps: BotDeps,
): Promise<void> {
  const selectedValue = interaction.values[0];
  if (!selectedValue || selectedValue === 'none') {
    return;
  }

  const neonDb = getNeonDb();
  const plugin = await findPluginByAny(neonDb, selectedValue);

  if (!plugin) {
    const errorContainer = createErrorContainer(
      'Không tìm thấy plugin',
      'Plugin này có thể vừa bị xóa hoặc không còn tồn tại trong kho.',
    );
    await interaction.reply(v2Payload(errorContainer, [], { ephemeral: true }));
    return;
  }

  await handlePluginDetail(interaction, deps, plugin.id);
}
