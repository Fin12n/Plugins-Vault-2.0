import { existsSync, readdirSync, rmSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { config } from '../src/config/index.js';
import { openDb } from '../src/db/connection.js';
import { migrate } from '../src/db/migrate.js';

async function resetAllData() {
  console.log('🔄 [Reset] Đang chuẩn bị dọn dẹp sạch toàn bộ Database và dữ liệu cũ...');
  const env = config();

  // 1. Danh sách tệp database SQLite cần xoá
  const dbFiles = [
    env.DB_PATH,
    `${env.DB_PATH}-wal`,
    `${env.DB_PATH}-shm`,
  ];

  for (const file of dbFiles) {
    if (existsSync(file)) {
      try {
        unlinkSync(file);
        console.log(`  - Đã xoá tệp database: ${file}`);
      } catch (err) {
        console.warn(`  - Không thể xoá ${file}:`, err instanceof Error ? err.message : String(err));
      }
    }
  }

  // 2. Dọn sạch thư mục lưu trữ plugins (STORAGE_URL)
  if (existsSync(env.STORAGE_URL)) {
    try {
      rmSync(env.STORAGE_URL, { recursive: true, force: true });
      console.log(`  - Đã làm sạch thư mục STORAGE_URL: ${env.STORAGE_URL}`);
    } catch (err) {
      console.warn(`  - Không thể xoá STORAGE_URL:`, err instanceof Error ? err.message : String(err));
    }
  }

  // 3. Dọn sạch thư mục Vault
  if (existsSync(env.VAULT_DIR)) {
    try {
      rmSync(env.VAULT_DIR, { recursive: true, force: true });
      console.log(`  - Đã làm sạch thư mục Vault: ${env.VAULT_DIR}`);
    } catch (err) {
      console.warn(`  - Không thể xoá VAULT_DIR:`, err instanceof Error ? err.message : String(err));
    }
  }

  // 4. Dọn sạch thư mục Tạm và Profile Trình duyệt
  const tempDirs = [
    env.TMP_DIR,
    join(process.cwd(), 'data', 'chrome-profile'),
  ];

  for (const dir of tempDirs) {
    if (existsSync(dir)) {
      try {
        rmSync(dir, { recursive: true, force: true });
        console.log(`  - Đã làm sạch thư mục tạm: ${dir}`);
      } catch (err) {
        console.warn(`  - Không thể xoá ${dir}:`, err instanceof Error ? err.message : String(err));
      }
    }
  }

  // 5. Khởi tạo lại Database SQLite mới tinh từ Migrations
  console.log('🛠️ [Reset] Đang khởi tạo lại CSDL SQLite và áp dụng toàn bộ Migrations mới...');
  const newDb = openDb(env.DB_PATH);
  try {
    const outcome = migrate(newDb);
    console.log(`  - Đã áp dụng ${outcome.applied.length} bản migrations (từ v${outcome.from} lên v${outcome.to}).`);
  } finally {
    newDb.close();
  }

  console.log('✅ [Reset] HOÀN TẤT! Hệ thống đã được làm sạch 100%, sẵn sàng cho phiên thử nghiệm mới tinh!');
}

resetAllData().catch((err) => {
  console.error('❌ Lỗi khi reset dữ liệu:', err);
  process.exit(1);
});
