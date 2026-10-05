/**
 * Hierarchical Deadline Manager (Phase 4B-4)
 *
 * Implements structured deadline hierarchy:
 *   Job deadline (overall operation)
 *       ↓
 *   Navigation/action deadline
 *       ↓
 *   Download deadline
 *
 * Core Invariant:
 * Parent deadline MUST dominate child operations.
 * A child operation cannot be granted more time than what remains in the parent deadline.
 */

export type DeadlineOptions = {
  jobTimeoutMs?: number;
  parentSignal?: AbortSignal;
};

export class HierarchicalDeadline {
  private readonly jobStartTime: number;
  private readonly jobTimeoutMs: number;
  private readonly parentSignal?: AbortSignal;

  constructor(options: DeadlineOptions = {}) {
    this.jobStartTime = Date.now();
    this.jobTimeoutMs = Math.max(0, options.jobTimeoutMs ?? 180_000);
    this.parentSignal = options.parentSignal;
  }

  /**
   * Thời gian còn lại của toàn bộ Job (ms).
   */
  getRemainingJobTimeMs(): number {
    const elapsed = Date.now() - this.jobStartTime;
    return Math.max(0, this.jobTimeoutMs - elapsed);
  }

  /**
   * Kiểm tra xem Job deadline đã hết hạn chưa.
   */
  isExpired(): boolean {
    if (this.parentSignal?.aborted) return true;
    return this.getRemainingJobTimeMs() <= 0;
  }

  /**
   * Tính thời gian tối đa cho tác vụ con.
   * Quy tắc chi phối: childTimeoutMs = Math.min(requestedChildTimeoutMs, remainingJobTimeMs)
   */
  getChildDeadlineMs(requestedChildTimeoutMs: number): number {
    const remaining = this.getRemainingJobTimeMs();
    return Math.min(Math.max(0, requestedChildTimeoutMs), remaining);
  }

  /**
   * Tạo AbortSignal cho tác vụ con, tự động kích hoạt khi:
   * 1. Hết hạn child deadline (hoặc job deadline nếu ngắn hơn)
   * 2. Hoặc parent signal bị abort
   */
  createChildSignal(requestedChildTimeoutMs: number): { signal: AbortSignal; cleanup: () => void } {
    const effectiveTimeoutMs = this.getChildDeadlineMs(requestedChildTimeoutMs);
    const controller = new AbortController();

    if (this.parentSignal?.aborted) {
      controller.abort(this.parentSignal.reason);
      return { signal: controller.signal, cleanup: () => {} };
    }

    if (effectiveTimeoutMs <= 0) {
      controller.abort(new Error('Job deadline đã hết thời gian'));
      return { signal: controller.signal, cleanup: () => {} };
    }

    const timer = setTimeout(() => {
      controller.abort(new Error(`Hết hạn deadline con (${effectiveTimeoutMs}ms)`));
    }, effectiveTimeoutMs);
    timer.unref();

    let parentListener: (() => void) | null = null;
    if (this.parentSignal) {
      parentListener = () => {
        clearTimeout(timer);
        controller.abort(this.parentSignal!.reason);
      };
      this.parentSignal.addEventListener('abort', parentListener, { once: true });
    }

    const cleanup = () => {
      clearTimeout(timer);
      if (this.parentSignal && parentListener) {
        this.parentSignal.removeEventListener('abort', parentListener);
      }
    };

    return { signal: controller.signal, cleanup };
  }
}
