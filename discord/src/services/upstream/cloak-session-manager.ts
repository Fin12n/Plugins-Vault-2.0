import { existsSync, rmSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { terminateProcessTree } from './process-tree-killer.js';

/**
 * Lỗi phát sinh khi có yêu cầu mở session CloakBrowser mới trong khi
 * đã có một session khác đang hoạt động và không thể xếp hàng.
 */
export class SessionConflictError extends Error {
  constructor(public readonly currentTask: string, public readonly requestedTask: string) {
    super(
      `[CloakSessionManager] Đã có 1 phiên CloakBrowser đang hoạt động cho tác vụ "${currentTask}". ` +
      `Từ chối mở phiên mới cho "${requestedTask}" để tuân thủ nghiêm ngặt giới hạn 1 concurrent session của CloakBrowser Pro.`
    );
    this.name = 'SessionConflictError';
  }
}

export type ActiveSessionInfo = {
  taskName: string;
  startedAt: number;
  browser: {
    close: () => Promise<void>;
    process?: () => { kill: (signal?: NodeJS.Signals | number) => boolean; pid?: number; killed?: boolean } | null;
    isConnected?: () => boolean;
  } | null;
  tempProfileDir?: string;
  isDead?: boolean;
};

export type SessionLockHandle = {
  taskName: string;
  startedAt: number;
  registerBrowser: (browser: ActiveSessionInfo['browser']) => void;
  release: () => Promise<void>;
  markDead: () => void;
};

export type AcquireOptions = {
  tempProfileDir?: string;
  waitTimeoutMs?: number;
  signal?: AbortSignal;
};

type QueueWaiter = {
  id: string;
  taskName: string;
  tempProfileDir?: string;
  resolve: (handle: SessionLockHandle) => void;
  reject: (err: Error) => void;
  timeoutTimer: NodeJS.Timeout | null;
  onAbort?: () => void;
  signal?: AbortSignal;
};

/**
 * Singleton CloakSessionManager: Quản lý độc quyền phiên CloakBrowser trên toàn hệ thống.
 * Đảm bảo CHỈ CÓ DUY NHẤT 1 BROWSER SESSION được phép hoạt động tại bất kỳ thời điểm nào.
 */
class CloakSessionManager {
  private activeSession: ActiveSessionInfo | null = null;
  private waitQueue: QueueWaiter[] = [];

  /**
   * Kiểm tra xem hiện có session CloakBrowser nào đang hoạt động hay không.
   */
  public hasActiveSession(): boolean {
    return this.activeSession !== null;
  }

  /**
   * Số lượng tác vụ đang chờ trong hàng đợi.
   */
  public getQueueLength(): number {
    return this.waitQueue.length;
  }

  /**
   * Lấy thông tin về session đang hoạt động hiện tại (nếu có).
   */
  public getActiveSessionInfo(): Readonly<ActiveSessionInfo> | null {
    return this.activeSession ? { ...this.activeSession } : null;
  }

  /**
   * Kiểm tra xem session hiện tại có bị crash hoặc ngắt kết nối hay không.
   */
  public isSessionDead(session: ActiveSessionInfo | null = this.activeSession): boolean {
    if (!session) return false;
    if (session.isDead) return true;

    if (session.browser) {
      if (typeof session.browser.isConnected === 'function' && !session.browser.isConnected()) {
        return true;
      }
      try {
        const proc = session.browser.process?.();
        if (proc) {
          if (proc.killed) return true;
          const pid = proc.pid;
          if (typeof pid === 'number') {
            try {
              process.kill(pid, 0);
            } catch (err: unknown) {
              const code = (err as { code?: string })?.code;
              if (code === 'ESRCH') {
                return true;
              }
            }
          }
        }
      } catch {
        // Bỏ qua lỗi
      }
    }

    return false;
  }

  /**
   * Đánh dấu session hiện tại là đã chết (crash).
   */
  public markActiveSessionDead(): void {
    if (this.activeSession) {
      this.activeSession.isDead = true;
    }
  }

  /**
   * Tạo handle quản lý khóa phiên cho tác vụ.
   */
  private createLockHandle(sessionInfo: ActiveSessionInfo): SessionLockHandle {
    const taskName = sessionInfo.taskName;
    return {
      taskName,
      startedAt: sessionInfo.startedAt,
      registerBrowser: (browser: ActiveSessionInfo['browser']) => {
        if (this.activeSession && this.activeSession.taskName === taskName) {
          this.activeSession.browser = browser;

          const bAny = browser as unknown as { on?: (event: string, cb: () => void) => void };
          if (bAny && typeof bAny.on === 'function') {
            bAny.on('disconnected', () => {
              if (this.activeSession && this.activeSession.browser === browser) {
                this.activeSession.isDead = true;
              }
            });
          }

          try {
            const proc = browser?.process?.() as unknown as { on?: (event: string, cb: () => void) => void } | null;
            if (proc && typeof proc.on === 'function') {
              proc.on('exit', () => {
                if (this.activeSession && this.activeSession.browser === browser) {
                  this.activeSession.isDead = true;
                }
              });
            }
          } catch {
            // ignore
          }
        }
      },
      markDead: () => {
        if (this.activeSession && this.activeSession.taskName === taskName) {
          this.activeSession.isDead = true;
        }
      },
      release: async () => {
        if (this.activeSession && this.activeSession.taskName === taskName) {
          this.activeSession.browser = null;
        }
        await this.releaseLock(taskName);
      },
    };
  }

  /**
   * Yêu cầu cấp phát khóa độc quyền (Mutex Lock) để mở session CloakBrowser mới.
   * Nếu đã có session đang chạy:
   *  - Nếu session cũ đã chết, tự động dọn dẹp và cấp lock mới.
   *  - Nếu session cũ còn sống và có waitTimeoutMs > 0, xếp hàng vào FIFO queue.
   *  - Nếu waitTimeoutMs === 0, ném SessionConflictError ngay lập tức (fail-fast).
   */
  public async acquireLock(
    taskName: string,
    optionsOrTempDir?: string | AcquireOptions,
  ): Promise<SessionLockHandle> {
    const options: AcquireOptions =
      typeof optionsOrTempDir === 'string'
        ? { tempProfileDir: optionsOrTempDir }
        : (optionsOrTempDir ?? {});

    if (options.signal?.aborted) {
      throw new Error(`[CloakSessionManager] Yêu cầu cấp khóa cho "${taskName}" đã bị hủy trước khi bắt đầu`);
    }

    if (this.activeSession !== null) {
      if (this.isSessionDead(this.activeSession)) {
        console.warn(
          `[CloakSessionManager] Phát hiện phiên CloakBrowser cũ cho tác vụ "${this.activeSession.taskName}" đã chết (crashed/disconnected). Tự động dọn dẹp để cấp lock mới cho "${taskName}".`
        );
        await this.releaseLock();
      } else if (options.waitTimeoutMs === 0) {
        throw new SessionConflictError(this.activeSession.taskName, taskName);
      } else {
        // Đưa vào hàng đợi FIFO chờ phục vụ
        return new Promise<SessionLockHandle>((resolve, reject) => {
          const waiterId = randomUUID();
          const timeoutMs = options.waitTimeoutMs ?? 60_000;
          let timeoutTimer: NodeJS.Timeout | null = null;

          const removeWaiter = () => {
            if (timeoutTimer) clearTimeout(timeoutTimer);
            const idx = this.waitQueue.findIndex((w) => w.id === waiterId);
            if (idx !== -1) this.waitQueue.splice(idx, 1);
            if (options.signal && onAbort) {
              options.signal.removeEventListener('abort', onAbort);
            }
          };

          if (timeoutMs > 0 && timeoutMs !== Infinity) {
            timeoutTimer = setTimeout(() => {
              removeWaiter();
              reject(new Error(`[CloakSessionManager] Hết thời gian chờ cấp khóa (${timeoutMs}ms) cho tác vụ "${taskName}"`));
            }, timeoutMs);
            timeoutTimer.unref();
          }

          let onAbort: (() => void) | undefined;
          if (options.signal) {
            onAbort = () => {
              removeWaiter();
              reject(new Error(`[CloakSessionManager] Yêu cầu cấp khóa cho tác vụ "${taskName}" đã bị hủy bởi caller`));
            };
            options.signal.addEventListener('abort', onAbort, { once: true });
          }

          this.waitQueue.push({
            id: waiterId,
            taskName,
            tempProfileDir: options.tempProfileDir,
            resolve,
            reject,
            timeoutTimer,
            onAbort,
            signal: options.signal,
          });
        });
      }
    }

    const sessionInfo: ActiveSessionInfo = {
      taskName,
      startedAt: Date.now(),
      browser: null,
      tempProfileDir: options.tempProfileDir,
    };

    this.activeSession = sessionInfo;
    return this.createLockHandle(sessionInfo);
  }

  /**
   * Đóng sạch sẽ session hiện tại, giải phóng tài nguyên và chuyển giao lock cho tác vụ tiếp theo trong queue (FIFO).
   */
  public async releaseLock(taskName?: string): Promise<void> {
    if (!this.activeSession) return;

    if (taskName && this.activeSession.taskName !== taskName) {
      console.warn(
        `[CloakSessionManager] Cảnh báo: Tác vụ "${taskName}" cố gắng giải phóng lock của "${this.activeSession.taskName}". Bỏ qua.`
      );
      return;
    }

    const session = this.activeSession;
    this.activeSession = null;

    // 1. Đóng trình duyệt triệt để
    if (session.browser) {
      try {
        let timer: NodeJS.Timeout | null = null;
        const graceful = await Promise.race([
          session.browser.close().then(() => true).catch(() => false),
          new Promise<boolean>((resolve) => {
            timer = setTimeout(() => resolve(false), 5000);
            timer.unref();
          }),
        ]);

        if (timer) clearTimeout(timer);

        if (!graceful) {
          try {
            const proc = session.browser.process?.();
            const pid = (proc as { pid?: number })?.pid;
            if (pid && typeof pid === 'number' && pid > 0) {
              await terminateProcessTree(pid);
            } else if (proc) {
              try {
                proc.kill('SIGKILL');
              } catch { }
            }
          } catch {
            // Process may already have terminated
          }
        }
      } catch (err) {
        console.warn('[CloakSessionManager] Lỗi khi đóng browser instance:', err instanceof Error ? err.message : String(err));
      }
    }

    // 2. Xoá sạch thư mục profile tạm thời (che giấu danh tính tuyệt đối)
    if (session.tempProfileDir && existsSync(session.tempProfileDir)) {
      try {
        rmSync(session.tempProfileDir, { recursive: true, force: true });
      } catch (err) {
        console.warn(
          `[CloakSessionManager] Không thể xoá profile tạm "${session.tempProfileDir}":`,
          err instanceof Error ? err.message : String(err)
        );
      }
    }

    // 3. Phục vụ tác vụ tiếp theo trong hàng đợi FIFO (nếu có)
    while (this.waitQueue.length > 0) {
      const nextWaiter = this.waitQueue.shift()!;
      if (nextWaiter.timeoutTimer) clearTimeout(nextWaiter.timeoutTimer);
      if (nextWaiter.signal && nextWaiter.onAbort) {
        nextWaiter.signal.removeEventListener('abort', nextWaiter.onAbort);
      }

      // Nếu waiter đã bị aborted giữa lúc chờ, bỏ qua
      if (nextWaiter.signal?.aborted) {
        continue;
      }

      const nextSession: ActiveSessionInfo = {
        taskName: nextWaiter.taskName,
        startedAt: Date.now(),
        browser: null,
        tempProfileDir: nextWaiter.tempProfileDir,
      };

      this.activeSession = nextSession;
      nextWaiter.resolve(this.createLockHandle(nextSession));
      break;
    }
  }

  /**
   * Giải tán toàn bộ hàng đợi (thường dùng khi shutdown).
   */
  public drainQueue(reason = 'System shutdown'): void {
    const waiters = [...this.waitQueue];
    this.waitQueue = [];
    for (const w of waiters) {
      if (w.timeoutTimer) clearTimeout(w.timeoutTimer);
      if (w.signal && w.onAbort) {
        w.signal.removeEventListener('abort', w.onAbort);
      }
      w.reject(new Error(`[CloakSessionManager] Hàng đợi bị giải tán (${reason}) cho tác vụ "${w.taskName}"`));
    }
  }

  /**
   * Reset hoàn toàn trạng thái lock và queue (dùng trong test hoặc phục hồi khẩn cấp).
   */
  public reset(): void {
    this.drainQueue('Reset manager');
    this.activeSession = null;
  }
}

export const cloakSessionManager = new CloakSessionManager();
