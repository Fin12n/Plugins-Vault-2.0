/**
 * Worker tải: chạy đúng đường tải của bot, nhưng KHÔNG cần Discord.
 *
 * Có mặt vì đo được rằng đường tải chỉ chạy ở nơi Chrome vượt được Cloudflare, và nơi đó
 * không nhất thiết là nơi chạy bot. Tách worker ra cho phép đặt việc tải ở máy nào tải
 * được, và cũng là hình dạng cần thiết để đóng gói riêng phần tải.
 *
 * Dùng CHÍNH `startMaintenance` của production chứ không dựng lại một đường tải riêng:
 * một bản mô phỏng sẽ trôi khỏi bản thật đúng vào lúc cần tin nó nhất. `client` là tuỳ
 * chọn trong `MaintenanceDeps`, nên bỏ Discord ra không phải là mẹo gì — nó vốn được thiết
 * kế để thiếu được.
 *
 * Chạy tới khi hàng chờ cạn hoặc không giảm nữa. "Không giảm nữa" là điều kiện dừng thật:
 * một hàng chờ còn 5 bản mà ba lượt quét liền không tải được bản nào thì lượt thứ tư cũng
 * vậy, và tiếp tục chỉ để gõ vào Spigot cho tới khi bị chặn.
 *
 * Dùng: npm run download-worker            (chạy tới khi cạn)
 *       npm run download-worker -- --once  (đúng một lượt, để thử nghiệm)
 *       npm run download-worker -- --scan  (bắt quét lại danh sách đã mua trước khi tải)
 */
import { mkdirSync } from 'node:fs';
import { config } from '../src/config/index.js';
import { initDb } from '../src/db/connection.js';
import { migrate } from '../src/db/migrate.js';
import { startMaintenance } from '../src/services/maintenance/scheduler.js';

/** Bao nhiêu lượt liền không tải được gì thì dừng. */
const STALL_LIMIT = 3;

const env = config();
const once = process.argv.includes('--once');
/**
 * Bắt quét lại danh sách "đã mua" của mọi tài khoản, bỏ qua giới hạn một lần/ngày.
 *
 * Cần cho lượt chạy ĐẦU trên một máy mới: chưa quét thì bot không biết tài khoản nào sở
 * hữu resource nào, và một lượt tải không biết chủ sẽ thử sai tài khoản cho từng bản.
 */
const forceScan = process.argv.includes('--scan');

// 0o750 như bản thật: jar trong kho và bảng token/audit không được để cả máy đọc.
mkdirSync(env.VAULT_DIR, { recursive: true, mode: 0o750 });
mkdirSync(env.TMP_DIR, { recursive: true, mode: 0o750 });

const db = initDb(env.DB_PATH);
migrate(db);

/** Số bản còn nợ trong hàng chờ. */
const pending = (): number =>
  (db.prepare('select count(*) c from pending_download').get() as { c: number }).c;
/** Số bản đã nằm trong kho, để biết lượt quét vừa rồi thêm được gì. */
const archived = (): number => (db.prepare('select count(*) c from versions').get() as { c: number }).c;

const shutdown = new AbortController();
let stopping = false;
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    if (stopping) return;
    stopping = true;
    console.log(`\nNhận ${signal} — dừng sau khi lượt đang chạy kết thúc.`);
    shutdown.abort();
  });
}

const maintenance = startMaintenance({ db, env, vaultDir: env.VAULT_DIR, signal: shutdown.signal });

async function main(): Promise<void> {
  console.log(`Kho: ${archived()} bản đã có, hàng chờ: ${pending()} bản.`);

  let stalled = 0;
  for (let round = 1; !shutdown.signal.aborted; round++) {
    const before = { pending: pending(), archived: archived() };
    if (before.pending === 0 && (!forceScan || round > 1)) {
      console.log('\nHàng chờ đã cạn.');
      break;
    }

    console.log(`\n===== Lượt ${round}: còn ${before.pending} bản trong hàng chờ =====`);
    const startedAt = Date.now();
    // Chỉ bắt quét lại ở lượt ĐẦU: quét lại mỗi lượt là 45 giây mỗi tài khoản cho một
    // danh sách chỉ đổi khi chủ bot mua thêm.
    await maintenance.runUpdateCheck(forceScan && round === 1 ? { forcePurchasedScan: true } : {});
    const took = ((Date.now() - startedAt) / 1000).toFixed(0);

    const after = { pending: pending(), archived: archived() };
    const gained = after.archived - before.archived;
    console.log(
      `----- Lượt ${round} xong sau ${took}s: +${gained} bản vào kho, ` +
        `hàng chờ ${before.pending} → ${after.pending} -----`,
    );

    if (once) break;

    // Đếm "không tải được gì" theo SỐ BẢN VÀO KHO, không theo hàng chờ: một bản bị bỏ vì
    // không còn tồn tại cũng làm hàng chờ ngắn đi mà không thêm gì vào kho.
    stalled = gained > 0 ? 0 : stalled + 1;
    if (stalled >= STALL_LIMIT) {
      console.log(`\nDừng: ${STALL_LIMIT} lượt liền không tải được bản nào. Xem log phía trên để biết lý do.`);
      break;
    }
  }

  console.log(`\nKết thúc — kho: ${archived()} bản, hàng chờ còn: ${pending()} bản.`);
}

main()
  .catch((err: unknown) => {
    console.error('Worker lỗi:', err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
  })
  .finally(async () => {
    await maintenance.stop();
    db.close();
  });
