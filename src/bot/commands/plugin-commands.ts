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
import { browseEmbed, errorEmbed, noticeEmbed, panelEmbed } from '../components/build-embeds.js';
import { ID, showPluginPage, type BotDeps } from '../components/handle-component-interaction.js';
import { requireAdminRole } from '../guards/require-admin-role.js';

export const menuCommand = new SlashCommandBuilder()
  .setName('menu')
  .setDescription('Mở danh sách plugin trong kho');

export const findCommand = new SlashCommandBuilder()
  .setName('find')
  .setDescription('Tìm plugin theo tên')
  .addStringOption((option) =>
    option.setName('ten').setDescription('Tên plugin cần tìm').setRequired(true).setMaxLength(100),
  );

export const panelCommand = new SlashCommandBuilder()
  .setName('panel')
  .setDescription('Đặt bảng chọn plugin cố định vào kênh này');

/**
 * Posts the standing panel: a permanent public message whose button opens a
 * private plugin browser.
 *
 * A button, not a select menu, and deliberately so. Every later step in the
 * browse flow edits the message it was invoked from, so putting the picker
 * directly on a shared public message would mean the first person to choose a
 * plugin rewrites the panel for everyone else. The button instead opens a fresh
 * ephemeral menu per person, leaving the panel itself untouched forever.
 *
 * All state lives in custom_id and is served by the same global handler, so the
 * panel keeps working across restarts with nothing to re-post.
 */
export async function handlePanelCommand(
  interaction: ChatInputCommandInteraction,
  deps: BotDeps,
): Promise<void> {
  if (!interaction.deferred && !interaction.replied) {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral }).catch(() => undefined);
  }
  if (!(await requireAdminRole(interaction, deps))) return;

  const open = new ButtonBuilder()
    .setCustomId(ID.openPanel)
    .setLabel(botVi.panelButton)
    .setStyle(ButtonStyle.Primary);

  try {
    if (!interaction.channel?.isSendable()) throw new Error('kênh không nhận được tin nhắn');
    // Counted here so the panel states the size of the vault. A bare "open the
    // vault" gives no reason to press it.
    const total = countPlugins(deps.db);
    await interaction.channel.send({
      embeds: [panelEmbed(total)],
      components: [new ActionRowBuilder<ButtonBuilder>().addComponents(open)],
    });
    if (interaction.deferred || interaction.replied) {
      await interaction.editReply({ content: botVi.panelPlaced }).catch(() => undefined);
    } else {
      await interaction.reply({ content: botVi.panelPlaced, flags: MessageFlags.Ephemeral }).catch(() => undefined);
    }
  } catch (err) {
    // Almost always a missing Send Messages permission for the bot in this channel.
    // Correcting the confirmation matters: otherwise the owner is told the panel is
    // placed and goes looking for a message that was never posted.
    console.warn(`Không đặt được panel: ${err instanceof Error ? err.message : String(err)}`);
    const payload = { content: '', embeds: [errorEmbed(botVi.panelFailed, botVi.panelFailedHint)] };
    if (interaction.deferred || interaction.replied) {
      await interaction.editReply(payload).catch(() => undefined);
    } else {
      await interaction.reply({ ...payload, flags: MessageFlags.Ephemeral }).catch(() => undefined);
    }
  }
}

export async function handleMenuCommand(
  interaction: ChatInputCommandInteraction,
  deps: BotDeps,
): Promise<void> {
  if (!interaction.deferred && !interaction.replied) {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral }).catch(() => undefined);
  }
  if (!(await requireAdminRole(interaction, deps))) return;
  await showPluginPage(interaction, deps, 0);
}

/**
 * Fuzzy search — the primary path once the vault holds more plugins than a select
 * menu's 25 options can show.
 */
export async function handleFindCommand(
  interaction: ChatInputCommandInteraction,
  deps: BotDeps,
): Promise<void> {
  if (!interaction.deferred && !interaction.replied) {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral }).catch(() => undefined);
  }
  if (!(await requireAdminRole(interaction, deps))) return;

  const query = interaction.options.getString('ten', true).trim();
  const total = countPlugins(deps.db, query);

  if (total === 0) {
    const payload = {
      embeds: [noticeEmbed(botVi.notFound(query), botVi.notFoundHint)],
    };
    if (interaction.deferred || interaction.replied) {
      await interaction.editReply(payload).catch(() => undefined);
    } else {
      await interaction.reply({ ...payload, flags: MessageFlags.Ephemeral }).catch(() => undefined);
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

  const payload = {
    embeds: [
      browseEmbed(total, paged.page, paged.totalPages).setTitle(botVi.searchResults(total)),
    ],
    components: toComponents(paged),
  };
  if (interaction.deferred || interaction.replied) {
    await interaction.editReply(payload).catch(() => undefined);
  } else {
    await interaction.reply({ ...payload, flags: MessageFlags.Ephemeral }).catch(() => undefined);
  }
}
