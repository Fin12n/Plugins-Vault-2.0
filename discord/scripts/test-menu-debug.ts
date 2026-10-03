import { config } from '../src/config/index.js';
import { initDb } from '../src/db/connection.js';
import { buildShelfPayload } from '../src/bot/commands/shelf-commands.js';

async function test() {
  console.log('--- TEST BẮT ĐẦU ---');
  const env = config();
  console.log('Env loaded, DB_PATH:', env.DB_PATH, 'VAULT_DIR:', env.VAULT_DIR);
  const db = initDb(env.DB_PATH);
  console.log('Database initialized.');

  const botDeps: any = {
    db,
    env,
  };

  console.log('Đang gọi buildShelfPayload(botDeps, 0)...');
  const res = await buildShelfPayload(botDeps, 0);
  console.log('Thành công! Files:', res.files.length, 'Embeds:', res.embeds.length, 'Components:', res.components.length);
}

test().catch((err) => {
  console.error('LỖI BẮT ĐƯỢC TẠI TEST:', err);
});
