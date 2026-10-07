/**
 * Module quản lý Ngân sách Hạn chót Tuyệt đối (Absolute Acquisition Deadline)
 * và Lan truyền Timeout / AbortSignal chuẩn hóa trên toàn bộ hệ thống.
 *
 * Nguyên tắc:
 * 1. deadline = startedAt + jobTimeoutMs
 * 2. mọi thao tác con: remainingMs = deadline - Date.now()
 * 3. effectiveTimeout = min(configuredTimeoutMs, remainingMs)
 * 4. Không cho child timeout vượt parent deadline.
 * 5. Khi remaining <= 0 -> immediate abort, classify là job_timeout.
 */

export class JobTimeoutError extends Error {
  public readonly code = 'JOB_TIMEOUT';
  public readonly deadline: number;
  public readonly startedAt: number;
  public readonly jobId?: string;

  constructor(message: string, deadline: number, startedAt: number, jobId?: string) {
    super(message);
    this.name = 'JobTimeoutError';
    this.deadline = deadline;
    this.startedAt = startedAt;
    this.jobId = jobId;
  }
}

export function isJobTimeoutError(err: unknown): boolean {
  if (!err) return false;
  if (err instanceof JobTimeoutError) return true;
  const msg = err instanceof Error ? err.message : String(err);
  return /job_timeout|JOB_TIMEOUT|quá thời gian deadline tổng/i.test(msg);
}

export interface DeadlineBudgetOptions {
  jobTimeoutMs: number;
  parentSignal?: AbortSignal;
  startedAt?: number;
  jobId?: string;
}

export interface DeadlineBudget {
  readonly jobId?: string;
  readonly startedAt: number;
  readonly jobTimeoutMs: number;
  readonly deadline: number;
  readonly signal: AbortSignal;
  getRemainingMs: () => number;
  getEffectiveTimeout: (configuredTimeoutMs: number) => number;
  isExpired: () => boolean;
  checkOrThrow: (operationName?: string) => void;
  dispose: () => void;
}

/**
 * Khởi tạo DeadlineBudget canonical cho một acquisition job.
 */
export function createDeadlineBudget(options: DeadlineBudgetOptions): DeadlineBudget {
  const startedAt = options.startedAt ?? Date.now();
  const jobTimeoutMs = Math.max(0, options.jobTimeoutMs);
  const deadline = startedAt + jobTimeoutMs;
  const jobId = options.jobId;

  const controller = new AbortController();
  let timer: NodeJS.Timeout | null = null;
  let disposed = false;

  const cleanupTimer = () => {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
  };

  const onParentAbort = () => {
    if (!disposed && !controller.signal.aborted) {
      cleanupTimer();
      controller.abort(options.parentSignal?.reason ?? new Error('Parent AbortSignal triggered'));
    }
  };

  if (options.parentSignal) {
    if (options.parentSignal.aborted) {
      controller.abort(options.parentSignal.reason ?? new Error('Parent AbortSignal already aborted'));
    } else {
      options.parentSignal.addEventListener('abort', onParentAbort, { once: true });
    }
  }

  const remainingInitial = Math.max(0, deadline - Date.now());
  if (remainingInitial <= 0) {
    controller.abort(new JobTimeoutError(`[DeadlineBudget] Job "${jobId ?? 'anonymous'}" đã quá hạn chót ngay khi bắt đầu`, deadline, startedAt, jobId));
  } else if (!controller.signal.aborted) {
    timer = setTimeout(() => {
      if (!disposed && !controller.signal.aborted) {
        controller.abort(new JobTimeoutError(`[DeadlineBudget] Job "${jobId ?? 'anonymous'}" đã vượt quá thời hạn tổng (${jobTimeoutMs}ms)`, deadline, startedAt, jobId));
      }
    }, remainingInitial);
    timer.unref();
  }

  const budget: DeadlineBudget = {
    jobId,
    startedAt,
    jobTimeoutMs,
    deadline,
    signal: controller.signal,

    getRemainingMs: (): number => {
      return Math.max(0, deadline - Date.now());
    },

    getEffectiveTimeout: (configuredTimeoutMs: number): number => {
      const remaining = Math.max(0, deadline - Date.now());
      if (remaining <= 0) return 0;
      return Math.min(configuredTimeoutMs, remaining);
    },

    isExpired: (): boolean => {
      return Date.now() >= deadline;
    },

    checkOrThrow: (operationName?: string): void => {
      if (controller.signal.aborted) {
        const reason = controller.signal.reason;
        if (reason instanceof Error) throw reason;
        throw new Error(String(reason ?? `Thao tác "${operationName ?? 'unknown'}" bị hủy do signal aborted`));
      }
      if (Date.now() >= deadline) {
        throw new JobTimeoutError(
          `[DeadlineBudget] Thao tác "${operationName ?? 'operation'}" bị hủy: Đã chạm ngưỡng deadline tổng (${jobTimeoutMs}ms)`,
          deadline,
          startedAt,
          jobId,
        );
      }
    },

    dispose: (): void => {
      if (disposed) return;
      disposed = true;
      cleanupTimer();
      if (options.parentSignal) {
        options.parentSignal.removeEventListener('abort', onParentAbort);
      }
    },
  };

  return budget;
}

/**
 * Thực thi một thao tác không đồng bộ với thời gian giới hạn tuân thủ nghiêm ngặt DeadlineBudget.
 */
export async function withDeadline<T>(
  budget: DeadlineBudget,
  operation: (signal: AbortSignal, effectiveTimeoutMs: number) => Promise<T>,
  configuredTimeoutMs?: number,
  operationName?: string,
): Promise<T> {
  budget.checkOrThrow(operationName);

  const effectiveTimeout =
    configuredTimeoutMs !== undefined
      ? budget.getEffectiveTimeout(configuredTimeoutMs)
      : budget.getRemainingMs();

  if (effectiveTimeout <= 0) {
    throw new JobTimeoutError(
      `[DeadlineBudget] Không còn đủ thời gian (${effectiveTimeout}ms) để thực hiện "${operationName ?? 'operation'}"`,
      budget.deadline,
      budget.startedAt,
      budget.jobId,
    );
  }

  const opController = new AbortController();
  const onBudgetAbort = () => {
    opController.abort(budget.signal.reason);
  };

  budget.signal.addEventListener('abort', onBudgetAbort, { once: true });

  let timer: NodeJS.Timeout | null = null;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      opController.abort(new JobTimeoutError(
        `[DeadlineBudget] Hết thời gian thực thi (${effectiveTimeout}ms) cho "${operationName ?? 'operation'}"`,
        budget.deadline,
        budget.startedAt,
        budget.jobId,
      ));
      reject(new JobTimeoutError(
        `[DeadlineBudget] Hết thời gian thực thi (${effectiveTimeout}ms) cho "${operationName ?? 'operation'}"`,
        budget.deadline,
        budget.startedAt,
        budget.jobId,
      ));
    }, effectiveTimeout);
    timer.unref();
  });

  try {
    return await Promise.race([
      operation(opController.signal, effectiveTimeout),
      timeoutPromise,
    ]);
  } finally {
    if (timer) clearTimeout(timer);
    budget.signal.removeEventListener('abort', onBudgetAbort);
  }
}
