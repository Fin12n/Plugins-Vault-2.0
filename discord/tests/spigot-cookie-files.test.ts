import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { existsSync, readFileSync, rmSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  getAccountCookieDir,
  saveAccountCookiesToFile,
  loadAccountCookiesFromFile,
  clearAccountCookies,
  extractAndSaveCookiesFromPage,
  injectCookiesFromAccountFile,
  type SpigotCookieItem,
} from '../src/services/upstream/spigot-cookie-files.js';

describe('Spigot Cookie File Storage (./data/cookie/{account}/*)', () => {
  let tempBaseDir: string;

  beforeEach(() => {
    tempBaseDir = join(tmpdir(), `spigot-cookie-test-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`);
    mkdirSync(tempBaseDir, { recursive: true });
  });

  afterEach(() => {
    if (existsSync(tempBaseDir)) {
      try {
        rmSync(tempBaseDir, { recursive: true, force: true });
      } catch { }
    }
  });

  it('xác định đúng đường dẫn thư mục cookie cho tài khoản', () => {
    const dir = getAccountCookieDir('MyAccount#1', tempBaseDir);
    expect(dir).toBe(join(tempBaseDir, 'MyAccount_1'));
  });

  it('lưu cookies và session metadata vào ./data/cookie/{account}/cookies.json và session.json', () => {
    const mockCookies: SpigotCookieItem[] = [
      { name: 'xf_user', value: '12345,hashstring' },
      { name: 'xf_session', value: 'sessiontoken123' },
      { name: 'cf_clearance', value: 'clearance123' },
    ];

    const result = saveAccountCookiesToFile('test-acc', mockCookies, { status: 'active' }, tempBaseDir);
    expect(existsSync(result.cookieFile)).toBe(true);
    expect(existsSync(result.sessionFile)).toBe(true);

    const savedCookies = JSON.parse(readFileSync(result.cookieFile, 'utf-8'));
    expect(savedCookies).toEqual(mockCookies);

    const savedSession = JSON.parse(readFileSync(result.sessionFile, 'utf-8'));
    expect(savedSession.account).toBe('test-acc');
    expect(savedSession.status).toBe('active');
    expect(savedSession.xfUser).toBe('12345,hashstring');
    expect(savedSession.xfSession).toBe('sessiontoken123');
    expect(savedSession.cfClearance).toBe('clearance123');
  });

  it('đọc lại cookies và metadata từ file hợp lệ', () => {
    const mockCookies: SpigotCookieItem[] = [
      { name: 'xf_user', value: '888,token' },
      { name: 'xf_session', value: 'sess' },
    ];

    saveAccountCookiesToFile('acc2', mockCookies, { status: 'active' }, tempBaseDir);

    const loaded = loadAccountCookiesFromFile('acc2', tempBaseDir);
    expect(loaded).not.toBeNull();
    expect(loaded?.cookies).toHaveLength(2);
    expect(loaded?.metadata?.xfUser).toBe('888,token');
    expect(loaded?.metadata?.status).toBe('active');
  });

  it('trả về null nếu tài khoản chưa có file cookie', () => {
    const loaded = loadAccountCookiesFromFile('nonexistent', tempBaseDir);
    expect(loaded).toBeNull();
  });

  it('xóa sạch thư mục cookie của tài khoản', () => {
    saveAccountCookiesToFile('acc-to-delete', [{ name: 'test', value: 'val' }], {}, tempBaseDir);
    const dir = getAccountCookieDir('acc-to-delete', tempBaseDir);
    expect(existsSync(dir)).toBe(true);

    const cleared = clearAccountCookies('acc-to-delete', tempBaseDir);
    expect(cleared).toBe(true);
    expect(existsSync(dir)).toBe(false);
  });

  it('trích xuất và lưu cookie từ Page qua CDP Network.getCookies', async () => {
    const mockPage: any = {
      createCDPSession: vi.fn().mockResolvedValue({
        send: vi.fn().mockResolvedValue({
          cookies: [
            { name: 'xf_user', value: '999,userhash', domain: '.spigotmc.org' },
            { name: 'xf_session', value: 'sess999', domain: '.spigotmc.org' },
          ],
        }),
        detach: vi.fn().mockResolvedValue(undefined),
      }),
    };

    const extractResult = await extractAndSaveCookiesFromPage(mockPage, 'cdp-acc', { status: 'active' }, tempBaseDir);
    expect(extractResult.ok).toBe(true);
    expect(extractResult.count).toBe(2);
    expect(extractResult.cookieCount).toBe(2);
    expect(extractResult.xfUser).toBe('999,userhash');
    expect(extractResult.xfSession).toBe('sess999');

    const loaded = loadAccountCookiesFromFile('cdp-acc', tempBaseDir);
    expect(loaded?.cookies).toHaveLength(2);
  });

  it('tiêm cookies từ file vào Page qua CDP Network.setCookies', async () => {
    saveAccountCookiesToFile(
      'inject-acc',
      [{ name: 'xf_user', value: 'user_injected' }],
      { status: 'active' },
      tempBaseDir,
    );

    const sendMock = vi.fn().mockResolvedValue(undefined);
    const mockPage: any = {
      createCDPSession: vi.fn().mockResolvedValue({
        send: sendMock,
        detach: vi.fn().mockResolvedValue(undefined),
      }),
    };

    const injected = await injectCookiesFromAccountFile(mockPage, 'inject-acc', tempBaseDir);
    expect(injected).toBe(true);
    expect(sendMock).toHaveBeenCalledWith('Network.setCookie', expect.objectContaining({
      name: 'xf_user',
      value: 'user_injected',
    }));
  });
});
