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
  TextDisplayBuilder,
  type ButtonInteraction,
  type ChatInputCommandInteraction,
  type ModalSubmitInteraction,
  type StringSelectMenuInteraction,
} from 'discord.js';
import type { BotDeps } from '../components/handle-component-interaction.js';
import { ID } from '../components/handle-component-interaction.js';
import { findPluginById, findPluginBySlug, listPlugins } from '../../repositories/plugins.js';
import { listVersionsByPlugin } from '../../repositories/versions.js';
import { findOwners } from '../../repositories/resource-ownership.js';
import { formatBytes, formatVnd, shortDate } from '../i18n/bot-vi.js';
import { renderPluginBannerCanvas } from '../../services/canvas/plugin-banner-canvas.js';
import { join } from 'node:path';
import { existsSync } from 'node:fs';
import { createErrorContainer, V2_COLOUR, v2Payload } from '../components/build-v2-containers.js';

export const pluginInfoCommand = new SlashCommandBuilder()
  .setName('plugin-info')
  .setDescription('Xem thông tin chi tiết, banner đồ họa và lịch sử phiên bản của một plugin (Components V2)')
  .addStringOption((opt) =>
    opt
      .setName('ten')
      .setDescription('ID, slug hoặc tên plugin cần tra cứu')
      .setRequired(true)
      .setAutocomplete(true),
  );

/**
 * Xử lý gợi ý tìm kiếm (Autocomplete) cho /plugin-info
 */
export async function handlePluginInfoAutocomplete(
  interaction: any,
  deps: BotDeps,
): Promise<void> {
  const focused = interaction.options.getFocused().trim();
  const plugins = listPlugins(deps.db, 25, 0, focused.length > 0 ? focused : undefined);

  await interaction.respond(
    plugins.map((p) => {
      const priceTag = p.depositPrice > 0 ? ` [${p.depositPrice.toLocaleString('vi-VN')} ₫]` : ' [Free]';
      const name = `${p.displayName}${priceTag}`.slice(0, 100);
      return {
        name,
        value: String(p.id),
      };
    }),
  );
}

/**
 * Hiển thị chi tiết một plugin dạng Components V2
 */
export async function handlePluginDetail(
  interaction:
    | ChatInputCommandInteraction
    | ButtonInteraction
    | StringSelectMenuInteraction
    | ModalSubmitInteraction,
  deps: BotDeps,
  pluginId: number,
): Promise<void> {
  const plugin = findPluginById(deps.db, pluginId);
  if (!plugin) {
    const errorContainer = createErrorContainer(
      'Không tìm thấy plugin',
      'Plugin này không tồn tại hoặc đã bị xóa khỏi kho.',
    );
    const payload = v2Payload(errorContainer, [], { ephemeral: true });
    if (interaction.deferred || interaction.replied) {
      await interaction.editReply(payload).catch(() => undefined);
    } else {
      await interaction.reply(payload).catch(() => undefined);
    }
    return;
  }

  const versions = listVersionsByPlugin(deps.db, plugin.id);
  const isPremium = plugin.isPremium || plugin.depositPrice > 0;

  // Render Canvas Banner với Lucide Icons (chuẩn /banner-design & /ui-ux-pro-max)
  const assetsDir = join(deps.env.VAULT_DIR, '..', 'assets');
  let bannerAttachment: AttachmentBuilder | null = null;
  try {
    const bannerBuf = await renderPluginBannerCanvas(deps.db, plugin, {
      assetsDir: existsSync(assetsDir) ? assetsDir : './assets',
    });
    bannerAttachment = new AttachmentBuilder(bannerBuf, { name: 'plugin-banner.png' });
  } catch (err) {
    console.error('Failed to render plugin banner canvas:', err);
  }

  // Khởi tạo Container V2
  const container = new ContainerBuilder()
    .setAccentColor(isPremium ? V2_COLOUR.gold : V2_COLOUR.brand);

  // 1. Ảnh banner Canvas qua MediaGallery
  if (bannerAttachment) {
    container.addMediaGalleryComponents(
      new MediaGalleryBuilder().addItems(
        new MediaGalleryItemBuilder().setURL('attachment://plugin-banner.png'),
      ),
    );
    container.addSeparatorComponents(
      new SeparatorBuilder().setDivider(true).setSpacing(SeparatorSpacingSize.Small),
    );
  }

  // 2. Tiêu đề và thông tin tổng quan plugin
  const descText = plugin.description ? `> ${plugin.description}\n\n` : '';
  container.addTextDisplayComponents(
    new TextDisplayBuilder().setContent(
      `# 📦 ${plugin.displayName}\n` +
        descText +
        `🏷️ **Slug:** \`${plugin.slug}\`  •  **Platform:** \`${plugin.platform}\`  •  **ID:** \`#${plugin.resourceId || plugin.id}\`\n` +
        `💎 **Loại:** ${isPremium ? '⭐ **Premium**' : '🟢 **Miễn phí**'}  •  **Giá cọc:** ${plugin.depositPrice > 0 ? formatVnd(plugin.depositPrice) : '0 ₫'}\n` +
        `📊 **Kho lưu trữ:** **${versions.length}** phiên bản  •  **Bản mới nhất:** \`${versions[0]?.version ? `v${versions[0].version} (Mới nhất)` : 'Chưa có'}\`  •  **Dung lượng:** ${versions[0]?.bytes ? formatBytes(versions[0].bytes) : '—'}`,
    ),
  );

  // 3. Danh sách các phiên bản gần nhất
  if (versions.length > 0) {
    const versionList = versions
      .slice(0, 5)
      .map((v, i) => {
        const flag = v.isStable ? ' ⭐ [Ổn định]' : '';
        const size = formatBytes(v.bytes);
        const date = shortDate(v.uploadedAt);
        return `**${i + 1}. v${v.version || 'Gốc'}**${flag} • ${size} • _${date}_`;
      })
      .join('\n');

    container.addSeparatorComponents(
      new SeparatorBuilder().setDivider(true).setSpacing(SeparatorSpacingSize.Small),
    );
    container.addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        `### 📋 Các Bản Gần Nhất (${Math.min(5, versions.length)}/${versions.length})\n` +
          versionList,
      ),
    );
  } else {
    container.addSeparatorComponents(
      new SeparatorBuilder().setDivider(true).setSpacing(SeparatorSpacingSize.Small),
    );
    container.addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        `### 📋 Phiên Bản\n_Chưa có tệp \`.jar\` nào được lưu trữ cho plugin này._`,
      ),
    );
  }

  // 4. URL trên SpigotMC
  const spigotUrl =
    plugin.externalLink?.trim() ||
    (plugin.resourceId ? `https://www.spigotmc.org/resources/${plugin.resourceId}/` : undefined);

  // Hàng nút tương tác
  const actionRow = new ActionRowBuilder<ButtonBuilder>();

  // Nút Tải về / Mua
  if (versions.length > 0) {
    actionRow.addComponents(
      new ButtonBuilder()
        .setCustomId(ID.selectVersion(plugin.id))
        .setLabel(plugin.depositPrice > 0 ? '📥 Mua Phiên Bản Này' : '📥 Tải Phiên Bản')
        .setStyle(ButtonStyle.Success),
    );
  }

  // Nút liên kết SpigotMC
  if (spigotUrl) {
    actionRow.addComponents(
      new ButtonBuilder()
        .setLabel('🔗 Xem Trên SpigotMC')
        .setStyle(ButtonStyle.Link)
        .setURL(spigotUrl),
    );
  }

  // Nút Quay lại Kệ Hàng
  actionRow.addComponents(
    new ButtonBuilder()
      .setCustomId('shelf:p:0')
      .setLabel('🏪 Kệ Hàng')
      .setStyle(ButtonStyle.Secondary),
  );

  const payload = v2Payload(container, [actionRow], {
    files: bannerAttachment ? [bannerAttachment] : [],
    ephemeral: true,
  });

  if (interaction.deferred || interaction.replied) {
    await interaction.editReply(payload).catch(() => undefined);
  } else {
    await interaction.reply(payload).catch(() => undefined);
  }
}

/**
 * Xử lý lệnh /plugin-info
 */
export async function handlePluginInfoCommand(
  interaction: ChatInputCommandInteraction,
  deps: BotDeps,
): Promise<void> {
  if (!interaction.deferred && !interaction.replied) {
    await interaction.deferReply({
      flags: MessageFlags.Ephemeral,
    }).catch(() => undefined);
  }

  const query = interaction.options.getString('ten', true).trim();

  // Thử parse theo ID trước
  const numericId = parseInt(query, 10);
  let plugin = Number.isInteger(numericId) ? findPluginById(deps.db, numericId) : null;

  // Nếu không thấy theo ID, tìm theo slug hoặc tên
  if (!plugin) {
    plugin = findPluginBySlug(deps.db, query);
  }
  if (!plugin) {
    const list = listPlugins(deps.db, 1, 0, query);
    plugin = list[0] ?? null;
  }

  if (!plugin) {
    const errorContainer = createErrorContainer(
      'Không tìm thấy plugin',
      `Không tìm thấy plugin nào khớp với từ khóa "${query}".`,
    );
    const payload = v2Payload(errorContainer, [], { ephemeral: true });
    await interaction.editReply(payload).catch(() => undefined);
    return;
  }

  await handlePluginDetail(interaction, deps, plugin.id);
}
