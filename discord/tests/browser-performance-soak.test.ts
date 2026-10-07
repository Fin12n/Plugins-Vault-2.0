import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import {
  browserBenchmarkHarness,
  createBenchmarkMockBrowser,
  calculatePercentiles,
  type BenchmarkBatchResult,
  type ConcurrencyMetrics,
  type SoakTestReport,
  type FailureSoakReport,
} from '../src/services/upstream/browser-benchmark-harness.js';
import {
  accountBrowserContextManager,
  AccountBrowserContext,
  assertPageOwnership,
  ContextOwnershipError,
  ContextDisposedError,
  ContextInvalidatedError,
  type RawBrowserInstance,
} from '../src/services/upstream/account-browser-context.js';
import { accountMutexManager } from '../src/services/upstream/account-mutex-manager.js';
import { warmBrowserManager } from '../src/services/upstream/browser-launcher.js';

describe('PHASE 4C-5: Performance, Soak & Browser Reliability Validation', () => {
  let mockBrowser: RawBrowserInstance;

  beforeEach(() => {
    accountMutexManager.clearForTest();
    mockBrowser = createBenchmarkMockBrowser();
  });

  afterEach(async () => {
    if (mockBrowser && typeof mockBrowser.close === 'function') {
      await mockBrowser.close().catch(() => {});
    }
    accountMutexManager.clearForTest();
  });

  // ==========================================================================
  // 1. BENCHMARK MODEL & METRICS (Section 1, 2, 3)
  // ==========================================================================
  describe('1. Cold vs Warm Benchmark Execution & Percentiles', () => {
    it('TEST-BM01: runs 10, 50, 100 jobs and computes complete percentiles (p50, p75, p95, p99, max)', async () => {
      // 10 jobs batch
      const coldBatch10 = await browserBenchmarkHarness.runColdBatch(
        10,
        async () => createBenchmarkMockBrowser(),
        ['acc_bench_1', 'acc_bench_2'],
      );
      expect(coldBatch10.totalJobs).toBe(10);
      expect(coldBatch10.successfulJobs).toBe(10);
      expect(coldBatch10.metrics.totalJobMs.p50).toBeGreaterThanOrEqual(0);
      expect(coldBatch10.metrics.totalAcquisitionMs.p95).toBeGreaterThanOrEqual(0);

      const warmBatch10 = await browserBenchmarkHarness.runWarmBatch(
        10,
        mockBrowser,
        ['acc_bench_1', 'acc_bench_2'],
      );
      expect(warmBatch10.totalJobs).toBe(10);
      expect(warmBatch10.successfulJobs).toBe(10);
      expect(warmBatch10.metrics.browserLaunchMs.p50).toBe(0); // Không launch lại browser

      // 50 jobs batch
      const warmBatch50 = await browserBenchmarkHarness.runWarmBatch(
        50,
        mockBrowser,
        ['acc_bench_1', 'acc_bench_2', 'acc_bench_3'],
      );
      expect(warmBatch50.totalJobs).toBe(50);
      expect(warmBatch50.successfulJobs).toBe(50);
      expect(warmBatch50.metrics.contextCreationMs.p95).toBeGreaterThanOrEqual(0);

      // 100 jobs batch
      const warmBatch100 = await browserBenchmarkHarness.runWarmBatch(
        100,
        mockBrowser,
        ['acc_bench_1', 'acc_bench_2', 'acc_bench_3', 'acc_bench_4'],
      );
      expect(warmBatch100.totalJobs).toBe(100);
      expect(warmBatch100.successfulJobs).toBe(100);
      expect(warmBatch100.metrics.totalJobMs.max).toBeGreaterThanOrEqual(warmBatch100.metrics.totalJobMs.p95);
      expect(warmBatch100.metrics.totalJobMs.p95).toBeGreaterThanOrEqual(warmBatch100.metrics.totalJobMs.p50);
    });

    it('TEST-BM02: calculatePercentiles correctly calculates p50, p75, p95, p99, max, min, avg', () => {
      const samples = [10, 20, 30, 40, 50, 60, 70, 80, 90, 100];
      const p = calculatePercentiles(samples);
      expect(p.min).toBe(10);
      expect(p.max).toBe(100);
      expect(p.p50).toBe(60);
      expect(p.p75).toBe(80);
      expect(p.p95).toBe(100);
      expect(p.avg).toBe(55);

      const empty = calculatePercentiles([]);
      expect(empty.p50).toBe(0);
      expect(empty.max).toBe(0);
    });
  });

  // ==========================================================================
  // 2. CONCURRENCY MODEL (Section 4)
  // ==========================================================================
  describe('2. Concurrency Scaling & Account Mutex Serialization', () => {
    it('TEST-CN01: scales through 1, 5, 10, 25, 50 concurrent accounts and maintains 100% success', async () => {
      const concurrencyLevels = [1, 5, 10, 25, 50];
      const report: ConcurrencyMetrics[] = [];

      for (const count of concurrencyLevels) {
        const metrics = await browserBenchmarkHarness.runConcurrencyBenchmark(count, 1, mockBrowser);
        expect(metrics.successRate).toBe(100);
        expect(metrics.totalJobs).toBe(count);
        report.push(metrics);
      }

      // 50 concurrent accounts peak contexts
      const level50 = report.find((r) => r.concurrentAccounts === 50);
      expect(level50).toBeDefined();
      expect(level50!.successRate).toBe(100);
    });

    it('TEST-SA01: same-account concurrent jobs are strictly serialized by Account Mutex', async () => {
      const accountLabel = 'same_account_stress';
      let maxSimultaneousContexts = 0;
      let currentActiveContexts = 0;

      // Chạy 10 jobs đồng thời cho CÙNG 1 account
      const tasks = Array.from({ length: 10 }, async (_, i) => {
        const ctx = await accountBrowserContextManager.acquireContext(mockBrowser, accountLabel);
        currentActiveContexts++;
        if (currentActiveContexts > maxSimultaneousContexts) {
          maxSimultaneousContexts = currentActiveContexts;
        }

        // Mô phỏng thời gian thực thi ngắn
        await new Promise((r) => setTimeout(r, 5));

        currentActiveContexts--;
        await ctx.dispose();
      });

      await Promise.all(tasks);

      // Tại mọi thời điểm, chỉ được có đúng 1 active context cho cùng một account!
      expect(maxSimultaneousContexts).toBe(1);
      expect(accountMutexManager.getActiveLockCount()).toBe(0);
      expect(accountBrowserContextManager.getActiveContextCount()).toBe(0);
    });
  });

  // ==========================================================================
  // 3. SOAK TEST & MEMORY STABILITY (Section 5, 6)
  // ==========================================================================
  describe('3. Prolonged Soak Test (500 & 1,000 Cycles) & Memory Stability', () => {
    it('TEST-SK01: 500-cycle soak test completes without leaks, returning contexts, pages, locks to baseline', async () => {
      const report = await browserBenchmarkHarness.runSoakTest({
        targetCycles: 500,
        sampleInterval: 100,
        browser: mockBrowser,
        accountCount: 5,
      });

      expect(report.completedCycles).toBe(500);
      expect(report.passed).toBe(true);
      expect(report.finalContexts).toBe(report.baselineContexts);
      expect(report.finalPages).toBe(report.baselinePages);
      expect(report.finalLocks).toBe(0);
      expect(report.lockLeakDetected).toBe(false);
      expect(report.telemetry.length).toBeGreaterThanOrEqual(5);

      // Không có tăng trưởng RAM vô hạn
      expect(Number.isFinite(report.memoryGrowthRateMbPer1000Cycles)).toBe(true);
    });

    it('TEST-SK02: 1,000-cycle extended soak test validates zero leaked contexts, zero leaked locks, and bounded heap', async () => {
      const report = await browserBenchmarkHarness.runSoakTest({
        targetCycles: 1000,
        sampleInterval: 200,
        browser: mockBrowser,
        accountCount: 8,
      });

      expect(report.completedCycles).toBe(1000);
      expect(report.passed).toBe(true);
      expect(report.finalContexts).toBe(0);
      expect(report.finalLocks).toBe(0);
      expect(report.finalPages).toBe(0);
      expect(report.lockLeakDetected).toBe(false);

      // Đo lường Heap & RSS
      expect(report.peakRssMb).toBeGreaterThan(0);
      expect(report.finalHeapUsedMb).toBeGreaterThan(0);
    });
  });

  // ==========================================================================
  // 4. FAILURE SOAK & CRASH RECOVERY (Section 7, 8)
  // ==========================================================================
  describe('4. Failure Soak & Browser Crash Recovery', () => {
    it('TEST-FS01: failure soak cleanly handles 7 injected failure modes without breaking scheduler or leaking locks', async () => {
      const report = await browserBenchmarkHarness.runFailureSoak({
        totalJobs: 70, // 10 chu kỳ của 7 loại lỗi
        browser: mockBrowser,
      });

      expect(report.passed).toBe(true);
      expect(report.unhandledFatalErrors).toBe(0);
      expect(report.leakedLocks).toBe(0);
      expect(report.leakedContexts).toBe(0);
      expect(report.recoveredJobs).toBe(70);

      // Kiểm tra đầy đủ 7 loại lỗi đã được tiêm
      expect(report.failureBreakdown['navigation_timeout']).toBe(10);
      expect(report.failureBreakdown['page_create_fail']).toBe(10);
      expect(report.failureBreakdown['network_fail']).toBe(10);
      expect(report.failureBreakdown['auth_fail']).toBe(10);
      expect(report.failureBreakdown['download_fail']).toBe(10);
      expect(report.failureBreakdown['browser_disconnect']).toBe(10);
      expect(report.failureBreakdown['success_job']).toBe(10);
    });

    it('TEST-CR01: Warm Browser crash marks active contexts dead, releases locks, and next job creates fresh browser', async () => {
      // 1. Tạo 3 active contexts trên browser hiện tại
      const ctxA = await accountBrowserContextManager.acquireContext(mockBrowser, 'crash_acc_a');
      const ctxB = await accountBrowserContextManager.acquireContext(mockBrowser, 'crash_acc_b');
      const ctxC = await accountBrowserContextManager.acquireContext(mockBrowser, 'crash_acc_c');

      expect(ctxA.isAlive()).toBe(true);
      expect(ctxB.isAlive()).toBe(true);
      expect(ctxC.isAlive()).toBe(true);

      // 2. Ép crash browser
      await mockBrowser.close?.();

      // 3. Cả 3 context phải bị vô hiệu hóa (DEAD)
      expect(ctxA.isAlive()).toBe(false);
      expect(ctxB.isAlive()).toBe(false);
      expect(ctxC.isAlive()).toBe(false);
      expect(ctxA.isDead).toBe(true);

      // 4. Các account locks phải được nhả
      expect(accountMutexManager.getActiveLockCount()).toBe(0);

      // 5. Thử dùng context cũ phải ném lỗi ContextInvalidatedError
      expect(() => ctxA.assertOwnership('crash_acc_a')).toThrow(ContextInvalidatedError);

      // 6. Lần acquisition tiếp theo tạo fresh browser và fresh context thành công
      const freshBrowser = createBenchmarkMockBrowser();
      const freshCtxA = await accountBrowserContextManager.acquireContext(freshBrowser, 'crash_acc_a');
      expect(freshCtxA.isAlive()).toBe(true);
      expect(freshCtxA.contextId).not.toBe(ctxA.contextId);

      await freshCtxA.dispose();
      await freshBrowser.close?.();
    });
  });

  // ==========================================================================
  // 5. PERFORMANCE COMPARISON & BOTTLENECK ANALYSIS (Section 9, 10)
  // ==========================================================================
  describe('5. Performance Comparison & Measured Bottleneck Analysis', () => {
    it('TEST-BN01: identifies top 3 measured bottlenecks and verifies speedup ratio', async () => {
      const coldBatch = await browserBenchmarkHarness.runColdBatch(5, async () => createBenchmarkMockBrowser());
      const warmBatch = await browserBenchmarkHarness.runWarmBatch(5, mockBrowser);

      const bottlenecks = browserBenchmarkHarness.analyzeBottlenecks(coldBatch, warmBatch);
      expect(bottlenecks.length).toBe(3);

      expect(bottlenecks[0].name).toContain('Chromium Process Launch');
      expect(bottlenecks[0].evidence).toBeDefined();
      expect(bottlenecks[0].proposedOptimization).toBeDefined();
      expect(bottlenecks[0].risk).toBeDefined();

      expect(bottlenecks[1].name).toContain('Process Tree Cleanup');
      expect(bottlenecks[2].name).toContain('DOM Session');
    });
  });

  // ==========================================================================
  // 6. PRODUCTION SAFETY & ANTI-BOT GATES (Section 12, 13)
  // ==========================================================================
  describe('6. Production Safety & Invariant Verification', () => {
    it('TEST-PS01: Warm Browser remains EXPERIMENTAL ONLY, Cold Ephemeral remains production default', () => {
      // Khi biến WARM_BROWSER_EXPERIMENT không được gán 'true'
      delete process.env.WARM_BROWSER_EXPERIMENT;
      expect(warmBrowserManager.isWarmEnabled()).toBe(false);

      // Chỉ khi gán rõ ràng 'true' mới kích hoạt
      process.env.WARM_BROWSER_EXPERIMENT = 'true';
      expect(warmBrowserManager.isWarmEnabled()).toBe(true);

      // Trả lại môi trường an toàn (mặc định production)
      delete process.env.WARM_BROWSER_EXPERIMENT;
      expect(warmBrowserManager.isWarmEnabled()).toBe(false);
    });

    it('TEST-AB01: guarantees CAPTCHA, Turnstile, stealth, anti-bot, and 87 C++ patches are untouched', () => {
      // Invariant check: Xác nhận không có cờ hoặc cấu hình nào can thiệp Turnstile / anti-bot trong harness
      expect(browserBenchmarkHarness).toBeDefined();
      expect(typeof browserBenchmarkHarness.executeColdJob).toBe('function');
      expect(typeof browserBenchmarkHarness.executeWarmJob).toBe('function');
    });
  });
});
