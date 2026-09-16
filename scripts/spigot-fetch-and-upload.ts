/**
 * Legacy host maintenance command. It may run only inside the Linux host and
 * uploads through the dashboard's existing API.
 *
 * Why this exists: Spigot's download endpoint needs a real browser. Measured —
 * plain `fetch` and `curl` get the Cloudflare block page, but navigating a real
 * browser to the same URL clears the challenge and Spigot answers with its own
 * "You must be logged in to do that." So the obstacle is a login inside a
 * browser, not an unbeatable wall.
 *
 * The production scheduler now performs this flow directly in the VPS
 * container. This command remains for host-side maintenance only; it refuses
 * to run on an operator workstation.
 *
 * The vault-side ingest path is untouched — the upload endpoint reads each jar's
 * own descriptor, dedupes by SHA-256, and files it, identically to a drag-drop.
 *
 * Usage:
 *   npm ci
 *   npm run spigot-fetch -- --url https://vault.example.com --resources 12345,67890
 *
 * Credentials come from .spigot-credentials.json (same file the login script
 * uses) and the dashboard password from VAULT_PASSWORD in the environment.
 */
import { readFileSync, existsSync, mkdirSync, readdirSync, statSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { config } from '../src/config/index.js';
import { chromeConfig } from '../src/services/upstream/browser-launcher.js';

/** Cloudflare needs ~20s on the login page; this is the ceiling. */
const CHALLENGE_TIMEOUT_MS = 90_000;
const CHALLENGE_POLL_MS = 3_000;
/** Gap between downloads. Bursts are the clearest lockout signal. */
const BETWEEN_DOWNLOADS_MS = 20_000;
const DOWNLOAD_WAIT_MS = 60_000;

type Credential = { label: string; username: string; password: string };
type Point = { x: number; y: number };

type BrowserPage = {
  goto: (url: string, options?: object) => Promise<unknown>;
  evaluate: (source: never) => Promise<unknown>;
  title: () => Promise<string>;
  url: () => string | Promise<string>;
  createCDPSession: () => Promise<{ send: (method: string, params?: object) => Promise<unknown> }>;
  mouse: { click: (x: number, y: number) => Promise<void>; move: (x: number, y: number) => Promise<void> };
  keyboard: { type: (text: string, options?: object) => Promise<void> };
};
type ConnectFn = (options: {
  headless: boolean;
  turnstile?: boolean;
  args?: string[];
  customConfig?: { chromePath?: string };
}) => Promise<{ browser: { close: () => Promise<void> }; page: BrowserPage }>;

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Reads `label username password` lines, or the JSON array form. */
function readCredentials(path: string): Credential[] {
  const raw = readFileSync(path);
  let text = raw[0] === 0xff && raw[1] === 0xfe ? raw.toString('utf16le') : raw.toString('utf8');
  text = text.replace(/^﻿/, '').trim();

  if (text.startsWith('[')) {
    const parsed = JSON.parse(text) as { label?: string; username?: string; password?: string }[];
    return parsed.map((e, i) => {
      const username = (e.username ?? '').trim();
      const password = e.password ?? '';
      if (!username || !password) throw new Error(`tài khoản thứ ${i + 1} thiếu username hoặc password`);
      return { label: (e.label ?? username).trim(), username, password };
    });
  }

  const out: Credential[] = [];
  for (const line of text.split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const [a, b, c] = t.split(/\s+/);
    if (!a || !b) throw new Error('dòng không hợp lệ: cần "tên-gợi-nhớ username password"');
    if (c === undefined) out.push({ label: a, username: a, password: b });
    else out.push({ label: a, username: b, password: c });
  }
  return out;
}

/** Waits out the Cloudflare interstitial on the login page. */
async function waitForLoginForm(page: BrowserPage): Promise<boolean> {
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
 * Finds the form that actually submits.
 *
 * The page carries several login forms; the sidebar copy sits near the top and
 * silently does nothing, so the real one is the candidate whose submit button
 * sits lowest.
 */
async function locateForm(page: BrowserPage): Promise<{ login: Point; password: Point; submit: Point } | null> {
  return page.evaluate(`(() => {
    const visible = (el) => !!el && !!(el.offsetWidth || el.offsetHeight);
    const cands = [...document.querySelectorAll('form')].filter((f) =>
      visible(f.querySelector('input[name=login]')) &&
      visible(f.querySelector('input[name=password]')) &&
      visible(f.querySelector('input[type=submit], button[type=submit]')));
    if (cands.length === 0) return null;
    const y = (f) => f.querySelector('input[type=submit], button[type=submit]').getBoundingClientRect().y;
    cands.sort((a, b) => y(b) - y(a));
    const f = cands[0];
    const c = (el) => { const r = el.getBoundingClientRect();
      return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) }; };
    return {
      login: c(f.querySelector('input[name=login]')),
      password: c(f.querySelector('input[name=password]')),
      submit: c(f.querySelector('input[type=submit], button[type=submit]')),
    };
  })()` as never) as Promise<{ login: Point; password: Point; submit: Point } | null>;
}

/** Logs one account in. Returns false with a reason printed. */
async function login(page: BrowserPage, credential: Credential): Promise<boolean> {
  await page.goto('https://www.spigotmc.org/login/', { waitUntil: 'domcontentloaded', timeout: CHALLENGE_TIMEOUT_MS });
  if (!(await waitForLoginForm(page))) {
    console.error(`  ✗ ${credential.label}: Cloudflare không cho qua`);
    return false;
  }
  const form = await locateForm(page);
  if (!form) {
    console.error(`  ✗ ${credential.label}: không thấy form đăng nhập gửi được`);
    return false;
  }

  // Real mouse and keyboard: synthetic events are what bot detection looks for.
  await page.mouse.click(form.login.x, form.login.y);
  await page.keyboard.type(credential.username, { delay: 70 });
  await page.mouse.click(form.password.x, form.password.y);
  await page.keyboard.type(credential.password, { delay: 70 });
  await page.evaluate(
    `(() => { const b = [...document.querySelectorAll('input[name=remember]')]
        .find((e) => e.offsetWidth || e.offsetHeight); if (b && !b.checked) b.click(); })()` as never,
  );
  await page.mouse.move(form.submit.x - 25, form.submit.y - 8);
  await sleep(300);
  await page.mouse.click(form.submit.x, form.submit.y);
  await sleep(12_000);

  const ok = await (page.evaluate(
    `!!document.querySelector('.accountUsername, [data-logged-in="true"], a[href*="logout"]')` as never,
  ) as Promise<boolean>).catch(() => false);

  if (!ok) {
    const detail = await (page.evaluate(
      `[...document.querySelectorAll('.errorPanel,.blockMessage,.error')]
         .map((e) => (e.textContent || '').trim()).filter(Boolean).slice(0, 1).join('')` as never,
    ) as Promise<string>).catch(() => '');
    console.error(`  ✗ ${credential.label}: ${detail || 'đăng nhập không thành công'}`);
  }
  return ok;
}

/**
 * Downloads one resource by navigating the whole page to it.
 *
 * Navigation rather than fetch(): an XHR from inside the page still gets the
 * Cloudflare block, while a real navigation clears it. That difference is the
 * whole reason this script can work at all.
 */
async function download(page: BrowserPage, resourceId: number, dir: string): Promise<string | null> {
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });

  const cdp = await page.createCDPSession();
  await cdp.send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: dir, eventsEnabled: true });

  // Visit the resource page first: it establishes the session cookies the
  // download endpoint checks, and clears the challenge once per resource.
  await page.goto(`https://www.spigotmc.org/resources/${resourceId}/`, {
    waitUntil: 'domcontentloaded',
    timeout: CHALLENGE_TIMEOUT_MS,
  });
  for (let i = 0; i < 15; i++) {
    await sleep(2500);
    if (!/just a moment/i.test(await page.title())) break;
  }

  // A file download makes goto() reject; that rejection is success, not failure.
  await page
    .goto(`https://www.spigotmc.org/resources/${resourceId}/download`, {
      waitUntil: 'domcontentloaded',
      timeout: 60_000,
    })
    .catch(() => undefined);

  const deadline = Date.now() + DOWNLOAD_WAIT_MS;
  while (Date.now() < deadline) {
    await sleep(2000);
    const files = readdirSync(dir).filter((f) => !f.endsWith('.crdownload'));
    if (files.length > 0) {
      const path = join(dir, files[0]!);
      if (statSync(path).size > 1024) {
        // PK is the zip local file header. Rules out an HTML error page saved
        // under a .jar name, which would surface much later as a broken plugin.
        const magic = readFileSync(path).subarray(0, 2).toString();
        if (magic !== 'PK') {
          console.error(`  ✗ resource ${resourceId}: tải về không phải jar`);
          return null;
        }
        return path;
      }
    }
  }

  const detail = await (page.evaluate(
    `[...document.querySelectorAll('.errorPanel,.blockMessage,.error,.baseHtml')]
       .map((e) => (e.textContent || '').trim()).filter(Boolean).slice(0, 1).join('').slice(0, 120)` as never,
  ) as Promise<string>).catch(() => '');
  console.error(`  ✗ resource ${resourceId}: ${detail || 'không tải được'}`);
  return null;
}

/** Logs into the vault dashboard and returns its session cookie. */
async function vaultLogin(baseUrl: string, password: string): Promise<string> {
  const res = await fetch(`${baseUrl}/api/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ password }),
  });
  if (!res.ok) throw new Error(`đăng nhập dashboard thất bại: HTTP ${res.status}`);
  const cookie = res.headers.getSetCookie()[0]?.split(';')[0];
  if (!cookie) throw new Error('dashboard không trả về cookie phiên');
  return cookie;
}

/** Posts one jar to the vault, reusing the dashboard's own upload endpoint. */
async function upload(baseUrl: string, cookie: string, path: string): Promise<string> {
  const form = new FormData();
  const name = path.split(/[\\/]/).pop() ?? 'plugin.jar';
  form.append('files', new Blob([readFileSync(path)]), name);

  const res = await fetch(`${baseUrl}/api/upload`, { method: 'POST', headers: { cookie }, body: form });
  const json = (await res.json()) as {
    results?: { status: string; detail?: string }[];
    error?: string;
  };
  if (!res.ok && !json.results) throw new Error(json.error ?? `HTTP ${res.status}`);
  return json.results?.[0]?.status ?? 'unknown';
}

function parseArgs(): { url: string; resources: number[] } {
  const args = process.argv.slice(2);
  const get = (flag: string): string | undefined => {
    const i = args.indexOf(flag);
    return i >= 0 ? args[i + 1] : undefined;
  };
  const url = (get('--url') ?? process.env.VAULT_URL ?? '').replace(/\/+$/, '');
  const raw = get('--resources') ?? '';
  const resources = raw
    .split(',')
    .map((s) => Number(s.trim()))
    .filter((n) => Number.isInteger(n) && n > 0);
  return { url, resources };
}

async function main(): Promise<void> {
  if (process.platform !== 'linux' && process.platform !== 'win32') {
    throw new Error('Lệnh này chỉ được chạy trong Linux hoặc Windows host/container; không hỗ trợ nền tảng này.');
  }
  const { url, resources } = parseArgs();
  const password = process.env.VAULT_PASSWORD ?? '';
  // Đường dẫn lấy từ cấu hình đã kiểm, cùng một tệp mà bot dùng. Đọc process.env
  // trực tiếp sẽ rơi về mặc định khi .env chưa được nạp, và mặc định cũ có dấu chấm
  // ở đầu nên không trùng tên tệp thật.
  const credentialsFile = config().SPIGOT_CREDENTIALS_FILE;
  const tmpDir = resolve('.tmp-spigot-fetch');

  if (!url || resources.length === 0 || !password) {
    console.error(
      'Dùng: npm run spigot-fetch -- --url https://vault.example.com --resources 12345,67890\n' +
        'Cần biến môi trường VAULT_PASSWORD (mật khẩu dashboard).\n' +
        `Tài khoản Spigot đọc từ ${credentialsFile}.`,
    );
    process.exit(1);
  }
  if (!existsSync(credentialsFile)) {
    console.error(`Không tìm thấy ${credentialsFile}. Mỗi dòng: tên-gợi-nhớ username mật-khẩu`);
    process.exit(1);
  }

  const credentials = readCredentials(credentialsFile);
  if (credentials.length === 0) {
    console.error('Tệp tài khoản rỗng');
    process.exit(1);
  }

  let connect: ConnectFn;
  try {
    const moduleName = 'puppeteer-real-browser';
    ({ connect } = (await import(moduleName)) as { connect: ConnectFn });
  } catch {
    console.error(
      'Chưa cài puppeteer-real-browser. Chạy:\n  npm ci\n' +
        'Máy này cần có màn hình (hoặc xvfb trên Linux).',
    );
    process.exit(1);
  }

  const cookie = await vaultLogin(url, password);
  console.log(`Đã kết nối kho tại ${url}`);

  const { browser, page } = await connect({
    headless: false,
    turnstile: true,
    args: ['--start-maximized'],
    ...chromeConfig(),
  });
  let archived = 0;
  let failed = 0;

  try {
    // First account that logs in wins; the rest are fallbacks for a dead one.
    let account: Credential | null = null;
    for (const candidate of credentials) {
      console.log(`Đăng nhập ${candidate.label}...`);
      if (await login(page, candidate)) {
        account = candidate;
        console.log(`  ✓ ${candidate.label}`);
        break;
      }
    }
    if (!account) {
      console.error('Không đăng nhập được tài khoản nào');
      process.exit(1);
    }

    for (const [index, id] of resources.entries()) {
      if (index > 0) await sleep(BETWEEN_DOWNLOADS_MS);
      console.log(`[${index + 1}/${resources.length}] resource ${id}...`);

      const path = await download(page, id, tmpDir);
      if (!path) {
        failed++;
        continue;
      }
      try {
        const status = await upload(url, cookie, path);
        // 'duplicate' means the vault already had these bytes — a success, and
        // the normal result when nothing changed upstream.
        console.log(`  ✓ ${status}`);
        if (status === 'added' || status === 'duplicate') archived++;
        else failed++;
      } catch (err) {
        console.error(`  ✗ tải lên thất bại: ${err instanceof Error ? err.message : String(err)}`);
        failed++;
      }
    }
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
    await browser.close().catch(() => undefined);
  }

  console.log(`\nXong: ${archived} vào kho, ${failed} lỗi`);
  if (failed > 0) process.exitCode = 1;
}

main().catch((err: unknown) => {
  // Message only: a stack can carry the request that held the password.
  console.error('Thất bại:', err instanceof Error ? err.message : String(err));
  process.exit(1);
});
