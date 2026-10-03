import {
  ActionRowBuilder,
  ContainerBuilder,
  MessageFlags,
  SeparatorBuilder,
  SeparatorSpacingSize,
  StringSelectMenuBuilder,
  TextDisplayBuilder,
  MediaGalleryBuilder,
  MediaGalleryItemBuilder,
} from 'discord.js';
import type { Plugin, VersionWithPlugin } from '../../domain/plugin.js';
import { botVi, formatBytes, formatVnd, shortDate } from '../i18n/bot-vi.js';
import { formatBalance, type LedgerEntry } from '../../domain/wallet.js';
import type { CardTopup } from '../../domain/card-topup.js';
import { getEmoji } from '../emojis.js';

export const V2_COLOUR = {
  neutral: 0x5865f2,
  success: 0x57f287,
  pending: 0xfee75c,
  danger: 0xed4245,
  brand: 0x3b82f6,
  gold: 0xf59e0b,
} as const;

/**
 * Tạo payload tin nhắn chuẩn Components V2 của Discord
 */
export function v2Payload(
  container: ContainerBuilder,
  extraComponents: any[] = [],
  options: { files?: any[]; ephemeral?: boolean } = {},
) {
  if (Array.isArray(extraComponents) && extraComponents.length > 0) {
    for (const comp of extraComponents) {
      if (comp && typeof (container as any).addActionRowComponents === 'function') {
        container.addActionRowComponents(comp);
      }
    }
  }

  const flags = options.ephemeral
    ? MessageFlags.IsComponentsV2 | MessageFlags.Ephemeral
    : MessageFlags.IsComponentsV2;

  return {
    content: '',
    components: [container],
    files: options.files ?? [],
    flags,
  };
}

/**
 * Container thông báo lỗi
 */
export function createErrorContainer(title: string, hint: string): ContainerBuilder {
  return new ContainerBuilder()
    .setAccentColor(V2_COLOUR.danger)
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(`## ${getEmoji('error')}${title}\n${hint}`),
    );
}

/**
 * Container thông báo thông tin / trạng thái
 */
export function createNoticeContainer(title: string, body: string): ContainerBuilder {
  return new ContainerBuilder()
    .setAccentColor(V2_COLOUR.neutral)
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(`## ${getEmoji('info')}${title}\n${body}`),
    );
}

/**
 * Container thông báo thành công
 */
export function createSuccessContainer(title: string, body: string): ContainerBuilder {
  return new ContainerBuilder()
    .setAccentColor(V2_COLOUR.success)
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(`## ${getEmoji('success')}${title}\n${body}`),
    );
}

/**
 * Container thông báo giao tệp plugin thành công
 */
export function createDeliveredContainer(version: VersionWithPlugin): ContainerBuilder {
  return new ContainerBuilder()
    .setAccentColor(V2_COLOUR.success)
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        `# ${getEmoji('celebrate')}Giao Hàng Thành Công!\n` +
          `Đã chuyển giao phiên bản **${version.pluginDisplayName}** (\`v${version.version ?? 'mới nhất'}\`) trực tiếp qua tin nhắn riêng (DM) của bạn.`,
      ),
    )
    .addSeparatorComponents(
      new SeparatorBuilder().setDivider(true).setSpacing(SeparatorSpacingSize.Small),
    )
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        `${getEmoji('plugin')}**Dung lượng:** ${formatBytes(version.bytes)}  •  ${getEmoji('date')}**Cập nhật:** ${shortDate(version.uploadedAt)}\n` +
          `*Vui lòng kiểm tra hộp thư Discord (DM) để nhận tệp \`.jar\` hoặc đường dẫn tải dự phòng.*`,
      ),
    );
}

/**
 * Container thông báo liên kết tải trực tiếp khi DM bị chặn hoặc gửi tệp trực tiếp
 */
export function createDirectDownloadContainer(
  version: VersionWithPlugin,
  downloadUrl: string,
): ContainerBuilder {
  return new ContainerBuilder()
    .setAccentColor(V2_COLOUR.brand)
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        `# ${getEmoji('plugin')}Nhận Tệp: ${version.pluginDisplayName}\n` +
          `Bot không thể gửi tệp vào tin nhắn riêng (DM) của bạn (do bạn đang tắt DM từ thành viên server).\n\n` +
          `${getEmoji('point')}**Bạn vẫn có thể tải trực tiếp file bằng liên kết bên dưới:**`,
      ),
    )
    .addSeparatorComponents(
      new SeparatorBuilder().setDivider(true).setSpacing(SeparatorSpacingSize.Small),
    )
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        `${getEmoji('version')}**Phiên bản:** \`v${version.version ?? 'mới nhất'}\`  •  ${getEmoji('plugin')}**Dung lượng:** ${formatBytes(version.bytes)}\n` +
          `${getEmoji('download')}**Liên kết tải:** [Nhấp vào đây để tải file .jar](${downloadUrl}) *(Hết hạn sau 15 phút)*`,
      ),
    );
}

/**
 * Container đơn hàng thanh toán thành công hoàn toàn qua ví
 */
export function createWalletPaidContainer(
  version: VersionWithPlugin,
  order: { amount: number; walletPaid: number },
): ContainerBuilder {
  return new ContainerBuilder()
    .setAccentColor(V2_COLOUR.success)
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        `# ${getEmoji('wallet')}Thanh Toán Thành Công Qua Ví\n` +
          `Đã khấu trừ **${formatBalance(order.walletPaid)}** từ số dư ví EZ Store để mua phiên bản **${version.pluginDisplayName}** (\`v${version.version ?? 'mới nhất'}\`).\n\n` +
          `*Hệ thống đang tiến hành chuyển tệp đến hộp thư cá nhân của bạn.*`,
      ),
    );
}

/**
 * Container hóa đơn chuyển khoản ngân hàng (VietQR) cho plugin
 */
export function createPaymentContainer(
  version: VersionWithPlugin,
  order: {
    code: string;
    amount: number;
    walletPaid: number;
    bankDue: number;
    qrUrl: string | null;
    expiresAt: number;
  },
): ContainerBuilder {
  const minutes = Math.max(1, Math.round((order.expiresAt - Math.floor(Date.now() / 1000)) / 60));

  const container = new ContainerBuilder()
    .setAccentColor(V2_COLOUR.pending)
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        `# ${getEmoji('invoice')}Hóa Đơn Thanh Toán Plugin\n` +
          `Sở hữu phiên bản **${version.pluginDisplayName}** (\`v${version.version ?? 'mới nhất'}\`).\n\n` +
          (order.walletPaid > 0
            ? `• **Giá gốc:** ${formatVnd(order.amount)}\n• **Ví khấu trừ:** -${formatBalance(order.walletPaid)}\n• **Số tiền cần chuyển:** **${formatVnd(order.bankDue)}**`
            : `• **Số tiền cần chuyển:** **${formatVnd(order.bankDue)}**`),
      ),
    )
    .addSeparatorComponents(
      new SeparatorBuilder().setDivider(true).setSpacing(SeparatorSpacingSize.Small),
    )
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        `${getEmoji('pin')}**Nội dung chuyển khoản (BẮT BUỘC CHÍNH XÁC):**\n` +
          `\`\`\`\n${order.code}\n\`\`\`\n` +
          `${getEmoji('warning')}*Hệ thống tự động kích hoạt và giao tệp ngay khi nhận được thanh toán. Lệnh giữ trong **${minutes} phút**.*`,
      ),
    );

  if (order.qrUrl) {
    container.addMediaGalleryComponents(
      new MediaGalleryBuilder().addItems(new MediaGalleryItemBuilder().setURL(order.qrUrl)),
    );
  }

  return container;
}

/**
 * Container thông tin ví tiền
 */
export function createWalletContainer(balance: number, recent: LedgerEntry[]): ContainerBuilder {
  const container = new ContainerBuilder()
    .setAccentColor(V2_COLOUR.brand)
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        `# ${getEmoji('price')}Ví Tiền EZ Store\n` +
          `Số dư khả dụng hiện tại: **${formatBalance(balance)}**\n` +
          `*Dùng số dư này để mua các plugin có phí ngay lập tức mà không cần chuyển khoản từng đơn.*`,
      ),
    );

  if (recent.length > 0) {
    container
      .addSeparatorComponents(
        new SeparatorBuilder().setDivider(true).setSpacing(SeparatorSpacingSize.Small),
      )
      .addTextDisplayComponents(
        new TextDisplayBuilder().setContent(
          `### ${getEmoji('history')}Lịch sử biến động gần đây:\n` +
            recent.map((entry) => `• ${botVi.ledgerLine(entry.delta, entry.kind, entry.createdAt)}`).join('\n'),
        ),
      );
  } else {
    container.addTextDisplayComponents(
      new TextDisplayBuilder().setContent(`\n_${botVi.walletEmptyHint}_`),
    );
  }

  return container;
}

/**
 * Container tạo mã QR nạp ví
 */
export function createTopupQrContainer(topup: {
  code: string;
  amount: number;
  qrUrl: string;
  expiresAt: number;
  }): ContainerBuilder {
  const minutes = Math.max(1, Math.round((topup.expiresAt - Math.floor(Date.now() / 1000)) / 60));

  const container = new ContainerBuilder()
    .setAccentColor(V2_COLOUR.pending)
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        `# ${getEmoji('qr')}Nạp Tiền Vào Ví Qua VietQR\n` +
          `Số tiền nạp: **${formatVnd(topup.amount)}** (Cộng **${formatBalance(topup.amount)}** vào ví).\n\n` +
          `${getEmoji('pin')}**Nội dung chuyển khoản (BẮT BUỘC):**\n` +
          `\`\`\`\n${topup.code}\n\`\`\`\n` +
          `*Quét mã QR bằng App Ngân hàng bất kỳ. Lệnh nạp hết hạn sau **${minutes} phút**.*`,
      ),
    );

  if (topup.qrUrl) {
    container.addMediaGalleryComponents(
      new MediaGalleryBuilder().addItems(new MediaGalleryItemBuilder().setURL(topup.qrUrl)),
    );
  }

  return container;
}

/**
 * Container kết quả nạp thẻ cào
 */
export function createCardResultContainer(topup: CardTopup, balance: number): ContainerBuilder {
  let title = botVi.cardOkTitle;
  let desc = botVi.cardOkBody(topup.actualValue ?? topup.declaredValue, balance);
  let color: number = V2_COLOUR.success;

  if (topup.status === 'wrong_amount') {
    title = botVi.cardWrongTitle;
    desc = botVi.cardWrongBody(topup.declaredValue, topup.actualValue ?? 0, balance);
    color = V2_COLOUR.pending;
  } else if (topup.status === 'failed') {
    title = botVi.cardFailedTitle;
    desc = botVi.cardFailedBody;
    color = V2_COLOUR.danger;
  } else if (topup.status === 'pending') {
    title = botVi.cardPendingTitle;
    desc = botVi.cardPendingBody;
    color = V2_COLOUR.neutral;
  } else if (topup.status === 'needs_review' || topup.status === 'timeout') {
    title = botVi.cardReviewTitle;
    desc = botVi.cardReviewBody;
    color = V2_COLOUR.pending;
  }

  return new ContainerBuilder()
    .setAccentColor(color)
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        `## ${title}\n` +
          `• **Nhà mạng & Mệnh giá:** ${topup.telco} · ${formatVnd(topup.declaredValue)}\n\n` +
          `${desc}`,
      ),
    );
}

/**
 * Container duyệt danh sách plugin
 */
export function createBrowseContainer(
  pluginCount: number,
  page: number,
  totalPages: number,
): ContainerBuilder {
  return new ContainerBuilder()
    .setAccentColor(V2_COLOUR.brand)
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        `# ${getEmoji('store')}KHO TÀI NGUYÊN PLUGINS\n` +
          `Hiện có tổng cộng **${pluginCount}** plugin có sẵn trong kho lưu trữ.\n\n` +
          `*Trang ${page + 1} / ${totalPages} • Chọn một plugin từ menu thả xuống bên dưới để xem chi tiết.*`,
      ),
    );
}

/**
 * Container danh sách phiên bản của plugin
 */
export function createVersionsContainer(
  plugin: Plugin,
  versionCount: number,
  page: number,
  totalPages: number,
): ContainerBuilder {
  const isPremium = plugin.isPremium || plugin.depositPrice > 0;
  return new ContainerBuilder()
    .setAccentColor(isPremium ? V2_COLOUR.gold : V2_COLOUR.success)
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        `# ${getEmoji('plugin')}${plugin.displayName}\n` +
          (plugin.depositPrice > 0
            ? `${getEmoji('price')}**Giá cọc:** \`${formatVnd(plugin.depositPrice)}\`\n`
            : `${getEmoji('price')}**Giá cọc:** \`Miễn phí\`\n`) +
          `${getEmoji('version')}**Tổng số phiên bản:** **${versionCount}** bản lưu trữ (Trang ${page + 1}/${totalPages})\n\n` +
          `*Chọn phiên bản từ menu bên dưới để tiến hành tải hoặc mua.*`,
      ),
    );
}

/**
 * Container bảng điều khiển panel
 */
export function createPanelContainer(pluginCount: number): ContainerBuilder {
  return new ContainerBuilder()
    .setAccentColor(V2_COLOUR.brand)
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        `# ${getEmoji('panel')}BẢNG ĐIỀU KHIỂN PLUGINS VAULT\n` +
          `${botVi.panelBody}\n\n` +
          `*Tổng cộng **${pluginCount}** plugin đã được cấu hình trong hệ thống.*`,
      ),
    );
}

export interface StorePanelItem {
  id: number;
  pluginId: string;
  displayName: string;
  depositPrice: number;
  versionCount: number;
}

/**
 * Xây dựng tin nhắn Panel mua hàng chuẩn Components V2 kèm Media Gallery & Select Menu
 */
export function createStorePanelPayload(
  items: StorePanelItem[],
  bannerUrl = 'https://discord-webhook.com/uploads/e60133f9f684500d481a74cf37bd40a0.png',
) {
  const container = new ContainerBuilder()
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent('## Welcome to EZStore\n\n>>> `Choose your product you want !`\n'),
    )
    .addSeparatorComponents(
      new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small).setDivider(true),
    )
    .addMediaGalleryComponents(
      new MediaGalleryBuilder().addItems(
        new MediaGalleryItemBuilder().setURL(bannerUrl),
      ),
    )
    .addSeparatorComponents(
      new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small).setDivider(true),
    );

  const options = items.slice(0, 25).map((item) => {
    const vndPrice = item.depositPrice > 0 ? `${item.depositPrice.toLocaleString('vi-VN')} VND` : '0 VND';
    const coinsPrice = item.depositPrice > 0 ? `${item.depositPrice.toLocaleString('vi-VN')} Coins!` : '0 Coins!';
    const description = `${item.versionCount} Phiên bản | ${vndPrice} | ${coinsPrice}`.slice(0, 100);

    return {
      label: item.displayName.slice(0, 100),
      description,
      value: String(item.id),
      emoji: {
        name: '📦',
      },
    };
  });

  const selectRow = new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId('panel:select_plugin')
      .setPlaceholder('🔻 Chọn plugin bạn muốn xem hoặc mua...')
      .setDisabled(options.length === 0)
      .addOptions(
        options.length > 0
          ? options
          : [
              {
                label: 'Chưa có plugin nào trong kho',
                value: 'none',
                description: 'Vui lòng quay lại sau',
              },
            ],
      ),
  );

  return v2Payload(container, [selectRow]);
}
