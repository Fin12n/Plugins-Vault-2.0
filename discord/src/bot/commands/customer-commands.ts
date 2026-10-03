import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ContainerBuilder,
  MessageFlags,
  SeparatorBuilder,
  SeparatorSpacingSize,
  SlashCommandBuilder,
  TextDisplayBuilder,
  type ChatInputCommandInteraction,
} from "discord.js";
import type { Database } from "../../db/neon.js";
import { syncRolesForMember } from "../../services/roles/role-sync.js";
import { orders } from "@vault/db";
import { eq, and, sql, desc } from "drizzle-orm";
import {
  createErrorContainer,
  createNoticeContainer,
  V2_COLOUR,
  v2Payload,
} from "../components/build-v2-containers.js";

export const syncCommand = new SlashCommandBuilder()
  .setName("sync")
  .setDescription("Đồng bộ vai trò (Roles) Discord dựa trên lịch sử mua hàng (Components V2)");

export const myPluginsCommand = new SlashCommandBuilder()
  .setName("my-plugins")
  .setDescription("Xem danh sách các Plugin bạn đã sở hữu bản quyền (Components V2)");

export const downloadCommand = new SlashCommandBuilder()
  .setName("download")
  .setDescription("Nhận liên kết tải bản quyền cho plugin bạn đã mua (Components V2)")
  .addStringOption((opt) =>
    opt
      .setName("plugin")
      .setDescription("Tên hoặc slug của plugin")
      .setRequired(true)
  );

/**
 * Xử lý lệnh /sync
 */
export async function handleSyncCommand(
  interaction: ChatInputCommandInteraction,
  neonDb: Database,
  guildId: string
): Promise<void> {
  if (!interaction.deferred && !interaction.replied) {
    await interaction
      .deferReply({ flags: MessageFlags.Ephemeral })
      .catch(() => undefined);
  }

  const result = await syncRolesForMember(
    interaction.client,
    guildId,
    interaction.user.id,
    neonDb
  );

  const container = new ContainerBuilder()
    .setAccentColor(result.assignedRoles.length > 0 ? V2_COLOUR.success : V2_COLOUR.brand)
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent("## 🔄 Đồng Bộ Vai Trò Discord"),
    )
    .addSeparatorComponents(
      new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small).setDivider(true),
    )
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(result.message),
    );

  await interaction.editReply(v2Payload(container, [], { ephemeral: true })).catch(() => undefined);
}

/**
 * Xử lý lệnh /my-plugins
 */
export async function handleMyPluginsCommand(
  interaction: ChatInputCommandInteraction,
  neonDb: Database
): Promise<void> {
  if (!interaction.deferred && !interaction.replied) {
    await interaction
      .deferReply({ flags: MessageFlags.Ephemeral })
      .catch(() => undefined);
  }

  // Truy vấn các đơn hàng thành công của người dùng
  const purchasedOrders = await neonDb
    .select({
      pluginName: orders.pluginName,
      versionLabel: orders.versionLabel,
      paidAt: orders.paidAt,
      versionId: orders.versionId,
    })
    .from(orders)
    .where(
      and(
        eq(orders.discordUserId, interaction.user.id),
        sql`${orders.status} IN ('paid', 'delivered', 'wallet_paid')`
      )
    )
    .orderBy(desc(orders.createdAt));

  if (purchasedOrders.length === 0) {
    const container = new ContainerBuilder()
      .setAccentColor(V2_COLOUR.gold)
      .addTextDisplayComponents(
        new TextDisplayBuilder().setContent("## 📦 Kho Plugin Đã Sở Hữu"),
      )
      .addSeparatorComponents(
        new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small).setDivider(true),
      )
      .addTextDisplayComponents(
        new TextDisplayBuilder().setContent(
          "Bạn chưa sở hữu Plugin nào trong hệ thống.\nHãy sử dụng lệnh `/kho` hoặc ghé thăm cửa hàng để mua plugin!"
        ),
      );
    await interaction.editReply(v2Payload(container, [], { ephemeral: true })).catch(() => undefined);
    return;
  }

  // Loại bỏ trùng lặp nếu mua nhiều phiên bản
  const uniquePlugins = new Map<string, (typeof purchasedOrders)[0]>();
  for (const item of purchasedOrders) {
    if (!uniquePlugins.has(item.pluginName)) {
      uniquePlugins.set(item.pluginName, item);
    }
  }

  const items = Array.from(uniquePlugins.values());
  const description = items
    .map(
      (item, idx) =>
        `**${idx + 1}. ${item.pluginName}** (v${item.versionLabel || "Mới nhất"})\n└ Mua ngày: ${
          item.paidAt ? new Date(item.paidAt).toLocaleDateString("vi-VN") : "Đã duyệt"
        }`
    )
    .join("\n\n");

  const container = new ContainerBuilder()
    .setAccentColor(V2_COLOUR.success)
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(`## 📦 Plugin Đã Sở Hữu (${items.length})`),
    )
    .addSeparatorComponents(
      new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small).setDivider(true),
    )
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(description),
    )
    .addSeparatorComponents(
      new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small).setDivider(false),
    )
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent("-# 💡 Dùng /download <tên> để nhận liên kết tải về an toàn"),
    );

  await interaction.editReply(v2Payload(container, [], { ephemeral: true })).catch(() => undefined);
}

/**
 * Xử lý lệnh /download
 */
export async function handleDownloadCommand(
  interaction: ChatInputCommandInteraction,
  neonDb: Database,
  publicBaseUrl: string
): Promise<void> {
  if (!interaction.deferred && !interaction.replied) {
    await interaction
      .deferReply({ flags: MessageFlags.Ephemeral })
      .catch(() => undefined);
  }

  const query = interaction.options.getString("plugin", true).trim().toLowerCase();

  // Kiểm tra quyền sở hữu
  const purchased = await neonDb
    .select({
      orderId: orders.id,
      pluginName: orders.pluginName,
      versionId: orders.versionId,
    })
    .from(orders)
    .where(
      and(
        eq(orders.discordUserId, interaction.user.id),
        sql`${orders.status} IN ('paid', 'delivered', 'wallet_paid')`,
        sql`LOWER(${orders.pluginName}) LIKE ${`%${query}%`}`
      )
    )
    .limit(1);

  if (purchased.length === 0) {
    const container = createErrorContainer(
      "Không Tìm Thấy Bản Quyền",
      `Bạn chưa mua bản quyền plugin **${query}**.\nVui lòng kiểm tra lại tên bằng lệnh \`/my-plugins\` hoặc mua qua \`/kho\`.`
    );
    await interaction.editReply(v2Payload(container, [], { ephemeral: true })).catch(() => undefined);
    return;
  }

  const item = purchased[0];
  if (!item) {
    const container = createErrorContainer("Lỗi", "Không tìm thấy dữ liệu đơn hàng");
    await interaction.editReply(v2Payload(container, [], { ephemeral: true })).catch(() => undefined);
    return;
  }

  const downloadUrl = `${publicBaseUrl}/api/download?user=${interaction.user.id}&order=${item.orderId}`;
  const container = new ContainerBuilder()
    .setAccentColor(V2_COLOUR.brand)
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(`## ⚡ Tải Plugin: ${item.pluginName}`),
    )
    .addSeparatorComponents(
      new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small).setDivider(true),
    )
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        `Quyền sở hữu hợp lệ! Bạn có thể tải file bản quyền qua liên kết an toàn bên dưới:\n\n🔗 **[Nhấp vào đây để tải file](${downloadUrl})**`
      ),
    )
    .addSeparatorComponents(
      new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small).setDivider(false),
    )
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent("-# 🔒 Liên kết tải được bảo vệ và chống chia sẻ trái phép"),
    );

  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setLabel("Tải File .JAR").setStyle(ButtonStyle.Link).setURL(downloadUrl)
  );

  await interaction.editReply(v2Payload(container, [row], { ephemeral: true })).catch(() => undefined);
}
