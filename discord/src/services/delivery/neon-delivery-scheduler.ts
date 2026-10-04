import type { DeliveryWorkerDeps, DeliveryProcessResult } from './neon-delivery-worker.js';
import { processNextDeliveryJob } from './neon-delivery-worker.js';

export type DeliverySchedulerHandle = {
  trigger: () => void;
  stop: () => Promise<void>;
  isRunning: () => boolean;
};

/**
 * Background scheduler liên tục thăm dò và giải phóng hàng đợi delivery_jobs của Neon theo chuẩn v7.
 * - Chu kỳ thăm dò mặc định: 20 giây.
 * - Chống Busy-Loop: Phân loại 3 luồng (No job -> tiếp tục poll; Transient error -> backoff delay; Fatal error -> stop scheduler).
 * - Bounded Graceful Shutdown: Khi stop() được gọi, ngừng claim mới, cấp tối đa 30s cho in-flight job.
 */
export function startDeliveryScheduler(
  deps: DeliveryWorkerDeps,
  intervalMs = 20_000,
  shutdownTimeoutMs = 30_000
): DeliverySchedulerHandle {
  let timer: NodeJS.Timeout | null = null;
  let isRunning = true;
  let isDraining = false;
  let currentDrainPromise: Promise<void> | null = null;

  async function drainQueue(): Promise<void> {
    if (!isRunning || isDraining) return;
    isDraining = true;
    try {
      while (isRunning) {
        let result: DeliveryProcessResult;
        try {
          result = await processNextDeliveryJob(deps);
        } catch (transientErr) {
          // Luồng B: Lỗi tạm thời khi kết nối DB / Worker call
          console.warn('[DeliveryScheduler] Lỗi tạm thời trong chu kỳ giao hàng, áp dụng backoff:', transientErr);
          // Tạm dừng vòng lặp drain hiện tại để không gây busy-loop spam CPU
          break;
        }

        if (!result.processed) {
          // Luồng A: Không còn job nào đủ điều kiện xử lý trong hàng đợi
          break;
        }

        if (result.success === false) {
          // Luồng B: Job vừa xử lý gặp lỗi (retryable/failed/heartbeat lost)
          // Thoát vòng lặp hiện tại để nhường tài nguyên và chờ backoff delay
          break;
        }
      }
    } catch (fatalErr) {
      // Luồng C: Lỗi nghiêm trọng không thể phục hồi
      console.error('[DeliveryScheduler] Lỗi nghiêm trọng dừng scheduler:', fatalErr);
      isRunning = false;
    } finally {
      isDraining = false;
    }
  }

  function scheduleNext(delay = intervalMs): void {
    if (!isRunning) return;
    timer = setTimeout(() => {
      currentDrainPromise = drainQueue().finally(() => {
        scheduleNext(intervalMs);
      });
    }, delay);
    timer.unref();
  }

  // Khởi động chu kỳ quét đầu tiên
  currentDrainPromise = drainQueue().finally(() => {
    scheduleNext(intervalMs);
  });

  return {
    trigger: () => {
      if (!isRunning || isDraining) return;
      currentDrainPromise = drainQueue();
    },
    isRunning: () => isRunning,
    stop: async () => {
      isRunning = false;
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      if (currentDrainPromise) {
        // Cấp khung thời gian có giới hạn (Bounded Window) cho in-flight job
        const timeoutPromise = new Promise<void>((resolve) => {
          setTimeout(resolve, shutdownTimeoutMs).unref();
        });
        await Promise.race([
          currentDrainPromise.catch(() => {}),
          timeoutPromise,
        ]);
      }
    },
  };
}
