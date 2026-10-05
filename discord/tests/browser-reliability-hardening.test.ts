import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync, existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createAbruptCloseTracker, isChromeClosedError } from '../src/services/upstream/chrome-close-detector.js';
import { cloakSessionManager, SessionConflictError } from '../src/services/upstream/cloak-session-manager.js';
import {
  downloadViaBrowser,
  injectSpigotSessionCookies,
  type BrowserPage,
  type BrowserSession,
} from '../src/services/upstream/download-via-browser.js';
import { applyClearance } from '../src/services/upstream/cloudflare-clearance.js';
import { InstanceTracker } from '../src/services/maintenance/instance-tracker.js';

describe('Phase 4A — Browser Reliability Hardening', () => {
  beforeEach(() => {
    cloakSessionManager.reset();
  });

  afterEach(async () => {
    await cloakSessionManager.releaseLock().catch(() => undefined);
    cloakSessionManager.reset();
  });

  // =========================================================================
  // TEST-D01: cookie validation exception → no browser leak → next session succeeds
  // =========================================================================
  it('TEST-D01: cookie validation exception releases session lock and allows next acquisition', async () => {
    let candidateClosed = false;
    const lockHandle = await cloakSessionManager.acquireLock('cookie-validation-test');

    const candidateSession: BrowserSession = {
      page: {
        goto: vi.fn().mockRejectedValue(new Error('Network timeout during cookie check')),
        evaluate: vi.fn(),
        title: vi.fn().mockResolvedValue('SpigotMC'),
        createCDPSession: vi.fn().mockResolvedValue({ send: vi.fn(), detach: vi.fn() }),
        mouse: { click: vi.fn(), move: vi.fn() },
        keyboard: { type: vi.fn(), press: vi.fn() },
      },
      close: async () => {
        candidateClosed = true;
        await lockHandle.release();
      },
    };

    let session: BrowserSession | null = null;
    let adopted = false;

    // Simulate scheduler.ts ownership-safe pattern
    try {
      // goto rejects with error
      await candidateSession.page.goto('https://www.spigotmc.org/resources/purchased');
      session = candidateSession;
      adopted = true;
    } catch {
      // Error caught
    } finally {
      if (!adopted && candidateSession) {
        await candidateSession.close().catch(() => undefined);
      }
    }

    expect(candidateClosed).toBe(true);
    expect(session).toBeNull();
    expect(cloakSessionManager.hasActiveSession()).toBe(false);

    // Next session acquisition must succeed without SessionConflictError
    const nextLock = await cloakSessionManager.acquireLock('next-login-session');
    expect(nextLock).toBeDefined();
    expect(nextLock.taskName).toBe('next-login-session');
    await nextLock.release();
  });

  // =========================================================================
  // TEST-D02: cookie invalid → no browser leak
  // =========================================================================
  it('TEST-D02: cookie invalid closes candidate session and leaves lock clean', async () => {
    let candidateClosed = false;
    const lockHandle = await cloakSessionManager.acquireLock('cookie-invalid-test');

    const candidateSession: BrowserSession = {
      page: {
        goto: vi.fn().mockResolvedValue(undefined),
        evaluate: vi.fn().mockResolvedValue(false), // hasUser === false
        title: vi.fn().mockResolvedValue('SpigotMC Login'),
        createCDPSession: vi.fn().mockResolvedValue({ send: vi.fn(), detach: vi.fn() }),
        mouse: { click: vi.fn(), move: vi.fn() },
        keyboard: { type: vi.fn(), press: vi.fn() },
      },
      close: async () => {
        candidateClosed = true;
        await lockHandle.release();
      },
    };

    let session: BrowserSession | null = null;
    let adopted = false;

    try {
      await candidateSession.page.goto('https://www.spigotmc.org/resources/purchased');
      const hasUser = await candidateSession.page.evaluate('check' as never);
      if (hasUser) {
        session = candidateSession;
        adopted = true;
      }
    } finally {
      if (!adopted && candidateSession) {
        await candidateSession.close().catch(() => undefined);
      }
    }

    expect(candidateClosed).toBe(true);
    expect(session).toBeNull();
    expect(cloakSessionManager.hasActiveSession()).toBe(false);

    const nextLock = await cloakSessionManager.acquireLock('fallback-login');
    expect(nextLock.taskName).toBe('fallback-login');
    await nextLock.release();
  });

  // =========================================================================
  // TEST-D03: CDP normal completion → detach
  // =========================================================================
  it('TEST-D03: CDP session detaches on normal operation completion', async () => {
    const detachMock = vi.fn().mockResolvedValue(undefined);
    const sendMock = vi.fn().mockResolvedValue(undefined);

    const page: BrowserPage = {
      goto: vi.fn().mockResolvedValue(undefined),
      evaluate: vi.fn().mockResolvedValue(undefined),
      title: vi.fn().mockResolvedValue('SpigotMC'),
      createCDPSession: vi.fn().mockResolvedValue({
        send: sendMock,
        detach: detachMock,
      }),
      mouse: { click: vi.fn(), move: vi.fn() },
      keyboard: { type: vi.fn(), press: vi.fn() },
    };

    const injected = await injectSpigotSessionCookies(page, { xfUser: 'test_user', xfSession: 'test_session' });
    expect(injected).toBe(true);
    expect(sendMock).toHaveBeenCalledWith('Network.enable');
    expect(detachMock).toHaveBeenCalledTimes(1);
  });

  // =========================================================================
  // TEST-D04: CDP exception → detach
  // =========================================================================
  it('TEST-D04: CDP session detaches deterministically when operation throws', async () => {
    const detachMock = vi.fn().mockResolvedValue(undefined);
    const sendMock = vi.fn().mockImplementation((method: string) => {
      if (method === 'Network.enable') {
        throw new Error('CDP socket pipe destroyed');
      }
      return Promise.resolve(undefined);
    });

    const page: BrowserPage = {
      goto: vi.fn().mockResolvedValue(undefined),
      evaluate: vi.fn().mockResolvedValue(undefined),
      title: vi.fn().mockResolvedValue('SpigotMC'),
      createCDPSession: vi.fn().mockResolvedValue({
        send: sendMock,
        detach: detachMock,
      }),
      mouse: { click: vi.fn(), move: vi.fn() },
      keyboard: { type: vi.fn(), press: vi.fn() },
    };

    await expect(
      applyClearance(
        page,
        { cookies: { cf_clearance: 'cf123' }, userAgent: '' },
        '.spigotmc.org',
        'Mozilla/5.0',
      ),
    ).rejects.toThrow('CDP socket pipe destroyed');

    expect(detachMock).toHaveBeenCalledTimes(1);
  });

  // =========================================================================
  // TEST-D05: CDP timeout → detach
  // =========================================================================
  it('TEST-D05: CDP session detaches when download loop reaches timeout or aborts', async () => {
    const detachMock = vi.fn().mockResolvedValue(undefined);
    const sendMock = vi.fn().mockResolvedValue(undefined);

    const mockPage: BrowserPage = {
      goto: vi.fn().mockResolvedValue(undefined),
      evaluate: vi.fn().mockResolvedValue(null),
      title: vi.fn().mockResolvedValue('Download Resource'),
      createCDPSession: vi.fn().mockResolvedValue({
        send: sendMock,
        detach: detachMock,
      }),
      mouse: { click: vi.fn(), move: vi.fn() },
      keyboard: { type: vi.fn(), press: vi.fn() },
    };

    const tempDir = mkdtempSync(join(tmpdir(), 'cdp-timeout-test-'));

    try {
      const outcome = await downloadViaBrowser(
        {
          tmpDir: tempDir,
          maxBytes: 10_000_000,
          signal: AbortSignal.timeout(50),
          log: () => undefined,
        },
        mockPage,
        99999,
        null,
      );

      // Verify CDP session was detached deterministically upon timeout/abort
      expect(detachMock).toHaveBeenCalled();
      expect(outcome.status).toBe('error');
      expect(outcome.detail).toContain('đang tắt tiến trình');
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  // =========================================================================
  // TEST-D06: abrupt browser close → listener fires → unsubscribe works
  // =========================================================================
  it('TEST-D06: abrupt close tracker supports unsubscribe and clears listeners on dispose', () => {
    const tracker = createAbruptCloseTracker();
    const mockBrowser = new EventEmitter();
    tracker.attachBrowser(mockBrowser);

    const listenerA = vi.fn();
    const listenerB = vi.fn();

    const unsubA = tracker.onAbruptClose(listenerA);
    const unsubB = tracker.onAbruptClose(listenerB);

    // Unsubscribe listener A
    unsubA();

    // Trigger abrupt close
    mockBrowser.emit('disconnected');

    expect(tracker.isAbruptlyClosed()).toBe(true);
    expect(listenerA).not.toHaveBeenCalled();
    expect(listenerB).toHaveBeenCalledTimes(1);

    // Verify dispose clears listeners and marks graceful
    const listenerC = vi.fn();
    tracker.dispose();
    expect(tracker.isGraceful()).toBe(true);

    tracker.onAbruptClose(listenerC);
    expect(listenerC).not.toHaveBeenCalled();
  });

  // =========================================================================
  // TEST-D07: browser crash → session lock released → new session can start
  // =========================================================================
  it('TEST-D07: browser process crash is detected and lock automatically recovered for next session', async () => {
    const lockHandle = await cloakSessionManager.acquireLock('crashed-job');

    const mockProc = new EventEmitter();
    const mockBrowser = {
      close: vi.fn().mockResolvedValue(undefined),
      process: () => mockProc,
      isConnected: () => false, // Disconnected!
    };

    lockHandle.registerBrowser(mockBrowser);
    expect(cloakSessionManager.hasActiveSession()).toBe(true);

    // Browser disconnects / process crashes
    mockProc.emit('exit', 1, null);

    // Attempt to acquire lock for next task — MUST auto-recover without SessionConflictError
    const nextHandle = await cloakSessionManager.acquireLock('recovered-job');
    expect(nextHandle.taskName).toBe('recovered-job');
    await nextHandle.release();
    expect(cloakSessionManager.hasActiveSession()).toBe(false);
  });

  // =========================================================================
  // TEST-D08: browser crash once → auto-restart succeeds
  // =========================================================================
  it('TEST-D08: browser crash on first attempt triggers automatic retry with fresh session', async () => {
    let launchCount = 0;
    let crashCount = 0;
    const maxCrashes = 2;

    const simulateAcquisition = async () => {
      launchCount++;
      const lockHandle = await cloakSessionManager.acquireLock(`job-attempt-${launchCount}`);

      try {
        if (launchCount === 1) {
          // Crash on first attempt
          crashCount++;
          await lockHandle.release();
          throw new Error('chrome_abruptly_closed: Connection closed');
        }

        // Second attempt succeeds
        const outcome = { status: 'ok' as const, bytes: 5000 };
        await lockHandle.release();
        return outcome;
      } catch (err) {
        await lockHandle.release().catch(() => undefined);
        if (isChromeClosedError(err) && crashCount <= maxCrashes) {
          // Bounded restart logic
          return simulateAcquisition();
        }
        throw err;
      }
    };

    const result = await simulateAcquisition();
    expect(result.status).toBe('ok');
    expect(launchCount).toBe(2);
    expect(crashCount).toBe(1);
    expect(cloakSessionManager.hasActiveSession()).toBe(false);
  });

  // =========================================================================
  // TEST-D09: repeated browser crashes → bounded retry → no infinite restart
  // =========================================================================
  it('TEST-D09: repeated browser crashes are bounded to max retry limit and fail safely', async () => {
    let launchAttempts = 0;
    let consecutiveCrashes = 0;
    const MAX_CONSECUTIVE_CRASHES = 2;

    const runCrashingJob = async (): Promise<{ status: string; detail: string }> => {
      while (true) {
        launchAttempts++;
        const lockHandle = await cloakSessionManager.acquireLock(`crash-loop-${launchAttempts}`);

        try {
          // Simulate persistent crash on every attempt
          throw new Error('TargetCloseError: Protocol error (Page.navigate): Target closed');
        } catch (err) {
          await lockHandle.release().catch(() => undefined);

          if (isChromeClosedError(err)) {
            consecutiveCrashes++;
            if (consecutiveCrashes <= MAX_CONSECUTIVE_CRASHES) {
              // Retry
              continue;
            }
            return {
              status: 'error',
              detail: `chrome_abruptly_closed: crash limit reached (${consecutiveCrashes})`,
            };
          }
          throw err;
        }
      }
    };

    const finalResult = await runCrashingJob();
    expect(finalResult.status).toBe('error');
    expect(finalResult.detail).toContain('crash limit reached (3)');
    expect(launchAttempts).toBe(3); // Exactly 1 initial + 2 retries = 3 attempts total, NO infinite loop!
    expect(cloakSessionManager.hasActiveSession()).toBe(false);
  });

  // =========================================================================
  // TEST-D10: timeout during browser operation → all resources released
  // =========================================================================
  it('TEST-D10: operation timeout cleans up browser, session lock, and temp profile', async () => {
    const tempProfileDir = mkdtempSync(join(tmpdir(), 'timeout-profile-'));
    writeFileSync(join(tempProfileDir, 'state.json'), '{"test":true}');

    let browserClosed = false;
    const lockHandle = await cloakSessionManager.acquireLock('timeout-test', tempProfileDir);

    const mockBrowser = {
      close: async () => {
        browserClosed = true;
      },
      process: () => null,
    };
    lockHandle.registerBrowser(mockBrowser);

    // Simulate an operation running under an AbortSignal / timeout
    const performOperationWithTimeout = async (timeoutMs: number) => {
      try {
        await new Promise((_, reject) => setTimeout(() => reject(new Error('Operation timeout (deadline reached)')), timeoutMs));
      } finally {
        await mockBrowser.close();
        await lockHandle.release();
      }
    };

    await expect(performOperationWithTimeout(10)).rejects.toThrow('Operation timeout');

    expect(browserClosed).toBe(true);
    expect(cloakSessionManager.hasActiveSession()).toBe(false);
    expect(existsSync(tempProfileDir)).toBe(false); // Cleaned up!
  });

  // =========================================================================
  // TEST-D11: watchdog → long valid operation not falsely reported as stalled
  // =========================================================================
  it('TEST-D11: worker with regular heartbeats during long operation is never falsely marked stalled', () => {
    const tracker = new InstanceTracker();
    tracker.registerWorker(1);
    tracker.updateWorker(1, {
      status: 'downloading',
      accountLabel: 'acc-premium',
      progressText: 'Đang tải plugin 100MB...',
    });

    const worker = tracker.getAll().find((w) => w.id === 1)!;
    // Simulate worker started 120s ago (> 90s threshold)
    worker.startedAt = Date.now() - 120_000;
    worker.updatedAt = Date.now() - 120_000;

    // But it has sent a recent heartbeat (5 seconds ago) as download chunks arrived!
    tracker.heartbeat(1, 'Đang tải… 50MB / 100MB');
    worker.lastHeartbeatAt = Date.now() - 5_000;

    // Check watchdog with 90s threshold
    const stalled = tracker.checkWatchdog(90_000);

    // Worker 1 MUST NOT be reported as stalled!
    expect(stalled).not.toContain(1);
    expect(worker.status).toBe('downloading');
    expect(worker.isStalled).toBe(false);

    // On the other hand, a truly abandoned worker without heartbeats for 95s MUST be caught
    tracker.registerWorker(2);
    tracker.updateWorker(2, { status: 'downloading' });
    const stalledWorker = tracker.getAll().find((w) => w.id === 2)!;
    stalledWorker.lastHeartbeatAt = Date.now() - 95_000;
    stalledWorker.updatedAt = Date.now() - 95_000;

    const stalledCheck2 = tracker.checkWatchdog(90_000);
    expect(stalledCheck2).toContain(2);
    expect(stalledWorker.isStalled).toBe(true);
  });

  // =========================================================================
  // TEST-D12: normal successful browser lifecycle → zero leaked listeners, locks, browsers
  // =========================================================================
  it('TEST-D12: full normal browser lifecycle leaves zero leaked listeners, locks, or processes', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'normal-lifecycle-'));
    let browserCloseCalls = 0;

    const lockHandle = await cloakSessionManager.acquireLock('clean-job', tempDir);
    const tracker = createAbruptCloseTracker();
    const mockBrowser = new EventEmitter();

    tracker.attachBrowser(mockBrowser);

    const mockBrowserHandle = {
      close: async () => {
        browserCloseCalls++;
      },
      process: () => null,
      isConnected: () => true,
    };
    lockHandle.registerBrowser(mockBrowserHandle);

    const listener = vi.fn();
    const unsubscribe = tracker.onAbruptClose(listener);

    const session: BrowserSession = {
      page: {
        goto: vi.fn().mockResolvedValue(undefined),
        evaluate: vi.fn().mockResolvedValue(true),
        title: vi.fn().mockResolvedValue('Dashboard'),
        createCDPSession: vi.fn().mockResolvedValue({
          send: vi.fn().mockResolvedValue(undefined),
          detach: vi.fn().mockResolvedValue(undefined),
        }),
        mouse: { click: vi.fn(), move: vi.fn() },
        keyboard: { type: vi.fn(), press: vi.fn() },
      },
      close: async () => {
        unsubscribe();
        tracker.dispose();
        await mockBrowserHandle.close();
        await lockHandle.release();
      },
      onAbruptClose: (cb) => tracker.onAbruptClose(cb),
      isAbruptlyClosed: () => tracker.isAbruptlyClosed(),
    };

    // Simulate normal successful operation
    await session.page.goto('https://www.spigotmc.org/');
    const cdp = await session.page.createCDPSession();
    try {
      await cdp.send('Page.enable');
    } finally {
      await cdp.detach?.();
    }

    // Clean session shutdown
    await session.close();

    // Verification
    expect(browserCloseCalls).toBe(1);
    expect(cloakSessionManager.hasActiveSession()).toBe(false);
    expect(tracker.isGraceful()).toBe(true);
    expect(listener).not.toHaveBeenCalled();

    // Mutex is completely free for next acquisition
    const nextHandle = await cloakSessionManager.acquireLock('next-clean-job');
    expect(nextHandle).toBeDefined();
    await nextHandle.release();

    if (existsSync(tempDir)) {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });
});
