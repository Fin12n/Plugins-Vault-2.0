/**
 * Chỉ chạy dashboard + API, KHÔNG Discord và KHÔNG lượt quét nền.
 *
 * Có mặt để xem lại giao diện mà không kéo theo hai tác dụng phụ hướng ra ngoài của
 * `npm start`: bot hiện online trên Discord, và lượt quét bảo trì bắt đầu gõ vào Spigot
 * sau 30 giây. Khi chỉ cần kiểm mắt thì cả hai đều là thứ không ai xin.
 *
 * `delivery`, `maintenance` và `challengeSessions` vốn đã là tuỳ chọn trong `ServerDeps`,
 * nên bỏ chúng ra không phải mẹo gì — đổi lại, những chỗ cần chúng sẽ không hoạt động:
 *   · nút "Kiểm tra cập nhật ngay" trả về false (không có scheduler để gọi)
 *   · mục xác minh Cloudflare trên browser VPS không có phiên nào để hiện
 *   · webhook SePay và nút giao hàng thủ công không được mount (không có client Discord)
 * Mọi phần đọc dữ liệu — plugin, phiên bản, ví, đơn, log, thống kê — đều đọc từ đúng
 * `data/vault.db` thật nên số liệu là số liệu thật.
 *
 * Dùng: npm run dashboard-only
 */
import { config } from '../src/config/index.js';
import { initDb } from '../src/db/connection.js';
import { migrate } from '../src/db/migrate.js';
import { buildServer } from '../src/http/server.js';

const env = config();
const db = initDb(env.DB_PATH);
migrate(db);

const app = await buildServer({ db, env });

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    void app.close().then(() => {
      db.close();
      process.exit(0);
    });
  });
}

await app.listen({ port: env.PORT, host: '0.0.0.0' });
console.log(`Dashboard đang chạy: http://127.0.0.1:${env.PORT}`);
console.log('Chế độ chỉ-xem: không có Discord, không có lượt quét nền.');
