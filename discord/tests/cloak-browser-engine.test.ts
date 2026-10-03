import { describe, it, expect, vi } from 'vitest';
import {
  detectCloudflareChallenge,
  tryClickTurnstileCheckbox,
  inspectPageFingerprint,
} from '../src/services/upstream/cloak-browser-engine.js';
import type { Page } from 'puppeteer-core';

describe('CloakBrowser Engine - Cloudflare Detection & Turnstile Solver', () => {
  it('phát hiện trang bị chặn bởi tiêu đề Cloudflare', async () => {
    const mockPage = {
      title: vi.fn().mockResolvedValue('Just a moment...'),
      content: vi.fn().mockResolvedValue('<html><body>Checking your browser before accessing spigotmc.org</body></html>'),
    } as unknown as Page;

    const status = await detectCloudflareChallenge(mockPage);
    expect(status.isBlocked).toBe(true);
    expect(status.title).toBe('Just a moment...');
    expect(status.reason).toBe('Cloudflare Challenge Title');
  });

  it('phát hiện trang có iframe cf-turnstile widget', async () => {
    const mockPage = {
      title: vi.fn().mockResolvedValue('SpigotMC - High Performance Minecraft'),
      content: vi.fn().mockResolvedValue('<html><body><div id="cf-turnstile" src="https://challenges.cloudflare.com/turnstile"></div></body></html>'),
    } as unknown as Page;

    const status = await detectCloudflareChallenge(mockPage);
    expect(status.isBlocked).toBe(true);
    expect(status.hasTurnstileWidget).toBe(true);
  });

  it('xác nhận trang sạch khi không có dấu hiệu Cloudflare', async () => {
    const mockPage = {
      title: vi.fn().mockResolvedValue('Log in | SpigotMC - High Performance Minecraft'),
      content: vi.fn().mockResolvedValue('<html><body><form id="pageLogin">...</form></body></html>'),
    } as unknown as Page;

    const status = await detectCloudflareChallenge(mockPage);
    expect(status.isBlocked).toBe(false);
    expect(status.hasTurnstileWidget).toBe(false);
    expect(status.reason).toBeUndefined();
  });

  it('giả lập click hộp kiểm Turnstile khi ở domain https://spigotmc.org/login/login', async () => {
    const moveFn = vi.fn().mockResolvedValue(undefined);
    const clickFn = vi.fn().mockResolvedValue(undefined);

    const mockPage = {
      url: vi.fn().mockReturnValue('https://spigotmc.org/login/login'),
      evaluate: vi.fn().mockResolvedValue({ x: 300, y: 400 }),
      mouse: {
        move: moveFn,
        click: clickFn,
      },
    } as unknown as Page;

    const clicked = await tryClickTurnstileCheckbox(mockPage);
    expect(clicked).toBe(true);
    expect(moveFn).toHaveBeenCalledWith(expect.any(Number), expect.any(Number), { steps: 10 });
    expect(clickFn).toHaveBeenCalledWith(300, 400);
  });

  it('từ chối click hộp kiểm Turnstile khi không ở domain spigotmc.org/login/login', async () => {
    const clickFn = vi.fn().mockResolvedValue(undefined);

    const mockPage = {
      url: vi.fn().mockReturnValue('https://browserleaks.com/ip'),
      evaluate: vi.fn().mockResolvedValue({ x: 300, y: 400 }),
      mouse: {
        click: clickFn,
      },
    } as unknown as Page;

    const clicked = await tryClickTurnstileCheckbox(mockPage);
    expect(clicked).toBe(false);
    expect(clickFn).not.toHaveBeenCalled();
  });

  it('trích xuất dữ liệu fingerprint navigator chính xác', async () => {
    const mockPage = {
      evaluate: vi.fn().mockResolvedValue({
        webdriver: undefined,
        hasChrome: true,
        pluginsCount: 5,
        hardwareConcurrency: 8,
      }),
    } as unknown as Page;

    const fp = await inspectPageFingerprint(mockPage);
    expect(fp.webdriver).toBeUndefined();
    expect(fp.hasChrome).toBe(true);
    expect(fp.pluginsCount).toBe(5);
    expect(fp.hardwareConcurrency).toBe(8);
  });
});
