export type WorkerStatus =
  | 'idle'
  | 'starting'
  | 'logging_in'
  | 'navigating'
  | 'downloading'
  | 'solving_challenge'
  | 'completed'
  | 'error'
  | 'stopped'
  | 'stalled';

export type WorkerState = {
  id: number;
  status: WorkerStatus;
  accountLabel: string | null;
  proxy: string | null;
  pluginName: string | null;
  versionName: string | null;
  progressText: string;
  bytesDownloaded: number;
  startedAt: number | null;
  updatedAt: number;
  lastHeartbeatAt: number;
  taskStartedAt: number | null;
  lastError: string | null;
  isStalled: boolean;
  successCount: number;
  failCount: number;
};

export class InstanceTracker {
  private workers = new Map<number, WorkerState>();
  private lockedAccounts = new Set<string>();

  registerWorker(id: number): WorkerState {
    const existing = this.workers.get(id);
    if (existing) return existing;
    const initial: WorkerState = {
      id,
      status: 'idle',
      accountLabel: null,
      proxy: null,
      pluginName: null,
      versionName: null,
      progressText: 'Sẵn sàng nhận nhiệm vụ',
      bytesDownloaded: 0,
      startedAt: null,
      updatedAt: Date.now(),
      lastHeartbeatAt: Date.now(),
      taskStartedAt: null,
      lastError: null,
      isStalled: false,
      successCount: 0,
      failCount: 0,
    };
    this.workers.set(id, initial);
    return initial;
  }

  updateWorker(id: number, update: Partial<Omit<WorkerState, 'id'>>): WorkerState {
    let worker = this.workers.get(id);
    if (!worker) {
      worker = this.registerWorker(id);
    }

    if (update.accountLabel !== undefined) {
      if (worker.accountLabel && worker.accountLabel !== update.accountLabel) {
        this.lockedAccounts.delete(worker.accountLabel);
      }
      if (update.accountLabel) {
        this.lockedAccounts.add(update.accountLabel);
      }
    }

    const now = Date.now();
    Object.assign(worker, {
      ...update,
      updatedAt: now,
      lastHeartbeatAt: now,
      isStalled: update.status === 'stalled' ? true : false,
      startedAt: worker.startedAt ?? (update.status && update.status !== 'idle' ? now : null),
    });

    return worker;
  }

  heartbeat(id: number, progressText?: string): void {
    const worker = this.workers.get(id);
    if (!worker) return;
    worker.lastHeartbeatAt = Date.now();
    worker.updatedAt = Date.now();
    worker.isStalled = false;
    if (progressText !== undefined) {
      worker.progressText = progressText;
    }
  }

  /**
   * Watchdog kiểm tra các luồng bị treo / không phản hồi quá ngưỡng cho phép (mặc định 90s).
   */
  checkWatchdog(stalledThresholdMs = 90_000): number[] {
    const now = Date.now();
    const stalledIds: number[] = [];

    for (const worker of this.workers.values()) {
      if (
        worker.status === 'idle' ||
        worker.status === 'completed' ||
        worker.status === 'error' ||
        worker.status === 'stopped' ||
        worker.status === 'stalled'
      ) {
        continue;
      }

      const elapsed = now - (worker.lastHeartbeatAt || worker.updatedAt);
      if (elapsed > stalledThresholdMs) {
        worker.status = 'stalled';
        worker.isStalled = true;
        worker.progressText = `⚠️ Luồng không phản hồi (> ${Math.round(elapsed / 1000)}s)`;
        worker.updatedAt = now;
        stalledIds.push(worker.id);
      }
    }

    return stalledIds;
  }

  stopWorker(id: number, reason = 'Trình duyệt Chrome bị tắt đột ngột'): void {
    const worker = this.workers.get(id);
    if (!worker) return;
    if (worker.accountLabel) {
      this.lockedAccounts.delete(worker.accountLabel);
    }
    worker.status = 'stopped';
    worker.lastError = reason;
    worker.progressText = `Đã dừng: ${reason}`;
    worker.updatedAt = Date.now();
  }

  terminateWorker(id: number, reason = 'Tiến trình bị dừng'): void {
    const worker = this.workers.get(id);
    if (!worker) return;
    if (worker.accountLabel) {
      this.lockedAccounts.delete(worker.accountLabel);
    }
    worker.status = 'error';
    worker.lastError = reason;
    worker.progressText = `Đã dừng: ${reason}`;
    worker.updatedAt = Date.now();
  }

  releaseWorker(id: number): void {
    const worker = this.workers.get(id);
    if (!worker) return;
    if (worker.accountLabel) {
      this.lockedAccounts.delete(worker.accountLabel);
    }
    worker.status = 'idle';
    worker.accountLabel = null;
    worker.pluginName = null;
    worker.versionName = null;
    worker.taskStartedAt = null;
    worker.isStalled = false;
    worker.progressText = 'Chờ lượt tải tiếp theo';
    worker.updatedAt = Date.now();
    worker.lastHeartbeatAt = Date.now();
  }

  resetAll(): void {
    for (const id of this.workers.keys()) {
      this.releaseWorker(id);
    }
    this.lockedAccounts.clear();
  }

  isAccountLocked(accountLabel: string, exceptWorkerId?: number): boolean {
    if (!this.lockedAccounts.has(accountLabel)) return false;
    if (exceptWorkerId !== undefined) {
      const current = this.workers.get(exceptWorkerId);
      if (current?.accountLabel === accountLabel) return false;
    }
    return true;
  }

  getAll(): WorkerState[] {
    return Array.from(this.workers.values()).sort((a, b) => a.id - b.id);
  }

  getActiveCount(): number {
    return Array.from(this.workers.values()).filter(
      (w) => w.status !== 'idle' && w.status !== 'completed' && w.status !== 'error',
    ).length;
  }

  pruneExtraWorkers(maxCount: number): void {
    for (const [id, worker] of this.workers.entries()) {
      if (id > maxCount && (worker.status === 'idle' || worker.status === 'completed')) {
        if (worker.accountLabel) this.lockedAccounts.delete(worker.accountLabel);
        this.workers.delete(id);
      }
    }
  }
}

export const instanceTracker = new InstanceTracker();
