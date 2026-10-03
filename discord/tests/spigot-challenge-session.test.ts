import { describe, expect, it, vi } from 'vitest';
import { SpigotChallengeSessionManager } from '../src/services/upstream/spigot-challenge-session.js';
import type { BrowserPage, BrowserSession } from '../src/services/upstream/download-via-browser.js';
import { createChallengeResumeHandler } from '../src/services/upstream/challenge-resume.js';

function makeSession() {
  const send = vi.fn(async () => ({ data: Buffer.from('frame').toString('base64') }));
  const page = {
    evaluate: vi.fn(async (source: string) =>
      source.includes('data-logged-in') ? false : { width: 1200, height: 800 },
    ),
    createCDPSession: vi.fn(async () => ({ send })),
    mouse: { click: vi.fn(async () => undefined), move: vi.fn(async () => undefined) },
    keyboard: { type: vi.fn(async () => undefined), press: vi.fn(async () => undefined) },
  } as unknown as BrowserPage;
  const close = vi.fn(async () => undefined);
  return { session: { page, close } satisfies BrowserSession, page, close, send };
}

describe('SpigotChallengeSessionManager', () => {
  it('resumes the queued download without forcing every account to rescan', () => {
    const triggerUpdateCheck = vi.fn(() => true);
    const resume = createChallengeResumeHandler(() => ({ triggerUpdateCheck }));

    resume();

    expect(triggerUpdateCheck).toHaveBeenCalledWith(false);
  });

  it('retries the resume trigger when the previous sweep is still finishing', async () => {
    vi.useFakeTimers();
    try {
      const triggerUpdateCheck = vi.fn()
        .mockReturnValueOnce(false)
        .mockReturnValueOnce(true);
      const resume = createChallengeResumeHandler(
        () => ({ triggerUpdateCheck }),
        { retryDelayMs: 10, maxAttempts: 3 },
      );

      resume();
      expect(triggerUpdateCheck).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(10);
      expect(triggerUpdateCheck).toHaveBeenCalledTimes(2);
      expect(triggerUpdateCheck).toHaveBeenLastCalledWith(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it('hands a held VPS browser to the dashboard without exposing credentials', async () => {
    const manager = new SpigotChallengeSessionManager();
    const { session, page, send } = makeSession();

    await manager.hold({
      accountLabel: 'account-a',
      reason: 'Cloudflare challenge',
      session,
      retryLogin: async () => ({ ok: true }),
    });

    expect(manager.getStatus()).toMatchObject({
      active: true,
      accountLabel: 'account-a',
      reason: 'Cloudflare challenge',
    });
    expect(JSON.stringify(manager.getStatus())).not.toContain('private-user');
    expect(JSON.stringify(manager.getStatus())).not.toContain('private-password');

    await manager.movePointer(0.25, 0.5);
    await manager.click(1.5, -1);
    await manager.typeText('hello');
    await manager.pressKey('Enter');
    const frame = await manager.captureFrame();

    expect(page.mouse.move).toHaveBeenNthCalledWith(1, 300, 400);
    expect(page.mouse.move).toHaveBeenNthCalledWith(2, 1200, 0);
    expect(page.mouse.click).toHaveBeenCalledWith(1200, 0);
    expect(page.keyboard.type).toHaveBeenCalledWith('hello', { delay: 35 });
    expect(page.keyboard.press).toHaveBeenCalledWith('Enter');
    expect(send).toHaveBeenCalledWith('Page.captureScreenshot', {
      format: 'jpeg', quality: 75, fromSurface: true,
    });
    expect(frame).toEqual({ image: Buffer.from('frame'), width: 1200, height: 800 });

    await manager.close();
  });

  it('closes a replaced session and triggers the resume handler only after resolve', async () => {
    const manager = new SpigotChallengeSessionManager();
    const first = makeSession();
    const second = makeSession();
    const resolved = vi.fn();
    manager.setResolvedHandler(resolved);

    await manager.hold({
      accountLabel: 'first',
      reason: 'first challenge',
      session: first.session,
      retryLogin: async () => ({ ok: true }),
    });
    await manager.hold({
      accountLabel: 'second',
      reason: 'second challenge',
      session: second.session,
      retryLogin: async () => ({ ok: true }),
    });

    expect(first.close).toHaveBeenCalledOnce();
    expect(resolved).not.toHaveBeenCalled();

    await manager.resolve();
    expect(second.close).toHaveBeenCalledOnce();
    expect(manager.hasActive()).toBe(false);
    expect(resolved).toHaveBeenCalledOnce();
  });

  it('rejects browser input after the challenge session is closed', async () => {
    const manager = new SpigotChallengeSessionManager();
    await expect(manager.captureFrame()).rejects.toThrow('phiên xác minh');
    await expect(manager.movePointer(0.5, 0.5)).rejects.toThrow('phiên xác minh');
    await expect(manager.click(0.5, 0.5)).rejects.toThrow('phiên xác minh');
  });

  it('runs the held workflow continuation when the admin retries', async () => {
    const manager = new SpigotChallengeSessionManager();
    const { session } = makeSession();
    const retryLogin = vi.fn(async () => ({ ok: false as const, reason: 'challenged' as const, detail: 'still blocked' }));
    await manager.hold({ accountLabel: 'account-a', reason: 'challenge', session, retryLogin });

    await expect(manager.retryLogin()).resolves.toEqual({
      ok: false,
      reason: 'challenged',
      detail: 'still blocked',
    });
    expect(retryLogin).toHaveBeenCalledOnce();
  });

  it('automatically resumes after the held page becomes logged in', async () => {
    const manager = new SpigotChallengeSessionManager({ autoResumeIntervalMs: 5 });
    const { session, page, close } = makeSession();
    const resolved = vi.fn();
    manager.setResolvedHandler(resolved);
    page.evaluate = vi.fn(async (source: string) =>
      source.includes('data-logged-in') ? true : { width: 1200, height: 800 },
    ) as typeof page.evaluate;
    const retryLogin = vi.fn(async () => ({ ok: true as const }));

    await manager.hold({ accountLabel: 'account-a', reason: 'challenge', session, retryLogin });

    await vi.waitFor(() => expect(resolved).toHaveBeenCalledOnce(), { timeout: 250 });
    expect(retryLogin).toHaveBeenCalledOnce();
    expect(manager.hasActive()).toBe(false);
    expect(close).toHaveBeenCalledOnce();
  });

  it('does not hammer a failed continuation while the same login marker remains', async () => {
    const manager = new SpigotChallengeSessionManager({ autoResumeIntervalMs: 5 });
    const { session, page } = makeSession();
    page.evaluate = vi.fn(async (source: string) =>
      source.includes('data-logged-in') ? true : { width: 1200, height: 800 },
    ) as typeof page.evaluate;
    const retryLogin = vi.fn(async () => ({
      ok: false as const,
      reason: 'challenged' as const,
      detail: 'Purchased Resources vẫn bị chặn',
    }));
    await manager.hold({ accountLabel: 'account-a', reason: 'challenge', session, retryLogin });

    await vi.waitFor(() => expect(retryLogin).toHaveBeenCalledOnce(), { timeout: 250 });
    await new Promise((resolve) => setTimeout(resolve, 30));

    expect(retryLogin).toHaveBeenCalledOnce();
    expect(manager.getStatus().reason).toBe('Purchased Resources vẫn bị chặn');
    await manager.close();
  });

  it('does not let frame polling race a login retry', async () => {
    const manager = new SpigotChallengeSessionManager();
    const { session } = makeSession();
    let finishRetry!: (result: { ok: true }) => void;
    const retryLogin = vi.fn(() => new Promise<{ ok: true }>((resolve) => { finishRetry = resolve; }));
    await manager.hold({ accountLabel: 'account-a', reason: 'challenge', session, retryLogin });

    const pending = manager.retryLogin();
    await expect(manager.captureFrame()).rejects.toThrow('thử lại sau');
    finishRetry({ ok: true });
    await expect(pending).resolves.toEqual({ ok: true });
    await manager.close();
  });

  it('releases an unresponsive browser instead of hanging the queue forever', async () => {
    const manager = new SpigotChallengeSessionManager({ interactiveTimeoutMs: 5, closeTimeoutMs: 5 });
    const { session, page, close } = makeSession();
    const resolved = vi.fn();
    manager.setResolvedHandler(resolved);
    page.evaluate = vi.fn(() => new Promise(() => undefined)) as typeof page.evaluate;
    await manager.hold({ accountLabel: 'account-a', reason: 'challenge', session, retryLogin: async () => ({ ok: true }) });

    await expect(manager.captureFrame()).rejects.toThrow('không phản hồi');
    expect(manager.hasActive()).toBe(false);
    expect(close).toHaveBeenCalledOnce();
    expect(resolved).toHaveBeenCalledOnce();
  });
});
