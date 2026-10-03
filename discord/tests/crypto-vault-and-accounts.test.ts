import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { migrate } from '../src/db/migrate.js';
import type { Db } from '../src/db/connection.js';
import { decryptSecret, encryptSecret, resetCachedKey } from '../src/utils/crypto-vault.js';
import {
  findSpigotAccountByLabel,
  listEnabledSpigotAccounts,
  listSpigotAccounts,
  setSpigotAccountEnabled,
  updateSpigotAccountSession,
  upsertSpigotAccount,
} from '../src/repositories/spigot-accounts.js';

describe('crypto-vault (AES-256-GCM)', () => {
  beforeEach(() => {
    process.env.SESSION_SECRET = 'test-secret-at-least-32-chars-long-12345';
    resetCachedKey();
  });

  afterEach(() => {
    resetCachedKey();
  });

  it('mã hóa và giải mã chuỗi chuẩn xác', () => {
    const raw = 'my-super-secret-password-123!@#';
    const encrypted = encryptSecret(raw);

    expect(encrypted).not.toBe(raw);
    expect(encrypted).toContain(':'); // iv:tag:ciphertext format
    const parts = encrypted.split(':');
    expect(parts.length).toBe(3);

    const decrypted = decryptSecret(encrypted);
    expect(decrypted).toBe(raw);
  });

  it('xử lý chuỗi rỗng an toàn', () => {
    expect(encryptSecret('')).toBe('');
    expect(decryptSecret('')).toBe('');
  });

  it('chuỗi payload hỏng trả về rỗng không gây crash', () => {
    expect(decryptSecret('invalid:payload:format-corrupted')).toBe('');
  });
});

describe('spigot-accounts repository', () => {
  let db: Db;

  beforeEach(() => {
    process.env.SESSION_SECRET = 'test-secret-at-least-32-chars-long-12345';
    resetCachedKey();
    db = new Database(':memory:') as unknown as Db;
    (db as any).pragma('foreign_keys = ON');
    migrate(db);
  });

  it('lưu trữ tài khoản Spigot và mã hoá mật khẩu / cookies', () => {
    upsertSpigotAccount(db, {
      label: 'acc-vip',
      username: 'vip_user',
      password: 'password123',
      xfUser: '12345,cookie_secret_val',
      xfSession: 'session_secret_hash',
      isEnabled: true,
    });

    // 1. Kiểm tra trong DB thực tế được mã hoá (không chứa plain password)
    const rawRow = db.prepare('SELECT * FROM spigot_accounts WHERE label = ?').get('acc-vip') as any;
    expect(rawRow).toBeDefined();
    expect(rawRow.password_encrypted).not.toBe('password123');
    expect(rawRow.password_encrypted).toContain(':');
    expect(rawRow.xf_user_encrypted).not.toBe('12345,cookie_secret_val');

    // 2. Đọc qua repository giải mã chuẩn xác
    const account = findSpigotAccountByLabel(db, 'acc-vip');
    expect(account).not.toBeNull();
    expect(account?.label).toBe('acc-vip');
    expect(account?.username).toBe('vip_user');
    expect(account?.password.reveal()).toBe('password123');
    expect(account?.xfUser.reveal()).toBe('12345,cookie_secret_val');
    expect(account?.xfSession.reveal()).toBe('session_secret_hash');
    expect(account?.isEnabled).toBe(true);
  });

  it('cập nhật session cookie của tài khoản', () => {
    upsertSpigotAccount(db, {
      label: 'acc-1',
      username: 'user1',
      password: 'pass',
    });

    updateSpigotAccountSession(db, 'acc-1', {
      xfUser: 'new-user-cookie',
      xfSession: 'new-session-cookie',
      status: 'ok',
      issuedAt: '2026-09-25T00:00:00.000Z',
    });

    const account = findSpigotAccountByLabel(db, 'acc-1');
    expect(account?.xfUser.reveal()).toBe('new-user-cookie');
    expect(account?.xfSession.reveal()).toBe('new-session-cookie');
    expect(account?.issuedAt).toBe('2026-09-25T00:00:00.000Z');
  });

  it('bật / tắt tài khoản thành công', () => {
    upsertSpigotAccount(db, {
      label: 'acc-toggle',
      username: 'user_toggle',
      password: 'pass',
      isEnabled: true,
    });

    expect(listEnabledSpigotAccounts(db).length).toBe(1);

    setSpigotAccountEnabled(db, 'acc-toggle', false);
    expect(listEnabledSpigotAccounts(db).length).toBe(0);
    expect(listSpigotAccounts(db).length).toBe(1);
  });
});
