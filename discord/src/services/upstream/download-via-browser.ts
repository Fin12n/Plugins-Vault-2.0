import { mkdirSync, rmSync } from 'node:fs';
import { open, readFile, readdir, rename, stat, unlink, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import type { DownloadOutcome } from './download-spigot-resource.js';
import type { Credential } from './spigot-credential-store.js';
import { downloadUrlFor, findVersionId } from './spigot-version-links.js';
import { fetchPublicPage, historyUrl } from './spigot-public-fetch.js';
import { isChromeClosedError } from './chrome-close-detector.js';
import { sweepLogs } from '../maintenance/sweep-logs.js';
import { tryClickTurnstileCheckbox, clickViaCDP } from './cloak-browser-engine.js';

async function readHead(path: string, length: number): Promise<Buffer> {
  const handle = await open(path, 'r');
  try {
    const buffer = Buffer.alloc(length);
    const { bytesRead } = await handle.read(buffer, 0, length, 0);
    return buffer.subarray(0, bytesRead);
  } finally {
    await handle.close().catch(() => undefined);
  }
}

const CHALLENGE_TIMEOUT_MS = 90_000;
const CHALLENGE_POLL_MS = 2_500;
const DOWNLOAD_WAIT_MS = 180_000;
const MIN_PLAUSIBLE_BYTES = 1024;

export type BrowserPage = {
  goto: (url: string, options?: object) => Promise<unknown>;
  evaluate: (source: never) => Promise<unknown>;
  title: () => Promise<string>;
  createCDPSession: () => Promise<{
    send: (method: string, params?: object) => Promise<unknown>;
    detach?: () => Promise<void>;
  }>;
  mouse: { click: (x: number, y: number) => Promise<void>; move: (x: number, y: number) => Promise<void> };
  keyboard: { type: (text: string, options?: object) => Promise<void>; press: (key: string) => Promise<void> };
  authenticate?: (credentials: { username: string; password: string }) => Promise<void>;
  close?: () => Promise<void>;
};

export type BrowserSession = {
  page: BrowserPage;
  close: () => Promise<void>;
  isAbruptlyClosed?: () => boolean;
  onAbruptClose?: (callback: (reason: string) => void) => (() => void);
  markAbruptlyClosed?: (reason?: string) => void;
};

export type ChallengeSolver = {
  solve: (page: BrowserPage, url: string) => Promise<{ ok: true; reused: boolean } | { ok: false; detail: string }>;
  prime: (page: BrowserPage, url: string) => Promise<boolean>;
};

export type BrowserLaunchOptions = {
  profileDir?: string;
  proxyServer?: string;
  proxyUsername?: string;
  proxyPassword?: string;
  headless?: boolean;
  ephemeral?: boolean;
  accountLabel?: string;
};

export type BrowserLauncher = (options?: BrowserLaunchOptions) => Promise<BrowserSession>;

export type BrowserDownloadDeps = {
  tmpDir: string;
  maxBytes: number;
  signal?: AbortSignal;
  fetchImpl?: typeof fetch;
  log?: (message: string) => void;
  solver?: ChallengeSolver;
  challengeTimings?: { pollMs?: number; delay?: (ms: number) => Promise<void>; now?: () => number };
  onHeartbeat?: () => void;
  onProgress?: (bytes: number, status?: string) => void;
  expectedSha256?: string;
  downloadWaitMs?: number;
};

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

async function abortableSleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return;
  return new Promise((resolve) => {
    let timer: NodeJS.Timeout | null = null;
    const onAbort = () => {
      if (timer) clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      resolve();
    };
    timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    if (signal) {
      signal.addEventListener('abort', onAbort, { once: true });
    }
  });
}

type ChallengeWait = { cleared: true } | { cleared: false; interactive: boolean };

const INTERACTIVE_GIVE_UP_MS = 60_000;
const SOLVER_GRACE_MS = 20_000;

/**
 * Điều hướng an toàn: Bỏ qua lỗi 'Navigating frame was detached' khi Cloudflare hoặc XenForo tự reload trang
 */
export async function safeNavigate(
  page: BrowserPage,
  url: string,
  options: { waitUntil?: string; timeout?: number } = {},
): Promise<void> {
  const timeout = options.timeout ?? CHALLENGE_TIMEOUT_MS;
  const waitUntil = options.waitUntil ?? 'domcontentloaded';
  try {
    await (page.goto as any)(url, { waitUntil, timeout });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err ?? '');
    if (
      /detached|destroyed|net::ERR_ABORTED|Target closed/i.test(msg) &&
      !msg.includes('browser has disconnected')
    ) {
      return;
    }
    throw err;
  }
}

async function hasInteractiveChallenge(page: BrowserPage): Promise<boolean> {
  try {
    const found = await (page.evaluate(
      `(() => {
        if (document.getElementById('challenge-running')) return true;
        if (document.querySelector('#cf-chl-widget-container, form#challenge-form, input[name="cf-turnstile-response"]')) return true;
        return !!document.querySelector('iframe[src*="challenges.cloudflare.com"]');
      })()` as never,
    ) as Promise<boolean>).catch(() => false);
    return found === true;
  } catch {
    return false;
  }
}

export async function tryClickTurnstile(
  page: BrowserPage,
  options: { waitBeforeClickMs?: number; skipWait?: boolean } = {}
): Promise<boolean> {
  // Ưu tiên 1: Quét frames và click qua CDP bằng CloakBrowser Engine
  try {
    const solved = await tryClickTurnstileCheckbox(page as any, {
      allowAnyDomain: true,
      skipWait: options.skipWait,
      waitBeforeClickMs: options.waitBeforeClickMs,
    });
    if (solved) {
      sweepLogs.add('🎯 Đã giả lập click hộp kiểm Cloudflare Turnstile qua CDP (Frames)!', 'info');
      return true;
    }
  } catch {
    // Bỏ qua lỗi và tiếp tục kiểm tra DOM
  }

  // Ưu tiên 2: Quét tọa độ DOM và click qua CDP hoặc mouse
  try {
    const coords = (await (page.evaluate(
      `(() => {
        const iframe = document.querySelector('iframe[src*="challenges.cloudflare.com"], iframe[src*="challenge-platform"], iframe[src*="turnstile"]');
        if (iframe) {
          const rect = iframe.getBoundingClientRect();
          if (rect && rect.width > 0 && rect.height > 0) {
            return { x: rect.left + 35, y: rect.top + rect.height / 2 };
          }
        }
        const widget = document.getElementById('cf-chl-widget-container') || document.getElementById('challenge-stage');
        if (widget) {
          const rect = widget.getBoundingClientRect();
          if (rect && rect.width > 0) {
            return { x: rect.left + 35, y: rect.top + rect.height / 2 };
          }
        }
        return null;
      })()` as never,
    ) as Promise<{ x: number; y: number } | null>).catch(() => null)) as { x: number; y: number } | null;

    if (coords && coords.x > 0 && coords.y > 0) {
      if (!options.skipWait) {
        const waitMs =
          options.waitBeforeClickMs ?? (process.env.VITEST ? 0 : 3000 + Math.floor(Math.random() * 2000));
        if (waitMs > 0) {
          sweepLogs.add(`⏳ Đang chờ từ từ ${(waitMs / 1000).toFixed(1)}s cho Cloudflare ổn định rồi mới ấn...`, 'info');
          await sleep(waitMs);
        }
      }

      if (typeof (page as any).createCDPSession === 'function' || typeof (page as any).target === 'function') {
        try {
          await clickViaCDP(page as any, coords.x, coords.y, 'Turnstile (DOM)');
          sweepLogs.add('🎯 Đã giả lập di chuột & click hộp kiểm Cloudflare Turnstile qua CDP!', 'info');
          return true;
        } catch {
          // Fallback to page.mouse
        }
      }
      if (page.mouse && typeof page.mouse.click === 'function') {
        if (typeof page.mouse.move === 'function') {
          await page.mouse.move(coords.x + (Math.random() * 4 - 2), coords.y + (Math.random() * 4 - 2));
        }
        await sleep(200 + Math.random() * 150);
        await page.mouse.click(coords.x, coords.y);
        sweepLogs.add('🎯 Đã giả lập di chuột & click hộp kiểm Cloudflare Turnstile!', 'info');
        return true;
      }
    }
  } catch {
    // Không ném lỗi nếu Cloudflare đang reload
  }
  return false;
}

/**
 * Tiêm trực tiếp session cookies (xf_user, xf_session) vào trình duyệt qua CDP
 * Giúp mở trang SpigotMC đã đăng nhập sẵn mà không cần điền form lại từ đầu.
 */
export async function injectSpigotSessionCookies(
  page: BrowserPage,
  cookies: { xfUser?: string; xfSession?: string },
  domain = '.spigotmc.org',
): Promise<boolean> {
  if (!cookies.xfUser && !cookies.xfSession) return false;
  try {
    const cdp = await page.createCDPSession();
    try {
      await cdp.send('Network.enable');
      if (cookies.xfUser) {
        await cdp.send('Network.setCookie', {
          name: 'xf_user',
          value: cookies.xfUser,
          domain,
          path: '/',
          secure: true,
          httpOnly: true,
          sameSite: 'None',
        });
      }
      if (cookies.xfSession) {
        await cdp.send('Network.setCookie', {
          name: 'xf_session',
          value: cookies.xfSession,
          domain,
          path: '/',
          secure: true,
          httpOnly: true,
          sameSite: 'None',
        });
      }
      return true;
    } finally {
      await cdp.detach?.().catch(() => undefined);
    }
  } catch {
    if (typeof (page as any).setCookie === 'function') {
      const list = [];
      if (cookies.xfUser) list.push({ name: 'xf_user', value: cookies.xfUser, domain, path: '/', httpOnly: true, secure: true });
      if (cookies.xfSession) list.push({ name: 'xf_session', value: cookies.xfSession, domain, path: '/', httpOnly: true, secure: true });
      await (page as any).setCookie(...list).catch(() => {});
      return true;
    }
    return false;
  }
}

/** Chờ CloakBrowser tự giải quyết Cloudflare Turnstile, kháng lỗi frame detach */
async function waitForRealPage(
  page: BrowserPage,
  pollMs = CHALLENGE_POLL_MS,
  delay: (ms: number) => Promise<void> = sleep,
  now: () => number = Date.now,
  budgetMs = CHALLENGE_TIMEOUT_MS,
): Promise<ChallengeWait> {
  const startedAt = now();
  const deadline = startedAt + budgetMs;
  let sawInteractive = false;
  let lastProgressLog = 0;
  let lastClickAttempt = 0;

  while (true) {
    let title = '';
    try {
      title = await page.title();
    } catch {
      // Đang reload/detach, đợi lượt tick tiếp theo
      if (now() >= deadline) break;
      await delay(pollMs);
      continue;
    }

    const isChallenged = /just a moment|checking your browser|security check/i.test(title);
    if (!isChallenged) {
      try {
        const ready = await (page.evaluate('document.readyState' as never) as Promise<string>).catch(() => '');
        if (!ready || ready === 'interactive' || ready === 'complete') {
          return { cleared: true };
        }
      } catch {
        return { cleared: true };
      }
    }

    const hasInteractive = await hasInteractiveChallenge(page);
    if (hasInteractive) {
      sawInteractive = true;
      const elapsedSinceClick = now() - lastClickAttempt;
      const minInterval = process.env.VITEST ? 100 : 7_000;
      if (lastClickAttempt === 0 || elapsedSinceClick >= minInterval) {
        lastClickAttempt = now();
        const waitMs = process.env.VITEST ? 50 : 3000 + Math.floor(Math.random() * 2000);
        sweepLogs.add(`🛡️ Phát hiện Cloudflare Turnstile, dừng chờ từ từ ${(waitMs / 1000).toFixed(1)}s trước khi tương tác...`, 'info');
        await delay(waitMs);
        await tryClickTurnstile(page, { skipWait: true });
        await delay(process.env.VITEST ? 50 : 3_000);
      }
    }

    const elapsed = now() - startedAt;
    if (sawInteractive && elapsed >= INTERACTIVE_GIVE_UP_MS) {
      return { cleared: false, interactive: true };
    }

    if (sawInteractive && elapsed - lastProgressLog >= 15_000) {
      lastProgressLog = elapsed;
      const remainSec = Math.max(0, Math.round((INTERACTIVE_GIVE_UP_MS - elapsed) / 1000));
      sweepLogs.add(`⏳ Đang chờ Cloudflare nhả thử thách (còn khoảng ${remainSec}s)...`, 'info');
    }

    if (now() >= deadline) break;
    await delay(pollMs);
  }
  return { cleared: false, interactive: sawInteractive };
}

function challengeDetail(where: string, wait: { interactive: boolean }): string {
  return wait.interactive
    ? `Cloudflare chặn ${where} bằng thử thách tương tác — cần đổi IP`
    : `Cloudflare chặn ${where}`;
}

async function openPastChallenge(
  page: BrowserPage,
  url: string,
  options: {
    solver?: ChallengeSolver;
    log?: (message: string) => void;
    tolerateNavigationError?: boolean;
    timings?: { pollMs?: number; delay?: (ms: number) => Promise<void>; now?: () => number };
  } = {},
): Promise<ChallengeWait> {
  const log = options.log ?? (() => undefined);
  const { pollMs = CHALLENGE_POLL_MS, delay = sleep, now = Date.now } = options.timings ?? {};
  const solver = options.solver;

  const navigate = async (): Promise<void> => {
    await safeNavigate(page, url, { waitUntil: 'domcontentloaded', timeout: CHALLENGE_TIMEOUT_MS });
  };

  if (solver) {
    const primed = await solver.prime(page, url).catch(() => false);
    if (primed) log('  đã tiêm cf_clearance còn hạn trước khi mở trang');
  }

  await navigate();

  const graceMs = solver ? SOLVER_GRACE_MS : CHALLENGE_TIMEOUT_MS;
  const first = await waitForRealPage(page, pollMs, delay, now, graceMs);
  if (first.cleared || !solver) return first;

  const solved = await solver.solve(page, url);
  if (!solved.ok) {
    log(`  YesCaptcha không giải được: ${solved.detail}`);
    return waitForRealPage(page, pollMs, delay, now, CHALLENGE_TIMEOUT_MS - graceMs);
  }
  log(solved.reused ? '  dùng lại cf_clearance còn hạn, mở lại trang' : '  đã mua cf_clearance, mở lại trang');

  await navigate();
  return waitForRealPage(page, pollMs, delay, now, graceMs);
}

async function tagLoginForm(page: BrowserPage, rank = 0): Promise<number> {
  try {
    const count = (await (page.evaluate(
      `(() => {
        const rendered = (el) =>
          !!el && !!(el.offsetWidth || el.offsetHeight || el.getClientRects().length);

        const usable = (f) => {
          const login = f.querySelector('input[name=login]');
          const password = f.querySelector('input[name=password]');
          return !!login && !!password && rendered(login) && rendered(password);
        };

        const score = (f) => {
          let s = 0;
          if (f.id === 'pageLogin') s += 4;
          if (f.querySelector('input[name=login][autofocus]')) s += 2;
          if (rendered(f.querySelector('input[type=submit], button[type=submit]'))) s += 1;
          return s;
        };

        const cands = [...document.querySelectorAll('form')].filter(usable).sort((a, b) => score(b) - score(a));

        for (const el of document.querySelectorAll('[data-vault-form]')) el.removeAttribute('data-vault-form');
        const chosen = cands[${rank}];
        if (chosen) chosen.setAttribute('data-vault-form', '1');
        return cands.length;
      })()` as never,
    ) as Promise<number>).catch(() => 0)) as number;
    return count;
  } catch {
    return 0;
  }
}

export type LoginResult =
  | { ok: true; cookies?: { xfUser?: string; xfSession?: string } }
  | {
    ok: false;
    reason: 'challenged' | 'no_form' | 'bad_credentials' | 'two_factor' | 'form_mismatch';
    detail: string;
  };

const LOGIN_URL = 'https://www.spigotmc.org/login';

export async function loginToSpigot(
  page: BrowserPage,
  credential: Credential,
  timings: LoginTimings = {},
  solver?: ChallengeSolver,
): Promise<LoginResult> {
  if (solver) await solver.prime(page, LOGIN_URL).catch(() => false);

  const first = await attemptSpigotLogin(
    page,
    credential,
    solver ? { ...timings, challengeBudgetMs: timings.challengeBudgetMs ?? SOLVER_GRACE_MS } : timings,
  );
  if (first.ok || first.reason !== 'challenged' || !solver) return first;

  const solved = await solver.solve(page, LOGIN_URL);
  if (!solved.ok) {
    return {
      ok: false,
      reason: 'challenged',
      detail: `${first.detail}; YesCaptcha không giải được: ${solved.detail}`,
    };
  }
  return attemptSpigotLogin(page, credential, timings);
}

type LoginTimings = {
  settleMs?: number;
  pollMs?: number;
  typeDelayMs?: number;
  delay?: (ms: number) => Promise<void>;
  now?: () => number;
  challengeBudgetMs?: number;
  warmUp?: boolean;
};

async function attemptSpigotLogin(
  page: BrowserPage,
  credential: Credential,
  timings: LoginTimings = {},
): Promise<LoginResult> {
  const challengeBudgetMs = timings.challengeBudgetMs ?? CHALLENGE_TIMEOUT_MS;
  const settleMs = timings.settleMs ?? challengeBudgetMs;
  const pollMs = timings.pollMs ?? CHALLENGE_POLL_MS;
  const typeDelayMs = timings.typeDelayMs ?? 70;
  const delay = timings.delay ?? sleep;
  const now = timings.now ?? Date.now;

  // Bước 1: Làm ấm qua Root Domain (chuẩn Script 1) để nhận cf_clearance trước khi vào /login
  const shouldWarmUp = timings.warmUp ?? !process.env.VITEST;
  if (shouldWarmUp) {
    sweepLogs.add('🌐 Đang làm ấm phiên qua trang chủ spigotmc.org để nhận cf_clearance...', 'info');
    await safeNavigate(page, 'https://spigotmc.org', {
      waitUntil: 'domcontentloaded',
      timeout: 45_000,
    }).catch(() => undefined);
    // Dừng tĩnh 8s không can thiệp CDP để Cloudflare Turnstile hoàn tất kiểm tra
    await delay(Math.min(8000, timings.settleMs ?? 8000));
    const warmupTitle = await page.title().catch(() => '');
    if (/just a moment|checking your browser/i.test(warmupTitle)) {
      await delay(4000);
    }
  }

  // Bước 2: Điều hướng tới trang đăng nhập
  await safeNavigate(page, LOGIN_URL, {
    waitUntil: 'domcontentloaded',
    timeout: CHALLENGE_TIMEOUT_MS,
  });

  const loginWait = await waitForRealPage(page, pollMs, delay, now, challengeBudgetMs);
  if (!loginWait.cleared) {
    return { ok: false, reason: 'challenged', detail: challengeDetail('trang đăng nhập', loginWait) };
  }

  const formCount = await tagLoginForm(page);
  if (formCount === 0) {
    const stillLoggedIn = await (page.evaluate(
      `!!document.querySelector('.accountUsername, [data-logged-in="true"], a[href*="logout"]')` as never,
    ) as Promise<boolean>).catch(() => false);
    if (stillLoggedIn) return { ok: true };
    return { ok: false, reason: 'no_form', detail: 'không thấy form đăng nhập gửi được' };
  }

  const focusField = async (name: 'login' | 'password'): Promise<void> => {
    try {
      await page.evaluate(
        `(() => {
          const f = document.querySelector('form[data-vault-form]');
          if (!f) return;
          const e = f.querySelector('input[name=${name}]');
          if (!e) return;
          e.scrollIntoView({ block: 'center' });
          e.focus();
          e.value = '';
        })()` as never,
      );
    } catch { }
  };

  const typeInto = async (): Promise<{ login: string; passwordLength: number }> => {
    await focusField('login');
    await page.keyboard.type(credential.username, { delay: typeDelayMs }).catch(() => { });
    await focusField('password');
    await page.keyboard.type(credential.password, { delay: typeDelayMs }).catch(() => { });
    return fieldValues(page);
  };

  const fillDirect = async (name: 'login' | 'password', value: string): Promise<void> => {
    try {
      await page.evaluate(
        `(() => {
          const f = document.querySelector('form[data-vault-form]');
          if (!f) return;
          const e = f.querySelector('input[name=${name}]');
          if (!e) return;
          e.scrollIntoView({ block: 'center' });
          e.focus();
          const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
          setter.call(e, ${JSON.stringify(value)});
          e.dispatchEvent(new Event('input', { bubbles: true }));
          e.dispatchEvent(new Event('change', { bubbles: true }));
        })()` as never,
      );
    } catch { }
  };

  const isFilled = (v: { login: string; passwordLength: number }): boolean =>
    v.login === credential.username && v.passwordLength === credential.password.length;

  let filled = await typeInto();

  if (!isFilled(filled)) {
    await tagLoginForm(page, 0);
    await fillDirect('login', credential.username);
    await fillDirect('password', credential.password);
    filled = await fieldValues(page);
  }

  for (let rank = 1; rank < formCount && !isFilled(filled); rank++) {
    await tagLoginForm(page, rank);
    await fillDirect('login', credential.username);
    await fillDirect('password', credential.password);
    filled = await fieldValues(page);
  }

  if (filled.login !== credential.username || filled.passwordLength !== credential.password.length) {
    return {
      ok: false,
      reason: 'form_mismatch',
      detail:
        `không điền được form đăng nhập (thử ${formCount} form, ô tên nhận ` +
        `${filled.login === '' ? 'rỗng' : `"${filled.login}"`}) — ` +
        'lỗi ở trang Spigot, không phải sai mật khẩu',
    };
  }

  await page.evaluate(
    `(() => {
       const f = document.querySelector('form[data-vault-form]') || document.querySelector('#pageLogin') || document;
       const reg = f.querySelector('#ctrl_pageLogin_registered, input[name="register"][value="0"]');
       if (reg) {
         reg.checked = true;
         reg.dispatchEvent(new Event('change', { bubbles: true }));
       }
       const boxes = [...f.querySelectorAll('input[name=remember], #ctrl_pageLogin_remember')];
       const b = boxes.find((e) => e.offsetWidth || e.offsetHeight) || boxes[0];
       if (b && !b.checked) {
         b.checked = true;
         b.dispatchEvent(new Event('change', { bubbles: true }));
       }
    })()` as never,
  ).catch(() => { });

  // Giải Turnstile trước khi submit nếu xuất hiện widget
  await tryClickTurnstile(page);
  await delay(300);
  let submitted = false;
  try {
    const p = page as any;
    if (typeof p.$ === 'function') {
      const submitBtn = await p.$('form[data-vault-form] input[type=submit], form[data-vault-form] button[type=submit], #pageLogin input.button.primary');
      if (submitBtn) {
        await page.evaluate(
          `(() => {
            const b = document.querySelector('form[data-vault-form] input[type=submit], form[data-vault-form] button[type=submit], #pageLogin input.button.primary');
            if (b) b.scrollIntoView({ block: 'center' });
          })()` as never,
        ).catch(() => { });
        await delay(150);
        await submitBtn.click({ delay: 50 });
        submitted = true;
      }
    }
  } catch { }

  if (!submitted) {
    try {
      if (page.keyboard) {
        await page.keyboard.press('Enter');
        submitted = true;
      }
    } catch { }
  }

  if (!submitted) {
    await page.evaluate(
      `(() => {
        const f = document.querySelector('form[data-vault-form]') || document.querySelector('#pageLogin');
        if (!f) return;
        const b = f.querySelector('input[type=submit], button[type=submit], input.button.primary');
        if (b) b.click();
        else if (f.requestSubmit) f.requestSubmit();
      })()` as never,
    ).catch(() => { });
  }

  const postSubmitWait = await waitForRealPage(page, pollMs, delay, now, settleMs);
  if (!postSubmitWait.cleared) {
    // Thử click Turnstile cho Cloudflare post-submit verification
    const waitMs = process.env.VITEST ? 50 : 3000 + Math.floor(Math.random() * 2000);
    sweepLogs.add(`🛡️ Đăng nhập gặp thử thách Cloudflare, chờ từ từ ${(waitMs / 1000).toFixed(1)}s trước khi ấn...`, 'info');
    await delay(waitMs);
    await tryClickTurnstile(page, { skipWait: true });
    await delay(process.env.VITEST ? 50 : 3000);
    const retryWait = await waitForRealPage(page, pollMs, delay, now, 10_000);
    if (!retryWait.cleared) {
      return { ok: false, reason: 'challenged', detail: 'Cloudflare chặn ngay sau khi gửi form đăng nhập' };
    }
  }

  const loginWaitBudget = timings.settleMs ?? 15_000;
  const loginDeadline = now() + loginWaitBudget;
  const pollInterval = Math.min(1000, Math.max(0, timings.pollMs ?? 1000));
  let loggedIn = false;
  do {
    const curTitle = await page.title().catch(() => '');
    if (/just a moment|checking your browser|security/i.test(curTitle)) {
      await tryClickTurnstile(page);
    }

    loggedIn = await (page.evaluate(
      `!!document.querySelector('.accountUsername, [data-logged-in="true"], a[href*="logout"]')` as never,
    ) as Promise<boolean>).catch(() => false);
    if (loggedIn) break;

    const early = await readLoginFailure(page);
    if (early.message !== '' || early.needsTwoFactor) break;
    if (now() >= loginDeadline) break;
    await delay(pollInterval);
  } while (now() < loginDeadline);

  if (loggedIn) {
    let cookies: { xfUser?: string; xfSession?: string } | undefined = undefined;
    if (typeof (page as any).cookies === 'function') {
      try {
        const allCookies = (await (page as any).cookies()) as Array<{ name: string; value: string }>;
        const xfUser = allCookies.find((c) => c.name === 'xf_user')?.value;
        const xfSession = allCookies.find((c) => c.name === 'xf_session')?.value;
        if (xfUser || xfSession) {
          cookies = { xfUser, xfSession };
        }
      } catch {
        // Bỏ qua lỗi cookies
      }
    }
    return { ok: true, ...(cookies ? { cookies } : {}) };
  }

  const state = await readLoginFailure(page);

  if (state.needsTwoFactor) {
    return {
      ok: false,
      reason: 'two_factor',
      detail: 'tài khoản bật xác thực hai lớp (2FA) — bot không vượt được, hãy tắt 2FA hoặc dùng tài khoản khác',
    };
  }

  if (state.message) {
    const hint = /password|incorrect|mật khẩu/i.test(state.message)
      ? ' — kiểm tra tệp tài khoản bằng `npm run check-accounts` trước khi đổi mật khẩu'
      : '';
    return { ok: false, reason: 'bad_credentials', detail: `${state.message}${hint}` };
  }

  if (state.stillOnLoginPage && state.filledUsername !== credential.username) {
    const seen = state.filledUsername === '' ? 'rỗng' : `"${state.filledUsername}"`;
    return {
      ok: false,
      reason: 'form_mismatch',
      detail:
        `ô tên đăng nhập ${seen} thay vì "${credential.username}" — chữ không vào được ô, ` +
        'không phải sai mật khẩu',
    };
  }

  return {
    ok: false,
    reason: 'bad_credentials',
    detail:
      `không vào được (tiêu đề: "${state.title}"` +
      `${state.stillOnLoginPage ? ', vẫn ở trang đăng nhập' : ''}` +
      `${state.filledUsername ? `, ô tên: "${state.filledUsername}"` : ''})`,
  };
}

async function fieldValues(page: BrowserPage): Promise<{ login: string; passwordLength: number }> {
  try {
    const raw = (await (page.evaluate(
      `(() => {
        const f = document.querySelector('form[data-vault-form]');
        if (!f) return JSON.stringify({ login: '', passwordLength: 0 });
        const l = f.querySelector('input[name=login]');
        const p = f.querySelector('input[name=password]');
        return JSON.stringify({ login: l ? l.value || '' : '', passwordLength: p ? (p.value || '').length : 0 });
      })()` as never,
    ) as Promise<string>).catch(() => '')) as string;

    if (!raw) return { login: '', passwordLength: 0 };
    return JSON.parse(raw) as { login: string; passwordLength: number };
  } catch {
    return { login: '', passwordLength: 0 };
  }
}

async function readLoginFailure(page: BrowserPage): Promise<{
  title: string;
  message: string;
  stillOnLoginPage: boolean;
  needsTwoFactor: boolean;
  filledUsername: string;
}> {
  try {
    const raw = (await (page.evaluate(
      `(() => {
        const text = (document.body ? document.body.textContent || '' : '').slice(0, 3000);
        const msg = [...document.querySelectorAll('.errors,.errorPanel,.blockMessage,.error,.errorOverlay,.js-errorMessage,.blockMessage--error')]
          .map((e) => (e.textContent || '').trim())
          .filter(Boolean)[0] || '';
        const scoped = document.querySelector('form[data-vault-form]');
        const userInput = (scoped || document).querySelector('input[name=login]');
        return JSON.stringify({
          title: document.title,
          message: msg.slice(0, 200),
          stillOnLoginPage: !!document.querySelector('input[name=password]'),
          needsTwoFactor:
            location.href.indexOf('two-step') !== -1 ||
            /two.step|two.factor|xác thực hai/i.test(text),
          filledUsername: userInput ? userInput.value || '' : '',
        });
      })()` as never,
    ) as Promise<string>).catch(() => '')) as string;

    if (!raw) {
      return { title: '', message: '', stillOnLoginPage: false, needsTwoFactor: false, filledUsername: '' };
    }
    return JSON.parse(raw) as {
      title: string;
      message: string;
      stillOnLoginPage: boolean;
      needsTwoFactor: boolean;
      filledUsername: string;
    };
  } catch {
    return { title: '', message: '', stillOnLoginPage: false, needsTwoFactor: false, filledUsername: '' };
  }
}

async function readPageMessage(page: BrowserPage): Promise<string> {
  return (await (page.evaluate(
    `[...document.querySelectorAll('.errors,.errorPanel,.blockMessage,.error,.errorOverlay,.resourceAlert')]
       .map((e) => (e.textContent || '').trim()).filter(Boolean).slice(0, 2).join(' ').slice(0, 200)` as never,
  ) as Promise<string>).catch(() => '')) as string;
}

async function findDownloadHref(page: BrowserPage): Promise<string | null> {
  const href = (await (page.evaluate(
    `(() => {
      const links = [...document.querySelectorAll('a[href*="download"]')]
        .map((a) => a.getAttribute('href') || '')
        .filter((h) => h.indexOf('/download') !== -1 || h.indexOf('download?') !== -1);
      const withVersion = links.filter((h) => h.indexOf('version=') !== -1);
      return (withVersion[0] || links[0] || '');
    })()` as never,
  ) as Promise<string>).catch(() => '')) as string;

  if (!href) return null;
  return absolute(href);
}

function absolute(href: string): string {
  return href.startsWith('http') ? href : `https://www.spigotmc.org/${href.replace(/^\//, '')}`;
}

async function pageHtml(page: BrowserPage): Promise<string> {
  return (await (page.evaluate(
    `document.documentElement ? document.documentElement.outerHTML : ''` as never,
  ) as Promise<string>).catch(() => '')) as string;
}

export async function downloadViaBrowser(
  deps: BrowserDownloadDeps,
  page: BrowserPage,
  resourceId: number,
  versionName?: string,
): Promise<DownloadOutcome> {
  const log = deps.log ?? (() => undefined);
  let dir = '';

  try {
    dir = resolve(deps.tmpDir, `spigot-dl-${randomUUID()}`);
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(dir, { recursive: true });

    log(`resource ${resourceId}: mở trang`);

    const resourceWait = await openPastChallenge(page, `https://www.spigotmc.org/resources/${resourceId}/`, {
      ...(deps.solver ? { solver: deps.solver } : {}),
      ...(deps.challengeTimings ? { timings: deps.challengeTimings } : {}),
      log,
    });
    if (!resourceWait.cleared) {
      const detail = challengeDetail('trang resource', resourceWait);
      log(`resource ${resourceId}: ${detail}`);
      return { status: 'challenged', detail };
    }
    log(`resource ${resourceId}: trang mở được, đang tìm link tải`);

    const pageTitle = await page.title().catch(() => '');
    const pageMsg = await readPageMessage(page);
    if (/must be logged in|log in or sign up/i.test(pageMsg)) {
      log(`resource ${resourceId}: phiên đăng nhập đã hết hạn`);
      return { status: 'cookie_dead' };
    }
    if (/not be found|no longer available|deleted|do not have permission/i.test(pageMsg) || /do not have permission/i.test(pageTitle)) {
      log(`resource ${resourceId}: tài nguyên không tồn tại hoặc đã bị xoá trên Spigot (${pageTitle || pageMsg})`);
      return { status: 'gone', detail: 'plugin đã bị xoá trên Spigot' };
    }

    const isResourceStatus = await (page.evaluate(`(() => {
      const text = document.body ? document.body.innerText || '' : '';
      if (/do not have permission to view this page|not have permission to perform this action/i.test(text)) return 'gone';
      if (/not have access|must purchase|buy this/i.test(text)) return 'not_owned';
      const buy = document.querySelector('a[href*="/purchase"], a[href*="/buy"], .price');
      const dl = document.querySelector('a[href*="/download"], label.downloadButton');
      return (buy && !dl) ? 'not_owned' : null;
    })()` as never) as Promise<string | null>).catch(() => null);

    if (isResourceStatus === 'gone') {
      log(`resource ${resourceId}: trang báo không có quyền xem — plugin đã bị xoá khỏi Spigot`);
      return { status: 'gone', detail: 'plugin đã bị xoá trên Spigot' };
    }
    if (isResourceStatus === 'not_owned') {
      log(`resource ${resourceId}: tài khoản không sở hữu plugin này (chưa mua)`);
      return { status: 'not_owned' };
    }

    let downloadUrl: string | null = null;

    if (versionName) {
      if (deps.fetchImpl) {
        const publicPage = await fetchPublicPage(
          { fetchImpl: deps.fetchImpl, ...(deps.signal ? { signal: deps.signal } : {}) },
          historyUrl(resourceId),
        );
        if (publicPage.ok) {
          const publicId = findVersionId(publicPage.html, versionName);
          if (publicId !== null) {
            downloadUrl = downloadUrlFor(resourceId, publicId);
            log(`resource ${resourceId}: lấy được id bản ${versionName} không cần trình duyệt`);
          }
        }
      }

      const pages = downloadUrl
        ? []
        : [
          `https://www.spigotmc.org/resources/${resourceId}/history`,
          `https://www.spigotmc.org/resources/${resourceId}/updates`,
        ];

      let sawLoginWall = false;
      for (const url of pages) {
        const historyWait = await openPastChallenge(page, url, {
          ...(deps.solver ? { solver: deps.solver } : {}),
          ...(deps.challengeTimings ? { timings: deps.challengeTimings } : {}),
          log,
          tolerateNavigationError: true,
        });
        if (!historyWait.cleared) {
          return { status: 'challenged', detail: challengeDetail('trang lịch sử', historyWait) };
        }

        const html = await pageHtml(page);
        if (/must be logged in|log in or sign up/i.test(html)) {
          sawLoginWall = true;
          continue;
        }

        const versionId = findVersionId(html, versionName);
        if (versionId !== null) {
          downloadUrl = downloadUrlFor(resourceId, versionId);
          break;
        }
      }

      if (!downloadUrl) {
        const mainDl = await findDownloadHref(page);
        if (mainDl) {
          log(`resource ${resourceId}: dùng link tải từ trang chính cho bản ${versionName}`);
          downloadUrl = mainDl;
        }
      }

      if (!downloadUrl) {
        if (sawLoginWall) {
          log(`resource ${resourceId}: trang lịch sử đòi đăng nhập`);
          return { status: 'cookie_dead' };
        }

        const isHistoryStatus = await (page.evaluate(
          `(() => {
            const text = document.body ? document.body.innerText || '' : '';
            if (/do not have permission to view this page|not have permission to perform this action/i.test(text)) return 'gone';
            if (/not have access|must purchase|buy this/i.test(text)) return 'not_owned';
            const buy = document.querySelector('a[href*="/purchase"], a[href*="/buy"], .price, .resourceAlert');
            const dl = document.querySelector('a[href*="/download"]');
            return (buy && !dl) ? 'not_owned' : null;
          })()` as never,
        ) as Promise<string | null>).catch(() => null);

        if (isHistoryStatus === 'gone') {
          log(`resource ${resourceId}: trang lịch sử báo không có quyền xem — plugin đã bị xoá khỏi Spigot`);
          return { status: 'gone', detail: 'plugin đã bị xoá trên Spigot' };
        }
        if (isHistoryStatus === 'not_owned') {
          log(`resource ${resourceId}: tài khoản không sở hữu plugin này (chưa mua)`);
          return { status: 'not_owned' };
        }

        log(`resource ${resourceId}: không thấy bản ${versionName} ở trang lịch sử đầu tiên`);
        return {
          status: 'incomplete',
          detail: `không thấy bản ${versionName} ở trang lịch sử (có thể ở trang sau)`,
        };
      }
    } else {
      downloadUrl = (await findDownloadHref(page)) ?? `https://www.spigotmc.org/resources/${resourceId}/download`;
    }

    log(`  link tải: ${downloadUrl}`);

    const cdp = await page.createCDPSession();
    try {
      let cdpDownloadOk = false;
      try {
        await cdp.send('Page.setDownloadBehavior', { behavior: 'allow', downloadPath: dir });
        cdpDownloadOk = true;
      } catch (e) {
        log(`resource ${resourceId}: Page.setDownloadBehavior thất bại: ${e instanceof Error ? e.message : String(e)}`);
      }
      try {
        await cdp.send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: dir, eventsEnabled: true });
        cdpDownloadOk = true;
      } catch (e) {
        log(`resource ${resourceId}: Browser.setDownloadBehavior thất bại: ${e instanceof Error ? e.message : String(e)}`);
      }
      if (!cdpDownloadOk) {
        log(`resource ${resourceId}: CẢNH BÁO — không set được download path qua CDP`);
      }

      // Cách 1: Tải trực tiếp trong phiên Context của Chrome (Ưu tiên Blob Direct Stream, fallback Base64)
      log(`resource ${resourceId}: đang tải qua fetch trong trình duyệt…`);
      const fetchOutcomeRaw = await (page.evaluate(
        `(async () => {
          try {
            const res = await fetch(${JSON.stringify(downloadUrl)}, {
              credentials: 'include',
              redirect: 'follow',
            });
            if (!res.ok) {
              const text = await res.text().catch(() => '').then((t) => t.slice(0, 300));
              return JSON.stringify({ ok: false, status: res.status, text });
            }
            const blob = await res.blob();
            if (blob.size >= 1024) {
              try {
                const blobUrl = URL.createObjectURL(blob);
                const a = document.createElement('a');
                a.href = blobUrl;
                a.download = 'download.jar';
                document.body.appendChild(a);
                a.click();
                setTimeout(() => {
                  try { document.body.removeChild(a); } catch { }
                  URL.revokeObjectURL(blobUrl);
                }, 10000);
                return JSON.stringify({ ok: true, directStream: true, size: blob.size });
              } catch { }
            }

            // Fallback sang Base64 nếu không trigger được Direct Blob Download
            const buf = await blob.arrayBuffer();
            const bytes = new Uint8Array(buf);
            const CHUNK = 32768;
            let binary = '';
            for (let i = 0; i < bytes.length; i += CHUNK) {
              binary += String.fromCharCode.apply(
                null,
                bytes.subarray(i, Math.min(i + CHUNK, bytes.length)),
              );
            }
            return JSON.stringify({ ok: true, data: btoa(binary), size: bytes.length });
          } catch (e) {
            return JSON.stringify({ ok: false, error: String(e) });
          }
        })()` as never,
      ) as Promise<string>).catch(() => null);

      type FetchOutcome =
        | { ok: true; directStream?: boolean; data?: string; size: number }
        | { ok: false; status?: number; text?: string; error?: string };
      let fetchOutcome: FetchOutcome | null = null;

      if (fetchOutcomeRaw) {
        try { fetchOutcome = JSON.parse(fetchOutcomeRaw) as FetchOutcome; } catch { }

        if (fetchOutcome?.ok) {
          const { directStream, data, size } = fetchOutcome;
          if (size < MIN_PLAUSIBLE_BYTES) {
            log(`resource ${resourceId}: fetch trả về file quá nhỏ (${size} byte) — bỏ qua, thử lại qua CDP`);
          } else if (size > deps.maxBytes) {
            return { status: 'error', detail: `tệp ${size} byte vượt giới hạn ${deps.maxBytes}` };
          } else if (directStream) {
            log(`resource ${resourceId}: đã kích hoạt direct stream nhị phân (${(size / 1048576).toFixed(2)} MB), đang chờ tệp ghi đĩa…`);
            // Chờ một khoảng ngắn cho tệp rơi vào dir
            await sleep(500);
          } else if (data) {
            const fileBuffer = Buffer.from(data, 'base64');
            if (fileBuffer.subarray(0, 2).toString() !== 'PK') {
              const text = fileBuffer.subarray(0, 200).toString('utf8');
              if (/must be logged in|log in to/i.test(text)) {
                log(`resource ${resourceId}: fetch trả về trang đăng nhập — phiên hết hạn`);
                return { status: 'cookie_dead' };
              }
              if (/do not have permission|not have access|must purchase|buy this/i.test(text)) {
                log(`resource ${resourceId}: fetch trả về trang lỗi quyền truy cập`);
                return { status: 'not_owned' };
              }
              if (/just a moment|checking your browser/i.test(text)) {
                log(`resource ${resourceId}: fetch bị chặn bởi Cloudflare`);
                return { status: 'challenged', detail: 'Cloudflare chặn khi tải qua fetch' };
              }
              log(`resource ${resourceId}: fetch trả về nội dung không phải jar (${size} byte) — thử CDP`);
            } else {
              const partPath = join(deps.tmpDir, `spigot-${randomUUID()}.jar.part`);
              const finalPath = join(deps.tmpDir, `spigot-${randomUUID()}.jar`);
              try {
                await writeFile(partPath, fileBuffer);
                const sha256 = createHash('sha256').update(fileBuffer).digest('hex');
                if (deps.expectedSha256 && sha256.toLowerCase() !== deps.expectedSha256.toLowerCase()) {
                  await unlink(partPath).catch(() => undefined);
                  log(`resource ${resourceId}: SHA256 không khớp (${sha256} != ${deps.expectedSha256})`);
                  return {
                    status: 'incomplete',
                    detail: `SHA256 không khớp (${sha256.slice(0, 12)}… != ${deps.expectedSha256.slice(0, 12)}…)`,
                  };
                }
                await rename(partPath, finalPath);
                log(`resource ${resourceId}: tải xong ${(size / 1048576).toFixed(2)} MB (SHA256: ${sha256.slice(0, 12)}… qua fetch fallback)`);
                return { status: 'ok', tmpPath: finalPath, bytes: size, rotated: null };
              } catch (writeErr) {
                await unlink(partPath).catch(() => undefined);
                throw writeErr;
              }
            }
          }
        } else if (fetchOutcome && !fetchOutcome.ok) {
          const fo = fetchOutcome as { ok: false; status?: number; text?: string; error?: string };
          log(`resource ${resourceId}: fetch thất bại (${fo.error ?? `HTTP ${fo.status ?? '?'}`}) — thử CDP`);
          const errText = (fo.text ?? fo.error ?? '').toLowerCase();
          if (/must be logged in|log in to/.test(errText)) return { status: 'cookie_dead' };
          if (/do not have permission|not have access|must purchase|buy this/.test(errText)) return { status: 'not_owned' };
        }
      }

      let directStreamTriggered = false;
      if (fetchOutcome?.ok && fetchOutcome.directStream) {
        directStreamTriggered = true;
      }

      if (!directStreamTriggered) {
        // Cách 2: Tải dự phòng bằng CDP + goto
        log(`resource ${resourceId}: thử tải qua CDP + goto (dự phòng)…`);

        const openDownload = (): Promise<unknown> =>
          page.goto(downloadUrl, { waitUntil: 'domcontentloaded', timeout: 60_000 }).catch(() => undefined);
        if (deps.solver) await deps.solver.prime(page, downloadUrl).catch(() => false);
        await openDownload();

        let landedTitle = await page.title().catch(() => '');
        if (/just a moment|checking your browser|attention required|cloudflare/i.test(landedTitle)) {
          if (deps.solver) {
            const solved = await deps.solver.solve(page, `https://www.spigotmc.org/resources/${resourceId}/`);
            if (solved.ok) {
              log(
                `resource ${resourceId}: ${solved.reused ? 'dùng lại cf_clearance' : 'đã mua cf_clearance'} — tải lại`,
              );
              try { await cdp.send('Page.setDownloadBehavior', { behavior: 'allow', downloadPath: dir }); } catch { }
              try { await cdp.send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: dir, eventsEnabled: true }); } catch { }
              await openDownload();
              landedTitle = await page.title().catch(() => '');
            } else {
              log(`resource ${resourceId}: YesCaptcha không giải được: ${solved.detail}`);
              return { status: 'challenged', detail: `Cloudflare chặn khi tải (${solved.detail})` };
            }
          } else {
            log(`resource ${resourceId}: Cloudflare chặn endpoint tải (chưa cấu hình YesCaptcha)`);
            return { status: 'challenged', detail: 'Cloudflare chặn khi tải' };
          }
        }

        const early = await readPageMessage(page);
        const landedUnowned = await (page.evaluate(`(() => {
          const text = document.body ? document.body.innerText || '' : '';
          if (/do not have permission|not have access|must purchase|buy this/i.test(text)) return 'not_owned';
          if (/must be logged in|log in to/i.test(text)) return 'cookie_dead';
          const buy = document.querySelector('a[href*="/purchase"], a[href*="/buy"], .price');
          const dl = document.querySelector('a[href*="/download"], label.downloadButton');
          if (buy && !dl) return 'not_owned';
          return null;
        })()` as never) as Promise<string | null>).catch(() => null);

        if (landedUnowned === 'not_owned' || /do not have permission|not have access|must purchase|buy this/i.test(early)) {
          log(`resource ${resourceId}: trang nói không có quyền tải`);
          return { status: 'not_owned' };
        }
        if (landedUnowned === 'cookie_dead' || /must be logged in|log in to/i.test(early)) {
          log(`resource ${resourceId}: trang nói chưa đăng nhập`);
          return { status: 'cookie_dead' };
        }
      }

      const waitTimeoutMs = deps.downloadWaitMs ?? DOWNLOAD_WAIT_MS;
      const START_TIMEOUT_MS = Math.min(25_000, waitTimeoutMs);
      const deadline = Date.now() + waitTimeoutMs;
      const startDeadline = Date.now() + START_TIMEOUT_MS;
      let lastReport = 0;
      let downloadStarted = false;

      while (Date.now() < deadline) {
        if (deps.signal?.aborted) return { status: 'error', detail: 'đang tắt tiến trình' };
        deps.onHeartbeat?.();
        await abortableSleep(Math.min(2_000, waitTimeoutMs), deps.signal);
        if (deps.signal?.aborted) return { status: 'error', detail: 'đang tắt tiến trình' };

        try {
          await page.title();
        } catch (err) {
          if (isChromeClosedError(err)) {
            log(`resource ${resourceId}: Chrome đã bị đóng trong lúc chờ tải`);
            return {
              status: 'error',
              detail: `chrome_abruptly_closed: ${err instanceof Error ? err.message : String(err)}`,
            };
          }
        }

        const partial = await readdir(dir);
        let bytes = 0;
        for (const file of partial) {
          bytes += await stat(join(dir, file)).then(
            (s) => s.size,
            () => 0,
          );
        }

        if (partial.length > 0 || bytes > 0) {
          downloadStarted = true;
          deps.onHeartbeat?.();
          deps.onProgress?.(bytes, 'downloading');
        }

        if (Date.now() - lastReport > 10_000) {
          lastReport = Date.now();
          log(`resource ${resourceId}: đang tải… ${partial.length} tệp, ${(bytes / 1048576).toFixed(1)} MB`);
        }

        if (!downloadStarted && Date.now() > startDeadline) {
          const title = await page.title().catch(() => '');
          const currentMsg = await readPageMessage(page);
          log(`resource ${resourceId}: không có tệp nào tải về sau 25s — tiêu đề "${title}", trang: ${currentMsg.slice(0, 100)}`);

          if (/just a moment|checking your browser|attention required|cloudflare/i.test(title)) {
            return { status: 'challenged', detail: 'Cloudflare chặn khi tải' };
          }
          if (/do not have permission to view this page|not have permission to perform this action|not be found|no longer available|deleted/i.test(currentMsg) || /do not have permission/i.test(title)) {
            return { status: 'gone', detail: 'plugin đã bị xoá trên Spigot' };
          }
          if (/do not have permission|not have access|must purchase|buy this/i.test(currentMsg) || /error\s*\|/i.test(title)) {
            return { status: 'not_owned' };
          }
          return { status: 'incomplete', detail: `trình duyệt không nhận được tệp sau 25s (tiêu đề: "${title}")` };
        }

        const files = (await readdir(dir)).filter((f) => !f.endsWith('.crdownload'));
        if (files.length === 0) continue;

        const path = join(dir, files[0]!);
        const size = (await stat(path)).size;
        if (size < MIN_PLAUSIBLE_BYTES) continue;
        if (size > deps.maxBytes) {
          return { status: 'error', detail: `tệp ${size} byte vượt giới hạn ${deps.maxBytes}` };
        }

        const head = await readHead(path, 200);
        if (head.subarray(0, 2).toString() !== 'PK') {
          const text = head.toString('utf8').replace(/\s+/g, ' ');
          log(`resource ${resourceId}: tệp không phải jar (${size} byte) — đầu tệp: ${text.slice(0, 120)}`);
          return { status: 'incomplete', detail: `tải về không phải jar (${size} byte)` };
        }

        const partPath = join(deps.tmpDir, `spigot-${randomUUID()}.jar.part`);
        const finalPath = join(deps.tmpDir, `spigot-${randomUUID()}.jar`);
        try {
          await rename(path, partPath);
          const fileBytes = await readFile(partPath);
          if (fileBytes.length !== size) {
            await unlink(partPath).catch(() => undefined);
            return { status: 'incomplete', detail: `kích thước tệp không khớp (${fileBytes.length} != ${size})` };
          }
          const sha256 = createHash('sha256').update(fileBytes).digest('hex');
          if (deps.expectedSha256 && sha256.toLowerCase() !== deps.expectedSha256.toLowerCase()) {
            await unlink(partPath).catch(() => undefined);
            log(`resource ${resourceId}: SHA256 không khớp (${sha256} != ${deps.expectedSha256})`);
            return {
              status: 'incomplete',
              detail: `SHA256 không khớp (${sha256.slice(0, 12)}… != ${deps.expectedSha256.slice(0, 12)}…)`,
            };
          }
          await rename(partPath, finalPath);
          log(`resource ${resourceId}: tải xong ${(size / 1048576).toFixed(2)} MB (SHA256: ${sha256.slice(0, 12)}…) — ${files[0]}`);
          return { status: 'ok', tmpPath: finalPath, bytes: size, rotated: null };
        } catch (renameErr) {
          await unlink(partPath).catch(() => undefined);
          throw renameErr;
        }
      }

      const message = await readPageMessage(page);
      const title = await page.title().catch(() => '');
      log(`resource ${resourceId}: hết thời gian chờ — tiêu đề "${title}", trang nói: ${message.slice(0, 120)}`);

      if (/just a moment|checking your browser/i.test(title)) {
        return { status: 'challenged', detail: 'Cloudflare chặn khi tải' };
      }
      if (/must be logged in|log in to/i.test(message)) return { status: 'cookie_dead' };
      if (/do not have permission|not have access|purchase/i.test(message)) return { status: 'not_owned' };
      if (/not be found|no longer available|deleted/i.test(message)) return { status: 'gone' };
      return { status: 'error', detail: message || 'không tải được, không rõ lý do' };
    } finally {
      await cdp.detach?.().catch(() => undefined);
    }
  } catch (err) {
    if (isChromeClosedError(err)) {
      return {
        status: 'error',
        detail: `chrome_abruptly_closed: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
    return { status: 'error', detail: err instanceof Error ? err.message : String(err) };
  } finally {
    if (dir) {
      rmSync(dir, { recursive: true, force: true });
    }
  }
}