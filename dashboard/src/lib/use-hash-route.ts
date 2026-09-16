import { useEffect, useState } from 'react';

/**
 * Điều hướng bằng hash, không thêm thư viện router.
 *
 * Vì sao cần: trước đây tab nằm trong `useState`, nên F5 là về tab đầu, nút Back của
 * trình duyệt nhảy ra khỏi dashboard, và không thể gửi cho ai một liên kết trỏ đúng
 * trang đang xem. Ba việc đó xảy ra hàng ngày với một trang quản trị.
 *
 * Hash thay vì History API vì dashboard được phục vụ tĩnh bởi @fastify/static: một
 * đường dẫn thật như `/plugins` sẽ 404 khi tải lại trang, còn `#/plugins` thì không
 * bao giờ chạm tới máy chủ.
 */
export function useHashRoute<T extends string>(allowed: readonly T[], fallback: T): [T, (next: T) => void] {
  const read = (): T => {
    const raw = window.location.hash.replace(/^#\/?/, '');
    return (allowed as readonly string[]).includes(raw) ? (raw as T) : fallback;
  };

  const [route, setRoute] = useState<T>(read);

  useEffect(() => {
    const onChange = (): void => setRoute(read());
    window.addEventListener('hashchange', onChange);
    // Địa chỉ không có hash (hoặc hash rác) được viết lại một lần, để nút Back không
    // đưa người dùng về một trạng thái không có tên.
    if (window.location.hash.replace(/^#\/?/, '') !== route) {
      window.history.replaceState(null, '', `#/${route}`);
    }
    return () => window.removeEventListener('hashchange', onChange);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const navigate = (next: T): void => {
    if (next === route) return;
    // Đặt hash chứ không setState: hashchange sẽ cập nhật state, nên Back/Forward và
    // cú bấm trong giao diện đi qua đúng một đường.
    window.location.hash = `#/${next}`;
  };

  return [route, navigate];
}
