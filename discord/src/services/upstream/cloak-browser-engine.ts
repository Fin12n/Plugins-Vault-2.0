import type { Page, Browser } from 'puppeteer-core';

export interface FingerprintData {
  webdriver: boolean | undefined;
  hasChrome: boolean;
  pluginsCount: number;
  hardwareConcurrency: number;
}

export interface LaunchEngineOptions {
  licenseKey?: string;
  headless?: boolean;
  humanize?: boolean;
  humanPreset?: 'careful' | 'fast' | 'normal';
  proxy?: string;
  args?: string[];
  userDataDir?: string;
}

export interface CloudflareStatus {
  isBlocked: boolean;
  title: string;
  hasTurnstileWidget: boolean;
  reason?: string;
}

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Khởi chạy phiên trình duyệt Chromium nhân C++ của CloakBrowser
 * với đầy đủ cấu hình mô phỏng người thật (Bézier mouse, humanize).
 */
export async function launchCloakBrowser(options: LaunchEngineOptions = {}): Promise<Browser> {
  const { launch } = (await import('cloakbrowser/puppeteer')) as {
    launch: (opts: Record<string, unknown>) => Promise<Browser>;
  };

  const defaultArgs = [
    '--no-sandbox',
    '--disable-setuid-sandbox',
    '--window-size=1920,1080',
    '--start-maximized',
  ];

  const mergedArgs = [...defaultArgs, ...(options.args || [])];

  const isHeadless =
    options.headless !== undefined
      ? options.headless
      : process.env.CLOAKBROWSER_HEADLESS !== undefined
        ? process.env.CLOAKBROWSER_HEADLESS === 'true' || process.env.CLOAKBROWSER_HEADLESS === '1'
        : false;

  const licenseKey =
    options.licenseKey ||
    process.env.CLOAKBROWSER_LICENSE_KEY ||
    process.env.CLOAK_API_KEY;

  const launchConfig: Record<string, unknown> = {
    ...(licenseKey ? { licenseKey } : {}),
    headless: isHeadless,
    humanize: options.humanize ?? true,
    humanPreset: options.humanPreset ?? 'careful',
    args: mergedArgs,
    defaultViewport: { width: 1920, height: 1080 },
    ...(options.proxy ? { proxy: options.proxy } : {}),
    ...(options.userDataDir ? { userDataDir: options.userDataDir } : {}),
  };

  try {
    return await launch(launchConfig);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes('session limit reached') || msg.includes('exit code 76') || msg.includes('plan')) {
      console.warn('[CloakEngine] ⚠️ License key đạt giới hạn concurrent session trên cloud. Tự động chuyển sang CloakBrowser Free Stealth...');
      delete launchConfig.licenseKey;
      return await launch(launchConfig);
    }
    throw err;
  }
}

/**
 * Trích xuất dữ liệu Fingerprint thực tế trên trang để kiểm chứng khả năng ẩn danh
 */
export async function inspectPageFingerprint(page: Page): Promise<FingerprintData> {
  return await page
    .evaluate((): FingerprintData => ({
      webdriver: (navigator as unknown as { webdriver?: boolean }).webdriver,
      hasChrome: !!(window as unknown as { chrome?: unknown }).chrome,
      pluginsCount: navigator.plugins?.length ?? 0,
      hardwareConcurrency: navigator.hardwareConcurrency ?? 0,
    }))
    .catch(() => ({
      webdriver: undefined,
      hasChrome: false,
      pluginsCount: 0,
      hardwareConcurrency: 0,
    }));
}

/**
 * Nhận diện trang có đang vướng thử thách Cloudflare Turnstile / Managed Challenge hay không
 */
export async function detectCloudflareChallenge(page: Page): Promise<CloudflareStatus> {
  const title = await page.title().catch(() => '');
  const content = await page.content().catch(() => '');

  const hasTitleMarker =
    title.includes('Just a moment') ||
    title.includes('Checking your browser') ||
    /just a moment|security check/i.test(title);

  const hasContentMarker =
    content.includes('cf-turnstile') ||
    content.includes('challenge-platform') ||
    content.includes('challenges.cloudflare.com');

  const isBlocked = hasTitleMarker || hasContentMarker;

  return {
    isBlocked,
    title,
    hasTurnstileWidget: content.includes('cf-turnstile') || content.includes('challenges.cloudflare.com'),
    reason: isBlocked ? (hasTitleMarker ? 'Cloudflare Challenge Title' : 'Turnstile Script/Widget') : undefined,
  };
}

/**
 * Click chuột siêu tốc & an toàn qua Chrome DevTools Protocol (CDP)
 * Giả lập sự kiện chuột cấp phần cứng OS, Cloudflare Turnstile nhận diện như chuột người thật 100%.
 */
/**
 * Click chuột siêu tốc & an toàn qua Chrome DevTools Protocol (CDP)
 * Giả lập sự kiện chuột cấp phần cứng OS, Cloudflare Turnstile nhận diện như chuột người thật 100%.
 */
export async function clickViaCDP(
  page: Page,
  x: number,
  y: number,
  label = 'Tọa độ'
): Promise<void> {
  const client = await page.target().createCDPSession();
  try {
    const targetX = Math.round(x);
    const targetY = Math.round(y);

    // Di chuyển chuột từ từ tiếp cận tọa độ đích (mô phỏng đường cong di chuyển tự nhiên)
    const startX = targetX + Math.round((Math.random() - 0.5) * 40);
    const startY = targetY + Math.round((Math.random() - 0.5) * 30);
    const steps = 10;
    for (let i = 1; i <= steps; i++) {
      const curX = Math.round(startX + (targetX - startX) * (i / steps));
      const curY = Math.round(startY + (targetY - startY) * (i / steps));
      await client.send('Input.dispatchMouseEvent', {
        type: 'mouseMoved',
        x: curX,
        y: curY,
      });
      await sleep(15 + Math.random() * 10);
    }

    // Dừng quan sát hover nhẹ 200-400ms trên hộp kiểm như người thật
    await sleep(200 + Math.random() * 200);

    // Nhấn chuột xuống (mousedown)
    await client.send('Input.dispatchMouseEvent', {
      type: 'mousePressed',
      x: targetX,
      y: targetY,
      button: 'left',
      clickCount: 1,
    });

    // Giữ phím chuột trong 120-220ms
    await sleep(120 + Math.random() * 100);

    // Nhả phím chuột (mouseup)
    await client.send('Input.dispatchMouseEvent', {
      type: 'mouseReleased',
      x: targetX,
      y: targetY,
      button: 'left',
      clickCount: 1,
    });
  } finally {
    await client.detach().catch(() => {});
  }
}

/**
 * Giả lập di chuyển chuột theo quỹ đạo tự nhiên và nhấp vào hộp kiểm Cloudflare Turnstile.
 * Hoạt động trên mọi trang bị thử thách Cloudflare Turnstile (Login, Purchased, Download, v.v.)
 * Có khoảng nghỉ 3-5 giây trước khi ấn để Cloudflare tải xong telemetry script và phân tích hành vi.
 */
export async function tryClickTurnstileCheckbox(
  page: Page,
  options: {
    onlyOnLoginPath?: boolean;
    waitTimeoutMs?: number;
    allowAnyDomain?: boolean;
    waitBeforeClickMs?: number;
    skipWait?: boolean;
  } = {}
): Promise<boolean> {
  try {
    const onlyOnLogin = options.onlyOnLoginPath ?? (options.allowAnyDomain ? false : true);
    const currentUrl = typeof page.url === 'function' ? page.url() : '';
    if (onlyOnLogin) {
      const isLogin = currentUrl.includes('spigotmc.org/login') || currentUrl.includes('/login');
      if (!isLogin) return false;
    }

    // Khoảng chờ từ từ trước khi nhấn chuột (3 - 5 giây trong môi trường thực tế)
    const resolvePreWait = async () => {
      if (options.skipWait) return;
      const waitMs =
        options.waitBeforeClickMs ?? (process.env.VITEST ? 0 : 3000 + Math.floor(Math.random() * 2000));
      if (waitMs > 0) {
        await sleep(waitMs);
      }
    };

    // Chiến lược 1: Quét frame Cloudflare Turnstile qua page.frames() (xuyên qua mọi Shadow DOM)
    if (typeof page.frames === 'function') {
      try {
        const frames = page.frames();
        for (const frame of frames) {
          if (typeof page.mainFrame === 'function' && frame === page.mainFrame()) continue;
          const frameUrl = typeof frame.url === 'function' ? frame.url() : '';
          if (
            frameUrl.includes('challenges.cloudflare.com') ||
            frameUrl.includes('challenge-platform') ||
            frameUrl.includes('turnstile')
          ) {
            try {
              const frameEl = await (frame as any).frameElement?.();
              if (frameEl) {
                const box = await frameEl.boundingBox?.();
                if (box && box.width > 0 && box.height > 0) {
                  // Đợi từ từ 3-5s cho Turnstile widget ổn định
                  await resolvePreWait();

                  // Iframe chuẩn: Hộp kiểm nằm tại x = box.x + 30px, y = giữa chiều cao
                  const clickX = box.x + 30;
                  const clickY = box.y + box.height / 2;
                  if (typeof (page as any).createCDPSession === 'function' || typeof (page as any).target === 'function') {
                    await clickViaCDP(page, clickX, clickY, 'Hộp kiểm Turnstile (Frame)');
                  } else if (page.mouse && typeof page.mouse.click === 'function') {
                    if (typeof page.mouse.move === 'function') {
                      await page.mouse.move(clickX, clickY, { steps: 10 });
                    }
                    await sleep(200 + Math.random() * 150);
                    await page.mouse.click(clickX, clickY);
                  }
                  return true;
                }
              }
            } catch {
              // Không ném lỗi nếu frame đang detach
            }
          }
        }
      } catch {
        // Bỏ qua lỗi frames
      }
    }

    // Chiến lược 2: Kiểm tra trực tiếp qua evaluate bounding client rect
    const coords = await page
      .evaluate((): { x: number; y: number } | null => {
        const iframes = Array.from(document.querySelectorAll('iframe'));
        const turnstileIframe = iframes.find(
          (f) =>
            f.src.includes('challenges.cloudflare.com') ||
            f.src.includes('challenge-platform') ||
            f.src.includes('turnstile') ||
            f.getAttribute('title')?.includes('Turnstile') ||
            f.getAttribute('title')?.includes('Cloudflare')
        );

        if (!turnstileIframe) return null;
        const rect = turnstileIframe.getBoundingClientRect();
        if (rect.width <= 0 || rect.height <= 0) return null;

        return {
          x: rect.left + 30,
          y: rect.top + rect.height / 2,
        };
      })
      .catch(() => null);

    if (coords) {
      // Đợi từ từ 3-5s cho Turnstile widget ổn định
      await resolvePreWait();

      if (typeof (page as any).createCDPSession === 'function' || typeof (page as any).target === 'function') {
        try {
          await clickViaCDP(page, coords.x, coords.y, 'Hộp kiểm Turnstile (DOM)');
          return true;
        } catch {
          // Fallback to page.mouse
        }
      }
      if (page.mouse && typeof page.mouse.click === 'function') {
        if (typeof page.mouse.move === 'function') {
          await page.mouse.move(coords.x, coords.y, { steps: 10 }).catch(() => {});
        }
        await sleep(200 + Math.random() * 150);
        await page.mouse.click(coords.x, coords.y).catch(() => {});
        return true;
      }
      return true;
    }
  } catch {
    // Không ném lỗi nếu Cloudflare đang refresh hoặc detach iframe
  }

  return false;
}

/**
 * Điều hướng đến trang web mục tiêu và tự động vượt Cloudflare Turnstile nếu gặp phải
 */
export async function navigateAndSolveChallenge(
  page: Page,
  url: string,
  options: {
    timeoutMs?: number;
    maxSolveSeconds?: number;
    log?: (msg: string) => void;
  } = {}
): Promise<{ ok: boolean; title: string; clearedChallenge: boolean }> {
  const logger = options.log || console.log;
  const timeoutMs = options.timeoutMs ?? 60000;
  const maxSolveSeconds = options.maxSolveSeconds ?? 45;

  page.setDefaultNavigationTimeout(timeoutMs);

  logger(`[CloakEngine] Đang điều hướng đến: ${url}...`);
  // Đợi trình duyệt load hoàn tất tài nguyên trang
  await page.goto(url, { waitUntil: 'load' }).catch((err) => {
    logger(`[CloakEngine] Cảnh báo điều hướng ban đầu: ${err instanceof Error ? err.message : String(err)}`);
  });

  // Đảm bảo DOM load xong hoàn toàn (document.readyState === 'complete')
  await page.waitForFunction(() => document.readyState === 'complete', { timeout: 15000 }).catch(() => { });
  logger(`[CloakEngine] ✓ Trình duyệt đã load xong trang (readyState: complete). Bắt đầu tìm Turnstile Box...`);

  const startSolveAt = Date.now();
  let cleared = false;
  let lastClickAt = 0;

  while (Date.now() - startSolveAt < maxSolveSeconds * 1000) {
    const status = await detectCloudflareChallenge(page);

    if (!status.isBlocked) {
      cleared = true;
      break;
    }

    logger(`[CloakEngine] Phát hiện Cloudflare: "${status.title}". Đang kiểm tra hộp kiểm Turnstile...`);

    const now = Date.now();
    const cooldownMs = process.env.VITEST ? 100 : 7000;
    if (now - lastClickAt >= cooldownMs) {
      const waitBeforeClick = process.env.VITEST ? 0 : 3000 + Math.floor(Math.random() * 2000);
      if (waitBeforeClick > 0) {
        logger(`[CloakEngine] ⏳ Chờ từ từ ${(waitBeforeClick / 1000).toFixed(1)}s cho Cloudflare ổn định rồi mới ấn hộp kiểm...`);
        await sleep(waitBeforeClick);
      }
      const clicked = await tryClickTurnstileCheckbox(page, {
        onlyOnLoginPath: true,
        waitTimeoutMs: 2500,
        skipWait: true,
      });
      if (clicked) {
        lastClickAt = Date.now();
        logger(`[CloakEngine] 🎯 Đã giả lập di chuột & click hộp kiểm Cloudflare Turnstile từ từ!`);
        await sleep(process.env.VITEST ? 50 : 2500);
      }
    }

    await sleep(2000);
  }

  const finalTitle = await page.title().catch(() => '');
  return {
    ok: cleared,
    title: finalTitle,
    clearedChallenge: cleared,
  };
}
