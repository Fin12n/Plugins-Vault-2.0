import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cloakSessionManager } from '../src/services/upstream/cloak-session-manager.js';

beforeEach(() => {
  cloakSessionManager.reset();
});

afterEach(async () => {
  await cloakSessionManager.releaseLock();
  cloakSessionManager.reset();
});

/**
 * Kiểm cách launcher truyền proxy và cờ vào CloakBrowser.
 *
 * `cloakbrowser/puppeteer` được giả lập vì thật thì nó mở Chromium thật: điều duy nhất
 * cần biết ở đây là launcher đưa gì cho nó — cờ `--proxy-server`, KHÔNG có
 * `--proxy-bypass-list`, và mật khẩu proxy đi qua `page.authenticate` chứ không nằm
 * trong dòng lệnh (mọi tiến trình trên máy đều đọc được argv).
 */
type CloakLaunchArgs = {
  headless?: boolean;
  humanize?: boolean;
  licenseKey?: string;
  args?: string[];
  userDataDir?: string;
  launchOptions?: { executablePath?: string };
};

const calls: CloakLaunchArgs[] = [];
const authenticated: { username: string; password: string }[] = [];
let authenticateThrows = false;
let closed = 0;

const mockPage = {
  authenticate: async (credentials: { username: string; password: string }) => {
    if (authenticateThrows) throw new Error('Protocol error: Target closed');
    authenticated.push(credentials);
  },
};

const mockBrowser = {
  close: async () => void closed++,
  process: () => null,
  pages: async () => [mockPage],
  newPage: async () => mockPage,
};

vi.mock('cloakbrowser/puppeteer', () => ({
  launch: async (options: CloakLaunchArgs) => {
    calls.push(options);
    return mockBrowser;
  },
  launchPersistentContext: async (options: CloakLaunchArgs & { userDataDir: string }) => {
    calls.push(options);
    return mockBrowser;
  },
}));

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    existsSync: (path: string) =>
      // Chrome path used in tests does not exist on Windows/CI; pretend it does
      // so resolveChromePath() returns it and the launcher reaches launch().
      path === '/usr/bin/google-chrome-stable' ? true : actual.existsSync(path),
  };
});

const { probeBrowserLauncher } = await import('../src/services/upstream/browser-launcher.js');

async function launcher() {
  const probe = await probeBrowserLauncher('/usr/bin/google-chrome-stable', undefined, 'linux');
  if (!probe.available) throw new Error(`launcher không dựng được: ${probe.reason}`);
  return probe.launch;
}

describe('browser launcher — proxy', () => {
  it('truyền --proxy-server và KHÔNG truyền --proxy-bypass-list', async () => {
    calls.length = 0;
    const launch = await launcher();
    await launch({ proxyServer: 'http://1.2.3.4:8000' });

    const args = calls[0]?.args ?? [];
    expect(args).toContain('--proxy-server=http://1.2.3.4:8000');
    // `<-loopback>` TRỪ miễn trừ localhost, tức đẩy loopback qua proxy — đo được
    // rằng có cờ này thì một trang localhost không tải nổi.
    expect(args.some((arg) => arg.includes('proxy-bypass-list'))).toBe(false);
  });

  it('không truyền cờ proxy nào khi không có proxy', async () => {
    calls.length = 0;
    const launch = await launcher();
    await launch({});
    expect((calls[0]?.args ?? []).some((arg) => arg.includes('proxy'))).toBe(false);
  });

  it('mật khẩu proxy đi qua page.authenticate, không nằm trong dòng lệnh', async () => {
    calls.length = 0;
    authenticated.length = 0;
    const launch = await launcher();
    await launch({ proxyServer: 'http://1.2.3.4:8000', proxyUsername: 'bob', proxyPassword: 's3cret' });

    expect(authenticated).toEqual([{ username: 'bob', password: 's3cret' }]);
    expect((calls[0]?.args ?? []).join(' ')).not.toContain('s3cret');
  });

  it('không gọi authenticate khi proxy không có mật khẩu', async () => {
    authenticated.length = 0;
    const launch = await launcher();
    await launch({ proxyServer: 'http://1.2.3.4:8000' });
    expect(authenticated).toEqual([]);
  });

  it('authenticate ném lỗi thì đóng Chrome rồi mới ném ra, không bỏ lại tiến trình treo', async () => {
    closed = 0;
    authenticateThrows = true;
    try {
      const launch = await launcher();
      await expect(
        launch({ proxyServer: 'http://1.2.3.4:8000', proxyUsername: 'bob', proxyPassword: 's3cret' }),
      ).rejects.toThrow(/Target closed/);
      // Không đóng thì Chrome + xvfb ở lại, giữ luôn khoá profile của account đó.
      expect(closed).toBe(1);
    } finally {
      authenticateThrows = false;
    }
  });

  it('bật humanize để mô phỏng tương tác người thật tránh bị Cloudflare chặn', async () => {
    calls.length = 0;
    const launch = await launcher();
    await launch({});
    expect(calls[0]?.humanize).toBe(true);
  });
});

describe('browser launcher — GUI and viewport options', () => {
  it('giữ đúng 4 cờ chuẩn của Script 1 và headless = false khi showWindow = true', async () => {
    calls.length = 0;
    const probe = await probeBrowserLauncher(
      '/usr/bin/google-chrome-stable',
      undefined,
      'linux',
      { showWindow: true, display: ':1' },
    );
    if (!probe.available) throw new Error(`launcher không dựng được: ${probe.reason}`);
    await probe.launch({});

    expect(calls[0]?.headless).toBe(false);
    expect(calls[0]?.args).toEqual([
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--window-size=1920,1080',
      '--start-maximized',
    ]);
  });

  it('cố định defaultViewport 1920x1080 chuẩn Script 1', async () => {
    calls.length = 0;
    const probe = await probeBrowserLauncher(
      '/usr/bin/google-chrome-stable',
      undefined,
      'linux',
      { showWindow: true },
    );
    if (!probe.available) throw new Error(`launcher không dựng được: ${probe.reason}`);
    await probe.launch({});

    expect((calls[0] as any)?.defaultViewport).toEqual({ width: 1920, height: 1080 });
  });

  it('truyền headless = true khi launcherOptions.headless = true', async () => {
    calls.length = 0;
    const probe = await probeBrowserLauncher(
      '/usr/bin/google-chrome-stable',
      undefined,
      'linux',
      { headless: true },
    );
    if (!probe.available) throw new Error(`launcher không dựng được: ${probe.reason}`);
    await probe.launch({});

    expect(calls[0]?.headless).toBe(true);
  });

  it('truyền headless = false khi launcherOptions.headless = false', async () => {
    calls.length = 0;
    const probe = await probeBrowserLauncher(
      '/usr/bin/google-chrome-stable',
      undefined,
      'linux',
      { headless: false },
    );
    if (!probe.available) throw new Error(`launcher không dựng được: ${probe.reason}`);
    await probe.launch({});

    expect(calls[0]?.headless).toBe(false);
  });
});
