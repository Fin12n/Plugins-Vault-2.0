import { describe, expect, it, vi } from 'vitest';

/**
 * Kiểm cách launcher truyền proxy vào Chrome.
 *
 * `puppeteer-real-browser` được giả lập vì thật thì nó mở Chrome thật: điều duy nhất
 * cần biết ở đây là launcher đưa gì cho nó — cờ `--proxy-server`, KHÔNG có
 * `--proxy-bypass-list`, và mật khẩu proxy đi qua `page.authenticate` chứ không nằm
 * trong dòng lệnh (mọi tiến trình trên máy đều đọc được argv).
 */
type ConnectArgs = {
  headless: boolean;
  turnstile?: boolean;
  disableXvfb?: boolean;
  args?: string[];
  customConfig?: { chromePath?: string; userDataDir?: string };
};

const calls: ConnectArgs[] = [];
const authenticated: { username: string; password: string }[] = [];
let authenticateThrows = false;
let closed = 0;

vi.mock('puppeteer-real-browser', () => ({
  connect: async (options: ConnectArgs) => {
    calls.push(options);
    return {
      browser: {
        close: async () => void closed++,
        process: () => null,
      },
      page: {
        authenticate: async (credentials: { username: string; password: string }) => {
          if (authenticateThrows) throw new Error('Protocol error: Target closed');
          authenticated.push(credentials);
        },
      },
    };
  },
}));

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    existsSync: (path: string) =>
      // Chrome path used in tests does not exist on Windows/CI; pretend it does
      // so resolveChromePath() returns it and the launcher reaches connect().
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

  it('bật turnstile và chạy không headless, vì headless bị thử thách phát hiện', async () => {
    calls.length = 0;
    const launch = await launcher();
    await launch({});
    expect(calls[0]?.headless).toBe(false);
    expect(calls[0]?.turnstile).toBe(true);
  });
});

describe('browser launcher — GUI and GPU options', () => {
  it('truyền disableXvfb: true và cờ vị trí cửa sổ khi showWindow = true', async () => {
    calls.length = 0;
    const probe = await probeBrowserLauncher(
      '/usr/bin/google-chrome-stable',
      undefined,
      'linux',
      { showWindow: true, display: ':1' },
    );
    if (!probe.available) throw new Error(`launcher không dựng được: ${probe.reason}`);
    await probe.launch({});

    expect(calls[0]?.disableXvfb).toBe(true);
    expect(calls[0]?.args).toContain('--window-position=0,0');
  });

  it('bật cờ GPU và WebGL khi enableGpu = true', async () => {
    calls.length = 0;
    const probe = await probeBrowserLauncher(
      '/usr/bin/google-chrome-stable',
      undefined,
      'linux',
      { enableGpu: true },
    );
    if (!probe.available) throw new Error(`launcher không dựng được: ${probe.reason}`);
    await probe.launch({});

    const args = calls[0]?.args ?? [];
    expect(args).toContain('--enable-gpu-rasterization');
    expect(args).toContain('--enable-webgl');
    expect(args).toContain('--ignore-gpu-blocklist');
    expect(args).not.toContain('--disable-gpu');
    expect(args).not.toContain('--disable-software-rasterizer');
  });

  it('tắt GPU khi enableGpu = false', async () => {
    calls.length = 0;
    const probe = await probeBrowserLauncher(
      '/usr/bin/google-chrome-stable',
      undefined,
      'linux',
      { enableGpu: false },
    );
    if (!probe.available) throw new Error(`launcher không dựng được: ${probe.reason}`);
    await probe.launch({});

    const args = calls[0]?.args ?? [];
    expect(args).toContain('--disable-gpu');
    expect(args).toContain('--disable-software-rasterizer');
    expect(args).not.toContain('--enable-gpu-rasterization');
  });
});
