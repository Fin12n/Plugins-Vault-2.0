import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { envSchema } from '../src/config/env.js';

/** Minimum set of vars a valid config needs. */
const validEnv = {
  DISCORD_TOKEN: 'a-token',
  DISCORD_CLIENT_ID: '100000000000000001',
  DISCORD_GUILD_ID: '100000000000000002',
  DISCORD_ADMIN_ROLE_IDS: '100000000000000003,100000000000000004',
  DISCORD_OWNER_ID: '100000000000000005',
  DISCORD_NOTIFY_CHANNEL_ID: '100000000000000006',
  PUBLIC_BASE_URL: 'https://vault.example.com',
  DASHBOARD_PASSWORD: 'a-real-password',
  SESSION_SECRET: 'k9Xq2mVt7bNr4aLp8sZw3eYc6uHd1oGf',
  SEPAY_WEBHOOK_SECRET: 'a-real-secret',
  SEPAY_ACCOUNT_NUMBER: '0010000000355',
  SEPAY_BANK_CODE: 'Vietcombank',
  SEPAY_CODE_PREFIX: 'vn',
};

describe('envSchema', () => {
  it('accepts a complete config and applies defaults', () => {
    const parsed = envSchema.parse(validEnv);
    expect(parsed.PORT).toBe(3000);
    expect(parsed.PRUNE_KEEP_COUNT).toBe(10);
    expect(parsed.TRUST_PROXY).toBe(false);
    expect(parsed.SPIGOT_INTERACTIVE_CHALLENGE).toBe(false);
    expect(parsed.SPIGOT_CHALLENGE_COOLDOWN_MS).toBe(30 * 60_000);
  });

  it('names every missing variable rather than failing on the first', () => {
    const result = envSchema.safeParse({});
    expect(result.success).toBe(false);
    if (result.success) return;
    const keys = result.error.issues.map((i) => i.path.join('.'));
    expect(keys).toContain('DISCORD_TOKEN');
    expect(keys).toContain('SEPAY_CODE_PREFIX');
    expect(keys.length).toBeGreaterThan(10);
  });

  it('uppercases the SePay code prefix so it matches what SePay extracts', () => {
    expect(envSchema.parse(validEnv).SEPAY_CODE_PREFIX).toBe('VN');
  });

  it('strips trailing slashes from PUBLIC_BASE_URL to avoid double-slash links', () => {
    const parsed = envSchema.parse({ ...validEnv, PUBLIC_BASE_URL: 'https://vault.example.com//' });
    expect(parsed.PUBLIC_BASE_URL).toBe('https://vault.example.com');
  });

  it('rejects a non-http scheme', () => {
    const result = envSchema.safeParse({ ...validEnv, PUBLIC_BASE_URL: 'javascript:alert(1)' });
    expect(result.success).toBe(false);
  });

  it('rejects placeholder secrets copied from .env.example', () => {
    const placeholders = ['change-me-at-least-32-characters-long', 'your-session-secret-goes-right-here'];
    for (const value of placeholders) {
      const result = envSchema.safeParse({ ...validEnv, SESSION_SECRET: value });
      expect(result.success, `should reject ${value}`).toBe(false);
    }
  });

  it('accepts a random secret even when it contains a placeholder-like substring', () => {
    const random = 'aXsecretQ9zLmPw4TvBnR7kEdCyHgFj2';
    expect(envSchema.safeParse({ ...validEnv, SESSION_SECRET: random }).success).toBe(true);
  });

  it('rejects a TRUST_PROXY typo instead of silently reading false', () => {
    expect(envSchema.safeParse({ ...validEnv, TRUST_PROXY: 'yes' }).success).toBe(false);
    expect(envSchema.parse({ ...validEnv, TRUST_PROXY: 'true' }).TRUST_PROXY).toBe(true);
  });

  it('parses unattended Spigot challenge controls strictly', () => {
    expect(envSchema.parse({ ...validEnv, SPIGOT_INTERACTIVE_CHALLENGE: 'true' }).SPIGOT_INTERACTIVE_CHALLENGE).toBe(true);
    expect(envSchema.safeParse({ ...validEnv, SPIGOT_INTERACTIVE_CHALLENGE: 'yes' }).success).toBe(false);
    expect(envSchema.safeParse({ ...validEnv, SPIGOT_CHALLENGE_COOLDOWN_MS: '1000' }).success).toBe(false);
  });

  it('parses CLOAKBROWSER_HEADLESS with true as default', () => {
    expect(envSchema.parse(validEnv).CLOAKBROWSER_HEADLESS).toBe(true);
    expect(envSchema.parse({ ...validEnv, CLOAKBROWSER_HEADLESS: 'false' }).CLOAKBROWSER_HEADLESS).toBe(false);
    expect(envSchema.parse({ ...validEnv, CLOAKBROWSER_HEADLESS: 'true' }).CLOAKBROWSER_HEADLESS).toBe(true);
  });

  it('để trống cấu hình proxy nghĩa là chạy IP máy chủ, không phải lỗi', () => {
    const parsed = envSchema.parse(validEnv);
    expect(parsed.SPIGOT_PROXY_LIST).toBeUndefined();
    expect(parsed.SPIGOT_PROXY_FILE).toBeUndefined();
    expect(parsed.SPIGOT_PROXY_API_URL).toBeUndefined();
    // Mặc định phải có giá trị dùng được ngay: nghỉ 10 phút, thử 3 proxy mỗi lần mở.
    expect(parsed.SPIGOT_PROXY_COOLDOWN_MS).toBe(600_000);
    expect(parsed.SPIGOT_PROXY_MAX_ATTEMPTS).toBe(3);
  });

  it('chặn số lần thử proxy vô lý, để một danh sách proxy chết không treo lượt quét', () => {
    expect(envSchema.safeParse({ ...validEnv, SPIGOT_PROXY_MAX_ATTEMPTS: '0' }).success).toBe(false);
    expect(envSchema.safeParse({ ...validEnv, SPIGOT_PROXY_MAX_ATTEMPTS: '99' }).success).toBe(false);
    expect(envSchema.parse({ ...validEnv, SPIGOT_PROXY_MAX_ATTEMPTS: '5' }).SPIGOT_PROXY_MAX_ATTEMPTS).toBe(5);
  });

  it('để trống YesCaptcha nghĩa là không mua cf_clearance, không phải lỗi', () => {
    const parsed = envSchema.parse(validEnv);
    expect(parsed.YESCAPTCHA_CLIENT_KEY).toBeUndefined();
    // Mặc định phải dùng được ngay khi chủ bot chỉ dán thêm đúng một dòng khoá vào .env.
    expect(parsed.YESCAPTCHA_BASE_URL).toBe('https://api.yescaptcha.com');
    expect(parsed.YESCAPTCHA_TIMEOUT_MS).toBe(120_000);
    expect(parsed.YESCAPTCHA_CLEARANCE_TTL_MS).toBe(45 * 60_000);
    expect(parsed.YESCAPTCHA_MAX_SOLVES_PER_SWEEP).toBe(10);
  });

  it('cắt dấu / cuối YESCAPTCHA_BASE_URL, để URL không thành //createTask', () => {
    expect(envSchema.parse({ ...validEnv, YESCAPTCHA_BASE_URL: 'https://cn.yescaptcha.com/' }).YESCAPTCHA_BASE_URL).toBe(
      'https://cn.yescaptcha.com',
    );
    expect(envSchema.safeParse({ ...validEnv, YESCAPTCHA_BASE_URL: 'không-phải-url' }).success).toBe(false);
  });

  it('chặn trần lượt giải vô lý, vì mỗi lượt tốn điểm thật', () => {
    expect(envSchema.safeParse({ ...validEnv, YESCAPTCHA_MAX_SOLVES_PER_SWEEP: '0' }).success).toBe(false);
    expect(envSchema.safeParse({ ...validEnv, YESCAPTCHA_MAX_SOLVES_PER_SWEEP: '5000' }).success).toBe(false);
    // Trần chờ cũng vậy: dưới 30 giây thì bỏ cuộc trước khi nhà cung cấp kịp trả lời,
    // vì tài liệu ghi kết quả về sau 10–80 giây.
    expect(envSchema.safeParse({ ...validEnv, YESCAPTCHA_TIMEOUT_MS: '5000' }).success).toBe(false);
  });

  it('rejects a malformed role ID list', () => {
    expect(envSchema.safeParse({ ...validEnv, DISCORD_ADMIN_ROLE_IDS: 'not-a-snowflake' }).success).toBe(false);
    expect(envSchema.safeParse({ ...validEnv, DISCORD_ADMIN_ROLE_IDS: '' }).success).toBe(false);
  });

  it('treats a blank optional value as absent rather than NaN', () => {
    expect(envSchema.parse({ ...validEnv, PRUNE_KEEP_COUNT: '' }).PRUNE_KEEP_COUNT).toBe(10);
  });

  it('resolves relative storage paths to absolute so CWD cannot redirect them', () => {
    const parsed = envSchema.parse(validEnv);
    expect(parsed.DB_PATH).toMatch(/^([A-Za-z]:[\\/]|\/)/);
    expect(parsed.VAULT_DIR).toMatch(/^([A-Za-z]:[\\/]|\/)/);
  });

  it('anchors relative paths at the project root, not the build output dir', () => {
    // The compiled module sits at dist/src/config/, one level deeper than the
    // source. A fixed hop count would resolve here to dist/ and silently create
    // a second empty database there.
    const parsed = envSchema.parse({ ...validEnv, DB_PATH: './data/vault.db' });
    expect(parsed.DB_PATH).not.toMatch(/[\\/]dist[\\/]/);
    expect(parsed.DB_PATH).toBe(resolve(process.cwd(), 'data/vault.db'));
  });

  it('leaves an absolute path untouched', () => {
    const absolute = resolve('/srv/vault/data/vault.db');
    expect(envSchema.parse({ ...validEnv, DB_PATH: absolute }).DB_PATH).toBe(absolute);
  });
});
