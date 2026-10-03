/**
 * Bot strings, Vietnamese. Kept in one module so no string is inlined in logic.
 *
 * Rule for every message here: say what happened, then what the person can do
 * about it. A line like "Gửi thất bại" is true and useless — it leaves someone
 * staring at a dead end with no next step.
 */
import { formatBalance } from '../../domain/wallet.js';

export const botVi = {
  // Access and empty states
  guildOnly: 'Lệnh này chỉ dùng trong server',
  guildOnlyHint: 'Kho plugin gắn với role admin của server, nên không dùng được ở tin nhắn riêng. Hãy gõ lệnh trong một kênh của server.',
  noAccess: 'Bạn chưa có quyền tải plugin',
  noAccessHint: 'Cần role admin để dùng kho plugin. Hãy nhờ chủ server cấp role, rồi thử lại.',
  noPlugins: 'Kho chưa có plugin nào',
  noPluginsHint:
    'Chủ bot chưa nạp plugin nào vào kho. Nếu bạn là chủ bot, mở dashboard rồi kéo thả tệp .jar vào tab Plugin.',
  noVersions: 'Plugin này chưa có bản nào',
  noVersionsHint: 'Bot đã biết plugin nhưng chưa tải được bản nào. Thử lại sau, hoặc chọn plugin khác.',
  notFound: (query: string) => `Không tìm thấy plugin nào khớp "${query}"`,
  notFoundHint: 'Thử gõ ít chữ hơn — ví dụ "vulcan" thay vì "Vulcan Anti-Cheat 2.9".',

  // Browsing
  vaultTitle: 'Kho plugin',
  browseHint: (count: number) =>
    count === 1 ? 'Có 1 plugin trong kho. Chọn ở menu bên dưới.' : `Có ${count} plugin trong kho. Chọn ở menu bên dưới.`,
  versionsHint: (count: number) =>
    count === 1 ? 'Có 1 bản. Chọn để nhận tệp qua tin nhắn riêng.' : `Có ${count} bản, mới nhất ở trên.`,
  pickPlugin: 'Chọn plugin',
  pickVersion: 'Chọn phiên bản',
  pageOf: (page: number, total: number) => `Trang ${page}/${total}`,
  searchResults: (count: number) => (count === 1 ? 'Tìm thấy 1 plugin' : `Tìm thấy ${count} plugin`),
  stableMark: 'ổn định',

  // Field labels, shared across embeds
  fieldDeposit: 'Tạm ứng',
  fieldAmount: 'Số tiền',
  fieldPrice: 'Giá',
  fieldWalletPaid: 'Trả bằng ví',
  fieldBankDue: 'Cần chuyển',
  fieldTransferNote: 'Nội dung chuyển khoản — bắt buộc',
  fieldSize: 'Dung lượng',
  fieldUploaded: 'Vào kho ngày',
  fieldExternalLink: '🌐 Link sản phẩm',
  viewProductOnSpigot: 'Xem trên Spigot',

  // Paying from the coin wallet
  walletPaidTitle: 'Đã trừ ví, không cần chuyển khoản',  walletPaidBody: (label: string) => `Ví của bạn đủ để lấy **${label}**. Tệp đang được chuẩn bị.`,
  walletRefunded: 'Không gửi được tệp — đã hoàn coin',
  walletRefundedHint:
    'Số coin đã trừ được trả lại đầy đủ vào ví. Bạn có thể thử lại, hoặc nhắn chủ kho nếu vẫn lỗi.',

  // Topping the wallet up
  topupCredited: (credited: number, balance: number) =>
    `Đã nhận **${credited.toLocaleString('vi-VN')} ₫** vào ví. Số dư hiện tại: **${formatBalance(balance)}**.`,

  // The wallet
  walletTitle: 'Ví của bạn',
  walletBalance: (balance: string) => `Số dư: **${balance}**\n1 coin = 1.000 ₫`,
  walletRecent: 'Gần đây',
  walletEmptyHint: 'Ví chưa có giao dịch nào. Bấm nút bên dưới để nạp.',
  ledgerLine: (delta: number, kind: string, at: number) => {
    const sign = delta >= 0 ? '+' : '−';
    return `\`${sign}${Math.abs(delta).toLocaleString('vi-VN')} ₫\` · ${ledgerKindVi(kind)} · ${shortDate(at)}`;
  },

  topupBankButton: 'Nạp bằng chuyển khoản',
  topupModalTitle: 'Nạp coin vào ví',
  topupAmountLabel: 'Số tiền muốn nạp',
  topupAmountPlaceholder: 'Ví dụ: 50000 hoặc 50.000',
  topupBadAmount: 'Số tiền không hợp lệ',
  topupBadAmountHint: (min: number, max: number) =>
    `Nhập một số trong khoảng ${min.toLocaleString('vi-VN')} ₫ đến ${max.toLocaleString('vi-VN')} ₫. Dấu chấm và phẩy đều được, ví dụ "50.000".`,
  topupFailed: 'Không tạo được phiếu nạp',
  topupFailedHint: 'Thử lại sau một chút. Nếu vẫn lỗi, nhắn chủ kho.',
  topupQrTitle: 'Quét mã để nạp ví',
  topupQrLead: (balance: string) => `Chuyển đúng số tiền bên dưới để nhận **${balance}**.`,
  topupQrFooter: (minutes: number) =>
    `Phải giữ đúng nội dung chuyển khoản, nếu không tiền không vào được ví · hết hạn sau ${minutes} phút`,

  // Card top-ups
  topupCardButton: 'Nạp bằng thẻ cào',
  pickTelco: 'Chọn nhà mạng',
  pickDenomination: 'Chọn mệnh giá',
  coinsFor: (coins: number) => `${coins.toLocaleString('vi-VN')} coin`,
  fieldTelco: 'Thẻ',
  cardModalTitle: (telco: string, amount: number) => `Thẻ ${telco} ${(amount / 1000).toLocaleString('vi-VN')}k`,
  cardSerialLabel: 'Số serial',
  cardCodeLabel: 'Mã thẻ',
  cardSubmitting: 'Đang gửi thẻ…',
  cardSubmittingHint: 'Nhà mạng có thể mất vài chục giây. Bạn không cần làm gì thêm.',
  cardStepHint: 'Chọn nhà mạng của thẻ, rồi chọn mệnh giá in trên thẻ.',
  cardAmountHint: (telco: string) => `Chọn đúng mệnh giá in trên thẻ ${telco}. Khai sai sẽ bị trừ thêm phí.`,

  cardOkTitle: 'Nạp thẻ thành công',
  cardOkBody: (credited: number, balance: number) =>
    `Đã cộng **${credited.toLocaleString('vi-VN')} ₫** vào ví. Số dư: **${formatBalance(balance)}**.`,

  cardWrongTitle: 'Thẻ vào rồi, nhưng khai sai mệnh giá',
  cardWrongBody: (declared: number, actual: number, balance: number) =>
    `Bạn khai ${declared.toLocaleString('vi-VN')} ₫ nhưng thẻ thật là **${actual.toLocaleString('vi-VN')} ₫**. ` +
    `Ví đã được cộng đúng giá trị thật. Số dư: **${formatBalance(balance)}**.\n` +
    'Lần sau chọn đúng mệnh giá nhé — khai sai bị nhà mạng trừ thêm phí.',

  cardFailedTitle: 'Thẻ không dùng được',
  cardFailedBody:
    'Nhà mạng báo thẻ sai hoặc đã được dùng. Kiểm tra lại serial và mã thẻ, rồi thử lại. Ví không bị trừ gì.',

  cardPendingTitle: 'Thẻ đang được xử lý',
  cardPendingBody:
    'Nhà mạng chưa trả kết quả. Bot sẽ tự kiểm tra lại và nhắn cho bạn khi xong, không cần gửi lại thẻ.',

  cardReviewTitle: 'Chưa rõ kết quả thẻ',
  cardReviewBody:
    'Nhà mạng không trả kết quả rõ ràng nên bot không tự cộng ví. Chủ kho sẽ kiểm tra và xử lý. ' +
    'Đừng gửi lại thẻ này — nếu thẻ đã bị trừ, gửi lại cũng không được gì.',

  cardDisabled: 'Nạp thẻ cào đang tắt',
  cardDisabledHint: 'Chủ kho chưa cấu hình card2k. Dùng nạp bằng chuyển khoản, hoặc nhắn chủ kho.',
  cardBadTelco: 'Nhà mạng không hỗ trợ',
  cardBadTelcoHint: 'Chọn lại từ danh sách. Vietnamobile hiện không nạp được.',
  cardBadAmount: 'Mệnh giá không hợp lệ cho nhà mạng này',
  cardBadAmountHint: 'Chọn lại mệnh giá trong danh sách của nhà mạng đó.',
  cardBadSerial: 'Số serial không hợp lệ',
  cardBadSerialHint: 'Serial chỉ gồm chữ và số, từ 6 đến 32 ký tự. Kiểm tra lại rồi thử lại.',
  cardBadCode: 'Mã thẻ không hợp lệ',
  cardBadCodeHint: 'Mã thẻ chỉ gồm chữ và số, từ 6 đến 32 ký tự. Kiểm tra lại rồi thử lại.',
  cardDuplicate: 'Thẻ này đang được xử lý',
  cardDuplicateHint: 'Bot đã nhận thẻ có serial này và đang chờ nhà mạng trả lời. Đợi kết quả, đừng gửi lại.',
  cardCredited: (credited: number, balance: number) =>
    `Thẻ cào đã vào: **+${credited.toLocaleString('vi-VN')} ₫**. Số dư: **${formatBalance(balance)}**.`,

  // The standing panel
  panelPlaced: 'Đã đặt bảng chọn plugin vào kênh này.',
  panelFailed: 'Không đặt được bảng ở kênh này',
  panelFailedHint:
    'Bot thiếu quyền gửi tin nhắn ở đây. Vào Cài đặt kênh → Quyền, cấp "Send Messages" cho bot, rồi chạy lại `/panel`.',
  panelHeading: 'Kho plugin',
  panelBody: 'Bấm nút bên dưới để xem danh sách và tải. Tệp được gửi vào tin nhắn riêng của bạn.',
  panelButton: 'Mở kho plugin',
  panelFooter: (count: number) =>
    count === 0 ? 'Kho chưa có plugin nào' : `${count} plugin · chỉ thành viên có role admin dùng được`,

  // Delivery
  sending: 'Đang chuẩn bị tệp…',
  sentTitle: 'Đã gửi vào tin nhắn riêng',
  sentBody: (plugin: string, version: string | null) =>
    version === null ? `**${plugin}** đang trên đường tới hộp thư của bạn.` : `**${plugin}** \`${version}\` đang trên đường tới hộp thư của bạn.`,
  dmBlocked: 'Không gửi được tin nhắn riêng',
  dmBlockedHint:
    'Discord đang chặn tin nhắn từ bot. Bấm chuột phải vào tên server → Quyền riêng tư → bật "Direct Messages", rồi chọn lại.',
  deliveryFailed: 'Không gửi được tệp',
  deliveryFailedHint: 'Lỗi phía bot, không phải do bạn. Thử lại sau ít phút; nếu vẫn vậy hãy nhắn chủ server.',
  staleMenu: 'Menu này đã cũ',
  staleMenuHint: 'Plugin hoặc phiên bản đã thay đổi từ lúc menu mở ra. Chạy lại `/menu` để xem danh sách mới.',

  // Payment
  payTitle: 'Cần tạm ứng trước khi tải',
  payLead: (what: string) => `Bạn đang tải **${what}**.`,
  payFooter: (minutes: number) =>
    `Quét QR hoặc chuyển đúng nội dung ở trên · Hết hạn sau ${minutes} phút · Tệp tự gửi sau khi nhận được tiền`,
  payTimeout: 'Đơn đã hết hạn',
  payTimeoutHint: 'Chọn lại phiên bản để lấy mã mới. Nếu bạn đã chuyển tiền, hãy nhắn chủ server để được giao tay.',

  // Errors
  unknownAction: 'Không hiểu yêu cầu này',
  unknownActionHint: 'Nút này có thể thuộc một bản bot cũ. Chạy lại `/menu`.',
  unknownCommand: 'Bot đang chạy bản cũ chưa có lệnh này',
  unknownCommandHint: 'Trên máy chủ: `git pull && npm run build`, rồi khởi động lại bot.',

  versionLabel: (version: string | null, date: string) => `${version ?? 'không rõ'} · ${date}`,
};

/** Formats a Vietnamese short date from unix seconds. */
export function shortDate(unixSeconds: number): string {  return new Date(unixSeconds * 1000).toLocaleDateString('vi-VN', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
  });
}

export function formatVnd(amount: number): string {
  return `${amount.toLocaleString('vi-VN')} ₫`;
}

/**
 * Why a balance moved, in words.
 *
 * Falls back to the raw key rather than a generic "khác": an unlabelled kind is a
 * gap in this map, and showing it is how the gap gets noticed.
 */
export function ledgerKindVi(kind: string): string {
  const labels: Record<string, string> = {
    card_topup: 'nạp thẻ cào',
    bank_topup: 'nạp chuyển khoản',
    order_hold: 'mua plugin',
    order_refund: 'hoàn đơn',
    overpay: 'chuyển thừa',
    manual: 'chủ kho chỉnh',
  };
  return labels[kind] ?? kind;
}

/**
 * Human file size.
 *
 * One decimal for MB and above, none below: "3.4 MB" is useful, "3.42 MB" is
 * noise, and "0.0 KB" for a small file is worse than "812 B".
 */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
