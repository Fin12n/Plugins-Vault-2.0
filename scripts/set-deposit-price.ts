import { config } from '../src/config/index.js';
import { openDb } from '../src/db/connection.js';
import { countPlugins, listPlugins, updatePlugin } from '../src/repositories/plugins.js';

/**
 * Sets the deposit price on plugins from the command line.
 *
 * Exists because the price lives in the database, not in .env: it is a per-plugin
 * runtime setting editable from the dashboard. Reaching for a shell one-liner
 * instead means hand-writing SQL against a STRICT schema on a live vault, so this
 * goes through the same repository the dashboard uses and prints what changed.
 *
 * Until a plugin carries a price above zero the bot delivers it immediately and
 * never opens an order — so no QR appears and the SePay webhook has nothing to
 * match, which reads as "payments are broken" when nothing is broken at all.
 *
 * Usage:
 *   npm run set-price -- 1000              # every plugin
 *   npm run set-price -- 1000 vulcan       # only plugins matching a name/slug
 */
async function main(): Promise<void> {
  const env = config();
  const amount = Number(process.argv[2]);
  const search = process.argv[3];

  if (!Number.isInteger(amount) || amount < 0) {
    console.error('Thiếu số tiền. Dùng: npm run set-price -- 1000 [tên plugin]');
    process.exit(1);
  }

  const db = openDb(env.DB_PATH);
  try {
    const total = countPlugins(db, search);
    if (total === 0) {
      console.error(search ? `Không có plugin nào khớp "${search}".` : 'Kho chưa có plugin nào.');
      process.exit(1);
    }

    const plugins = listPlugins(db, total, 0, search);
    for (const plugin of plugins) {
      updatePlugin(db, plugin.id, { depositPrice: amount });
      console.log(`${plugin.displayName}: ${plugin.depositPrice} → ${amount} ₫`);
    }
    console.log(`\nĐã đặt giá tạm ứng ${amount.toLocaleString('vi-VN')} ₫ cho ${plugins.length} plugin.`);
  } finally {
    db.close();
  }
}

main().catch((err: unknown) => {
  console.error('Đặt giá thất bại:', err instanceof Error ? err.message : err);
  process.exit(1);
});
