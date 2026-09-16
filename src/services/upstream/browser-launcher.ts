import { existsSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { BrowserLaunchOptions, BrowserLauncher, BrowserSession } from './download-via-browser.js';
import { createAbruptCloseTracker } from './chrome-close-detector.js';

/**
 * Boots a real Chrome for the download sweep.
 *
 * puppeteer-real-browser is a pinned production dependency. It is imported at
 * runtime so a damaged install or unavailable Chrome degrades only this feature
 * instead of taking the dashboard and Discord bot down with it.
 *
 * `headless: false` is required, not a preference. True headless mode is
 * detected and blocked by the challenge. On Linux the library runs Chrome on a
 * virtual display via xvfb, so the process stays unattended and nothing is ever
 * shown; "not headless" does not mean "a window someone has to look at".
 */

type ConnectFn = (options: {
  headless: boolean;
  turnstile?: boolean;
  args?: string[];
  customConfig?: { chromePath?: string; userDataDir?: string };
  disableXvfb?: boolean;
}) => Promise<{
  browser: {
    close: () => Promise<void>;
    process?: () => { kill: (signal?: NodeJS.Signals | number) => boolean } | null;
  };
  page: unknown;
}>;

export type LauncherProbe =
  | { available: true; launch: BrowserLauncher; isGuiWindow?: boolean; gpuEnabled?: boolean }
  | { available: false; reason: string };

/** Closes Chrome gracefully, then kills it if its CDP connection is wedged. */
export async function closeBrowser(
  browser: {
    close: () => Promise<void>;
    process?: () => { kill: (signal?: NodeJS.Signals | number) => boolean } | null;
  },
  timeoutMs = 8_000,
): Promise<void> {
  let timer: NodeJS.Timeout | null = null;
  try {
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
      try {
        const proc = browser.process?.();
        if (proc) {
          proc.kill('SIGKILL');
          // On Linux, kill the process group to ensure no orphan/zombie child processes remain
          const pid = (proc as { pid?: number }).pid;
          if (process.platform === 'linux' && pid && typeof pid === 'number') {
            try {
              process.kill(-pid, 'SIGKILL');
            } catch {
              // Ignore if already dead or not process group leader
            }
          }
        }
      } catch {
        // The process may already have exited between the timeout and kill.
      }
    }
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Where a Debian/Ubuntu VPS puts Chrome or Chromium.
 *
 * Searched because the underlying chrome-launcher reports only "the CHROME_PATH
 * environment variable must be set", which describes its own internals rather
 * than the operator's problem: Chrome is simply not installed, or is installed
 * under a name the launcher does not probe. Finding it here turns the common
 * case into no configuration at all.
 */
const CHROME_CANDIDATES = [
  '/usr/bin/google-chrome-stable',
  '/usr/bin/google-chrome',
  // Where Google's own .deb puts the real binary. The /usr/bin entries above are
  // symlinks to it and can be absent even when Chrome is installed.
  '/opt/google/chrome/chrome',
  '/opt/google/chrome/google-chrome',
  '/usr/bin/chromium-browser',
  '/usr/bin/chromium',
  '/snap/bin/chromium',
  '/usr/lib/chromium/chromium',
  '/usr/lib/chromium-browser/chromium-browser',
  // Windows candidate locations
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  ...(process.env.LOCALAPPDATA ? [join(process.env.LOCALAPPDATA, 'Google', 'Chrome', 'Application', 'chrome.exe')] : []),
  ...(process.env.PROGRAMFILES ? [join(process.env.PROGRAMFILES, 'Google', 'Chrome', 'Application', 'chrome.exe')] : []),
  ...(process.env['PROGRAMFILES(X86)'] ? [join(process.env['PROGRAMFILES(X86)'], 'Google', 'Chrome', 'Application', 'chrome.exe')] : []),
];

/**
 * Chrome downloaded by `npx puppeteer browsers install chrome`.
 *
 * Worth searching because it is the only install route that needs no root, which
 * is the difference between the feature working and not on a VPS where the bot
 * user cannot sudo. The directory carries a version in its name, so the exact
 * path cannot be hardcoded and the newest build wins.
 */
export function puppeteerCacheChrome(home = homedir()): string | null {
  const base = join(home, '.cache', 'puppeteer', 'chrome');
  if (!existsSync(base)) return null;
  try {
    // Reverse lexicographic order approximates newest-first for the
    // `linux-<version>` names puppeteer creates.
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
  } catch {
    // Unreadable cache is the same as no cache.
  }
  return null;
}

/**
 * A per-account profile directory under the shared profile base.
 *
 * Each account gets its own Chrome profile so a sweep never has to log one
 * account out to sign the next in — the logout was what left the reused page
 * without keyboard focus and failed every account after the first. A stable
 * subdirectory per label (rather than a throwaway) keeps that account's own
 * cf_clearance between sweeps, so only its very first login pays the challenge.
 *
 * The label is sanitised to a filesystem-safe token: it comes from an
 * owner-edited file and can hold spaces, slashes, or an email address. A hash
 * suffix keeps two labels that sanitise to the same token from sharing a profile.
 */
export function accountProfileDir(base: string, label: string): string {
  const safe = label.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 40) || 'acc';
  let hash = 0;
  for (let i = 0; i < label.length; i++) hash = (hash * 31 + label.charCodeAt(i)) >>> 0;
  return join(base, `${safe}-${hash.toString(36)}`);
}

/**
 * Deletes per-account profiles whose account has left the credentials file.
 *
 * Each account keeps a persistent Chrome profile (tens of MB with the cookie
 * store and cache), so an account removed by the owner would otherwise leave its
 * profile on disk forever. Called with the current labels; anything under the
 * base that this module created for an unknown account is removed.
 *
 * Only directories matching accountProfileDir's `<label>-<hash>` shape are
 * touched — the trailing base36 hash — so a profile directory created by
 * something else, or the shared default profile's own files, is never deleted.
 * Returns how many were removed, for a one-line log.
 */
export function pruneOrphanProfiles(base: string, knownLabels: Iterable<string>): number {
  if (!existsSync(base)) return 0;
  const keep = new Set<string>();
  for (const label of knownLabels) keep.add(accountProfileDir(base, label));

  let removed = 0;
  try {
    for (const name of readdirSync(base)) {
      // The suffix accountProfileDir appends: a dash then a base36 hash. Guards
      // against deleting a directory this module did not create.
      if (!/-[0-9a-z]+$/.test(name)) continue;
      const full = join(base, name);
      if (keep.has(full)) continue;
      try {
        rmSync(full, { recursive: true, force: true });
        removed++;
      } catch {
        // A profile still locked by a running Chrome is skipped, not fatal.
      }
    }
  } catch {
    // An unreadable base is the same as nothing to prune.
  }
  return removed;
}

/** First Chrome that exists: the configured one, then the usual locations. */
export function resolveChromePath(configured?: string): string | null {
  if (configured) return existsSync(configured) ? configured : null;
  return CHROME_CANDIDATES.find((path) => existsSync(path)) ?? puppeteerCacheChrome();
}

/**
 * chrome-launcher config naming a resolved browser, or nothing when none is
 * found so the launcher can fall back to its own search.
 *
 * Shared with the standalone scripts, which call connect() directly and would
 * otherwise hit the same unhelpful "CHROME_PATH must be set" wall.
 */
export function chromeConfig(configured?: string): { customConfig?: { chromePath: string } } {
  const resolved = resolveChromePath(configured ?? process.env.CHROME_PATH);
  return resolved ? { customConfig: { chromePath: resolved } } : {};
}

/**
 * Removes a lock left by a Chrome that did not exit cleanly.
 *
 * Chrome hard-locks a profile directory to one process and the failure is
 * SILENT: a second launch simply never becomes reachable, with nothing on stdout
 * or stderr. So a sweep killed mid-download would brick the profile for every
 * later run with no visible cause.
 *
 * Only safe because this bot runs exactly one browser at a time. The lock files
 * are recreated on the next launch.
 */
export function clearStaleProfileLocks(profileDir: string): void {
  if (!existsSync(profileDir)) return;
  for (const name of ['SingletonLock', 'SingletonCookie', 'SingletonSocket']) {
    try {
      rmSync(join(profileDir, name), { force: true });
    } catch {
      // Unremovable is not fatal: the launch below will surface the real problem.
    }
  }
}

/**
 * Resolves a launcher, or explains why there is none.
 *
 * Checked once at startup rather than per sweep: a missing package is a
 * deployment fact, and retrying the import hourly would only repeat the same
 * failure in the logs.
 *
 * `profileDir` makes Chrome reuse one persistent profile instead of a blank one
 * per launch. That keeps `cf_clearance` — the ticket proving the Cloudflare
 * challenge was already passed — so a warm sweep skips the challenge entirely.
 * Only worth anything if the browser closes gracefully, which is why shutdown
 * awaits it.
 */
export async function probeBrowserLauncher(
  chromePath?: string,
  profileDir?: string,
  /** Injected so tests can override `process.platform` without touching the global. */
  platform?: string,
  launcherOptions?: {
    showWindow?: boolean;
    enableGpu?: boolean;
    display?: string;
  },
): Promise<LauncherProbe> {
  // Spigot automation runs in host service/container on Linux or operator host on Windows.
  const currentPlatform = platform ?? process.platform;
  if (currentPlatform !== 'linux' && currentPlatform !== 'win32') {
    return {
      available: false,
      reason: 'tự động Spigot chỉ được phép chạy trong Linux host/container hoặc Windows; không hỗ trợ nền tảng này',
    };
  }

  let connect: ConnectFn;
  try {
    const moduleName = 'puppeteer-real-browser';
    ({ connect } = (await import(moduleName)) as { connect: ConnectFn });
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    return {
      available: false,
      reason: `thiếu hoặc lỗi nạp puppeteer-real-browser: ${detail} (chạy npm install; trên Linux cần thêm: sudo apt-get install xvfb)`,
    };
  }

  const isContainer = existsSync('/.dockerenv') || existsSync('/run/.containerenv');
  const hasX11Socket = existsSync('/tmp/.X11-unix');

  let showWindow =
    launcherOptions?.showWindow ??
    (process.env.CHROME_SHOW_WINDOW === 'true' ||
      process.env.CHROME_SHOW_WINDOW === '1' ||
      Boolean(
        process.env.DISPLAY &&
          process.env.CHROME_SHOW_WINDOW !== 'false' &&
          process.env.CHROME_SHOW_WINDOW !== '0',
      ));

  if (isContainer && !hasX11Socket && showWindow) {
    console.warn(
      '[BrowserLauncher] Phát hiện môi trường Docker/Container không có X11 socket hiển thị. Tự động chuyển CHROME_SHOW_WINDOW=false để chạy Chrome qua màn hình ảo Xvfb nhằm tránh lỗi crash ECONNREFUSED.',
    );
    showWindow = false;
  }

  const enableGpu =
    launcherOptions?.enableGpu ??
    (process.env.CHROME_ENABLE_GPU !== 'false' && process.env.CHROME_ENABLE_GPU !== '0');

  const display =
    launcherOptions?.display || process.env.CHROME_DISPLAY || process.env.DISPLAY || ':0';

  // Linux headless check: unattended runs on a VPS need Xvfb when no graphical display exists and showWindow is false.
  if (platform === undefined && process.platform === 'linux' && !showWindow && !process.env.DISPLAY) {
    const hasXvfb =
      existsSync('/usr/bin/Xvfb') || existsSync('/usr/local/bin/Xvfb') || existsSync('/bin/Xvfb');
    if (!hasXvfb) {
      return {
        available: false,
        reason:
          'máy chủ Linux không có DISPLAY và chưa cài Xvfb (cần thiết để chạy Chrome ảo giải Cloudflare).\n' +
          'Hãy cài Xvfb bằng lệnh:\n' +
          '  sudo apt-get install -y xvfb',
      };
    }
  }

  // Resolved before launching, not after failing: the launcher's own error names
  // an environment variable instead of saying Chrome is missing, which sends the
  // operator looking for a config mistake that does not exist.
  const resolved = resolveChromePath(chromePath);
  if (!resolved) {
    return {
      available: false,
      reason: chromePath
        ? `CHROME_PATH trỏ tới "${chromePath}" nhưng không có tệp nào ở đó`
        : 'chưa có Chrome trên máy. Cài bằng MỘT trong hai cách:\n' +
          '  (có sudo)    sudo apt-get install -y xvfb chromium\n' +
          '  (không sudo) npx puppeteer browsers install chrome\n' +
          'Nếu Chrome nằm ở chỗ khác, tìm bằng `which google-chrome chromium` rồi ' +
          'đặt CHROME_PATH=<đường dẫn> trong .env',
    };
  }

  const launch: BrowserLauncher = async (options: BrowserLaunchOptions = {}): Promise<BrowserSession> => {
    // Per-account override wins over the shared default. A sweep gives each
    // account its own directory so no logout is needed between accounts and each
    // account keeps its own cf_clearance across sweeps.
    const dir = options.profileDir ?? profileDir;
    // 0700: the profile's cookie database holds a live Spigot session, so it is a
    // credential store even though it never passes through Secret.
    if (dir) {
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      clearStaleProfileLocks(dir);
    }

    if (showWindow && process.platform === 'linux') {
      process.env.DISPLAY = display;
      if (!process.env.XAUTHORITY) {
        const xauthPath = join(homedir(), '.Xauthority');
        if (existsSync(xauthPath)) {
          process.env.XAUTHORITY = xauthPath;
        }
      }
    }

    const args = [
      '--start-maximized',
      '--window-size=1920,1080',
      '--no-sandbox',
      '--test-type',
      '--disable-infobars',
      '--disable-dev-shm-usage',
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-blink-features=AutomationControlled',
      '--lang=en-US,en',
    ];

    if (enableGpu) {
      args.push(
        '--enable-gpu-rasterization',
        '--enable-webgl',
        '--ignore-gpu-blocklist',
      );
    } else {
      args.push('--disable-gpu', '--disable-software-rasterizer');
    }

    if (showWindow) {
      args.push('--window-position=0,0');
    }

    if (options.proxyServer) {
      args.push(`--proxy-server=${options.proxyServer}`);
    }

    const { browser, page } = await connect({
      headless: false,
      // Let the helper library click through Cloudflare Turnstile on its own. This
      // is the primary path to unattended access: with it off, every account was
      // rejected at the Cloudflare layer and left waiting for manual dashboard
      // input. The dashboard challenge flow remains as a fallback for the cases it
      // still cannot solve; a rotating proxy per launch lowers how often that
      // happens by not reusing one flagged datacenter IP across every account.
      turnstile: true,
      // no-sandbox is required when running as root in a container, which is the
      // common VPS case; --start-maximized keeps the viewport large enough that
      // the login form's submit button is inside it.
      args,
      disableXvfb: showWindow,
      // chrome-launcher's own option names; a top-level executablePath is ignored,
      // and userDataDir belongs here rather than in args or it is silently dropped.
      customConfig: { chromePath: resolved, ...(dir ? { userDataDir: dir } : {}) },
    });

    const tracker = createAbruptCloseTracker();
    tracker.attachBrowser(browser, page);

    const session = page as BrowserSession['page'];

    // A paid proxy usually wants credentials, and Chrome answers the 407 with a
    // native dialog automation cannot see: every request would fail with nothing
    // in the log. Answering through the page is the only route that works, and it
    // must happen before the first navigation.
    //
    // A rejection here has to close the browser by hand. `browser` is reachable
    // only through the session this function has not returned yet, so an escaping
    // error would leave Chrome and its xvfb display running and holding the
    // profile lock — which then breaks every later launch for that account.
    if (options.proxyServer && options.proxyUsername && options.proxyPassword && session.authenticate) {
      try {
        await session.authenticate({ username: options.proxyUsername, password: options.proxyPassword });
      } catch (err) {
        tracker.markGraceful();
        await closeBrowser(browser);
        throw err;
      }
    }

    return {
      page: session,
      close: async () => {
        tracker.markGraceful();
        await closeBrowser(browser);
      },
      isAbruptlyClosed: () => tracker.isAbruptlyClosed(),
      onAbruptClose: (callback) => tracker.onAbruptClose(callback),
      markAbruptlyClosed: (reason) => tracker.markAbruptlyClosed(reason),
    };
  };

  return { available: true, launch };
}
