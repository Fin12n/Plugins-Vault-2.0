import { config } from '../src/config/index.js';
import { openDb } from '../src/db/connection.js';
import { forgetScanState, listScanStates } from '../src/repositories/account-scan-state.js';

/**
 * Clears the "already scanned today" marks so the next sweep re-reads every
 * account's purchased list.
 *
 * Exists because the throttle that makes many accounts practical — one scan per
 * account per day — also means a fixed credential is not retried until tomorrow.
 * After correcting a password or installing the browser, the owner otherwise has
 * no way to see the result without waiting out the interval.
 *
 * Only the schedule is reset. Nothing about plugins, versions, or the vault is
 * touched, so this is safe to run at any time.
 *
 * Usage:
 *   npm run rescan-purchased            # every account
 *   npm run rescan-purchased -- acc-2   # one account
 */
async function main(): Promise<void> {
  const env = config();
  const label = process.argv[2];

  const db = openDb(env.DB_PATH);
  try {
    const states = listScanStates(db);
    if (states.length === 0) {
      console.log('Chưa có tài khoản nào từng được quét — lượt quét tới sẽ tự đọc tất cả.');
      return;
    }

    const targets = label ? states.filter((s) => s.accountLabel === label) : states;
    if (targets.length === 0) {
      console.error(
        `Không có tài khoản nào tên "${label}". Đang có: ${states.map((s) => s.accountLabel).join(', ')}`,
      );
      process.exit(1);
    }

    for (const state of targets) {
      forgetScanState(db, state.accountLabel);
      const note = state.lastError === '' ? `${state.resourceCount} plugin` : `lỗi: ${state.lastError}`;
      console.log(`${state.accountLabel}: đặt lại lịch quét (lần trước ${note})`);
    }
    console.log(`\nXong. Khởi động lại bot để quét ngay, hoặc chờ lượt quét kế tiếp.`);
  } finally {
    db.close();
  }
}

main().catch((err: unknown) => {
  console.error('Đặt lại lịch quét thất bại:', err instanceof Error ? err.message : err);
  process.exit(1);
});
