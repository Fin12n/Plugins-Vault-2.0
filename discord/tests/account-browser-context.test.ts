import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import {
  accountBrowserContextManager,
  AccountBrowserContext,
  tagPageWithAccount,
  assertPageOwnership,
  ContextOwnershipError,
  ContextDisposedError,
  ContextInvalidatedError,
  type RawBrowserInstance,
  type RawBrowserContext,
} from '../src/services/upstream/account-browser-context.js';
import { accountMutexManager } from '../src/services/upstream/account-mutex-manager.js';
import { warmBrowserManager } from '../src/services/upstream/browser-launcher.js';
import type { SpigotCookieItem } from '../src/services/upstream/spigot-cookie-files.js';

interface MockPage extends EventEmitter {
  cookiesList: SpigotCookieItem[];
  localStorageStore: Record<string, string>;
  isClosed: boolean;
  createCDPSession?: () => Promise<{
    send: (method: string, params?: any) => Promise<any>;
    detach: () => Promise<void>;
  }>;
  setCookie?: (...cookies: SpigotCookieItem[]) => Promise<void>;
  cookies?: () => Promise<SpigotCookieItem[]>;
  evaluate?: (fnOrStr: any, ...args: any[]) => Promise<any>;
  content?: () => Promise<string>;
  close?: () => Promise<void>;
}

function createMockPage(): MockPage {
  const page = new EventEmitter() as MockPage;
  page.cookiesList = [];
  page.localStorageStore = {};
  page.isClosed = false;

  page.createCDPSession = async () => ({
    send: async (method: string, params?: any) => {
      if (method === 'Network.setCookie' && params) {
        page.cookiesList.push({ name: params.name, value: params.value, domain: params.domain });
      }
      return {};
    },
    detach: async () => {},
  });

  page.setCookie = async (...cookies: SpigotCookieItem[]) => {
    page.cookiesList.push(...cookies);
  };

  page.cookies = async () => [...page.cookiesList];

  page.evaluate = async (fnOrStr: any, ...args: any[]) => {
    if (typeof fnOrStr === 'string') {
      if (fnOrStr.includes('localStorage.getItem')) {
        const key = fnOrStr.match(/localStorage\.getItem\(['"](.+?)['"]\)/)?.[1] ?? '';
        return page.localStorageStore[key] ?? null;
      }
      if (fnOrStr.includes('localStorage.setItem')) {
        const match = fnOrStr.match(/localStorage\.setItem\(['"](.+?)['"],\s*['"](.+?)['"]\)/);
        if (match) {
          page.localStorageStore[match[1]!] = match[2]!;
        }
        return undefined;
      }
    }
    if (typeof fnOrStr === 'function') {
      return fnOrStr(...args);
    }
    return undefined;
  };

  page.content = async () => '<div data-logged-in="true">User</div>';

  page.close = async () => {
    page.isClosed = true;
    page.emit('close');
  };

  return page;
}

function createMockBrowser(): RawBrowserInstance & EventEmitter {
  const emitter = new EventEmitter() as RawBrowserInstance & EventEmitter;
  const contexts: RawBrowserContext[] = [];

  emitter.createBrowserContext = async () => {
    const pages: MockPage[] = [];
    const rawCtx: RawBrowserContext = {
      newPage: async () => {
        const p = createMockPage();
        pages.push(p);
        return p;
      },
      pages: async () => pages,
      close: async () => {
        for (const p of pages) {
          await p.close();
        }
      },
    };
    contexts.push(rawCtx);
    return rawCtx;
  };

  emitter.newPage = async () => createMockPage();

  emitter.close = async () => {
    for (const ctx of contexts) {
      await ctx.close();
    }
    emitter.emit('disconnected');
  };

  return emitter;
}

describe('Phase 4C-4: Browser Context Isolation', () => {
  beforeEach(() => {
    accountBrowserContextManager.reset();
    accountMutexManager.reset();
  });

  afterEach(async () => {
    accountBrowserContextManager.reset();
    accountMutexManager.reset();
  });

  // =========================================================================
  // 1. CONTEXT OWNERSHIP & IDEMPOTENT DISPOSAL (Section 1 & 2)
  // =========================================================================
  describe('Context Ownership & Abstraction', () => {
    it('TEST-CO01: context handle tracks account identity, browser identity, and createdAt', async () => {
      const mockBrowser = createMockBrowser();
      const ctx = await accountBrowserContextManager.acquireContext(mockBrowser, 'Spigot-User-A');

      expect(ctx.accountLabel).toBe('Spigot-User-A');
      expect(typeof ctx.browserId).toBe('string');
      expect(typeof ctx.contextId).toBe('string');
      expect(ctx.createdAt).toBeGreaterThan(0);
      expect(ctx.isDisposed).toBe(false);
      expect(ctx.isDead).toBe(false);

      expect(() => ctx.assertOwnership('Spigot-User-A')).not.toThrow();
      expect(() => ctx.assertOwnership('Spigot-User-B')).toThrow(ContextOwnershipError);

      await ctx.dispose();
      expect(ctx.isDisposed).toBe(true);
      expect(() => ctx.assertOwnership('Spigot-User-A')).toThrow(ContextDisposedError);
    });

    it('TEST-CO02: dispose() is strictly idempotent (calling 3 times throws no error)', async () => {
      const mockBrowser = createMockBrowser();
      const ctx = await accountBrowserContextManager.acquireContext(mockBrowser, 'Spigot-User-Idempotent');

      await ctx.dispose();
      await ctx.dispose();
      await ctx.dispose();

      expect(ctx.isDisposed).toBe(true);
      expect(accountBrowserContextManager.getActiveContextCount()).toBe(0);
    });
  });

  // =========================================================================
  // 2. COOKIE ISOLATION (Section 3)
  // =========================================================================
  describe('Cookie Isolation', () => {
    it('TEST-CK01: Account A and Account B cookies are strictly isolated', async () => {
      const mockBrowser = createMockBrowser();

      const ctxA = await accountBrowserContextManager.acquireContext(mockBrowser, 'Account-A', {
        initialCookies: [{ name: 'session_marker', value: 'MARKER_ACCOUNT_A', domain: '.spigotmc.org' }],
      });
      const ctxB = await accountBrowserContextManager.acquireContext(mockBrowser, 'Account-B', {
        initialCookies: [{ name: 'session_marker', value: 'MARKER_ACCOUNT_B', domain: '.spigotmc.org' }],
      });

      const pageA = ctxA.pages[0] as MockPage;
      const pageB = ctxB.pages[0] as MockPage;

      const cookiesA = await pageA.cookies?.();
      const cookiesB = await pageB.cookies?.();

      expect(cookiesA?.find((c) => c.name === 'session_marker')?.value).toBe('MARKER_ACCOUNT_A');
      expect(cookiesA?.some((c) => c.value === 'MARKER_ACCOUNT_B')).toBe(false);

      expect(cookiesB?.find((c) => c.name === 'session_marker')?.value).toBe('MARKER_ACCOUNT_B');
      expect(cookiesB?.some((c) => c.value === 'MARKER_ACCOUNT_A')).toBe(false);

      await ctxA.dispose();
      await ctxB.dispose();
    });
  });

  // =========================================================================
  // 3. LOCAL STORAGE ISOLATION (Section 4)
  // =========================================================================
  describe('Local Storage Isolation', () => {
    it('TEST-LS01: localStorage in Context A cannot be read or modified by Context B', async () => {
      const mockBrowser = createMockBrowser();

      const ctxA = await accountBrowserContextManager.acquireContext(mockBrowser, 'Storage-A');
      const ctxB = await accountBrowserContextManager.acquireContext(mockBrowser, 'Storage-B');

      const pageA = ctxA.pages[0] as MockPage;
      const pageB = ctxB.pages[0] as MockPage;

      await pageA.evaluate?.('localStorage.setItem("account", "VALUE_A")');
      await pageB.evaluate?.('localStorage.setItem("account", "VALUE_B")');

      const valA = await pageA.evaluate?.('localStorage.getItem("account")');
      const valB = await pageB.evaluate?.('localStorage.getItem("account")');

      expect(valA).toBe('VALUE_A');
      expect(valB).toBe('VALUE_B');

      await ctxA.dispose();
      await ctxB.dispose();
    });
  });

  // =========================================================================
  // 4. PAGE ISOLATION & RUNTIME OWNERSHIP ASSERTION (Section 5)
  // =========================================================================
  describe('Page Isolation & Ownership Assertion', () => {
    it('TEST-PG01: page tagged with account ownership throws ContextOwnershipError when passed to another account', async () => {
      const mockBrowser = createMockBrowser();
      const ctxA = await accountBrowserContextManager.acquireContext(mockBrowser, 'Account-A');
      const pageA = ctxA.pages[0];

      // Verifying ownership matches
      expect(() => assertPageOwnership(pageA, 'Account-A')).not.toThrow();

      // Passing pageA to a worker for Account-B must trigger an explicit violation
      expect(() => assertPageOwnership(pageA, 'Account-B')).toThrow(ContextOwnershipError);

      await ctxA.dispose();
    });
  });

  // =========================================================================
  // 5. AUTHENTICATION ISOLATION (Section 6)
  // =========================================================================
  describe('Authentication Isolation', () => {
    it('TEST-AU01: Authenticated session in Context A does not leak authentication into Context B', async () => {
      const mockBrowser = createMockBrowser();

      const ctxA = await accountBrowserContextManager.acquireContext(mockBrowser, 'Auth-A', {
        initialCookies: [{ name: 'xf_user', value: 'authenticated_user_token_A', domain: '.spigotmc.org' }],
      });

      const ctxB = await accountBrowserContextManager.acquireContext(mockBrowser, 'Auth-B', {
        initialCookies: [], // Unauthenticated guest
      });

      const pageA = ctxA.pages[0] as MockPage;
      const pageB = ctxB.pages[0] as MockPage;

      expect(pageA.cookiesList.some((c) => c.name === 'xf_user')).toBe(true);
      expect(pageB.cookiesList.some((c) => c.name === 'xf_user')).toBe(false);

      await ctxA.dispose();
      await ctxB.dispose();
    });
  });

  // =========================================================================
  // 6. CROSS-ACCOUNT CONCURRENCY TEST (Section 9)
  // =========================================================================
  describe('Cross-Account Concurrency', () => {
    it('TEST-CC01: Run Account A, B, and C simultaneously without cross-account contamination', async () => {
      const mockBrowser = createMockBrowser();

      const [ctxA, ctxB, ctxC] = await Promise.all([
        accountBrowserContextManager.acquireContext(mockBrowser, 'Account-A', {
          initialCookies: [{ name: 'marker', value: 'A' }],
        }),
        accountBrowserContextManager.acquireContext(mockBrowser, 'Account-B', {
          initialCookies: [{ name: 'marker', value: 'B' }],
        }),
        accountBrowserContextManager.acquireContext(mockBrowser, 'Account-C', {
          initialCookies: [{ name: 'marker', value: 'C' }],
        }),
      ]);

      expect(accountBrowserContextManager.getActiveContextCount()).toBe(3);

      const pageA = ctxA.pages[0] as MockPage;
      const pageB = ctxB.pages[0] as MockPage;
      const pageC = ctxC.pages[0] as MockPage;

      await pageA.evaluate?.('localStorage.setItem("marker", "LOCAL_A")');
      await pageB.evaluate?.('localStorage.setItem("marker", "LOCAL_B")');
      await pageC.evaluate?.('localStorage.setItem("marker", "LOCAL_C")');

      expect(pageA.cookiesList[0]?.value).toBe('A');
      expect(pageB.cookiesList[0]?.value).toBe('B');
      expect(pageC.cookiesList[0]?.value).toBe('C');

      expect(await pageA.evaluate?.('localStorage.getItem("marker")')).toBe('LOCAL_A');
      expect(await pageB.evaluate?.('localStorage.getItem("marker")')).toBe('LOCAL_B');
      expect(await pageC.evaluate?.('localStorage.getItem("marker")')).toBe('LOCAL_C');

      await Promise.all([ctxA.dispose(), ctxB.dispose(), ctxC.dispose()]);
      expect(accountBrowserContextManager.getActiveContextCount()).toBe(0);
    });
  });

  // =========================================================================
  // 7. SAME ACCOUNT SERIALIZATION (Section 10)
  // =========================================================================
  describe('Same Account Serialization', () => {
    it('TEST-SA01: Two jobs for the same account are serialized by Account Mutex (1 active context)', async () => {
      const mockBrowser = createMockBrowser();
      const executionOrder: string[] = [];

      const ctx1 = await accountBrowserContextManager.acquireContext(mockBrowser, 'Same-Account-1');
      executionOrder.push('job1-started');

      const job2Promise = accountBrowserContextManager
        .acquireContext(mockBrowser, 'Same-Account-1')
        .then(async (ctx2) => {
          executionOrder.push('job2-started');
          await ctx2.dispose();
          executionOrder.push('job2-finished');
        });

      // Wait a tick
      await new Promise((r) => setTimeout(r, 40));
      expect(executionOrder).toEqual(['job1-started']);

      // Job 1 disposes and releases lock
      executionOrder.push('job1-releasing');
      await ctx1.dispose();

      await job2Promise;

      expect(executionOrder).toEqual([
        'job1-started',
        'job1-releasing',
        'job2-started',
        'job2-finished',
      ]);
    });
  });

  // =========================================================================
  // 8. BROWSER CRASH / DISCONNECT TEST (Section 11)
  // =========================================================================
  describe('Browser Crash / Disconnect Safety', () => {
    it('TEST-CR01: Browser crash invalidates all associated contexts without leaving zombie references', async () => {
      const mockBrowser = createMockBrowser();

      const ctxA = await accountBrowserContextManager.acquireContext(mockBrowser, 'Crash-Account-A');
      const ctxB = await accountBrowserContextManager.acquireContext(mockBrowser, 'Crash-Account-B');

      expect(accountBrowserContextManager.getActiveContextCount()).toBe(2);

      // Simulate browser crash or CDP disconnect
      await mockBrowser.close?.();

      expect(ctxA.isDead).toBe(true);
      expect(ctxB.isDead).toBe(true);
      expect(accountBrowserContextManager.getActiveContextCount()).toBe(0);

      // Attempting to assert ownership throws ContextInvalidatedError
      expect(() => ctxA.assertOwnership('Crash-Account-A')).toThrow(ContextInvalidatedError);
      expect(() => ctxB.assertOwnership('Crash-Account-B')).toThrow(ContextInvalidatedError);

      // Subsequent acquisition on a fresh browser works cleanly
      const freshBrowser = createMockBrowser();
      const freshCtx = await accountBrowserContextManager.acquireContext(freshBrowser, 'Crash-Account-A');
      expect(freshCtx.isAlive()).toBe(true);
      await freshCtx.dispose();
    });
  });

  // =========================================================================
  // 9. CONTEXT LEAK TEST (Section 12)
  // =========================================================================
  describe('Context Leak Stress Test', () => {
    it('TEST-LK01: 100 cycles of create -> use -> dispose return counts strictly to baseline (0)', async () => {
      const mockBrowser = createMockBrowser();
      const warningSpy = vi.fn();
      process.on('warning', warningSpy);

      try {
        for (let i = 0; i < 100; i++) {
          const ctx = await accountBrowserContextManager.acquireContext(mockBrowser, `Leak-Acc-${i % 5}`);
          const page = ctx.pages[0];
          expect(page).toBeDefined();
          await ctx.dispose();
        }

        expect(accountBrowserContextManager.getActiveContextCount()).toBe(0);
        expect(warningSpy).not.toHaveBeenCalled();
      } finally {
        process.off('warning', warningSpy);
      }
    });
  });

  // =========================================================================
  // 10. FAILURE INJECTION MATRIX (Section 13)
  // =========================================================================
  describe('Failure Injection Matrix (A to F)', () => {
    it('TEST-FI01 [Failure A]: createContext() fails -> releases account lock cleanly', async () => {
      const brokenBrowser: RawBrowserInstance = {
        createBrowserContext: async () => {
          throw new Error('Chromium Target.createBrowserContext failed');
        },
      };

      await expect(
        accountBrowserContextManager.acquireContext(brokenBrowser, 'Acc-Fail-A')
      ).rejects.toThrow('Chromium Target.createBrowserContext failed');

      expect(accountMutexManager.isLocked('Acc-Fail-A')).toBe(false);
      expect(accountBrowserContextManager.getActiveContextCount()).toBe(0);
    });

    it('TEST-FI02 [Failure B]: Cookie injection fails -> disposes context and releases lock', async () => {
      const mockBrowser = createMockBrowser();
      const originalInject = accountBrowserContextManager.injectCookiesIntoPage;
      accountBrowserContextManager.injectCookiesIntoPage = vi.fn().mockRejectedValue(new Error('CDP cookie rejection'));

      try {
        await expect(
          accountBrowserContextManager.acquireContext(mockBrowser, 'Acc-Fail-B', {
            initialCookies: [{ name: 'test', value: '123' }],
          })
        ).rejects.toThrow('CDP cookie rejection');

        expect(accountMutexManager.isLocked('Acc-Fail-B')).toBe(false);
        expect(accountBrowserContextManager.getActiveContextCount()).toBe(0);
      } finally {
        accountBrowserContextManager.injectCookiesIntoPage = originalInject;
      }
    });

    it('TEST-FI03 [Failure C]: newPage() fails -> disposes context and releases lock', async () => {
      const mockBrowser: RawBrowserInstance = {
        createBrowserContext: async () => ({
          newPage: async () => {
            throw new Error('Tab creation limit exceeded');
          },
          close: async () => {},
        }),
      };

      await expect(
        accountBrowserContextManager.acquireContext(mockBrowser, 'Acc-Fail-C')
      ).rejects.toThrow('Tab creation limit exceeded');

      expect(accountMutexManager.isLocked('Acc-Fail-C')).toBe(false);
      expect(accountBrowserContextManager.getActiveContextCount()).toBe(0);
    });

    it('TEST-FI04 [Failure D]: Authentication verification fails -> marks NEEDS_LOGIN and disposes context', async () => {
      const mockBrowser = createMockBrowser();

      await expect(
        accountBrowserContextManager.acquireContext(mockBrowser, 'Acc-Fail-D', {
          verifyAuthHtml: () => false, // fails auth verification
        })
      ).rejects.toThrow(/Xác thực phiên người dùng cho "Acc-Fail-D" thất bại/);

      expect(accountMutexManager.isLocked('Acc-Fail-D')).toBe(false);
      expect(accountBrowserContextManager.getActiveContextCount()).toBe(0);
    });
  });

  // =========================================================================
  // 11. PERFORMANCE MEASUREMENT (Section 14)
  // =========================================================================
  describe('Performance Measurement Baseline', () => {
    it('TEST-PM01: measures baseline metrics for context creation, cookie injection, and disposal', async () => {
      const mockBrowser = createMockBrowser();
      const metrics = await accountBrowserContextManager.measurePerformance(mockBrowser, 'Perf-Acc');

      expect(metrics.contextCreationMs).toBeGreaterThanOrEqual(0);
      expect(metrics.pageCreationMs).toBeGreaterThanOrEqual(0);
      expect(metrics.cookieInjectionMs).toBeGreaterThanOrEqual(0);
      expect(metrics.authVerificationMs).toBeGreaterThanOrEqual(0);
      expect(metrics.contextDisposalMs).toBeGreaterThanOrEqual(0);
      expect(metrics.totalAcquisitionMs).toBeGreaterThanOrEqual(0);
    });
  });

  // =========================================================================
  // 12. PRODUCTION SAFETY (Section 15)
  // =========================================================================
  describe('Production Safety Verification', () => {
    it('TEST-PS01: Cold Ephemeral remains production default, Warm Browser is disabled by default', () => {
      // By default without WARM_BROWSER_EXPERIMENT=true, warm browser must remain inactive
      expect(warmBrowserManager.isWarmEnabled()).toBe(false);
    });
  });
});
