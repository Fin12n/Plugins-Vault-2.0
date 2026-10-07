import { randomUUID } from 'node:crypto';
import { JobTimeoutError } from './deadline-budget.js';

/*
 * ============================================================================
 * CANONICAL LOCK ORDERING (BẮT BUỘC TUÂN THỦ TOÀN HỆ THỐNG):
 *
 * 1. Global Scheduling Admission (Kiểm tra hệ thống không bị shutdown, admission gate)
 *    ↓
 * 2. Account Mutex (accountMutexManager.acquire(accountLabel))
 *    ↓
 * 3. Browser / Session Resource (cloakSessionManager.acquireLock(taskName))
 *
 * THỨ TỰ GIẢI PHÓNG (NGƯỢC LẠI HOÀN TOÀN):
 * 1. Browser / Session Resource (session.close() / lockHandle.release())
 *    ↓
 * 2. Account Mutex (accountLock.release())
 *    ↓
 * 3. Complete Admission
 *
 * QUY TẮC BẢO ĐẢM KHÔNG DEADLOCK (ZERO LOCK-ORDER INVERSION):
 * - Giữ Account Mutex KHÔNG BAO GIỜ chặn các tài khoản Spigot khác.
 * - Chờ Account Mutex KHÔNG ĐƯỢC PHÉP giữ trước tài nguyên Browser Session.
 * - Tuyệt đối không acquire ngược: Account Mutex sau khi đã có Browser Session.
 * ============================================================================
 */

export interface AccountLockHandle {
  readonly accountLabel: string;
  readonly jobId?: string;
  readonly acquiredAt: number;
  release: () => Promise<void>;
}

export interface AcquireAccountOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
  jobId?: string;
}

interface AccountWaiter {
  id: string;
  jobId?: string;
  resolve: (handle: AccountLockHandle) => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout | null;
  onAbort?: () => void;
  signal?: AbortSignal;
}

interface AccountLockState {
  activeJobId?: string;
  acquiredAt: number;
  waiters: AccountWaiter[];
}

export class AccountMutexManager {
  private locks = new Map<string, AccountLockState>();
  private isStopping = false;

  /**
   * Kiểm tra xem một tài khoản Spigot hiện có đang bị khóa (đang có job chiếm giữ) hay không.
   */
  public isLocked(accountLabel: string): boolean {
    const state = this.locks.get(accountLabel);
    return state !== undefined;
  }

  /**
   * Lấy số lượng tài khoản đang bị khóa tại thời điểm hiện tại.
   */
  public getActiveLockCount(): number {
    return this.locks.size;
  }

  /**
   * Reset hoàn toàn trạng thái (alias cho testing).
   */
  public clearForTest(): void {
    this.reset();
  }

  /**
   * Lấy số lượng job đang xếp hàng chờ cho một tài khoản (hoặc toàn bộ hệ thống).
   */
  public getQueueLength(accountLabel?: string): number {
    if (accountLabel) {
      return this.locks.get(accountLabel)?.waiters.length ?? 0;
    }
    let total = 0;
    for (const state of this.locks.values()) {
      total += state.waiters.length;
    }
    return total;
  }

  /**
   * Yêu cầu cấp phát khóa độc quyền cho một tài khoản Spigot cụ thể (Account Mutex).
   */
  public async acquire(
    accountLabel: string,
    options: AcquireAccountOptions = {},
  ): Promise<AccountLockHandle> {
    if (this.isStopping) {
      throw new Error(`[AccountMutexManager] Từ chối cấp khóa cho "${accountLabel}": Hệ thống đang trong quá trình shutdown`);
    }

    if (options.signal?.aborted) {
      const reason = options.signal.reason;
      if (reason instanceof Error) throw reason;
      throw new Error(String(reason ?? `Yêu cầu khóa tài khoản "${accountLabel}" đã bị hủy trước khi bắt đầu`));
    }

    const state = this.locks.get(accountLabel);

    // Trường hợp 1: Tài khoản chưa ai chiếm -> Nhận khóa ngay lập tức
    if (!state) {
      const newState: AccountLockState = {
        activeJobId: options.jobId,
        acquiredAt: Date.now(),
        waiters: [],
      };
      this.locks.set(accountLabel, newState);
      return this.createHandle(accountLabel, newState, options.jobId);
    }

    // Trường hợp 2: Tài khoản đang bận -> Xếp hàng chờ FIFO
    return new Promise<AccountLockHandle>((resolve, reject) => {
      const waiterId = randomUUID();
      let timer: NodeJS.Timeout | null = null;

      const removeWaiter = () => {
        if (timer) clearTimeout(timer);
        const curr = this.locks.get(accountLabel);
        if (curr) {
          const idx = curr.waiters.findIndex((w) => w.id === waiterId);
          if (idx !== -1) curr.waiters.splice(idx, 1);
        }
        if (options.signal && onAbort) {
          options.signal.removeEventListener('abort', onAbort);
        }
      };

      let onAbort: (() => void) | undefined;
      if (options.signal) {
        onAbort = () => {
          removeWaiter();
          const reason = options.signal?.reason;
          if (reason instanceof Error) {
            reject(reason);
          } else {
            reject(new Error(String(reason ?? `[AccountMutexManager] Chờ khóa tài khoản "${accountLabel}" bị hủy bởi signal`)));
          }
        };
        options.signal.addEventListener('abort', onAbort, { once: true });
      }

      if (options.timeoutMs !== undefined && options.timeoutMs > 0 && options.timeoutMs !== Infinity) {
        timer = setTimeout(() => {
          removeWaiter();
          reject(new JobTimeoutError(
            `[AccountMutexManager] Hết thời gian chờ cấp khóa tài khoản "${accountLabel}" (${options.timeoutMs}ms) cho job "${options.jobId ?? 'anonymous'}"`,
            Date.now() + options.timeoutMs!,
            Date.now(),
            options.jobId,
          ));
        }, options.timeoutMs);
        timer.unref();
      }

      state.waiters.push({
        id: waiterId,
        jobId: options.jobId,
        resolve,
        reject,
        timer,
        onAbort,
        signal: options.signal,
      });
    });
  }

  private createHandle(
    accountLabel: string,
    state: AccountLockState,
    jobId?: string,
  ): AccountLockHandle {
    let released = false;

    return {
      accountLabel,
      jobId,
      acquiredAt: state.acquiredAt,
      release: async (): Promise<void> => {
        if (released) return; // Idempotent release
        released = true;

        const currentState = this.locks.get(accountLabel);
        if (!currentState || currentState !== state) {
          return;
        }

        // Phục vụ người chờ tiếp theo trong hàng đợi FIFO
        while (currentState.waiters.length > 0) {
          const next = currentState.waiters.shift()!;
          if (next.timer) clearTimeout(next.timer);
          if (next.signal && next.onAbort) {
            next.signal.removeEventListener('abort', next.onAbort);
          }

          // Bỏ qua nếu waiter đã bị abort giữa chừng
          if (next.signal?.aborted) {
            continue;
          }

          currentState.activeJobId = next.jobId;
          currentState.acquiredAt = Date.now();
          next.resolve(this.createHandle(accountLabel, currentState, next.jobId));
          return;
        }

        // Không còn ai chờ -> Xóa hẳn entry để tránh rò rỉ bộ nhớ
        this.locks.delete(accountLabel);
      },
    };
  }

  /**
   * Hủy toàn bộ hàng đợi của các tài khoản (dùng khi shutdown hệ thống).
   */
  public cancelWaiters(reason = 'System shutdown'): void {
    this.isStopping = true;
    for (const [accountLabel, state] of this.locks.entries()) {
      const waiters = [...state.waiters];
      state.waiters = [];
      for (const w of waiters) {
        if (w.timer) clearTimeout(w.timer);
        if (w.signal && w.onAbort) {
          w.signal.removeEventListener('abort', w.onAbort);
        }
        w.reject(new Error(`[AccountMutexManager] Hàng đợi tài khoản "${accountLabel}" bị giải tán (${reason})`));
      }
    }
  }

  /**
   * Reset hoàn toàn trạng thái (chỉ dùng trong testing hoặc phục hồi khẩn cấp).
   */
  public reset(): void {
    this.cancelWaiters('Reset');
    this.locks.clear();
    this.isStopping = false;
  }
}

export const accountMutexManager = new AccountMutexManager();
