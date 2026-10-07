import { randomUUID } from 'node:crypto';
import {
  accountMutexManager,
  type AccountLockHandle,
} from './account-mutex-manager.js';
import {
  sessionRecoveryManager,
  classifySessionFailure,
  hasAuthenticatedMarker,
} from './session-recovery-manager.js';
import {
  loadAccountCookiesFromFile,
  type SpigotCookieItem,
} from './spigot-cookie-files.js';
import type { BrowserPage } from './download-via-browser.js';

/*
 * ============================================================================
 * PHASE 4C-4: BROWSER CONTEXT ISOLATION
 *
 * MỤC TIÊU:
 * - Cô lập hoàn toàn trạng thái giữa các Spigot account trong BrowserContext riêng.
 * - Mỗi Account sở hữu riêng:
 *   + riêng cookies
 *   + riêng localStorage
 *   + riêng sessionStorage
 *   + riêng pages
 *   + riêng authentication state
 *   + riêng lifecycle ownership
 * - Đảm bảo Zero Cross-Account Contamination.
 * - Tuân thủ nghiêm ngặt Account Mutex từ Phase 4C-2.
 * - Cold Ephemeral vẫn giữ vai trò Production Default (Warm Browser = Experimental Only).
 * ============================================================================
 */

export class ContextOwnershipError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ContextOwnershipError';
  }
}

export class ContextDisposedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ContextDisposedError';
  }
}

export class ContextInvalidatedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ContextInvalidatedError';
  }
}

const PAGE_ACCOUNT_METADATA = Symbol('PAGE_ACCOUNT_METADATA');

interface PageOwnerMetadata {
  accountLabel: string;
  contextId: string;
  browserId: string;
}

/**
 * Gắn nhãn quyền sở hữu tài khoản cho Page để chống việc dùng nhầm Page giữa các tài khoản khác nhau.
 */
export function tagPageWithAccount(
  page: unknown,
  accountLabel: string,
  contextId: string,
  browserId: string,
): void {
  if (page && typeof page === 'object') {
    Object.defineProperty(page, PAGE_ACCOUNT_METADATA, {
      value: { accountLabel, contextId, browserId } as PageOwnerMetadata,
      writable: false,
      configurable: true,
      enumerable: false,
    });
  }
}

/**
 * Xác thực tính sở hữu của Page. Ném ra ngoại lệ ContextOwnershipError nếu phát hiện dùng chéo.
 */
export function assertPageOwnership(page: unknown, expectedAccount: string): void {
  if (!page || typeof page !== 'object') return;
  const meta = (page as Record<string, unknown>)[PAGE_ACCOUNT_METADATA as unknown as string] as PageOwnerMetadata | undefined;
  if (meta && meta.accountLabel !== expectedAccount) {
    throw new ContextOwnershipError(
      `[ContextSecurity] Vi phạm quyền sở hữu trang: Trang thuộc về tài khoản "${meta.accountLabel}", không được phép dùng cho "${expectedAccount}"`
    );
  }
}

export interface AccountContextOptions {
  customBaseDir?: string;
  signal?: AbortSignal;
  jobId?: string;
  timeoutMs?: number;
  initialCookies?: SpigotCookieItem[];
  verifyAuthHtml?: (body: string, statusCode?: number) => boolean;
  onPageCreated?: (page: BrowserPage) => Promise<void> | void;
}

export interface ContextPerformanceMetrics {
  contextCreationMs: number;
  cookieInjectionMs: number;
  pageCreationMs: number;
  authVerificationMs: number;
  contextDisposalMs: number;
  totalAcquisitionMs: number;
}

export interface RawBrowserContext {
  newPage: () => Promise<unknown>;
  pages?: () => Promise<unknown[]>;
  close: () => Promise<void>;
  browser?: () => unknown;
}

export interface RawBrowserInstance {
  createBrowserContext?: () => Promise<RawBrowserContext>;
  createIncognitoBrowserContext?: () => Promise<RawBrowserContext>;
  pages?: () => Promise<unknown[]>;
  newPage?: () => Promise<unknown>;
  close?: () => Promise<void>;
  on?: (event: string, cb: (...args: unknown[]) => void) => void;
  off?: (event: string, cb: (...args: unknown[]) => void) => void;
  removeListener?: (event: string, cb: (...args: unknown[]) => void) => void;
  isConnected?: () => boolean;
}

/**
 * Lớp đại diện cho một BrowserContext độc quyền của một tài khoản Spigot.
 */
export class AccountBrowserContext {
  public readonly accountLabel: string;
  public readonly browserId: string;
  public readonly contextId: string;
  public readonly createdAt: number;

  private _rawContext: RawBrowserContext | null;
  private _rawBrowser: RawBrowserInstance | null;
  private _accountLock: AccountLockHandle | null;
  private _pages: Set<BrowserPage> = new Set();
  private _isDisposed = false;
  private _isDead = false;
  private _onDisposeCallbacks: Array<() => void> = [];

  constructor(params: {
    accountLabel: string;
    browserId: string;
    contextId: string;
    rawContext: RawBrowserContext;
    rawBrowser: RawBrowserInstance;
    accountLock: AccountLockHandle | null;
  }) {
    this.accountLabel = params.accountLabel;
    this.browserId = params.browserId;
    this.contextId = params.contextId;
    this.createdAt = Date.now();
    this._rawContext = params.rawContext;
    this._rawBrowser = params.rawBrowser;
    this._accountLock = params.accountLock;
  }

  public get isDisposed(): boolean {
    return this._isDisposed;
  }

  public get isDead(): boolean {
    return this._isDead;
  }

  public get rawContext(): RawBrowserContext | null {
    return this._rawContext;
  }

  public get rawBrowser(): RawBrowserInstance | null {
    return this._rawBrowser;
  }

  public get pages(): BrowserPage[] {
    return Array.from(this._pages);
  }

  /**
   * Kiểm tra quyền sở hữu đối với tài khoản chỉ định.
   */
  public assertOwnership(expectedAccount: string): void {
    if (this._isDisposed) {
      throw new ContextDisposedError(`[AccountBrowserContext] Context "${this.contextId}" cho "${this.accountLabel}" đã bị giải phóng.`);
    }
    if (this._isDead) {
      throw new ContextInvalidatedError(`[AccountBrowserContext] Context "${this.contextId}" cho "${this.accountLabel}" đã bị vô hiệu hóa do browser crash.`);
    }
    if (this.accountLabel !== expectedAccount) {
      throw new ContextOwnershipError(
        `[AccountBrowserContext] Vi phạm quyền sở hữu context: Context thuộc về "${this.accountLabel}", không phải "${expectedAccount}".`
      );
    }
  }

  /**
   * Tạo một trang (Page) mới bên trong BrowserContext cô lập này.
   */
  public async createPage(): Promise<BrowserPage> {
    this.assertOwnership(this.accountLabel);

    if (!this._rawContext || typeof this._rawContext.newPage !== 'function') {
      throw new Error(`[AccountBrowserContext] Raw BrowserContext không hỗ trợ newPage().`);
    }

    const page = (await this._rawContext.newPage()) as BrowserPage;
    tagPageWithAccount(page, this.accountLabel, this.contextId, this.browserId);
    this._pages.add(page);

    // Gắn hook tự động xóa khỏi danh sách khi trang đóng
    const pAny = page as unknown as { on?: (event: string, cb: () => void) => void };
    if (pAny && typeof pAny.on === 'function') {
      pAny.on('close', () => {
        this._pages.delete(page);
      });
    }

    return page;
  }

  /**
   * Kiểm tra context có còn sống và sẵn sàng sử dụng hay không.
   */
  public isAlive(): boolean {
    return !this._isDisposed && !this._isDead;
  }

  /**
   * Đánh dấu context đã chết (ví dụ khi browser crash/disconnected) và giải phóng lock tài khoản.
   */
  public markInvalid(reason = 'Browser crashed'): void {
    this._isDead = true;
    console.warn(`[AccountBrowserContext] ⚠️ Context "${this.contextId}" của "${this.accountLabel}" bị đánh dấu vô hiệu hóa: ${reason}`);
    if (this._accountLock) {
      this._accountLock.release().catch(() => {});
      this._accountLock = null;
    }
  }

  /**
   * Đăng ký callback khi context bị giải phóng.
   */
  public onDispose(callback: () => void): void {
    if (this._isDisposed) {
      callback();
      return;
    }
    this._onDisposeCallbacks.push(callback);
  }

  /**
   * Giải phóng Context, đóng toàn bộ Pages và nhả Account Mutex.
   * Đảm bảo tính lũy biến (idempotent): gọi nhiều lần không sinh lỗi, không leak.
   */
  public async dispose(): Promise<void> {
    if (this._isDisposed) {
      return;
    }
    this._isDisposed = true;

    // 1. Đóng toàn bộ các Page trực thuộc
    const pageClosePromises = Array.from(this._pages).map(async (p) => {
      try {
        if (typeof (p as any).close === 'function') {
          await (p as any).close();
        }
      } catch {
        // Bỏ qua lỗi đóng page
      }
    });
    await Promise.all(pageClosePromises);
    this._pages.clear();

    // 2. Đóng BrowserContext
    if (this._rawContext && typeof this._rawContext.close === 'function') {
      try {
        await this._rawContext.close();
      } catch {
        // Bỏ qua nếu context đã bị đóng do browser chết
      }
      this._rawContext = null;
    }

    // 3. Giải phóng Account Mutex nếu đang giữ
    if (this._accountLock) {
      try {
        await this._accountLock.release();
      } catch {
        // Bỏ qua lỗi giải phóng lock
      }
      this._accountLock = null;
    }

    // 4. Kích hoạt callbacks
    for (const cb of this._onDisposeCallbacks) {
      try {
        cb();
      } catch {}
    }
    this._onDisposeCallbacks = [];
  }
}

/**
 * Singleton Quản trị viên Browser Context theo từng Spigot Account.
 */
export class AccountBrowserContextManager {
  private activeContexts = new Map<string, AccountBrowserContext>();
  private browserDisconnectHandlers = new Map<RawBrowserInstance, () => void>();

  /**
   * Lấy số lượng BrowserContext đang hoạt động.
   */
  public getActiveContextCount(): number {
    return this.activeContexts.size;
  }

  /**
   * Lấy context đang hoạt động cho một tài khoản cụ thể.
   */
  public getActiveContext(accountLabel: string): AccountBrowserContext | null {
    const ctx = this.activeContexts.get(accountLabel);
    if (!ctx) return null;
    if (ctx.isDisposed || ctx.isDead) {
      this.activeContexts.delete(accountLabel);
      return null;
    }
    return ctx;
  }

  /**
   * Khởi tạo hoặc cấp phát BrowserContext cô lập cho một Spigot Account.
   * Tuân thủ quy trình chuẩn tắc (PDCA & Context Lifecycle):
   * 1. Chiếm giữ Account Mutex (chống race condition giữa các job cùng tài khoản).
   * 2. Tạo BrowserContext riêng biệt trên Browser (`createBrowserContext`).
   * 3. Nạp và tiêm cookies riêng biệt của tài khoản vào Context.
   * 4. Tạo Page ban đầu và gắn thẻ quyền sở hữu (tagPageWithAccount).
   * 5. Xác thực phiên (authentication verification) nếu có yêu cầu.
   */
  public async acquireContext(
    browser: RawBrowserInstance,
    accountLabel: string,
    options: AccountContextOptions = {},
  ): Promise<AccountBrowserContext> {
    const acquisitionStart = Date.now();
    const browserId = (browser as any)._browserId ?? randomUUID();
    (browser as any)._browserId = browserId;

    // 1. Chiếm giữ Account Mutex (Phase 4C-2 Serialization)
    let accountLock: AccountLockHandle | null = null;
    try {
      accountLock = await accountMutexManager.acquire(accountLabel, {
        signal: options.signal,
        timeoutMs: options.timeoutMs,
        jobId: options.jobId,
      });
    } catch (lockErr) {
      throw lockErr;
    }

    // 2. Gắn listener theo dõi browser crash (nếu chưa gắn)
    this.ensureBrowserCrashWatcher(browser, browserId);

    // 3. Khởi tạo BrowserContext độc lập
    let rawContext: RawBrowserContext;
    try {
      if (typeof browser.createBrowserContext === 'function') {
        rawContext = await browser.createBrowserContext();
      } else if (typeof browser.createIncognitoBrowserContext === 'function') {
        rawContext = await browser.createIncognitoBrowserContext();
      } else {
        // Fallback đối với môi trường mock hoặc engine không hỗ trợ
        rawContext = {
          newPage: async () => {
            if (typeof browser.newPage === 'function') {
              return await browser.newPage();
            }
            throw new Error('[BrowserContext] Browser không hỗ trợ newPage().');
          },
          close: async () => {},
        };
      }
    } catch (contextCreateErr) {
      if (accountLock) await accountLock.release().catch(() => undefined);
      throw contextCreateErr;
    }

    const contextId = randomUUID();
    const accountContext = new AccountBrowserContext({
      accountLabel,
      browserId,
      contextId,
      rawContext,
      rawBrowser: browser,
      accountLock,
    });

    accountContext.onDispose(() => {
      if (this.activeContexts.get(accountLabel) === accountContext) {
        this.activeContexts.delete(accountLabel);
      }
    });

    this.activeContexts.set(accountLabel, accountContext);

    // 4. Tạo trang ban đầu (Initial Page)
    let page: BrowserPage;
    try {
      page = await accountContext.createPage();
      if (options.onPageCreated) {
        await options.onPageCreated(page);
      }
    } catch (pageErr) {
      await accountContext.dispose();
      throw pageErr;
    }

    // 5. Nạp và tiêm cookies riêng của tài khoản vào Page / Context
    try {
      const cookiesToInject =
        options.initialCookies ??
        loadAccountCookiesFromFile(accountLabel, options.customBaseDir)?.cookies;

      if (cookiesToInject && cookiesToInject.length > 0) {
        await this.injectCookiesIntoPage(page, cookiesToInject);
      }
    } catch (cookieErr) {
      await accountContext.dispose();
      throw cookieErr;
    }

    // 6. Kiểm tra xác thực người dùng (Auth verification) nếu có yêu cầu
    if (options.verifyAuthHtml) {
      try {
        let body = '';
        let status = 200;
        if (typeof (page as any).content === 'function') {
          body = await (page as any).content();
        }
        const isAuthenticated = options.verifyAuthHtml(body, status);
        if (!isAuthenticated) {
          const classification = classifySessionFailure({
            hasAuthMarker: false,
            statusCode: status,
            bodySnippet: body.slice(0, 500),
          });
          sessionRecoveryManager.setState(accountLabel, classification.type === 'NEEDS_LOGIN' ? 'NEEDS_LOGIN' : 'UNKNOWN');
          await accountContext.dispose();
          throw new Error(`[AccountBrowserContext] Xác thực phiên người dùng cho "${accountLabel}" thất bại (cần đăng nhập lại).`);
        }
      } catch (authErr) {
        await accountContext.dispose();
        throw authErr;
      }
    }

    return accountContext;
  }

  /**
   * Tiêm cookies vào page thông qua CDP Network.setCookie hoặc page.setCookie.
   */
  public async injectCookiesIntoPage(
    page: BrowserPage,
    cookies: SpigotCookieItem[],
  ): Promise<void> {
    if (!cookies || cookies.length === 0) return;

    if (typeof (page as any).createCDPSession === 'function') {
      const cdp = await (page as any).createCDPSession();
      try {
        await cdp.send('Network.enable').catch(() => {});
        for (const c of cookies) {
          if (!c.name || !c.value) continue;
          await cdp.send('Network.setCookie', {
            name: c.name,
            value: c.value,
            domain: c.domain ?? '.spigotmc.org',
            path: c.path ?? '/',
            secure: c.secure ?? true,
            httpOnly: c.httpOnly ?? true,
            sameSite: (c.sameSite as any) ?? 'None',
          }).catch(() => {});
        }
        return;
      } finally {
        await cdp.detach().catch(() => {});
      }
    }

    if (typeof (page as any).setCookie === 'function') {
      await (page as any).setCookie(...cookies).catch(() => {});
    }
  }

  /**
   * Theo dõi sự cố crash hoặc mất kết nối của Browser để vô hiệu hóa ngay các Context trực thuộc.
   */
  private ensureBrowserCrashWatcher(browser: RawBrowserInstance, browserId: string): void {
    if (this.browserDisconnectHandlers.has(browser)) return;

    const onDisconnect = () => {
      console.warn(`[AccountBrowserContextManager] 💥 Phát hiện trình duyệt (id: ${browserId}) ngắt kết nối. Vô hiệu hóa tất cả context liên kết.`);
      for (const [accountLabel, ctx] of this.activeContexts.entries()) {
        if (ctx.browserId === browserId) {
          ctx.markInvalid('Browser disconnected');
          this.activeContexts.delete(accountLabel);
        }
      }
    };

    if (typeof browser.on === 'function') {
      browser.on('disconnected', onDisconnect);
      this.browserDisconnectHandlers.set(browser, onDisconnect);
    }
  }

  /**
   * Đo lường hiệu năng của chu trình Context Lifecycle (Performance Measurement).
   */
  public async measurePerformance(
    browser: RawBrowserInstance,
    accountLabel: string,
    options: AccountContextOptions = {},
  ): Promise<ContextPerformanceMetrics> {
    const t0 = Date.now();

    // 1. Context Creation
    const tContext0 = Date.now();
    let rawContext: RawBrowserContext;
    if (typeof browser.createBrowserContext === 'function') {
      rawContext = await browser.createBrowserContext();
    } else {
      rawContext = {
        newPage: async () => (browser.newPage ? browser.newPage() : {}),
        close: async () => {},
      };
    }
    const contextCreationMs = Date.now() - tContext0;

    const contextId = randomUUID();
    const ctx = new AccountBrowserContext({
      accountLabel,
      browserId: 'benchmark-browser',
      contextId,
      rawContext,
      rawBrowser: browser,
      accountLock: null,
    });

    // 2. Page Creation
    const tPage0 = Date.now();
    const page = await ctx.createPage();
    const pageCreationMs = Date.now() - tPage0;

    // 3. Cookie Injection
    const tCookie0 = Date.now();
    const testCookies: SpigotCookieItem[] = [
      { name: 'session_marker', value: 'benchmark_token', domain: '.spigotmc.org' },
    ];
    await this.injectCookiesIntoPage(page, testCookies);
    const cookieInjectionMs = Date.now() - tCookie0;

    // 4. Auth Verification
    const tAuth0 = Date.now();
    const mockHtml = '<div data-logged-in="true">User</div>';
    hasAuthenticatedMarker(mockHtml);
    const authVerificationMs = Date.now() - tAuth0;

    // 5. Context Disposal
    const tDisp0 = Date.now();
    await ctx.dispose();
    const contextDisposalMs = Date.now() - tDisp0;

    const totalAcquisitionMs = Date.now() - t0;

    return {
      contextCreationMs,
      cookieInjectionMs,
      pageCreationMs,
      authVerificationMs,
      contextDisposalMs,
      totalAcquisitionMs,
    };
  }

  /**
   * Reset hoàn toàn registry (chỉ dùng trong testing).
   */
  public reset(): void {
    this.activeContexts.clear();
    this.browserDisconnectHandlers.clear();
  }
}

export const accountBrowserContextManager = new AccountBrowserContextManager();
