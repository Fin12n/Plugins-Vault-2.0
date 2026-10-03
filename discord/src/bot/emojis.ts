/**
 * TỪ ĐIỂN CẤU HÌNH EMOJIS TẬP TRUNG (CUSTOM & DEFAULT)
 *
 * Hướng dẫn thay thế bằng Custom Emoji:
 * - Để dùng emoji mặc định: Giữ nguyên ký tự unicode (hoặc ký tự mong muốn).
 * - Để dùng Discord Custom Emoji: Điền chuỗi dạng `<:tên_emoji:id_emoji>` hoặc `<a:tên_emoji:id_emoji>` (cho animated emoji).
 *   Ví dụ:
 *     store: '<:ez_store:123456789012345678>',
 *     premium: '<a:gold_crown:123456789012345678>',
 * - Để TẮT / BỎ emoji: Chỉ cần để chuỗi rỗng `''`.
 */

export interface VaultEmojiConfig {
  // Điều hướng trang kệ hàng (Pagination Buttons)
  navFirst: string;
  navPrev: string;
  navNext: string;
  navLast: string;

  // Trạng thái thông báo (Status / Alerts)
  success: string;
  error: string;
  info: string;
  warning: string;
  celebrate: string;

  // Kho hàng & Quản lý Plugin
  store: string;
  plugin: string;
  version: string;
  date: string;
  download: string;
  search: string;
  lightbulb: string;
  panel: string;
  externalLink: string;

  // Phân loại Plugin
  premium: string;
  free: string;

  // Thanh toán & Ví tiền (Billing & Wallet)
  price: string;
  wallet: string;
  invoice: string;
  pin: string;
  history: string;
  qr: string;
  point: string;
}

export const CUSTOM_EMOJIS: VaultEmojiConfig = {
  // Điều hướng kệ hàng: Đã bỏ hoàn toàn các custom chevron không tương thích
  navFirst: '',        // Nút trang đầu (để rỗng hoặc thêm Custom Emoji)
  navPrev: '',         // Nút trang trước (đã bỏ chevronleft)
  navNext: '',         // Nút trang sau (đã bỏ chevronright)
  navLast: '',         // Nút trang cuối

  // Trạng thái thông báo
  success: '✅',
  error: '❌',
  info: 'ℹ️',
  warning: '⚠️',
  celebrate: '🎉',

  // Kho hàng & Plugin
  store: '🏪',
  plugin: '📦',
  version: '🏷️',
  date: '📅',
  download: '🔗',
  search: '🔍',
  lightbulb: '💡',
  panel: '🎛️',
  externalLink: '🌐',

  // Phân loại Plugin
  premium: '👑',
  free: '🛡️',

  // Thanh toán & Ví tiền
  price: '💰',
  wallet: '💳',
  invoice: '🧾',
  pin: '📌',
  history: '📜',
  qr: '📲',
  point: '👉',
};

/**
 * Trả về emoji kèm khoảng trắng phía sau nếu emoji tồn tại, hoặc chuỗi rỗng nếu không cấu hình emoji.
 */
export function getEmoji(key: keyof VaultEmojiConfig): string {
  const val = CUSTOM_EMOJIS[key];
  if (!val || val.trim() === '') return '';
  return `${val.trim()} `;
}

/**
 * Lấy trực tiếp emoji chuỗi thô (dùng cho button .setEmoji hoặc menu placeholder).
 */
export function rawEmoji(key: keyof VaultEmojiConfig): string | undefined {
  const val = CUSTOM_EMOJIS[key];
  if (!val || val.trim() === '') return undefined;
  return val.trim();
}
