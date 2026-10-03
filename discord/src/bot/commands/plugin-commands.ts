import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  MessageFlags,
  SlashCommandBuilder,
  type ChatInputCommandInteraction,
} from 'discord.js';
import { countPlugins, listPlugins } from '../../repositories/plugins.js';
import { botVi } from '../i18n/bot-vi.js';
import { buildPagedSelect, toComponents } from '../components/build-paged-select.js';
import {
  createBrowseContainer,
  createErrorContainer,
  createNoticeContainer,
  createPanelContainer,
  v2Payload,
} from '../components/build-v2-containers.js';
import { ID, type BotDeps } from '../components/handle-component-interaction.js';
import { requireAdminRole } from '../guards/require-admin-role.js';
import { handleShelfCommand } from './shelf-commands.js';

export const menuCommand = new SlashCommandBuilder()
  .setName('menu')
  .setDescription('Mở kệ hàng hiển thị toàn bộ plugin trong kho (Giao diện Canvas & Components V2)')
  .addIntegerOption((opt) =>
    opt.setName('trang').setDescription('Số thứ tự trang cần xem').setMinValue(1).setRequired(false),
  );

export const findCommand = new SlashCommandBuilder()
  .setName('find')
  .setDescription('Tìm plugin theo tên (Components V2)')
  .addStringOption((option) =>
    option.setName('ten').setDescription('Tên plugin cần tìm').setRequired(true).setMaxLength(100),
  );

export const panelCommand = new SlashCommandBuilder()
  .setName('panel')
  .setDescription('Đặt bảng chọn plugin cố định vào kênh này (Components V2)');

export async function handlePanelCommand(
  interaction: ChatInputCommandInteraction,
  deps: BotDeps,
): Promise<void> {
  if (!interaction.deferred && !interaction.replied) {
    await interaction.deferReply({
      flags: MessageFlags.Ephemeral,
    }).catch(() => undefined);
  }
  if (!(await requireAdminRole(interaction, deps))) return;

  const open = new ButtonBuilder()
    .setCustomId(ID.openPanel)
    .setLabel(botVi.panelButton)
    .setStyle(ButtonStyle.Primary);

  try {
    if (!interaction.channel?.isSendable()) throw new Error('kênh không nhận được tin nhắn');
    const total = countPlugins(deps.db);
    const panelMsg = v2Payload(createPanelContainer(total), [
      new ActionRowBuilder<ButtonBuilder>().addComponents(open),
    ]);
    await interaction.channel.send(panelMsg);

    const okContainer = createNoticeContainer('Đã đặt panel', botVi.panelPlaced);
    const confPayload = v2Payload(okContainer, [], { ephemeral: true });
    if (interaction.deferred || interaction.replied) {
      await interaction.editReply(confPayload).catch(() => undefined);
    } else {
      await interaction.reply(confPayload).catch(() => undefined);
    }
  } catch (err) {
    console.warn(`Không đặt được panel: ${err instanceof Error ? err.message : String(err)}`);
    const errorContainer = createErrorContainer(botVi.panelFailed, botVi.panelFailedHint);
    const payload = v2Payload(errorContainer, [], { ephemeral: true });
    if (interaction.deferred || interaction.replied) {
      await interaction.editReply(payload).catch(() => undefined);
    } else {
      await interaction.reply(payload).catch(() => undefined);
    }
  }
}

export async function handleMenuCommand(
  interaction: ChatInputCommandInteraction,
  deps: BotDeps,
): Promise<void> {
  await handleShelfCommand(interaction, deps);
}

export async function handleFindCommand(
  interaction: ChatInputCommandInteraction,
  deps: BotDeps,
): Promise<void> {
  if (!interaction.deferred && !interaction.replied) {
    await interaction.deferReply({
      flags: MessageFlags.Ephemeral,
    }).catch(() => undefined);
  }
  if (!(await requireAdminRole(interaction, deps))) return;

  const query = interaction.options.getString('ten', true).trim();
  const total = countPlugins(deps.db, query);

  if (total === 0) {
    const noticeContainer = createNoticeContainer(botVi.notFound(query), botVi.notFoundHint);
    const payload = v2Payload(noticeContainer, [], { ephemeral: true });
    if (interaction.deferred || interaction.replied) {
      await interaction.editReply(payload).catch(() => undefined);
    } else {
      await interaction.reply(payload).catch(() => undefined);
    }
    return;
  }

  const matches = listPlugins(deps.db, total, 0, query);

  const paged = buildPagedSelect({
    items: matches.map((plugin) => ({
      value: String(plugin.id),
      label: plugin.displayName,
      description: plugin.depositPrice > 0 ? `${plugin.depositPrice.toLocaleString('vi-VN')} ₫` : undefined,
    })),
    page: 0,
    selectId: ID.selectPlugin,
    navPrefix: ID.pagePlugin,
    placeholder: botVi.pickPlugin,
  });

  const browseContainer = createBrowseContainer(total, paged.page, paged.totalPages);
  const payload = v2Payload(browseContainer, toComponents(paged), { ephemeral: true });

  if (interaction.deferred || interaction.replied) {
    await interaction.editReply(payload).catch(() => undefined);
  } else {
    await interaction.reply(payload).catch(() => undefined);
  }
}
