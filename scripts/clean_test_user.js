import Database from 'better-sqlite3';

const db = new Database('data/vault.db');
const targetUserIds = [
  '1122334455667788990', // Người dùng Discord #8990
  '2233445566778899001', // Người dùng Discord #9001
];

const tables = [
  'wallet_ledger',
  'wallets',
  'orders',
  'wallet_topups',
  'card_topups',
  'download_tokens',
  'audit_log',
];

const deleteTx = db.transaction(() => {
  for (const userId of targetUserIds) {
    console.log(`\n--- Xoá dữ liệu cho User ID: ${userId} ---`);
    for (const table of tables) {
      try {
        const info = db.prepare(`DELETE FROM ${table} WHERE discord_user_id = ?`).run(userId);
        if (info.changes > 0) {
          console.log(`✓ Đã xoá ${info.changes} dòng từ bảng ${table}`);
        }
      } catch (e) {
        console.log(`Lỗi bảng ${table}: ${e.message}`);
      }
    }
  }
});

deleteTx();
console.log('\nHoàn tất xoá toàn bộ dữ liệu test cho các user đã chọn.');
