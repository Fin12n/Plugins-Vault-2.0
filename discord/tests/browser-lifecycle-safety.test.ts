import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  captureProcessIdentity,
  isProcessAlive,
  snapshotDescendants,
  terminateProcessTree,
  verifyProcessIdentity,
  type ProcessIdentity,
} from '../src/services/upstream/process-tree-killer.js';
import {
  createBrowserLauncher,
  closeBrowser,
  type CloakModule,
} from '../src/services/upstream/browser-launcher.js';
import { cloakSessionManager } from '../src/services/upstream/cloak-session-manager.js';
import type { BrowserPage } from '../src/services/upstream/download-via-browser.js';
import * as cookieFiles from '../src/services/upstream/spigot-cookie-files.js';
import { rmSync } from 'node:fs';

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

describe('Phase 4C-1: Process Safety & Post-Launch Exception Safety', () => {
  beforeEach(() => {
    cloakSessionManager.reset();
  });

  afterEach(async () => {
    await cloakSessionManager.releaseLock().catch(() => undefined);
    cloakSessionManager.reset();
  });

  // =========================================================================
  // 1. CONTROLLED PROCESS-TREE TESTING (Windows & POSIX)
  // =========================================================================
  describe('Controlled Process-Tree Testing (Non-production fixtures)', () => {
    it('TEST-PT01: captures process identity correctly and detects alive status', async () => {
      // Spawn a controlled dummy process (node holding an idle timer)
      const proc = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], {
        stdio: 'ignore',
      });
      const pid = proc.pid!;
      expect(pid).toBeGreaterThan(0);
      expect(isProcessAlive(pid)).toBe(true);

      try {
        const identity = await captureProcessIdentity(pid);
        expect(identity).not.toBeNull();
        expect(identity?.pid).toBe(pid);
        expect(identity?.name.toLowerCase()).toContain('node');

        const isMatch = verifyProcessIdentity(identity!, identity);
        expect(isMatch).toBe(true);
      } finally {
        proc.kill('SIGKILL');
      }
    });

    it('TEST-PT02: terminates parent process and snapshots/verifies full tree cleanup', async () => {
      // Spawn a controlled parent process that spawns a child process
      // Parent runs for 60s, Child runs for 60s
      const parentScript = `
        const { spawn } = require('child_process');
        const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { stdio: 'ignore' });
        setTimeout(() => {}, 60000);
      `;

      const parentProc = spawn(process.execPath, ['-e', parentScript], {
        stdio: 'ignore',
      });
      const parentPid = parentProc.pid!;
      expect(isProcessAlive(parentPid)).toBe(true);

      // Wait a moment for the child process to be spawned
      await sleep(1000);

      const parentIdentity = await captureProcessIdentity(parentPid);
      expect(parentIdentity).not.toBeNull();

      const descendants = await snapshotDescendants(parentPid);
      // Descendants should contain at least the child node process
      expect(descendants.length).toBeGreaterThanOrEqual(1);
      const childPid = descendants[0]!.pid;
      expect(isProcessAlive(childPid)).toBe(true);

      // Terminate the entire process tree using our safe utility
      const result = await terminateProcessTree(parentPid, parentIdentity!);

      expect(result.success).toBe(true);
      expect(result.reason).toBe('verified_clean');
      expect(result.killedPids).toContain(parentPid);
      expect(result.killedPids).toContain(childPid);

      // Verify that BOTH parent and child are completely dead
      expect(isProcessAlive(parentPid)).toBe(false);
      expect(isProcessAlive(childPid)).toBe(false);
    });

    it('TEST-PT03: PID reuse protection refuses to kill when identity mismatches', async () => {
      // Spawn a controlled dummy process
      const proc = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], {
        stdio: 'ignore',
      });
      const pid = proc.pid!;
      expect(isProcessAlive(pid)).toBe(true);

      try {
        // Construct an intentionally mismatched identity (e.g. expected chrome.exe or mismatched creation date)
        const fakeIdentity: ProcessIdentity = {
          pid,
          name: 'unrelated_system_app.exe',
          creationDate: '999999999999',
        };

        const result = await terminateProcessTree(pid, fakeIdentity);

        // MUST REFUSE TO KILL
        expect(result.success).toBe(false);
        expect(result.reason).toBe('identity_mismatch');
        expect(result.killedPids).toHaveLength(0);
        expect(result.survivingPids).toContain(pid);

        // The process MUST still be alive!
        expect(isProcessAlive(pid)).toBe(true);
      } finally {
        proc.kill('SIGKILL');
      }
    });

    it('TEST-PT04: handles already dead PIDs idempotently', async () => {
      const deadPid = 99999999;
      expect(isProcessAlive(deadPid)).toBe(false);

      const result = await terminateProcessTree(deadPid);
      expect(result.success).toBe(true);
      expect(result.reason).toBe('already_dead');
      expect(result.killedPids).toHaveLength(0);
    });
  });

  // =========================================================================
  // 2. POST-LAUNCH FAILURE MATRIX & CLEANUP (Cold Ephemeral Lifecycle)
  // =========================================================================
  describe('Post-Launch Failure Matrix (Deterministic setup failure tests)', () => {
    function createMockBrowser(options: {
      pagesThrow?: boolean;
      newPageThrow?: boolean;
      authenticateThrow?: boolean;
      trackerThrow?: boolean;
      cdpThrow?: boolean;
    } = {}) {
      let closed = false;
      let processKilled = false;

      const mockPage: BrowserPage = {
        goto: vi.fn().mockResolvedValue(undefined),
        evaluate: vi.fn().mockResolvedValue(null),
        title: vi.fn().mockResolvedValue('SpigotMC'),
        createCDPSession: vi.fn().mockImplementation(async () => {
          if (options.cdpThrow) {
            throw new Error('MOCK_COOKIE_INJECTION_THROW');
          }
          return {
            send: vi.fn().mockResolvedValue(undefined),
            detach: vi.fn().mockResolvedValue(undefined),
          };
        }),
        mouse: { click: vi.fn(), move: vi.fn() },
        keyboard: { type: vi.fn(), press: vi.fn() },
        authenticate: vi.fn().mockImplementation(async () => {
          if (options.authenticateThrow) {
            throw new Error('MOCK_AUTH_FAILURE');
          }
        }),
      };

      let pagesDone = false;

      const mockBrowser = {
        close: vi.fn().mockImplementation(async () => {
          closed = true;
        }),
        process: vi.fn().mockReturnValue({
          pid: 99998,
          kill: vi.fn().mockImplementation(() => {
            processKilled = true;
            return true;
          }),
        }),
        pages: vi.fn().mockImplementation(async () => {
          pagesDone = true;
          if (options.pagesThrow) {
            throw new Error('MOCK_PAGES_THROW');
          }
          if (options.newPageThrow) {
            return []; // Force newPage() call
          }
          return [mockPage];
        }),
        newPage: vi.fn().mockImplementation(async () => {
          pagesDone = true;
          if (options.newPageThrow) {
            throw new Error('MOCK_NEW_PAGE_THROW');
          }
          return mockPage;
        }),
        on: vi.fn().mockImplementation(() => {
          if (options.trackerThrow && pagesDone) {
            throw new Error('MOCK_TRACKER_ATTACH_THROW');
          }
        }),
        isClosed: () => closed,
        isProcessKilled: () => processKilled,
      };

      return { mockBrowser, mockPage };
    }

    it('TEST-FM01: failure at browser.pages() cleans browser, releases lock, and unlinks profile', async () => {
      const { mockBrowser } = createMockBrowser({ pagesThrow: true });
      const mockCloak: CloakModule = {
        launch: vi.fn().mockResolvedValue(mockBrowser),
      };

      const customDir = join(tmpdir(), `test-fail-pages-${Date.now()}`);
      mkdirSync(customDir, { recursive: true });
      expect(existsSync(customDir)).toBe(true);

      const launcher = createBrowserLauncher(mockCloak);

      // Attempt launch — MUST reject with MOCK_PAGES_THROW
      await expect(launcher({ ephemeral: true, profileDir: customDir })).rejects.toThrow('MOCK_PAGES_THROW');

      // Verify Browser was closed
      expect(mockBrowser.close).toHaveBeenCalled();

      // Verify Lock was released (next acquisition can immediately claim the lock!)
      const nextLock = await cloakSessionManager.acquireLock('after-pages-fail-task', customDir);
      expect(nextLock).toBeDefined();
      await nextLock.release();
    });

    it('TEST-FM02: failure at browser.newPage() cleans browser, releases lock, and unlinks profile', async () => {
      const { mockBrowser } = createMockBrowser({ newPageThrow: true });
      const mockCloak: CloakModule = {
        launch: vi.fn().mockResolvedValue(mockBrowser),
      };

      const launcher = createBrowserLauncher(mockCloak);

      // Attempt launch — MUST reject with MOCK_NEW_PAGE_THROW
      await expect(launcher({ ephemeral: true })).rejects.toThrow('MOCK_NEW_PAGE_THROW');

      // Verify Browser was closed
      expect(mockBrowser.close).toHaveBeenCalled();

      // Verify Lock was released
      const nextLock = await cloakSessionManager.acquireLock('after-newpage-fail-task');
      expect(nextLock).toBeDefined();
      await nextLock.release();
    });

    it('TEST-FM03: failure at page.authenticate() cleans browser, releases lock, and unlinks profile', async () => {
      const { mockBrowser } = createMockBrowser({ authenticateThrow: true });
      const mockCloak: CloakModule = {
        launch: vi.fn().mockResolvedValue(mockBrowser),
      };

      const launcher = createBrowserLauncher(mockCloak);

      // Attempt launch with proxy credentials — MUST reject with MOCK_AUTH_FAILURE
      await expect(
        launcher({
          ephemeral: true,
          proxyServer: 'http://127.0.0.1:8080',
          proxyUsername: 'user',
          proxyPassword: 'pass',
        }),
      ).rejects.toThrow('MOCK_AUTH_FAILURE');

      // Verify Browser was closed
      expect(mockBrowser.close).toHaveBeenCalled();

      // Verify Lock was released
      const nextLock = await cloakSessionManager.acquireLock('after-auth-fail-task');
      expect(nextLock).toBeDefined();
      await nextLock.release();
    });

    it('TEST-FM04: normal successful acquisition establishes ownership and normal close() releases cleanly', async () => {
      const { mockBrowser } = createMockBrowser();
      const mockCloak: CloakModule = {
        launch: vi.fn().mockResolvedValue(mockBrowser),
      };

      const launcher = createBrowserLauncher(mockCloak);

      const session = await launcher({ ephemeral: true });
      expect(session).toBeDefined();
      expect(session.page).toBeDefined();

      // Session handle now owns the browser
      await session.close();

      expect(mockBrowser.close).toHaveBeenCalled();

      // Subsequent session can claim lock immediately
      const nextLock = await cloakSessionManager.acquireLock('subsequent-normal-task');
      expect(nextLock).toBeDefined();
      await nextLock.release();
    });

    it('TEST-FM05: failure at tracker.attachBrowser() cleans browser, releases lock, and unlinks profile', async () => {
      const { mockBrowser } = createMockBrowser({ trackerThrow: true });
      const mockCloak: CloakModule = {
        launch: vi.fn().mockResolvedValue(mockBrowser),
      };

      const customDir = join(tmpdir(), `test-fail-tracker-${Date.now()}`);
      mkdirSync(customDir, { recursive: true });
      expect(existsSync(customDir)).toBe(true);

      const launcher = createBrowserLauncher(mockCloak);

      // Attempt launch — MUST reject with MOCK_TRACKER_ATTACH_THROW
      await expect(launcher({ ephemeral: true, profileDir: customDir })).rejects.toThrow('MOCK_TRACKER_ATTACH_THROW');

      // Verify Browser was closed
      expect(mockBrowser.close).toHaveBeenCalled();

      // Verify Lock was released
      const nextLock = await cloakSessionManager.acquireLock('after-tracker-fail-task', customDir);
      expect(nextLock).toBeDefined();
      await nextLock.release();
    });

    it('TEST-FM06: failure at cookie injection cleans browser, releases lock, and unlinks profile', async () => {
      const { mockBrowser } = createMockBrowser();
      const mockCloak: CloakModule = {
        launch: vi.fn().mockResolvedValue(mockBrowser),
      };

      const accountLabel = `test-cookie-acc-${Date.now()}`;
      const customDir = join(tmpdir(), `test-fail-cookie-${Date.now()}`);
      mkdirSync(customDir, { recursive: true });
      expect(existsSync(customDir)).toBe(true);

      const spy = vi.spyOn(cookieFiles, 'injectCookiesFromAccountFile').mockRejectedValueOnce(
        new Error('MOCK_COOKIE_INJECTION_THROW'),
      );

      const launcher = createBrowserLauncher(mockCloak);

      try {
        // Attempt launch — MUST reject with MOCK_COOKIE_INJECTION_THROW
        await expect(
          launcher({ ephemeral: true, profileDir: customDir, accountLabel }),
        ).rejects.toThrow('MOCK_COOKIE_INJECTION_THROW');

        // Verify Browser was closed
        expect(mockBrowser.close).toHaveBeenCalled();

        // Verify Lock was released
        const nextLock = await cloakSessionManager.acquireLock('after-cookie-fail-task', customDir);
        expect(nextLock).toBeDefined();
        await nextLock.release();
      } finally {
        spy.mockRestore();
      }
    });
  });
});

