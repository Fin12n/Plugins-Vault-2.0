import { config } from '../src/config/index.js';
import { openDb } from '../src/db/connection.js';

/**
 * Clears the learned state of the Spigot download pipeline, so the next sweep
 * relearns everything from scratch.
 *
 * Exists because several defects wrote WRONG facts that the system then trusted
 * forever. The worst: a login failure was reported as "this account does not own
 * the plugin", which recorded a permanent ownership row and deleted the download
 * queue entry. Those rows are indistinguishable from genuine knowledge, so no
 * amount of code fixing removes them — they have to be dropped.
 *
 * Deliberately NOT destructive to anything the owner cannot recreate:
 *
 *   dropped  — resource_ownership (who owns what), pending_download (the queue),
 *              upstream_state (last-seen version), account_scan_state (scan
 *              schedule)
 *   kept     — plugins, versions, the vault jars, orders, audit log, settings
 *
 * The archive is untouched. What is dropped is only the bot's own bookkeeping.
 *
 * Usage:
 *   npm run reset-spigot-state              # show what would be dropped
 *   npm run reset-spigot-state -- --yes     # actually drop it
 */
type TableCount = { table: string; rows: number; describe: string };

const TABLES: { name: string; describe: string }[] = [
  { name: 'resource_ownership', describe: 'ghi nhận tài khoản nào sở hữu plugin nào' },
  { name: 'pending_download', describe: 'hàng chờ tải' },
  { name: 'upstream_state', describe: 'phiên bản mới nhất đã thấy trên Spigot' },
  { name: 'account_scan_state', describe: 'lịch quét danh sách đã mua' },
];

function main(): void {
  const env = config();
  const confirmed = process.argv.includes('--yes');

  const db = openDb(env.DB_PATH);
  try {
    const counts: TableCount[] = TABLES.map((t) => {
      const row = db.prepare(`SELECT count(*) AS c FROM ${t.name}`).get() as { c: number };
      return { table: t.name, rows: row.c, describe: t.describe };
    });

    const total = counts.reduce((sum, c) => sum + c.rows, 0);

    console.log('Sẽ xoá:');
    for (const c of counts) console.log(`  ${c.table.padEnd(20)} ${String(c.rows).padStart(6)} dòng  — ${c.describe}`);

    // Named explicitly so the owner can see the archive is not at risk.
    const plugins = (db.prepare('SELECT count(*) AS c FROM plugins').get() as { c: number }).c;
    const versions = (db.prepare('SELECT count(*) AS c FROM versions').get() as { c: number }).c;
    console.log(`\nGiữ nguyên: ${plugins} plugin, ${versions} bản jar trong kho, đơn hàng, cấu hình.`);

    if (total === 0) {
      console.log('\nKhông có gì để xoá.');
      return;
    }

    if (!confirmed) {
      console.log('\nĐây chỉ là xem trước. Chạy lại kèm --yes để xoá thật:');
      console.log('  npm run reset-spigot-state -- --yes');
      return;
    }

    // One transaction: a half-cleared state would be worse than either end of it.
    const clear = db.transaction(() => {
      for (const t of TABLES) db.prepare(`DELETE FROM ${t.name}`).run();
    });
    clear();

    console.log(`\nĐã xoá ${total} dòng. Lượt quét tới sẽ học lại từ đầu:`);
    console.log('  1. quét danh sách đã mua của TỪNG tài khoản');
    console.log('  2. ghi lại tài khoản nào sở hữu plugin nào');
    console.log('  3. tải bằng đúng tài khoản sở hữu');
    console.log('\nKhởi động lại bot để bắt đầu ngay.');
  } finally {
    db.close();
  }
}

try {
  main();
} catch (err) {
  console.error('Xoá thất bại:', err instanceof Error ? err.message : err);
  process.exit(1);
}
