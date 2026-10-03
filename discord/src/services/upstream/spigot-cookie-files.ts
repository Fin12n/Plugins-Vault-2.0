import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { BrowserPage } from './download-via-browser.js';

export interface SpigotCookieItem {
  name: string;
  value: string;
  domain?: string;
  path?: string;
  expires?: number;
  httpOnly?: boolean;
  secure?: boolean;
  sameSite?: 'Strict' | 'Lax' | 'None';
  [key: string]: unknown;
}

export interface SpigotSessionMetadata {
  account: string;
  savedAt: string;
  status: 'active' | 'challenged' | 'expired' | 'invalid';
  xfUser?: string;
  xfSession?: string;
  cfClearance?: string;
  [key: string]: unknown;
}

/**
 * Trả về đường dẫn thư mục lưu cookie của tài khoản: ./data/cookie/{account}
 */
export function getAccountCookieDir(accountLabel: string, customBaseDir?: string): string {
  const base = customBaseDir ?? resolve(process.cwd(), 'data', 'cookie');
  const safeAccountName = accountLabel.trim().replace(/[^a-zA-Z0-9._-]/g, '_') || 'account';
  return join(base, safeAccountName);
}

/**
 * Lưu danh sách cookies và metadata của tài khoản vào thư mục ./data/cookie/{account}/*
 */
export function saveAccountCookiesToFile(
  accountLabel: string,
  cookies: SpigotCookieItem[],
  metadata: Partial<SpigotSessionMetadata> = {},
  customBaseDir?: string,
): { cookieFile: string; sessionFile: string } {
  const dir = getAccountCookieDir(accountLabel, customBaseDir);
  mkdirSync(dir, { recursive: true, mode: 0o700 });

  const cookieFile = join(dir, 'cookies.json');
  const sessionFile = join(dir, 'session.json');

  // Trích xuất xf_user và xf_session nếu chưa có trong metadata
  const xfUser = metadata.xfUser ?? cookies.find((c) => c.name === 'xf_user')?.value;
  const xfSession = metadata.xfSession ?? cookies.find((c) => c.name === 'xf_session')?.value;
  const cfClearance = metadata.cfClearance ?? cookies.find((c) => c.name === 'cf_clearance')?.value;

  const fullMetadata: SpigotSessionMetadata = {
    account: accountLabel,
    savedAt: new Date().toISOString(),
    status: metadata.status ?? 'active',
    xfUser,
    xfSession,
    cfClearance,
    ...metadata,
  };

  writeFileSync(cookieFile, JSON.stringify(cookies, null, 2), { encoding: 'utf-8', mode: 0o600 });
  writeFileSync(sessionFile, JSON.stringify(fullMetadata, null, 2), { encoding: 'utf-8', mode: 0o600 });

  return { cookieFile, sessionFile };
}

/**
 * Đọc cookies và metadata đã lưu của tài khoản từ ./data/cookie/{account}/*
 */
export function loadAccountCookiesFromFile(
  accountLabel: string,
  customBaseDir?: string,
): { cookies: SpigotCookieItem[]; metadata: SpigotSessionMetadata | null } | null {
  const dir = getAccountCookieDir(accountLabel, customBaseDir);
  const cookieFile = join(dir, 'cookies.json');
  const sessionFile = join(dir, 'session.json');

  if (!existsSync(cookieFile)) return null;

  try {
    const rawCookies = readFileSync(cookieFile, 'utf-8');
    const cookies = JSON.parse(rawCookies) as SpigotCookieItem[];

    let metadata: SpigotSessionMetadata | null = null;
    if (existsSync(sessionFile)) {
      try {
        metadata = JSON.parse(readFileSync(sessionFile, 'utf-8')) as SpigotSessionMetadata;
      } catch {
        // Metadata không bắt buộc nếu cookies.json hợp lệ
      }
    }

    return { cookies, metadata };
  } catch (err) {
    console.warn(`[CookieStorage] Không thể đọc cookies từ ${cookieFile}:`, err instanceof Error ? err.message : String(err));
    return null;
  }
}

/**
 * Xóa sạch thư mục cookie của tài khoản khi đăng xuất hoặc xóa tài khoản
 */
export function deleteAccountCookiesFile(accountLabel: string, customBaseDir?: string): boolean {
  const dir = getAccountCookieDir(accountLabel, customBaseDir);
  if (!existsSync(dir)) return false;
  try {
    rmSync(dir, { recursive: true, force: true });
    return true;
  } catch {
    return false;
  }
}

export const clearAccountCookies = deleteAccountCookiesFile;

/**
 * Trích xuất toàn bộ cookies hiện tại từ trình duyệt và lưu ngay vào ./data/cookie/{account}/*
 */
export async function extractAndSaveCookiesFromPage(
  page: BrowserPage,
  accountLabel: string,
  metadata: Partial<SpigotSessionMetadata> = {},
  customBaseDir?: string,
): Promise<{ ok: boolean; count: number; cookieCount: number; xfUser?: string; xfSession?: string }> {
  try {
    let rawCookies: SpigotCookieItem[] = [];

    // Ưu tiên 1: Lấy qua CDP Network.getCookies để có đầy đủ cờ HttpOnly, Secure, SameSite
    if (typeof (page as any).createCDPSession === 'function') {
      try {
        const cdp = await (page as any).createCDPSession();
        const res = await cdp.send('Network.getCookies');
        if (Array.isArray(res?.cookies)) {
          rawCookies = res.cookies as SpigotCookieItem[];
        }
        await cdp.detach().catch(() => {});
      } catch {
        // Fallback to page.cookies
      }
    }

    // Ưu tiên 2: Lấy qua page.cookies()
    if (rawCookies.length === 0 && typeof (page as any).cookies === 'function') {
      rawCookies = (await (page as any).cookies().catch(() => [])) as SpigotCookieItem[];
    }

    if (rawCookies.length === 0) {
      return { ok: false, count: 0, cookieCount: 0 };
    }

    const { sessionFile } = saveAccountCookiesToFile(accountLabel, rawCookies, metadata, customBaseDir);
    const xfUser = rawCookies.find((c) => c.name === 'xf_user')?.value;
    const xfSession = rawCookies.find((c) => c.name === 'xf_session')?.value;

    return {
      ok: true,
      count: rawCookies.length,
      cookieCount: rawCookies.length,
      xfUser,
      xfSession,
    };
  } catch (err) {
    console.warn(`[CookieStorage] Lỗi khi trích xuất cookie từ trang cho "${accountLabel}":`, err instanceof Error ? err.message : String(err));
    return { ok: false, count: 0, cookieCount: 0 };
  }
}

/**
 * Tiêm toàn bộ cookies đã lưu của tài khoản vào Browser Page qua Chrome DevTools Protocol
 */
export async function injectCookiesFromAccountFile(
  page: BrowserPage,
  accountLabel: string,
  customBaseDir?: string,
): Promise<boolean> {
  const loaded = loadAccountCookiesFromFile(accountLabel, customBaseDir);
  if (!loaded || !loaded.cookies || loaded.cookies.length === 0) return false;

  try {
    if (typeof (page as any).createCDPSession === 'function') {
      const cdp = await (page as any).createCDPSession();
      await cdp.send('Network.enable');

      for (const c of loaded.cookies) {
        if (!c.name || !c.value) continue;
        await cdp.send('Network.setCookie', {
          name: c.name,
          value: c.value,
          domain: c.domain ?? '.spigotmc.org',
          path: c.path ?? '/',
          secure: c.secure ?? true,
          httpOnly: c.httpOnly ?? true,
          sameSite: (c.sameSite as any) ?? 'None',
        }).catch(() => {});
      }

      await cdp.detach().catch(() => {});
      return true;
    }

    if (typeof (page as any).setCookie === 'function') {
      await (page as any).setCookie(...loaded.cookies).catch(() => {});
      return true;
    }

    return false;
  } catch (err) {
    console.warn(`[CookieStorage] Không thể tiêm cookies cho "${accountLabel}":`, err instanceof Error ? err.message : String(err));
    return false;
  }
}
