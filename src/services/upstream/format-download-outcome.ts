import type { AutoDownloadOutcome, SweepResult } from './auto-download-versions.js';
import type { UpdateFinding } from './check-plugin-updates.js';
import { formatUpdateNotice } from './check-plugin-updates.js';

/**
 * Owner-facing text for auto-download results.
 *
 * Deliberately not in check-plugin-updates: that module's contract is
 * notification only, never automated acquisition. Putting acquisition wording
 * there would weld detection to download.
 */

/**
 * One line per outcome.
 *
 * Every status is mapped explicitly. A fallthrough would mean the interesting
 * cases — parked, not owned, retrying — reach the owner as silence, which reads
 * as "everything is fine".
 */
export function formatDownloadOutcome(outcome: AutoDownloadOutcome): string {
  const label = `**${outcome.pluginName}** \`${outcome.versionName}\``;
  const via = outcome.accountLabel ? ` (tài khoản ${outcome.accountLabel})` : '';

  switch (outcome.status) {
    case 'archived':
      return `✅ ${label} — đã tải và lưu vào kho${via}`;

    case 'duplicate':
      // Not a failure: the vault already holds these exact bytes.
      return `➖ ${label} — đã có trong kho, bỏ qua`;

    case 'parked':
      return (
        `⚠️ ${label} — tải được nhưng không đọc được thông tin plugin, ` +
        `đã đưa vào tab **Chờ xử lý** để bạn gán tay. Lý do: ${outcome.detail}`
      );

    case 'not_owned':
      return `🛒 ${label} — không tài khoản nào đã mua plugin này, hãy tải thủ công`;

    case 'cookie_dead':
      return (
        `🔑 ${label} — cookie đã hết hiệu lực ${outcome.detail}. ` +
        `Đăng nhập lại Spigot (nhớ tick "Stay logged in") rồi cập nhật cookie. ` +
        `Đã tạm dừng tải tự động lần này; bản này sẽ thử lại sau.`
      );

    case 'challenged':
      return (
        `🛑 ${label} — Spigot đang chặn truy cập tự động (${outcome.detail}). ` +
        `Đã dừng lượt quét để tránh bị khoá tài khoản; sẽ thử lại sau.`
      );

    case 'retrying':
      return `🔄 ${label} — tải lỗi, sẽ thử lại: ${outcome.detail}`;

    case 'failed':
      return `❌ ${label} — ${outcome.detail}`;
  }
}

/**
 * Notice for a finding the bot did not try to download.
 *
 * Falls back to the manual "go fetch this" wording, which is exactly right when
 * auto-download is off, has no accounts, or was cut short by the per-sweep cap.
 */
export function formatSkippedFinding(finding: UpdateFinding, reason: string): string {
  return `${formatUpdateNotice(finding)}\n_(${reason})_`;
}

/** Explains an early stop so a partial sweep is never read as a complete one. */
export function formatAbortReason(result: SweepResult): string | null {
  if (!result.aborted) return null;
  switch (result.abortReason) {
    case 'disabled':
      return 'Tải tự động đang tắt — bật ở tab Cấu hình nếu muốn.';
    case 'no-accounts':
      return 'Chưa cấu hình tài khoản Spigot nào, nên không tải tự động.';
    case 'shutdown':
      return 'Tiến trình đang dừng hoặc đã nhận lệnh dừng khẩn cấp lượt quét.';
    case 'cookie_dead':
    case 'challenged':
      // Already explained by the per-outcome line; repeating it would be noise.
      return null;
    default:
      return `Lượt quét dừng sớm: ${result.abortReason ?? 'nhận tín hiệu dừng hoặc tắt tiến trình'}`;
  }
}
