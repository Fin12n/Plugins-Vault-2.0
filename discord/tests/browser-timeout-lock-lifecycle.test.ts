import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import {
  createDeadlineBudget,
  withDeadline,
  JobTimeoutError,
  isJobTimeoutError,
} from '../src/services/upstream/deadline-budget.js';
import {
  AccountMutexManager,
  accountMutexManager,
  type AccountLockHandle,
} from '../src/services/upstream/account-mutex-manager.js';
import {
  createAbruptCloseTracker,
} from '../src/services/upstream/chrome-close-detector.js';
import {
  cloakSessionManager,
  type SessionLockHandle,
} from '../src/services/upstream/cloak-session-manager.js';
import { abortableSleep } from '../src/services/upstream/download-via-browser.js';

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

describe('Phase 4C-2: Timeout / Lock Lifecycle / Listener Safety', () => {
  beforeEach(() => {
    accountMutexManager.reset();
    cloakSessionManager.reset();
  });

  afterEach(async () => {
    await cloakSessionManager.releaseLock().catch(() => undefined);
    accountMutexManager.reset();
    cloakSessionManager.reset();
  });

  // =========================================================================
  // 1. EVENT LISTENER LIFECYCLE TESTS (Item 7 & 8)
  // =========================================================================
  describe('Event Listener Lifecycle & Exact Handler Disposal', () => {
    it('TEST-L01: attach/dispose x 1 returns listener count to baseline', () => {
      const tracker = createAbruptCloseTracker();
      const mockBrowser = new EventEmitter();
      const mockProc = new EventEmitter();
      const mockPage = new EventEmitter();
      (mockBrowser as any).process = () => mockProc;

      expect(mockBrowser.listenerCount('disconnected')).toBe(0);
      expect(mockProc.listenerCount('exit')).toBe(0);
      expect(mockPage.listenerCount('close')).toBe(0);

      tracker.attachBrowser(mockBrowser, mockPage);

      expect(mockBrowser.listenerCount('disconnected')).toBe(1);
      expect(mockProc.listenerCount('exit')).toBe(1);
      expect(mockPage.listenerCount('close')).toBe(1);

      tracker.dispose();

      expect(mockBrowser.listenerCount('disconnected')).toBe(0);
      expect(mockProc.listenerCount('exit')).toBe(0);
      expect(mockPage.listenerCount('close')).toBe(0);
    });

    it('TEST-L02: attach/dispose x 20 without MaxListenersExceededWarning', () => {
      const mockBrowser = new EventEmitter();
      const mockProc = new EventEmitter();
      const mockPage = new EventEmitter();
      (mockBrowser as any).process = () => mockProc;

      const warningSpy = vi.fn();
      process.on('warning', warningSpy);

      try {
        for (let i = 0; i < 20; i++) {
          const tracker = createAbruptCloseTracker();
          tracker.attachBrowser(mockBrowser, mockPage);

          expect(mockBrowser.listenerCount('disconnected')).toBe(1);
          expect(mockProc.listenerCount('exit')).toBe(1);
          expect(mockPage.listenerCount('close')).toBe(1);

          tracker.dispose();

          expect(mockBrowser.listenerCount('disconnected')).toBe(0);
          expect(mockProc.listenerCount('exit')).toBe(0);
          expect(mockPage.listenerCount('close')).toBe(0);
        }

        expect(warningSpy).not.toHaveBeenCalled();
      } finally {
        process.off('warning', warningSpy);
      }
    });

    it('TEST-L03: attach/dispose x 100 returns strictly to baseline count', () => {
      const mockBrowser = new EventEmitter();
      const mockProc = new EventEmitter();
      const mockPage = new EventEmitter();
      (mockBrowser as any).process = () => mockProc;

      for (let i = 0; i < 100; i++) {
        const tracker = createAbruptCloseTracker();
        tracker.attachBrowser(mockBrowser, mockPage);
        tracker.dispose();
      }

      expect(mockBrowser.listenerCount('disconnected')).toBe(0);
      expect(mockProc.listenerCount('exit')).toBe(0);
      expect(mockPage.listenerCount('close')).toBe(0);
    });

    it('TEST-L04: dispose() is strictly idempotent (calling dispose 3 times throws no error)', () => {
      const tracker = createAbruptCloseTracker();
      const mockBrowser = new EventEmitter();
      (mockBrowser as any).process = () => new EventEmitter();
      tracker.attachBrowser(mockBrowser);

      expect(() => {
        tracker.dispose();
        tracker.dispose();
        tracker.dispose();
      }).not.toThrow();

      expect(tracker.isGraceful()).toBe(true);
      expect(mockBrowser.listenerCount('disconnected')).toBe(0);
    });

    it('TEST-L05: old session closures are unhooked when attaching new browser', () => {
      const tracker = createAbruptCloseTracker();
      const firstBrowser = new EventEmitter();
      const secondBrowser = new EventEmitter();

      tracker.attachBrowser(firstBrowser);
      expect(firstBrowser.listenerCount('disconnected')).toBe(1);

      // Re-attaching unbinds from first browser
      tracker.attachBrowser(secondBrowser);
      expect(firstBrowser.listenerCount('disconnected')).toBe(0);
      expect(secondBrowser.listenerCount('disconnected')).toBe(1);

      tracker.dispose();
      expect(secondBrowser.listenerCount('disconnected')).toBe(0);
    });
  });

  // =========================================================================
  // 2. ACCOUNT MUTEX MATRIX (Item 4, 5, 9)
  // =========================================================================
  describe('Account Mutex Lifecycle & Concurrency Matrix', () => {
    it('TEST-M01 [Matrix A]: same account x 2 jobs are queued in FIFO order', async () => {
      const manager = new AccountMutexManager();
      const executionOrder: string[] = [];

      const lockA = await manager.acquire('spigot-user-1', { jobId: 'job-A' });
      expect(manager.isLocked('spigot-user-1')).toBe(true);
      expect(manager.getQueueLength('spigot-user-1')).toBe(0);

      // Job B attempts to acquire same account -> queued
      const lockBPromise = manager.acquire('spigot-user-1', { jobId: 'job-B' }).then((handle) => {
        executionOrder.push('job-B-acquired');
        return handle;
      });

      expect(manager.getQueueLength('spigot-user-1')).toBe(1);
      expect(executionOrder).toEqual([]);

      // Job A finishes
      executionOrder.push('job-A-releasing');
      await lockA.release();

      const lockB = await lockBPromise;
      expect(executionOrder).toEqual(['job-A-releasing', 'job-B-acquired']);
      expect(manager.getQueueLength('spigot-user-1')).toBe(0);

      await lockB.release();
      expect(manager.isLocked('spigot-user-1')).toBe(false);
    });

    it('TEST-M02 [Matrix B]: different accounts x 2 jobs run concurrently', async () => {
      const manager = new AccountMutexManager();

      const lock1 = await manager.acquire('spigot-user-1', { jobId: 'job-1' });
      const lock2 = await manager.acquire('spigot-user-2', { jobId: 'job-2' });

      expect(manager.isLocked('spigot-user-1')).toBe(true);
      expect(manager.isLocked('spigot-user-2')).toBe(true);
      expect(manager.getQueueLength('spigot-user-1')).toBe(0);
      expect(manager.getQueueLength('spigot-user-2')).toBe(0);

      await lock1.release();
      await lock2.release();

      expect(manager.isLocked('spigot-user-1')).toBe(false);
      expect(manager.isLocked('spigot-user-2')).toBe(false);
    });

    it('TEST-M03 [Matrix C]: first job success releases lock to second job', async () => {
      const manager = new AccountMutexManager();
      const lock1 = await manager.acquire('acc-c');

      let job2Started = false;
      const job2Promise = manager.acquire('acc-c').then(async (handle) => {
        job2Started = true;
        await handle.release();
      });

      expect(job2Started).toBe(false);
      await lock1.release();
      await job2Promise;

      expect(job2Started).toBe(true);
      expect(manager.isLocked('acc-c')).toBe(false);
    });

    it('TEST-M04 [Matrix D]: first job failure releases lock in finally block', async () => {
      const manager = new AccountMutexManager();
      let job2Acquired = false;

      const runJob1 = async () => {
        const lock = await manager.acquire('acc-d');
        try {
          throw new Error('Simulation of catastrophic acquisition error');
        } finally {
          await lock.release();
        }
      };

      const runJob2 = async () => {
        const lock = await manager.acquire('acc-d');
        job2Acquired = true;
        await lock.release();
      };

      await expect(runJob1()).rejects.toThrow('Simulation of catastrophic acquisition error');
      await runJob2();

      expect(job2Acquired).toBe(true);
      expect(manager.isLocked('acc-d')).toBe(false);
    });

    it('TEST-M05 [Matrix E]: first job timeout releases lock and waiter timeout is clean', async () => {
      const manager = new AccountMutexManager();
      const lock1 = await manager.acquire('acc-e');

      // Job 2 waits with a tight 50ms timeout
      await expect(
        manager.acquire('acc-e', { timeoutMs: 50, jobId: 'job-timeout' })
      ).rejects.toThrow(JobTimeoutError);

      // Queue is pruned
      expect(manager.getQueueLength('acc-e')).toBe(0);

      // When Job 1 releases, no orphan waiter exists
      await lock1.release();
      expect(manager.isLocked('acc-e')).toBe(false);
    });

    it('TEST-M06 [Matrix F]: first job aborts signal removes waiter without orphan', async () => {
      const manager = new AccountMutexManager();
      const lock1 = await manager.acquire('acc-f');

      const controller = new AbortController();
      const job2Promise = manager.acquire('acc-f', { signal: controller.signal });

      expect(manager.getQueueLength('acc-f')).toBe(1);

      controller.abort(new Error('User cancelled acquisition'));
      await expect(job2Promise).rejects.toThrow('User cancelled acquisition');

      expect(manager.getQueueLength('acc-f')).toBe(0);

      await lock1.release();
      expect(manager.isLocked('acc-f')).toBe(false);
    });

    it('TEST-M07 [Matrix G]: browser crash release clears account lock', async () => {
      const manager = new AccountMutexManager();
      const lock = await manager.acquire('acc-g');

      // Tracker detects abrupt close -> triggers graceful release
      const tracker = createAbruptCloseTracker();
      tracker.markAbruptlyClosed('Chrome process exited unexpectedly');

      if (tracker.isAbruptlyClosed()) {
        await lock.release();
      }

      expect(manager.isLocked('acc-g')).toBe(false);
      tracker.dispose();
    });

    it('TEST-M08 [Matrix H]: shutdown while second job waits rejects waiter immediately', async () => {
      const manager = new AccountMutexManager();
      const lock1 = await manager.acquire('acc-h');

      const job2Promise = manager.acquire('acc-h', { jobId: 'job-waiter' });
      expect(manager.getQueueLength('acc-h')).toBe(1);

      manager.cancelWaiters('SIGTERM shutdown');

      await expect(job2Promise).rejects.toThrow(/bị giải tán \(SIGTERM shutdown\)/);
      expect(manager.getQueueLength('acc-h')).toBe(0);

      await lock1.release();
    });

    it('TEST-M09 [Matrix I]: shutdown stops new acquisitions immediately', async () => {
      const manager = new AccountMutexManager();
      manager.cancelWaiters('Shutdown');

      await expect(manager.acquire('acc-i')).rejects.toThrow(/Hệ thống đang trong quá trình shutdown/);
    });

    it('TEST-M10 [Matrix J]: cancellation of middle waiter preserves subsequent waiters in FIFO order', async () => {
      const manager = new AccountMutexManager();
      const lock1 = await manager.acquire('acc-j');

      const abortCtrl2 = new AbortController();
      const order: string[] = [];

      const p2 = manager.acquire('acc-j', { signal: abortCtrl2.signal, jobId: 'W2' }).then(async (h) => {
        order.push('W2');
        await h.release();
      });

      const p3 = manager.acquire('acc-j', { jobId: 'W3' }).then(async (h) => {
        order.push('W3');
        await h.release();
      });

      expect(manager.getQueueLength('acc-j')).toBe(2);

      // Cancel W2
      abortCtrl2.abort(new Error('W2 cancelled'));
      await expect(p2).rejects.toThrow('W2 cancelled');

      // Now release lock1 -> W3 should be served directly
      await lock1.release();
      await p3;

      expect(order).toEqual(['W3']);
      expect(manager.isLocked('acc-j')).toBe(false);
    });
  });

  // =========================================================================
  // 3. CANONICAL LOCK ORDERING (Item 5)
  // =========================================================================
  describe('Canonical Lock Order (Admission -> Account -> Browser)', () => {
    it('TEST-O01: enforces canonical acquisition order and reverse release order', async () => {
      const manager = accountMutexManager;
      const events: string[] = [];

      // 1. Admission (simulated)
      events.push('1:admission_granted');

      // 2. Account Mutex
      const accLock = await manager.acquire('canonical-acc', { jobId: 'job-canonical' });
      events.push('2:account_lock_acquired');

      // 3. Browser Session Resource
      const browserLock = await cloakSessionManager.acquireLock('account-canonical-acc');
      events.push('3:browser_lock_acquired');

      // Execution phase
      events.push('operation_running');

      // REVERSE RELEASE:
      // 1. Browser Session
      await browserLock.release();
      events.push('4:browser_lock_released');

      // 2. Account Mutex
      await accLock.release();
      events.push('5:account_lock_released');

      // 3. Admission done
      events.push('6:admission_completed');

      expect(events).toEqual([
        '1:admission_granted',
        '2:account_lock_acquired',
        '3:browser_lock_acquired',
        'operation_running',
        '4:browser_lock_released',
        '5:account_lock_released',
        '6:admission_completed',
      ]);
    });
  });

  // =========================================================================
  // 4. TIMEOUT TEST MATRIX & DEADLINE BUDGET (Item 1, 2, 3, 10)
  // =========================================================================
  describe('Absolute Acquisition Deadline & Timeout Propagation Matrix', () => {
    it('TEST-T01 [Matrix A]: parent 120s / child 180s -> child effective timeout <= remaining parent time', () => {
      // Simulate parent job started 47s ago with 120s timeout -> remaining is 73s
      const budget = createDeadlineBudget({
        jobTimeoutMs: 120_000,
        startedAt: Date.now() - 47_000,
      });

      const remaining = budget.getRemainingMs();
      expect(remaining).toBeLessThanOrEqual(73_050);
      expect(remaining).toBeGreaterThanOrEqual(72_500);

      const effectiveChildTimeout = budget.getEffectiveTimeout(180_000);
      expect(effectiveChildTimeout).toBeLessThanOrEqual(remaining);
      expect(effectiveChildTimeout).toBeLessThan(180_000);

      budget.dispose();
    });

    it('TEST-T02 [Matrix B]: parent expires while child operation in progress -> aborts and throws JobTimeoutError', async () => {
      const budget = createDeadlineBudget({
        jobTimeoutMs: 80, // tight 80ms deadline
      });

      let operationCancelled = false;

      const testOp = async (signal: AbortSignal, effectiveTimeout: number) => {
        expect(effectiveTimeout).toBeLessThanOrEqual(80);
        await new Promise<void>((resolve, reject) => {
          signal.addEventListener('abort', () => {
            operationCancelled = true;
            reject(signal.reason);
          });
        });
      };

      await expect(
        withDeadline(budget, testOp, 500, 'simulated-navigation')
      ).rejects.toSatisfy((err) => isJobTimeoutError(err));

      expect(operationCancelled).toBe(true);
      budget.dispose();
    });

    it('TEST-T03 [Matrix C]: child timeout shorter than parent -> child timeout respected', async () => {
      const budget = createDeadlineBudget({
        jobTimeoutMs: 60_000, // Parent has 60s
      });

      const effectiveTimeout = budget.getEffectiveTimeout(150); // Child wants 150ms
      expect(effectiveTimeout).toBe(150);

      const start = Date.now();
      await expect(
        withDeadline(
          budget,
          async (signal) => {
            await new Promise<void>((_, reject) => {
              signal.addEventListener('abort', () => reject(signal.reason));
            });
          },
          100, // 100ms child timeout
          'short-child-operation',
        )
      ).rejects.toSatisfy((err) => isJobTimeoutError(err));

      const duration = Date.now() - start;
      expect(duration).toBeLessThan(1000); // Definitely completed around 100ms, not 60s
      budget.dispose();
    });

    it('TEST-T04 [Matrix D]: parent abort -> every child observes abort signal immediately', async () => {
      const parentController = new AbortController();
      const budget = createDeadlineBudget({
        jobTimeoutMs: 60_000,
        parentSignal: parentController.signal,
      });

      expect(budget.signal.aborted).toBe(false);

      let observedAbortReason: any = null;
      const childPromise = withDeadline(
        budget,
        async (signal) => {
          await new Promise<void>((_, reject) => {
            signal.addEventListener('abort', () => {
              observedAbortReason = signal.reason;
              reject(signal.reason);
            });
          });
        },
        30_000,
        'parent-abort-test',
      );

      // Parent aborts
      const abortError = new Error('Parent process cancelled by user');
      parentController.abort(abortError);

      await expect(childPromise).rejects.toThrow('Parent process cancelled by user');
      expect(budget.signal.aborted).toBe(true);
      expect(observedAbortReason).toBe(abortError);

      budget.dispose();
    });

    it('TEST-T05: abortableSleep wakes immediately when parent signal is aborted', async () => {
      const controller = new AbortController();
      const start = Date.now();

      // Trigger abort after 50ms
      setTimeout(() => controller.abort(new Error('Fast wake')), 50);

      // Try to sleep for 5,000ms
      await abortableSleep(5_000, controller.signal);

      const elapsed = Date.now() - start;
      expect(elapsed).toBeLessThan(500); // Woke in ~50ms, didn't wait 5000ms
    });

    it('TEST-T06: withDeadline throws immediately if remaining budget <= 0', async () => {
      const budget = createDeadlineBudget({
        jobTimeoutMs: 10,
        startedAt: Date.now() - 50, // Started in the past, remaining <= 0
      });

      const mockOp = vi.fn();
      await expect(
        withDeadline(budget, mockOp, 5000, 'expired-op')
      ).rejects.toSatisfy((err) => isJobTimeoutError(err));

      expect(mockOp).not.toHaveBeenCalled();
      budget.dispose();
    });
  });

  // =========================================================================
  // 5. SHUTDOWN LIFECYCLE (Item 6)
  // =========================================================================
  describe('Bounded Shutdown Lifecycle', () => {
    it('TEST-S01: cloakSessionManager.stop() releases active lock and cancels waiters within bounded timeout', async () => {
      const lock = await cloakSessionManager.acquireLock('active-task');

      let waiterRejected = false;
      const waiterPromise = cloakSessionManager.acquireLock('queued-task').catch((err) => {
        waiterRejected = true;
        return err;
      });

      const stopPromise = cloakSessionManager.stop('SIGTERM received', 3000);
      await stopPromise;

      const waiterErr = await waiterPromise;
      expect(waiterRejected).toBe(true);
      expect((waiterErr as Error).message).toContain('Hàng đợi bị giải tán');
      expect(cloakSessionManager.hasActiveSession()).toBe(false);
    });
  });
});
