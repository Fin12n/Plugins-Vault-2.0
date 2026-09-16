import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from './api-client.js';

/**
 * Một lần đọc dữ liệu từ API, kèm đủ trạng thái để vẽ giao diện trung thực.
 *
 * Trước đây mỗi trang tự làm `useState` + `useEffect` + try/catch, và mỗi trang lại
 * quên một trạng thái khác nhau: có trang không phân biệt "đang tải lần đầu" với
 * "đang tải lại" nên bảng nhấp nháy về rỗng mỗi lần làm mới, có trang giữ dữ liệu cũ
 * khi request mới lỗi mà không nói gì. Gom vào một chỗ để mọi trang cùng đúng.
 *
 * `stale` là điểm quan trọng: khi đang tải lại thì dữ liệu cũ VẪN được vẽ, chỉ mờ đi.
 * Xoá bảng rồi vẽ lại làm mắt phải tìm lại vị trí sau mỗi hành động.
 */
export type AsyncState<T> = {
  data: T | null;
  error: string | null;
  /** Chưa từng có dữ liệu — đây là lúc vẽ khung xương. */
  loading: boolean;
  /** Đã có dữ liệu và đang tải lại — vẽ dữ liệu cũ, làm mờ. */
  refreshing: boolean;
  reload: () => Promise<void>;
  /** Thay dữ liệu tại chỗ, cho cập nhật lạc quan sau một hành động. */
  set: (next: T) => void;
};

export function useAsync<T>(path: string | null, deps: unknown[] = []): AsyncState<T> {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  // Đếm số lần gọi để bỏ qua phản hồi về muộn: bấm sang trang 3 rồi trang 4 mà
  // phản hồi của trang 3 về sau sẽ ghi đè trang 4 nếu không có cái này.
  const generation = useRef(0);
  const alive = useRef(true);

  useEffect(() => {
    alive.current = true;
    return () => void (alive.current = false);
  }, []);

  const run = useCallback(async () => {
    if (path === null) return;
    const mine = ++generation.current;
    setPending(true);
    try {
      const next = await api.get<T>(path);
      if (!alive.current || mine !== generation.current) return;
      setData(next);
      setError(null);
    } catch (err) {
      if (!alive.current || mine !== generation.current) return;
      setError(err instanceof Error ? err.message : 'Không tải được dữ liệu');
    } finally {
      if (alive.current && mine === generation.current) setPending(false);
    }
    // path là phần phụ thuộc thật; deps để trang tự thêm điều kiện tải lại.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path, ...deps]);

  useEffect(() => {
    void run();
  }, [run]);

  return {
    data,
    error,
    loading: pending && data === null,
    refreshing: pending && data !== null,
    reload: run,
    set: setData,
  };
}

/**
 * Đọc lại theo chu kỳ, nhưng chỉ khi tab đang được xem.
 *
 * Polling khi tab bị ẩn là gửi request cho một cái không ai nhìn — và trên máy chủ
 * nhỏ thì mười tab đang mở là mười lần tải vô ích mỗi vài giây. `visibilitychange`
 * còn cho một lợi ích thứ hai: quay lại tab là làm mới ngay, đúng lúc người dùng
 * muốn thấy số liệu mới nhất.
 */
export function usePoll(callback: () => void | Promise<void>, intervalMs: number, enabled = true): void {
  const latest = useRef(callback);
  latest.current = callback;

  useEffect(() => {
    if (!enabled) return;
    let timer: ReturnType<typeof setInterval> | null = null;

    const tick = (): void => void latest.current();
    const start = (): void => {
      if (timer === null) timer = setInterval(tick, intervalMs);
    };
    const stop = (): void => {
      if (timer !== null) {
        clearInterval(timer);
        timer = null;
      }
    };
    const onVisibility = (): void => {
      if (document.visibilityState === 'visible') {
        tick();
        start();
      } else stop();
    };

    if (document.visibilityState === 'visible') start();
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      stop();
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [intervalMs, enabled]);
}
