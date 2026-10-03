/**
 * Logs into SpigotMC with stored credentials and writes session cookies to the
 * accounts file. Handles many accounts in one run.
 *
 * Automating this is possible, which took three wrong conclusions to establish.
 * The traps, all measured rather than assumed:
 *
 *  1. Cloudflare's challenge on /login/ takes about TWENTY seconds to clear.
 *     Shorter waits see "Just a moment..." and no form, which looks exactly like
 *     a hard block and is why earlier attempts seemed to fail at random.
 *  2. The page carries SEVERAL login forms — one in the sidebar near the top,
 *     one as the page's own form lower down. Only the latter submits; filling
 *     the sidebar copy produces no request at all.
 *  3. An empty `_xfToken` is fine. XenForo accepts it for a guest session, so
 *     the token is not the obstacle it appeared to be.
 *
 * A real browser is still required: `headless: true` does not clear the
 * challenge. This maintenance command is restricted to the Linux host; normal
 * operation uses the dashboard challenge session inside the bot process.
 *
 * puppeteer-real-browser is a pinned production dependency, imported dynamically
 * so a damaged browser install does not take down unrelated application paths.
 *
 * Usage:
 *   npm ci                                   # plus: sudo apt-get install xvfb (Linux)
 *   npm run spigot-login                     # every account in the credentials file
 *   npm run spigot-login -- acc-chinh        # just one
 */
import { readFileSync, existsSync } from 'node:fs';
import { config } from '../src/config/index.js';
import {
  Secret,
  loadSpigotAccounts,
  saveSpigotAccounts,
  type SpigotAccount,
} from '../src/services/upstream/spigot-account-store.js';

/** No trailing slash: `/login/` is Cloudflare-challenged (403), `/login` is not. */
const LOGIN_URL = 'https://www.spigotmc.org/login';
/** Cloudflare needs ~20s; this is the ceiling before calling it blocked. */
const CHALLENGE_TIMEOUT_MS = 90_000;
const CHALLENGE_POLL_MS = 3_000;
/** Gap between accounts. Back-to-back logins are the loudest lockout signal. */
const BETWEEN_ACCOUNTS_MS = 15_000;

type Credential = { label: string; username: string; password: string };

/**
 * Just enough of puppeteer-real-browser's surface, declared locally: importing
 * its types would make typecheck depend on an install most deployments skip.
 */
type BrowserCookie = { name: string; value: string };
type Point = { x: number; y: number };
type LoginPage = {
  goto: (url: string, options?: object) => Promise<unknown>;
  evaluate: (source: never) => Promise<unknown>;
  cookies: () => Promise<BrowserCookie[]>;
  url: () => string | Promise<string>;
  mouse: { click: (x: number, y: number) => Promise<void>; move: (x: number, y: number) => Promise<void> };
  keyboard: { type: (text: string, options?: object) => Promise<void> };
};
type CloakModule = {
  launch: (options?: Record<string, unknown>) => Promise<{
    close: () => Promise<void>;
    pages: () => Promise<unknown[]>;
    newPage: () => Promise<unknown>;
  }>;
};

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Reads the credentials file.
 *
 * Accepts JSON, or `label username password` lines for hand-editing. Tolerates
 * the UTF-16 and BOM that PowerShell's `>` redirect produces, which would
 * otherwise fail JSON.parse with a confusing error.
 */
function readCredentials(path: string): Credential[] {
  const raw = readFileSync(path);
  let text = raw[0] === 0xff && raw[1] === 0xfe ? raw.toString('utf16le') : raw.toString('utf8');
  text = text.replace(/^﻿/, '').trim();

  if (text.startsWith('[')) {
    const parsed = JSON.parse(text) as { label?: string; username?: string; password?: string }[];
    return parsed.map((entry, index) => {
      const username = (entry.username ?? '').trim();
      const password = entry.password ?? '';
      if (username === '' || password === '') throw new Error(`tài khoản thứ ${index + 1} thiếu username hoặc password`);
      return { label: (entry.label ?? username).trim(), username, password };
    });
  }

  // Plain form: one account per line, whitespace-separated.
  const out: Credential[] = [];
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed === '' || trimmed.startsWith('#')) continue;
    const parts = trimmed.split(/\s+/);
    if (parts.length < 2) throw new Error(`dòng không hợp lệ: cần "tên-gợi-nhớ username password"`);
    const [a, b, c] = parts;
    // Two fields means username+password with the label defaulting to username.
    if (c === undefined) out.push({ label: a!, username: a!, password: b! });
    else out.push({ label: a!, username: b!, password: c });
  }
  return out;
}

/** Waits out the Cloudflare interstitial. Returns false if it never clears. */
async function waitForLoginForm(page: LoginPage): Promise<boolean> {
  const deadline = Date.now() + CHALLENGE_TIMEOUT_MS;
  while (Date.now() < deadline) {
    await sleep(CHALLENGE_POLL_MS);
    const ready = await (page.evaluate(
      `document.querySelectorAll('input[name=login]').length > 0` as never,
    ) as Promise<boolean>).catch(() => false);
    if (ready) return true;
  }
  return false;
}

/**
 * Locates the form that actually submits.
 *
 * Several login forms share the page. The sidebar copy sits near the top and
 * silently does nothing, so the real one is identified as the candidate whose
 * submit button sits lowest.
 */
async function locateForm(page: LoginPage): Promise<{ login: Point; password: Point; submit: Point } | null> {
  // Passed as a source string: this executes in the page, not in Node, and the
  // project deliberately has no DOM lib — adding one would let every server
  // module reference `document`.
  return page.evaluate(`(() => {
    const visible = (el) => !!el && !!(el.offsetWidth || el.offsetHeight);
    const candidates = [...document.querySelectorAll('form')].filter((form) =>
      visible(form.querySelector('input[name=login]')) &&
      visible(form.querySelector('input[name=password]')) &&
      visible(form.querySelector('input[type=submit], button[type=submit]')));
    if (candidates.length === 0) return null;
    const buttonY = (f) => f.querySelector('input[type=submit], button[type=submit]').getBoundingClientRect().y;
    candidates.sort((a, b) => buttonY(b) - buttonY(a));
    const form = candidates[0];
    const centre = (el) => { const r = el.getBoundingClientRect();
      return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) }; };
    return {
      login: centre(form.querySelector('input[name=login]')),
      password: centre(form.querySelector('input[name=password]')),
      submit: centre(form.querySelector('input[type=submit], button[type=submit]')),
    };
  })()` as never) as Promise<{ login: Point; password: Point; submit: Point } | null>;
}

/**
 * Whatever error XenForo rendered, so a wrong password says so plainly.
 *
 * `.errors` phải đứng trong danh sách: đó là lớp Spigot thật sự dùng cho câu "The
 * requested user '…' could not be found." — và `.error` không khớp `class="errors"`
 * vì CSS so khớp trọn token, nên trước đây mọi lỗi tên/mật khẩu đọc ra rỗng rồi bị
 * báo thành "có thể bật 2FA".
 */
async function readError(page: LoginPage): Promise<string> {
  const messages = await (page.evaluate(
    `[...document.querySelectorAll('.errors, .errorPanel, .blockMessage, .error, .errorOverlay')]
       .map((el) => (el.textContent || '').trim()).filter(Boolean).slice(0, 2)` as never,
  ) as Promise<string[]>).catch(() => [] as string[]);
  // Lọc trùng: XenForo lồng câu lỗi trong hai lớp cùng khớp bộ chọn, nên nguyên văn
  // sẽ in ra hai lần y hệt.
  return [...new Set(messages)].join(' | ');
}

/** Logs in one account and returns its cookies, or null with a reason logged. */
async function loginOne(page: LoginPage, credential: Credential): Promise<SpigotAccount | null> {
  await page.goto(LOGIN_URL, { waitUntil: 'domcontentloaded', timeout: CHALLENGE_TIMEOUT_MS });

  if (!(await waitForLoginForm(page))) {
    console.error(`  ✗ ${credential.label}: Cloudflare không cho qua sau ${CHALLENGE_TIMEOUT_MS / 1000}s`);
    return null;
  }

  const form = await locateForm(page);
  if (!form) {
    console.error(`  ✗ ${credential.label}: không tìm thấy form đăng nhập gửi được`);
    return null;
  }

  // Real mouse and keyboard rather than assigning .value or calling .click():
  // synthetic events are exactly what the bot detection looks for.
  await page.mouse.click(form.login.x, form.login.y);
  await page.keyboard.type(credential.username, { delay: 70 });
  await page.mouse.click(form.password.x, form.password.y);
  await page.keyboard.type(credential.password, { delay: 70 });

  // Tick "Stay logged in" before submitting: without it XenForo issues no
  // xf_user at all and the session dies in an hour.
  await page.evaluate(
    `(() => {
      const boxes = [...document.querySelectorAll('input[name=remember]')];
      const box = boxes.find((e) => e.offsetWidth || e.offsetHeight) || boxes[0];
      if (box && !box.checked) box.click();
    })()` as never,
  );

  await page.mouse.move(form.submit.x - 25, form.submit.y - 8);
  await sleep(300);
  await page.mouse.click(form.submit.x, form.submit.y);
  await sleep(12_000);

  const cookies = await page.cookies().catch(() => [] as BrowserCookie[]);
  const xfUser = cookies.find((c) => c.name === 'xf_user')?.value ?? '';
  const xfSession = cookies.find((c) => c.name === 'xf_session')?.value ?? '';

  if (xfUser === '') {
    const detail = await readError(page);
    console.error(`  ✗ ${credential.label}: ${detail || 'không nhận được cookie xf_user'}`);
    if (detail === '' && xfSession !== '') {
      // Chỉ nói "có thể 2FA" khi trang KHÔNG còn form đăng nhập: còn form nghĩa là
      // Spigot đã từ chối ngay tại bước nhập, và đoán 2FA ở đó gửi chủ bot đi tắt
      // một thứ chưa từng bật.
      const stillOnForm = await (page.evaluate(
        `!!document.querySelector('input[name=password]')` as never,
      ) as Promise<boolean>).catch(() => false);
      console.error(
        stillOnForm
          ? '    (vẫn ở trang đăng nhập mà trang không báo lỗi — kiểm tra tệp tài khoản bằng `npm run check-accounts`)'
          : '    (có phiên nhưng không có cookie dài hạn — có thể tài khoản bật 2FA)',
      );
    }
    return null;
  }

  // issuedAt is stamped here, at the only moment the real age is known. The
  // refresh job reads it to re-login at day 20, before XenForo's 30-day ceiling.
  return {
    label: credential.label,
    xfUser: new Secret(xfUser),
    xfSession: new Secret(xfSession),
    issuedAt: new Date().toISOString(),
    lastVerifiedAt: new Date().toISOString(),
    status: 'ok',
  };
}

async function main(): Promise<void> {
  if (process.platform !== 'linux' && process.platform !== 'win32') {
    throw new Error('Lệnh này chỉ được chạy trong Linux hoặc Windows host/container; không hỗ trợ nền tảng này.');
  }
  const only = process.argv[2];
  const env = config();
  // Đường dẫn lấy từ cấu hình đã kiểm, không đọc process.env ở đầu module: biến
  // môi trường chỉ có sau khi config() nạp .env, nên hằng số ở đầu tệp luôn rơi về
  // mặc định — và mặc định cũ (`.spigot-credentials.json`, có dấu chấm) không phải
  // tệp bot đang dùng, nên lệnh này không bao giờ tìm thấy tài khoản nào.
  const credentialsFile = env.SPIGOT_CREDENTIALS_FILE;

  if (!existsSync(credentialsFile)) {
    console.error(
      `Không tìm thấy ${credentialsFile}. Tạo tệp với mỗi dòng một tài khoản:\n` +
        '  acc-chinh  TEN_DANG_NHAP  MAT_KHAU\n' +
        '  acc-2      TEN_2          MAT_KHAU_2\n' +
        'Hoặc dùng JSON: [{"label":"acc-chinh","username":"...","password":"..."}]',
    );
    process.exit(1);
  }

  let credentials: Credential[];
  try {
    credentials = readCredentials(credentialsFile);
  } catch (err) {
    console.error(`Đọc ${credentialsFile} thất bại: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }

  if (only) credentials = credentials.filter((c) => c.label === only);
  if (credentials.length === 0) {
    console.error(only ? `Không có tài khoản nào tên "${only}"` : 'Tệp không có tài khoản nào');
    process.exit(1);
  }

  let cloak: CloakModule;
  try {
    const moduleName = 'cloakbrowser/puppeteer';
    cloak = (await import(moduleName)) as CloakModule;
  } catch {
    console.error(
      'Chưa cài cloakbrowser. Cài bằng:\n' +
        '  npm install\n' +
        'Hoặc dán cookie thủ công vào tệp tài khoản.',
    );
    process.exit(1);
  }

  console.log(`Đăng nhập ${credentials.length} tài khoản. Mỗi tài khoản mất khoảng 40 giây.`);

  const existing = loadSpigotAccounts(env.SPIGOT_ACCOUNTS_FILE);
  const accounts: SpigotAccount[] = existing.ok ? [...existing.accounts] : [];
  let ok = 0;

  for (const [index, credential] of credentials.entries()) {
    if (index > 0) await sleep(BETWEEN_ACCOUNTS_MS);
    console.log(`[${index + 1}/${credentials.length}] ${credential.label}...`);

    // A fresh browser per account: reusing one carries the previous session's
    // cookies, and the second login would silently capture the first account.
    const browser = await cloak.launch({
      headless: false,
      humanize: true,
      args: ['--start-maximized'],
    });
    const pages = await browser.pages();
    const page = (pages.length > 0 ? pages[0] : await browser.newPage()) as LoginPage;
    try {
      const account = await loginOne(page, credential);
      if (account) {
        const at = accounts.findIndex((a) => a.label === account.label);
        if (at >= 0) accounts[at] = account;
        else accounts.push(account);
        // Saved per account, not at the end: a crash on account 4 must not
        // discard the three that already worked.
        saveSpigotAccounts(env.SPIGOT_ACCOUNTS_FILE, accounts);
        ok++;
        console.log(`  ✓ ${account.label}: đã lưu cookie`);
      }
    } catch (err) {
      // Message only — a stack can carry the request that held the password.
      console.error(`  ✗ ${credential.label}: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      await browser.close().catch(() => undefined);
    }
  }

  console.log(`\nXong: ${ok}/${credentials.length} tài khoản, lưu vào ${env.SPIGOT_ACCOUNTS_FILE}`);
  if (ok > 0) console.log(`Nhớ xoá ${credentialsFile} nếu không cần đăng nhập lại.`);
  if (ok < credentials.length) process.exitCode = 1;
}

main().catch((err: unknown) => {
  console.error('Không lấy được cookie:', err instanceof Error ? err.message : String(err));
  process.exit(1);
});
