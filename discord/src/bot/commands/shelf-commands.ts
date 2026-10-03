import {
  ActionRowBuilder,
  AttachmentBuilder,
  ButtonBuilder,
  ButtonStyle,
  ContainerBuilder,
  MediaGalleryBuilder,
  MediaGalleryItemBuilder,
  MessageFlags,
  SeparatorBuilder,
  SeparatorSpacingSize,
  SlashCommandBuilder,
  StringSelectMenuBuilder,
  TextDisplayBuilder,
  type ButtonInteraction,
  type ChatInputCommandInteraction,
  type StringSelectMenuInteraction,
} from 'discord.js';
import type { BotDeps } from '../components/handle-component-interaction.js';
import { countPlugins, listPlugins } from '../../repositories/plugins.js';
import { renderPluginShelfCanvas } from '../../services/canvas/plugin-shelf-canvas.js';
import { handlePluginDetail } from './plugin-info-commands.js';
import { join } from 'node:path';
import { existsSync } from 'node:fs';
import { createErrorContainer, V2_COLOUR, v2Payload } from '../components/build-v2-containers.js';
import { getEmoji, rawEmoji } from '../emojis.js';

export const SHELF_ID = {
  pagePrefix: 'shelf:p:',
  selectPlugin: 'shelf:select',
};

const ITEMS_PER_PAGE = 6;

export const shelfCommand = new SlashCommandBuilder()
  .setName('kho')
  .setDescription('Mở kệ hàng hiển thị toàn bộ plugin trong kho (Components V2 & Đồ họa Canvas)')
  .addIntegerOption((opt) =>
    opt.setName('trang').setDescription('Số thứ tự trang cần xem').setMinValue(1).setRequired(false),
  );

function createShelfNavRow(safePage: number, totalPages: number): ActionRowBuilder<ButtonBuilder> {
  const maxPage = Math.max(0, totalPages - 1);

  const firstBtn = new ButtonBuilder()
    .setCustomId(`${SHELF_ID.pagePrefix}first:0`)
    .setLabel('Đầu')
    .setStyle(ButtonStyle.Secondary)
    .setDisabled(safePage === 0);
  const firstEmoji = rawEmoji('navFirst');
  if (firstEmoji) firstBtn.setEmoji(firstEmoji);

  const prevBtn = new ButtonBuilder()
    .setCustomId(`${SHELF_ID.pagePrefix}prev:${Math.max(0, safePage - 1)}`)
    .setLabel('Trước')
    .setStyle(ButtonStyle.Primary)
    .setDisabled(safePage === 0);
  const prevEmoji = rawEmoji('navPrev');
  if (prevEmoji) prevBtn.setEmoji(prevEmoji);

  const currBtn = new ButtonBuilder()
    .setCustomId(`shelf:curr:${safePage}`)
    .setLabel(`${safePage + 1} / ${Math.max(1, totalPages)}`)
    .setStyle(ButtonStyle.Secondary)
    .setDisabled(true);

  const nextBtn = new ButtonBuilder()
    .setCustomId(`${SHELF_ID.pagePrefix}next:${Math.min(maxPage, safePage + 1)}`)
    .setLabel('Sau')
    .setStyle(ButtonStyle.Primary)
    .setDisabled(safePage >= maxPage);
  const nextEmoji = rawEmoji('navNext');
  if (nextEmoji) nextBtn.setEmoji(nextEmoji);

  const lastBtn = new ButtonBuilder()
    .setCustomId(`${SHELF_ID.pagePrefix}last:${maxPage}`)
    .setLabel('Cuối')
    .setStyle(ButtonStyle.Secondary)
    .setDisabled(safePage >= maxPage);
  const lastEmoji = rawEmoji('navLast');
  if (lastEmoji) lastBtn.setEmoji(lastEmoji);

  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    firstBtn,
    prevBtn,
    currBtn,
    nextBtn,
    lastBtn,
  );
}

/**
 * Tạo payload Fallback dạng Components V2 Text khi môi trường không thể gửi ảnh Canvas
 */
export function buildFallbackShelfPayload(deps: BotDeps, page = 0) {
  const totalPlugins = countPlugins(deps.db);
  const totalPages = Math.max(1, Math.ceil(totalPlugins / ITEMS_PER_PAGE));
  const safePage = Math.max(0, Math.min(page, totalPages - 1));

  const plugins = listPlugins(deps.db, ITEMS_PER_PAGE, safePage * ITEMS_PER_PAGE);

  const lines = plugins.map((p, idx) => {
    const price = p.depositPrice > 0 ? `${p.depositPrice.toLocaleString('vi-VN')} ₫` : 'Miễn phí';
    const tag = p.isPremium ? `${getEmoji('premium')}**[PREMIUM]**` : `${getEmoji('free')}**[FREE]**`;
    return `**${safePage * ITEMS_PER_PAGE + idx + 1}. ${p.displayName}**\n> ${tag} • Giá: **${price}** • Mã: \`#${p.resourceId || p.id}\``;
  });

  const container = new ContainerBuilder()
    .setAccentColor(V2_COLOUR.brand)
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        `# ${getEmoji('store')}KỆ HÀNG PLUGINS VAULT\n` +
          `Đang hiển thị **${plugins.length}** plugin trên kệ hàng (Trang **${safePage + 1}** / **${totalPages}**).\n\n` +
          (lines.length > 0 ? lines.join('\n\n') : '*Hiện chưa có plugin nào trong kho.*') +
          `\n\n*${getEmoji('lightbulb')}Chọn plugin từ menu bên dưới để xem chi tiết & nhận link tải.*`,
      ),
    )
    .addSeparatorComponents(
      new SeparatorBuilder().setDivider(true).setSpacing(SeparatorSpacingSize.Small),
    )
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        `*Tổng cộng ${totalPlugins} plugin • Trang ${safePage + 1}/${totalPages}*`,
      ),
    );

  const navRow = createShelfNavRow(safePage, totalPages);

  const selectOptions = plugins.map((p, idx) => ({
    label: `${idx + 1}. ${p.displayName.slice(0, 50)}`,
    value: String(p.id),
    description: (p.depositPrice > 0 ? `Giá: ${p.depositPrice.toLocaleString('vi-VN')} ₫` : 'Miễn phí').slice(0, 100),
  }));

  const components: any[] = [navRow];

  if (selectOptions.length > 0) {
    const pickerRow = new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
      new StringSelectMenuBuilder()
        .setCustomId(SHELF_ID.selectPlugin)
        .setPlaceholder(`${getEmoji('search')}Chọn một plugin trên kệ để xem chi tiết...`.trim())
        .addOptions(selectOptions),
    );
    components.push(pickerRow);
  }

  return v2Payload(container, components, { ephemeral: true });
}

/**
 * Xây dựng payload hiển thị Kệ Hàng Plugins Components V2 kèm hình ảnh Canvas
 */
export async function buildShelfPayload(deps: BotDeps, page = 0) {
  const totalPlugins = countPlugins(deps.db);
  const totalPages = Math.max(1, Math.ceil(totalPlugins / ITEMS_PER_PAGE));
  const safePage = Math.max(0, Math.min(page, totalPages - 1));

  const plugins = listPlugins(deps.db, ITEMS_PER_PAGE, safePage * ITEMS_PER_PAGE);

  // Render ảnh Kệ Hàng bằng Canvas
  const assetsDir = join(deps.env.VAULT_DIR, '..', 'assets');
  const finalAssetsDir = existsSync(assetsDir) ? assetsDir : './assets';
  const buffer = await renderPluginShelfCanvas(deps.db, plugins, {
    page: safePage,
    totalPages,
    totalPlugins,
    assetsDir: finalAssetsDir,
  });

  const attachment = new AttachmentBuilder(buffer, { name: 'plugins-shelf.png' });

  // Container V2 chứa ảnh MediaGallery & Text
  const container = new ContainerBuilder()
    .setAccentColor(V2_COLOUR.brand)
    .addMediaGalleryComponents(
      new MediaGalleryBuilder().addItems(
        new MediaGalleryItemBuilder().setURL('attachment://plugins-shelf.png'),
      ),
    )
    .addSeparatorComponents(
      new SeparatorBuilder().setDivider(true).setSpacing(SeparatorSpacingSize.Small),
    )
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        `## ${getEmoji('store')}KỆ HÀNG PLUGINS VAULT\n` +
          `Đang hiển thị **${plugins.length}** plugin trên kệ hàng (Trang **${safePage + 1}** / **${totalPages}**).\n` +
          `Chọn một plugin từ menu bên dưới để xem chi tiết & nhận liên kết tải!`,
      ),
    )
    .addSeparatorComponents(
      new SeparatorBuilder().setDivider(true).setSpacing(SeparatorSpacingSize.Small),
    )
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        `*Tổng cộng ${totalPlugins} plugin • Dùng các nút bên dưới để chuyển trang kệ*`,
      ),
    );

  // Row 1: Nút chuyển trang (First, Prev, Current, Next, Last)
  const navRow = createShelfNavRow(safePage, totalPages);

  // Row 2: Select Menu chọn nhanh plugin trên kệ
  const selectOptions = plugins.map((p, idx) => ({
    label: `${idx + 1}. ${p.displayName.slice(0, 50)}`,
    value: String(p.id),
    description: (p.depositPrice > 0 ? `Giá: ${p.depositPrice.toLocaleString('vi-VN')} ₫` : 'Miễn phí').slice(0, 100),
  }));

  const components: any[] = [navRow];

  if (selectOptions.length > 0) {
    const pickerRow = new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
      new StringSelectMenuBuilder()
        .setCustomId(SHELF_ID.selectPlugin)
        .setPlaceholder(`${getEmoji('search')}Chọn một plugin trên kệ để xem chi tiết...`.trim())
        .addOptions(selectOptions),
    );
    components.push(pickerRow);
  }

  return v2Payload(container, components, { files: [attachment], ephemeral: true });
}

/**
 * Xử lý lệnh /kho hoặc /menu
 */
export async function handleShelfCommand(
  interaction: ChatInputCommandInteraction,
  deps: BotDeps,
): Promise<void> {
  const userTag = interaction.user.tag;
  const channelId = interaction.channelId;
  console.log(`[handleShelfCommand] Nhận lệnh từ ${userTag} tại kênh ${channelId}`);

  try {
    if (!interaction.deferred && !interaction.replied) {
      await interaction.deferReply({
        flags: MessageFlags.Ephemeral,
      });
    }

    const requestedPage = (interaction.options.getInteger('trang') ?? 1) - 1;
    let payload;

    try {
      payload = await buildShelfPayload(deps, requestedPage);
    } catch (canvasErr) {
      console.error('[handleShelfCommand] Lỗi render Canvas, tự động chuyển Fallback Text:', canvasErr);
      payload = buildFallbackShelfPayload(deps, requestedPage);
    }

    try {
      await interaction.editReply(payload);
      console.log(`[handleShelfCommand] Gửi kệ hàng Components V2 thành công cho ${userTag}`);
    } catch (sendErr) {
      console.error('[handleShelfCommand] Discord từ chối gửi tệp đính kèm, kích hoạt Fallback Text:', sendErr);
      const fallbackPayload = buildFallbackShelfPayload(deps, requestedPage);
      await interaction.editReply(fallbackPayload);
      console.log(`[handleShelfCommand] Gửi Fallback Text Components V2 thành công cho ${userTag}`);
    }
  } catch (fatalErr) {
    console.error('[handleShelfCommand] Lỗi nghiêm trọng không thể mở kệ hàng:', fatalErr);
    const msg = fatalErr instanceof Error ? fatalErr.message : String(fatalErr);
    const errorContainer = createErrorContainer('Không thể mở Kệ Hàng Plugins', msg);
    const errorPayload = v2Payload(errorContainer, [], { ephemeral: true });

    if (interaction.deferred || interaction.replied) {
      await interaction.editReply(errorPayload).catch(() => undefined);
    } else {
      await interaction.reply(errorPayload).catch(() => undefined);
    }
  }
}

/**
 * Xử lý nút bấm chuyển trang kệ hàng
 */
export async function handleShelfButton(
  interaction: ButtonInteraction,
  deps: BotDeps,
): Promise<void> {
  try {
    const parts = interaction.customId.split(':');
    // customId format: "shelf:p:action:page" (ví dụ: "shelf:p:first:0", "shelf:p:next:1")
    const pageStr = parts[3] ?? parts[2];
    const targetPage = parseInt(pageStr ?? '0', 10);

    if (Number.isNaN(targetPage)) return;

    await interaction.deferUpdate();

    let payload;
    try {
      payload = await buildShelfPayload(deps, targetPage);
    } catch (err) {
      console.error('[handleShelfButton] Lỗi Canvas khi chuyển trang, dùng fallback:', err);
      payload = buildFallbackShelfPayload(deps, targetPage);
    }

    try {
      await interaction.editReply(payload);
    } catch (sendErr) {
      console.error('[handleShelfButton] Lỗi editReply ảnh, dùng fallback text:', sendErr);
      const fallbackPayload = buildFallbackShelfPayload(deps, targetPage);
      await interaction.editReply(fallbackPayload);
    }
  } catch (err) {
    console.error('[handleShelfButton] Lỗi nghiêm trọng khi chuyển trang:', err);
  }
}

/**
 * Xử lý chọn plugin từ Select Menu trên Kệ hàng
 */
export async function handleShelfSelect(
  interaction: StringSelectMenuInteraction,
  deps: BotDeps,
): Promise<void> {
  try {
    const pluginId = Number(interaction.values[0]);
    if (!pluginId) return;

    await handlePluginDetail(interaction, deps, pluginId);
  } catch (err) {
    console.error('[handleShelfSelect] Lỗi khi mở chi tiết plugin từ kệ hàng:', err);
  }
}
