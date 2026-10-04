import type { DeliveryWorkerDeps } from './neon-delivery-worker.js';
import { processNextDeliveryJob } from './neon-delivery-worker.js';

export type DeliverySchedulerHandle = {
  trigger: () => void;
  stop: () => Promise<void>;
};

/**
 * Background scheduler liên tục thăm dò và giải phóng hàng đợi delivery_jobs của Neon.
 * - Chu kỳ thăm dò mặc định: 20 giây.
 * - Có thể gọi `trigger()` để kích hoạt xử lý hàng đợi ngay lập tức (ví dụ sau khi SePay webhook xác nhận thanh toán).
 * - Phương thức `stop()` hỗ trợ Graceful Shutdown, chờ job đang xử lý (in-flight) hoàn tất.
 */
export function startDeliveryScheduler(
  deps: DeliveryWorkerDeps,
  intervalMs = 20_000,
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
        const result = await processNextDeliveryJob(deps);
        if (!result.processed) {
          // Không còn job nào cần xử lý hoặc các job đang bị lock bởi worker khác
          break;
        }
      }
    } catch (err) {
      console.error('Lỗi trong chu kỳ delivery scheduler:', err);
    } finally {
      isDraining = false;
    }
  }

  function scheduleNext(): void {
    if (!isRunning) return;
    timer = setTimeout(() => {
      currentDrainPromise = drainQueue().finally(() => {
        scheduleNext();
      });
    }, intervalMs);
    timer.unref();
  }

  // Chạy lần đầu ngay khi khởi động
  currentDrainPromise = drainQueue().finally(() => {
    scheduleNext();
  });

  return {
    trigger: () => {
      if (!isRunning || isDraining) return;
      currentDrainPromise = drainQueue();
    },
    stop: async () => {
      isRunning = false;
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      if (currentDrainPromise) {
        await currentDrainPromise.catch(() => {});
      }
    },
  };
}
