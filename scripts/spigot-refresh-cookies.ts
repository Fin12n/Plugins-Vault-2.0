import { config } from '../src/config/index.js';
import { loadSpigotAccounts, needsRefresh } from '../src/services/upstream/spigot-account-store.js';
import { loadSpigotCredentials } from '../src/services/upstream/spigot-credential-store.js';

/**
 * Names the accounts whose stored cookie is old enough to re-mint.
 *
 * Exists because XenForo caps the `xf_user` remember token at **30 days** and
 * that ceiling is not configurable. Nothing warns before it lapses: the system
 * works for a month and then every download starts failing at once, which is the
 * failure mode nobody plans for.
 *
 * Refreshing at day 20 leaves ten days of margin. It is deliberately a SELECTOR
 * rather than a re-login loop — `npm run spigot-login` already does the login
 * properly (fresh browser per account, incremental save, spaced attempts), and a
 * second implementation of that would drift from the first.
 *
 * Prints the exact command to run. Logging in is the one step that can lock an
 * account — XenForo locks after four failures in fifteen minutes, and the only
 * escape is a password reset that invalidates every remember token — so it stays
 * a deliberate action, not something a cron job fires unattended.
 *
 * Usage:
 *   npm run spigot-refresh              # list accounts due
 *   npm run spigot-refresh -- --days 25 # use a different threshold
 */
const DEFAULT_MAX_AGE_DAYS = 20;

function parseDays(argv: string[]): number {
  const at = argv.indexOf('--days');
  if (at < 0) return DEFAULT_MAX_AGE_DAYS;
  const value = Number(argv[at + 1]);
  return Number.isInteger(value) && value > 0 && value < 30 ? value : DEFAULT_MAX_AGE_DAYS;
}

/** Days since a cookie was minted, or null when the file predates the field. */
function ageInDays(issuedAt: string | null): number | null {
  if (issuedAt === null) return null;
  const parsed = Date.parse(issuedAt);
  if (Number.isNaN(parsed)) return null;
  return Math.floor((Date.now() - parsed) / (24 * 60 * 60 * 1000));
}

function main(): void {
  const env = config();
  const maxAgeDays = parseDays(process.argv);

  const load = loadSpigotAccounts(env.SPIGOT_ACCOUNTS_FILE);
  if (!load.ok) {
    if (load.reason === 'missing') {
      // Not an error: the bot logs in from the credentials file every sweep, so a
      // cookie file is optional. Say which mode is in play rather than failing.
      const credentials = loadSpigotCredentials(env.SPIGOT_CREDENTIALS_FILE);
      console.log(
        credentials.ok
          ? `Chưa có tệp cookie (${env.SPIGOT_ACCOUNTS_FILE}).\n` +
              'Bot đang đăng nhập bằng mật khẩu mỗi lượt quét, nên chưa cần làm mới cookie.\n' +
              'Chạy `npm run spigot-login` nếu muốn chuyển sang dùng cookie.'
          : `Chưa có tệp cookie lẫn tệp mật khẩu — tính năng tự động tải đang tắt.`,
      );
      return;
    }
    console.error(`Tệp cookie không đọc được: ${load.detail}`);
    process.exit(1);
  }

  const due = load.accounts.filter((a) => needsRefresh(a, maxAgeDays));

  console.log(`${load.accounts.length} tài khoản trong ${env.SPIGOT_ACCOUNTS_FILE}:\n`);
  for (const account of load.accounts) {
    const age = ageInDays(account.issuedAt);
    const ageText = age === null ? 'chưa rõ tuổi' : `${age} ngày`;
    const mark = due.includes(account) ? '⚠️ ' : '   ';
    console.log(`  ${mark}${account.label.padEnd(16)} ${ageText.padEnd(14)} trạng thái: ${account.status}`);
  }

  if (due.length === 0) {
    console.log(`\nKhông tài khoản nào quá ${maxAgeDays} ngày. Chưa cần làm gì.`);
    return;
  }

  console.log(`\n${due.length} tài khoản cần đăng nhập lại (cookie hết hạn sau 30 ngày):`);
  for (const account of due) console.log(`  npm run spigot-login -- ${account.label}`);
  console.log('\nHoặc làm tất cả một lượt: npm run spigot-login');
}

try {
  main();
} catch (err) {
  console.error('Kiểm tra cookie thất bại:', err instanceof Error ? err.message : err);
  process.exit(1);
}
