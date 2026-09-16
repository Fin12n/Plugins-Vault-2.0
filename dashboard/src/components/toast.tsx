import { createContext, useCallback, useContext, useMemo, useRef, useState, type ReactNode } from 'react';

/**
 * Thông báo nổi cho mọi hành động ghi.
 *
 * Trước đây mỗi trang tự giữ một cờ `saved`/`error` rồi in một dòng chữ cạnh nút.
 * Hai vấn đề thật: dòng "Đã lưu" không bao giờ tự mất nên lần lưu thứ hai không
 * phân biệt được với lần đầu, và khi trang cuộn dài thì thông báo nằm ngoài tầm mắt
 * — người dùng bấm lại vì tưởng chưa ăn.
 *
 * Cố tình KHÔNG dùng thư viện: một hàng đợi thông báo là mươi dòng, còn thêm phụ
 * thuộc thì phải nuôi nó mãi.
 */
export type ToastKind = 'success' | 'error' | 'info';

type Toast = { id: number; kind: ToastKind; message: string };

type ToastApi = {
  /** Hiện thông báo. Trả về id để nơi gọi tự đóng sớm nếu cần. */
  show: (kind: ToastKind, message: string) => number;
  success: (message: string) => number;
  error: (message: string) => number;
  dismiss: (id: number) => void;
};

const ToastContext = createContext<ToastApi | null>(null);

/** Lỗi tự mất chậm hơn: người dùng cần thời gian đọc một câu lỗi. */
const TTL_MS: Record<ToastKind, number> = { success: 3_000, info: 4_000, error: 8_000 };
/** Nhiều hơn thế thì cột thông báo che mất giao diện; cái cũ nhất bị đẩy ra. */
const MAX_VISIBLE = 4;

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const nextId = useRef(1);

  const dismiss = useCallback((id: number) => {
    setToasts((current) => current.filter((toast) => toast.id !== id));
  }, []);

  const show = useCallback(
    (kind: ToastKind, message: string): number => {
      const id = nextId.current++;
      setToasts((current) => [...current, { id, kind, message }].slice(-MAX_VISIBLE));
      // unref không tồn tại trong trình duyệt; timer tự hết khi tab đóng.
      setTimeout(() => dismiss(id), TTL_MS[kind]);
      return id;
    },
    [dismiss],
  );

  const value = useMemo<ToastApi>(
    () => ({
      show,
      success: (message: string) => show('success', message),
      error: (message: string) => show('error', message),
      dismiss,
    }),
    [show, dismiss],
  );

  return (
    <ToastContext.Provider value={value}>
      {children}
      {/*
        aria-live="polite" chứ không "assertive": thông báo thành công không nên cắt
        ngang thứ trình đọc màn hình đang đọc, nhưng vẫn phải được đọc ra.
      */}
      <div className="toast-stack" role="status" aria-live="polite">
        {toasts.map((toast) => (
          <div key={toast.id} className={`toast toast-${toast.kind}`}>
            <span>{toast.message}</span>
            <button type="button" className="toast-close" onClick={() => dismiss(toast.id)} aria-label="Đóng thông báo">
              ✕
            </button>
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

/**
 * Dùng trong mọi trang. Ném lỗi khi thiếu Provider thay vì im lặng không hiện gì —
 * một thông báo không hiện là lỗi khó thấy nhất trong nhóm này.
 */
export function useToast(): ToastApi {
  const api = useContext(ToastContext);
  if (!api) throw new Error('useToast phải nằm trong <ToastProvider>');
  return api;
}
