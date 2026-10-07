import { exec } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BrowserLaunchOptions, BrowserLauncher, BrowserSession } from './download-via-browser.js';
import { createAbruptCloseTracker, type AbruptCloseTracker } from './chrome-close-detector.js';
import { cloakSessionManager, type SessionLockHandle } from './cloak-session-manager.js';
import { accountMutexManager, type AccountLockHandle } from './account-mutex-manager.js';
import { createDeadlineBudget, type DeadlineBudget, JobTimeoutError } from './deadline-budget.js';
import { injectCookiesFromAccountFile } from './spigot-cookie-files.js';
import {
  captureProcessIdentity,
  terminateProcessTree,
  type ProcessIdentity,
} from './process-tree-killer.js';

export function makeWindowsProcessVisible(pid?: number): void {
  if (process.platform !== 'win32') return;
  const psScript = `
Add-Type -TypeDefinition @"
using System;
using System.Text;
using System.Runtime.InteropServices;
public class WinShow {
    public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);
    [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
    [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
    [DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc enumProc, IntPtr lParam);
    [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint pid);
    [DllImport("user32.dll", CharSet = CharSet.Auto)] public static extern int GetClassName(IntPtr hWnd, StringBuilder lpClassName, int nMaxCount);

    public static void ShowChromeWindows(int[] pids) {
        var pidSet = new System.Collections.Generic.HashSet<uint>();
        foreach (var p in pids) pidSet.Add((uint)p);
        EnumWindows((h, l) => {
            uint p;
            GetWindowThreadProcessId(h, out p);
            if (pidSet.Contains(p)) {
                var sb = new StringBuilder(256);
                GetClassName(h, sb, 256);
                if (sb.ToString() == "Chrome_WidgetWin_1") {
                    ShowWindow(h, 9);
                    ShowWindow(h, 5);
                    SetForegroundWindow(h);
                }
            }
            return true;
        }, IntPtr.Zero);
    }
}
"@
$targetPid = ${pid && pid > 0 ? pid : 0}
if ($targetPid -gt 0) {
    [WinShow]::ShowChromeWindows(@($targetPid))
} else {
    $chromePids = (Get-Process chrome -ErrorAction SilentlyContinue).Id
    if ($chromePids) {
        [WinShow]::ShowChromeWindows($chromePids)
    }
}
`;

  const encoded = Buffer.from(psScript, 'utf16le').toString('base64');
  exec(`powershell -NoProfile -NonInteractive -EncodedCommand ${encoded}`, () => { });
}

export type CloakModule = {
  launch: (options?: Record<string, unknown>) => Promise<{
    close: () => Promise<void>;
    process?: () => { kill: (signal?: NodeJS.Signals | number) => boolean; pid?: number } | null;
    pages: () => Promise<unknown[]>;
    newPage: () => Promise<unknown>;
  }>;
};

export type LauncherProbe =
  | { available: true; launch: BrowserLauncher; isGuiWindow?: boolean; gpuEnabled?: boolean }
  | { available: false; reason: string };

export async function closeBrowser(
  browser: {
    close: () => Promise<void>;
    process?: () => { kill: (signal?: NodeJS.Signals | number) => boolean; pid?: number } | null;
  },
  timeoutMs = 8_000,
  expectedIdentity?: ProcessIdentity,
): Promise<void> {
  let timer: NodeJS.Timeout | null = null;
  try {
    const proc = browser.process?.();
    const pid = (proc as { pid?: number })?.pid;
    const identity = expectedIdentity ?? (pid && pid > 0 ? await captureProcessIdentity(pid) : null);

    const graceful = await Promise.race([
      browser.close().then(
        () => true,
        () => false,
      ),
      new Promise<boolean>((resolve) => {
        timer = setTimeout(() => resolve(false), timeoutMs);
        timer.unref();
      }),
    ]);
    if (!graceful) {
      if (pid && typeof pid === 'number' && pid > 0) {
        await terminateProcessTree(pid, identity ?? undefined);
      } else if (proc) {
        try {
          proc.kill('SIGKILL');
        } catch { }
      }
    }
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export function puppeteerCacheChrome(home = homedir()): string | null {
  const base = join(home, '.cache', 'puppeteer', 'chrome');
  if (!existsSync(base)) return null;
  try {
    const builds = readdirSync(base).sort().reverse();
    for (const build of builds) {
      for (const leaf of [
        'chrome-linux64/chrome',
        'chrome-linux/chrome',
        'chrome-win64/chrome.exe',
        'chrome-win/chrome.exe',
        'chrome-win32/chrome.exe',
      ]) {
        const candidate = join(base, build, leaf);
        if (existsSync(candidate)) return candidate;
      }
    }
  } catch { }
  return null;
}

export function accountProfileDir(base: string, label: string): string {
  const safe = label.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 40) || 'acc';
  let hash = 0;
  for (let i = 0; i < label.length; i++) hash = (hash * 31 + label.charCodeAt(i)) >>> 0;
  return join(base, `${safe}-${hash.toString(36)}`);
}

export function pruneOrphanProfiles(base: string, knownLabels: Iterable<string>): number {
  if (!existsSync(base)) return 0;
  const keep = new Set<string>();
  for (const label of knownLabels) keep.add(accountProfileDir(base, label));

  let removed = 0;
  try {
    for (const name of readdirSync(base)) {
      if (!/-[0-9a-z]+$/.test(name)) continue;
      const full = join(base, name);
      if (keep.has(full)) continue;
      try {
        rmSync(full, { recursive: true, force: true });
        removed++;
      } catch { }
    }
  } catch { }
  return removed;
}

let memoizedChrome: { key?: string; resolved: string | null } | null = null;

export function invalidateChromePathCache(): void {
  memoizedChrome = null;
}

export function resolveChromePath(configured?: string): string | null {
  const key = configured ?? '';
  if (memoizedChrome && memoizedChrome.key === key) {
    if (memoizedChrome.resolved && existsSync(memoizedChrome.resolved)) {
      return memoizedChrome.resolved;
    }
    if (memoizedChrome.resolved === null) {
      return null;
    }
  }

  let resolved: string | null = null;
  if (configured && existsSync(configured)) {
    resolved = configured;
  }
  memoizedChrome = { key, resolved };
  return resolved;
}

export function chromeConfig(configured?: string): { customConfig?: { chromePath: string } } {
  const resolved = resolveChromePath(configured ?? process.env.CHROME_PATH);
  return resolved ? { customConfig: { chromePath: resolved } } : {};
}

export function clearStaleProfileLocks(profileDir: string): void {
  if (!existsSync(profileDir)) return;
  for (const name of ['SingletonLock', 'SingletonCookie', 'SingletonSocket']) {
    try {
      rmSync(join(profileDir, name), { force: true });
    } catch { }
  }
}

export type WarmBrowserInstance = {
  close: () => Promise<void>;
  process?: () => { kill: (signal?: NodeJS.Signals | number) => boolean; pid?: number } | null;
  pages: () => Promise<unknown[]>;
  newPage: () => Promise<unknown>;
  isConnected?: () => boolean;
};

export class WarmBrowserManager {
  private static instance: WarmBrowserManager | null = null;
  private warmBrowser: WarmBrowserInstance | null = null;
  private warmDir: string | null = null;

  public static getInstance(): WarmBrowserManager {
    if (!WarmBrowserManager.instance) {
      WarmBrowserManager.instance = new WarmBrowserManager();
    }
    return WarmBrowserManager.instance;
  }

  public isWarmEnabled(): boolean {
    return process.env.WARM_BROWSER_EXPERIMENT === 'true';
  }

  public getWarmBrowser(): WarmBrowserInstance | null {
    return this.warmBrowser;
  }

  public getWarmDir(): string | null {
    return this.warmDir;
  }

  public async sanitizePage(page: BrowserSession['page']): Promise<void> {
    try {
      if (page.createCDPSession) {
        const cdp = await page.createCDPSession();
        await cdp.send('Network.clearBrowserCookies').catch(() => {});
        await cdp.send('Network.clearBrowserCache').catch(() => {});
        await cdp.send('Storage.clearDataForOrigin', {
          origin: 'https://www.spigotmc.org',
          storageTypes: 'all',
        }).catch(() => {});
        await cdp.detach?.().catch(() => {});
      }
    } catch {
      // Mock CDP or CDP-unsupported environment handled gracefully
    }
  }

  public async acquireWarmBrowser(
    cloak: CloakModule,
    launchConfig: Record<string, unknown>,
  ): Promise<{
    browser: WarmBrowserInstance;
    dir: string;
  }> {
    if (this.warmBrowser) {
      const isConnected = this.warmBrowser.isConnected ? this.warmBrowser.isConnected() : true;
      if (!isConnected) {
        await this.disposeWarmBrowser();
      }
    }

    if (!this.warmBrowser) {
      const dir = mkdtempSync(join(tmpdir(), 'cloak-warm-browser-'));
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      clearStaleProfileLocks(dir);

      const config: Record<string, unknown> = {
        ...launchConfig,
        userDataDir: dir,
      };

      let browser: any;
      try {
        browser = await cloak.launch(config);
      } catch (err: any) {
        const msg = err instanceof Error ? err.message : String(err ?? '');
        if (/session limit|plan|upgrade|exit code 76/i.test(msg)) {
          const freeConfig: Record<string, unknown> = { ...config };
          delete freeConfig.licenseKey;
          browser = await cloak.launch(freeConfig);
        } else {
          throw err;
        }
      }

      this.warmBrowser = browser;
      this.warmDir = dir;
    }

    return {
      browser: this.warmBrowser!,
      dir: this.warmDir!,
    };
  }

  public async releaseSessionPage(page: BrowserSession['page']): Promise<void> {
    await this.sanitizePage(page).catch(() => {});
    if (typeof (page as any).close === 'function') {
      await (page as any).close().catch(() => {});
    }
  }

  public async disposeWarmBrowser(): Promise<void> {
    if (this.warmBrowser) {
      const b = this.warmBrowser;
      const d = this.warmDir;
      this.warmBrowser = null;
      this.warmDir = null;
      await closeBrowser(b).catch(() => {});
      if (d && existsSync(d)) {
        try {
          rmSync(d, { recursive: true, force: true });
        } catch {}
      }
    }
  }

  public reset(): void {
    this.warmBrowser = null;
    this.warmDir = null;
  }
}

export const warmBrowserManager = WarmBrowserManager.getInstance();

export async function shutdownWarmBrowser(): Promise<void> {
  await warmBrowserManager.disposeWarmBrowser();
}

export async function probeBrowserLauncher(
  _chromePath?: string,
  profileDir?: string,
  platform?: string,
  _launcherOptions?: Record<string, unknown>,
): Promise<LauncherProbe> {
  const currentPlatform = platform ?? process.platform;
  if (currentPlatform !== 'linux' && currentPlatform !== 'win32') {
    return {
      available: false,
      reason: 'tự động Spigot chỉ được phép chạy trong Linux host/container hoặc Windows; không hỗ trợ nền tảng này',
    };
  }

  if (_chromePath && !existsSync(_chromePath)) {
    return {
      available: false,
      reason: `CHROME_PATH trỏ tới "${_chromePath}" nhưng không có tệp nào ở đó`,
    };
  }

  let cloak: CloakModule;
  try {
    cloak = (await import('cloakbrowser/puppeteer')) as CloakModule;
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    return {
      available: false,
      reason: `Thiếu cloakbrowser: ${detail}`,
    };
  }

  if (process.platform === 'linux' && !process.env.DISPLAY) {
    process.env.DISPLAY = ':99';
  }

  const launch = createBrowserLauncher(cloak, profileDir, _launcherOptions);
  return { available: true, launch };
}

export function createBrowserLauncher(
  cloak: CloakModule,
  profileDir?: string,
  _launcherOptions?: Record<string, unknown>,
): BrowserLauncher {
  return async (options: BrowserLaunchOptions = {}): Promise<BrowserSession> => {
    const isEphemeral = options.ephemeral ?? true;
    const isWarm = isEphemeral && warmBrowserManager.isWarmEnabled();
    const acquisitionStart = Date.now();

    // 1. Khởi tạo DeadlineBudget (nếu caller có cấu hình jobTimeoutMs)
    const budget: DeadlineBudget | null = options.jobTimeoutMs
      ? createDeadlineBudget({
          jobTimeoutMs: options.jobTimeoutMs,
          parentSignal: options.signal,
          jobId: options.jobId,
          startedAt: acquisitionStart,
        })
      : null;

    const effectiveSignal = budget?.signal ?? options.signal;
    if (effectiveSignal?.aborted) {
      budget?.dispose();
      const reason = effectiveSignal.reason;
      if (reason instanceof Error) throw reason;
      throw new Error(String(reason ?? '[BrowserLauncher] Yêu cầu khởi chạy bị hủy do signal aborted'));
    }

    const taskName = options.accountLabel
      ? `account-${options.accountLabel}`
      : options.profileDir
        ? `profile-${options.profileDir.replace(/.*[/\\]/, '')}`
        : 'session';

    // Cờ khởi chạy tối ưu cho CloakBrowser
    const args = [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--window-size=1920,1080',
      '--start-maximized',
    ];

    if (options.proxyServer) {
      args.push(`--proxy-server=${options.proxyServer}`);
    }

    let proxyUrl: string | undefined = undefined;
    if (options.proxyServer) {
      if (options.proxyUsername && options.proxyPassword) {
        const cleanServer = options.proxyServer.replace(/^[a-z]+:\/\//i, '');
        proxyUrl = `http://${encodeURIComponent(options.proxyUsername)}:${encodeURIComponent(options.proxyPassword)}@${cleanServer}`;
      } else {
        proxyUrl = options.proxyServer;
      }
    }

    const defaultHeadless =
      process.env.CLOAKBROWSER_HEADLESS !== undefined
        ? process.env.CLOAKBROWSER_HEADLESS !== 'false' && process.env.CLOAKBROWSER_HEADLESS !== '0'
        : true;
    const isHeadless =
      typeof options.headless === 'boolean'
        ? options.headless
        : typeof _launcherOptions?.headless === 'boolean'
          ? (_launcherOptions.headless as boolean)
          : _launcherOptions?.showWindow === true
            ? false
            : defaultHeadless;

    const baseConfig: Record<string, unknown> = {
      licenseKey:
        process.env.CLOAKBROWSER_LICENSE_KEY ||
        process.env.CLOAK_API_KEY,
      headless: isHeadless,
      humanize: true,
      humanPreset: 'careful',
      args,
      defaultViewport: { width: 1920, height: 1080 },
      ...(proxyUrl ? { proxy: proxyUrl } : {}),
    };

    /*
     * ========================================================================
     * CANONICAL LOCK ORDERING:
     * 1. Global Scheduling Admission (kiểm tra không bị shutdown)
     * 2. Account Mutex (accountMutexManager.acquire(options.accountLabel))
     * 3. Browser Session Resource (cloakSessionManager.acquireLock(taskName))
     *
     * Thứ tự giải phóng bắt buộc theo chiều ngược lại (Reverse order):
     * 1. Browser Session Resource (lockHandle.release())
     * 2. Account Mutex (accountLock.release())
     * ========================================================================
     */
    let accountLock: AccountLockHandle | null = null;
    const lockWaitStart = Date.now();

    if (options.accountLabel) {
      try {
        const remainingForAccount = budget ? budget.getRemainingMs() : undefined;
        if (remainingForAccount !== undefined && remainingForAccount <= 0) {
          throw new JobTimeoutError(
            `[BrowserLauncher] Hết hạn chót trước khi chờ khóa tài khoản "${options.accountLabel}"`,
            budget!.deadline,
            budget!.startedAt,
            options.jobId,
          );
        }
        accountLock = await accountMutexManager.acquire(options.accountLabel, {
          signal: effectiveSignal,
          timeoutMs: remainingForAccount,
          jobId: options.jobId,
        });
      } catch (accLockErr) {
        budget?.dispose();
        throw accLockErr;
      }
    }

    if (isWarm) {
      console.log(`[BrowserLauncher] Sử dụng WARM CloakBrowser session (account-isolated, ephemeral=${isEphemeral})`);
      let lockHandle: SessionLockHandle;
      try {
        const remainingForBrowser = budget ? budget.getRemainingMs() : undefined;
        if (remainingForBrowser !== undefined && remainingForBrowser <= 0) {
          throw new JobTimeoutError(
            `[BrowserLauncher] Hết hạn chót trước khi nhận khóa warm browser cho "${taskName}"`,
            budget!.deadline,
            budget!.startedAt,
            options.jobId,
          );
        }
        lockHandle = await cloakSessionManager.acquireLock(taskName, {
          signal: effectiveSignal,
          waitTimeoutMs: remainingForBrowser,
        });
      } catch (lockErr) {
        if (accountLock) await accountLock.release().catch(() => undefined);
        budget?.dispose();
        throw lockErr;
      }

      const lockWaitMs = Date.now() - lockWaitStart;
      console.log(`[BrowserLauncher] 🔒 Đã cấp khóa [Canonical: Account -> BrowserSession]: job_id=${options.jobId ?? 'none'} account_id=${options.accountLabel ?? 'none'} lock_wait_ms=${lockWaitMs} remaining_ms=${budget ? budget.getRemainingMs() : 'inf'}`);

      let warmInstance: WarmBrowserInstance;
      try {
        const acquired = await warmBrowserManager.acquireWarmBrowser(cloak, baseConfig);
        warmInstance = acquired.browser;
        lockHandle.registerBrowser(warmInstance);

        const proc = warmInstance.process?.();
        const pid = (proc as { pid?: number })?.pid;
        if (process.platform === 'win32' && !isHeadless && pid) {
          makeWindowsProcessVisible(pid);
        }
      } catch (launchErr) {
        await lockHandle.release();
        if (accountLock) await accountLock.release().catch(() => undefined);
        budget?.dispose();
        throw launchErr;
      }

      let tracker: AbruptCloseTracker | null = null;
      let page: BrowserSession['page'] | null = null;

      try {
        tracker = createAbruptCloseTracker();
        page = (await warmInstance.newPage()) as BrowserSession['page'];
        tracker.attachBrowser(warmInstance, page);
        tracker.onAbruptClose(() => {
          lockHandle.markDead();
          warmBrowserManager.reset();
        });

        // Strict account isolation: sanitize before use
        await warmBrowserManager.sanitizePage(page);

        if (options.proxyServer && options.proxyUsername && options.proxyPassword && page.authenticate) {
          await page.authenticate({ username: options.proxyUsername, password: options.proxyPassword });
        }

        if (options.accountLabel) {
          const injected = await injectCookiesFromAccountFile(page, options.accountLabel);
          if (injected) {
            console.log(`[BrowserLauncher] 🍪 Đã tiêm cookies lưu sẵn từ ./data/cookie/${options.accountLabel}/* vào phiên warm.`);
          }
        }
      } catch (setupErr) {
        if (tracker) {
          try { tracker.dispose(); } catch { }
        }
        if (page) {
          await warmBrowserManager.releaseSessionPage(page).catch(() => undefined);
        }
        await lockHandle.release().catch((relErr) => {
          console.warn('[BrowserLauncher] Lỗi giải phóng lock sau warm setup failure:', relErr);
        });
        if (accountLock) await accountLock.release().catch(() => undefined);
        budget?.dispose();
        throw setupErr;
      }

      return {
        page: page!,
        close: async () => {
          if (tracker) tracker.dispose();
          await warmBrowserManager.releaseSessionPage(page!);
          await lockHandle.release();
          if (accountLock) await accountLock.release().catch(() => undefined);
          budget?.dispose();
        },
        isAbruptlyClosed: () => tracker ? tracker.isAbruptlyClosed() : false,
        onAbruptClose: (callback) => tracker ? tracker.onAbruptClose(callback) : (() => {}),
        markAbruptlyClosed: (reason) => {
          tracker?.markAbruptlyClosed(reason);
          warmBrowserManager.reset();
        },
      };
    }

    // COLD EPHEMERAL PATH (Phase 4A baseline)
    let dir: string;
    if (isEphemeral) {
      dir = mkdtempSync(join(tmpdir(), 'cloak-ephemeral-session-'));
    } else {
      dir = options.profileDir ?? profileDir ?? mkdtempSync(join(tmpdir(), 'cloak-session-'));
    }

    if (dir) {
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      clearStaleProfileLocks(dir);
    }

    const launchConfig: Record<string, unknown> = {
      ...baseConfig,
      userDataDir: dir,
    };

    console.log(`[BrowserLauncher] Khởi chạy CloakBrowser phiên trắng (ephemeral=${isEphemeral}): headless=${isHeadless}, viewport=1920x1080`);

    let lockHandle: SessionLockHandle;
    try {
      const remainingForBrowser = budget ? budget.getRemainingMs() : undefined;
      if (remainingForBrowser !== undefined && remainingForBrowser <= 0) {
        throw new JobTimeoutError(
          `[BrowserLauncher] Hết hạn chót trước khi nhận khóa cold browser cho "${taskName}"`,
          budget!.deadline,
          budget!.startedAt,
          options.jobId,
        );
      }
      lockHandle = await cloakSessionManager.acquireLock(taskName, {
        tempProfileDir: dir,
        signal: effectiveSignal,
        waitTimeoutMs: remainingForBrowser,
      });
    } catch (lockErr) {
      if (accountLock) await accountLock.release().catch(() => undefined);
      budget?.dispose();
      if (isEphemeral && dir && existsSync(dir)) {
        try { rmSync(dir, { recursive: true, force: true }); } catch { }
      }
      throw lockErr;
    }

    const lockWaitMs = Date.now() - lockWaitStart;
    console.log(`[BrowserLauncher] 🔒 Đã cấp khóa [Canonical: Account -> BrowserSession]: job_id=${options.jobId ?? 'none'} account_id=${options.accountLabel ?? 'none'} lock_wait_ms=${lockWaitMs} remaining_ms=${budget ? budget.getRemainingMs() : 'inf'}`);

    let browser: {
      close: () => Promise<void>;
      process?: () => { kill: (signal?: NodeJS.Signals | number) => boolean; pid?: number } | null;
      pages: () => Promise<unknown[]>;
      newPage: () => Promise<unknown>;
    } | null = null;

    let expectedIdentity: ProcessIdentity | null = null;

    try {
      try {
        browser = await cloak.launch(launchConfig);
      } catch (launchErr: any) {
        const msg = launchErr instanceof Error ? launchErr.message : String(launchErr ?? '');
        if (/session limit|plan|upgrade|exit code 76/i.test(msg)) {
          console.warn('[BrowserLauncher] ⚠️ Gặp giới hạn concurrent session license CloakBrowser Pro. Tự động chuyển sang CloakBrowser Free Stealth...');
          const freeConfig = { ...launchConfig };
          delete freeConfig.licenseKey;
          browser = await cloak.launch(freeConfig);
        } else {
          throw launchErr;
        }
      }
      lockHandle.registerBrowser(browser);

      const proc = browser.process?.();
      const pid = (proc as { pid?: number })?.pid;
      if (pid && typeof pid === 'number' && pid > 0) {
        expectedIdentity = await captureProcessIdentity(pid);
        if (process.platform === 'win32' && !isHeadless) {
          makeWindowsProcessVisible(pid);
        }
      }
    } catch (launchErr) {
      if (browser) {
        await closeBrowser(browser, 5_000, expectedIdentity ?? undefined).catch(() => undefined);
      }
      await lockHandle.release().catch((relErr) => {
        console.warn('[BrowserLauncher] Lỗi giải phóng lock sau launch failure:', relErr);
      });
      if (accountLock) await accountLock.release().catch(() => undefined);
      budget?.dispose();
      if (isEphemeral && dir && existsSync(dir)) {
        try {
          rmSync(dir, { recursive: true, force: true });
        } catch (rmErr) {
          console.warn(`[BrowserLauncher] Cảnh báo: Không thể dọn dẹp thư mục profile "${dir}":`, rmErr);
        }
      }
      throw launchErr;
    }

    let tracker: AbruptCloseTracker | null = null;
    let page: BrowserSession['page'] | null = null;

    try {
      tracker = createAbruptCloseTracker();
      const pages = await browser.pages();
      page = (pages.length > 0 ? pages[0] : await browser.newPage()) as BrowserSession['page'];
      tracker.attachBrowser(browser, page);
      tracker.onAbruptClose(() => {
        lockHandle.markDead();
      });

      if (options.proxyServer && options.proxyUsername && options.proxyPassword && page.authenticate) {
        await page.authenticate({ username: options.proxyUsername, password: options.proxyPassword });
      }

      // Nếu có chỉ định accountLabel, tự động nạp cookies từ ./data/cookie/{account}/* vào phiên trắng
      if (options.accountLabel) {
        const injected = await injectCookiesFromAccountFile(page, options.accountLabel);
        if (injected) {
          console.log(`[BrowserLauncher] 🍪 Đã tiêm cookies lưu sẵn từ ./data/cookie/${options.accountLabel}/* vào phiên trình duyệt trắng.`);
        }
      }
    } catch (setupErr) {
      if (tracker) {
        try { tracker.dispose(); } catch { }
      }
      if (browser) {
        await closeBrowser(browser, 5_000, expectedIdentity ?? undefined).catch(() => undefined);
      }
      await lockHandle.release().catch((relErr) => {
        console.warn('[BrowserLauncher] Lỗi giải phóng lock sau setup failure:', relErr);
      });
      if (accountLock) await accountLock.release().catch(() => undefined);
      budget?.dispose();
      if (isEphemeral && dir && existsSync(dir)) {
        try {
          rmSync(dir, { recursive: true, force: true });
        } catch (rmErr) {
          console.warn(`[BrowserLauncher] Cảnh báo: Không thể dọn dẹp thư mục profile "${dir}":`, rmErr);
        }
      }
      throw setupErr;
    }

    return {
      page: page!,
      close: async () => {
        if (tracker) tracker.dispose();
        await closeBrowser(browser, 8_000, expectedIdentity ?? undefined).catch(() => undefined);
        await lockHandle.release();
        if (accountLock) await accountLock.release().catch(() => undefined);
        budget?.dispose();
        // Xóa sạch thư mục session tạm thời -> Dữ liệu hoàn toàn đi vào hư vô!
        if (isEphemeral && dir && existsSync(dir)) {
          try {
            rmSync(dir, { recursive: true, force: true });
          } catch (rmErr) {
            console.warn(`[BrowserLauncher] Cảnh báo: Không thể dọn dẹp thư mục profile "${dir}":`, rmErr);
          }
        }
      },
      isAbruptlyClosed: () => tracker ? tracker.isAbruptlyClosed() : false,
      onAbruptClose: (callback) => tracker ? tracker.onAbruptClose(callback) : (() => {}),
      markAbruptlyClosed: (reason) => tracker?.markAbruptlyClosed(reason),
    };
  };
}