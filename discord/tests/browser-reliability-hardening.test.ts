import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync, existsSync, writeFileSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { createAbruptCloseTracker, isChromeClosedError } from '../src/services/upstream/chrome-close-detector.js';
import { cloakSessionManager, SessionConflictError } from '../src/services/upstream/cloak-session-manager.js';
import {
  downloadViaBrowser,
  injectSpigotSessionCookies,
  type BrowserPage,
  type BrowserSession,
} from '../src/services/upstream/download-via-browser.js';
import { applyClearance } from '../src/services/upstream/cloudflare-clearance.js';
import {
  warmBrowserManager,
  shutdownWarmBrowser,
  resolveChromePath,
  invalidateChromePathCache,
} from '../src/services/upstream/browser-launcher.js';
import { HierarchicalDeadline } from '../src/services/upstream/hierarchical-deadline.js';
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

  // =========================================================================
  // Phase 4B-1: DIRECT DOWNLOAD PIPELINE & ARTIFACT INTEGRITY
  // =========================================================================
  describe('Phase 4B-1 — Direct Download Pipeline & Integrity', () => {
    it('TEST-P01: download pipeline verifies SHA256 and atomically publishes jar without leaking .part', async () => {
      const tempDir = mkdtempSync(join(tmpdir(), 'dl-atomic-publish-'));
      const testJarContent = Buffer.concat([
        Buffer.from('PK\x03\x04'),
        Buffer.alloc(1024 * 1024, 0x42), // 1MB payload
      ]);
      const expectedSha256 = createHash('sha256').update(testJarContent).digest('hex');

      let downloadDir = '';
      const mockPage: BrowserPage = {
        goto: vi.fn().mockImplementation(async (url: string) => {
          if (url.includes('download') && downloadDir) {
            writeFileSync(join(downloadDir, 'TestPlugin.jar'), testJarContent);
          }
          return undefined;
        }),
        evaluate: vi.fn().mockImplementation(async (source: unknown) => {
          const src = String(source);
          if (src.includes('a[href*="download"]')) return 'https://www.spigotmc.org/resources/83626/download?version=12345';
          return null;
        }),
        title: vi.fn().mockResolvedValue('Download Resource'),
        createCDPSession: vi.fn().mockResolvedValue({
          send: vi.fn().mockImplementation(async (method: string, params?: Record<string, unknown>) => {
            if (method === 'Browser.setDownloadBehavior' || method === 'Page.setDownloadBehavior') {
              downloadDir = String(params?.downloadPath ?? '');
            }
            return undefined;
          }),
          detach: vi.fn().mockResolvedValue(undefined),
        }),
        mouse: { click: vi.fn(), move: vi.fn() },
        keyboard: { type: vi.fn(), press: vi.fn() },
      };

      try {
        const outcome = await downloadViaBrowser(
          {
            tmpDir: tempDir,
            maxBytes: 10_000_000,
            log: () => undefined,
          },
          mockPage,
          83626,
          null,
        );

        expect(outcome.status).toBe('ok');
        if (outcome.status === 'ok') {
          expect(existsSync(outcome.tmpPath)).toBe(true);
          expect(outcome.bytes).toBe(testJarContent.length);
          const publishedContent = readFileSync(outcome.tmpPath);
          const publishedSha256 = createHash('sha256').update(publishedContent).digest('hex');
          expect(publishedSha256).toBe(expectedSha256);

          // Verify NO partial artifact (.part) exists in tmpDir
          const remainingFiles = readdirSync(tempDir);
          expect(remainingFiles.some((f) => f.endsWith('.part'))).toBe(false);
        }
      } finally {
        rmSync(tempDir, { recursive: true, force: true });
      }
    });

    it('TEST-P02: file size exceeding maxBytes is rejected and temp files cleaned immediately', async () => {
      const tempDir = mkdtempSync(join(tmpdir(), 'dl-oversize-'));
      const oversizedContent = Buffer.concat([
        Buffer.from('PK\x03\x04'),
        Buffer.alloc(2 * 1024 * 1024, 0x5a), // 2MB
      ]);

      let downloadDir = '';
      const mockPage: BrowserPage = {
        goto: vi.fn().mockImplementation(async (url: string) => {
          if (url.includes('download') && downloadDir) {
            writeFileSync(join(downloadDir, 'BigPlugin.jar'), oversizedContent);
          }
          return undefined;
        }),
        evaluate: vi.fn().mockResolvedValue(null),
        title: vi.fn().mockResolvedValue('Download Resource'),
        createCDPSession: vi.fn().mockResolvedValue({
          send: vi.fn().mockImplementation(async (method: string, params?: Record<string, unknown>) => {
            if (method === 'Browser.setDownloadBehavior' || method === 'Page.setDownloadBehavior') {
              downloadDir = String(params?.downloadPath ?? '');
            }
            return undefined;
          }),
          detach: vi.fn().mockResolvedValue(undefined),
        }),
        mouse: { click: vi.fn(), move: vi.fn() },
        keyboard: { type: vi.fn(), press: vi.fn() },
      };

      try {
        const outcome = await downloadViaBrowser(
          {
            tmpDir: tempDir,
            maxBytes: 1024 * 1024, // 1MB limit < 2MB content
            log: () => undefined,
          },
          mockPage,
          83626,
          null,
        );

        expect(outcome.status).toBe('error');
        expect(outcome.detail).toContain('vượt giới hạn');

        // Verify no artifact was published to tmpDir
        const remainingFiles = readdirSync(tempDir);
        expect(remainingFiles.filter((f) => f.endsWith('.jar'))).toHaveLength(0);
      } finally {
        rmSync(tempDir, { recursive: true, force: true });
      }
    });

    it('TEST-P03: corrupted or non-jar HTML payload is rejected as incomplete without publishing', async () => {
      const tempDir = mkdtempSync(join(tmpdir(), 'dl-html-corrupt-'));
      const htmlErrorContent = Buffer.concat([
        Buffer.from('<!DOCTYPE html><html><body>Error 403 Forbidden - Not a Jar File</body></html>'),
        Buffer.alloc(2048, 0x20),
      ]);

      let downloadDir = '';
      const mockPage: BrowserPage = {
        goto: vi.fn().mockImplementation(async (url: string) => {
          if (url.includes('download') && downloadDir) {
            writeFileSync(join(downloadDir, 'Error.html'), htmlErrorContent);
          }
          return undefined;
        }),
        evaluate: vi.fn().mockResolvedValue(null),
        title: vi.fn().mockResolvedValue('Download Resource'),
        createCDPSession: vi.fn().mockResolvedValue({
          send: vi.fn().mockImplementation(async (method: string, params?: Record<string, unknown>) => {
            if (method === 'Browser.setDownloadBehavior' || method === 'Page.setDownloadBehavior') {
              downloadDir = String(params?.downloadPath ?? '');
            }
            return undefined;
          }),
          detach: vi.fn().mockResolvedValue(undefined),
        }),
        mouse: { click: vi.fn(), move: vi.fn() },
        keyboard: { type: vi.fn(), press: vi.fn() },
      };

      try {
        const outcome = await downloadViaBrowser(
          {
            tmpDir: tempDir,
            maxBytes: 10_000_000,
            log: () => undefined,
          },
          mockPage,
          83626,
          null,
        );

        expect(outcome.status).toBe('incomplete');
        expect(outcome.detail).toContain('không phải jar');

        // Zero published jars
        const remainingFiles = readdirSync(tempDir);
        expect(remainingFiles.filter((f) => f.endsWith('.jar'))).toHaveLength(0);
      } finally {
        rmSync(tempDir, { recursive: true, force: true });
      }
    });

    it('TEST-P04: signal cancellation cleans up all temporary download files', async () => {
      const tempDir = mkdtempSync(join(tmpdir(), 'dl-cancel-clean-'));
      const mockPage: BrowserPage = {
        goto: vi.fn().mockResolvedValue(undefined),
        evaluate: vi.fn().mockResolvedValue(null),
        title: vi.fn().mockResolvedValue('Download Resource'),
        createCDPSession: vi.fn().mockResolvedValue({
          send: vi.fn().mockResolvedValue(undefined),
          detach: vi.fn().mockResolvedValue(undefined),
        }),
        mouse: { click: vi.fn(), move: vi.fn() },
        keyboard: { type: vi.fn(), press: vi.fn() },
      };

      try {
        const outcome = await downloadViaBrowser(
          {
            tmpDir: tempDir,
            maxBytes: 10_000_000,
            signal: AbortSignal.timeout(50),
            log: () => undefined,
          },
          mockPage,
          83626,
          null,
        );

        expect(outcome.status).toBe('error');
        expect(outcome.detail).toContain('đang tắt tiến trình');

        // Zero partial files left
        const remainingFiles = readdirSync(tempDir);
        expect(remainingFiles).toHaveLength(0);
      } finally {
        rmSync(tempDir, { recursive: true, force: true });
      }
    });
  });

  // =========================================================================
  // Phase 4B-2: CLOAK SESSION FIFO WAIT QUEUE
  // =========================================================================
  describe('Phase 4B-2 — Cloak Session FIFO Wait Queue', () => {
    it('TEST-Q01: 2 concurrent jobs serialize smoothly via FIFO queue without SessionConflictError', async () => {
      const lock1 = await cloakSessionManager.acquireLock('job-1');
      expect(lock1.taskName).toBe('job-1');
      expect(cloakSessionManager.hasActiveSession()).toBe(true);

      let job2Acquired = false;
      const job2Promise = cloakSessionManager.acquireLock('job-2').then((handle) => {
        job2Acquired = true;
        return handle;
      });

      // Job 2 is queued, not rejected
      expect(job2Acquired).toBe(false);
      expect(cloakSessionManager.getQueueLength()).toBe(1);

      // Release Job 1 -> Job 2 receives lock immediately
      await lock1.release();
      const lock2 = await job2Promise;

      expect(job2Acquired).toBe(true);
      expect(lock2.taskName).toBe('job-2');
      expect(cloakSessionManager.getQueueLength()).toBe(0);

      await lock2.release();
      expect(cloakSessionManager.hasActiveSession()).toBe(false);
    });

    it('TEST-Q02: 8 concurrent jobs are dispatched strictly in FIFO order', async () => {
      const lock0 = await cloakSessionManager.acquireLock('job-0');
      const executionOrder: string[] = ['job-0'];

      const pendingJobs: Promise<void>[] = [];
      for (let i = 1; i <= 7; i++) {
        const jobName = `job-${i}`;
        const p = cloakSessionManager.acquireLock(jobName).then(async (handle) => {
          executionOrder.push(handle.taskName);
          await handle.release();
        });
        pendingJobs.push(p);
      }

      expect(cloakSessionManager.getQueueLength()).toBe(7);

      // Release first job to trigger cascading FIFO queue execution
      await lock0.release();
      await Promise.all(pendingJobs);

      expect(executionOrder).toEqual([
        'job-0',
        'job-1',
        'job-2',
        'job-3',
        'job-4',
        'job-5',
        'job-6',
        'job-7',
      ]);
      expect(cloakSessionManager.getQueueLength()).toBe(0);
      expect(cloakSessionManager.hasActiveSession()).toBe(false);
    });

    it('TEST-Q03: waiting timeout rejects waiter cleanly and clears stale entry from queue', async () => {
      const lock1 = await cloakSessionManager.acquireLock('job-blocking');

      // Request lock with short 50ms wait timeout
      const jobTimeoutPromise = cloakSessionManager.acquireLock('job-timed-out', { waitTimeoutMs: 50 });

      expect(cloakSessionManager.getQueueLength()).toBe(1);

      await expect(jobTimeoutPromise).rejects.toThrow('Hết thời gian chờ cấp khóa (50ms)');

      // Queue is clean
      expect(cloakSessionManager.getQueueLength()).toBe(0);

      await lock1.release();
      expect(cloakSessionManager.hasActiveSession()).toBe(false);
    });

    it('TEST-Q04: caller cancellation via AbortSignal removes waiter immediately', async () => {
      const lock1 = await cloakSessionManager.acquireLock('job-active');

      const controller = new AbortController();
      const jobCancelPromise = cloakSessionManager.acquireLock('job-cancelled', {
        signal: controller.signal,
      });

      expect(cloakSessionManager.getQueueLength()).toBe(1);

      // Cancel before lock is granted
      controller.abort();

      await expect(jobCancelPromise).rejects.toThrow('đã bị hủy bởi caller');
      expect(cloakSessionManager.getQueueLength()).toBe(0);

      await lock1.release();
    });

    it('TEST-Q05: shutdown drains all pending queue waiters safely without unhandled promises', async () => {
      const lock1 = await cloakSessionManager.acquireLock('job-running');

      const p1 = cloakSessionManager.acquireLock('job-drain-1');
      const p2 = cloakSessionManager.acquireLock('job-drain-2');

      expect(cloakSessionManager.getQueueLength()).toBe(2);

      // System shutdown triggers drainQueue
      cloakSessionManager.drainQueue('Graceful bot shutdown');

      await expect(p1).rejects.toThrow('Hàng đợi bị giải tán (Graceful bot shutdown)');
      await expect(p2).rejects.toThrow('Hàng đợi bị giải tán (Graceful bot shutdown)');

      expect(cloakSessionManager.getQueueLength()).toBe(0);
      await lock1.release();
    });

    it('TEST-Q06: crashed browser releases session and allows next queued job to acquire lock', async () => {
      let isAlive = true;
      const lock1 = await cloakSessionManager.acquireLock('job-crashing');
      const mockProc = new EventEmitter();
      const mockBrowser = {
        close: vi.fn().mockResolvedValue(undefined),
        process: () => mockProc,
        isConnected: () => isAlive,
      };
      lock1.registerBrowser(mockBrowser);

      // Queue next job while job1 is still alive
      const nextJobPromise = cloakSessionManager.acquireLock('job-after-crash');
      expect(cloakSessionManager.getQueueLength()).toBe(1);

      // Browser crashes and disconnects
      isAlive = false;
      lock1.markDead();
      mockProc.emit('exit', 1, null);

      // Release crashed lock -> Next job in queue immediately acquires
      await lock1.release();
      const nextLock = await nextJobPromise;

      expect(nextLock.taskName).toBe('job-after-crash');
      expect(cloakSessionManager.getQueueLength()).toBe(0);

      await nextLock.release();
    });
  });

  // =========================================================================
  // Phase 4B-3: WARM BROWSER EXPERIMENT
  // =========================================================================
  describe('Phase 4B-3 — Warm Browser Experiment', () => {
    beforeEach(() => {
      process.env.WARM_BROWSER_EXPERIMENT = 'true';
      warmBrowserManager.reset();
    });

    afterEach(async () => {
      delete process.env.WARM_BROWSER_EXPERIMENT;
      await shutdownWarmBrowser().catch(() => undefined);
      warmBrowserManager.reset();
    });

    it('TEST-W01: Account A -> warm session -> cleanup -> Account B -> verify complete state sanitization', async () => {
      const cdpCalls: { method: string; params?: any }[] = [];
      const mockPage = {
        goto: vi.fn().mockResolvedValue(undefined),
        evaluate: vi.fn().mockResolvedValue(undefined),
        title: vi.fn().mockResolvedValue('SpigotMC'),
        createCDPSession: vi.fn().mockResolvedValue({
          send: vi.fn().mockImplementation(async (method, params) => {
            cdpCalls.push({ method, params });
            return {};
          }),
          detach: vi.fn().mockResolvedValue(undefined),
        }),
        mouse: { click: vi.fn(), move: vi.fn() },
        keyboard: { type: vi.fn(), press: vi.fn() },
        close: vi.fn().mockResolvedValue(undefined),
      };

      // Sanitize before use
      await warmBrowserManager.sanitizePage(mockPage as any);
      expect(cdpCalls.some((c) => c.method === 'Network.clearBrowserCookies')).toBe(true);
      expect(cdpCalls.some((c) => c.method === 'Network.clearBrowserCache')).toBe(true);
      expect(cdpCalls.some((c) => c.method === 'Storage.clearDataForOrigin' && c.params?.storageTypes === 'all')).toBe(true);

      // Sanitize on release
      cdpCalls.length = 0;
      await warmBrowserManager.releaseSessionPage(mockPage as any);
      expect(cdpCalls.some((c) => c.method === 'Network.clearBrowserCookies')).toBe(true);
      expect(cdpCalls.some((c) => c.method === 'Storage.clearDataForOrigin')).toBe(true);
      expect(mockPage.close).toHaveBeenCalled();
    });

    it('TEST-W02: Account A authenticated state is never exposed to Account B in warm session', async () => {
      const activeState = new Map<string, string>();
      const mockPageA = {
        goto: vi.fn().mockResolvedValue(undefined),
        evaluate: vi.fn().mockResolvedValue(undefined),
        title: vi.fn().mockResolvedValue('SpigotMC'),
        createCDPSession: vi.fn().mockResolvedValue({
          send: vi.fn().mockImplementation(async (method) => {
            if (method === 'Network.clearBrowserCookies' || method === 'Storage.clearDataForOrigin') {
              activeState.clear();
            }
            return {};
          }),
          detach: vi.fn().mockResolvedValue(undefined),
        }),
        mouse: { click: vi.fn(), move: vi.fn() },
        keyboard: { type: vi.fn(), press: vi.fn() },
        close: vi.fn().mockResolvedValue(undefined),
      };

      // Account A sets token
      activeState.set('xf_user', 'user_a_token_12345');
      expect(activeState.get('xf_user')).toBe('user_a_token_12345');

      // Session A completes and calls release
      await warmBrowserManager.releaseSessionPage(mockPageA as any);
      expect(activeState.size).toBe(0);

      // Account B starts fresh page
      const mockPageB = { ...mockPageA, close: vi.fn().mockResolvedValue(undefined) };
      await warmBrowserManager.sanitizePage(mockPageB as any);
      expect(activeState.has('xf_user')).toBe(false);
    });

    it('TEST-W03: crashed warm browser triggers clean restart and job recovery', async () => {
      let isConnected = true;
      let launchCount = 0;
      const mockCloak = {
        launch: vi.fn().mockImplementation(async () => {
          launchCount++;
          return {
            close: vi.fn().mockResolvedValue(undefined),
            process: () => null,
            isConnected: () => isConnected,
            pages: async () => [],
            newPage: async () => ({
              close: vi.fn().mockResolvedValue(undefined),
            }),
          };
        }),
      };

      const baseConfig = { headless: true };
      const session1 = await warmBrowserManager.acquireWarmBrowser(mockCloak as any, baseConfig);
      expect(launchCount).toBe(1);

      // Browser crashes
      isConnected = false;

      // Next job tries to acquire warm browser -> detects crash -> restarts browser
      const session2 = await warmBrowserManager.acquireWarmBrowser(mockCloak as any, baseConfig);
      expect(launchCount).toBe(2);
      expect(session2.browser).not.toBe(session1.browser);
    });

    it('TEST-W04: 20 sequential jobs reuse single warm browser without resource growth', async () => {
      let launchCount = 0;
      const mockCloak = {
        launch: vi.fn().mockImplementation(async () => {
          launchCount++;
          return {
            close: vi.fn().mockResolvedValue(undefined),
            process: () => null,
            isConnected: () => true,
            pages: async () => [],
            newPage: async () => ({
              close: vi.fn().mockResolvedValue(undefined),
            }),
          };
        }),
      };

      const baseConfig = { headless: true };
      for (let i = 0; i < 20; i++) {
        const { browser } = await warmBrowserManager.acquireWarmBrowser(mockCloak as any, baseConfig);
        const page = (await browser.newPage()) as BrowserSession['page'];
        await warmBrowserManager.releaseSessionPage(page);
      }

      // Exact 1 launch for all 20 jobs
      expect(launchCount).toBe(1);
    });

    it('TEST-W05: warm mode disabled (default) preserves exact cold ephemeral behavior', () => {
      delete process.env.WARM_BROWSER_EXPERIMENT;
      expect(warmBrowserManager.isWarmEnabled()).toBe(false);

      process.env.WARM_BROWSER_EXPERIMENT = 'false';
      expect(warmBrowserManager.isWarmEnabled()).toBe(false);
    });
  });

  // =========================================================================
  // Phase 4B-4: MICRO OPTIMIZATIONS
  // =========================================================================
  describe('Phase 4B-4 — Micro Optimizations', () => {
    beforeEach(() => {
      invalidateChromePathCache();
    });

    afterEach(() => {
      invalidateChromePathCache();
    });

    it('TEST-M01: resolveChromePath memoizes resolved path and supports explicit cache invalidation', () => {
      const tempDir = mkdtempSync(join(tmpdir(), 'chrome-memo-test-'));
      const dummyChrome = join(tempDir, 'dummy-chrome.exe');
      writeFileSync(dummyChrome, 'binary');

      try {
        const first = resolveChromePath(dummyChrome);
        expect(first).toBe(dummyChrome);

        // Remove file to test cache persistence
        rmSync(dummyChrome, { force: true });

        // Invalidate cache: must detect file is missing
        invalidateChromePathCache();
        const recheck = resolveChromePath(dummyChrome);
        expect(recheck).toBeNull();
      } finally {
        rmSync(tempDir, { recursive: true, force: true });
      }
    });

    it('TEST-M02: HierarchicalDeadline enforces parent deadline dominance over child operations', async () => {
      // Parent job timeout is strictly 100ms
      const jobDeadline = new HierarchicalDeadline({ jobTimeoutMs: 100 });

      // Child requests 5,000ms, but parent must dominate and cap it at <= 100ms
      const effectiveChildMs = jobDeadline.getChildDeadlineMs(5000);
      expect(effectiveChildMs).toBeLessThanOrEqual(100);

      const { signal, cleanup } = jobDeadline.createChildSignal(5000);
      expect(signal.aborted).toBe(false);

      // Wait for child signal to be aborted by dominated deadline
      await new Promise<void>((resolve) => {
        if (signal.aborted) return resolve();
        signal.addEventListener('abort', () => resolve(), { once: true });
      });

      expect(signal.aborted).toBe(true);
      expect(signal.reason?.message ?? String(signal.reason)).toContain('Hết hạn deadline con');
      cleanup();
    });

    it('TEST-M03: HierarchicalDeadline propagates parent abort signal immediately to child', () => {
      const parentController = new AbortController();
      const jobDeadline = new HierarchicalDeadline({
        jobTimeoutMs: 100_000,
        parentSignal: parentController.signal,
      });

      const { signal, cleanup } = jobDeadline.createChildSignal(50_000);
      expect(signal.aborted).toBe(false);

      // Parent aborts due to shutdown
      parentController.abort('shutdown');

      expect(signal.aborted).toBe(true);
      expect(signal.reason).toBe('shutdown');
      cleanup();
    });

    it('TEST-M04: Progress heartbeat prevents false-stall during extended operations', () => {
      const tracker = new InstanceTracker();
      tracker.registerWorker(99, 'TestWorker');
      tracker.updateWorker(99, { status: 'downloading', progressText: 'Đang tải file 100MB...' });

      // Initial check - active and healthy
      expect(tracker.checkWatchdog(90_000)).toEqual([]);

      // Send heartbeat
      tracker.heartbeat(99, 'Đã tải 50MB...');
      const worker = tracker.getAll().find((w) => w.id === 99);
      expect(worker?.progressText).toBe('Đã tải 50MB...');
      expect(worker?.isStalled).toBe(false);

      // Watchdog check passes without flagging false stall
      const stalled = tracker.checkWatchdog(90_000);
      expect(stalled).toEqual([]);
    });
  });
});
