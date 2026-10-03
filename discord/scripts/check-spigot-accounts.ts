import { config } from '../src/config/index.js';
import {
  checkCredentialsFilePermissions,
  loadSpigotCredentials,
} from '../src/services/upstream/spigot-credential-store.js';

/**
 * Shows what the bot actually parsed out of the Spigot accounts file.
 *
 * Exists because the file is whitespace-separated and hand-edited, so a subtle
 * mistake — two columns where three were meant, a pasted smart quote, a trailing
 * space — moves a value into the wrong field while still parsing cleanly. The bot
 * then reports "Incorrect password", which is true of what it sent and useless for
 * finding the typo.
 *
 * Passwords are never printed. A length plus first and last character is enough to
 * spot a truncation or a stray quote without putting the secret on screen or into
 * a scrollback buffer.
 *
 * Usage: npm run check-accounts
 */
function shape(secret: string): string {
  if (secret.length === 0) return 'RỖNG';
  if (secret.length <= 2) return `${secret.length} ký tự — quá ngắn, gần như chắc chắn sai`;
  return `${secret.length} ký tự, bắt đầu "${secret[0]}", kết thúc "${secret[secret.length - 1]}"`;
}

/** Patterns that almost always mean a copy-paste went wrong. */
function suspicious(value: string): string[] {
  const notes: string[] = [];
  if (/^["']|["']$/.test(value)) notes.push('có dấu nháy ở đầu/cuối — bỏ dấu nháy đi');
  if (/[‘’“”]/.test(value)) notes.push('có dấu nháy cong (copy từ Word/chat) — hãy gõ lại bằng tay');
  if (value !== value.trim()) notes.push('có khoảng trắng ở đầu/cuối');
  return notes;
}

function main(): void {
  const env = config();
  const path = env.SPIGOT_CREDENTIALS_FILE;
  const load = loadSpigotCredentials(path);

  if (!load.ok) {
    if (load.reason === 'missing') {
      console.error(`Không có tệp ${path} — tính năng tự động tải đang tắt.`);
    } else {
      console.error(`Tệp ${path} không đọc được: ${load.detail}`);
    }
    process.exit(1);
  }

  const warning = checkCredentialsFilePermissions(path);
  if (warning) console.warn(`⚠️  ${warning}\n`);

  console.log(`Đọc được ${load.credentials.length} tài khoản từ ${path}:\n`);

  let problems = 0;
  for (const credential of load.credentials) {
    console.log(`  ${credential.label}`);
    console.log(`    tên đăng nhập : "${credential.username}"`);
    console.log(`    mật khẩu      : ${shape(credential.password)}`);

    for (const note of suspicious(credential.username)) {
      console.log(`    ⚠️  tên đăng nhập ${note}`);
      problems++;
    }
    for (const note of suspicious(credential.password)) {
      console.log(`    ⚠️  mật khẩu ${note}`);
      problems++;
    }
    // The two-column form defaults the label to the username. Harmless in itself,
    // but worth naming: an owner who meant three columns has silently lost a field,
    // which is how a label ends up being used as the username.
    if (credential.label === credential.username) {
      console.log('    (dòng chỉ có 2 cột — tên gợi nhớ lấy theo tên đăng nhập)');
    }
    console.log('');
  }

  if (problems > 0) {
    console.log(`Có ${problems} điểm đáng ngờ ở trên. Sửa rồi chạy lại lệnh này.`);
    process.exit(1);
  }

  console.log('Định dạng tệp không có vấn đề gì.');
  console.log('Hãy đối chiếu tên đăng nhập ở trên với tên bạn thật sự dùng trên spigotmc.org.');
  console.log('Nếu khớp mà bot vẫn báo sai mật khẩu, thì mật khẩu trong tệp khác mật khẩu thật.');
}

try {
  main();
} catch (err) {
  console.error('Kiểm tra thất bại:', err instanceof Error ? err.message : err);
  process.exit(1);
}
