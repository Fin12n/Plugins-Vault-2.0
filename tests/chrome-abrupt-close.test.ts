import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { EventEmitter } from 'node:events';
import { migrate } from '../src/db/migrate.js';
import { createPlugin } from '../src/repositories/plugins.js';
import { recordOwnership } from '../src/repositories/resource-ownership.js';
import { autoDownloadVersions } from '../src/services/upstream/auto-download-versions.js';
import type { UpdateFinding } from '../src/services/upstream/check-plugin-updates.js';
import { Secret } from '../src/services/upstream/spigot-account-store.js';
import { createAbruptCloseTracker, isChromeClosedError } from '../src/services/upstream/chrome-close-detector.js';
import { InstanceTracker } from '../src/services/maintenance/instance-tracker.js';

describe('Abrupt Chrome Close Handling', () => {
  describe('isChromeClosedError', () => {
    it('accurately recognizes CDP and process exit errors as Chrome closed', () => {
      expect(isChromeClosedError(new Error('TargetCloseError: Protocol error (Page.navigate): Target closed'))).toBe(true);
      expect(isChromeClosedError(new Error('Protocol error: Connection closed. Most likely the browser has been closed or crashed'))).toBe(true);
      expect(isChromeClosedError(new Error('Target closed'))).toBe(true);
      expect(isChromeClosedError(new Error('Session closed. Most likely the page has been closed'))).toBe(true);
      expect(isChromeClosedError(new Error('Browser has been disconnected'))).toBe(true);
      expect(isChromeClosedError(new Error('Navigation failed because browser has disconnected!'))).toBe(true);
      expect(isChromeClosedError(new Error('Execution context was destroyed'))).toBe(true);
      expect(isChromeClosedError('chrome_abruptly_closed: Connection closed')).toBe(true);
      expect(isChromeClosedError('Page crashed')).toBe(true);
      expect(isChromeClosedError('Trình duyệt Chrome đã bị đóng')).toBe(true);
    });

    it('does not misclassify ordinary network or application errors', () => {
      expect(isChromeClosedError(new Error('connect ETIMEDOUT 1.2.3.4:443'))).toBe(false);
      expect(isChromeClosedError(new Error('HTTP 404: Not Found'))).toBe(false);
      expect(isChromeClosedError(new Error('Sai mật khẩu hoặc mã xác thực'))).toBe(false);
      expect(isChromeClosedError(null)).toBe(false);
      expect(isChromeClosedError(undefined)).toBe(false);
    });
  });

  describe('createAbruptCloseTracker', () => {
    it('notifies listener when browser disconnects unexpectedly', () => {
      const tracker = createAbruptCloseTracker();
      const mockBrowser = new EventEmitter();
      tracker.attachBrowser(mockBrowser);

      let notifiedReason = '';
      tracker.onAbruptClose((reason) => {
        notifiedReason = reason;
      });

      expect(tracker.isAbruptlyClosed()).toBe(false);
      mockBrowser.emit('disconnected');

      expect(tracker.isAbruptlyClosed()).toBe(true);
      expect(notifiedReason).toContain('mất kết nối hoặc bị đóng');
    });

    it('notifies listener when Chrome process exits unexpectedly', () => {
      const tracker = createAbruptCloseTracker();
      const mockProc = new EventEmitter();
      const mockBrowser = {
        process: () => mockProc,
      };
      tracker.attachBrowser(mockBrowser);

      let notified = false;
      tracker.onAbruptClose(() => {
        notified = true;
      });

      mockProc.emit('exit', 1, null);
      expect(tracker.isAbruptlyClosed()).toBe(true);
      expect(notified).toBe(true);
      expect(tracker.getAbruptReason()).toContain('Tiến trình Chrome đã tắt');
    });

    it('does NOT trigger abrupt close when closed gracefully', () => {
      const tracker = createAbruptCloseTracker();
      const mockBrowser = new EventEmitter();
      tracker.attachBrowser(mockBrowser);

      let notified = false;
      tracker.onAbruptClose(() => {
        notified = true;
      });

      // Mark graceful close first
      tracker.markGraceful();
      mockBrowser.emit('disconnected');

      expect(tracker.isAbruptlyClosed()).toBe(false);
      expect(notified).toBe(false);
      expect(tracker.isGraceful()).toBe(true);
    });
  });

  describe('InstanceTracker worker stopped status', () => {
    it('correctly sets stopped status and ignores it in watchdog', () => {
      const tracker = new InstanceTracker();
      tracker.registerWorker(1);

      tracker.stopWorker(1, 'Chrome bị tắt đột ngột');
      const worker = tracker.getAll().find((w) => w.id === 1);
      expect(worker?.status).toBe('stopped');
      expect(worker?.lastError).toBe('Chrome bị tắt đột ngột');

      // Watchdog check should not consider stopped worker as stalled
      const stalled = tracker.checkWatchdog(0);
      expect(stalled).not.toContain(1);
    });
  });

  describe('autoDownloadVersions immediate abort on Chrome close', () => {
    let db: Database.Database;
    let root: string;
    let accountsFile: string;

    beforeEach(async () => {
      root = await mkdtemp(join(tmpdir(), 'chrome-close-test-'));
      await mkdir(join(root, 'vault'), { recursive: true });
      await mkdir(join(root, 'tmp'), { recursive: true });
      accountsFile = join(root, 'spigot-credentials.json');

      db = new Database(':memory:');
      db.pragma('foreign_keys = ON');
      migrate(db);

      createPlugin(db, {
        slug: 'plugin-one',
        displayName: 'Plugin One',
        descriptorName: 'PluginOne',
        platform: 'spigot',
        depositPrice: 0,
        isPremium: true,
        resourceId: 1001,
      });

      createPlugin(db, {
        slug: 'plugin-two',
        displayName: 'Plugin Two',
        descriptorName: 'PluginTwo',
        platform: 'spigot',
        depositPrice: 0,
        isPremium: true,
        resourceId: 1002,
      });

      recordOwnership(db, 1001, 'tester', 'owned');
      recordOwnership(db, 1002, 'tester', 'owned');
    });

    afterEach(async () => {
      db.close();
      await rm(root, { recursive: true, force: true });
    });

    it('aborts the sweep immediately and does NOT attempt subsequent findings when Chrome is closed abruptly', async () => {
      const stubAccount = {
        label: 'tester',
        xfUser: new Secret('u'),
        xfSession: new Secret('s'),
        issuedAt: null,
        lastVerifiedAt: null,
        status: 'ok' as const,
      };

      const findings: UpdateFinding[] = [
        {
          pluginId: 1,
          pluginName: 'Plugin One',
          resourceId: 1001,
          isPremium: true,
          upstream: { uuid: 'v-1', name: '1.0.0', releaseDateMs: Date.now(), downloads: 1 },
          archivedVersion: null,
        },
        {
          pluginId: 2,
          pluginName: 'Plugin Two',
          resourceId: 1002,
          isPremium: true,
          upstream: { uuid: 'v-2', name: '2.0.0', releaseDateMs: Date.now(), downloads: 1 },
          archivedVersion: null,
        },
      ];

      const attemptedResourceIds: number[] = [];
      const fetchJar = async (_account: unknown, resId: number) => {
        attemptedResourceIds.push(resId);
        // Simulate Chrome window closed by user
        return {
          status: 'error' as const,
          detail: 'chrome_abruptly_closed: TargetCloseError: Protocol error (Page.navigate): Target closed',
        };
      };

      const sweep = await autoDownloadVersions(
        {
          db,
          ingest: { db, vaultDir: join(root, 'vault'), tmpDir: join(root, 'tmp') },
          accounts: [stubAccount],
          accountsFile,
          download: { tmpDir: join(root, 'tmp'), maxBytes: 10_000_000 },
          minIntervalMs: 0,
          maxPerSweep: 10,
          isEnabled: () => true,
          continueOnError: true, // Even with continueOnError = true, Chrome close MUST halt!
          fetchJar,
        },
        findings,
      );

      // Should have attempted ONLY resource 1001, and aborted before attempting 1002!
      expect(attemptedResourceIds).toEqual([1001]);
      expect(sweep.aborted).toBe(true);
      expect(sweep.abortReason).toBe('chrome_closed');
      expect(sweep.outcomes[0]?.detail).toContain('Trình duyệt Chrome bị tắt đột ngột');
    });
  });
});
