import type { Credential } from './spigot-credential-store.js';
import { loginToSpigot, type BrowserSession, type LoginResult } from './download-via-browser.js';

const SESSION_TTL_MS = 20 * 60 * 1000;
const AUTO_RESUME_INTERVAL_MS = 2_000;
const INTERACTIVE_TIMEOUT_MS = 12_000;
const RETRY_TIMEOUT_MS = 70_000;
const CLOSE_TIMEOUT_MS = 10_000;

export type SpigotChallengeStatus = {
  active: boolean;
  accountLabel: string | null;
  reason: string | null;
  startedAt: number | null;
  expiresAt: number | null;
};

type ActiveChallenge = {
  accountLabel: string;
  retryLogin: () => Promise<LoginResult>;
  reason: string;
  session: BrowserSession;
  startedAt: number;
  expiresAt: number;
  timer: NodeJS.Timeout;
  monitor: NodeJS.Timeout | null;
  operation: string | null;
  autoResumeAttempted: boolean;
};

type ChallengeSessionTimings = {
  autoResumeIntervalMs?: number;
  interactiveTimeoutMs?: number;
  retryTimeoutMs?: number;
  closeTimeoutMs?: number;
};

class ChallengeOperationTimeoutError extends Error {}

export type SpigotChallengeSessionController = Pick<
  SpigotChallengeSessionManager,
  'getStatus' | 'hasActive' | 'captureFrame' | 'movePointer' | 'click' | 'typeText' | 'pressKey' | 'retryLogin' | 'resolve' | 'close'
>;

/** Owns the one VPS browser temporarily handed to the dashboard for a human challenge. */
export class SpigotChallengeSessionManager {
  private active: ActiveChallenge | null = null;
  private onResolved: (() => void) | null = null;

  constructor(private readonly timings: ChallengeSessionTimings = {}) {}

  setResolvedHandler(handler: () => void): void {
    this.onResolved = handler;
  }

  getStatus(): SpigotChallengeStatus {
    const current = this.active;
    if (!current) return { active: false, accountLabel: null, reason: null, startedAt: null, expiresAt: null };
    return {
      active: true,
      accountLabel: current.accountLabel,
      reason: current.reason,
      startedAt: current.startedAt,
      expiresAt: current.expiresAt,
    };
  }

  hasActive(): boolean {
    return this.active !== null;
  }

  async hold(input: {
    accountLabel: string;
    reason: string;
    session: BrowserSession;
    retryLogin?: () => Promise<LoginResult>;
    credential?: Credential;
  }): Promise<void> {
    await this.close();
    const startedAt = Date.now();
    const timer = setTimeout(() => void this.close(), SESSION_TTL_MS);
    timer.unref();
    const retryLogin = input.retryLogin ?? (() => {
      if (!input.credential) throw new Error('Phiên xác minh thiếu thông tin đăng nhập');
      return loginToSpigot(input.session.page, input.credential);
    });
    const current: ActiveChallenge = {
      accountLabel: input.accountLabel,
      reason: input.reason,
      session: input.session,
      retryLogin,
      startedAt,
      expiresAt: startedAt + SESSION_TTL_MS,
      timer,
      monitor: null,
      operation: null,
      autoResumeAttempted: false,
    };
    current.monitor = setInterval(
      () => void this.detectCompletedLogin(current),
      this.timings.autoResumeIntervalMs ?? AUTO_RESUME_INTERVAL_MS,
    );
    current.monitor.unref();
    this.active = current;
  }

  async captureFrame(): Promise<{ image: Buffer; width: number; height: number }> {
    const current = this.requireActive();
    return this.runExclusive(current, 'đang chụp khung trình duyệt', this.interactiveTimeoutMs(), async () => {
      const dimensions = await current.session.page.evaluate(
        `({ width: window.innerWidth, height: window.innerHeight })` as never,
      ) as { width: number; height: number };
      const cdp = await current.session.page.createCDPSession();
      const result = await cdp.send('Page.captureScreenshot', { format: 'jpeg', quality: 75, fromSurface: true }) as {
        data: string;
      };
      return { image: Buffer.from(result.data, 'base64'), width: dimensions.width, height: dimensions.height };
    });
  }

  async click(normalizedX: number, normalizedY: number): Promise<void> {
    const current = this.requireActive();
    await this.runExclusive(current, 'đang click trình duyệt', this.interactiveTimeoutMs(), async () => {
      const point = await this.resolvePoint(current, normalizedX, normalizedY);
      await current.session.page.mouse.move(point.x, point.y);
      await current.session.page.mouse.click(point.x, point.y);
    });
  }

  async movePointer(normalizedX: number, normalizedY: number): Promise<void> {
    const current = this.requireActive();
    await this.runExclusive(current, 'đang di chuyển con trỏ', this.interactiveTimeoutMs(), async () => {
      const point = await this.resolvePoint(current, normalizedX, normalizedY);
      await current.session.page.mouse.move(point.x, point.y);
    });
  }

  async retryLogin(): Promise<LoginResult> {
    const current = this.requireActive();
    return this.runExclusive(current, 'đang kiểm tra đăng nhập', this.timings.retryTimeoutMs ?? RETRY_TIMEOUT_MS, () =>
      current.retryLogin(),
    );
  }

  async typeText(text: string): Promise<void> {
    const current = this.requireActive();
    await this.runExclusive(current, 'đang nhập chữ', this.interactiveTimeoutMs(), () =>
      current.session.page.keyboard.type(text, { delay: 35 }),
    );
  }

  async pressKey(key: 'Enter' | 'Tab' | 'Escape' | 'Backspace'): Promise<void> {
    const current = this.requireActive();
    await this.runExclusive(current, 'đang gửi phím', this.interactiveTimeoutMs(), () =>
      current.session.page.keyboard.press(key),
    );
  }

  async resolve(): Promise<void> {
    const current = this.active;
    if (!current) return;
    if (await this.release(current)) this.onResolved?.();
  }

  async close(): Promise<void> {
    const current = this.active;
    if (!current) return;
    await this.release(current);
  }

  private async release(current: ActiveChallenge): Promise<boolean> {
    if (this.active !== current) return false;
    this.active = null;
    clearTimeout(current.timer);
    if (current.monitor) clearInterval(current.monitor);
    try {
      await this.withDeadline(
        current.session.close(),
        this.timings.closeTimeoutMs ?? CLOSE_TIMEOUT_MS,
        'Chromium không đóng được đúng hạn',
      );
      return true;
    } catch {
      return false;
    }
  }

  private requireActive(): ActiveChallenge {
    if (!this.active) throw new Error('Không có phiên xác minh Spigot đang mở');
    return this.active;
  }

  private async resolvePoint(
    current: ActiveChallenge,
    normalizedX: number,
    normalizedY: number,
  ): Promise<{ x: number; y: number }> {
    const dimensions = await current.session.page.evaluate(
      `({ width: window.innerWidth, height: window.innerHeight })` as never,
    ) as { width: number; height: number };
    return {
      x: Math.max(0, Math.min(1, normalizedX)) * dimensions.width,
      y: Math.max(0, Math.min(1, normalizedY)) * dimensions.height,
    };
  }

  private interactiveTimeoutMs(): number {
    return this.timings.interactiveTimeoutMs ?? INTERACTIVE_TIMEOUT_MS;
  }

  private async detectCompletedLogin(current: ActiveChallenge): Promise<void> {
    if (this.active !== current || current.operation !== null) return;
    try {
      const loggedIn = await this.runExclusive(
        current,
        'đang dò trạng thái đăng nhập',
        this.interactiveTimeoutMs(),
        () => current.session.page.evaluate(
          `!!document.querySelector('.accountUsername, [data-logged-in="true"], a[href*="logout"]')` as never,
        ) as Promise<boolean>,
      );
      if (!loggedIn) {
        current.autoResumeAttempted = false;
        return;
      }
      if (this.active === current && !current.autoResumeAttempted) {
        current.autoResumeAttempted = true;
        // The held continuation can also scan Purchased Resources and persist
        // ownership. Closing immediately after spotting the login marker would
        // skip that work and leave the download queue without a usable owner.
        const result = await this.retryLogin();
        if (result.ok && this.active === current) await this.resolve();
        else if (!result.ok && this.active === current) current.reason = result.detail;
      }
    } catch {
      // A busy browser is normal while the admin is interacting. A timed-out
      // browser is released by runExclusive so the next sweep can relaunch it.
    }
  }

  private async runExclusive<T>(
    current: ActiveChallenge,
    operation: string,
    timeoutMs: number,
    work: () => Promise<T>,
  ): Promise<T> {
    if (this.active !== current) throw new Error('Không có phiên xác minh Spigot đang mở');
    if (current.operation !== null) throw new Error(`Browser VPS ${current.operation}; thử lại sau`);
    current.operation = operation;
    try {
      return await this.withDeadline(work(), timeoutMs, `Browser VPS không phản hồi khi ${operation}`);
    } catch (err) {
      if (err instanceof ChallengeOperationTimeoutError && this.active === current) {
        if (await this.release(current)) this.onResolved?.();
      }
      throw err;
    } finally {
      if (this.active === current) current.operation = null;
    }
  }

  private async withDeadline<T>(work: Promise<T>, timeoutMs: number, message: string): Promise<T> {
    let timer: NodeJS.Timeout | null = null;
    try {
      return await Promise.race([
        work,
        new Promise<T>((_resolve, reject) => {
          timer = setTimeout(() => reject(new ChallengeOperationTimeoutError(message)), timeoutMs);
          timer.unref();
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
}
